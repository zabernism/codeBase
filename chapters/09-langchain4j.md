## 第九章：LangChain4j框架

> 本章是 Spring AI 的对照面，也是不少团队的实际选择。LangChain4j 的核心范式是"定义业务接口 + `AiServices` 构建期生成代理"——注意 `AiServices` 本身没有 `chat` 方法，运行时调用的是你自己声明的接口方法。面试常问二者取舍：Spring AI 与 Spring 生态融合更深，LangChain4j 的 AI 抽象更直接。



### 1. LangChain4j核心架构是什么？模块化三层架构是怎样的？
**重要度**：★★★★

**三层架构**：

```
┌──────────────────────────────────┐
│  高层 API（AiServices）            │  ← 声明式，接口+注解
├──────────────────────────────────┤
│  中层 API（Services/Components）   │  ← RAG/Agent/Memory/Tools
├──────────────────────────────────┤
│  底层 API（Core）                  │  ← ChatModel/EmbeddingModel
└──────────────────────────────────┘
```

- **底层**：模型接口抽象（`ChatModel`、`EmbeddingModel` 等，`ChatLanguageModel` 是 0.x 旧名）。
- **中层**：功能组件（ContentRetriever、ChatMemory、Tool、OutputParser 等）。
- **高层**：`AiServices` 声明式 API，通过接口+注解定义 AI 服务。

#### 追问：
- 追问1：如果业务需要同时调用通义千问和自建vLLM两个底层模型，你会如何在LangChain4j的三层架构中做统一抽象而不破坏上层AiServices的声明式接口？
  - **答**：在底层用 `ChatModel` 接口封装两个实现（社区模块的 QwenChatModel，以及指向自建 vLLM 的 OpenAI 兼容 `ChatModel`），对外暴露统一接口；中层用路由（如 `ModelRouter`）按场景选择，再注入到同一 `AiServices` 的 `.chatModel()`，高层声明式接口完全无感。注意 LangChain4j 没有内置的主备模型 / fallback 链，主备切换要自己写一个实现 `ChatModel` 接口的装饰器（内部持主备两个 delegate，按健康度或异常顺序 try），或把 fallback 下沉到 AI 网关层。
- 追问2：在"底层API—中层组件—高层AiServices"分层中，碳管家项目把RAG编排放在哪一层、把流式输出放在哪一层，依据是什么？
  - **答**：RAG 编排（Retriever/QueryTransformer/Augmentor）属于中层组件层——通过 `AiServices.contentRetriever()` / `retrievalAugmentor()` 注入，是功能组件而非业务接口；流式输出属于底层模型能力（1.x 里 `ChatModel` 本身就带流式方法 `chat(req, StreamingChatResponseHandler)`，独立用 `StreamingChatModel` 也行），高层接口返回 `TokenStream`，依据是"流式是模型能力、RAG 是编排策略"。
- 追问3：当高层的AiServices声明的接口方法需要同时支持RAG检索和工具调用时，三层架构之间的依赖边界应如何划分以避免业务逻辑耦合？
  - **答**：高层只声明契约与注解（不含逻辑）；中层由框架把 `ContentRetriever` 与 `@Tool` 分别接到 Augmentor 和 ToolExecutor，二者通过各自 SPI 扩展点接入；业务代码仅提供 Retriever 实现与 Tool 方法。依赖边界为"接口=契约、组件=能力"，检索/工具逻辑不写进接口方法体。

### 2. LangChain4j的DefaultRetrievalAugmentor在RAG场景中扮演什么角色？其内部组件是如何编排的？
**重要度**：★★★★★

**DefaultRetrievalAugmentor** 是 RAG 流程的编排核心，内部组件：

```
用户查询
  → QueryTransformer（查询改写/扩展）
  → ContentRetriever（向量检索）
  → ContentInjector（将检索内容注入 Prompt）
  → 大模型生成
```

- **QueryTransformer**：改写用户查询（如将"它怎么算"改写为"碳足迹怎么计算"）。
- **ContentRetriever**：执行向量检索，返回相关 chunk。
- **ContentInjector**：将 chunk 内容注入到 Prompt 的 User Message 中。

#### 追问：
- 追问1：在碳管家实际场景中，如果QueryTransformer把"它怎么算"改写成"碳足迹怎么计算"后仍然检索不到相关ISO条款，DefaultRetrievalAugmentor的后续流程会如何退化、你如何兜底？
  - **答**：默认流程不会崩溃，只是注入空/低分片段继续生成，易出现编造。兜底：
    - ① 先尝试 Query 扩展/同义词重写重试
    - ② 降级为关键词检索（BM25/ES）或换一个 Web 搜索 retriever
    - ③ Prompt 明确"无相关条款如实告知并给建议"，由 Moderation 阻止编造来源
- 追问2：ContentRetriever返回的chunk在注入Prompt前，你如何控制注入数量与长度以同时满足"引用来源"和"上下文窗口限制"两个约束？
  - **答**：用 `maxResults`+`minScore` 双约束先截断；再按 token 预算对命中 chunk 做长度裁剪（保留来源编号，超长截断并标"[省略]"）；ContentInjector 注入时保留 `metadata.source` 满足引用；必要时先 rerank 再取 Top-K 控制总量。
- 追问3：当ContentInjector把检索内容注入User Message后模型仍出现幻觉，你会如何从Augmentor编排层面（而非单纯调Prompt）去定位并缓解？
  - **答**：编排层定位：
    - ① 加 `QueryTransformer` 日志看改写是否跑偏
    - ② 在 ContentRetriever 外套一层自定义 `ContentRetriever` 装饰器做后置过滤去噪（过滤低分/无关来源），质量仍不够再接 `ReRankingContentAggregator` 重排（LangChain4j 没有 `contextFilterChain`，过滤只能自己包一层 retriever）
    - ③ 生成后接独立校验服务，校验"答案是否可追溯到注入片段"（LC4j 没有 validationChain，校验只能放在 AiServices 调用之后做）
    - ④ 用 reranker 提升注入质量，从"塞得多"改为"塞得准"

### 3. LangChain4j支持哪些向量数据库？EmbeddingStore是什么？
**重要度**：★★★★★

支持：Milvus、PGVector、Chroma、Weaviate、Pinecone、Qdrant、ElasticSearch、Redis 等。

**EmbeddingStore**：LangChain4j 的向量存储抽象接口：

```java
public interface EmbeddingStore<Embedded> {
    // ---- 写入 ----
    String add(Embedding embedding);                            // 只存向量，返回自动生成的 id
    String add(Embedding embedding, Embedded embedded);         // 向量 + 原始内容（通常传 TextSegment）
    void add(String id, Embedding embedding);
    void add(String id, Embedding embedding, Embedded embedded);
    List<String> addAll(List<Embedding> embeddings);
    void addAll(List<Embedding> embeddings, List<Embedded> embedded);

    // ---- 检索（1.x 主入口）----
    EmbeddingSearchResult<Embedded> search(EmbeddingSearchRequest request);

    // ---- 删除 ----
    void removeAll();                          // 清空整个 store
    void removeAll(Collection<String> ids);
    void removeAll(Filter filter);

    // 便捷方法：内部就是用 search(EmbeddingSearchRequest) 实现的，返回按 score 倒序的 Top-K
    default List<EmbeddingMatch<Embedded>> findRelevant(Embedding reference, int maxResults, double minScore) { ... }
}
```

要点：写库方法同时有"只给向量"和"向量 + 原文"两类重载（后者才能把 `TextSegment` 一起存下来供检索后回填）；检索统一走 `search(EmbeddingSearchRequest)`（可设 maxResults / minScore / filter / 是否需要嵌入内容），`findRelevant` 只是它的语法糖。

#### 追问：
- 追问1：在碳管家接入Milvus时，如果某批排放因子文档的embedding维度与已建Collection不一致，EmbeddingStore的add方法会在哪一层报错、如何在不重建库的前提下兼容？
  - **答**：错误发生在 `EmbeddingStore.add()` 调用 Milvus insert 阶段（维度不匹配被服务端拒绝）。不重建库兼容：
    - ① 新建维度匹配的 Collection 双写/迁移
    - ② 统一用同一 EmbeddingModel 重新向量化该批文档
    - ③ 规范做法是在建库时把维度写入配置，add 前做断言校验避免不一致写入
- 追问2：findRelevant的minScore阈值在碳管家这种"数值必须严谨"的场景下应如何设定，过低或过高分别会引发什么失败模式？
  - **答**：阈值建议偏高且配合 rerank（如先取 Top-20 再 rerank 取高置信 Top-3，minScore 设 0.7 量级）。过低→混入无关因子导致错误引用/幻觉；过高→漏召回正确条款，拒答率上升。应结合召回率与精确率离线标定，而非拍脑袋。

### 4. 请描述一个你从0到1搭建的完整LangChain4j项目，包括技术选型、架构设计、难点攻克。
**重要度**：★★★★

**项目**：碳管家AI助手（RAG 知识问答）

**技术选型**：

- 框架：LangChain4j 1.x（项目当时用 0.34，新项目建议 1.x）+ Spring Boot 3
- 模型：通义千问 Qwen-Plus（Chat）+ bge-large-zh-v1.5（Embedding）
- 向量库：Milvus 2.4
- 记忆：Redis ChatMemory
- 分块：递归分块器

**架构设计**：

```
用户 → Controller → AiServices(CarbonAssistant)
                        ├── ChatMemory(Redis)
                        ├── ContentRetriever(Milvus)
                        ├── Tools(queryFactor, getRegulation)
                        └── OutputParser(JSON)
```

**难点攻克**：

1. **检索准确率低**：增加 Re-ranking（bge-reranker-large），Top-1 命中率从 75% → 92%（口径：人工标注 300 条碳核算问答的测试集，命中标准条款即算对；基线是不带 rerank 的纯向量召回）。
2. **上下文溢出**：历史对话摘要压缩，只保留最近3轮 + 摘要。
3. **多轮对话指代消解**：QueryTransformer 改写"它"为具体名词。
4. **工具调用死循环**：限制最大工具调用次数为3。


#### 三种框架实现对比

##### Spring AI 1.0 实现

```java
// 碳管家 AI 助手：Controller → Facade → ChatClient(RAG+记忆+工具) 三段式装配
@Service
public class CarbonAssistantService {

    private final ChatClient chatClient;          // 已由 starter 自动装配注入
    private final ChatMemory chatMemory;           // MessageWindowChatMemory
    private final VectorStore factorVectorStore;   // Milvus / PGVector

    public CarbonAssistantService(ChatModel chatModel, ChatMemory chatMemory,
                                  VectorStore factorVectorStore) {
        this.chatMemory = chatMemory;
        this.factorVectorStore = factorVectorStore;
        // 难点1：Reranking 放在检索之后、注入之前；这里用 Advisor 链表达编排顺序
        this.chatClient = ChatClient.builder(chatModel)
                .defaultAdvisors(
                        // 1.0 的 QuestionAnswerAdvisor 只有单参构造器，SearchRequest 必须走 builder
                        QuestionAnswerAdvisor.builder(factorVectorStore)
                                .searchRequest(SearchRequest.builder()
                                        .topK(20)                      // 先粗排 20 条
                                        .similarityThreshold(0.75)     // 对应 LC4j 的 minScore
                                        .build())
                                .build(),
                        MessageChatMemoryAdvisor.builder(chatMemory).build())
                .defaultTools(new CarbonFactorTool()) // 难点3：工具调用次数由 Advisor 兜底
                .defaultSystem("你是碳管理专家，回答必须引用因子库来源。")
                .build();
    }

    public String chat(String sessionId, String question) {
        // 难点2：conversationId 显式传入，保证多轮会话隔离
        return chatClient.prompt()
                .user(question)
                .advisors(a -> a.param(ChatMemory.CONVERSATION_ID, sessionId))
                .call()
                .content();
    }
}
```

##### Spring AI 2.0 实现

```java
// 2.0 差异：options 必须传 builder；工具需显式注册 ToolCallback Bean；conversationId 必填
@Service
public class CarbonAssistantService {

    private final ChatClient chatClient;
    private final ToolCallback carbonFactorTool;   // 由 @Bean ToolCallback 显式注入

    public CarbonAssistantService(ChatModel chatModel, ChatMemory chatMemory,
                                  VectorStore factorVectorStore,
                                  ToolCallback carbonFactorTool) {
        this.carbonFactorTool = carbonFactorTool;
        // 2.0：ChatClient 自动注册 ToolCallingAdvisor 驱动工具循环，
        //       这里只把工具"贴"上去，无需手写 tool-calling 循环
        this.chatClient = ChatClient.builder(chatModel)
                .defaultAdvisors(
                        QuestionAnswerAdvisor.builder(factorVectorStore)
                                .searchRequest(SearchRequest.builder()
                                        .topK(20)
                                        .similarityThreshold(0.75)
                                        .build())
                                .build(),
                        MessageChatMemoryAdvisor.builder(chatMemory).build())
                .defaultToolCallbacks(carbonFactorTool)
                .defaultSystem("你是碳管理专家，回答必须引用因子库来源。")
                .build();
    }

    public String chat(String sessionId, String question) {
        // 2.0：conversationId 必填，DEFAULT_CONVERSATION_ID 已移除
        return chatClient.prompt()
                .user(question)
                .advisors(a -> a.param(ChatMemory.CONVERSATION_ID, sessionId))
                .options(OpenAiChatOptions.builder().temperature(0.2)) // builder 化且不可变
                .call()
                .content();
    }
}
```

##### LangChain4j 实现

```java
// 碳管家 AI 助手：AiServices 声明式装配，对应架构图
// Controller → AiServices(CarbonAssistant) → ChatMemory + ContentRetriever + Tools
public interface CarbonAssistant {
    @SystemMessage("你是碳管理专家，回答需引用因子库来源，不得编造数值。")
    String chat(@MemoryId String sessionId, @UserMessage("{{it}}") String question);
}

public class CarbonTools {
    @Tool("查询指定产品的碳排放因子，返回因子值与单位")
    CarbonFactor queryCarbonFactor(@P("产品名称") String product) {
        return factorService.query(product);
    }
}

@Configuration
public class CarbonAiConfig {

    @Bean
    CarbonAssistant carbonAssistant(ChatModel chatModel,          // LC4j 1.0 GA 已是 ChatModel
                                   EmbeddingStore<TextSegment> milvusStore,
                                   EmbeddingModel embeddingModel) {
        // 难点1：Rerank 作为 retriever 后处理，接在初排之后、注入之前
        ContentRetriever retriever = EmbeddingStoreContentRetriever.builder()
                .embeddingStore(milvusStore)
                .embeddingModel(embeddingModel)
                .maxResults(20)      // 粗排 20 条供后续 rerank
                .minScore(0.75)
                .build();

        // 难点2：滑动窗口记忆 + 外部 RedisChatMemoryStore 实现会话隔离与持久化
        ChatMemoryProvider memoryProvider = sessionId ->
                MessageWindowChatMemory.builder()
                        .id(sessionId)
                        .maxMessages(20)
                        .chatMemoryStore(redisChatMemoryStore)
                        .build();

        return AiServices.builder(CarbonAssistant.class)
                .chatModel(chatModel)              // 1.0 GA 用 chatModel，旧版是 chatLanguageModel
                .chatMemoryProvider(memoryProvider)
                .contentRetriever(retriever)       // contentRetriever 是单 retriever 的便捷写法；多组件编排仍用 retrievalAugmentor(DefaultRetrievalAugmentor)，它并未移除
                .tools(new CarbonTools())
                .maxSequentialToolsInvocations(3)  // 难点3：工具调用死循环兜底
                .build();
    }
}
```

#### 追问：
- 追问1：你提到用Re-ranking把检索准确率从75%提升到92%，请说明bge-reranker-large是在DefaultRetrievalAugmentor的哪个环节接入的，以及它带来多少额外延迟、是否影响流式首字时间？
  - **答**：bge-reranker-large 接在 `ContentRetriever` 返回初排结果之后、`ContentInjector` 之前，作为 retriever 后处理。额外延迟为一次 rerank 推理（几十~百毫秒级），发生在首字生成之前，故略微增加 TTFT 但不影响后续 token 流速；可仅对前 20 条 rerank 控制开销。
- 追问2：你限制工具调用最大次数为3来防止死循环，但如果真实业务确实需要超过3次串联调用（如"查因子→算碳足迹→比对法规→生成报告"），你的设计该如何既防死循环又支持长链路？
  - **答**：把"防无限循环"与"业务长链路"解耦：步数上限按单轮 Agent 上限（如 10）而非 3；死循环防护改为"去重检测"——同一 Tool+相同参数重复调用即终止；长链路用预定义的固定 Pipeline（显式步骤编排）而非靠模型自由循环，并用有向步骤图约束合法调用顺序。
- 追问3：历史对话摘要压缩只保留最近3轮+摘要，如果用户在第10轮追问"第2轮那个0.85的因子"，你的记忆策略会丢失关键信息吗，如何权衡？
  - **答**：会丢失。权衡：
    - ① 摘要压缩时保留关键数值实体（因子值、来源）而非整轮丢弃
    - ② 长期记忆落 MySQL，关键因子可跨轮按来源召回（"上次那个0.85"走长期记忆）
    - ③ 对显式引用历史数值的请求，优先从持久化因子库查，而非依赖对话窗口

### 5. 如何处理生产环境中LangChain4j应用的模型性能退化问题？
**重要度**：★★★

1. **版本固定**：锁定模型版本，不自动升级。
2. **质量监控**：每日自动运行测试集，对比历史准确率，退化 > 5% 告警。
3. **A/B 测试**：新模型版本先接 5% 流量，对比效果。
4. **Prompt 版本管理**：Prompt 模板 Git 管理，支持回滚。
5. **日志记录**：完整记录每次请求的 Prompt、检索结果、模型输出，便于事后分析。

#### 追问：
- 追问1：你提到"退化>5%告警"，这5%的基线和测试集是如何定义的，碳管家针对"排放因子数值准确性"这类硬性指标如何设计可量化的回归测试而非只测语义相似度？
  - **答**：基线=上线首日测试集得分快照，测试集由标注过的标准问答对（含已知正确因子值）构成。数值类用精确/容差比对：输出与标准答案差值<阈值（如 1%）判对，而非语义相似度；并统计"数值错误率""来源引用准确率"等硬指标纳入每日回归。
- 追问2：A/B测试先接5%流量时，如果新模型版本在碳核算上给出不同数值结论，你如何保证同一用户的多轮对话不被路由到不同模型导致前后矛盾？
  - **答**：用 sessionId 做一致性哈希/黏性路由——同一 session 整个生命周期固定路由到同一模型版本，A/B 仅在新建 session 时按比例分配实验组，避免把同一用户的不同轮次打到不同模型。
