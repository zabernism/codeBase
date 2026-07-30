<script setup lang="ts">
import { ref } from 'vue'

export interface MindNode {
  label: string
  href?: string
  count?: number
  children?: MindNode[]
}

const props = defineProps<{
  node: MindNode
  depth: number
  root?: boolean
}>()

const open = ref(false)
</script>

<template>
  <div class="mm-node" :class="{ 'mm-root': root }">
    <!-- 叶子：题目，点击跳转 -->
    <a v-if="node.href" class="mm-link" :href="node.href">{{ node.label }}</a>

    <!-- 分支：可折叠 -->
    <template v-else>
      <button class="mm-toggle" type="button" :aria-expanded="open" @click="open = !open">
        <span class="mm-caret">{{ open ? '▾' : '▸' }}</span>
        <span class="mm-label">{{ node.label }}</span>
        <span v-if="node.count != null" class="mm-count">{{ node.count }}</span>
      </button>
      <div v-if="open" class="mm-children">
        <MindMapNode
          v-for="(child, idx) in node.children"
          :key="idx"
          :node="child"
          :depth="depth + 1"
        />
      </div>
    </template>
  </div>
</template>
