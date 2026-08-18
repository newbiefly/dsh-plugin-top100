// test/smoke.mjs — 用无头 Chrome (CDP) 对页面做端到端冒烟测试
// 前置：本地静态服务器已在 8123 运行；无头 Chrome 已在 9333 开启远程调试。
// 用法：node test/smoke.mjs
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const PAGE_URL = "http://127.0.0.1:8123/";
const DEBUG_PORT = 9333;

let passed = 0, failed = 0;
const results = [];
function check(name, cond, extra = "") {
  if (cond) { passed++; results.push(`✅ ${name}`); }
  else { failed++; results.push(`❌ ${name}${extra ? " — " + extra : ""}`); }
}

/* ---------- 极简 CDP 客户端 ---------- */
class CDP {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl);
    this.id = 0;
    this.pending = new Map();
  }
  open() {
    return new Promise((res, rej) => {
      this.ws.onopen = res;
      this.ws.onerror = () => rej(new Error("CDP websocket error"));
      this.ws.onmessage = (ev) => {
        const msg = JSON.parse(ev.data);
        if (msg.id && this.pending.has(msg.id)) {
          const p = this.pending.get(msg.id);
          this.pending.delete(msg.id);
          msg.error ? p.reject(new Error(JSON.stringify(msg.error))) : p.resolve(msg.result);
        }
      };
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  close() { try { this.ws.close(); } catch {} }
}

async function evalJs(cdp, expression) {
  const r = await cdp.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error("JS 执行异常: " + JSON.stringify(r.exceptionDetails).slice(0, 300));
  return r.result.value;
}

async function waitFor(cdp, expr, timeoutMs = 15000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try { if (await evalJs(cdp, expr)) return true; } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

/* 用 CDP 派发真实鼠标事件（算用户手势，剪贴板 API 才可用） */
async function clickAt(cdp, selector) {
  const r = await evalJs(cdp, `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return null; el.scrollIntoView({ block: 'center' }); const b = el.getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; })()`);
  if (!r) throw new Error("找不到元素: " + selector);
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: r.x, y: r.y });
  await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: r.x, y: r.y, button: "left", clickCount: 1 });
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: r.x, y: r.y, button: "left", clickCount: 1 });
}

/* ---------- 读取数据计算期望值 ---------- */
const data = JSON.parse(
  (await import("node:fs")).readFileSync(join(ROOT, "data", "plugins.json"), "utf8")
);

function hayOf(p) {
  return [p.full_name, p.owner, p.name, p.zh, p.description, p.language,
    (p.topics || []).join(" "), p.category].filter(Boolean).join(" ").toLowerCase();
}

/* ---------- 连接浏览器 ---------- */
const targets = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`)).json();
const page = targets.find((t) => t.type === "page");
if (!page) { console.error("没有可用 page target"); process.exit(1); }

const cdp = new CDP(page.webSocketDebuggerUrl);
await cdp.open();
await cdp.send("Page.enable");
await cdp.send("Runtime.enable");
/* 放大视口，避免卡片按钮落在折叠线以下点不到 */
await cdp.send("Emulation.setDeviceMetricsOverride", {
  width: 1440, height: 1200, deviceScaleFactor: 1, mobile: false,
});

/* 授权剪贴板（须在导航前，浏览器级连接） */
const ver = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/version`)).json();
const browser = new CDP(ver.webSocketDebuggerUrl);
await browser.open();
await browser.send("Browser.grantPermissions", {
  origin: PAGE_URL.replace(/\/$/, ""),
  permissions: ["clipboardReadWrite", "clipboardSanitizedWrite"],
});
browser.close();

/* ---------- 加载页面 ---------- */
await cdp.send("Page.bringToFront");
await cdp.send("Page.navigate", { url: PAGE_URL });
const loaded = await waitFor(cdp, `document.readyState === 'complete' && document.querySelectorAll('.card').length > 0`);
check("页面加载并渲染出卡片", loaded);

/* ---------- 基础渲染 ---------- */
const cardCount = await evalJs(cdp, `document.querySelectorAll('.card').length`);
check(`卡片数量 = 100`, cardCount === data.plugins.length, `实际 ${cardCount}`);

const chipCount = await evalJs(cdp, `document.querySelectorAll('.chip').length`);
check(`分类 chips 渲染（>= 20 个）`, chipCount >= 20, `实际 ${chipCount}`);

const statsText = await evalJs(cdp, `document.querySelector('#stats').textContent`);
check("统计栏包含总数与更新时间", /共 100 个插件/.test(statsText) && /数据更新于/.test(statsText), statsText);

const firstZh = await evalJs(cdp, `document.querySelector('.desc-zh')?.textContent || ''`);
check("第一张卡片有中文简介", firstZh.length > 5, firstZh.slice(0, 30));

const firstInstall = await evalJs(cdp, `document.querySelector('[data-copy]')?.dataset.copy || ''`);
check("第一张卡片有安装命令", firstInstall.startsWith("dsh plugin"), firstInstall);