- 追问3：模型版本锁定后，如果供应商悄无声息地变更了后端（如通义千问热更新），你的版本固定策略还成立吗，如何侦测这种"隐形退化"？
  - **答**：不成立，固定的是"调用接口版本号"而非后端实现。侦测：
    - ① 每日回归对比输出分布（数值/格式漂移）
    - ② 监控线上数值错误率、拒答率、token 异常
    - ③ 对关键问题做定时探针采样比对，发现分布偏移即告警并考虑回滚/降级

### 6. 如何用LangChain4j分析公司财报？关键信息提取的难点是什么？
**重要度**：★★★

**难点**：

- 财报表格数据难以纯文本提取（PDF 表格解析）。
- 财务术语多义性（如"营业收入"在不同公司定义可能不同）。
- 大量数字精度要求高（大模型容易"四舍五入"或幻觉）。

**方案**：

- 表格数据用 Apache POI 精确提取，不走 RAG。
- 非结构化描述（管理层讨论、风险提示）走 RAG 问答。
- 结构化输出提取关键指标，Prompt 约束"严格基于原文数据"。


#### 三种框架实现对比

##### Spring AI 1.0 实现

```java
// 财报分析：表格走 POI 精确提取（不走 RAG），叙述性文本走 RAG，指标走结构化输出
@Service
public class FinancialReportAnalyzer {

    private final ChatClient chatClient;
    private final VectorStore reportVectorStore;

    public FinancialReportAnalyzer(ChatModel chatModel, VectorStore reportVectorStore) {
        this.reportVectorStore = reportVectorStore;
        this.chatClient = ChatClient.builder(chatModel)
                .defaultAdvisors(new QuestionAnswerAdvisor(reportVectorStore))
                .build();
    }

    // 关键指标抽取：POJO 目标类型 → Schema 约束 → 缺失字段返回 null 不编造
    public FinancialMetrics extract(String narrativeText, BigDecimal revenueFromPoi) {
        return chatClient.prompt()
                .system("严格基于原文数据抽取，禁止四舍五入，无依据的字段必须返回 null。")
                .user(u -> u.text("叙述段落：{narrative}\n表格精确值：{revenue}")
                        .param("narrative", narrativeText)
                        .param("revenue", revenueFromPoi))
                .call()
                .entity(FinancialMetrics.class);
    }
}

// 结构化输出目标：字段可为 null 表示"无依据"，下游渲染为"数据缺失，请补充"而不是填默认值
public record FinancialMetrics(
        @JsonProperty("operating_revenue") BigDecimal operatingRevenue,
        @JsonProperty("net_profit") BigDecimal netProfit,
        @JsonProperty("pe_ratio") Double peRatio) {
}
```

##### Spring AI 2.0 实现

```java
// 2.0 差异：entity(Class, Consumer<EntityParamSpec>) 可传入自定义 Schema；
//           StructuredOutputValidationAdvisor 做自纠正重试，防止字段缺失/类型错误
@Service
public class FinancialReportAnalyzer {

    private final ChatClient chatClient;

    public FinancialReportAnalyzer(ChatModel chatModel, VectorStore reportVectorStore) {
        // 2.0：StructuredOutputValidationAdvisor 会校验 JSON Schema，
        //       不合规时自动带着错误信息重试若干次（maxRepeatAttempts）
        this.chatClient = ChatClient.builder(chatModel)
                .defaultAdvisors(
                        QuestionAnswerAdvisor.builder(reportVectorStore).build(),
                        StructuredOutputValidationAdvisor.builder()
                                .outputType(FinancialMetrics.class)
                                .maxRepeatAttempts(2)
                                .build())
                .build();
    }

    public FinancialMetrics extract(String narrativeText, BigDecimal revenueFromPoi) {
        return chatClient.prompt()
                .system("严格基于原文数据抽取，禁止四舍五入，无依据的字段必须返回 null。")
                .user(u -> u.text("叙述段落：{narrative}\n表格精确值：{revenue}")
                        .param("narrative", narrativeText)
                        .param("revenue", revenueFromPoi))
                .options(OpenAiChatOptions.builder().temperature(0.0)) // 抽取任务用 0 温度
                .call()
                .entity(FinancialMetrics.class);
    }
}
```

##### LangChain4j 实现

```java
// LangChain4j：AiServices 方法直接返回 POJO，框架自动做 JSON Schema 约束 + 反序列化
public interface FinancialReportExtractor {
    // {{text}} 模板变量由 @V 绑定；system 约束"禁止四舍五入、无依据置 null"
    @SystemMessage("严格基于原文数据抽取，禁止四舍五入，无依据的字段必须返回 null。")
    @UserMessage("叙述段落：{{text}}\n表格精确值：{{revenue}}")
    FinancialMetrics extract(@V("text") String narrativeText,
                             @V("revenue") BigDecimal revenueFromPoi);
}

// POJO：缺失字段为 null，下游渲染为"数据缺失，请补充"而不是填 0
public class FinancialMetrics {
    @JsonProperty("operating_revenue") private BigDecimal operatingRevenue;
    @JsonProperty("net_profit") private BigDecimal netProfit;
    @JsonProperty("pe_ratio") private Double peRatio;
    // getter / setter 省略
}

// 组装：表格由 Apache POI 精确提取后作为上下文注入，非结构化段落才走 RAG
public class FinancialReportService {

    private final FinancialReportExtractor extractor;
    private final FinancialTableParser poiParser;   // Apache POI 精确抽表

    public FinancialReportService(FinancialReportExtractor extractor,
                                  FinancialTableParser poiParser) {
        this.extractor = extractor;
        this.poiParser = poiParser;
    }

    public FinancialMetrics analyze(String pdfPath) {
        // 表格数据走 POI，不进 RAG——保证数值零误差
        BigDecimal revenue = poiParser.parseRevenue(pdfPath);
        // 叙述段落（管理层讨论、风险提示）走 RAG 后的语义抽取
        String narrative = poiParser.parseNarrative(pdfPath);
        return extractor.extract(narrative, revenue);
    }
}
```

#### 追问：
- 追问1：碳管家也会处理企业碳排放报告中的表格数据，Apache POI精确提取与RAG问答两套路径并存时，你如何判断一张"含数值的段落"该走哪条路、边界在哪里？
  - **答**：按数据形态判定：结构化数值表格（因子表、活动数据表）→ POI 精确提取走计算路径；非结构化叙述（核算说明、合规结论）→ RAG 问答。边界：单元格可程序化解析的走 POI；夹杂自由文本、需语义理解的段落走 RAG；混合段落先抽结构化数值，再对剩余文本 RAG。
- 追问2：当大模型对碳核算数字"四舍五入"或幻觉时，你的结构化输出约束具体通过什么机制强制其保留原文精度，失败如何重试？
  - **答**：通过 JSON Schema + 约束解码强制字段类型与小数位；Prompt 明确"必须原样引用原文数值，禁止四舍五入"并把原文数值作为上下文注入核对；失败时先用 OutputConverter 重试修正，仍失败则回退到带原文引用的文本并标"需人工核对"，不直接放行。

### 7. 如何用LangChain4j实现金融研报的自动生成？
**重要度**：★★

（非碳管家项目，但思路类似碳足迹报告生成）

- 数据源：结构化财务数据（API）+ 非结构化分析报告（RAG）。
- Prompt 模板：预定义研报结构（摘要、行业分析、财务分析、投资建议）。
- 多段生成：逐段生成（避免单次生成过长导致质量下降），最后拼接。
- 结构化输出：关键数据（如 PE、PB、营收增长率）用 JSON Mode 精确提取。


#### 三种框架实现对比

##### Spring AI 1.0 实现

```java
// 研报生成：逐段生成再拼接 + 关键指标 JSON 精确提取 + 口径一致性校验
@Service
public class ResearchReportGenerator {

    private static final List<Section> SECTIONS = List.of(
            new Section("摘要", "SUMMARY_PROMPT"),
            new Section("行业分析", "INDUSTRY_PROMPT"),
            new Section("财务分析", "FINANCE_PROMPT"),
            new Section("投资建议", "ADVICE_PROMPT"));

    private final ChatClient chatClient;
    private final ChatClient metricsClient;

    public ResearchReportGenerator(ChatModel chatModel) {
        this.chatClient = ChatClient.create(chatModel);
        this.metricsClient = ChatClient.create(chatModel);
    }

    public ResearchReport generate(String companyName, String ragContext) {
        // 逐段生成：单次生成过长会导致质量下降，故每段独立一次调用
        StringBuilder sb = new StringBuilder();
        for (Section section : SECTIONS) {
            sb.append("## ").append(section.title()).append('\n')
              .append(chatClient.prompt()
                      .system(section.promptKey() + "\n必须标注所用核算口径与标准版本。")
                      .user(u -> u.text("公司：{company}\n资料：{ctx}")
                              .param("company", companyName)
                              .param("ctx", ragContext))
                      .call()
                      .content())
              .append('\n');
        }
        // 关键指标（PE/PB/营收增长率）用结构化输出精确抽取
        KeyMetrics metrics = metricsClient.prompt()
                .user(u -> u.text("从研报正文抽取指标：{body}")
                        .param("body", sb.toString()))
                .call()
                .entity(KeyMetrics.class);
        // 口径一致性校验：全文必须统一 ISO 14067 / GHG Protocol 之一
        String report = sb.toString();
        if (!report.contains("ISO 14067") && !report.contains("GHG Protocol")) {
            throw new IllegalStateException("研报缺少统一核算口径声明，需重新生成");
        }
        return new ResearchReport(report, metrics);
    }
}
```

##### Spring AI 2.0 实现

```java
// 2.0 差异：options 传 builder；结构化输出加 StructuredOutputValidationAdvisor 自纠正
@Service
public class ResearchReportGenerator {

    private final ChatClient chatClient;
    private final ChatClient metricsClient;

    public ResearchReportGenerator(ChatModel chatModel) {
        // 2.0：指标抽取链路加 Schema 自纠正，防止 PE/PB 字段缺失或类型错乱
        this.metricsClient = ChatClient.builder(chatModel)
                .defaultAdvisors(StructuredOutputValidationAdvisor.builder()
                        .outputType(KeyMetrics.class)
                        .maxRepeatAttempts(2)
                        .build())
                .build();
        this.chatClient = ChatClient.create(chatModel);
    }

    public ResearchReport generate(String companyName, String ragContext) {
        StringBuilder sb = new StringBuilder();
        for (Section section : SECTIONS) {
            // 2.0：temperature / maxTokens 用 builder 传入，不可变
            String body = chatClient.prompt()
                    .system(section.promptKey() + "\n必须标注所用核算口径与标准版本。")
                    .user(u -> u.text("公司：{company}\n资料：{ctx}")
                            .param("company", companyName)
                            .param("ctx", ragContext))
                    .options(OpenAiChatOptions.builder()
                            .temperature(0.4)
                            .maxTokens(1200))     // 限制单段长度，避免长文质量下降
                    .call()
                    .content();
            sb.append("## ").append(section.title()).append('\n').append(body).append('\n');
        }
        KeyMetrics metrics = metricsClient.prompt()
                .user(u -> u.text("从研报正文抽取指标：{body}").param("body", sb.toString()))
                .options(OpenAiChatOptions.builder().temperature(0.0))
                .call()
                .entity(KeyMetrics.class);
        return new ResearchReport(validateConsistency(sb.toString()), metrics);
    }
}
```

##### LangChain4j 实现

```java
// LangChain4j：逐段生成（每段一次 AiServices 调用）+ 结构化输出 + 口径校验
public interface SectionGenerator {
    @SystemMessage("""
            你是研报撰写专家。严格基于给定资料撰写{{section}}章节，
            并在段首标注所用核算口径与标准版本（如 ISO 14067 / GHG Protocol）。
            """)
    @UserMessage("公司：{{company}}\n资料：{{context}}")
    String write(@V("section") String section,
                 @V("company") String company,
                 @V("context") String ragContext);
}

public interface KeyMetricsExtractor {
    @SystemMessage("从研报正文抽取关键指标，无法得出的指标必须返回 null，严禁编造。")
    @UserMessage("研报正文：{{body}}")
    KeyMetrics extract(@V("body") String body);
}

public class ResearchReportService {

    private final SectionGenerator sectionGenerator;
    private final KeyMetricsExtractor metricsExtractor;

    public ResearchReportService(ChatModel chatModel) {
        this.sectionGenerator = AiServices.builder(SectionGenerator.class)
                .chatModel(chatModel)
                .build();
        this.metricsExtractor = AiServices.builder(KeyMetricsExtractor.class)
                .chatModel(chatModel)
                .build();
    }

    public ResearchReport generate(String companyName, String ragContext) {
        // 逐段生成：每段独立调用，避免单次上下文过长导致质量下降
        StringBuilder sb = new StringBuilder();
        for (String section : List.of("摘要", "行业分析", "财务分析", "投资建议")) {
            sb.append("## ").append(section).append('\n')
              .append(sectionGenerator.write(section, companyName, ragContext))
              .append('\n');
        }
        String body = sb.toString();
        // 拼接后扫描全文做口径一致性校验，冲突则重新生成
        if (!body.contains("ISO 14067") && !body.contains("GHG Protocol")) {
            throw new IllegalStateException("研报缺少统一核算口径声明，需重新生成");
        }
        return new ResearchReport(body, metricsExtractor.extract(body));
    }
}
```

#### 追问：
- 追问1：碳足迹报告生成同样采用逐段生成再拼接，如果前后两段引用的排放因子口径不一致（如一段用ISO 14067、一段用GHG Protocol），你的拼接流程如何做一致性校验？
  - **答**：拼接前做口径一致性校验：
    - ① 每段生成时强制标注所用标准（ISO 14067 / GHG Protocol）与版本
    - ② 拼接后用独立的校验服务扫描全文，发现同一指标两种口径即触发告警/重新生成冲突段（LangChain4j 没有 validationChain，属业务侧后处理）
    - ③ 报告头统一声明主口径，段落内引用须与头一致
- 追问2：用JSON Mode精确提取PE/PB等指标的思路应用到碳管家时，若某个指标模型确实无法从原文得出，你要求它返回null还是编造，如何定义Schema约束？
  - **答**：要求返回 null 并显式标"未知"，绝不编造。Schema 用 `@Nullable`/Optional 字段 + `enum` 限定取值范围，Prompt 约束"无依据字段必须置 null"；下游对 null 渲染为"数据缺失，请补充"而非填默认值，避免误导碳核算结论。

### 8. LangChain4j的AiServices是什么？如何使用？
**重要度**：★★★★★

`AiServices` 是 LangChain4j 的声明式 API，通过接口+注解定义 AI 服务：

```java
interface CarbonAssistant {
    @SystemMessage("你是碳管理专家，回答需引用来源")
    String chat(@MemoryId String sessionId, @UserMessage String question);
}

CarbonAssistant assistant = AiServices.builder(CarbonAssistant.class)
    .chatModel(model)                                  // 1.x 叫 chatModel，0.x 时代叫 chatLanguageModel
    .chatMemoryProvider(sessionId -> redisMemory)
    .contentRetriever(milvusRetriever)
    .tools(carbonFactorTool, regulationTool)
    .build();

String answer = assistant.chat("session-001", "什么是CBAM？");
```

#### 追问：
- 追问1：CarbonAssistant接口用@MemoryId做会话隔离，如果同一个sessionId在Redis中因过期被清除，AiServices在build或调用时分别会暴露什么行为，你如何兜底？
  - **答**：build 阶段不依赖具体 session 数据，不会报错；调用时若 Redis 中该 session 已过期，ChatMemory 返回空历史，等价于"新会话"，不抛异常。兜底：
    - ① 设合理 TTL + 访问续期
    - ② 长期记忆落 MySQL，过期后从持久层恢复
    - ③ 调用前检测空记忆可注入欢迎/上下文提示
- 追问2：你通过.builder()把MilvusRetriever和Tools都注入到同一个AiServices，当一次提问既触发RAG检索又触发Tool调用时，两者的结果在Prompt中如何合并、优先级如何？
  - **答**：框架先执行 RAG 检索把 chunk 注入 Prompt 上下文，再在同一轮根据上下文决定是否调用 Tool，Tool 结果以独立消息/系统提示形式追加；二者都在同一 Prompt 内供模型综合。优先级：通常以 Tool 实时结果为准（更权威），RAG 作背景，可用 Prompt 约束"以工具返回的最新因子为准"。

### 9. LangChain4j中的Document和DocumentLoader如何使用？LangChain4j的RAG组件有哪些？
**重要度**：★★★★

**Document / DocumentLoader**：

```java
Document doc = FileSystemDocumentLoader.loadDocument(Path.of("iso14067.pdf"));
List<Document> docs = FileSystemDocumentLoader.loadDocuments(Path.of("knowledge/"), "*.pdf");  // 第二参是 glob
```

**RAG 组件**：

- `DocumentLoader`：文档加载。
- `DocumentSplitter`：文本分块。
- `EmbeddingStore`：向量存储。
- `EmbeddingModel`：向量化。
- `ContentRetriever` / `EmbeddingStoreContentRetriever`：检索。
- `RetrievalAugmentor` / `DefaultRetrievalAugmentor`：RAG 编排。
- `QueryTransformer`：查询改写。
- `ContentInjector`：内容注入。

#### 追问：
- 追问1：碳管家的ISO标准PDF用FileSystemDocumentLoader加载后，你如何把"条款编号"作为metadata保留下来，以支持后续按标准号过滤检索？
  - **答**：加载/分块时把条款编号写入 `Document.metadata`（如 `{section:"6.1", standard:"ISO 14064-1"}`），分块时 metadata 随 `TextSegment` 继承；Milvus 将 standard/section 建为标量字段，检索时用 `Filter` 表达式按标准号过滤（Self-Query），实现"只在该标准内检索"。
- 追问2：LangChain4j的RAG组件链中，EmbeddingModel与ContentRetriever分别承担什么职责，如果二者使用的向量维度或模型不一致会在哪个环节暴露问题？
  - **答**：EmbeddingModel 负责文本向量化（写入与查询两侧须一致）；ContentRetriever 负责按向量+索引查询。不一致在"写入与查询维度不同"时暴露——add 阶段 Milvus 维度校验或查询时余弦距离无意义/报错；应在启动时校验 embedding 维度与 Collection schema 一致，统一使用同一 EmbeddingModel 实例。

### 10. LangChain4j如何实现对话记忆（Memory）？
**重要度**：★★★★

