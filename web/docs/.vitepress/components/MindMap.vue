<script setup lang="ts">
import { computed, ref, onMounted } from 'vue'
import rawData from '../../data/questions.mjs'
import MindMapNode, { type MindNode } from './MindMapNode.vue'

const raw = (rawData?.default ?? rawData) || { categories: [], questions: [] }
const questions: any[] = raw.questions || []
const categories: any[] = raw.categories || []

// 按 分类 → 章节 → 题目 → 追问 构建树。
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
      // 题目节点：自身可点击跳转（href），展开后挂追问子节点（children）
      const followupChildren: MindNode[] | undefined =
        q.followups && q.followups.length
          ? q.followups.map((f: any) => ({
              label: f.title,
              href: `/${q.slug}.html#${f.anchor}`,
              followup: true,
            }))
          : undefined
      ch.children!.push({
        label: q.title,
        href: `/${q.slug}.html#${q.anchor}`,
        children: followupChildren,
      })
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

// 脑图布局样式可切换：树状（带连线）/ 缩进（简洁）。记忆到 localStorage。
type MMStyle = 'tree' | 'indent'
const STYLE_KEY = 'interview-mindmap-style'
const styleMode = ref<MMStyle>('tree')
onMounted(() => {
  const saved = (typeof localStorage !== 'undefined' && localStorage.getItem(STYLE_KEY)) as MMStyle | null
  if (saved === 'tree' || saved === 'indent') styleMode.value = saved
})
function setStyle(s: MMStyle) {
  styleMode.value = s
  try { localStorage.setItem(STYLE_KEY, s) } catch {}
}
const styleOptions: { key: MMStyle; label: string }[] = [
  { key: 'tree', label: '树状' },
  { key: 'indent', label: '缩进' },
]
</script>

<template>
  <section class="mindmap-section">
    <div class="mindmap-head">
      <div>
        <h2 class="mindmap-heading">🧠 面试题脑图</h2>
        <p class="mindmap-sub">
          默认折叠。展开「分类 → 章节 → 题目」即可看到追问，点击任意节点直达对应内容。
        </p>
      </div>
      <div class="mm-style-switch" role="group" aria-label="脑图样式">
        <button
          v-for="opt in styleOptions"
          :key="opt.key"
          type="button"
          class="mm-style-btn"
          :class="{ active: styleMode === opt.key }"
          @click="setStyle(opt.key)"
        >{{ opt.label }}</button>
      </div>
    </div>

    <div class="mindmap" :class="`style-${styleMode}`">
      <MindMapNode :node="tree" :depth="0" :root="true" />
    </div>
  </section>
</template>
