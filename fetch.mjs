#!/usr/bin/env node
/**
 * fetch.mjs — DSH 插件榜数据管道
 *
 * 1. 从 GitHub Search API 拉取 topic:dsh-plugin 按 stars 排序的前 N 个仓库
 * 2. 合并 awesome-dsh-plugin 精选名单（中文简介 + 20 分类 + 社区收录标记）
 * 3. 合并人工策展 data/translations.json（zh / category / install 覆盖）
 * 4. 可选：未覆盖的英文描述调用 LLM 翻译（OpenAI 兼容接口），结果回写缓存
 * 5. 分类兜底：基于 topics + 描述的关键词启发式
 * 6. 生成 data/plugins.json 供前端使用
 *
 * 环境变量（均可选）：
 *   GITHUB_TOKEN   GitHub token（推荐，避免限流；Actions 里用 ${{ secrets.GITHUB_TOKEN }}）
 *   LIMIT          拉取数量，默认 100
 *   LLM_API_KEY    LLM key，缺省则跳过自动翻译
 *   LLM_BASE_URL   兼容 OpenAI 的 base url，默认 https://api.deepseek.com
 *   LLM_MODEL      默认 deepseek-chat
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, "data");
const OUT = join(DATA_DIR, "plugins.json");
const TRANSLATIONS = join(DATA_DIR, "translations.json");

const env = process.env;
const LIMIT = Number(env.LIMIT || 100);
const GH = "https://api.github.com";
const RAW = "https://raw.githubusercontent.com";
const AWESOME_REPO = "awesome-dsh-plugin/awesome-dsh-plugin";

const ghHeaders = {
  "User-Agent": "dsh-plugin-top100-builder",
  Accept: "application/vnd.github+json",
  ...(env.GITHUB_TOKEN ? { Authorization: `Bearer ${env.GITHUB_TOKEN}` } : {}),
};

async function ghJson(url, retries = 3) {
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(url, { headers: ghHeaders });
    if (res.ok) return res.json();
    if (res.status === 403 || res.status === 429) {
      const reset = res.headers.get("x-ratelimit-reset");
      const waitMs = reset ? Math.min(Number(reset) * 1000 - Date.now() + 1000, 60000) : attempt * 4000;
      if (attempt > retries) throw new Error(`GitHub API ${res.status} (rate limited): ${url}`);
      console.log(`⏳ 限流，${Math.round(waitMs / 1000)}s 后重试（${attempt}/${retries}）…`);
      await new Promise((r) => setTimeout(r, Math.max(waitMs, 1000)));
      continue;
    }
    throw new Error(`GitHub API ${res.status}: ${url}`);
  }
}

async function rawText(url) {
  const res = await fetch(url, { headers: { "User-Agent": "dsh-plugin-top100-builder" } });
  if (!res.ok) return null;
  return res.text();
}

/* ---------- 1. GitHub Search API ---------- */
async function fetchTopicRepos(limit) {
  const url = `${GH}/search/repositories?q=topic:dsh-plugin&sort=stars&order=desc&per_page=${Math.min(limit, 100)}`;
  const data = await ghJson(url);
  return { total: data.total_count, items: data.items };
}

/* ---------- 2. awesome-dsh-plugin 精选名单解析 ---------- */
const AWESOME_CATEGORIES = new Set([
  "🎨 UI 增强", "💰 用量与计费", "🎭 主题与外观", "🔌 模型与账号接入",
  "💬 会话与消息", "🧠 记忆", "🛠️ 工具与能力", "🌐 浏览器与网页",
  "🖼️ 视觉与多模态", "🎙️ 语音与音频", "📄 文档与渲染", "🧩 技能包",
  "🔁 工作流与自动化", "🔀 Git 与代码评审", "🔔 通知与集成", "🧑‍💻 开发与运行时",
  "🔒 安全与权限", "📱 远程与移动端", "🛒 插件市场与管理", "🎮 娱乐",
]);