/* ---------- 搜索 ---------- */
const Q = "记忆";
const expectedSearch = data.plugins.filter((p) => hayOf(p).includes(Q)).length;
await evalJs(cdp, `(() => { const i = document.querySelector('#search'); i.value = ${JSON.stringify(Q)}; i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
await new Promise((r) => setTimeout(r, 150));
const searchCount = await evalJs(cdp, `document.querySelectorAll('.card').length`);
check(`搜索「${Q}」匹配数 = ${expectedSearch}`, searchCount === expectedSearch, `实际 ${searchCount}`);

/* ---------- 分类筛选 ---------- */
const CAT = "🧠 记忆";
const expectedCat = data.plugins.filter((p) => p.category === CAT).length;
await evalJs(cdp, `(() => { const c = [...document.querySelectorAll('.chip')].find(x => x.dataset.cat === ${JSON.stringify(CAT)}); c.click(); })()`);
await new Promise((r) => setTimeout(r, 150));
const catCount = await evalJs(cdp, `document.querySelectorAll('.card').length`);
check(`分类「${CAT}」筛选 = ${expectedCat}`, catCount === expectedCat, `实际 ${catCount}`);

/* 清空搜索并切回「全部」，恢复 100 张卡片 */
await evalJs(cdp, `(() => {
  const i = document.querySelector('#search'); i.value = ''; i.dispatchEvent(new Event('input', { bubbles: true }));
  [...document.querySelectorAll('.chip')].find(x => x.dataset.cat === '全部').click();
})()`);
await new Promise((r) => setTimeout(r, 150));
const resetCount = await evalJs(cdp, `document.querySelectorAll('.card').length`);
check("重置筛选后恢复 100 张卡片", resetCount === 100, `实际 ${resetCount}`);

/* ---------- 一键复制（真实鼠标点击 = 用户手势） ---------- */
await clickAt(cdp, "[data-copy]");
await new Promise((r) => setTimeout(r, 300));
const toastText = await evalJs(cdp, `document.querySelector('#toast').textContent || ''`);
check("点击复制出现成功提示", toastText.includes("✅"), toastText || "(空)");

/* 剪贴板读回（headless 下读权限可能受限，只作信息输出，不判失败） */
let clipboard = null, clipErr = null;
try { clipboard = await evalJs(cdp, `navigator.clipboard.readText().then(v => v, e => { throw new Error(e.message); })`); }
catch (e) { clipErr = e.message; }
if (clipboard === firstInstall) {
  passed++; results.push("✅ 剪贴板内容 = 安装命令");
} else if (clipErr) {
  results.push(`ℹ️ 剪贴板读回跳过（headless 读权限限制）: ${clipErr}`);
} else {
  failed++; results.push(`❌ 剪贴板内容 = 安装命令 — 实际 ${clipboard}`);
}
console.log(`ℹ️ 剪贴板读回: ${clipboard ?? "（不可读）"}${clipErr ? " — " + clipErr : ""}`);

/* ---------- 更多命令展开 ---------- */
await clickAt(cdp, "[data-more]");
await new Promise((r) => setTimeout(r, 100));
const panelOpen = await evalJs(cdp, `document.querySelector('.install-panel').classList.contains('open')`);
const rowCount = await evalJs(cdp, `document.querySelector('.card .install-panel').querySelectorAll('.install-row').length`);
check("「更多命令」面板展开", panelOpen);
check("面板含 2 条安装命令（npm + GitHub 源）", rowCount === 2, `实际 ${rowCount}`);

/* ---------- 作者区块（顶栏右侧，与左侧 Logo 对称） ---------- */
const authorExists = await evalJs(cdp, `(() => {
  const el = document.querySelector('.author-mini');
  if (!el) return false;
  const header = document.querySelector('.site-header');
  return header && header.contains(el);
})()`);
check("顶栏右侧作者卡片存在", authorExists);

const authorRight = await evalJs(cdp, `(() => {
  const brand = document.querySelector('.brand').getBoundingClientRect();
  const author = document.querySelector('.author-mini').getBoundingClientRect();
  return author.left > brand.right && author.top <= brand.bottom + 40;
})()`);
check("作者卡片位于顶栏右侧（与 Logo 对称）", authorRight);

const wxText = await evalJs(cdp, `document.querySelector('#wx-id')?.textContent || ''`);
check("显示微信号 wuzhu2", wxText === "wuzhu2", wxText);

const qrLoaded = await evalJs(cdp, `(() => { const img = document.querySelector('.qr-mini'); return img && img.complete && img.naturalWidth > 0; })()`);
check("二维码图片加载成功（非破损）", qrLoaded);

await clickAt(cdp, "#copy-wx");
await new Promise((r) => setTimeout(r, 300));
const wxToast = await evalJs(cdp, `document.querySelector('#toast').textContent || ''`);
check("复制微信号出现成功提示", wxToast.includes("✅") && wxToast.includes("wuzhu2"), wxToast || "(空)");

/* ---------- 截图 ---------- */
const shot = await cdp.send("Page.captureScreenshot", { format: "png" });
mkdirSync(join(__dirname, "shots"), { recursive: true });
const shotPath = join(__dirname, "shots", "render.png");
writeFileSync(shotPath, Buffer.from(shot.data, "base64"));
console.log(`📸 截图已保存: ${shotPath}`);

/* ---------- 汇总 ---------- */
cdp.close();
console.log("\n========== 测试结果 ==========");
results.forEach((r) => console.log(r));
console.log(`\n通过 ${passed} 项 / 失败 ${failed} 项`);
process.exit(failed ? 1 : 0);
