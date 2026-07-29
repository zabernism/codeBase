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

// 每个章节的固定 slug（顺序必须与 面试_带追问.md 的 ## 章节顺序一致）。
// 章节标题本身由 md 解析得到（见下方 chapters），这里只保留 slug 这一稳定标识。
const slugs = [
  '01-java-basics',
  '02-ai-model-integration',
  '03-rag',
  '04-spring-ai',
  '05-langchain4j',
  '06-ai-agent',
  '07-prompt-engineering',
  '08-vector-db-embedding',
  '09-engineering-production',
  '10-llm-fundamentals',
  '11-spring-ecosystem',
  '12-spring-cloud',
  '13-mysql',
  '14-redis',
  '15-concurrency-juc',
  '16-mq',
  '17-system-design',
  '18-design-patterns',
  '19-k8s',
  '20-cicd',
  '21-network',
  '22-os',
  '23-mcp',
  '24-llmops',
  '25-multimodal-security',
  '26-training-finetune',
  '27-carbon-accounting',
  '28-esg-disclosure',
  '29-carbon-policy-market',
  '30-carbon-data-platform',
  '31-carbon-java-composite',
  '32-carbon-compliance-audit',
  '33-jvm-gc',
  '34-algorithm-ds',
  '35-elasticsearch',
  '36-security',
  '37-distributed-tx',
  'appendix-open-questions',
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
if (chapters.length !== slugs.length) {
  console.error(`章节数 ${chapters.length} ≠ 期望 ${slugs.length}`)
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
  const slug = slugs[i]
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

    // 五位一体：把 **难度**：… 这类行转成结构化标签，便于杂志风排版。
    // 仅匹配 难度/考点/参考答案/深度解析/易错点 五种；正文保留行内 markdown（反引号代码等）。
    const five = line.match(/^\*\*(难度|考点|参考答案|深度解析|易错点)\*\*[:：]\s?(.*)$/)
    if (five) {
      const label = five[1]
      const bodyText = five[2]
      const safe = escapeHtmlLikeTags(bodyText)
      // 标签设为 block，正文自然落到下一行；span 内的 label 不再带冒号
      return `<span class="five-label">${label}</span>\n${safe}`
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

// 由 md 的 ## 章节标题生成目录清单，作为导航/侧边栏的唯一真相源。
// text 去掉可能不准确的题数后缀（如（50题）（29道项目设计题）），
// 保留（AI场景下）（GHG Protocol…）等说明性括号。
function cleanTitle(t) {
  return t
    .replace(/（[^）]*\d+\s*[题道][^）]*）/g, '')
    .replace(/\s*[—–-]\s*$/u, '')
    .trim()
}

const chaptersManifest = chapters.map((c, i) => ({
  index: i + 1,
  slug: slugs[i],
  title: c.title,           // md 原始标题
  text: cleanTitle(c.title), // 侧边栏/导航展示标题
}))
writeFileSync(join(dataDir, 'chapters.json'), JSON.stringify(chaptersManifest, null, 2))

const imgSrc = join(root, 'images')
if (existsSync(imgSrc)) {
  for (const f of readdirSync(imgSrc)) {
    if (f.endsWith('.svg')) copyFileSync(join(imgSrc, f), join(publicImg, f))
  }
}

console.log(`split done: ${chapters.length} chapters -> docs/ | ${questions.length} questions -> data/questions.json`)