function parseAwesome(text) {
  const map = new Map(); // full_name(lower) -> { zh, category, verified }
  if (!text) return map;
  let category = null;
  const entryRe = /-\s*\[([^\]/]+\/[^\]]+)\]\(https?:\/\/github\.com\/[^)]*\)\s*(?:—|–|-)\s*(.+)/;
  for (const line of text.split("\n")) {
    const h = line.match(/^###\s+(.+)$/);
    if (h) { category = AWESOME_CATEGORIES.has(h[1].trim()) ? h[1].trim() : category; continue; }
    const m = line.match(entryRe);
    if (!m) continue;
    const key = m[1].trim().toLowerCase();
    const prev = map.get(key) || {};
    map.set(key, { ...prev, zh: prev.zh || m[2].trim(), category: prev.category || category, verified: true });
  }
  return map;
}

async function loadAwesome() {
  const [zh, en] = await Promise.all([
    rawText(`${RAW}/${AWESOME_REPO}/HEAD/README.zh.md`),
    rawText(`${RAW}/${AWESOME_REPO}/HEAD/README.md`),
  ]);
  const map = parseAwesome(zh);
  for (const [k, v] of parseAwesome(en)) {
    if (!map.has(k)) map.set(k, { ...v, zh: null });
  }
  return map;
}

/* ---------- 3. 人工策展翻译 ---------- */
function loadTranslations() {
  if (!existsSync(TRANSLATIONS)) return {};
  try { return JSON.parse(readFileSync(TRANSLATIONS, "utf8")); } catch { return {}; }
}

function saveTranslations(t) {
  writeFileSync(TRANSLATIONS, JSON.stringify(t, null, 2) + "\n", "utf8");
}

