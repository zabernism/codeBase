<script setup lang="ts">
import { ref, inject, watch, onMounted, computed } from 'vue'

export interface MindNode {
  label: string
  href?: string
  count?: number
  followup?: boolean
  color?: string
  children?: MindNode[]
  _expanded?: boolean
}

const props = defineProps<{
  node: MindNode
  depth: number
  root?: boolean
  last?: boolean
}>()

const open = ref(false)
const hasChildren = !!(props.node.children && props.node.children.length)

// 注入父级「一键展开/折叠全部」信号
interface ExpandControl {
  expandVersion: { value: number }
  expandState: { value: boolean | null }
  autoExpand: { value: boolean }
}
const expand = inject<ExpandControl | null>('mm-expand', null)

function applyForcedState() {
  if (expand && expand.expandState.value != null && hasChildren) {
    open.value = expand.expandState.value
  }
  // 搜索时自动展开有匹配的节点
  if (expand?.autoExpand.value && hasChildren) {
    open.value = true
  }
}
watch(
  () => expand?.expandVersion.value,
  () => applyForcedState(),
)
watch(
  () => expand?.autoExpand.value,
  () => applyForcedState(),
)
onMounted(() => {
  // 根节点默认展开（显示分类），分类层级默认折叠
  if (props.root) open.value = true
  applyForcedState()
})

const depthClass = computed(() => `mm-depth-${Math.min(props.depth, 4)}`)
</script>

<template>
  <div
    class="mm-node"
    :class="[depthClass, { 'mm-root': root, 'mm-last': last, 'mm-followup': node.followup }]"
  >
    <div class="mm-row" :style="root ? {} : (depth === 1 && node.color ? { '--mm-accent': node.color } : {})">
      <button
        v-if="hasChildren"
        class="mm-caret"
        type="button"
        :aria-expanded="open"
        :title="open ? '折叠' : '展开'"
        @click="open = !open"
      >
        <svg class="mm-caret-icon" :class="{ open }" viewBox="0 0 20 20" fill="currentColor">
          <path fill-rule="evenodd" d="M7.21 14.77a.75.75 0 01.02-1.06L11.168 10 7.23 6.29a.75.75 0 111.04-1.08l4.5 4.25a.75.75 0 010 1.08l-4.5 4.25a.75.75 0 01-1.06-.02z" clip-rule="evenodd"/>
        </svg>
      </button>
      <span v-else class="mm-dot" :style="node.followup ? {} : (node.color ? { background: node.color } : {})" aria-hidden="true"></span>

      <a v-if="node.href" class="mm-link" :href="node.href">
        <span v-if="node.followup" class="mm-fu-icon" aria-hidden="true">↳</span>{{ node.label }}
      </a>
      <span v-else class="mm-label">{{ node.label }}</span>

      <span v-if="node.count != null" class="mm-count" :style="depth === 0 && node.color ? { background: node.color + '18', color: node.color } : {}">{{ node.count }}</span>
    </div>

    <transition name="mm-expand">
      <div v-if="open && hasChildren" class="mm-children">
        <MindMapNode
          v-for="(child, idx) in node.children"
          :key="idx"
          :node="child"
          :depth="depth + 1"
          :last="idx === node.children.length - 1"
        />
      </div>
    </transition>
  </div>
</template>

<style scoped>
.mm-caret-icon {
  width: 14px;
  height: 14px;
  transition: transform 0.18s ease;
}
.mm-caret-icon.open {
  transform: rotate(90deg);
}
.mm-expand-enter-active,
.mm-expand-leave-active {
  transition: opacity 0.18s ease, max-height 0.25s ease;
  overflow: hidden;
}
.mm-expand-enter-from,
.mm-expand-leave-to {
  opacity: 0;
  max-height: 0;
}
.mm-expand-enter-to,
.mm-expand-leave-from {
  opacity: 1;
  max-height: 6000px;
}
</style>
