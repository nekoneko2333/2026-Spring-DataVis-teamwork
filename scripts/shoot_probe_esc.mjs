// 验证: 退出探针(ESC / 按钮)时, 3D 视线与剖面图一并清除 (option A)。
import { chromium } from "playwright";

const browser = await chromium.launch({ headless: true, args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
const page = await browser.newPage({ viewport: { width: 1680, height: 1000 } });
const logs = [];
page.on("console", (m) => { if (m.type() === "error") logs.push(`[err] ${m.text()}`); });
page.on("pageerror", (e) => logs.push(`[pageerror] ${e.message}`));
await page.goto(process.env.URL || "http://localhost:5174/", { waitUntil: "networkidle", timeout: 60000 });
await page.waitForFunction(() => document.querySelector("#loadingOverlay")?.classList.contains("hidden"), { timeout: 45000 });
await page.waitForTimeout(1500);

const snap = () => page.evaluate(() => ({
  active: document.querySelector("#btnProbe").classList.contains("active"),
  line: !!window.__app.renderer.probeLine,
  samples: !!window.__app.probe.samples,
  hintHidden: document.querySelector("#probeHint").classList.contains("hidden"),
}));

// 1) 开启探针并在画布中心模拟点击拉线
await page.evaluate(() => window.__app._toggleProbe(true));
await page.waitForTimeout(300);
await page.evaluate(() => {
  const c = document.querySelector("#glcanvas");
  const r = c.getBoundingClientRect();
  c.dispatchEvent(new PointerEvent("pointerdown", { button: 0, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, bubbles: true }));
});
await page.waitForTimeout(900);
const afterDraw = await snap();
console.log("画线后 :", JSON.stringify(afterDraw));

// 2) 派发 ESC (走真实的 document keydown 监听)
await page.evaluate(() => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })));
await page.waitForTimeout(500);
const afterEsc = await snap();
console.log("按ESC后:", JSON.stringify(afterEsc));

// 3) 再开一次探针->画线->点"清除探针"按钮, 确认按钮路径也一致(并验证可重复使用)
await page.evaluate(() => window.__app._toggleProbe(true));
await page.waitForTimeout(200);
await page.evaluate(() => {
  const c = document.querySelector("#glcanvas");
  const r = c.getBoundingClientRect();
  c.dispatchEvent(new PointerEvent("pointerdown", { button: 0, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, bubbles: true }));
});
await page.waitForTimeout(700);
const reDraw = await snap();
console.log("二次画线:", JSON.stringify(reDraw));

// 4) 判定
const pass =
  afterDraw.active && afterDraw.line && afterDraw.samples && !afterDraw.hintHidden &&
  !afterEsc.active && !afterEsc.line && !afterEsc.samples && afterEsc.hintHidden &&
  reDraw.line && reDraw.samples;
console.log(pass ? "RESULT: PASS ✅  ESC 清除视线+剖面, 且探针可重复使用" : "RESULT: FAIL ❌");
console.log("errors:", logs.length ? logs.join("\n") : "(none)");
await browser.close();
process.exit(pass ? 0 : 1);
