import { defineConfig } from 'vitepress'
import { categories } from '../../scripts/categories.mjs'
// 目录（侧边栏/导航）由 split.mjs 从 面试_带追问.md 自动生成，作为唯一真相源，
// 不再手写章节表，避免与 md 脱节导致 404/点不动。
import chaptersManifest from '../data/chapters.json'

const ghUser = 'zabernism'

// 由 split.mjs 生成的章节清单驱动侧边栏/导航：md 的 ## 章节标题即目录唯一真相源，
// 不再手写 38 条硬编码章节表，避免与 md 脱节导致整组章节消失或 404。
const chapters = chaptersManifest.map(c => ({ text: c.text, link: `/${c.slug}` }))

const slugMap = new Map(chapters.map(c => [c.link.slice(1), c]))

const categoryNav = categories.map(c => ({
  text: c.name,
  items: c.slugs
    .map(slug => {
      const ch = slugMap.get(slug)
      return ch ? { text: ch.text, link: ch.link } : null
    })
    .filter(Boolean),
}))

// base 自适应：
// - Vercel 构建环境（自动注入 VERCEL 变量）：站点服务于域名根，base 强制 '/'
// - GitHub Pages 绑定了自定义域名 blog.zs666.asia：自定义域名下站点同样服务于域名根 '/'
//   （CI 已把 VP_BASE 设为 '/'），故所有目标环境当前均用 base '/'
// - 仅当改回 zabernism.github.io/codeBase/ 这种 project 子路径托管时，才需把 VP_BASE 设回 /codeBase/
const base = process.env.VERCEL ? '/' : (process.env.VP_BASE || '/')

export default defineConfig({
  base,
  ignoreDeadLinks: true,
  lang: 'zh-CN',
  // 锁定亮色：杂志风（暖色纸面）为明色设计，关闭暗色切换避免与暖色变量冲突
  appearance: false,
  markdown: {
    // 允许在 Markdown 中使用 Vue 组件（如 <PracticePage />）。
    // 源文档中的 List<Message> 等尖括号文本已在 split.mjs 中做安全转义。
    html: true,
    // 代码高亮主题：github-dark 提供 Java 风格着色（关键字/字符串/类型分色），
    // 配合 custom.css 的暖色暗代码框呈现。
    theme: 'github-dark',
  },
  title: '面试通关手册 · AI + Java 后端',
  description: 'AI + Java 后端面试全覆盖：Java/并发/Spring/AI/RAG/Agent/云原生/系统设计，含追问与碳管理业务场景',
  // favicon：站点当前所有目标均 base '/'，故用根路径 /favicon.svg（文件置于 public/，由 VitePress 拷贝到 dist 根）
  head: [
    ['link', { rel: 'icon', href: '/favicon.svg', type: 'image/svg+xml' }],
  ],
  themeConfig: {
    nav: [
      { text: '首页', link: '/' },
      { text: '刷题', link: '/practice' },
      ...categoryNav,
      { text: 'GitHub', link: `https://github.com/${ghUser}/codeBase` },
    ],
    sidebar: [
      {
        text: `面试题库（${chapters.length}章）`,
        items: chapters,
      },
    ],
    search: {
      provider: 'local',
    },
    socialLinks: [
      { icon: 'github', link: `https://github.com/${ghUser}/codeBase` },
    ],
    outline: { level: [2, 3], label: '本页目录' },
    docFooter: { prev: true, next: true },
    lastUpdated: true,
  },
})
