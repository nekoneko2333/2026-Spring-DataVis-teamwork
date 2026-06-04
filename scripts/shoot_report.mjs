// 捕获报告用三维体渲染图: 早/中/后期体渲染 + 节点刷选联动。
import { chromium } from "playwright";
import fs from "fs";
const OUT = "outputs/screens";
fs.mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch({
  headless: true,
  args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"],
});
const page = await browser.newPage({ viewport: { width: 1680, height: 1000 } });
const logs = [];
page.on("pageerror", (e) => logs.push(e.message));
await page.goto("http://localhost:5173/", { waitUntil: "networkidle", timeout: 60000 });
await page.waitForFunction(() => document.querySelector("#loadingOverlay")?.classList.contains("hidden"), { timeout: 45000 });

// 只截 3D 视口区域, 更聚焦
const clip = async (name) => {
  const el = await page.$("#viewport");
  const box = await el.boundingBox();
  await page.screenshot({ path: `${OUT}/${name}.png`, clip: box });
  console.log("shot:", name);
};

async function settle(step) {
  await page.evaluate((s) => window.__app.setStep(s), step);
  // 等全分辨率 + 软渲染稳定
  await page.waitForTimeout(7000);
}

await page.evaluate(() => { window.__app._setMode(0); window.__app.renderer.setSteps(260); });
await settle(0); await clip("report_volume_t00");
await settle(50); await clip("report_volume_t50");
await settle(99); await clip("report_volume_t99");
// 节点刷选联动
await page.evaluate(() => window.__app._quickBrush("node", document.querySelector('#brushQuick [data-brush="node"]')));
await page.waitForTimeout(6000); await clip("report_node_brush");

console.log("errors:", logs.length ? logs.join("\n") : "(none)");
await browser.close();
