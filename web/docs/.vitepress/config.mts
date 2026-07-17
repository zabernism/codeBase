import { defineConfig } from 'vitepress'
import { categories } from '../../scripts/categories.mjs'

const ghUser = 'zabernism'

const chapters = [
  { text: '一、Java基础与分布式系统', link: '/01-java-basics' },
  { text: '二、AI模型集成与推理', link: '/02-ai-model-integration' },
  { text: '三、RAG（检索增强生成）', link: '/03-rag' },
  { text: '四、Spring AI框架', link: '/04-spring-ai' },
  { text: '五、LangChain4j框架', link: '/05-langchain4j' },
  { text: '六、AI Agent（智能体）', link: '/06-ai-agent' },
  { text: '七、Prompt工程', link: '/07-prompt-engineering' },
  { text: '八、向量数据库与Embedding', link: '/08-vector-db-embedding' },
  { text: '九、工程化与生产实践', link: '/09-engineering-production' },
  { text: '十、大模型基础与概念', link: '/10-llm-fundamentals' },
  { text: '第十一章 Spring全家桶深度', link: '/11-spring-ecosystem' },
  { text: '第十二章 Spring Cloud微服务体系', link: '/12-spring-cloud' },
  { text: '第十三章：MySQL数据库深度', link: '/13-mysql' },
  { text: '第十四章：Redis深度', link: '/14-redis' },
  { text: '第十五章：Java并发编程与JUC', link: '/15-concurrency-juc' },
  { text: '第十六章：消息队列深度', link: '/16-mq' },
  { text: '第十七章：系统设计', link: '/17-system-design' },
  { text: '第十八章：设计模式', link: '/18-design-patterns' },
  { text: '第十九章：Docker与Kubernetes深度', link: '/19-k8s' },
  { text: '第二十章：CI/CD与DevOps', link: '/20-cicd' },
  { text: '第二十一章：计算机网络', link: '/21-network' },
  { text: '第二十二章：操作系统', link: '/22-os' },
  { text: '第二十三章：MCP协议与AI工具集成', link: '/23-mcp' },
  { text: '第二十四章：LLMOps与AI工程化运维', link: '/24-llmops' },
  { text: '第二十五章：多模态AI与AI安全', link: '/25-multimodal-security' },
  { text: '第二十六章：模型训练微调与评估', link: '/26-training-finetune' },
  { text: '附录：面试高频开放题参考回答', link: '/appendix-open-questions' },
]

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
  markdown: {
    // 允许在 Markdown 中使用 Vue 组件（如 <PracticePage />）。
    // 源文档中的 List<Message> 等尖括号文本已在 split.mjs 中做安全转义。
    html: true,
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
        text: '面试题库（27章）',
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
