// 轻量验证图表 tab(降低 ray-march 步进以避开 SwiftShader 软渲染卡顿)。
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
page.on("console", (m) => { if (m.type() === "error") logs.push(`[err] ${m.text()}`); });
page.on("pageerror", (e) => logs.push(`[pageerror] ${e.message}`));
await page.goto("http://localhost:5173/", { waitUntil: "networkidle", timeout: 60000 });
await page.waitForFunction(() => document.querySelector("#loadingOverlay")?.classList.contains("hidden"), { timeout: 45000 });
// 降低着色器开销
await page.evaluate(() => { window.__app.renderer.setSteps(24); window.__app.setStep(80); });
await page.waitForTimeout(1200);

const shoot = async (n) => { await page.screenshot({ path: `${OUT}/${n}.png` }); console.log("shot:", n); };

await page.evaluate(() => window.__app._setTab("fingerprint"));
await page.waitForTimeout(900); await shoot("09_fingerprint");
await page.evaluate(() => window.__app._setTab("series"));
await page.waitForTimeout(900); await shoot("10_series");
await page.evaluate(() => window.__app._setTab("power"));
await page.waitForTimeout(900); await shoot("11_power");
// 探针: 合成一条穿过体内的视线
await page.evaluate(() => {
  const V = (x, y, z) => ({ x, y, z });
  window.__app._onProbe({ p0: V(0,0,0), p1: V(0,0,0), uvw0: V(0.08, 0.46, 0.5), uvw1: V(0.95, 0.6, 0.52) });
});
await page.waitForTimeout(900); await shoot("12_probe");
console.log("errors:", logs.length ? logs.join("\n") : "(none)");
await browser.close();
