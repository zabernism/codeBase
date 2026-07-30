<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount } from 'vue'

interface ThemeDef {
  key: string
  label: string
  icon: string
}

const themes: ThemeDef[] = [
  { key: 'magazine', label: '杂志风', icon: '📖' },
  { key: 'dark', label: '暗夜', icon: '🌙' },
  { key: 'minimal', label: '冷光', icon: '❄️' },
  { key: 'mint', label: '薄荷', icon: '🌿' },
]

const STORAGE_KEY = 'interview-theme'
const open = ref(false)
const current = ref('magazine')
const root = ref<HTMLElement | null>(null)

function apply(key: string) {
  current.value = key
  document.documentElement.setAttribute('data-theme', key)
  try {
    localStorage.setItem(STORAGE_KEY, key)
  } catch (e) {}
  open.value = false
}

function onDocClick(e: MouseEvent) {
  if (root.value && !root.value.contains(e.target as Node)) {
    open.value = false
  }
}

onMounted(() => {
  try {
    const saved = localStorage.getItem(STORAGE_KEY)
    if (saved && themes.some((t) => t.key === saved)) {
      current.value = saved
      document.documentElement.setAttribute('data-theme', saved)
    }
  } catch (e) {}
  document.addEventListener('click', onDocClick)
})

onBeforeUnmount(() => {
  document.removeEventListener('click', onDocClick)
})
</script>

<template>
  <div ref="root" class="theme-switcher">
    <button
      class="theme-toggle"
      type="button"
      title="切换主题"
      aria-label="切换主题"
      @click="open = !open"
    >
      <span class="tt-icon">🎨</span>
      <span class="tt-text">主题</span>
    </button>
    <transition name="theme-fade">
      <div v-if="open" class="theme-menu" role="menu">
        <button
          v-for="t in themes"
          :key="t.key"
          class="theme-item"
          :class="{ active: t.key === current }"
          type="button"
          role="menuitem"
          @click="apply(t.key)"
        >
          <span class="ti-icon">{{ t.icon }}</span>
          <span class="ti-label">{{ t.label }}</span>
        </button>
      </div>
    </transition>
  </div>
</template>