```java
// 方式一：全局 Memory
ChatMemory memory = MessageWindowChatMemory.withMaxMessages(20);

// 方式二：按会话隔离（推荐）
ChatMemoryProvider provider = sessionId -> 
    MessageWindowChatMemory.builder()
        .id(sessionId)
        .maxMessages(20)
        .build();

CarbonAssistant assistant = AiServices.builder(CarbonAssistant.class)
    .chatMemoryProvider(provider)
    .build();
```

**策略**：

- `MessageWindowChatMemory`：保留最近 N 条消息（滑动窗口）。
- `TokenWindowChatMemory`：按 token 数限制（更精确）。
- 自定义：超出限制时自动摘要压缩。


#### 三种框架实现对比

##### Spring AI 1.0 实现

```java
// 记忆：MessageWindowChatMemory（按条数滑窗）+ ChatMemoryRepository（换存储）
// 窗口存储换实现即可从内存切到 Redis/JDBC，业务代码零改动
@Configuration
public class ChatMemoryConfig {

    @Bean
    ChatMemoryRepository chatMemoryRepository() {
        // 生产用 JdbcChatMemoryRepository 落库；此处用内存实现演示
        return new InMemoryChatMemoryRepository();
    }

    @Bean
    ChatMemory chatMemory(ChatMemoryRepository repository) {
        // 滑动窗口保留最近 20 条消息，超出自动淘汰最旧的
        return MessageWindowChatMemory.builder()
                .chatMemoryRepository(repository)
                .maxMessages(20)
                .build();
    }
}

@Service
public class CarbonChatService {

    private final ChatClient chatClient;
    private final ChatMemory chatMemory;

    public CarbonChatService(ChatModel chatModel, ChatMemory chatMemory) {
        this.chatMemory = chatMemory;
        // 记忆通过 Advisor 注入到 Prompt，而不是手工拼 List<ChatMessage>
        this.chatClient = ChatClient.builder(chatModel)
                .defaultAdvisors(MessageChatMemoryAdvisor.builder(chatMemory).build())
                .build();
    }

    public String chat(String sessionId, String question) {
        return chatClient.prompt()
                .user(question)
                // 1.0：conversationId 可在 Advisor 构造时固定，也可按请求覆盖
                .advisors(a -> a.param(ChatMemory.CONVERSATION_ID, sessionId))
                .call()
                .content();
    }
}
```

##### Spring AI 2.0 实现

```java
// 2.0 差异：conversationId 必须在每次请求上显式传，不能在 Advisor 构造时固定
@Configuration
public class ChatMemoryConfig {

    @Bean
    ChatMemoryRepository chatMemoryRepository() {
        return new InMemoryChatMemoryRepository();
    }

    @Bean
    ChatMemory chatMemory(ChatMemoryRepository repository) {
        return MessageWindowChatMemory.builder()
                .chatMemoryRepository(repository)
                .maxMessages(20)
                .build();
    }
}

@Service
public class CarbonChatService {

    private final ChatClient chatClient;

    public CarbonChatService(ChatModel chatModel, ChatMemory chatMemory) {
        // 2.0：MessageChatMemoryAdvisor.builder(...).conversationId(...) 已移除，
        //      且 DEFAULT_CONVERSATION_ID 已删除——必须每次请求传 CONVERSATION_ID
        this.chatClient = ChatClient.builder(chatModel)
                .defaultAdvisors(MessageChatMemoryAdvisor.builder(chatMemory).build())
                .build();
    }

    public String chat(String sessionId, String question) {
        return chatClient.prompt()
                .user(question)
                .advisors(a -> a.param(ChatMemory.CONVERSATION_ID, sessionId))
                .call()
                .content();
    }

    // 2.0：Spring AI 侧没有 TokenWindowChatMemory，按 token 精确控窗需自定义 ChatMemory 实现；
    //      LangChain4j 侧对应能力见该节 LangChain4j 实现
}
```

##### LangChain4j 实现

```java
// LangChain4j：ChatMemory + ChatMemoryProvider（按会话隔离）+ ChatMemoryStore（换存储）
public interface CarbonAssistant {
    @SystemMessage("你是碳管理专家，回答需引用来源。")
    String chat(@MemoryId String sessionId, @UserMessage("{{it}}") String question);
}

@Configuration
public class ChatMemoryConfig {

    // 方式一：全局 Memory（单用户场景）
    @Bean
    ChatMemory globalMemory() {
        return MessageWindowChatMemory.withMaxMessages(20);
    }

    // 方式二：按会话隔离（推荐）——ChatMemoryProvider 依据 @MemoryId 参数取值
    @Bean
    ChatMemoryProvider chatMemoryProvider(ChatMemoryStore redisStore) {
        return sessionId -> MessageWindowChatMemory.builder()
                .id(sessionId)                  // 会话 ID，同时作为 Redis key
                .maxMessages(20)                // 滑动窗口保留最近 20 条
                .chatMemoryStore(redisStore)    // 存储可换 Redis / JDBC
                .build();
    }
}

@Configuration
public class CarbonAiConfig {

    @Bean
    CarbonAssistant carbonAssistant(ChatModel model, ChatMemoryProvider provider) {
        return AiServices.builder(CarbonAssistant.class)
                .chatModel(model)
                .chatMemoryProvider(provider)   // 框架自动读写记忆，多轮上下文免手工维护
                .build();
    }
}
```

#### 追问：
- 追问1：你使用MessageWindowChatMemory保留最近20条消息，在碳管家"用户逐步细化碳计算"的多轮场景中，滑窗滑出早期关键前提时如何避免回答前后矛盾？
  - **答**：用"摘要压缩"把将滑出的早期关键前提压成摘要保留在窗口内；对碳计算类关键参数（因子值、范围）额外写入长期记忆/结构化上下文；并在每次调用前把"已确认前提"作为系统提示/约束注入，降低滑窗导致的前后矛盾。
- 追问2：按会话隔离用Redis持久化，如果Redis故障或重启，碳管家的对话记忆是降级为无记忆还是从MySQL恢复，切换时机如何控制？
  - **答**：优先从 MySQL 长期记忆恢复而非直接降级为无记忆。切换时机：ChatMemory 读 Redis 失败（异常/超时）即触发 fallback 到 MySQL 加载历史摘要；若 MySQL 也不可用再降级为无记忆并给出"历史暂不可用"提示，避免对话直接断裂。

### 11. LangChain4j的Tool（工具调用）如何定义和使用？
**重要度**：★★★★★

**设计思路（口头表述）**：LangChain4j 的工具调用是**声明式**的——我用 `@Tool` 注解描述方法能力（描述要写清"做什么、输入、返回"），用 `@P` 注解标注参数含义，模型靠这些描述自动判断要不要调、调哪个、传什么参数。使用时通过 `AiServices.builder` 把工具类注入，构建出的 Assistant 接口像普通 Java 接口，但调用时框架把方法签名转成 function schema 发给模型，模型决策后框架再反射调回我的方法。和 Spring AI 的 `@Tool` 思路一致，区别在 LangChain4j 用 `AiServices` 声明式接口、Spring AI 用 `ChatClient` 流式 API。

```java
class CarbonTools {
    @Tool("查询指定产品的碳排放因子，返回因子值和单位")
    CarbonFactor queryCarbonFactor(@P("产品名称") String product) {
        return factorService.query(product);
    }
    
    @Tool("获取最新CBAM法规内容")
    String getCbamRegulation() {
        return regulationService.getLatest("CBAM");
    }
}

CarbonAssistant assistant = AiServices.builder(CarbonAssistant.class)
    .chatModel(model)
    .tools(new CarbonTools())
    .build();
```

大模型根据 `@Tool` 的描述自动判断是否调用工具。

#### 追问：
- 追问1：你用@Tool注解描述"查询碳排放因子"，当模型判断不需要调用工具却确实需要（漏调用）时，碳管家如何在不破坏声明式风格的前提下做强制校验或兜底？
  - **答**：不破坏声明式前提下：
    - ① 在 SystemMessage 强化触发条件与示例
    - ② 检索后加独立校验，检查答案是否含所需因子，缺失则二次追问模型"是否应调用工具"（LC4j 没有 validationChain，校验放在 AiServices 返回之后做）
    - ③ 对强依赖场景用后处理拦截，发现未调用且答案缺关键数据时进行意图重判或兜底提示
- 追问2：queryCarbonFactor返回的领域对象CarbonFactor若服务层抛异常，LangChain4j的Tool调用默认会如何传播，你如何把异常转成用户可读的降级回答？
  - **答**：默认是**抛**，不是回传给模型：`@Tool` 方法抛出的异常会被框架包成 `ToolExecutionException` 抛出，整轮调用中断。处理：
    - ① 在 `@Tool` 方法内 try-catch，返回降级对象（带 errorMessage 的 CarbonFactor 或自然语言说明）——生产首选
    - ② 如果希望模型自己看到错误并纠正，可配置 `ToolExecutionErrorHandler`，在里面返回一条 `ToolExecutionResultMessage` 而不是抛异常；但要防模型反复重试烧 token
    - ③ 整轮兜底在 AiServices 外层 try-catch（LangChain4j 没有 `@Fallback` 注解），捕获 `LangChain4jException` 后返回业务侧降级话术；主备切换由自定义 ChatModel 装饰器做，或实现 `ChatModelListener.onError` 做监控告警
    - ④ 把异常转为"因子查询暂不可用，已转人工/给估算区间"的用户可读回答，而非堆栈

### 12. LangChain4j和Spring AI如何选型？
**重要度**：★★★★

| 场景             | 推荐          | 原因                                            |
| -------------- | ----------- | --------------------------------------------- |
| Spring Boot 项目 | Spring AI   | 自动装配、生态集成                                     |
| 复杂 RAG 编排      | LangChain4j | Augmentor 模式更灵活                               |
| Agent 开发       | LangChain4j | AiServices 声明式更简洁                             |
| 多模型切换          | Spring AI   | 配置驱动更方便                                       |
| 两者可以共存         | ✅           | 两者均可做 RAG/Agent；碳管家按栈分工：Spring AI Alibaba 做对话/流式，LangChain4j 做 RAG 链编排 |

**碳管家助手选择**：两者并用。

#### 追问：
- 追问1：你说复杂RAG编排选LangChain4j、多模型切换选Spring AI，在碳管家"两者并用"的架构里，一次RAG请求究竟由谁发起、检索结果如何跨越框架边界传给Spring AI的ChatModel？
  - **答**：由 LangChain4j 的 RetrievalAugmentor/ContentRetriever 发起检索并产出上下文片段，通过自定义 `Advisor`（如 `RagContextAdvisor`）把结果写入 `ChatClientRequest` 的上下文/UserMessage，再交给 Spring AI 的 `ChatModel` 生成。即"检索在 LC4j、生成在 Spring AI"，边界由 Facade 控制。
- 追问2：表格中"Agent开发选LangChain4j因为AiServices声明式更简洁"，但如果团队更熟悉Spring的FunctionCallback风格，这个选型依据的权衡点还有什么？
  - **答**：权衡点：
    - ① 团队熟练度与维护成本（熟悉 ToolCallback 则 Spring AI 上手快）
    - ② 生态与可观测性（Spring AI 自动接 Micrometer）
    - ③ 复杂 Agent 多步编排 LC4j 更顺手
    - 若团队更熟 Spring，可统一用 Spring AI ToolCallback + Advisor，牺牲少量声明式简洁换可维护性。
- 追问3：两个框架并存时，EmbeddingModel和ChatMemory这类基础设施若各自配置一套，会出现什么一致性问题，你如何统一？
  - **答**：各自一套会导致 embedding 维度/模型不同使向量不互通、记忆格式不同使上下文错乱。统一：
    - ① EmbeddingModel 仅配一个 `@Primary` Bean，两框架注入同一实例
    - ② ChatMemory 底层存储共用 Redis/MySQL 并做适配器对齐格式
    - ③ 配置中心集中管理模型与存储参数

### 13. LangChain4j的流式响应如何实现？

```java
interface CarbonAssistant {
    TokenStream chat(@UserMessage String query);
}

CarbonAssistant assistant = AiServices.builder(CarbonAssistant.class)
    .streamingChatModel(streamingModel)      // 1.x 叫 streamingChatModel，0.x 时代叫 streamingChatLanguageModel
    .build();

assistant.chat("什么是碳足迹？")
    .onPartialResponse(token -> System.out.print(token))  // 逐片段回调
    .onCompleteResponse(response -> System.out.println("\n完成"))
    .onError(error -> error.printStackTrace())
    .start();
```

#### 追问：
- 追问1：碳管家在流式输出"碳足迹计算过程"时，如果中途某次Tool调用（如查因子）失败，已推送给前端的token如何处理、能否回滚或更正？
  - **答**：已推送 token 无法物理撤回（HTTP 流已发出）。策略：
    - ① Tool 调用尽量在生成开始前完成（先规划再流式），避免中途失败
    - ② 若中途失败，发送"更正/补充"消息块说明并以正确结果接续
    - ③ 前端按消息块渲染，对未完成内容做占位/可替换，UI 层支持"最后一块为准"
- 追问2：TokenStream的onPartialResponse逐片段回调与内容审核（Moderation）如何协调——你是先全量生成再审核，还是边流边审，二者在架构上如何取舍？
  - **答**：架构取舍：
    - ① 边流边审（流式 Moderation）延迟低体验好，但需对逐块做轻量校验，发现违规立即中断并清空前端
    - ② 先全量再审更安全但首字延迟高
    - 碳管家因含数值严谨性，采用"流式展示 + 生成后整体 Moderation 复核"，违规则追加更正块并告警。

### 14. LangChain4j如何支持多模型切换？

```java
// 注意：这两个实现都来自社区模块，不在核心 langchain4j 包里，需单独引依赖
// QwenChatModel  → langchain4j-community-dashscope
// QianfanChatModel（百度文心）→ langchain4j-community-qianfan
ChatModel qwenModel = QwenChatModel.builder()...build();
ChatModel ernieModel = QianfanChatModel.builder()...build();

// 路由
ChatModel activeModel = needComplex ? qwenModel : ernieModel;

CarbonAssistant assistant = AiServices.builder(CarbonAssistant.class)
    .chatModel(activeModel)
    .build();
```

#### 追问：
- 追问1：你用needComplex布尔变量在Qwen和Ernie间路由，碳管家中"复杂"应如何量化定义，基于规则还是基于query分类模型，误判后果是什么？
  - **答**："复杂"可量化：query 长度、是否含多实体/计算/法规引用、是否需 RAG/Tool。先用规则（关键词/意图分类）低成本路由，再迭代为轻量分类模型。误判后果：复杂误走简单模型→答不准/漏步骤；简单误走复杂模型→成本高延迟大。可用 A/B 与监控纠偏。
- 追问2：切换模型后，两个模型对同一个碳核算问题的输出格式可能不同，你如何保证AiServices声明的返回类型（如CarbonFactorResult）在两边都能稳定反序列化？
  - **答**：用 StructuredOutput（JSON Schema）约束两模型输出同一 Schema；不支持原生结构化的模型用 OutputConverter/约束解码包裹。CarbonFactorResult 等 POJO 用 Jackson + 容错（忽略未知字段、必填缺失则 null）反序列化；对格式不稳的模型加后处理归一化层，保证返回类型一致。

### 15. LangChain4j的PromptTemplate如何使用？

```java
PromptTemplate template = PromptTemplate.from(
    "作为{{role}}，请回答：{{question}}。参考标准：{{standard}}");

Prompt prompt = template.apply(Map.of(
    "role", "碳管理专家",
    "question", "什么是碳足迹？",
    "standard", "ISO 14067"
));
```

#### 追问：
- 追问1：你用{{standard}}占位符注入"ISO 14067"，如果模板中的标准号与检索到的chunk实际来源标准不一致，碳管家如何防止模型被错误上下文带偏？
  - **答**：以检索 chunk 的实际来源 metadata 为准：生成时把注入片段的 `source.standard` 与模板 `{{standard}}` 比对，不一致则优先采用检索来源标注并在 Prompt 显式注明"参考来源为 X 标准"；必要时去掉硬编码 `{{standard}}`，改为由检索结果动态填充标准号，避免人为注入与事实冲突。
- 追问2：PromptTemplate的变量若来自用户输入（如question），你如何防范用户通过注入恶意指令绕过@SystemMessage的"引用来源"约束？
  - **答**：
    - ① 对 `{{question}}` 做输入清洗/转义，剥离疑似指令（如"忽略上述"）
    - ② 把用户内容放在独立 User Message 而非 System Message，降低优先级
    - ③ 用结构化分隔符隔离系统指令与用户输入（明确边界）
    - ④ 加 Moderation 对用户输入做安全审核，可疑指令拦截

### 16. LangChain4j的Agent模块如何工作？
**重要度**：★★★★

LangChain4j 的 Agent 基于 `AiServices` + Tools 实现 ReAct 模式：

1. 接收用户请求。
2. 大模型判断是否需要调用 Tool。
3. 调用 Tool → 获取结果 → 结果返回大模型。
4. 大模型基于结果继续判断或生成回答。
5. 循环直到大模型认为不需要再调用 Tool。

#### 追问：
- 追问1：碳管家的Agent基于ReAct循环，当Tool返回"查无此因子"时，模型可能编造一个因子继续推理，你如何在Agent循环层面约束它必须承认未知？
  - **答**：在 Tool 返回"查无"时把该结果作为明确信号注入上下文，并在 SystemMessage 约束"未知必须如实告知，禁止编造因子"；Agent 循环中加入校验：若关键因子缺失则终止并输出"数据不足，建议补充/转人工"，而非用占位值继续推理；可加独立校验后处理器对最终答案的因子做存在性校验。
- 追问2：ReAct循环直到"模型认为不需要再调用Tool"才停止，这个停止判断若出错导致过早终止，你如何设计校验或最大步数兜底？
  - **答**：设"最大步数"硬上限（如 10 步）防止无限；终止前加校验检查是否仍有关键子任务未完成/必要 Tool 未调用，未完成则继续；同时让模型终止时输出"已完成/需补充"理由，由独立校验后处理器复核，异常则重入循环或转人工。

### 17. LangChain4j的Splitter（文本分割器）有哪些策略？
**重要度**：★★★★

- `DocumentByParagraphSplitter`：按段落分割。
- `DocumentByLineSplitter`：按行分割。
- `DocumentByCharacterSplitter`：按字符数分割。
- `DocumentSplitters.recursive(500, 50)`：递归分割，尝试按段落→句→字符逐级切分。⚠️ **两参重载的单位是「字符」不是 token**（maxSegmentSizeInChars / maxOverlapSizeInChars）；要按 token 切分用三参重载 `recursive(maxTokens, overlap, new TokenTextSplitter.TokenCountEstimator())`。

