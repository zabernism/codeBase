export const categories = [
  {
    name: 'AI / 大模型',
    slugs: [
      '02-ai-model-integration',
      '03-rag',
      '04-spring-ai',
      '05-langchain4j',
      '06-ai-agent',
      '07-prompt-engineering',
      '08-vector-db-embedding',
      '10-llm-fundamentals',
      '23-mcp',
      '24-llmops',
      '25-multimodal-security',
      '26-training-finetune',
    ],
  },
  {
    name: 'Java 后端',
    slugs: ['01-java-basics', '11-spring-ecosystem', '12-spring-cloud', '15-concurrency-juc'],
  },
  {
    name: '数据与中间件',
    slugs: ['13-mysql', '14-redis', '16-mq'],
  },
  {
    name: '系统与网络',
    slugs: ['21-network', '22-os'],
  },
  {
    name: '工程与云原生',
    slugs: ['09-engineering-production', '19-k8s', '20-cicd'],
  },
  {
    name: '系统设计',
    slugs: ['17-system-design', '18-design-patterns'],
  },
  {
    name: '附录',
    slugs: ['appendix-open-questions'],
  },
]

export const slugToCategory = Object.fromEntries(
  categories.flatMap(c => c.slugs.map(s => [s, c.name]))
)
