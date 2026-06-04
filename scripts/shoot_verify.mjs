// 验证本轮改动: 精确选区统计 / 播放降步进 / 探针全分辨率重采。
import { chromium } from "playwright";
const browser = await chromium.launch({ headless: true, args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
const page = await browser.newPage({ viewport: { width: 1680, height: 1000 } });
const logs = [];
page.on("console", (m) => { if (m.type() === "error") logs.push(`[err] ${m.text()}`); });
page.on("pageerror", (e) => logs.push(`[pageerror] ${e.message}`));
await page.goto("http://localhost:5173/", { waitUntil: "networkidle", timeout: 60000 });
await page.waitForFunction(() => document.querySelector("#loadingOverlay")?.classList.contains("hidden"), { timeout: 45000 });
await page.evaluate(() => window.__app.setStep(99));
await page.waitForTimeout(4000); // 等全分辨率到位

// 1) 精确选区统计
await page.evaluate(() => window.__app._quickBrush("node", document.querySelector('#brushQuick [data-brush="node"]')));
await page.waitForTimeout(1500);
const sel = await page.evaluate(() => document.querySelector("#selStats").innerText);
console.log("=== 选区统计 ===\n" + sel);

// 2) 播放降步进
await page.evaluate(() => window.__app.play());
await page.waitForTimeout(400);
const playSteps = await page.evaluate(() => window.__app.renderer.uniforms.uStepCount.value);
await page.evaluate(() => window.__app.pause());
await page.waitForTimeout(200);
const pauseSteps = await page.evaluate(() => window.__app.renderer.uniforms.uStepCount.value);
console.log(`播放步进=${playSteps}  暂停步进=${pauseSteps}`);

// 3) 探针(全分辨率)
await page.evaluate(() => {
  const V = (x, y, z) => ({ x, y, z });
  window.__app._onProbe({ p0: V(0,0,0), p1: V(0,0,0), uvw0: V(0.05, 0.5, 0.5), uvw1: V(0.95, 0.55, 0.5) });
});
await page.waitForTimeout(1200);
const probeSrc = await page.evaluate(() => { const t = document.querySelector("#probeChart text"); return [...document.querySelectorAll("#probeChart text")].map(e=>e.textContent).filter(s=>s.includes("采样"))[0] || "?"; });
console.log("探针采样来源: " + probeSrc);

console.log("errors:", logs.length ? logs.join("\n") : "(none)");
await browser.close();