/* ---------- 4. LLM 翻译（OpenAI 兼容） ---------- */
async function llmTranslate(text, model) {
  const base = (env.LLM_BASE_URL || "https://api.deepseek.com").replace(/\/+$/, "");
  const res = await fetch(`${base}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${env.LLM_API_KEY}` },
    body: JSON.stringify({
      model, temperature: 0.3, max_tokens: 120,
      messages: [
        { role: "system", content: "你是一名中文译者。把 GitHub 仓库的英文简介翻译成一句简洁中文（≤50字），只输出译文本身，不要引号、不要解释、不要前缀。" },
        { role: "user", content: text },
      ],
    }),
  });
  if (!res.ok) throw new Error(`LLM ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return String(data.choices?.[0]?.message?.content || "").trim();
}

async function translateMissing(records, translations) {
  if (!env.LLM_API_KEY) {
    console.log("ℹ️  未设置 LLM_API_KEY，跳过自动翻译（已有人工策展的照常生效）");
    return;
  }
  const model = env.LLM_MODEL || "deepseek-chat";
  const pending = records.filter(
    (r) => !r.zh && r.description && !translations[r.full_name.toLowerCase()]?.zh
  );
  console.log(`🌐 待 LLM 翻译：${pending.length} 条`);
  let ok = 0, fail = 0;
  for (let i = 0; i < pending.length; i++) {
    const r = pending[i];
    try {
      const zh = await llmTranslate(r.description, model);
      if (zh) {
        translations[r.full_name.toLowerCase()] = { ...(translations[r.full_name.toLowerCase()] || {}), zh };
        ok++;
      }
    } catch (e) {
      fail++;
      console.warn(`⚠️  翻译失败 ${r.full_name}: ${e.message}`);
    }
    if (i % 5 === 4 || i === pending.length - 1) console.log(`  … ${i + 1}/${pending.length}`);
  }
  saveTranslations(translations);
  console.log(`✅ LLM 翻译完成：成功 ${ok}，失败 ${fail}`);
}

/* ---------- 5. 分类启发式 ---------- */
const CLASSIFIERS = [
  [/^awesome|curated|精选|雷达/, "📚 精选列表"],
  [/tutorial|handbook|手册|教程|guide|learn|getting-started|从 0 到 1|深度/, "📖 教程与文档"],
  [/desktop|electron|tauri|桌面/, "🖥️ 桌面应用"],
  [/agent-os|agentic-os|agent runtime|agentic-runtime|harness$|harness-runtime|runtime for|操作系统/, "🤖 Agent 运行时"],
  [/market|marketplace|市场|插件管理/, "🛒 插件市场与管理"],
  [/security|antivirus|guard|secret|sandbox|安全|防护/, "🔒 安全与权限"],
  [/memory|memor|记忆|knowledge-graph|上下文/, "🧠 记忆"],
  [/browser|chrome|sidebar|浏览器|网页/, "🌐 浏览器与网页"],
  [/vision|ocr|multimodal|visual|图像|视觉|图/, "🖼️ 视觉与多模态"],
  [/theme|skin|皮肤|主题|外观/, "🎭 主题与外观"],
  [/^ui|web-ui|interface|面板/, "🎨 UI 增强"],
  [/novel|writing|writer|paper|写作|小说|论文/, "✍️ 写作与创作"],
  [/research|scientist|研究/, "🔬 研究与科学"],
  [/git|code-review|review|评审/, "🔀 Git 与代码评审"],
  [/workflow|automation|自动|工作流/, "🔁 工作流与自动化"],
  [/session|chat|会话|消息/, "💬 会话与消息"],
  [/model|provider|llm access|账号|api key/, "🔌 模型与账号接入"],
  [/test|qa|testing|验收/, "🧪 测试与 QA"],
  [/visualize|chart|dashboard|可视化|数据/, "📈 数据与可视化"],
  [/voice|audio|语音|音频/, "🎙️ 语音与音频"],
  [/skill|技能/, "🧩 技能包"],
  [/tool|mcp|工具|能力/, "🛠️ 工具与能力"],
  [/agent|agents|智能体|ai-cod/, "🤖 Agent / 智能体"],
];

function classify(r) {
  const hay = `${r.topics.join(" ")} ${r.description || ""} ${r.full_name}`.toLowerCase();
  for (const [re, cat] of CLASSIFIERS) if (re.test(hay)) return cat;
  return "🏷️ 其他";
}

/* ---------- 主流程 ---------- */
const { total, items } = await fetchTopicRepos(LIMIT);
console.log(`🔎 GitHub topic:dsh-plugin 共 ${total} 个仓库，取 stars 前 ${items.length}`);

const awesome = await loadAwesome();
console.log(`📋 awesome-dsh-plugin 解析条目：${awesome.size}`);

let translations = loadTranslations();
console.log(`📝 人工策展翻译：${Object.keys(translations).length} 条`);

const records = items.map((it) => {
  const key = it.full_name.toLowerCase();
  const aw = awesome.get(key) || {};
  const tl = translations[key] || {};
  const name = it.name;
  return {
    rank: 0, // 之后按顺序补
    name,
    full_name: it.full_name,
    url: it.html_url,
    homepage: it.homepage || null,
    owner: it.owner?.login || null,
    avatar: it.owner?.avatar_url || null,
    description: it.description,
    zh: tl.zh || aw.zh || null,
    category: tl.category || aw.category || null,
    topics: it.topics || [],
    stars: it.stargazers_count,
    forks: it.forks_count,
    open_issues: it.open_issues_count,
    language: it.language,
    license: it.license?.spdx_id || null,
    created_at: it.created_at,
    pushed_at: it.pushed_at,
    updated_at: it.updated_at,
    archived: it.archived,
    verified: !!aw.verified, // 进 awesome 精选名单 = 社区收录
    curated: !!tl.zh, // 有人工策展中文简介
    install: tl.install || aw.install || `dsh plugin --profile web add ${name}`,
    install_github: tl.install_github || `dsh plugin --profile web add github:${it.full_name}`,
  };
});

await translateMissing(records, translations);

for (const [i, r] of records.entries()) {
  r.rank = i + 1;
  if (!r.category) r.category = classify(r);
}

const out = {
  generated_at: new Date().toISOString(),
  source: `${GH}/search/repositories?q=topic:dsh-plugin&sort=stars`,
  total_on_github: total,
  limit: records.length,
  plugins: records,
};

mkdirSync(DATA_DIR, { recursive: true });
writeFileSync(OUT, JSON.stringify(out, null, 2) + "\n", "utf8");

const withZh = records.filter((r) => r.zh).length;
console.log(`✅ 已生成 ${OUT}`);
console.log(`   中文简介覆盖：${withZh}/${records.length}，分类覆盖：${records.filter((r) => r.category).length}/${records.length}`);
