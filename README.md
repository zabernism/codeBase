# 面试题站 · 自动部署说明（master 单分支）

本仓库使用 **单一 `master` 分支** 同时承载「源码」与「渲染后的站点」：

- **源码**：`面试_带追问.md`（原始面试题）、`images/`（架构图 SVG）、`web/`（VitePress 工程 + `scripts/split.mjs`）
- **渲染站点**：根目录的 `index.html`、各章节 HTML、`assets/`、`images/`（由 CI 构建后自动提交到 `master` 根目录）

推送 `master` 即触发 GitHub Actions：拆分章节 → 构建 VitePress → 把产物 `cp` 到根目录并提交（`[skip ci]` 防止循环触发）。

站点结构：

- **首页**（`/`）：按技术分类（AI / 大模型、Java 后端、数据与中间件、系统与网络、工程与云原生、系统设计、附录）展示入口。
- **刷题页**（`/practice`）：列出全部面试题，顶部分类 tab 可筛选，点击题目跳转到对应章节锚点。
- **章节页**（`/NN-xxx`）：完整题目与追问解答。
- **顶部导航**：分类下拉菜单，可快速进入 MySQL、操作系统、RAG、Spring AI 等具体章节。

## 本地预览

```bash
cd web
npm run dev      # 自动从 面试_带追问.md 拆分出 27 个章节页再启动
```

## 本地构建

```bash
cd web
env -u NODE_OPTIONS npm run build    # 本机有 NODE_OPTIONS 守卫时需去掉；产物在 web/docs/.vitepress/dist/
```

> 说明：本地 `npm run build` 只产出 `web/docs/.vitepress/dist/`，**不会**把 HTML 复制到仓库根目录（那是 CI 的最后一步）。仓库根目录的站点 HTML 由 CI 提交维护。

## 推送部署

```bash
git push origin master    # 触发 CI：自动拆分 + 构建，并把渲染结果提交到 master 根目录
```

## 站点激活（一次性）

GitHub 仓库 **Settings → Pages → Source** 选择 **Deploy from a branch** → `master` / `root`。

## 修改内容

直接编辑根目录的 `面试_带追问.md`（这是你要维护的"源码"），`git push` 后即自动重新渲染发布。

## 目录约定

- `web/scripts/split.mjs`：把 `面试_带追问.md` 按 `## ` 切成 27 个章节页（`web/docs/NN-*.md`、`web/docs/appendix-*.md`），并把 `images/*.svg` 复制到 `web/docs/public/images/`。
- 这些生成的章节页与静态资源**不进 `master` 分支**（见 `.gitignore`），仅在 CI 构建时生成；渲染后的站点 HTML 由 CI 提交到根目录。
- `.gitignore` 同时排除本地资料（`面试.md`、`周计划/`、`*.bak*`、`学习计划.md`、`.workbuddy/`），它们不会进仓库。
