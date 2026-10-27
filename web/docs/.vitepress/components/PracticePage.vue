<script setup>
import { ref, computed, onMounted } from 'vue'
import rawData from '../../data/questions.mjs'

const raw = (rawData?.default ?? rawData) || { categories: [], questions: [] }
const baseUrl = import.meta.env.BASE_URL || '/'

const categories = ['全部', ...raw.categories.map(c => c.name)]
const questions = raw.questions || []
const totalFollowUps = raw.categories.reduce((a, c) => a + c.count, 0)

const activeCategory = ref('全部')
// 星级筛选：0 = 不按星级过滤；5 = 只看必背必答
const activeStars = ref(0)
const starOptions = [5, 4, 3, 2, 1]

onMounted(() => {
  const params = new URLSearchParams(window.location.search)
  const cat = params.get('category')
  if (cat && categories.includes(cat)) {
    activeCategory.value = cat
  }
  const st = Number(params.get('stars'))
  if (st >= 1 && st <= 5) activeStars.value = st
})

const counts = computed(() => {
  const c = { '全部': questions.length }
  for (const cat of categories) {
    if (cat === '全部') continue
    c[cat] = questions.filter(q => q.category === cat).length
  }
  return c
})

// 各星级在当前分类下的题数
const starCounts = computed(() => {
  const pool = activeCategory.value === '全部'
    ? questions
    : questions.filter(q => q.category === activeCategory.value)
  const c = { 0: pool.length }
  for (const s of starOptions) c[s] = pool.filter(q => q.importance === s).length
  return c
})

const filteredQuestions = computed(() => {
  let list = questions
  if (activeCategory.value !== '全部') {
    list = list.filter(q => q.category === activeCategory.value)
  }
  if (activeStars.value) {
    list = list.filter(q => q.importance === activeStars.value)
  }
  return list
})

const groupedQuestions = computed(() => {
  const groups = {}
  for (const q of filteredQuestions.value) {
    if (!groups[q.chapter]) groups[q.chapter] = []
    groups[q.chapter].push(q)
  }
  return Object.entries(groups)
})

function chapterUrl(q) {
  // 站点未开启 cleanUrls，静态托管下内部链接需带 .html 后缀，否则跳 404
  return `${baseUrl}${q.slug}.html#${q.anchor}`
}
</script>

<template>
  <div class="practice-page">
    <h1 class="practice-title">开始刷题</h1>

    <p class="practice-desc">
      共收录 {{ questions.length }} 道面试题、{{ totalFollowUps }} 条追问。
      选择上方分类筛选题目，点击题目即可跳转到对应章节查看详细解答。
    </p>

    <div class="category-tabs">
      <button
        v-for="cat in categories"
        :key="cat"
        :class="['tab', { active: activeCategory === cat }]"
        @click="activeCategory = cat"
      >
        {{ cat }}
        <span class="count">{{ counts[cat] || 0 }}</span>
      </button>
    </div>

    <div class="star-tabs">
      <span class="star-tabs-label">按重要度</span>
      <button
        class="tab star-tab"
        :class="{ active: activeStars === 0 }"
        @click="activeStars = 0"
      >
        全部星级
        <span class="count">{{ starCounts[0] || 0 }}</span>
      </button>
      <button
        v-for="s in starOptions"
        :key="s"
        class="tab star-tab"
        :class="[{ active: activeStars === s }, `imp-${s}`]"
        @click="activeStars = activeStars === s ? 0 : s"
      >
        {{ '★'.repeat(s) }}
        <span class="count">{{ starCounts[s] || 0 }}</span>
      </button>
      <span class="star-tabs-hint">★越多越该精确背下来</span>
    </div>

    <div v-if="filteredQuestions.length === 0" class="empty">
      该分类下暂无题目
    </div>

    <div v-else class="question-groups">
      <div v-for="[chapter, items] in groupedQuestions" :key="chapter" class="group">
        <h2 class="group-title">{{ chapter }}</h2>
        <ul class="question-list">
          <li v-for="q in items" :key="q.anchor">
            <span v-if="q.importance" class="q-star" :class="`imp-${q.importance}`">{{ '★'.repeat(q.importance) }}</span>
            <a :href="chapterUrl(q)" class="question-link" :title="q.title">
              {{ q.title }}
            </a>
          </li>
        </ul>
      </div>
    </div>
  </div>
</template>
