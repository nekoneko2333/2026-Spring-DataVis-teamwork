// 用 headless Chromium 验证前端: 收集控制台/异常, 等待加载完成, 截图。
import { chromium } from "playwright";
import fs from "fs";

const OUT = "outputs/screens";
fs.mkdirSync(OUT, { recursive: true });

const URL = process.env.URL || "http://localhost:5173/";
const shots = (process.env.SHOTS || "main").split(",");

const browser = await chromium.launch({
  headless: true,
  args: [
    "--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader",
    "--ignore-gpu-blocklist", "--enable-webgl", "--disable-dev-shm-usage",
  ],
});
const page = await browser.newPage({ viewport: { width: 1680, height: 1000 }, deviceScaleFactor: 1 });

const logs = [];
page.on("console", (m) => logs.push(`[${m.type()}] ${m.text()}`));
page.on("pageerror", (e) => logs.push(`[pageerror] ${e.message}`));

await page.goto(URL, { waitUntil: "networkidle", timeout: 60000 });

// 等待加载遮罩消失
try {
  await page.waitForFunction(() => {
    const el = document.querySelector("#loadingOverlay");
    return el && el.classList.contains("hidden");
  }, { timeout: 45000 });
} catch (e) { logs.push("[warn] loadingOverlay 未在超时内隐藏"); }

await page.waitForTimeout(2500);

async function shoot(name) { await page.screenshot({ path: `${OUT}/${name}.png` }); console.log("shot:", name); }

if (shots.includes("main")) {
  await shoot("01_main_default");
}
if (shots.includes("interact")) {
  // 切到晚期时间步
  await page.evaluate(() => window.__app.setStep(99));
  await page.waitForTimeout(1800);
  await shoot("02_t99_volume");
  // MIP
  await page.evaluate(() => window.__app._setMode(1));
  await page.waitForTimeout(1500);
  await shoot("03_t99_mip");
  // 等值面
  await page.evaluate(() => window.__app._setMode(2));
  await page.waitForTimeout(1500);
  await shoot("04_t99_iso");
  // top1%
  await page.evaluate(() => window.__app._setMode(3));
  await page.waitForTimeout(1500);
  await shoot("05_t99_top1");
  // void
  await page.evaluate(() => window.__app._setMode(4));
  await page.waitForTimeout(1500);
  await shoot("06_t99_void");
  // 回到体渲染 + filament 刷选
  await page.evaluate(() => { window.__app._setMode(0); window.__app._quickBrush("filament", document.querySelector('#brushQuick [data-brush="filament"]')); });
  await page.waitForTimeout(1500);
  await shoot("07_t99_filament_brush");
  // atlas
  await page.evaluate(() => { window.__app._clearBrush(); window.__app._toggleAtlas(); });
  await page.waitForTimeout(2200);
  await shoot("08_t99_atlas");
  // fingerprint tab
  await page.evaluate(() => { window.__app._toggleAtlas(); window.__app._setTab("fingerprint"); });
  await page.waitForTimeout(1200);
  await shoot("09_fingerprint");
  await page.evaluate(() => window.__app._setTab("series"));
  await page.waitForTimeout(1000);
  await shoot("10_series");
  await page.evaluate(() => window.__app._setTab("power"));
  await page.waitForTimeout(1000);
  await shoot("11_power");
}

console.log("\n=== console / errors ===");
console.log(logs.length ? logs.join("\n") : "(无)");
await browser.close();
