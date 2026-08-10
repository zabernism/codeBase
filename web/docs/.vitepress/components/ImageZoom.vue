<template>
  <Teleport to="body">
    <div v-if="open" class="img-zoom-overlay" @click="close">
      <img class="img-zoom-target" :class="{ 'zoom-arch': isArch }" :src="src" :alt="alt" @click.stop />
      <button class="img-zoom-close" @click.stop="close" aria-label="关闭">×</button>
      <div class="img-zoom-hint">点击空白处或按 Esc 关闭</div>
    </div>
  </Teleport>
</template>

<script setup>
import { onMounted, onUnmounted, ref } from 'vue'

const open = ref(false)
const src = ref('')
const alt = ref('')
const isArch = ref(false)

const ARCH_RE = /arch-overview|cortex-rag|matrix/

const onDocClick = (e) => {
  const target = e.target
  if (!(target instanceof HTMLImageElement)) return
  // 只放大正文区内的图片，避开导航/图标等非正文 img
  if (!target.closest('.vp-doc')) return
  src.value = target.currentSrc || target.src
  alt.value = target.alt || ''
  // 架构图（固定宽 SVG）在灯箱里按原始尺寸显示，避免被缩糊
  isArch.value = ARCH_RE.test(src.value)
  open.value = true
  if (typeof document !== 'undefined') document.body.style.overflow = 'hidden'
}

const onKey = (e) => {
  if (e.key === 'Escape' && open.value) close()
}

const close = () => {
  open.value = false
  src.value = ''
  isArch.value = false
  if (typeof document !== 'undefined') document.body.style.overflow = ''
}

onMounted(() => {
  if (typeof document !== 'undefined') {
    document.addEventListener('click', onDocClick)
    document.addEventListener('keydown', onKey)
  }
})

onUnmounted(() => {
  if (typeof document !== 'undefined') {
    document.removeEventListener('click', onDocClick)
    document.removeEventListener('keydown', onKey)
    document.body.style.overflow = ''
  }
})
</script>