#### 追问：
- 追问1：碳管家的ISO标准文档用递归分块(500,50)，若一个条款恰好被切在500边界上导致"前半句在chunk A、后半句在chunk B"，检索时如何保证语义完整？
  - **答**：
    - ① 提高 overlap（如 50→100）让跨边界句在相邻 chunk 都重叠，检索命中任一侧即可召回完整句
    - ② recursive 已优先按句级切分避免硬切半句
    - ③ 检索后用 rerank 合并同一条款的多个片段
    - ④ 把条款编号写入 metadata，命中后按 section 聚合相邻 chunk 还原语义
- 追问2：排放因子Excel用Tika解析后，表格单元格是否被当作独立segment，重叠(overlap)参数对数值型表格检索的精度提升是否反而引入噪声？
  - **答**：数值表格不应把单元格当独立语义 segment 做向量检索——更适合作结构化存储（POI/MySQL）按"行=记录"检索。若确需向量化，应按"整行/整表区域"为 segment 而非单单元格；overlap 对纯数值无语义增益反而稀释相似度，建议 overlap=0 并对表加表头上下文。

### 18. LangChain4j如何与Spring Boot集成？
**重要度**：★★★

```xml
<dependency>
    <groupId>dev.langchain4j</groupId>
    <artifactId>langchain4j</artifactId>
</dependency>
<dependency>
    <groupId>dev.langchain4j</groupId>
    <artifactId>langchain4j-milvus</artifactId>
</dependency>
```

通过 `@Bean` 配置 LangChain4j 组件，注入 Spring 容器。也可使用 `langchain4j-spring-boot-starter` 实现自动装配。


#### 三种框架实现对比

##### Spring AI 1.0 实现

```java
// Spring Boot 集成：starter 自动装配 ChatModel，其余组件手动 @Bean 装配进容器
// pom: spring-ai-starter-model-openai + spring-ai-starter-vector-store-milvus
@Configuration
public class AiBeansConfig {

    // 1.0 走 starter 自动装配的 ChatModel，只补装 VectorStore / Memory
    @Bean
    ChatMemoryRepository chatMemoryRepository() {
        return new InMemoryChatMemoryRepository();
    }

    @Bean
    ChatMemory chatMemory(ChatMemoryRepository repository) {
        return MessageWindowChatMemory.builder()
                .chatMemoryRepository(repository)
                .maxMessages(20)
                .build();
    }

    // 需要精细控制时（如指定 base-url 走通义千问兼容端点）可自己建 Model
    @Bean
    @Primary
    ChatModel dashScopeChatModel() {
        OpenAiApi api = OpenAiApi.builder()
                .baseUrl("https://dashscope.aliyuncs.com/compatible-mode")
                .apiKey(System.getenv("DASHSCOPE_API_KEY"))
                .completionsPath("/v1/chat/completions")
                .build();
        return OpenAiChatModel.builder()
                .openAiApi(api)
                .defaultOptions(OpenAiChatOptions.builder()
                        .model("qwen-plus")         // Spring AI 的 ChatOptions 用 model(...)；modelName(...) 是 LangChain4j 的写法
                        .temperature(0.2)
                        .build())
                .build();
    }
}
```

##### Spring AI 2.0 实现

```java
// 2.0 差异：OpenAiApi 已移除（改用官方 OpenAI Java SDK），
//          走 OpenAI 兼容端点（通义千问）改为配置驱动，由 starter 自动装配 ChatModel
@Configuration
public class AiBeansConfig {

    @Bean
    ChatMemoryRepository chatMemoryRepository() {
        return new InMemoryChatMemoryRepository();
    }

    @Bean
    ChatMemory chatMemory(ChatMemoryRepository repository) {
        return MessageWindowChatMemory.builder()
                .chatMemoryRepository(repository)
                .maxMessages(20)
                .build();
    }
}
```

对应配置（2.0 去掉 `.options` 段）：

```properties
# 2.0：属性扁平化，spring.ai.openai.chat.options.* 已不存在
spring.ai.openai.api-key=${DASHSCOPE_API_KEY}
spring.ai.openai.base-url=https://dashscope.aliyuncs.com/compatible-mode
spring.ai.openai.chat.model=qwen-plus
spring.ai.openai.chat.temperature=0.2
```

##### LangChain4j 实现

```java
// LangChain4j 集成：langchain4j-open-ai-spring-boot-starter 自动装配 ChatModel/EmbeddingModel，
// 复杂编排组件（AiServices / EmbeddingStore）用 @Bean 手动装配进 Spring 容器
@Configuration
public class LangChain4jBeansConfig {

    // starter 自动装配的 ChatModel 直接注入（langchain4j.open-ai.chat-model.* 驱动）
    @Bean
    CarbonAssistant carbonAssistant(ChatModel chatModel,
                                   EmbeddingStore<TextSegment> milvusStore,
                                   EmbeddingModel embeddingModel) {
        ContentRetriever retriever = EmbeddingStoreContentRetriever.builder()
                .embeddingStore(milvusStore)
                .embeddingModel(embeddingModel)
                .maxResults(5)
                .minScore(0.75)
                .build();

        return AiServices.builder(CarbonAssistant.class)
                .chatModel(chatModel)
                .contentRetriever(retriever)
                .build();
    }

    // 需要多模型时用 @Qualifier 区分不同 Bean，避免 NoUniqueBeanDefinitionException
    @Bean("qwenPlusModel")
    ChatModel qwenPlusModel() {
        return OpenAiChatModel.builder()
                .baseUrl("https://dashscope.aliyuncs.com/compatible-mode")
                .apiKey(System.getenv("DASHSCOPE_API_KEY"))
                .modelName("qwen-plus")
                .temperature(0.2)
                .build();
    }
}
```

#### 追问：
- 追问1：碳管家同时引入langchain4j和Spring AI的starter，两者的自动装配若出现同类型Bean（如ChatModel）冲突，你如何通过@Qualifier或@Primary解决启动报错？
  - **答**：对 `ChatModel`（旧名 `ChatLanguageModel`）等冲突类型，用 `@Primary` 指定主实现、或用 `@Qualifier("xxx")` 在注入点显式区分；也可 `@ConditionalOnProperty` 按配置关闭其中一个自动装配，避免两 starter 同时注册同类型 Bean 导致 `NoUniqueBeanDefinitionException`。
- 追问2：你用@Bean手动配置LangChain4j组件注入Spring容器，这些Bean与Spring AI的Advisor如何在一个请求链路中协作，顺序由谁控制？
  - **答**：在 `CarbonAiFacade`/统一入口编排顺序：先由 LangChain4j 侧做 RAG 检索与 Augment 产出上下文（`ContentRetriever`/`RetrievalAugmentor`，LangChain4j 本身没有 Chain 抽象），再交给 Spring AI `ChatClient` 的 `AdvisorChain` 做记忆/审计/后处理。顺序由 Facade 调用链（或自定义 Advisor 的 `getOrder`）控制，保证"RAG→生成→增强"的确定顺序。
- 追问3：langchain4j-spring-boot-starter配置项（如langchain4j.chat-model.api-key）在碳管家多环境（dev/test/prod）下如何做密钥管理与热更新而不重启？
  - **答**：密钥不写死在 yml，改用配置中心（Nacos/Spring Cloud Config）或 K8s Secret + 外部化配置；通过 `@RefreshScope` 或配置中心监听实现热更新（api-key 变更后 Bean 重载）；prod 密钥经 Secret 注入，dev/test 用占位，避免明文与重启。

### 19. LangChain4j的异常处理、日志监控、性能优化？
**重要度**：★★★

**异常处理**：LangChain4j 没有统一的 `ResponseException`，异常体系统一是 `dev.langchain4j.exception.LangChain4jException` 及其子类（如 `RetryableException` / `NonRetryableException` / `ModelNotFoundException`，HTTP 层还有 `HttpException`）。按子类分类处理：可重试的（限流、超时、5xx）走指数退避，用框架自带的 `RetryUtils.withRetry(...)` 或自定义 `ChatModel` 装饰器包一层；不可重试的（4xx、鉴权失败）直接失败并告警；重试耗尽后降级为兜底答案。

**日志监控**：通过 Micrometer 暴露指标，或自定义 `ChatModelListener` 记录每次调用的耗时、token、错误。

**性能优化**：

1. 批量 Embedding。
2. 向量检索限制 maxResults。
3. Memory 控制消息数量。
4. 缓存检索结果。

#### 追问：
- 追问1：你用 LangChain4jException 的子类分类+重试+降级处理异常，在碳管家调用通义千问超时但用户已在等待流式响应时，重试策略如何避免首字延迟过长？
  - **答**：流式场景用"快速失败+有限重试"：首次调用设较短超时（如 3s），超时立即切换备用模型/降级答案并尽快首字；重试在首字前完成不阻塞已开始的流；若已流式则发"更正/降级说明"块。降级路径（缓存答案/模板）保证用户尽快看到内容。
- 追问2：ChatModelListener记录耗时/token/错误，这些指标如何与Spring AI侧Micrometer指标统一到一个看板，碳管家按什么维度（session/接口/模型）聚合？
  - **答**：统一用 Micrometer 作度量后端：LangChain4j 在 `ChatModelListener` 中把耗时/token/错误以相同 tag 命名（如 `ai.token.total`、`ai.duration`）记录到同一 Registry；Spring AI 侧天然接入同一 Registry。聚合维度按 `sessionId`/`接口(意图)`/`模型` 打 tag，统一 Grafana 看板。
- 追问3：性能优化中的"缓存检索结果"，在排放因子标准会随新法规更新的场景下，你的缓存失效策略如何保证不返回过期因子？
  - **答**：缓存 key 带"数据版本/标准生效日期"，并以法规更新事件（新标准发布、CBAM 修订）作为失效触发器主动 evict；设 TTL 兜底（如 24h）；检索前校验缓存因子的 `applicableYear`/来源版本是否仍为最新，过期则回源重查 Milvus/因子库后再回填缓存。

### 20. LangChain4j的社区活跃度和生态如何？企业级项目中的最佳实践是什么？
**重要度**：★★

**生态**：LangChain4j 是 Java 生态最活跃的 AI 框架之一（GitHub Star 已 10k+ 量级），支持 20+ 向量库、15+ 模型供应商，Spring Boot 集成完善。

**最佳实践**：

1. **AiServices 声明式 API**：定义清晰的接口，将 AI 逻辑与业务逻辑解耦。
2. **Memory 隔离**：按会话 ID 隔离，使用 Redis 持久化。
3. **Tool 独立管理**：工具类独立定义，按功能域分组。
4. **异常兜底**：AiServices 没有 `@Fallback` 注解（也没有内置 fallback 机制）；兜底靠两层——自定义 ChatModel 装饰器做重试与主备模型切换，业务侧在 AiServices 调用外用 try-catch 捕获 `LangChain4jException` 返回降级答案，另可用 `ChatModelListener.onError` 做告警。
5. **测试**：用 `WireMock` Mock 大模型 API 做单元测试。


#### 追问：
- 追问1：你提到用 AiServices 外层 try-catch 做模型异常兜底，在碳管家"必须给出严谨碳核算数字"的场景下，兜底返回的默认值是预设常量还是安全提示，如何避免兜底值被误当真值？
  - **答**：兜底不返回预设"假因子常量"，而返回"安全提示"（如"因子查询暂不可用，请核实后重试/转人工"）。兜底值显式带 `isFallback=true` 标记并在前端标注"非权威值"；结构化结果中数值字段置 null + 原因，绝不混入可被执行计算的常量，避免被下游误当真值。
- 追问2：最佳实践建议用WireMock Mock大模型做单元测试，针对RAG链路你如何Mock Milvus检索结果以保证测试既快又可复现？
  - **答**：用 WireMock 桩 `EmbeddingStore`/Milvus 客户端（或抽象一层 `ContentRetriever` 接口注入 Mock 实现），预置"query→固定 chunk 列表"映射；EmbeddingModel 同样 Mock 返回固定向量。RAG 链路不依赖真实 Milvus/模型，测试秒级且结果由桩数据决定，可复现。
- 追问3：你列了5条企业级实践，如果团队要在3个月内把碳管家从单机LangChain4j升级为多租户SaaS，这5条中哪条优先级最高、瓶颈在哪？
  - **答**：优先级最高是"Memory 隔离 + 按租户数据隔离"（多租户核心是数据与会话隔离）。瓶颈：
    - ① 向量库需按租户 Collection 隔离或加 tenant_id filter
    - ② 模型调用需租户级配额/限流
    - ③ 密钥与审计按租户
    - 原单机 Redis/MySQL 记忆与 Milvus 需改造为租户维度，是主要工作量。


#### 扩充第五节：LangChain4j框架（新增10题）


### 21. LangChain4j vs Spring AI的定位差异与选型建议
**重要度**：★★★★

**题目：碳管家AI助手同时使用Spring AI和LangChain4j，两者的定位差异是什么？何时应该优先选择哪个框架？**

LangChain4j和Spring AI虽功能重叠但定位不同，理解差异才能合理选型。

定位差异：
- **Spring AI**：Spring生态一等公民，面向Spring Boot开发者，强调Spring风格（Bean、Advisor、AutoConfiguration），适合需要深度融入Spring微服务架构的AI应用
- **LangChain4j**：LangChain 的 Java 版，面向 AI 应用开发者，强调 AI 概念的原生表达（AiServices、Agent、Tool、Memory、RAG 组件），适合复杂 AI 逻辑编排；注意它刻意不复制 Python 的 Chain 抽象

选型建议矩阵：

| 场景 | 推荐框架 | 原因 |
|------|----------|------|
| Spring Boot项目集成AI | Spring AI | 无缝融入Spring生态，配置式开发 |
| 复杂RAG链路编排 | LangChain4j | RetrievalAugmentor 的组件化编排更适合多步骤 RAG |
| Tool Calling | Spring AI | 更贴合Spring Bean注册风格 |
| Agent设计 | LangChain4j | AiServices声明式Agent更直观 |
| 多模型切换 | Spring AI | ChatModel统一抽象更简洁 |
| 自定义AI Pipeline | LangChain4j | QueryTransformer/Retriever/Aggregator 可自由替换组合 |
| 可观测性/监控 | Spring AI | 自动接入Micrometer |

碳管家混合使用最佳实践：
- **框架分工**：两者均可做模型调用/RAG/Agent（能力重叠，非互斥）。碳管家按团队栈分工：Spring AI 管模型调用层（ChatModel、Tool Calling、Advisor，贴 Spring 生态），LangChain4j 管 RAG 编排层（RetrievalAugmentor、QueryTransformer、AiServices，组件细可定制）——是分工不是能力边界
- **数据流通**：LangChain4j的Retriever结果通过Advisor传递给Spring AI的ChatModel
- **不重叠**：避免同一功能在两个框架中都实现，选择最合适的那个

#### 追问：
- 追问1：你建议"复杂RAG链路编排选LangChain4j、可观测性选Spring AI"，在碳管家实际请求中，一条链路如何同时享受两边优势而不产生两次埋点重复？
  - **答**：统一度量后端为 Micrometer，在链路唯一"边界"埋点：RAG 检索耗时由 LC4j 事件/Listener 记一次，模型调用耗时由 Spring AI Advisor 记一次，按同一 `traceId` 关联，而非各记全流程。通过 Facade 把两次埋点归并到同一请求上下文，避免重复计全链路。
- 追问2：你说的"数据流通：LangChain4j的Retriever结果通过Advisor传给Spring AI的ChatModel"，这个跨框架传递的具体数据结构和触发时机是什么？
  - **答**：数据结构为 `List<Content>`（含 text + metadata.source），封装进 Spring AI 的 `ChatClientRequest` 的上下文或合并进 UserMessage/system 上下文。触发时机：LC4j 检索在 Facade 调用 `ChatClient` 之前完成，结果作为上下文注入请求，再交给 Spring AI `ChatModel.call`，即"检索前置、生成后置"。
- 追问3：若未来LangChain4j与Spring AI的某个能力（如Tool Calling）趋同，你预留了什么机制来低成本地把碳管家从双框架收敛为单框架？
  - **答**：通过 `CarbonAiFacade` 抽象层隔离框架细节，业务只依赖 Facade 接口；RAG/Tool/Memory 等能力在 Facade 内以接口抽象，底层可替换实现。收敛时只改 Facade 内部实现（如把 LC4j 的 RetrievalAugmentor 方案换成 Spring AI 的 `QuestionAnswerAdvisor`），业务代码不动，实现低成本切换。

### 22. LangChain4j的AiServices（声明式AI服务）详解
**重要度**：★★★★

**题目：LangChain4j的AiServices如何用声明式方式定义AI服务接口？在碳管家场景中如何应用？**

AiServices是LangChain4j的核心创新，允许用Java接口声明式定义AI服务，框架自动生成实现类，类似MyBatis的Mapper接口。

原理：
- 开发者定义一个Java接口，方法签名即AI服务契约
- LangChain4j在运行时动态生成接口的实现类（Proxy）
- 实现类内部：将方法参数转换为Prompt → 调用LLM → 将输出映射为方法返回类型
- 支持注入@Tool、@V、@UserMessage、@SystemMessage等注解增强

碳管家AiServices定义示例：
```java
@SystemMessage("你是碳管理AI助手，专注于LCA碳足迹计算和ISO标准解读...")
interface CarbonAssistant {
    @UserMessage("查询{{industry}}行业的碳排放因子")
    CarbonFactorResult queryFactor(@V("industry") String industry);

    @UserMessage("根据以下数据计算产品碳足迹：{{data}}")
    CarbonFootprintReport calculateFootprint(@V("data") String data);

    String chat(String userMessage); // 通用对话
}
```

构建与使用：
```java
CarbonAssistant assistant = AiServices.builder(CarbonAssistant.class)
    .chatModel(qwenModel)                                               // 1.x 方法名是 chatModel
    .contentRetriever(milvusRetriever)
    .tools(carbonFactorTool, lcaCalculatorTool)
    .chatMemoryProvider(id -> MessageWindowChatMemory.withMaxMessages(20))  // 按 session 隔离，别用全局单例 chatMemory
    .build();
```

优势：
- 声明式定义减少样板代码（无需手动拼Prompt、解析响应）
- 类型安全：输入输出都是Java类型，编译期检查
- 碳管家场景：每个业务场景（因子查询/报告生成/合规判定）定义独立接口，职责清晰

#### 追问：
- 追问1：你示例的CarbonAssistant用@V注入变量，若用户问"查询钢铁行业因子"但意图其实是"查询钢铁行业炼钢工序因子"，声明式接口无法表达嵌套意图时如何扩展？
  - **答**：
    - ① 把接口方法参数细化（如 `queryFactor(industry, process)`），用多个 `@V` 表达
    - ② 或把自然语言交给 QueryTransformer/意图识别层解析出结构化参数再调用
    - ③ 用通用 `chat(String)` 配合 RAG + Tool 动态解析嵌套意图，不必为每个嵌套维度都加声明式参数
