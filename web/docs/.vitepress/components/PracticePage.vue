<script setup>
import { ref, computed, onMounted } from 'vue'
import rawData from '../../data/questions.mjs'

const raw = (rawData?.default ?? rawData) || { categories: [], questions: [] }
const baseUrl = import.meta.env.BASE_URL || '/'

const categories = ['全部', ...raw.categories.map(c => c.name)]
const questions = raw.questions || []
const totalFollowUps = raw.categories.reduce((a, c) => a + c.count, 0)

const activeCategory = ref('全部')

onMounted(() => {
  const params = new URLSearchParams(window.location.search)
  const cat = params.get('category')
  if (cat && categories.includes(cat)) {
    activeCategory.value = cat
  }
})

const counts = computed(() => {
  const c = { '全部': questions.length }
  for (const cat of categories) {
    if (cat === '全部') continue
    c[cat] = questions.filter(q => q.category === cat).length
  }
  return c
})

const filteredQuestions = computed(() => {
  if (activeCategory.value === '全部') return questions
  return questions.filter(q => q.category === activeCategory.value)
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
  return `${baseUrl}${q.slug}#${q.anchor}`
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

    <div v-if="filteredQuestions.length === 0" class="empty">
      该分类下暂无题目
    </div>

    <div v-else class="question-groups">
      <div v-for="[chapter, items] in groupedQuestions" :key="chapter" class="group">
        <h2 class="group-title">{{ chapter }}</h2>
        <ul class="question-list">
          <li v-for="q in items" :key="q.anchor">
            <a :href="chapterUrl(q)" class="question-link" :title="q.title">
              {{ q.title }}
            </a>
          </li>
        </ul>
      </div>
    </div>
  </div>
</template>
