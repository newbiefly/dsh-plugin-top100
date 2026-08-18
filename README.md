# 🐋 DSH 插件榜 · DeepSeek Harness Plugin Top 100

GitHub [`dsh-plugin`](https://github.com/topics/dsh-plugin) topic 下按 ⭐ 排名前 100 的插件榜单网页：

- 🔍 **中文搜索**：按名称、中文简介、英文描述、作者、标签即时过滤
- 🏷️ **分类筛选**：20+ 分类 chips（源自 awesome-dsh-plugin 分类 + 关键词启发式）
- 📋 **一键复制安装命令**：`dsh plugin --profile web add <包名>`（另附 GitHub 源码安装命令）
- 📊 排序（星标 / 最近更新 / 名称）、响应式、深色主题
- 🔄 **数据每日自动更新**（GitHub Actions cron，零服务器成本）

## 快速开始（本地预览）

```sh
# 1. 生成数据（无需任何依赖，Node 18+）
node fetch.mjs

# 2. 本地起一个静态服务器预览
npx serve .
```

打开 http://localhost:3000 即可看到榜单。

## 本地自动化测试（可选）

用无头 Chrome (CDP) 对页面做端到端冒烟测试，覆盖：渲染 100 卡片、分类 chips、搜索、分类筛选、一键复制、更多命令展开：

```sh
# 终端 1：静态服务器
node test/server.mjs

# 终端 2：无头 Chrome（本机装有 Chrome 时）
# 用 --remote-debugging-port=9333 --user-data-dir=<临时目录> 启动

# 终端 3：跑测试
node test/smoke.mjs   # 截图保存在 test/shots/render.png
```

## 部署到 GitHub Pages

1. 把本目录推送到一个 GitHub 仓库（如 `dsh-plugin-top100`）。
2. 仓库 **Settings → Pages** → Source 选择 **Deploy from a branch** → 选 `main` + 根目录 `/` → Save。
3. 首次部署成功后，访问 `https://<你的用户名>.github.io/dsh-plugin-top100/`。
4. 每日 02:00 UTC 的 Actions 会**自动抓取最新数据并提交**，页面随之更新。

## 数据管道

```
.github/workflows/update.yml   # 每日定时（cron）执行 fetch.mjs
fetch.mjs                      # 数据管道（无第三方依赖，Node 内置 fetch）
data/plugins.json              # 生成结果，前端直接读取（提交进仓库）
data/translations.json         # 人工策展中文简介/分类/安装命令覆盖（脚本会回写缓存）
index.html / style.css / app.js # 纯静态前端
```

`fetch.mjs` 做的事情：

1. **GitHub Search API** 拉取 `topic:dsh-plugin` 按 stars 排序前 100（字段齐全，无需 HTML 爬虫）。
2. **合并 [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin)** 精选名单：中文简介 + 20 分类 + 「社区收录」标记。
3. **合并人工策展** `data/translations.json`：可覆盖中文简介、分类、安装命令（优先级最高）。
4. **LLM 翻译兜底**（可选）：未覆盖的英文简介调用 OpenAI 兼容接口翻译，结果**回写缓存**，每天只翻译新增的。
5. **分类兜底**：基于 topics + 描述的关键词启发式归类。

### 可选环境变量

| 变量 | 说明 |
| --- | --- |
| `GITHUB_TOKEN` | GitHub token，强烈建议在 Actions 里用 `${{ secrets.GITHUB_TOKEN }}` 避免限流 |
| `LIMIT` | 抓取数量，默认 `100` |
| `LLM_API_KEY` | LLM key（OpenAI 兼容），缺省跳过自动翻译 |
| `LLM_BASE_URL` | 默认 `https://api.deepseek.com` |
| `LLM_MODEL` | 默认 `deepseek-chat` |

> 若要让每日任务自动翻译**新上榜**插件的英文简介，在仓库 **Settings → Secrets and variables → Actions** 里添加 `LLM_API_KEY`（可选 `LLM_BASE_URL` / `LLM_MODEL`）。

## 数据字段说明

`data/plugins.json` 中每个插件包含：`rank / name / full_name / url / homepage / owner / avatar / description / zh(中文简介) / category / topics / stars / forks / language / license / created_at / pushed_at / updated_at / archived / verified(社区收录) / curated(人工策展) / install / install_github`。

## ⚠️ 安全提示

安装插件等于在机器上执行第三方代码（权限与你的账号相同）。本站只做展示与聚合，**不构成任何安全背书**；安装前请先查看源码，不熟悉的插件建议在隔离环境中使用。

## 致谢

- 数据：GitHub `dsh-plugin` topic
- 中文与分类：[awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin)
- 生态参考：[dsh-market](https://github.com/dsh-market/dsh-market) · [DSH-Plugins-Marketplace](https://github.com/bradeGithub/DSH-Plugins-Marketplace)
