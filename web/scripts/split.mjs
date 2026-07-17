import { readFileSync, writeFileSync, mkdirSync, copyFileSync, existsSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = join(__dirname, '..', '..')      // web/scripts/ -> 面试/ (repo root)
const src = join(root, '面试_带追问.md')
const docsDir = join(__dirname, '..', 'docs') // web/scripts/ -> web/docs
const publicImg = join(docsDir, 'public', 'images')

const slugMap = [
  ['一、Java基础与分布式系统（AI场景下）', '01-java-basics'],
  ['二、AI模型集成与推理', '02-ai-model-integration'],
  ['三、RAG（检索增强生成）', '03-rag'],
  ['四、Spring AI框架', '04-spring-ai'],
  ['五、LangChain4j框架', '05-langchain4j'],
  ['六、AI Agent（智能体）', '06-ai-agent'],
  ['七、Prompt工程', '07-prompt-engineering'],
  ['八、向量数据库与Embedding', '08-vector-db-embedding'],
  ['九、工程化与生产实践', '09-engineering-production'],
  ['十、大模型基础与概念', '10-llm-fundamentals'],
  ['第十一章 Spring全家桶深度', '11-spring-ecosystem'],
  ['第十二章 Spring Cloud微服务体系', '12-spring-cloud'],
  ['第十三章：MySQL数据库深度（50题）', '13-mysql'],
  ['第十四章：Redis深度（40题）', '14-redis'],
  ['第十五章：Java并发编程与JUC（40题）', '15-concurrency-juc'],
  ['第十六章：消息队列深度（30题）', '16-mq'],
  ['第十七章：系统设计 —— 21道项目设计题', '17-system-design'],
  ['第十八章：设计模式（30题）', '18-design-patterns'],
  ['第十九章：Docker与Kubernetes深度（30题）', '19-k8s'],
  ['第二十章：CI/CD与DevOps（20题）', '20-cicd'],
  ['第二十一章：计算机网络', '21-network'],
  ['第二十二章：操作系统', '22-os'],
  ['第二十三章：MCP协议与AI工具集成', '23-mcp'],
  ['第二十四章：LLMOps与AI工程化运维', '24-llmops'],
  ['第二十五章：多模态AI与AI安全', '25-multimodal-security'],
  ['第二十六章：模型训练微调与评估', '26-training-finetune'],
  ['附录：面试高频开放题参考回答', 'appendix-open-questions'],
]

const text = readFileSync(src, 'utf-8')
const lines = text.split('\n')
const chapters = []
let cur = null
for (const line of lines) {
  if (/^## /.test(line)) {
    cur = { title: line.slice(3).trim(), lines: [] }
    chapters.push(cur)
  } else if (cur) {
    cur.lines.push(line)
  }
}
if (chapters.length !== slugMap.length) {
  console.error(`章节数 ${chapters.length} ≠ 期望 ${slugMap.length}`)
  process.exit(1)
}
mkdirSync(publicImg, { recursive: true })
for (let i = 0; i < chapters.length; i++) {
  const { title, lines: body } = chapters[i]
  const slug = slugMap[i][1]
  let content = body.join('\n')
  content = content.replace(/\]\((\.\/)?images\//g, '](/images/')
  const out = `---\ntitle: ${title}\n---\n\n# ${title}\n\n${content}\n`
  writeFileSync(join(docsDir, `${slug}.md`), out)
}
const imgSrc = join(root, 'images')
if (existsSync(imgSrc)) {
  for (const f of readdirSync(imgSrc)) {
    if (f.endsWith('.svg')) copyFileSync(join(imgSrc, f), join(publicImg, f))
  }
}
console.log(`split done: ${chapters.length} chapters -> docs/`)
