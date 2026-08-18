/* DSH 插件榜 前端逻辑：搜索 / 分类筛选 / 排序 / 一键复制安装命令 */
(() => {
  "use strict";

  const $ = (sel) => document.querySelector(sel);

  let DATA = null; // plugins.json 内容
  const state = { query: "", cat: "全部", sort: "stars-desc" };

  const els = {
    search: $("#search"),
    sort: $("#sort"),
    cats: $("#cats"),
    stats: $("#stats"),
    grid: $("#grid"),
    empty: $("#empty"),
    toast: $("#toast"),
  };

  /* ---------- 工具函数 ---------- */
  const esc = (s) =>
    String(s ?? "").replace(/[&<>"']/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  function fmtStars(n) {
    if (n == null) return "0";
    if (n >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, "") + "M";
    if (n >= 1e3) return (n / 1e3).toFixed(1).replace(/\.0$/, "") + "k";
    return String(n);
  }

  function fmtDate(iso) {
    if (!iso) return "—";
    const d = new Date(iso);
    if (isNaN(d)) return "—";
    const diff = Date.now() - d.getTime();
    const day = 864e5;
    if (diff < 0) return d.toISOString().slice(0, 10);
    if (diff < day) return `${Math.max(1, Math.round(diff / 36e5))} 小时前`;
    if (diff < 30 * day) return `${Math.round(diff / day)} 天前`;
    return d.toISOString().slice(0, 10);
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // 降级方案
      try {
        const ta = document.createElement("textarea");
        ta.value = text;
        ta.style.cssText = "position:fixed;opacity:0";
        document.body.appendChild(ta);
        ta.select();
        const ok = document.execCommand("copy");
        ta.remove();
        return ok;
      } catch {
        return false;
      }
    }
  }

  let toastTimer = null;
  function toast(msg, ok = true) {
    els.toast.textContent = msg;
    els.toast.classList.toggle("ok", ok);
    els.toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (els.toast.hidden = true), 1800);
  }

  /* ---------- 渲染 ---------- */
  function renderChips() {
    const counts = new Map();
    for (const p of DATA.plugins) counts.set(p.category || "🏷️ 其他", (counts.get(p.category || "🏷️ 其他") || 0) + 1);
    const cats = ["全部", ...[...counts.entries()].sort((a, b) => b[1] - a[1]).map(([c]) => c)];
    els.cats.innerHTML = cats
      .map(
        (c) =>
          `<button class="chip${c === state.cat ? " active" : ""}" data-cat="${esc(c)}">${esc(c)}` +
          (c === "全部" ? "" : `<span class="n">${counts.get(c)}</span>`) + `</button>`
      )
      .join("");
  }

  function visible() {
    const q = state.query.trim().toLowerCase();
    let list = DATA.plugins.filter((p) => {
      if (state.cat !== "全部" && (p.category || "🏷️ 其他") !== state.cat) return false;
      if (!q) return true;
      const hay = [
        p.full_name, p.owner, p.name,
        p.zh, p.description, p.language,
        (p.topics || []).join(" "),
        p.category,
      ].filter(Boolean).join(" ").toLowerCase();
      return hay.includes(q);
    });

    const [key, dir] = state.sort.split("-");
    const mul = dir === "asc" ? 1 : -1;
    list.sort((a, b) => {
      if (key === "stars") return (a.stars - b.stars) * mul;
      if (key === "pushed") return (new Date(b.pushed_at) - new Date(a.pushed_at)) * mul;
      return a.name.localeCompare(b.name) * mul;
    });
    return list;
  }

  function cardHTML(p) {
    const top = (p.topics || []).slice(0, 4);
    const badges = [
      p.verified ? '<span class="badge verified">✓ 社区收录</span>' : "",
      p.archived ? '<span class="badge archived">已归档</span>' : "",
      p.language ? `<span class="badge lang">${esc(p.language)}</span>` : "",
      `<span class="badge cat">${esc(p.category || "🏷️ 其他")}</span>`,
    ].join("");

    return `
    <article class="card" data-rank="${p.rank}">
      <div class="card-top">
        <div class="rank ${p.rank <= 3 ? "r" + p.rank : ""}">#${p.rank}</div>
        ${p.avatar ? `<img class="avatar" src="${esc(p.avatar)}" alt="" loading="lazy">` : `<div class="avatar"></div>`}
        <div class="card-title">
          <a class="repo-name" href="${esc(p.url)}" target="_blank" rel="noopener">${esc(p.full_name)}</a>
          <div class="repo-owner">@${esc(p.owner || "")}${p.license ? ` · ${esc(p.license)}` : ""}</div>
        </div>
      </div>
      <div class="badges">${badges}</div>
      ${p.zh ? `<p class="desc-zh">${esc(p.zh)}</p>` : ""}
      ${p.description ? `<p class="desc-en">${esc(p.description)}</p>` : ""}
      ${top.length ? `<div class="topics">${top.map((t) => `<span class="topic">${esc(t)}</span>`).join("")}</div>` : ""}
      <div class="meta">
        <span>⭐ <b>${fmtStars(p.stars)}</b></span>
        <span>🍴 ${fmtStars(p.forks)}</span>
        <span>🕐 ${fmtDate(p.pushed_at)}</span>
        ${p.homepage ? `<span>🔗 <a href="${esc(p.homepage)}" target="_blank" rel="noopener">主页</a></span>` : ""}
      </div>
      <div class="card-actions">
        <button class="btn primary" data-copy="${esc(p.install)}" title="${esc(p.install)}">📋 复制安装命令</button>
        <button class="btn ghost" data-more="${p.rank}">更多命令 ▾</button>
        <a class="btn ghost" href="${esc(p.url)}" target="_blank" rel="noopener">GitHub ↗</a>
      </div>
      <div class="install-panel" id="ip-${p.rank}">
        <div class="install-row">
          <code title="npm 包名安装（插件已发布到 npm 时适用）">${esc(p.install)}</code>
          <button class="copy-mini" data-copy="${esc(p.install)}">复制</button>
        </div>
        <div class="install-row">
          <code title="从 GitHub 源码安装">${esc(p.install_github)}</code>
          <button class="copy-mini" data-copy="${esc(p.install_github)}">复制</button>
        </div>
      </div>
    </article>`;
  }

  function render() {
    const list = visible();
    els.grid.innerHTML = list.map(cardHTML).join("");
    els.empty.hidden = list.length !== 0;
    els.stats.innerHTML =
      `共 <b>${DATA.plugins.length}</b> 个插件 · 当前匹配 <b>${list.length}</b> 个 · ` +
      `GitHub topic 下共 <b>${DATA.total_on_github}</b> 个仓库 · 数据更新于 ${fmtDate(DATA.generated_at)}`;
  }

  /* ---------- 事件 ---------- */
  els.search.addEventListener("input", (e) => { state.query = e.target.value; render(); });

  els.sort.addEventListener("change", (e) => { state.sort = e.target.value; render(); });

  els.cats.addEventListener("click", (e) => {
    const btn = e.target.closest(".chip");
    if (!btn) return;
    state.cat = btn.dataset.cat;
    document.querySelectorAll(".chip").forEach((c) => c.classList.toggle("active", c === btn));
    render();
  });

  els.grid.addEventListener("click", async (e) => {
    const copyBtn = e.target.closest("[data-copy]");
    if (copyBtn) {
      const ok = await copyText(copyBtn.dataset.copy);
      toast(ok ? "✅ 安装命令已复制到剪贴板" : "❌ 复制失败，请手动选择复制", ok);
      return;
    }
    const more = e.target.closest("[data-more]");
    if (more) {
      const panel = document.getElementById("ip-" + more.dataset.more);
      const open = panel.classList.toggle("open");
      more.textContent = open ? "收起命令 ▴" : "更多命令 ▾";
    }
  });

  /* 作者微信号一键复制 */
  const wxBtn = $("#copy-wx");
  if (wxBtn) {
    wxBtn.addEventListener("click", async () => {
      const ok = await copyText("wuzhu2");
      toast(ok ? "✅ 微信号已复制：wuzhu2" : "❌ 复制失败，请手动复制", ok);
    });
  }

  /* ---------- 启动 ---------- */
  async function init() {
    try {
      const res = await fetch("data/plugins.json", { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      DATA = await res.json();
      renderChips();
      render();
    } catch (err) {
      els.grid.innerHTML = `<div class="empty"><p>😵 数据加载失败</p><p class="empty-sub">${esc(err.message)}</p></div>`;
    }
  }
  init();
})();