- 追问2：AiServices运行时动态生成Proxy实现类，在碳管家高并发下，每个session都builder().build()是否会有性能/内存问题，你如何复用实例？
  - **答**：不应每 session build——AiServices 实例无状态（状态在 ChatMemory/Retriever），应全局单例（Spring `@Bean` 复用），仅 `sessionId` 作调用参数区分会话。build 一次缓存复用，避免重复生成 Proxy 与连接开销；若需不同配置（模型/Tool 分组）可按场景建少量固定实例池。

### 23. LangChain4j的RAG链式编排（RetrievalAugmentor + AiServices）
**重要度**：★★★★

**题目：LangChain4j如何编排多步骤AI流程？碳管家的RAG流程如何用LangChain4j编排？**

> ⚠️ **澄清**：LangChain4j **刻意不提供** Python LangChain 那种 `Chain<I,O>` / `Chains.sequential()` 抽象（官方明确表示不复制 Chain 类）。它的多步骤编排走 **`AiServices` + `RetrievalAugmentor` + `ContentRetriever` + `QueryTransformer` + `ContentInjector`** 这套抽象，而非"Chain"链。下面按真实 API 讲。

LangChain4j 的 RAG 编排核心是 **`RetrievalAugmentor`**（默认实现 `DefaultRetrievalAugmentor`），它把"检索增强"拆成可插拔的四步：

- **QueryTransformer**：查询改写/扩展（如把口语化"钢铁的碳因子"转成贴近知识库的表述）
- **ContentRetriever**：内容检索（单路向量检索，返回 `List<Content>`；混合检索要自己组合多路 retriever）
- **ContentInjector**：把检索结果注入到 Prompt 上下文
- **QueryRouter**：查询路由（可选，按意图分发到不同 retriever）

碳管家 RAG 编排（真实 API）：
```java
// 1. ContentRetriever：向量检索（EmbeddingStoreContentRetriever 只做单路向量召回）
ContentRetriever retriever = EmbeddingStoreContentRetriever.builder()
    .embeddingStore(milvusStore)
    .embeddingModel(embeddingModel)
    .maxResults(5)
    .build();

// 2. RetrievalAugmentor：编排"改写→检索→注入"，各环节可插拔
RetrievalAugmentor augmentor = DefaultRetrievalAugmentor.builder()
    .queryTransformer(ExpandingQueryTransformer.builder()  // 查询扩展：类名是 ExpandingQueryTransformer，用 LLM 扩写出多个变体查询，构造参数是 ChatModel 而非 EmbeddingModel
        .chatModel(qwenModel)
        .nQueries(3)
        .build())
    .contentRetriever(retriever)
    .contentInjector(DefaultContentInjector.builder().promptTemplate(...).build())
    .build();

// 3. AiServices：声明式接口，把 augmentor + memory + tools 编排成 assistant
CarbonAssistant assistant = AiServices.builder(CarbonAssistant.class)
    .chatModel(qwenModel)
    .retrievalAugmentor(augmentor)   // RAG 增强注入
    .chatMemory(MessageWindowChatMemory.withMaxMessages(20))
    .tools(new CarbonTools())        // Function Calling 工具
    .build();

// 4. 调用：框架自动完成 改写→检索→注入→生成
String answer = assistant.answer("钢铁行业碳排放因子是多少？");
```

与 Spring AI Advisor 的对比：
- **LangChain4j RetrievalAugmentor**：显式编排 RAG 各环节（改写/检索/注入），步骤清晰可见、可单测，适合复杂多步 RAG
- **Spring AI Advisor**（如 `RetrievalAugmentationAdvisor`）：隐式拦截、自动链式执行，适合通用增强（记忆、审计、检索）+ 与 Spring 生态贴合
- 碳管家选择：RAG 链编排用 LangChain4j（步骤多、需灵活调整各环节），通用横切增强用 Spring AI Advisor（记忆、审计、安全过滤）

进阶：条件分支不靠"Conditional Chain"，而是自定义 **QueryRouter**（按意图把 query 路由到不同 ContentRetriever，如检索质量差时路由到 Web 搜索 retriever 降级）。

#### 追问：
- 追问1：DefaultRetrievalAugmentor 编排"改写→检索→注入"，若 ContentRetriever 返回空结果，augmentor 是短路还是继续注入空上下文生成？如何降级到 Web 搜索？
  - **答**：默认会注入空上下文继续生成（不短路），所以要在 retriever 前或后做判空。策略：
    - ① 自定义 ContentRetriever 包一层，结果为空/平均得分低于阈值时，改走 WebSearchContentRetriever 降级
    - ② 或在 QueryRouter 层判断——检索质量差时路由到备用 retriever
    - ③ 也可在 ContentInjector 前拦截空结果，避免注入空上下文导致模型"硬编"答案
- 追问2：后处理校验"碳数值单位缺失"这种逻辑，放在 RetrievalAugmentor 里还是 AiServices 之外单独做？如何保证不引入错误假设？
  - **答**：不放在 augmentor 里（augmentor 只管检索增强），放在 AiServices 调用之后做后处理校验。策略：
    - ① SystemMessage 先要求模型"按原文单位，缺失则置 null 并说明"
    - ② 后处理校验发现单位缺失则回退重生成一次，仍缺失则返回"单位未知，请补充"而非填默认
    - ③ 对关键碳核算数值，缺失单位视为不可信，转人工/标注待核——绝不擅自用默认单位补全（会引入错误假设）
- 追问3：碳管家"RAG 用 LangChain4j、通用增强用 Spring AI Advisor"，两者如何收口避免重复编排，顺序一致性如何保证？
  - **答**：用统一 Facade（AiGateway）收口，不互相嵌套。Facade 先调 Spring AI Advisor 做横切（记忆加载、审计），内部再调 LangChain4j 的 AiServices 做 RAG 生成；顺序以 Facade 调用顺序为权威，用统一 `traceId` 串联，保证"记忆→RAG 检索→生成→审计"顺序一致。两者是 Facade 下的并列职责（横切 vs RAG 编排），不嵌套不重复。

### 24. LangChain4j的Memory（记忆）机制
**重要度**：★★★★

**题目：LangChain4j提供了哪些ChatMemory记忆机制？碳管家AI助手如何选择和配置？**

LangChain4j的记忆机制管理对话历史，确保LLM能理解跨轮次的上下文引用。

ChatMemory接口：
- 核心方法：`add(Message)`、`messages()`、`clear()`
- 内置实现只有两个窗口类：`MessageWindowChatMemory`（按消息条数滑窗）、`TokenWindowChatMemory`（按 token 预算滑窗）。LangChain4j 没有"全量历史"的现成实现——要保留所有轮次就自己实现 `ChatMemory`（`add` 全收、`messages()` 全返），或让 `ChatMemoryStore` 持久化完整消息不做裁剪。
- `MessageWindowChatMemory`：滑动窗口，仅保留最近N条消息
- 支持自定义存储后端：`ChatMemoryStore`接口，可对接Redis/MySQL

MemoryWindow（窗口记忆）配置：
```java
MessageWindowChatMemory memory = MessageWindowChatMemory.withMaxMessages(10);
// 保留最近5轮对话（10条消息 = 5个user + 5个ai）
```

碳管家记忆策略：
- **短期记忆**（同一会话）：`MessageWindowChatMemory`，保留最近10条消息
  - 用户可能在多轮对话中逐步细化碳排放计算，需要回溯前轮数据
- **长期记忆**（跨会话）：自定义`PersistentChatMemoryStore`，存储到MySQL
  - 用户昨天查询的排放因子今天可能引用（"上次那个0.85的因子"）
- **语义记忆**：将对话摘要向量化存入Milvus
  - 新会话开始时检索相似历史对话，提供"你可能想问..."建议

记忆注入机制：
- AiServices构建时注入`chatMemory`
- 每次调用自动从memory加载历史 → 注入Prompt → 调用LLM → 保存新消息到memory
- 与Spring AI的ChatMemoryAdvisor类似但更声明式

#### 追问：
- 追问1：你设计了短期/长期/语义三层记忆，新会话开始时从Milvus检索相似历史对话提供"你可能想问"，但若检索到的历史本身包含错误因子，是否会污染新会话？
  - **答**：语义记忆只作为"建议/上下文提示"，不自动作为事实注入计算；且带来源与置信度，新会话引用前经独立校验后处理器核对（与该用户权威因子库比对）。对已被纠错的因子，在 MySQL 长期记忆标记"以修正值为准"，检索时优先权威值，降低错误历史污染。
- 追问2：长期记忆存MySQL、语义记忆存Milvus，两套存储与Redis短期记忆之间如何同步，用户在一处修正了因子后另外两处何时更新？
  - **答**：以 MySQL 长期记忆为权威源。修正因子时：
    - ① 写 MySQL 并删/更新对应语义记忆向量（Milvus 按 id upsert）
    - ② Redis 短期记忆中该 session 的历史消息可标记"已修正"或下次加载时以 MySQL 为准覆盖
    - 采用"写直达 MySQL + 异步更新 Milvus/失效 Redis 缓存"的最终一致策略。

### 25. LangChain4j的StructuredOutput（结构化输出）
**重要度**：★★★★

**题目：碳管家AI需要生成结构化的碳排放报告（JSON格式），LangChain4j的StructuredOutput如何确保输出符合预定Schema？**

StructuredOutput是LangChain4j将LLM自由文本输出映射为Java POJO的能力，核心解决LLM输出格式不可控问题。

实现原理：
- 开发者定义输出Java类（如`CarbonFootprintReport`）
- LangChain4j自动根据类定义生成JSON Schema描述
- 将Schema描述注入Prompt，约束LLM输出符合Schema格式
- LLM输出JSON字符串后，LangChain4j用Jackson反序列化为Java对象

定义示例：
```java
@Description("碳排放因子查询结果")
record CarbonFactorResult(
    @Description("行业名称") String industry,
    @Description("排放因子数值") Double value,
    @Description("单位") String unit,
    @Description("数据来源") String source,
    @Description("适用年份") Integer applicableYear
) {}
```

AiServices使用：
```java
CarbonAssistant assistant = AiServices.builder(CarbonAssistant.class)
    .chatModel(qwenModel)
    .build();
CarbonFactorResult result = assistant.queryFactor("钢铁行业");
// result直接是Java对象，无需手动解析JSON
```

碳管家场景关键：
- 碳排放因子结果必须结构化（数值+单位+来源+年份），不能是模糊文本
- LCA报告生成结果映射为`CarbonFootprintReport`（含总排放量、各阶段明细、数据来源）
- 合规判定结果映射为`ComplianceResult`（合规/不合规+依据条款+整改建议）

容错设计：LLM偶尔输出格式错误，LangChain4j的`OutputConverter`支持重试修复格式（重新Prompt要求修正格式）。

#### 追问：
- 追问1：你用record定义CarbonFactorResult并由LangChain4j生成JSON Schema约束输出，若模型返回的行业名不在枚举内（如把"钢铁"写成"冶金"），反序列化与业务校验如何分层处理？
  - **答**：反序列化层用宽松映射（行业名先作自由字符串接收，不强制枚举，避免反序列化失败）；业务校验层再做归一化——把"冶金"映射到标准行业字典（如归一为"钢铁"）或标"待确认"。即 Jackson 反序列化容错 + 后续 `IndustryNormalizer` 业务映射，分层保证既能解析又不放错值。
- 追问2：OutputConverter重试修复格式时，如果反复失败，碳管家是回退到非结构化文本还是直接报错给用户，重试上限与成本如何权衡？
  - **答**：设重试上限（如 2 次），超限不无限烧 token：回退到"带原文引用的非结构化文本 + 明确标注'格式解析失败，请参考原始回答'"，而非硬报错中断。成本权衡：重试仅首次失败触发，超限即降级并记录失败指标供监控；关键报告场景可转人工复核。

### 26. LangChain4j与Spring Boot深度集成实践
**重要度**：★★★

**题目：LangChain4j如何与Spring Boot深度集成？在碳管家项目中，Spring AI和LangChain4j如何共存？**

LangChain4j 提供了 `langchain4j-spring-boot-starter`（groupId `dev.langchain4j`，按 provider 拆成 `langchain4j-open-ai-spring-boot-starter`、`langchain4j-ollama-spring-boot-starter` 等），支持 Spring Boot 自动配置和 Bean 注入。

自动配置：
- `langchain4j-spring-boot-starter` + 具体 provider starter：自动配置 `ChatModel`、`EmbeddingModel` 等核心 Bean（0.x 时代叫 `ChatLanguageModel`，1.x 已更名）
- 配置项：按 provider 分前缀（**不存在** `langchain4j.chat-model.provider` 统一切换键），如对接通义千问走 OpenAI 兼容端点用 `langchain4j.open-ai.chat-model.api-key=xxx` + `langchain4j.open-ai.chat-model.base-url` 指向 DashScope，或用社区 `langchain4j-dashscope` 模块
- 支持多模型配置：通过`@Qualifier`区分不同模型Bean

与Spring AI共存策略：
- **依赖管理**：两个框架的依赖不冲突，可同时引入pom.xml
- **Bean隔离**：Spring AI的ChatModel和LangChain4j的ChatModel是不同包下的不同 Bean（全限定名不同），各自管理
- **统一入口**：碳管家自定义`AiServiceFacade`，对外统一API，内部根据场景选择框架
  - RAG检索 → LangChain4j 的 RetrievalAugmentor/ContentRetriever 编排
  - 模型调用 → Spring AI ChatModel（更贴合Spring生态）
  - Tool Calling → Spring AI（Bean注册风格）
  - 对话管理 → LangChain4j AiServices（声明式风格）

共存注意：
- 避免两个框架的Embedding模型重复配置（统一使用一个）
- ChatMemory/记忆存储统一（两个框架共享同一Redis/MySQL存储）
- 日志和监控统一接入Micrometer（Spring AI自动接入，LangChain4j需手动埋点）


#### 三种框架实现对比

##### Spring AI 1.0 实现

```java
// 统一入口 Facade：内部按场景路由到 Spring AI，LangChain4j 侧只承担 RAG 检索链
@Service
public class AiServiceFacade {

    private final ChatClient chatClient;
    private final ChatMemory chatMemory;
    private final VectorStore vectorStore;

    public AiServiceFacade(ChatModel chatModel, ChatMemory chatMemory, VectorStore vectorStore) {
        this.chatMemory = chatMemory;
        this.vectorStore = vectorStore;
        this.chatClient = ChatClient.builder(chatModel)
                .defaultAdvisors(
                        new QuestionAnswerAdvisor(vectorStore),   // RAG 检索 → 注入上下文
                        MessageChatMemoryAdvisor.builder(chatMemory).build())
                .build();
    }

    // 场景路由：RAG 问答走 Spring AI 全链路
    public String askWithRag(String sessionId, String question) {
        return chatClient.prompt()
                .user(question)
                .advisors(a -> a.param(ChatMemory.CONVERSATION_ID, sessionId))
                .call()
                .content();
    }

    // 场景路由：纯模型调用（无检索）走另一个 ChatClient，避免无谓的向量查询
    public String askPlain(String question) {
        return ChatClient.create(chatModel).prompt().user(question).call().content();
    }

    // 统一监控：把 token 用量上报 Micrometer，与 LangChain4j 侧埋点对齐维度
    public Usage recordUsage(String sessionId, String question) {
        ChatResponse resp = chatClient.prompt()
                .user(question)
                .advisors(a -> a.param(ChatMemory.CONVERSATION_ID, sessionId))
                .call()
                .chatResponse();
        return resp.getMetadata().getUsage();
    }
}
```

##### Spring AI 2.0 实现

```java
// 2.0 差异：ToolCallback 必须显式注册；ToolCallingAdvisor 由 ChatClient 自动注册；
//           ChatModel.call() 不再自动执行工具
@Service
public class AiServiceFacade {

    private final ChatClient chatClient;
    private final ToolCallback carbonTool;

    public AiServiceFacade(ChatModel chatModel, ChatMemory chatMemory,
                           VectorStore vectorStore, ToolCallback carbonTool) {
        this.carbonTool = carbonTool;
        this.chatClient = ChatClient.builder(chatModel)
                .defaultAdvisors(
                        QuestionAnswerAdvisor.builder(vectorStore).build(),
                        MessageChatMemoryAdvisor.builder(chatMemory).build())
                // 2.0：tools 必须显式传 ToolCallback，不能只写 Bean 名（toolNames 已移除）
                .defaultToolCallbacks(carbonTool)
                .build();
    }

    public String askWithRag(String sessionId, String question) {
        return chatClient.prompt()
                .user(question)
                .advisors(a -> a.param(ChatMemory.CONVERSATION_ID, sessionId))
                .options(OpenAiChatOptions.builder().temperature(0.2))
                .call()
                .content();
    }

    // 渐进式工具披露：工具很多时先只暴露 toolSearchTool，让模型按需检索
    @Bean
    ChatClient toolSearchChatClient(ChatModel chatModel, ToolCallback carbonTool) {
        // 需在 properties 里开启 spring.ai.chat.client.tool-search-advisor.enabled=true
        return ChatClient.builder(chatModel)
                .defaultToolCallbacks(carbonTool)
                .build();
    }
}
```

##### LangChain4j 实现

```java
// 统一入口 Facade：LangChain4j 承担 RAG 检索链与声明式对话，模型调用可委派给 Spring AI
@Service
public class AiServiceFacade {

    private final CarbonAssistant carbonAssistant;   // LC4j AiServices
    private final ChatClient springAiChatClient;    // Spring AI 兜底/专用调用

    public AiServiceFacade(CarbonAssistant carbonAssistant, ChatModel springAiChatModel) {
        this.carbonAssistant = carbonAssistant;
        this.springAiChatClient = ChatClient.create(springAiChatModel);
    }

    // 场景路由：声明式对话（RAG + 记忆 + 工具）走 LangChain4j
    public String askWithRag(String sessionId, String question) {
        return carbonAssistant.chat(sessionId, question);
    }

    // 场景路由：轻量单轮调用走 Spring AI ChatClient
    public String askPlain(String question) {
        return springAiChatClient.prompt().user(question).call().content();
    }

    // 工具调用结果优先级更高：Prompt 里约束"以工具返回的最新因子为准"
    public String askWithToolFirst(String sessionId, String question) {
        return carbonAssistant.chat(sessionId, question);
    }
}
```

