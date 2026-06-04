// 验证新功能: MC 真实网格 / T-web 叠加 / 螺旋时间轴。
import { chromium } from "playwright";
import fs from "fs";
const OUT = "outputs/screens";
fs.mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch({ headless: true, args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
const page = await browser.newPage({ viewport: { width: 1680, height: 1000 } });
const logs = [];
page.on("console", (m) => { if (m.type() === "error") logs.push(`[err] ${m.text()}`); });
page.on("pageerror", (e) => logs.push(`[pageerror] ${e.message}`));
await page.goto("http://localhost:5173/", { waitUntil: "networkidle", timeout: 60000 });
await page.waitForFunction(() => document.querySelector("#loadingOverlay")?.classList.contains("hidden"), { timeout: 45000 });

const clip = async (name) => { const el = await page.$("#viewport"); const b = await el.boundingBox(); await page.screenshot({ path: `${OUT}/${name}.png`, clip: b }); console.log("shot:", name); };
const full = async (name) => { await page.screenshot({ path: `${OUT}/${name}.png` }); console.log("shot:", name); };

await page.evaluate(() => window.__app.setStep(99));
await page.waitForTimeout(5000);

// 1) MC 真实网格 (mesh 渲染较轻量)
await page.evaluate(() => window.__app._setMode(5));
await page.waitForTimeout(4000);
await clip("ext_mc_mesh_t99");

// 2) T-web Cosmic Atlas (默认 method=tweb)
await page.evaluate(() => { window.__app._setMode(0); });
await page.waitForTimeout(6000);
await page.evaluate(() => window.__app._toggleAtlas());
await page.waitForTimeout(5000);
await clip("ext_atlas_tweb_t99");

// 3) density-Hessian 对比
await page.evaluate(() => { document.querySelector('#methodSwitch [data-method="proxy"]').click(); });
await page.waitForTimeout(5000);
await clip("ext_atlas_proxy_t99");

// 4) 螺旋时间轴 (整页, 看左侧)
await page.evaluate(() => { window.__app._toggleAtlas(); document.querySelector("#timelineLayout").click(); });
await page.waitForTimeout(1500);
await full("ext_spiral_timeline");

console.log("errors:", logs.length ? logs.join("\n") : "(none)");
await browser.close();
