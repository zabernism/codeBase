export const categories = [
  {
    name: '系统设计',
    slugs: ['17-system-design', '18-design-patterns'],
  },
  {
    name: 'AI / 大模型',
    slugs: [
      '10-llm-fundamentals',
      '02-ai-model-integration',
      '03-rag',
      '08-vector-db-embedding',
      '07-prompt-engineering',
      '04-spring-ai',
      '05-langchain4j',
      '06-ai-agent',
      '23-mcp',
      '38-ai-gateway',
      '09-engineering-production',
      '25-multimodal-security',
      '26-training-finetune',
    ],
  },
  {
    name: 'Java 后端',
    slugs: ['01-java-basics', '33-jvm-gc', '11-spring-ecosystem', '12-spring-cloud', '15-concurrency-juc', '34-algorithm-ds', '36-security'],
  },
  {
    name: '数据与中间件',
    slugs: ['13-mysql', '14-redis', '16-mq', '35-elasticsearch', '37-distributed-tx'],
  },
  {
    name: '系统与网络',
    slugs: ['21-network', '22-os'],
  },
  {
    name: '工程与云原生',
    slugs: ['19-k8s', '20-cicd'],
  },
  {
    name: '绿色低碳',
    slugs: [
      '27-carbon-accounting',
      '28-esg-disclosure',
      '29-carbon-policy-market',
      '30-carbon-data-platform',
      '32-carbon-compliance-audit',
    ],
  },
  {
    name: '附录',
    slugs: ['appendix-open-questions'],
  },
]

export const slugToCategory = Object.fromEntries(
  categories.flatMap(c => c.slugs.map(s => [s, c.name]))
)