#### 追问：
- 追问1：你提到AiServiceFacade对外统一API、内部按场景路由，这个Facade本身是Spring Bean还是静态工厂，它如何保证RAG链路中的Milvus连接与Spring AI的ChatModel连接共享同一池？
  - **答**：Facade 是 Spring `@Bean`（单例），内部持有 LC4j AiServices/RetrievalAugmentor 与 Spring AI ChatModel 的引用。连接池共享：Milvus 客户端与模型 endpoint（vLLM）在各框架配置时注入同一连接池/客户端实例（`@Primary` 单例），Facade 不新建连接仅做编排，保证 RAG 与生成共用同一底层连接。
- 追问2：两个框架共存时你要求"ChatMemory统一共享同一Redis/MySQL"，但Spring AI的ChatMemoryAdvisor与LangChain4j的ChatMemory数据格式不同，你如何做适配层？
  - **答**：定义统一的 `ChatMemoryStore` 适配层：对外暴露与框架无关的内存读写接口，内部把 Spring AI 的 `ChatMemory` 与 LC4j 的 `ChatMemory` 格式互相转换（消息列表 ↔ LC4j Message）。在两者与存储之间加 Adapter，存储只用一套（Redis/MySQL），两框架通过 Adapter 读写同一份数据。
- 追问3：日志监控统一接Micrometer，LangChain4j需手动埋点，你具体在检索管线的哪几个节点埋点才能与Spring AI的Advisor指标对齐维度？
  - **答**：在检索管线关键节点埋点：
    - ① queryTranslation 耗时
    - ② retrieval（Milvus 查询）耗时与命中数
    - ③ augmentation 注入 token 数
    - ④ generation（LLM 调用）耗时与 token
    - ⑤ validation 结果
    - 以相同 tag（`model`/`intent`/`sessionId`）写入 Micrometer，与 Spring AI Advisor 的 `ChatClient` 指标维度对齐，统一看板。

### 27. LangChain4j的Document Loader体系
**重要度**：★★★

**题目：LangChain4j提供了哪些Document Loader？碳管家知识库构建中如何选择和使用？**

LangChain4j的Document Loader体系负责从各种数据源加载文档，转换为统一的`Document`对象（text + metadata）。

核心Loader：
- `FileSystemDocumentLoader`：从本地文件系统加载（PDF、TXT、Markdown）
  - 碳管家场景：加载本地ISO标准PDF、排放因子Excel
- `UrlDocumentLoader`：从URL加载网页内容
  - 碳管家场景：加载环保部官网政策页面
- `S3DocumentLoader`：从AWS S3加载
- `GitHubDocumentLoader`：从GitHub仓库加载
- `TikaDocumentLoader`：通用文档解析（支持PDF/DOCX/PPTX/等50+格式）

碳管家知识库构建流程：
```java
// 加载ISO标准PDF
List<Document> isoDocs = FileSystemDocumentLoader.loadDocuments(
    Paths.get("knowledge/iso14064.pdf"),
    new ApachePdfBoxDocumentParser()   // 需引 langchain4j-document-parser-apache-pdfbox
);

// 加载排放因子Excel
List<Document> factorDocs = FileSystemDocumentLoader.loadDocuments(
    Paths.get("knowledge/emission_factors.xlsx"),
    new ApacheTikaDocumentParser()   // 需引 langchain4j-document-parser-apache-tika
);

// 分块+向量化+入库
DocumentSplitter splitter = DocumentSplitters.recursive(500, 100);  // 单位：字符
List<TextSegment> segments = splitter.split(isoDocs);
Response<List<Embedding>> embeddings = embeddingModel.embedAll(segments);  // 1.x 返回 Response
embeddingStore.addAll(embeddings, segments);
```

碳管理特殊处理：
- ISO标准文档保留条款编号作为metadata（如`{section: "6.1", standard: "ISO 14064-1"}`）
- 排放因子Excel提取行业和年份作为metadata（支持Self-Query过滤）
- 定期增量加载：新标准发布时自动加载入库

#### 追问：
- 追问1：你用Tika解析排放因子Excel并把行业/年份写入metadata，若Excel中某行行业字段缺失，加载时你选择跳过该行还是用默认值，对Self-Query过滤有何影响？
  - **答**：缺失行业字段不跳过整行（避免丢数据），而是置 `industry="unknown"` 并保留其他 metadata；Self-Query 用"行业=unknown"可过滤排除，或检索时对该字段做宽松匹配。更稳妥：缺失关键过滤字段的行标为低优先级，检索时若用户指定行业则自动排除 unknown，不影响精确查询。
- 追问2：你提到定期增量加载新标准，如何识别Milvus中"已废止的旧版ISO条款"并下线，避免检索时新旧版本冲突？
  - **答**：给每条条款 metadata 加 `status`（effective/deprecated）与 `version`；新标准发布时加载新版并标记旧版 `deprecated`；检索 Filter 默认排除 `deprecated`；保留旧版一段时间供追溯，确认无引用后物理删除或彻底隔离。亦可用"标准号+版本"维度去重，避免新旧共存冲突。

### 28. LangChain4j的Moderation（内容审核）
**重要度**：★★★

**题目：碳管家AI助手可能生成不当内容（如错误的碳核算建议），LangChain4j的Moderation模块如何实现内容审核？**

Moderation模块对LLM输出做安全合规检查，确保内容不违反安全策略和业务规则。

LangChain4j Moderation架构：
- `ModerationModel`接口：审核模型，输入文本→输出审核结果（flagged/categories）
- 内置OpenAI Moderation Model：检测暴力/色情/仇恨等通用安全类别
- 自定义`ModerationModel`：实现碳管理特有的审核逻辑

碳管家自定义审核维度：
- **数值合理性审核**：排放因子是否在合理范围（如钢铁行业CO2因子应在0.5-2.0 tCO2e/t钢之间）
- **法规准确性审核**：引用的ISO标准编号是否真实存在且条款描述正确
- **建议安全性审核**：碳减排建议是否可能误导企业做出违规决策
- **数据隐私审核**：输出是否包含其他企业的敏感碳排放数据

实现方式：
```java
public class CarbonModerationModel implements ModerationModel {
    // 1.x 签名：ModerationRequest 进、ModerationResponse 出（内部是 List<Moderation>）
    @Override
    public ModerationResponse moderate(ModerationRequest request) {
        List<Moderation> results = request.texts().stream()   // 一次可审核多条文本
                .map(this::moderateOne)
                .toList();
        return new ModerationResponse(results);
    }

    private Moderation moderateOne(String text) {
        // Moderation 只有 flagged + flaggedCategories 两个字段，没有 flagged(...)/notFlagged() 静态工厂
        if (containsUnreasonableValue(text)) {
            return new Moderation(true, Set.of("CARBON_VALUE_ANOMALY"));
        }
        if (containsFakeStandardReference(text)) {
            return new Moderation(true, Set.of("FAKE_STANDARD_REF"));
        }
        if (containsOtherEnterpriseData(text)) {
            return new Moderation(true, Set.of("DATA_PRIVACY_LEAK"));
        }
        return new Moderation(false, Set.of());
    }
}
```

> 注意：数值合理性 / 法规编号这类校验本质是规则判断，更适合放在 AiServices 调用之后的规则引擎/后处理器里（零额外模型调用）；`ModerationModel` 是用来接"通用安全类目"的模型（暴力/色情/仇恨等），自研实现里做规则校验属于借用接口，会多一次链路开销。

集成到AiServices：
```java
CarbonAssistant assistant = AiServices.builder(CarbonAssistant.class)
    .chatModel(qwenModel)
    .moderationModel(carbonModerationModel)
    .build();
```

每次生成后自动审核，flagged 内容阻断返回并触发告警。

#### 追问：
- 追问1：你的CarbonModerationModel做数值合理性审核（如钢铁CO2因子0.5-2.0），但不同工艺路线（如电炉 vs 高炉）因子差异巨大，你怎么避免把合规值误判为异常？
  - **答**：数值审核不应只用全局区间，应按"行业+工艺路线"分级阈值：在 metadata/因子库带 `process`（高炉/电炉），审核时取对应工艺的合理区间（电炉显著低于高炉）。把"工艺路线"作为上下文传入审核，做精细化区间判断，避免把某工艺合规值误判为异常。
- 追问2：Moderation在每次生成后自动审核并阻断flagged内容，若阻断发生在流式输出中途，已推送给前端的token如何撤回或更正？
  - **答**：流式场景采用"生成后整体审核 + 轻量块级校验"：若最终审核 flagged，前端收到"内容已撤回/更正"指令块并清空/替换已显示内容（UI 支持最后一块为准）；若必须中途阻断，发"内容合规校验未通过，已停止"提示并停止后续 token。关键数值类先用块级规则快速拦违规。

### 29. LangChain4j 版本演进与新特性（0.31→1.x）
**重要度**：★★★★★

**题目：LangChain4j 0.31及以上版本带来了哪些重要新特性？对碳管家AI助手的升级有什么影响？**

LangChain4j 已于 2025 年进入 1.x（1.0 GA）。0.31（2024年发布）是其走向 1.0 前的重大版本升级，架构和 API 均有变化（若项目仍用 0.31/0.34，以下新特性相对更早版本而言；新项目建议直接用 1.x）。

核心新特性：
- **AiServices增强**：支持返回`Response<A>`（含TokenUsage、FinishReason等元信息），碳管家可获取推理成本和完成状态
- **流式改进**：`AiServices` 的接口方法返回 `TokenStream` 即可流式输出；1.x 起支持"流式生成过程中执行 Tool Calling"（更早版本流式与工具调用不能共存），碳管家LCA报告可边生成边展示
- **@Tool注解增强**：`@Tool`方法支持更复杂的参数描述，`@P`注解可为每个参数添加描述，LLM Tool Calling更精确
- **Retriever统一接口**：`ContentRetriever` 统一了检索抽象（向量/Web/关键词各有实现类），业务侧面向同一个接口；混合检索需要自己组合多个 retriever 再用 `ContentAggregator` 合并，框架不内置
- **EmbeddingStore增强**：支持metadata过滤（`Filter`），碳管家可按行业/年份过滤向量检索
- **可观测性**：`ChatModelListener`覆盖模型调用（`onRequest`/`onResponse`/`onError`）；工具调用用 `ToolExecutedEvent`（AiService 事件）；检索侧没有官方事件，要在自定义 `ContentRetriever` 里自己埋点
- **多模型**：一个 AiServices 只能配一个 `chatModel`（需要流式再配一个 `streamingChatModel`）；没有内置的主备模型与 fallback 链，切换要自定义 `ChatModel` 装饰器或下沉到 AI 网关

对碳管家升级影响：
- AiServices元信息返回使成本统计更精确（每条对话的Token消耗可追踪）
- Streaming + Tool Calling组合使碳管家可以流式展示计算过程（边检索因子边计算边展示）
- EmbeddingStore metadata过滤直接支持Self-Query检索（无需额外开发）
- Event Listener（`ChatModelListener` + `ToolExecutedEvent`）使审计日志从"最终答案"升级为"全步骤追踪"

升级注意：0.31 API有breaking changes（如`Retriever`→`ContentRetriever`），需逐模块验证。

#### 追问：
- 追问1：0.31把Retriever改为ContentRetriever是breaking change，碳管家升级时如何保证旧的检索调用点与新的多路 Retriever 配置平滑过渡、不中断线上服务？
  - **答**：采用"适配层 + 灰度"：先引入兼容包装，把旧 `Retriever` 调用通过 Adapter 委托给新 `ContentRetriever`，业务代码暂不改；再逐步把调用点切到新 API 并跑回归；线上用双版本并跑/灰度流量验证，确认无误再全量。配合 `Response<A>` 等新特性也分步迁移。
- 追问2：EmbeddingStore支持metadata Filter后可直接做Self-Query，但用户自然语言里的"去年的标准"如何映射到具体的年份Filter表达式，解析失败如何降级？
  - **答**：用意图/时间解析把"去年"转为具体年份（如 2024），生成 `Filter.eq("applicableYear", 2024)`；解析失败（歧义/无法识别）则降级为"不加年份 Filter 的全量检索"或用 `applicableYear` 降序取最新，并在 Prompt 中说明"未限定具体年份，已返回最新相关标准"，保证不报错且结果可用。

### 30. 双框架混合使用的最佳实践
**重要度**：★★★★

**题目：碳管家同时使用Spring AI和LangChain4j，如何设计混合架构避免冲突和重复？请给出最佳实践。**

双框架混合使用需明确分工、统一基础设施、避免功能重叠。

分工原则：
- **Spring AI负责**：模型调用层（ChatModel统一抽象）、Tool Calling（Bean风格）、Advisor增强（链式拦截）、可观测性（Micrometer）
- **LangChain4j负责**：RAG编排层（RetrievalAugmentor/AiServices）、Agent设计（声明式）、记忆管理（ChatMemory）、内容审核（Moderation）

统一基础设施：
- **模型实例统一**：两个框架共享同一个模型连接（vLLM endpoint），不各自建连接池
- **向量存储统一**：两个框架共享同一个Milvus实例和Collection
- **Embedding统一**：使用一个EmbeddingModel（如bge-large-zh-v1.5），两个框架都调用同一服务
- **记忆存储统一**：Redis/MySQL做ChatMemory底层存储，两个框架共享数据

避免重叠：
- 不要在两个框架中都实现Tool Calling——统一用Spring AI
- 不要在两个框架中都配置RAG检索——统一用LangChain4j的ContentRetriever
- 不要在两个框架中都做格式校验——统一在Spring AI Advisor中做后处理

代码组织：
```
carbon-ai/
  ├── model/          # Spring AI ChatModel配置
  ├── rag/            # LangChain4j RAG 编排
  ├── tools/          # Spring AI ToolCallback / @Tool 定义
  ├── memory/         # 共享ChatMemory存储
  ├── moderation/     # LangChain4j Moderation
  ├── advisor/        # Spring AI自定义Advisor
  ├── facade/         # 统一对外API Facade
```

Facade模式：
- `CarbonAiFacade`对外统一接口，内部根据请求类型路由到Spring AI或LangChain4j
- 简单FAQ → Spring AI ChatModel（快速响应）
- RAG问答 → LangChain4j AiServices（完整检索+生成）
- Tool调用 → Spring AI ChatClient + ToolCallback（2.0 起工具循环由 ToolCallingAdvisor 统一编排）

---

---

#### 追问：
- 追问1：你规定Tool Calling统一用Spring AI、RAG检索统一用LangChain4j，那"先RAG检索再Tool调用"的串联请求在Facade里如何编排两个框架、谁持有主流程？
  - **答**：由 Facade 持有主流程（编排者）：Facade 先调 LC4j 的 ContentRetriever 做 RAG 检索得到上下文，再调 Spring AI ChatClient + ToolCallback 执行 Tool 调用，两框架结果在 Facade 层合并后返回。主流程在 Facade，框架各司其职，不互相嵌套调用。
- 追问2：统一基础设施要求两框架共享同一Milvus实例和Collection，若Spring AI侧和LangChain4j侧对Collection的schema（如metadata字段）理解不一致，如何做单一权威定义？
  - **答**：建立"Collection Schema 单一权威定义"——以一份 schema 契约（字段名/类型/含义）为准，放在共享配置/代码模块，两框架都从该契约生成/校验 metadata。新增字段走契约变更评审，启动时校验 Collection schema 与契约一致，避免两侧各写各的导致字段错位。
- 追问3：你的Facade按请求类型路由（简单FAQ→Spring AI，RAG→LangChain4j），若一个问题既是FAQ又需引用最新法规，路由决策冲突时如何兼顾速度与准确性？
  - **答**：路由用"复合决策"而非单选：FAQ 命中但含"最新法规/因子"意图时，升级为 RAG 路径（LC4j）以保证准确性；或先做轻量 FAQ 命中检测，再对"需引用"类追加 RAG 增强。即默认走快路径，检测到法规/数值依赖则自动提升到 RAG，兼顾速度与严谨。

#### LangChain4j 基础用法

### 31. 最基础的对话调用：ChatModel / StreamingChatModel 怎么用？
**重要度**：★★★★
不依赖 AiServices 时，可直接用模型接口：
```java
ChatModel model = OpenAiChatModel.builder().apiKey(...).modelName("qwen-plus").build();
String ans = model.chat("什么是CBAM？");
// 流式
StreamingChatModel sm = OpenAiStreamingChatModel.builder()...build();
sm.chat("问题", new StreamingChatResponseHandler() { /* onPartialResponse / onCompleteResponse */ });
```
- `ChatModel.chat(String)` 同步返回 `String`，`chat(List<ChatMessage>)` 返回 `ChatResponse`；`StreamingChatModel.chat(msg, handler)` 走 `StreamingChatResponseHandler` 回调逐字输出（1.x 里 `ChatModel` 本身也有流式 `chat(req, handler)`）。
- AiServices 本质是对这两个接口的声明式封装。


#### 三种框架实现对比

##### Spring AI 1.0 实现

```java
// Spring AI 里对应的是 ChatModel（无状态）+ ChatClient（带记忆/RAG 的门面）
@Service
public class BasicChatService {

    private final ChatModel chatModel;
    private final ChatClient chatClient;

    public BasicChatService(ChatModel chatModel) {
        this.chatModel = chatModel;
        this.chatClient = ChatClient.create(chatModel);
    }

    // 同步：直接调 ChatModel，返回 ChatResponse（含 token 用量）
    public ChatResponse syncAsk(String question) {
        return chatModel.call(new Prompt(new UserMessage(question)));
    }

    // 同步简化版：ChatClient 一步拿到字符串
    public String syncAskText(String question) {
        return chatClient.prompt().user(question).call().content();
    }

    // 流式：返回 Flux<String>，每来一个增量就推给前端
    public Flux<String> streamAsk(String question) {
        return chatClient.prompt()
                .user(question)
                .stream()
                .content();          // 每 chunk 就是一个增量文本
    }
}
```

##### Spring AI 2.0 实现

```java
// 2.0 差异：ChatModel.call(Prompt) 仍可用，但工具不再自动执行；
//          要工具必须走 ChatClient（由 ToolCallingAdvisor 驱动循环）
@Service
public class BasicChatService {

    private final ChatModel chatModel;
    private final ChatClient chatClient;

    public BasicChatService(ChatModel chatModel) {
        this.chatModel = chatModel;
        this.chatClient = ChatClient.create(chatModel);
    }

    // 同步：ChatModel.call 不会自动执行工具，只做一次模型调用
    public ChatResponse syncAsk(String question) {
        return chatModel.call(new Prompt(new UserMessage(question)));
    }

    public String syncAskText(String question) {
        return chatClient.prompt()
                .user(question)
                .options(OpenAiChatOptions.builder().temperature(0.7))  // 2.0：options 传 builder
                .call()
                .content();
    }

    // 流式：Flux<String> 逐块推送，前端直接渲染打字机效果
    public Flux<String> streamAsk(String question) {
        return chatClient.prompt()
                .user(question)
                .stream()
                .content();
    }
}
```

