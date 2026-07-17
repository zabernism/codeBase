<script setup>
import { ref, computed, onMounted } from 'vue'

const KEY = 'interview-last-read'
const baseUrl = import.meta.env.BASE_URL || '/'

const last = ref(null)
const dismissedAt = ref(0)

onMounted(() => {
  try {
    const data = JSON.parse(localStorage.getItem(KEY) || '{}')
    if (data.last && data.last.path && data.last.path !== '/') {
      last.value = data.last
      dismissedAt.value = data.dismissedAt || 0
    }
  } catch (e) {
    // ignore parse errors
  }
})

const visible = computed(() => {
  return last.value && last.value.path !== '/' && last.value.path !== '/practice'
    && last.value.ts > dismissedAt.value
})

const href = computed(() => {
  if (!last.value) return '/'
  return baseUrl.replace(/\/$/, '') + last.value.path
})

function dismiss() {
  dismissedAt.value = Date.now()
  try {
    const data = JSON.parse(localStorage.getItem(KEY) || '{}')
    data.dismissedAt = dismissedAt.value
    localStorage.setItem(KEY, JSON.stringify(data))
  } catch (e) {}
}
</script>

<template>
  <div v-if="visible" class="continue-bar">
    <div class="continue-info">
      <span class="continue-label">继续阅读</span>
      <a class="continue-title" :href="href">{{ last.title }}</a>
    </div>
    <button class="continue-close" @click="dismiss" aria-label="不再提示">×</button>
  </div>
</template>
