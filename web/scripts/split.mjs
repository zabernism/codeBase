import { readFileSync, writeFileSync, mkdirSync, copyFileSync, existsSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { categories, slugToCategory } from './categories.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = join(__dirname, '..', '..')      // web/scripts/ -> 面试/ (repo root)
const src = join(root, '面试_带追问.md')
const docsDir = join(__dirname, '..', 'docs') // web/scripts/ -> web/docs
const dataDir = join(docsDir, 'data')
const publicDir = join(docsDir, 'public')
const publicImg = join(publicDir, 'images')

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
  ['第十七章：系统设计 —— 29道项目设计题', '17-system-design'],
  ['第十八章：设计模式（30题）', '18-design-patterns'],
  ['第十九章：Docker与Kubernetes深度（30题）', '19-k8s'],
  ['第二十章：CI/CD与DevOps（28题）', '20-cicd'],
  ['第二十一章：计算机网络', '21-network'],
  ['第二十二章：操作系统', '22-os'],
  ['第二十三章：MCP协议与AI工具集成', '23-mcp'],
  ['第二十四章：LLMOps与AI工程化运维', '24-llmops'],
  ['第二十五章：多模态AI与AI安全', '25-multimodal-security'],
  ['第二十六章：模型训练微调与评估', '26-training-finetune'],
  ['二十七、碳足迹核算（GHG Protocol / ISO 14067 / LCA）', '27-carbon-accounting'],
  ['二十八、ESG 披露体系（GRI / SASB / ISSB / TCFD）', '28-esg-disclosure'],
  ['二十九、碳中和政策与碳市场（双碳 / CEA / CCER / CBAM）', '29-carbon-policy-market'],
  ['三十、碳数据平台工程化（高并发采集 / 批处理 / CDC）', '30-carbon-data-platform'],
  ['三十一、双碳业务 × Java 复合题', '31-carbon-java-composite'],
  ['三十二、碳核算合规与审计', '32-carbon-compliance-audit'],
  ['三十三、JVM 与 GC 深度调优', '33-jvm-gc'],
  ['三十四、算法与数据结构 / 编码题', '34-algorithm-ds'],
  ['三十五、Elasticsearch 与搜索工程', '35-elasticsearch'],
  ['三十六、通用安全：认证授权与 Spring Security', '36-security'],
  ['三十七、分布式事务深化：Seata/TCC/Saga 边界与实战', '37-distributed-tx'],
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

mkdirSync(dataDir, { recursive: true })
mkdirSync(publicImg, { recursive: true })

// 把行内类似 HTML 标签的尖括号文本（如 /proc/<pid>/stat、List<Message>）做安全转义，
// 避免 markdown.html:true 时 Vue 编译器报 "Element is missing end tag"。
// 跳过代码块与行内代码（反引号）内的尖括号。
function escapeHtmlLikeTags(line) {
  const parts = line.split(/(`[^`]*`)/g)
  return parts.map((part, idx) => {
    if (idx % 2 === 1) return part
    return part.replace(/<([^>]*)>/g, '&lt;$1&gt;')
  }).join('')
}

// 把"追问"块里的列表项转成真正的标题，让每个 追问N 成为可见的 h5 标题。
// 源文档结构（保持不变）：
//   #### 追问：
//   - 追问1：<问题>
//     - **答**：<答案>
//       - 子点
// 转换后（站点渲染）：
//   #### 追问：
//   ##### 追问1：<问题>   {锚点}
//   **答**：<答案>
//   - 子点
// 注意：仅对 `#### 追问` 之后的列表块生效，不影响 详细解答 里的流程阶段小标题。
function transformFollowups(lines, chapterIdx, state) {
  const out = []
  let inFollowup = false
  for (const line of lines) {
    if (/^####\s*追问/.test(line)) {
      inFollowup = true
      out.push(line) // 保留"追问："小节标题（已带 f- 锚点）
      continue
    }
    if (inFollowup) {
      // 遇到新题/新章/其它 h4 标题，退出追问块
      if (/^### /.test(line) || /^## /.test(line) || /^#### /.test(line)) {
        inFollowup = false
        out.push(line)
        continue
      }
      const m = line.match(/^(\s*)- (.+)$/)
      if (m) {
        const indent = m[1].length
        const rest = m[2]
        if (indent === 0) {
          // 顶层列表项 = 一个追问问题 → 转成 h5 标题（fuIdx 为整章连续计数，保证锚点唯一）
          state.fuIdx++
          out.push(`##### ${rest} {#fu-${chapterIdx}-${state.fuIdx}}`)
          continue
        } else if (indent === 2) {
          // 缩进 2 的列表项 = 答案行 → 变成段落（去掉 "- " 标记）
          out.push(rest)
          continue
        } else {
          // 更深层 → 整体减 2 空格缩进，保持为答案下的子列表
          out.push(line.slice(2))
          continue
        }
      }
      out.push(line)
      continue
    }
    out.push(line)
  }
  return out
}

const questions = []
for (let i = 0; i < chapters.length; i++) {
  const { title, lines: body } = chapters[i]
  const slug = slugMap[i][1]
  const category = slugToCategory[slug] || '未分类'

  let qIdx = 0
  let fIdx = 0
  let inCode = false

  const modified = body.map(line => {
    if (/^```/.test(line)) inCode = !inCode
    if (inCode) return line

    if (/^### /.test(line)) {
      qIdx++
      const anchor = `q-${i + 1}-${qIdx}`
      questions.push({
        chapter: title,
        category,
        slug,
        anchor,
        title: line.replace(/^### /, '').trim(),
        level: 3,
      })
      return escapeHtmlLikeTags(`${line} {#${anchor}}`)
    }

    if (/^#### /.test(line)) {
      fIdx++
      return escapeHtmlLikeTags(`${line} {#f-${i + 1}-${fIdx}}`)
    }

    return escapeHtmlLikeTags(line)
  })

  const transformed = transformFollowups(modified, i + 1, { fuIdx: 0 })
  let content = transformed.join('\n')
  content = content.replace(/\]\((\.\/)?images\//g, '](/images/')
  const out = `---\ntitle: ${title}\n---\n\n# ${title}\n\n${content}\n`
  writeFileSync(join(docsDir, `${slug}.md`), out)
}

const categoryMeta = categories.map(c => ({
  name: c.name,
  slugs: c.slugs,
  count: questions.filter(q => q.category === c.name).length,
}))

const dataPayload = { categories: categoryMeta, questions }
writeFileSync(join(dataDir, 'questions.json'), JSON.stringify(dataPayload, null, 2))
writeFileSync(
  join(dataDir, 'questions.mjs'),
  `export default ${JSON.stringify(dataPayload, null, 2)}\n`
)

const imgSrc = join(root, 'images')
if (existsSync(imgSrc)) {
  for (const f of readdirSync(imgSrc)) {
    if (f.endsWith('.svg')) copyFileSync(join(imgSrc, f), join(publicImg, f))
  }
}

console.log(`split done: ${chapters.length} chapters -> docs/ | ${questions.length} questions -> data/questions.json`)
