// 把 chapters/ 下的章节文件按序合并回单体 markdown，用于备份或整份分享。
// 用法：node scripts/merge.mjs [输出路径]
// 默认输出到项目根目录 面试_带追问.merged.md
import { readFileSync, writeFileSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = join(__dirname, '..', '..')
const chaptersDir = join(root, 'chapters')
const outFile = process.argv[2] ? resolve(process.argv[2]) : join(root, '面试_带追问.merged.md')

const files = readdirSync(chaptersDir)
  .filter((f) => f.endsWith('.md'))
  .sort()

if (files.length === 0) {
  console.error('[merge] chapters/ 目录为空')
  process.exit(1)
}

// 与拆分时的切法对称：各章之间补一个换行
const merged = files
  .map((f) => readFileSync(join(chaptersDir, f), 'utf-8'))
  .join('\n')

writeFileSync(outFile, merged, 'utf-8')
console.log(`[merge] ${files.length} chapters -> ${outFile}`)