##### LangChain4j 实现

```java
// LangChain4j 1.0 GA：ChatLanguageModel 已更名为 ChatModel，
// StreamingChatLanguageModel 已更名为 StreamingChatModel
public class BasicChatDemo {

    void sync() {
        ChatModel model = OpenAiChatModel.builder()
                .baseUrl("https://dashscope.aliyuncs.com/compatible-mode")
                .apiKey(System.getenv("DASHSCOPE_API_KEY"))
                .modelName("qwen-plus")
                .temperature(0.7)
                .maxTokens(1024)
                .build();

        // 简答：只返回文本
        String ans = model.chat("什么是CBAM？");

        // 要 token 用量必须用返回 ChatResponse 的重载
        ChatResponse resp = model.chat(List.of(
                SystemMessage.from("你是碳管理专家"),
                UserMessage.from("什么是CBAM？")));
        System.out.println(resp.tokenUsage());   // input / output token 计数
    }

    void stream() {
        StreamingChatModel sm = OpenAiStreamingChatModel.builder()
                .baseUrl("https://dashscope.aliyuncs.com/compatible-mode")
                .apiKey(System.getenv("DASHSCOPE_API_KEY"))
                .modelName("qwen-plus")
                .build();
        sm.chat("什么是CBAM？", new StreamingChatResponseHandler() {
            @Override public void onPartialResponse(String token) { /* 推 SSE */ }
            @Override public void onCompleteResponse(ChatResponse r) { /* 收尾 */ }
            @Override public void onError(Throwable t) { /* 兜底 */ }
        });
    }
}
```

#### 追问：
- 追问1：直接 new OpenAiChatModel 和用 AiServices 注入，在生产里哪个更常用？为什么？
  - **答**：生产更常用 AiServices 声明式注入（或 Spring Boot starter 自动装配的 Bean），直接 new 只适合 demo 或需精细控制构造参数的场景。
    - AiServices 用 @SystemMessage/@V/@MemoryId 等注解统一编排提示词、记忆、工具，减少样板代码。
    - starter 把 ChatModel 配成单例 Bean，由容器统一管生命周期、配置与可观测性。
    - 直接 new 适合测试、PoC 或要按租户动态切换 apiKey/modelName（如路由通义千问不同模型）时手动构建。
- 追问2：model.chat 返回 String 还是 ChatResponse？想要 token 用量该取哪个？
  - **答**：取决于重载。`chat(String)` 返回 String，拿 token 用量必须用返回 `ChatResponse` 的重载。
    - `chat(String)` 只返回文本，拿不到用量元数据。
    - `chat(List<ChatMessage>)` / `chat(ChatRequest)` 返回 `ChatResponse`，`response.tokenUsage()` 含 input/output token 计数。
    - 碳管家 RAG 链统一走 `ChatResponse`，把 token 用量上报 Prometheus 做成本监控。

### 32. Message 体系：UserMessage / AiMessage / SystemMessage 怎么构建？
**重要度**：★★★★
```java
UserMessage um = UserMessage.from("什么是CBAM？");
SystemMessage sm = SystemMessage.from("你是碳管理专家");
ChatResponse r = model.chat(sm, um);
AiMessage ai = r.aiMessage(); // 模型回复
```
- `UserMessage.from(...)` / `SystemMessage.from(...)` 是便捷工厂；多模态用 `UserMessage.from(List<Content>)`。
- `AiMessage` 是模型输出，多轮对话要把它原样回传以延续上下文。

#### 追问：
- 追问1：多轮对话是自己手动维护 List<ChatMessage> 然后每次 chat(system, history..., user) 吗？
  - **答**：可以手动维护，但生产更推荐交给 ChatMemory（如 MessageWindowChatMemory），由它维护并回传历史。
    - 手动维护需自己把 SystemMessage+历史拼成 List 再 chat，容易漏掉上轮 AiMessage 丢上下文。
    - AiServices 注入 chatMemory 后框架每轮自动读写记忆，@MemoryId 做会话隔离。
    - 碳管家用 MessageWindowChatMemory 限窗口（如窗口 10 条），超窗自动丢最旧消息控 token。
- 追问2：UserMessage.from 和 new UserMessage(text) 有区别吗？图片怎么作为 Content 加进去？
  - **答**：语义等价，from 是静态工厂、new 是直接构造；图片/多模态需走 Content 列表形式。
    - UserMessage.from(text) 内部即 new UserMessage(text)，选一种风格统一即可。
    - 多模态用 UserMessage.from(List<Content>)，图片用 ImageContent.from(InputStream, mimeType)。
    - 文本+图片组合时顺序即传给模型的 Content 顺序，需保证 TextContent 在前描述任务。

### 33. AiServices 声明式用法（代码级）：接口 + 注解怎么写？
**重要度**：★★★★
```java
interface CarbonAssistant {
  @SystemMessage("你是碳管理专家，用{{language}}回答")
  String answer(@V("language") String lang, String question);
}
CarbonAssistant assistant = AiServices.create(CarbonAssistant.class, model);
String r = assistant.answer("zh", "什么是CBAM？");
```
- `@SystemMessage`/`@UserMessage` 描述模板；`@V("x")` 绑定方法参数到模板变量。
- `@MemoryId` 标记会话隔离参数，配合 `ChatMemory` 实现多用户。


#### 三种框架实现对比

##### Spring AI 1.0 实现

```java
// Spring AI 没有"接口 + 注解"的声明式 AI 服务，对应能力是 ChatClient 链式 API
// 若要追求类似声明式体验，可自建薄封装接口
public interface CarbonAssistant {

    // 内部委托给 ChatClient，等价于 LC4j 的 @SystemMessage + @UserMessage 组合
    String answer(String language, String question);
}

@Service
public class CarbonAssistantImpl implements CarbonAssistant {

    private final ChatClient chatClient;

    public CarbonAssistantImpl(ChatModel chatModel) {
        this.chatClient = ChatClient.create(chatModel);
    }

    @Override
    public String answer(String language, String question) {
        // Spring AI 变量占位符是 {var}（单花括号），与 LC4j 的 {{var}} 不同
        return chatClient.prompt()
                .system("你是碳管理专家，用{language}回答。")
                .user(u -> u.text("{question}").param("language", language)
                                                 .param("question", question))
                .call()
                .content();
    }
}
```

##### Spring AI 2.0 实现

```java
// 2.0 差异：占位符语法不变，仍是 {var}；options 传 builder
public interface CarbonAssistant {
    String answer(String language, String question);
}

@Service
public class CarbonAssistantImpl implements CarbonAssistant {

    private final ChatClient chatClient;

    public CarbonAssistantImpl(ChatModel chatModel) {
        this.chatClient = ChatClient.create(chatModel);
    }

    @Override
    public String answer(String language, String question) {
        return chatClient.prompt()
                .system("你是碳管理专家，用{language}回答。")
                .user(u -> u.text("{question}")
                        .param("language", language)
                        .param("question", question))
                .options(OpenAiChatOptions.builder().temperature(0.3))
                .call()
                .content();
    }

    // 需要流式时返回 Flux<String>，前端推 SSE 实现打字机
    public Flux<String> streamAnswer(String question) {
        return chatClient.prompt()
                .user(question)
                .stream()
                .content();
    }
}
```

##### LangChain4j 实现

```java
// LangChain4j 声明式：接口 + @SystemMessage / @UserMessage / @V / @MemoryId 注解
public interface CarbonAssistant {

    // {{language}} 由 @V("language") 绑定的参数填充
    @SystemMessage("你是碳管理专家，用{{language}}回答")
    String answer(@V("language") String language,
                  @UserMessage("{{question}}") String question);

    // 多轮会话：@MemoryId 标记会话隔离参数，配合 ChatMemory 实现
    @SystemMessage("你是碳管理专家，回答需引用来源")
    String chat(@MemoryId String sessionId, @UserMessage("{{it}}") String question);
}

// 构建：注意 AiServices 本身没有 chat 方法，chat 是我们接口自己声明的方法
public class CarbonAssistantFactory {

    public CarbonAssistant create(ChatModel model, ChatMemoryProvider memoryProvider) {
        return AiServices.builder(CarbonAssistant.class)
                .chatModel(model)
                .chatMemoryProvider(memoryProvider)
                .build();
    }
}
```

#### 追问：
- 追问1：@SystemMessage 里 {{language}} 和 Spring AI 的 {language} 占位符语法不同，混用两个框架会搞混吗？
  - **答**：会搞混，两套占位符语法完全不同，同项目同时用两框架必须各自遵守、不要交叉。
    - LangChain4j 用 {{var}} 配合 @V("var") 绑定方法参数；Spring AI 用 {var} 配合 PromptTemplate。
    - 碳管家主链路用 LangChain4j，Spring AI 仅对比学习，避免同一提示词混写两套占位符。
    - 建议统一封装提示词常量与变量绑定工具，避免手写占位符串味。
- 追问2：AiServices 接口方法返回 String 还是 AiMessage？要流式返回怎么声明？
  - **答**：默认可返回 String（自动取 AiMessage 文本），也可返回 `AiMessage` / `ChatResponse`；流式需返回 `TokenStream`。
    - 返回 String 最简洁但丢 token 用量与元数据。
    - 要流式打字机效果，接口方法声明返回 TokenStream，调用处用 .onPartialResponse/.onCompleteResponse 订阅。
    - 碳管家问答前端用 TokenStream 推 SSE，保证用户实时看到生成过程。

### 34. AiServices 的 @Tool / @Moderate 注解怎么写？
**重要度**：★★★★
```java
class FactorTools {
  @Tool("查询产品碳排放因子")
  String lookup(@P("product") String product) { return svc.lookup(product); }
}
AiServices.builder(Assistant.class)   // 注意别写成 AiServices.create(...)：create 直接返回接口实例，没有 tools()/build()
    .chatModel(model)
    .tools(new FactorTools())
    .build();
```
- `@Tool` 方法暴露给模型，模型自决调用，参数回传执行后结果再喂回生成。
- `@Moderate` 在输入输出两端接内容审核，命中即拦截。

#### 追问：
- 追问1：@Tool 方法里查库超时，框架会把异常抛给模型还是吞掉？怎么自定义失败回退？
  - **答**：默认是**抛**——工具方法抛出的异常被框架包成 `ToolExecutionException` 抛出，整轮调用中断，模型拿不到任何"工具失败"的上下文。若想让模型看到错误自己纠正，1.x 可以配置 `ToolExecutionErrorHandler`：在里面返回一条 `ToolExecutionResultMessage`（内容写成"查询超时，请稍后重试"）而不是抛异常，模型就会把它当工具结果继续推理。
    - 最省事也最稳的做法还是在工具方法内 try-catch，超时时返回自然语言的失败说明，模型据此调整策略。
    - 碳管家 FactorTools 查积木 LCA 云/因子库时用 Resilience4j 设超时与重试，防卡死。
    - 不建议把原始堆栈直接暴露给模型，既浪费调用又可能泄漏内部实现细节。
- 追问2：@Moderate 审核的是模型输入还是输出？用户提问含敏感词会被拦在哪儿？
  - **答**：@Moderate 默认在输入和输出两端都接内容审核，用户提问含敏感词会在进入模型前被拦下。
    - 输入侧审核命中直接拦截不调用模型，返回既定拒绝话术。
    - 输出侧审核命中会阻止有害回复展示给用户。
    - 碳管家除框架审核外，网关层还用自建敏感词/合规规则先过滤碳数据相关越权查询。

### 35. EmbeddingStore + EmbeddingModel 最小闭环（不经 RAG 管线）？
**重要度**：★★★★
```java
EmbeddingModel emb = new AllMiniLmL6V2EmbeddingModel();   // 需引 langchain4j-embeddings-all-minilm-l6-v2（不在 core）
EmbeddingStore store = new InMemoryEmbeddingStore<>();
store.add(emb.embed("CBAM 范围三核算要点").content());
List<EmbeddingMatch> hits = store.findRelevant(emb.embed(q).content(), 5);   // 方法是 findRelevant（或 search）
```
- `embed(text).content()` 得向量；`store.add(...)` 存入；`store.findRelevant(vector, k)` 取最相似。
- 这是 RAG 的底层最小闭环，理解它才能读懂上层 RetrievalAugmentor。

#### 追问：
- 追问1：InMemoryEmbeddingStore 生产不能用，换 Milvus 时 add/findRelevant API 一样吗？
  - **答**：API 形态一致，MilvusEmbeddingStore 实现同一 EmbeddingStore 接口，业务代码基本无感切换。
    - 两者都实现 EmbeddingStore 接口，add(Embedding, TextSegment) 与 findRelevant(Embedding, k) 签名不变。
    - 切换只需把 InMemoryEmbeddingStore Bean 换成 MilvusEmbeddingStore（配 collection、uri）。
    - 碳管家生产用 Milvus 存因子文档与法规片段向量，支撑亿级向量与高性能检索。
- 追问2：embed 一段长文本超模型 token 上限会报错，这里要自己先切分吗？
  - **答**：要，EmbeddingModel 只负责单段向量化，超长文本必须在 embed 前用 Splitter 切成合规片段。
    - 先用 `DocumentSplitters.recursive(maxChars, overlap)` 按字符上限切（LangChain4j 没有 `RecursiveCharacterSplitter` 这个类，递归切分是工厂方法），需要按 token 切时用三参重载传 `TokenCountEstimator`，再逐段 embed。
    - 碳管家入库按 maxSegSize 控每段上限并留 overlap，避免切断语义。
    - 切分后 add 到 Milvus，检索以片段为单位返回再拼进上下文。

### 36. 检索装配：ContentRetriever / RetrievalAugmentor 怎么拼 RAG 链？
**重要度**：★★★★
```java
EmbeddingStoreContentRetriever retriever = EmbeddingStoreContentRetriever.builder()
    .embeddingStore(store).embeddingModel(emb).maxResults(5).minScore(0.75).build();
RetrievalAugmentor augmentor = DefaultRetrievalAugmentor.builder()
    .queryTransformer(new CompressingQueryTransformer(chatModel))  // 参数是 ChatModel：用 LLM 把"它怎么算"压成独立问题
    .contentRetriever(retriever).build();
```
- `CompressingQueryTransformer` 解决多轮指代消解（"它"→"碳足迹"），代价是每轮多一次 LLM 调用，对延迟敏感的场景要慎用。
- `ContentRetriever` 负责"取回相关片段"；`RetrievalAugmentor` 编排 查询改写 → 路由 → 检索 → 聚合。
- 与 Spring AI 的 RetrievalAugmentationAdvisor 定位类似，只是 API 形态不同。

#### 追问：
- 追问1：DefaultRetrievalAugmentor 里 QueryRouter 是做什么的？单库场景还需要吗？
  - **答**：QueryRouter 把查询路由到多个 ContentRetriever 中的一个或多个；单库场景可省略或只用默认路由。
    - 多源场景（因子库+法规库+报告库）用 Router 按语义选库提升召回精度。
    - 单库直接配一个 ContentRetriever 即可，框架默认路由到唯一 retriever。
    - 碳管家因子与法规划两 collection，用路由按问题类型分流避免噪声。
- 追问2：minScore 和 Spring AI 的 similarityThreshold 是一个意思吗？阈值调错会怎样？
  - **答**：语义一致都是相似度下限过滤，但分属不同框架参数名；阈值过高召回过少、过低引入噪声。
    - LangChain4j 用 minScore，Spring AI 用 similarityThreshold，都过滤低于阈值的片段。
    - 阈值定太高（如 0.9）易误杀相关法规条款，定太低（如 0.3）混入无关内容误导模型。
    - 我们按 Milvus 距离类型离线评估，选 0.75 左右平衡点再灰度调优。

### 37. Splitter 具体类用法：构造参数与选型？
**重要度**：★★★
- `DocumentByParagraphSplitter(maxSeg, overlap)`：按段落，保段落完整。
- `DocumentBySentenceSplitter(maxSeg, overlap)`：按句子，粒度更细。
- `DocumentByRegexSplitter(pattern, maxSeg, overlap)`：按正则（如`\n\d+\.`）切，适合带编号条款。
- `DocumentSplitters.recursive(maxSeg, overlap)`：通用默认（工厂方法，不是类名），内部按分隔符逐级回退。


#### 三种框架实现对比

##### Spring AI 1.0 实现

```java
// Spring AI 侧对应 TextSplitter（接口）+ TokenTextSplitter / SentenceSplitter 等实现
@Configuration
public class SplitterConfig {

    // 通用默认：按 token 切，与模型上下文对齐（推荐）
    @Bean
    TextSplitter tokenSplitter() {
        return new TokenTextSplitter(300, 0, 5000, 1000, true);
        //                maxChunkSize, minChunkSize, maxChunkChars, minChunkChars, keepSeparator
    }

    // 句子切分：保证条款不被截断，适合中文法规
    @Bean
    TextSplitter sentenceSplitter() {
        return new SentenceSplitter();
    }
}

// 使用：Document 切分后写入 VectorStore
@Service
public class IngestService {

    private final VectorStore vectorStore;
    private final TokenTextSplitter splitter;

    public IngestService(VectorStore vectorStore, TokenTextSplitter splitter) {
        this.vectorStore = vectorStore;
        this.splitter = splitter;
    }

    public void ingest(String rawText) {
        List<Document> chunks = splitter.split(new Document(rawText));
        // chunk 边界建议保留 metadata（如章节号），便于回溯引用
        vectorStore.add(chunks);
    }
}
```

##### Spring AI 2.0 实现

```java
// 2.0 侧切分 API 与 1.0 一致：TextSplitter 接口 + TokenTextSplitter / SentenceSplitter
@Configuration
public class SplitterConfig {

    // 通用默认：TokenTextSplitter，参数含义与 1.0 相同
    @Bean
    TextSplitter tokenSplitter() {
        return new TokenTextSplitter(300, 0, 5000, 1000, true);
    }

    // 结构感知：自定义实现按章节标题切 GB/T 标准
    @Bean
    TextSplitter regulationSplitter() {
        return new TextSplitter() {
            @Override
            public List<Document> split(Document document) {
                // 真实实现里按"章节标题行"正则切分，保证条款不被拆散
                return List.of(document);
            }
        };
    }
}

// 使用：VectorStore.add(List<Document>) 灌库
@Service
public class IngestService {

    private final VectorStore vectorStore;
    private final TextSplitter splitter;

    public IngestService(VectorStore vectorStore, TextSplitter splitter) {
        this.vectorStore = vectorStore;
        this.splitter = splitter;
    }

    public void ingest(String rawText) {
        List<Document> chunks = splitter.split(new Document(rawText));
        vectorStore.add(chunks);
    }
}
```

