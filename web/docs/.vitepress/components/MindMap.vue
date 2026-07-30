<script setup lang="ts">
import { computed } from 'vue'
import rawData from '../../data/questions.mjs'
import MindMapNode, { type MindNode } from './MindMapNode.vue'

const raw = (rawData?.default ?? rawData) || { categories: [], questions: [] }
const questions: any[] = raw.questions || []
const categories: any[] = raw.categories || []

// 按 分类 → 章节 → 题目 构建树。题目顺序保持源文档顺序（按 slug 首次出现分组）。
const tree = computed<MindNode>(() => {
  const catNodes: MindNode[] = categories.map((cat) => {
    const qs = questions.filter((q) => q.category === cat.name)
    const bySlug = new Map<string, MindNode>()
    for (const q of qs) {
      if (!bySlug.has(q.slug)) {
        bySlug.set(q.slug, { label: q.chapter, count: 0, children: [] })
      }
      const ch = bySlug.get(q.slug)!
      ch.count = (ch.count || 0) + 1
      ch.children!.push({ label: q.title, href: `/${q.slug}.html#${q.anchor}` })
    }
    return {
      label: cat.name,
      count: qs.length,
      children: Array.from(bySlug.values()),
    }
  })
  return {
    label: `全部题目 · ${questions.length} 道`,
    count: questions.length,
    children: catNodes,
  }
})
</script>

<template>
  <section class="mindmap-section">
    <h2 class="mindmap-heading">🧠 面试题脑图</h2>
    <p class="mindmap-sub">
      默认折叠。展开「分类 → 章节」即可看到题目，点击题目直达对应内容。
    </p>
    <div class="mindmap">
      <MindMapNode :node="tree" :depth="0" :root="true" />
    </div>
  </section>
</template>
