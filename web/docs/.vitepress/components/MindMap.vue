<script setup lang="ts">
import { computed, ref, onMounted, provide } from 'vue'
import rawData from '../../data/questions.mjs'
import MindMapNode, { type MindNode } from './MindMapNode.vue'

const raw = (rawData?.default ?? rawData) || { categories: [], questions: [] }
const questions: any[] = raw.questions || []
const categories: any[] = raw.categories || []

// 分类配色：每个分类一个主题色（节点描边/计数徽章/左侧色条）
const categoryColors: Record<string, string> = {
  '系统设计': '#6366f1',       // indigo
  'AI / 大模型': '#8b5cf6',    // violet
  'Java 后端': '#ea580c',      // orange
  '数据与中间件': '#0891b2',    // cyan
  '系统与网络': '#16a34a',     // green
  '工程与云原生': '#2563eb',   // blue
  '绿色低碳': '#059669',       // emerald
  '附录': '#64748b',           // slate
}

// 按 分类 → 章节 → 题目 → 追问 构建树。
const tree = computed<MindNode>(() => {
  const catNodes: MindNode[] = categories.map((cat) => {
    const qs = questions.filter((q) => q.category === cat.name)
    const bySlug = new Map<string, MindNode>()
    for (const q of qs) {
      if (!bySlug.has(q.slug)) {
        bySlug.set(q.slug, { label: q.chapter, count: 0, children: [], color: categoryColors[cat.name] })
      }
      const ch = bySlug.get(q.slug)!
      ch.count = (ch.count || 0) + 1
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
      color: categoryColors[cat.name],
      children: Array.from(bySlug.values()),
    }
  })
  return {
    label: `全部题目 · ${questions.length} 道`,
    count: questions.length,
    children: catNodes,
  }
})

// 搜索过滤
const searchQuery = ref('')
const filteredTree = computed<MindNode | null>(() => {
  const q = searchQuery.value.trim().toLowerCase()
  if (!q) return tree.value

  function filterNode(node: MindNode): MindNode | null {
    const matchSelf = node.label.toLowerCase().includes(q)
    if (!node.children) {
      return matchSelf ? { ...node } : null
    }
    const filteredChildren = node.children
      .map(filterNode)
      .filter((n): n is MindNode => n !== null)
    if (matchSelf || filteredChildren.length) {
      return {
        ...node,
        count: filteredChildren.length || node.count,
        children: filteredChildren.length ? filteredChildren : node.children,
        _expanded: true,
      } as MindNode & { _expanded: true }
    }
    return null
  }

  return filterNode(tree.value)
})

// 搜索时自动展开
const autoExpand = computed(() => !!searchQuery.value.trim())

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

// 一键展开全部 / 折叠全部
const expandVersion = ref(0)
const expandState = ref<boolean | null>(null)
provide('mm-expand', { expandVersion, expandState, autoExpand })
function expandAll() {
  expandState.value = true
  expandVersion.value++
}
function collapseAll() {
  expandState.value = false
  expandVersion.value++
}

// 统计
const stats = computed(() => {
  const chapterCount = tree.value.children?.reduce((sum, cat) => sum + (cat.children?.length || 0), 0) || 0
  const followupCount = questions.reduce((sum, q) => sum + (q.followups?.length || 0), 0)
  return { chapterCount, followupCount }
})
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
      <div class="mm-head-tools">
        <div class="mm-search-box">
          <input
            v-model="searchQuery"
            type="text"
            class="mm-search-input"
            placeholder="搜索题目..."
            aria-label="搜索题目"
          />
          <svg v-if="searchQuery" class="mm-search-clear" viewBox="0 0 20 20" fill="currentColor" @click="searchQuery = ''">
            <path fill-rule="evenodd" d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z" clip-rule="evenodd"/>
          </svg>
        </div>
        <div class="mm-actions">
          <button class="mm-act-btn" type="button" @click="expandAll">展开全部</button>
          <button class="mm-act-btn" type="button" @click="collapseAll">折叠全部</button>
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
    </div>

    <div class="mm-stats-bar">
      <span class="mm-stat"><strong>{{ questions.length }}</strong> 道题目</span>
      <span class="mm-stat-sep">·</span>
      <span class="mm-stat"><strong>{{ stats.chapterCount }}</strong> 个章节</span>
      <span class="mm-stat-sep">·</span>
      <span class="mm-stat"><strong>{{ stats.followupCount }}</strong> 个追问</span>
      <span class="mm-stat-sep">·</span>
      <span class="mm-stat"><strong>{{ categories.length }}</strong> 个分类</span>
    </div>

    <div class="mindmap" :class="`style-${styleMode}`">
      <MindMapNode v-if="filteredTree" :node="filteredTree" :depth="0" :root="true" />
      <div v-else class="mm-empty">未找到匹配「{{ searchQuery }}」的题目</div>
    </div>
  </section>
</template>
