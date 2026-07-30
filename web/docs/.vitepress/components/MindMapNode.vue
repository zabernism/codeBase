<script setup lang="ts">
import { ref } from 'vue'

export interface MindNode {
  label: string
  href?: string
  count?: number
  followup?: boolean
  children?: MindNode[]
}

const props = defineProps<{
  node: MindNode
  depth: number
  root?: boolean
  last?: boolean
}>()

const open = ref(false)
const hasChildren = !!(props.node.children && props.node.children.length)
</script>

<template>
  <div class="mm-node" :class="{ 'mm-root': root, 'mm-last': last, 'mm-followup': node.followup }">
    <div class="mm-row">
      <!-- 分支：带折叠按钮；若同时有 href（如题目），按钮旁仍给出跳转链接 -->
      <button
        v-if="hasChildren"
        class="mm-caret"
        type="button"
        :aria-expanded="open"
        :title="open ? '折叠' : '展开'"
        @click="open = !open"
      >{{ open ? '▾' : '▸' }}</button>
      <span v-else class="mm-dot" aria-hidden="true"></span>

      <a v-if="node.href" class="mm-link" :href="node.href">{{ node.label }}</a>
      <span v-else class="mm-label">{{ node.label }}</span>

      <span v-if="node.count != null" class="mm-count">{{ node.count }}</span>
    </div>

    <div v-if="open && hasChildren" class="mm-children">
      <MindMapNode
        v-for="(child, idx) in node.children"
        :key="idx"
        :node="child"
        :depth="depth + 1"
        :last="idx === node.children.length - 1"
      />
    </div>
  </div>
</template>
