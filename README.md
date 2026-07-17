# 面试题站 · 双分支自动部署说明

本仓库使用 **「源码分支 + 渲染分支」** 的双分支结构，配合 GitHub Actions 实现推送即部署。

## 分支模型

| 分支 | 内容 | 维护方 |
| --- | --- | --- |
| `main` | 源码：`面试_带追问.md`（原始面试题）、`images/`（架构图）、`web/`（VitePress 工程 + `scripts/split.mjs`） | 你（手动编辑） |
| `gh-pages` | 渲染后的静态站（由 CI 从 `main` 自动构建并发布） | GitHub Actions（勿手动修改） |

> `gh-pages` 分支由 CI 自动生成与更新，请勿在该分支手动提交。

## 本地预览

```bash
cd web
npm run dev      # 会自动从 面试_带追问.md 拆分出 27 个章节页再启动
```

## 本地构建

```bash
cd web
npm run build    # 先 split 再 vitepress build，产物在 web/docs/.vitepress/dist/
```

## 推送部署

```bash
git push -u origin main    # 触发 CI：自动拆分+构建并发布到 gh-pages
```

首次需在 GitHub 仓库 **Settings → Pages → Source** 选择 **Deploy from a branch** → `gh-pages` / `root`。

## 修改内容

直接编辑根目录的 `面试_带追问.md`（这是你要维护的"源码"），`git push` 后即自动重新渲染发布。

## 目录约定

- `web/scripts/split.mjs`：把 `面试_带追问.md` 按 `## ` 切成 27 个章节页（`web/docs/NN-*.md`、`web/docs/appendix-*.md`），并把 `images/*.svg` 复制到 `web/docs/public/images/`。
- 这些生成的章节页与静态资源**不进 `main` 分支**（见 `.gitignore`），只在 CI 构建或本地 `npm run build` 时生成。