##### LangChain4j 实现

```java
// LangChain4j：DocumentSplitter 是接口，具体实现都在 dev.langchain4j.data.document.splitter 包
public class SplitterSelection {

    void select() {
        // 通用默认：递归切分——先按段落，段落太长再按行/句子/词/字符逐级回退
        DocumentSplitter recursive = DocumentSplitters.recursive(300, 0);
        //                     maxSegmentSizeInChars, maxOverlapSizeInChars

        // 按段落：保段落完整，超长段落会交给默认子切分器二次切
        DocumentSplitter byParagraph = new DocumentByParagraphSplitter(300, 100);

        // 按句子：粒度更细，中文法规倾向这个
        DocumentSplitter bySentence = new DocumentBySentenceSplitter(300, 50);

        // 按正则：切带编号的条款，正则用"章节标题行"而不是单独句点，
        //         避免把 "1.1 范围" 里的点误判为句末
        DocumentSplitter byRegex = new DocumentByRegexSplitter(
                "(?m)^\\s*\\d+(\\.\\d+)*\\s+.*$",   // 匹配条款起始行
                "",                                 // joinDelimiter
                800, 100);                          // maxSegmentSizeInChars, maxOverlapSizeInChars

        // 按字符：最粗粒度的硬切
        DocumentSplitter byCharacter = new DocumentByCharacterSplitter(500, 50);
    }

    // 灌库：Splitter 决定切分，EmbeddingStoreIngestor 负责切分+向量化+入库
    void ingest(List<Document> docs, EmbeddingStore<TextSegment> store, EmbeddingModel model) {
        EmbeddingStoreIngestor.builder()
                .documentSplitter(DocumentSplitters.recursive(300, 0))
                .embeddingModel(model)
                .embeddingStore(store)
                .build()
                .ingest(docs);
    }
}
```

#### 追问：
- 追问1：DocumentByParagraphSplitter 的 maxSegSize 是按字符还是 token？超长段落会被强行切断吗？
  - **答**：默认按字符数（非 token）；超长段落会按 maxSegSize 强行切断，必要时配 overlap 保留上下文。
    - maxSegSize 是字符上限，长段落会被拆成多段，可能切断完整句子/条款。
    - 设 overlap（如 100 字符）让相邻段有重叠，减少语义割裂。
    - 碳管家对中文法规倾向用按句子或递归切分，降低硬切断的语义损失。
- 追问2：带编号法规用 DocumentByRegexSplitter 切，正则怎么写才能不把"1.1"当成句子边界？
  - **答**：用"句末标点+换行/段落"而非单纯句点作边界，避免把 1.1 编号里的点误判为句号。
    - 边界正则匹配 "。\n" 或"章节标题行"之类，而不是单独 "."。
    - 对 "1.1 范围" 这类编号可用正向预查 (?<=。)\n 或按章节标题切。
    - 碳管家处理 GB/T 标准时按"章节标题行"正则切，保证条款不被拆散。

### 38. DocumentLoader 怎么加载不同来源？
**重要度**：★★★
- `FileSystemDocumentLoader.loadDocument(Path)` 单个文件 / `loadDocuments(Path)` 整个目录 / `loadDocuments(Path, "**/*.pdf")` 带 glob 过滤：本地文件；默认用自带解析器，也可显式传 `ApachePdfBoxDocumentParser` 等。
- `ClassPathDocumentLoader.loadDocument("docs/iso14064.pdf")` / `loadDocuments("docs")`：resources 内资源。
- `UrlDocumentLoader.load(url, new ApacheTikaDocumentParser())`：远程网页/文件（必须传 parser）。
- 解析器是独立 artifact，且要按格式选：PDF 用 `langchain4j-document-parser-apache-pdfbox`，Office（doc/docx/xls/pptx）用 `langchain4j-document-parser-apache-poi`（POI 解析不了 PDF），多格式通用用 `langchain4j-document-parser-apache-tika`。

#### 追问：
- 追问1：ClassPathDocumentLoader 加载 resources 下的法规 PDF，打包后路径还在吗？Spring Boot fat-jar 要注意什么？
  - **答**：路径常量仍在，但 fat-jar 内资源非真实文件系统路径，必须用流读取而非 File 路径。
    - 不能用 new File("classpath:...")，fat-jar 资源在 BOOT-INF/classes，需 InputStream 读取。
    - DocumentLoader 内部走类加载器取流正常可用；自写解析要同样用流。
    - 大 PDF 建议放对象存储/NAS 用 FileSystemDocumentLoader 加载，避免包体膨胀。
- 追问2：UrlDocumentLoader 抓网页，要不要处理编码/反爬/超时？生产里你们用它被取代了吗？
  - **答**：必须处理编码、超时与反爬；生产我们改用离线抓取+定时入库，不依赖运行时实时抓。
    - 编码错会乱码，需读 Content-Type 或默认 UTF-8；设连接/读取超时防挂起。
    - 反爬需带 UA/代理，稳定性差，不适合线上实时问答。
    - 碳管家法规库由离线任务抓取公开法规源并切分，经业务员确认后录入 Milvus，线上只查库不现抓。

### 39. 流式响应（代码级）：StreamingChatResponseHandler 怎么实现打字机？
**重要度**：★★★★
```java
sm.chat("问题", new StreamingChatResponseHandler() {
  public void onPartialResponse(String token) { /* 推 SSE */ }
  public void onCompleteResponse(ChatResponse r) { /* 结束 */ }
  public void onError(Throwable t) { /* 错误处理 */ }
});
```
- `onPartialResponse` 每收到一个片段就推给前端；`onCompleteResponse` 收尾；`onError` 兜底异常（0.x 的 `StreamingResponseHandler` + `onNext`/`onComplete` 已废弃）。


#### 三种框架实现对比

##### Spring AI 1.0 实现

```java
// Spring AI 流式：Flux<String> 逐块返回，Controller 直接返回即 SSE
@RestController
public class ChatController {

    private final ChatClient chatClient;

    public ChatController(ChatModel chatModel) {
        this.chatClient = ChatClient.create(chatModel);
    }

    @GetMapping(value = "/chat/stream", produces = MediaType.TEXT_EVENT_STREAM_VALUE)
    public Flux<String> stream(@RequestParam String sessionId,
                                @RequestParam String question) {
        return chatClient.prompt()
                .user(question)
                .advisors(a -> a.param(ChatMemory.CONVERSATION_ID, sessionId))
                .stream()
                .content();   // 每个元素是一段增量文本，前端直接 append
    }
}
```

##### Spring AI 2.0 实现

```java
// 2.0 差异：流式同样走 Flux<String>；注意与工具循环共存时
//          ToolCallingAdvisor 会先完成工具调用再开始流式输出
@RestController
public class ChatController {

    private final ChatClient chatClient;

    public ChatController(ChatModel chatModel) {
        this.chatClient = ChatClient.create(chatModel);
    }

    @GetMapping(value = "/chat/stream", produces = MediaType.TEXT_EVENT_STREAM_VALUE)
    public Flux<String> stream(@RequestParam String sessionId,
                                @RequestParam String question) {
        return chatClient.prompt()
                .user(question)
                .advisors(a -> a.param(ChatMemory.CONVERSATION_ID, sessionId))
                .options(OpenAiChatOptions.builder().temperature(0.7))
                .stream()
                .content();
    }

    // 需要更细粒度控制时用 chatResponse()，拿到每块的完整 ChatResponse
    public Flux<ChatResponse> streamDetailed(String question) {
        return chatClient.prompt()
                .user(question)
                .stream()
                .chatResponse();
    }
}
```

##### LangChain4j 实现

```java
// LangChain4j 1.0 GA：StreamingChatModel + StreamingChatResponseHandler
// （onPartialResponse / onCompleteResponse / onError）
public class StreamingChatDemo {

    void stream(StreamingChatModel sm, SseEmitter emitter) {
        sm.chat("什么是CBAM？", new StreamingChatResponseHandler() {
            @Override
            public void onPartialResponse(String token) {
                // token 是模型输出的增量片段（非严格单 token），直接推给前端
                emitter.send(SseEmitter.event().data(token));
            }

            @Override
            public void onCompleteResponse(ChatResponse response) {
                // 收尾：拿到完整回答与 token 用量，可在此落库做对话记忆
                emitter.send(SseEmitter.event().name("done")
                        .data(response.aiMessage().text()));
                emitter.complete();
            }

            @Override
            public void onError(Throwable error) {
                // 已推送的片段无法撤回，追加一个 error 事件让前端收尾
                emitter.send(SseEmitter.event().name("error").data(error.getMessage()));
                emitter.complete();
            }
        });
    }

    // AiServices 侧流式：接口方法返回 TokenStream，用 onPartialResponse 订阅
    public interface StreamCarbonAssistant {
        TokenStream chat(@MemoryId String sessionId, @UserMessage("{{it}}") String question);
    }

    void streamViaAiServices(StreamCarbonAssistant assistant, String sessionId) {
        assistant.chat(sessionId, "什么是CBAM？")
                .onPartialResponse(chunk -> System.out.print(chunk))
                .onCompleteResponse(resp -> System.out.println("\n[done]"))
                .onError(err -> System.err.println("[err] " + err.getMessage()))
                .start();   // start() 才会真正触发流式调用
    }
}
```

#### 追问：
- 追问1：onPartialResponse 收到的已经是 String 还是 token 级？要不要自己做缓冲再发？
  - **答**：onPartialResponse 收到的是框架按模型输出切分的片段（近似 token 级子串），一般可直接转发，必要时按标点缓冲。
    - 通义千问流式返回是一段段文本，回调粒度由模型/SSE 决定，非严格单 token。
    - 前端打字机可直接每个片段推 SSE，体验已够顺滑。
    - 要按完整句展示可在回调里累积到句末标点再 emit，减少闪烁。
- 追问2：onCompleteResponse 里怎么把完整回答落库做对话记忆？
  - **答**：onCompleteResponse 拿到完整 `ChatResponse` 后，取 `aiMessage()` 写入 ChatMemory/持久化存储即可延续上下文。
    - 把完整文本包装成 AiMessage 调 chatMemory.add(aiMessage) 或存库。
    - 碳管家在 onCompleteResponse 同时落库审计日志（问题、回答、token）供追溯。
    - 失败/超时要保证记忆与日志一致，避免下一轮读到半截上下文。

### 40. 结构化输出（代码级）：AiServices 方法直接返回 POJO？
**重要度**：★★★★
```java
interface Assistant {
  @UserMessage("抽取报告字段：{{text}}")
  CarbonReport extract(String text);
}
CarbonReport r = AiServices.create(Assistant.class, model).extract(reportText);
```
- LangChain4j 自动把返回类型当成 JSON Schema 约束输出，并反序列化为 POJO，无需手动解析。

#### 追问：
- 追问1：模型返回的 JSON 字段比 POJO 多或少了，反序列化会报错吗？怎么容错？
  - **答**：字段多一般被忽略不报错，字段少了对应属性为 null；为容错 POJO 应给默认值并忽略未知字段。
    - Jackson 默认忽略未知字段（或加 @JsonIgnoreProperties(ignoreUnknown=true)）。
    - 必填字段缺失得 null，业务侧做空值校验与友好兜底。
    - 碳管家抽取报告字段时给合理默认值并做 schema 校验，避免脏数据入库。
- 追问2：POJO 嵌套（报告里有 List<Item>）能正确映射吗？字段名和中英命名怎么对齐？
  - **答**：能，Jackson 支持嵌套对象与集合；中英命名用 @JsonProperty 显式映射模型输出的 key。
    - 嵌套 List<Item> 框架按 JSON 数组递归反序列化，无需额外配置。
    - 模型常输出英文 key，POJO 用 @JsonProperty("carbon_value") 对齐，保持代码中文语义。
    - 复杂嵌套建议先让模型输出 schema 示例校验，再固定 POJO 结构。

### 41. Spring Boot 集成与配置：application.properties 怎么配？
**重要度**：★★★
```properties
langchain4j.open-ai.chat-model.api-key=${AK}
langchain4j.open-ai.chat-model.model-name=qwen-plus
```
- 引入 `langchain4j-spring-boot-starter` 后，配置即自动装配 `ChatModel` 等 Bean，`@Autowired` 直接用。

#### 追问：
- 追问1：同时配了 open-ai 和 qianfan 两个 starter，容器里有俩 ChatModel，注入怎么区分？
  - **答**：用 @Qualifier 按 Bean 名区分，或只启用一个 autoconfiguration 避免歧义。
    - 两个 starter 各自生成 ChatModel Bean，@Autowired 会报 NoUniqueBeanDefinitionException。
    - 用 @Qualifier("openAiChatModel") 之类指定，或在不需要的 starter 上 exclude 自动配置。
    - 碳管家只用通义千问（open-ai 兼容协议），不会同时引入多厂商。
- 追问2：api-key 放 application.properties 明文不安全，你们怎么接配置中心/密钥管理？
  - **答**：密钥不放文件，走配置中心/环境变量/密钥管理服务注入，运行时从 Vault/配置中心拉取。
    - 用 Nacos/Apollo 配置中心下发，或 K8s Secret 注入环境变量 ${AK}。
    - 密钥轮转在配置中心改值并热更新，不重新打包。
    - 碳管家密钥经配置中心下发并限定 Pod 环境变量访问，避免落盘明文。

### 42. 多模态输入：ImageContent 怎么传图片？
**重要度**：★★★
```java
UserMessage msg = UserMessage.from(
  TextContent.from("解读这张碳排放报表"),                          // 指令在前
  ImageContent.from(new FileInputStream("report.png"), "image/png"));  // 素材在后
```
- 文本 + 图片作为一条 `UserMessage` 的 `Content` 列表传给多模态模型；顺序按"先文本后图片"（多数 VLM 对 image-first 支持较差，且指令在前更利于对齐）。

#### 追问：
- 追问1：图片以 InputStream 传入，框架会自动转 base64 吗？大图要不要先压缩？
  - **答**：框架会把图片内容编码成 base64 随请求发送，大图建议先压缩/缩放避免超限与高延迟。
    - ImageContent.from(InputStream, mimeType) 读字节随请求体上传，非磁盘路径。
    - 超大图显著增加 token/请求体，先缩到模型可接受分辨率（如长边 2048）。
    - 碳管家解析报表截图前用 Thumbnailator 压缩，控体积与识别稳定性。
- 追问2：多模态模型返回的如果是指出图中某处，怎么把坐标/区域回显到前端？
  - **答**：让模型以结构化(JSON)输出边界框坐标，前端按归一化坐标在图上叠加高亮框。
    - 提示词要求模型返回 {"box":[x,y,w,h]} 等坐标字段，用结构化输出解析。
    - 坐标用归一化(0~1)表示，前端按图片实际尺寸换算叠加。
    - 碳管家若做报表圈注会用此 JSON 坐标回显，避免纯文本描述位置。

### 43. 记忆持久化：JdbcChatMemoryStore / RedisChatMemoryStore 怎么接？
**重要度**：★★★★
```java
// 注意：JdbcChatMemoryStore / RedisChatMemoryStore 都在社区模块
// （langchain4j-community-jdbc / langchain4j-community-redis），不在核心包里，需单独引依赖
ChatMemory memory = MessageWindowChatMemory.builder()
    .chatMemoryStore(new JdbcChatMemoryStore(dataSource))
    .maxMessages(10).build();
AiServices.builder(Assistant.class)
    .chatModel(model)
    .chatMemory(memory)
    .build();
```
- 默认 `InMemoryChatMemoryStore`，只在单实例内存里，重启即丢；生产换 JDBC/Redis 持久化（二者均为社区模块）。
- `@MemoryId` 参数让不同会话读写各自记忆，实现多用户隔离。

#### 追问：
- 追问1：MessageWindowChatMemory 的窗口只留 10 条，重要背景被挤出后回答变差，怎么保留摘要？
  - **答**：在窗口外增加"摘要记忆"：定期把被挤出的重要上下文压缩成摘要，作为 SystemMessage 注入。
    - 用两级记忆：近期原始消息走窗口，早期历史先经模型摘要后常驻。
    - 碳管家把本次会话的产品/核算边界等关键信息摘要进系统提示，防止遗忘。
    - 也可在切窗时触发一次摘要生成任务维护长期上下文。
- 追问2：RedisChatMemoryStore 在集群部署下，同一会话并发发两条消息会串号吗？
  - **答**：会，并发写同一会话记忆存在竞态，需对会话加锁或串行化写入避免交错。
    - 两条消息并发从 Redis 读同一记忆各写各的，后写覆盖前写导致丢消息。
    - 用 @MemoryId 维度的分布式锁（如 Redis SETNX）串行化同一会话读写。
    - 碳管家网关层对同一会话 user 做请求排队，保证记忆读写原子。

### 44. 单元测试：怎么用测试替身（mock）验证链路？
**重要度**：★★★
- 模型侧：用一个 `ChatModel` 的测试替身（mock）按顺序返回预设的 `AiMessage`，避免真实调用；这样 Prompt 组装、工具调用分支都能断言。
- 向量侧：用官方自带的 `InMemoryEmbeddingStore`（内存实现，结果确定）+ 固定输出的 EmbeddingModel 替身（返回常量向量）。
- 装配侧：`AiServices.create(Assistant.class, mockChatModel)` 把替身塞进去，跑完整链路。

#### 追问：
- 追问1：ChatModel 测试替身怎么模拟"模型决定调用工具"的行为来做工具链路测试？
  - **答**：让替身按顺序吐出两条 `AiMessage`：第一条带 `ToolExecutionRequest`（工具名 + 参数 JSON），逼框架走工具调用分支；第二条是拿到工具结果后的最终文本。本质是"用预设消息模拟一次工具调用指令"，不依赖真实模型推理。
    - 具体注入方式看版本：多数做法是构造 `ChatModel` 的 mock/测试实现，构造时传入这个 `AiMessage` 序列。
    - 断言框架确实调用了目标 @Tool 方法，且参数解析、结果回填的 `ToolExecutionResultMessage` 正确。
    - 碳管家用此验证 FactorTools 在 RAG 链里被正确触发与参数回传。
- 追问2：涉及真实 EmbeddingStore（Milvus）的集成测试太慢，CI 里怎么用内存实现替代？
  - **答**：CI 用 InMemoryEmbeddingStore 替代 Milvus，仅测链路逻辑，真实 Milvus 交互下沉到少量集成测试。
    - 通过配置/Profile 切换 EmbeddingStore Bean，test profile 注入内存实现。
    - 内存实现确定性高、启动快，覆盖切分→嵌入→检索→增强全链路。
    - 碳管家仅 nightly 集成测试连真实 Milvus，日常 PR 用 Fake/内存保速度。


---
