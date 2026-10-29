## 第三章：RAG（检索增强生成）


> 本章能力对应积木LCA云平台的 **Cortex 模块**（碳管家 AI 助手的 RAG 知识库问答）。架构总览见[第一章第1题《积木LCA云平台 · 系统架构总览》](/17-system-design.html#q-1-1)图 2。

### 1. 什么是RAG（检索增强生成）？它在企业级AI应用中的核心价值是什么？
**重要度**：★★★★★

**RAG（Retrieval-Augmented Generation，检索增强生成）**：在调用大模型生成回答之前，先从外部知识库中检索相关信息，将检索到的内容作为上下文（Context）拼入 Prompt，让大模型基于检索到的知识生成回答。

**核心价值**：

1. **知识时效性**：大模型训练数据有截止日期（GPT-4 原版截止 2021-09、GPT-4 Turbo 截止 2023-04，当前主流模型的知识截止仍滞后数月到一年），RAG 可检索最新碳法规，解决知识过时问题。
2. **领域专业性**：碳管理领域涉及大量 ISO 标准、行业碳排放因子等专业数据，大模型预训练知识不足，RAG 注入领域知识。
3. **数据隐私**：企业内部碳数据无需训练到模型中，通过 RAG 检索即可使用。
4. **可溯源**：每个回答可标注引用来源（如"依据 ISO 14067:2018 第5.3节"），增强可信度。
5. **降低成本**：无需微调模型，更新知识只需更新知识库索引。

**在碳管家助手中的价值**：碳法规频繁更新（如 CBAM 2023年发布、2026年全面实施），大模型预训练知识不包含最新法规。通过 RAG 检索最新法规文档，确保回答准确、时效。

#### 追问：
- 追问1：如果碳管家助手不做RAG而是直接微调模型，会丢失RAG的哪些不可替代的能力（如可溯源、知识时效）？
  - **答**：微调会把知识固化进权重，会丢失RAG的可溯源（无法标注具体标准条款）、知识时效（法规更新需重训）、数据隐私（数据需入训）与低成本更新能力；这些恰是碳管家助手选RAG的核心原因。
- 追问2：当Milvus检索返回的内容与通义千问已有的预训练知识冲突时，碳管家助手应优先信任哪一方，如何设计兜底策略？
  - **答**：口径统一为"分类型分流"：检索有明显冲突或相似度低时，以检索结果为准但显式标注来源与版本；检索为空/相似度低于阈值（<0.6）时不强行生成，返回"知识库暂无相关信息"并给出人工/官方原文路径；只有非关键的概念性问题才允许"标注式补充"模型常识（打上"非来自法规库"）。关键数值（排放因子）与法规条款一律拒答不猜，与第 2 题追问 2、第 27 题的阈值策略保持一致。


### 2. RAG系统的完整工作流程是怎样的？（标准6步）
**重要度**：★★★★★

**RAG 完整工作流程**：

#### 离线索引构建阶段

```
原始文档 → 文档解析 → 文本分块(Chunking) → 向量化(Embedding) → 存入向量库
```

**Step 1 - 文档解析**：使用 Apache POI 解析 Word/Excel，PDFBox 解析 PDF，提取纯文本。碳管家助手的知识库包含 ISO 14040/14044/14067 标准 PDF、GB/T 国标 Word 文档、碳排放因子 Excel 等。

**Step 2 - 文本分块（Chunking）**：

- 固定长度分块（如 500 token，重叠 50 token）。
- 语义分块（按段落/章节分块，保持语义完整）。
- 碳管家助手采用**语义分块 + 固定长度混合**：先按章节标题分块，超长章节再按段落切分。

**Step 3 - 向量化（Embedding）**：使用 Embedding 模型（bge-large-zh-v1.5）将文本块转为向量（如 1024 维）。

**Step 4 - 存入向量库**：将向量 + 原文 + 元数据（文档名、章节、页码）存入 Milvus。

#### 在线检索生成阶段

```
用户问题 → 向量化 → 向量检索(Top-K) → 重排(Re-ranking) → 组装Prompt → 大模型生成
```

**RAG 核心数据流图**（离线索引 vs 在线检索生成对照）：

![RAG核心数据流](./images/rag-dataflow.svg)

**Step 5 - 检索**：用户问题向量化后在 Milvus 中检索 Top-K（通常 K=5）最相似的文本块。

**Step 6 - 生成**：将检索结果 + System Prompt + 用户问题组装为完整 Prompt，调用大模型生成回答。

**Java 实现关键代码**（LangChain4j）：

```java
// 离线索引
EmbeddingStore<TextSegment> store = MilvusEmbeddingStore.builder()...build();
Document doc = FileSystemDocumentLoader.loadDocument("iso14067.pdf");
// 注意：LangChain4j 两参 recursive() 的单位是【字符】不是 token；
// 要按 token 切分得用三参重载（带 TokenCountEstimator）
DocumentSplitter splitter = DocumentSplitters.recursive(500, 50);
List<TextSegment> segments = splitter.split(doc);
// 1.x 的 embedAll 返回 Response<List<Embedding>>，不是 List<Embedding>
Response<List<Embedding>> response = embeddingModel.embedAll(segments);
store.addAll(segments, response.content());

// ① 先定义业务接口：AiServices 只是在【构建期】按接口生成代理，
//    运行时调用的是你自己声明的方法（AiServices 本身没有 chat 方法）
interface CarbonAssistant {
    @UserMessage("{{it}}")
    String chat(String userMessage);
}

// ② 构建：LangChain4j 1.x 用 chatMemoryProvider + contentRetriever
//    （RetrievalAugmentor / retrievalAugmentor 是 0.x 旧 API，已移除）
CarbonAssistant assistant = AiServices.builder(CarbonAssistant.class)
    .chatMemoryProvider(memoryProvider)                  // 会话记忆
    .contentRetriever(EmbeddingStoreContentRetriever.builder()
        .embeddingStore(store)
        .embeddingModel(embeddingModel)
        .maxResults(5)
        .build())                                         // RAG 检索增强
    .build();

// ③ 在线检索生成：调用自定义接口方法
String answer = assistant.chat(query);
```

#### 追问：
- 追问1：在碳管家助手的离线索引阶段，ISO 14067标准PDF里的公式和表格是如何被解析并保留语义的，会不会在分块时丢失关键符号？
  - **答**：用PDFBox提取时保留文本与表格结构，公式转LaTeX/图片OCR存为独立chunk并附元数据；分块以“章节+表格/公式”为单位整体保留，避免切断关键符号，必要时规则抽取排放因子等数值入结构化字段。
- 追问2：Step 5检索的Top-K与Step 6生成之间，如果检索结果相似度普遍偏低（如都小于0.6），流程应直接生成还是拒绝回答？
  - **答**：不直接硬生成。设置信度阈值截断（如<0.6返回“知识库暂无相关信息”），并触发补充检索（查询改写/知识图谱）；仍不足则拒答或给“部分信息”折中回答，而非强行编造。


### 3. 为什么要用向量数据库？
**重要度**：★★★★

**传统数据库的局限**：

- 关键词检索（LIKE/ElasticSearch）基于词形匹配，无法理解语义。如"碳排放因子"和"emission factor"是同一个概念但关键词不同。

**向量数据库的优势**：

1. **语义检索**：将文本转为向量后，通过向量相似度（余弦相似度）检索语义相近的内容，而非字面匹配。
2. **多语言支持（取决于 Embedding 模型）**：跨语言对齐依赖多语言 Embedding——bge-m3 这类模型能让"碳足迹"与"carbon footprint"在向量空间里靠近；本项目主选 bge-large-zh-v1.5 属纯中文模型，中文强、英文弱（CBAM 英文法规检索 Recall 明显下降），跨语言场景需换 bge-m3 或中英双模型双路召回（见第 18 题）。
3. **高效 ANN 检索**：支持百万级向量毫秒级近似最近邻检索（HNSW 索引）。
4. **元数据过滤**：可按文档类型、时间范围等条件过滤后再做向量检索。

#### 追问：
- 追问1：在"碳排放因子"和"emission factor"这类中英混合并存场景下，单路向量检索是否仍可能召回不到正确的因子库条目，如何验证？
  - **答**：可能召回不到。验证：构造中英对照测试集（如“碳排放因子”↔“emission factor”）算Recall@K；不足则引入混合检索（BM25/翻译增强）或领域Embedding提升跨语言召回。
- 追问2：碳管家助手同时有元数据过滤需求，Milvus的标量字段过滤在亿级向量下的性能开销是否会被向量检索掩盖？
  - **答**：Milvus标量过滤在亿级下若字段建了标量索引开销很小、通常被向量检索主导；无索引的过滤会先scan标量再算向量成为瓶颈。建议对常用过滤字段建索引，查询用预过滤+向量检索。


### 4. Spring AI中VectorStore作用是什么？
**重要度**：★★★★

**VectorStore**：Spring AI 对向量数据库的抽象接口，统一了不同向量库的访问方式。

**核心方法**：

```java
public interface VectorStore {
    void add(List<Document> documents);       // 添加文档
    void delete(List<String> idList);          // 删除文档
    List<Document> similaritySearch(SearchRequest request);  // 相似度检索
}
```

**作用**：

- 屏蔽底层向量库差异（Milvus/PGVector/Chroma/Pinecone 等），切换只需改配置。
- 与 Spring AI 的 DocumentReader、EmbeddingModel 无缝衔接。
- 支持过滤表达式（如按文档类型过滤）。

#### 追问：
- 追问1：如果碳管家助手未来从Milvus切换到PGVector，Spring AI的VectorStore抽象能让你不改业务代码完成迁移吗，哪些配置必须重写？
  - **答**：可基本不改业务代码（add/similaritySearch不动），仅替换配置与连接；必须重写：连接配置、collection/table映射、相似度函数（cosine）、元数据过滤语法（Milvus expr→PG JSONB）。
- 追问2：similaritySearch 本身能设相似度阈值，为什么还要在接口外再做一层置信度截断？动态阈值怎么定？
  - **答**：静态阈值只是第一道闸。`SearchRequest.builder().similarityThreshold(0.75).topK(5).build()` 能在库侧过滤掉低于 0.75 的召回，返回的 `Document` 也能用 `getScore()` 拿到分数；但阈值是全局固定的，而不同意图（法规条款 vs 因子数值）分数分布差异很大，固定值要么误杀要么漏放。所以外层还要按意图分档做二次截断（如法规类 0.7、闲聊类 0.5），并做空结果兜底：全部低于阈值时返回"未找到"，而不是把低分片段硬塞进 Prompt。


### 5. Spring AI如何实现RAG？
**重要度**：★★★★★

**Spring AI 实现 RAG 的两种方式**：

**方式一：手动编排**（灵活控制）

```java
// 1. 检索（Spring AI 1.0 中 SearchRequest 是 record，必须走 builder）
List<Document> docs = vectorStore.similaritySearch(
    SearchRequest.builder()
        .query(userQuery)
        .topK(5)
        .similarityThreshold(0.7)   // 置信度阈值过滤低质召回
        .build());
// 2. 自行拼接上下文
String context = docs.stream().map(Document::getText).collect(joining("\n"));
// 3. 调用大模型：检索结果必须拼进消息模板；
//    注意 1.0 的 .context() 已不接受 Document（那是 0.3.x 旧写法）
String answer = chatClient.prompt()
    .system(systemPrompt)
    .user(u -> u.text("{q}\n\n请仅依据以下参考资料回答：\n{ctx}")
                  .param("q", userQuery)
                  .param("ctx", context))
    .call()
    .content();
```

**方式二：RetrievalAugmentationAdvisor**（推荐）

```java
var ragAdvisor = RetrievalAugmentationAdvisor.builder()
    .queryTransformers(rewritingTransformer)
    .documentRetriever(VectorStoreDocumentRetriever.builder()
        .vectorStore(vectorStore)
        .topK(5)
        .build())
    .documentJoiner(sequentialJoiner)
    .queryAugmenter(contextualQueryAugmenter)
    .build();

String answer = chatClient.prompt()
    .user(userQuery)
    .advisors(ragAdvisor)
    .call()
    .content();
```


#### 三种框架实现对比

##### Spring AI 1.0 实现

```java
package com.carbon.guard.rag;

import org.springframework.ai.chat.client.ChatClient;
import org.springframework.ai.chat.client.advisor.vectorstore.QuestionAnswerAdvisor;
import org.springframework.ai.chat.model.ChatModel;
import org.springframework.ai.document.Document;
import org.springframework.ai.rag.advisor.RetrievalAugmentationAdvisor;
import org.springframework.ai.rag.generation.augmentation.ContextualQueryAugmenter;
import org.springframework.ai.rag.preretrieval.query.transformation.RewriteQueryTransformer;
import org.springframework.ai.rag.retrieval.search.VectorStoreDocumentRetriever;
import org.springframework.ai.vectorstore.SearchRequest;
import org.springframework.ai.vectorstore.VectorStore;

import java.util.List;
import java.util.stream.Collectors;

/**
 * 碳管家助手：Spring AI 1.0 实现 RAG。
 * 1.0 的 SearchRequest 是不可变类，必须走 builder()；不能 new。
 */
public class CarbonRagService {

    private final VectorStore vectorStore;   // Milvus，存放 ISO/GB 标准与法规分块
    private final ChatClient chatClient;

    public CarbonRagService(VectorStore vectorStore, ChatModel chatModel) {
        this.vectorStore = vectorStore;
        this.chatClient = ChatClient.create(chatModel);
    }

    /** 方式一：手动编排 —— 需要精细控制（过滤、重排、引用标注）时用这条 */
    public String askManual(String userQuery) {
        // 先按文档类型过滤再向量检索：filterExpression 支持 SQL 风格表达式，
        // 可移植到所有支持过滤的向量库，Milvus 会下推为标量过滤
        List<Document> docs = vectorStore.similaritySearch(
                SearchRequest.builder()
                        .query(userQuery)
                        .topK(5)
                        .similarityThreshold(0.7)
                        .filterExpression("docType == 'STANDARD'")
                        .build());

        // 1.0 的 .context() 已不接受 Document，必须自己把检索结果拼成字符串
        String context = docs.stream()
                .map(d -> "[来源: " + d.getMetadata().get("source") + "] " + d.getText())
                .collect(Collectors.joining("\n\n"));

        return chatClient.prompt()
                .system("你是碳管理专家助手。请仅依据<参考资料>回答；资料不足时明确说明。")
                .user(u -> u.text("<参考资料>\n{ctx}\n</参考资料>\n\n问题：{q}")
                        .param("q", userQuery)
                        .param("ctx", context))
                .call()
                .content();
    }

    /** 方式二：RetrievalAugmentationAdvisor —— 改写 + 检索 + 上下文增强一条链 */
    public String askWithAdvisor(String userQuery, ChatClient.Builder builder) {
        RetrievalAugmentationAdvisor ragAdvisor = RetrievalAugmentationAdvisor.builder()
                .queryTransformers(RewriteQueryTransformer.builder()
                        .chatClientBuilder(builder.build().mutate())
                        .build())
                .documentRetriever(VectorStoreDocumentRetriever.builder()
                        .vectorStore(vectorStore)
                        .topK(5)
                        .similarityThreshold(0.7)
                        .build())
                .queryAugmenter(ContextualQueryAugmenter.builder()
                        .allowEmptyContext(false)
                        .build())
                .build();

        return chatClient.prompt()
                .user(userQuery)
                .advisors(ragAdvisor)
                .call()
                .content();
    }

    /** 方式三：QuestionAnswerAdvisor —— 一行式 RAG，适合快速落地 */
    public String askSimple(String userQuery) {
        QuestionAnswerAdvisor advisor = QuestionAnswerAdvisor.builder(vectorStore)
                .searchRequest(SearchRequest.builder()
                        .topK(5)
                        .similarityThreshold(0.7)
                        .build())
                .build();

        return chatClient.prompt()
                .user(userQuery)
                .advisors(advisor)
                .call()
                .content();
    }
}
```

##### Spring AI 2.0 实现

```java
package com.carbon.guard.rag;

import org.springframework.ai.chat.client.ChatClient;
import org.springframework.ai.chat.client.advisor.vectorstore.QuestionAnswerAdvisor;
import org.springframework.ai.chat.model.ChatModel;
import org.springframework.ai.document.Document;
import org.springframework.ai.openai.OpenAiChatOptions;
import org.springframework.ai.vectorstore.SearchRequest;
import org.springframework.ai.vectorstore.VectorStore;

import java.util.List;
import java.util.stream.Collectors;

/**
 * 碳管家助手：Spring AI 2.0（Spring Boot 4 / Spring Framework 7 / Java 21）。
 * 2.0 关键变化：Options 只接受 Builder（不再接受构建好的实例）。
 */
public class CarbonRagService {

    private final VectorStore vectorStore;
    private final ChatClient chatClient;

    public CarbonRagService(VectorStore vectorStore, ChatModel chatModel) {
        this.vectorStore = vectorStore;
        this.chatClient = ChatClient.create(chatModel);
    }

    /** 2.0 一行式 RAG：QuestionAnswerAdvisor 自动完成检索 + 上下文注入 */
    public String askSimple(String userQuery) {
        QuestionAnswerAdvisor advisor = QuestionAnswerAdvisor.builder(vectorStore)
                .searchRequest(SearchRequest.builder()
                        .topK(5)
                        .similarityThreshold(0.7)
                        .build())
                .build();

        return chatClient.prompt()
                // 2.0：传 Builder，不要 .build()；未设置字段与默认值合并
                .options(OpenAiChatOptions.builder().temperature(0.2))
                .user(userQuery)
                .advisors(advisor)
                .call()
                .content();
    }

    /** 需要精细控制（多路召回 + 重排 + 引用标注）时仍然手动编排 */
    public String askManual(String userQuery) {
        List<Document> docs = vectorStore.similaritySearch(SearchRequest.builder()
                .query(userQuery)
                .topK(5)
                .similarityThreshold(0.7)
                .filterExpression("docType == 'STANDARD'")
                .build());

        String context = docs.stream()
                .map(d -> "[来源: " + d.getMetadata().get("source") + "] " + d.getText())
                .collect(Collectors.joining("\n\n"));

        return chatClient.prompt()
                .options(OpenAiChatOptions.builder().temperature(0.2))
                .system("你是碳管理专家助手。仅依据<参考资料>回答，答案中标注 [来源]。")
                .user(u -> u.text("<参考资料>\n{ctx}\n</参考资料>\n\n问题：{q}")
                        .param("q", userQuery)
                        .param("ctx", context))
                .call()
                .content();
    }
}
```

##### LangChain4j 实现

```java
package com.carbon.guard.rag;

import dev.langchain4j.memory.chat.MessageWindowChatMemory;
import dev.langchain4j.model.chat.ChatModel;
import dev.langchain4j.model.embedding.EmbeddingModel;
import dev.langchain4j.rag.content.retriever.ContentRetriever;
import dev.langchain4j.rag.content.retriever.EmbeddingStoreContentRetriever;
import dev.langchain4j.service.AiServices;
import dev.langchain4j.service.SystemMessage;
import dev.langchain4j.service.V;
import dev.langchain4j.store.embedding.EmbeddingStore;
import dev.langchain4j.data.segment.TextSegment;

/**
 * 碳管家助手：LangChain4j 1.0。
 * 注意：AiServices 本身没有 chat 方法，运行时调用的是自己声明的接口方法。
 */
public class CarbonRagService {

    /** 用接口声明能力，AiServices 在运行时生成代理实现 */
    public interface CarbonAssistant {
        @SystemMessage("你是碳管理专家助手。请仅依据检索到的知识回答；知识不足时明确告知用户。")
        String chat(@V("question") String question);
    }

    private final CarbonAssistant assistant;

    public CarbonRagService(ChatModel chatModel,
                             EmbeddingStore<TextSegment> embeddingStore,
                             EmbeddingModel embeddingModel) {
        // 向量检索器：等价于 Spring AI 的 VectorStore.similaritySearch
        ContentRetriever retriever = EmbeddingStoreContentRetriever.builder()
                .embeddingStore(embeddingStore)
                .embeddingModel(embeddingModel)
                .maxResults(5)
                .minScore(0.7)
                .build();

        this.assistant = AiServices.builder(CarbonAssistant.class)
                .chatModel(chatModel)
                .contentRetriever(retriever)
                .chatMemoryProvider(id -> MessageWindowChatMemory.builder().maxMessages(20).build())
                .build();
    }

    /** 声明式 RAG：检索 + 上下文注入 + 多轮记忆全由框架完成 */
    public String ask(String userQuestion) {
        return assistant.chat(userQuestion);
    }
}
```

#### 追问：
- 追问1：RetrievalAugmentationAdvisor与手动编排相比，在需要"先按行业过滤再向量检索"的碳管家场景里，Advisor的queryAugmenter能否嵌入元数据过滤逻辑？
  - **答**：可以。先用queryTransformer做Self-Query把“行业”抽为metadata filter写入SearchRequest，或自定义Retriever先标量过滤再向量检索，再用queryAugmenter组装；Advisor链式组合即可实现“先过滤后检索”。
- 追问2：当queryTransformers做查询改写后，改写失败或产生歧义时，是否还能回退到原始Query检索？
  - **答**：支持回退。改造queryTransformers链保留originalQuery；若改写后检索的相似度/数量不达标，回退用原Query重检并合并，或在Advisor里try-catch改写异常直接用原Query。


### 6. RAG如何优化？
**重要度**：★★★

优化不是"上一堆技巧"，而是**先定位瓶颈再对症**：碳管家的做法是先看 Bad Case 归因——检索没命中（召回问题）、命中了但排不进 Top-5（排序问题）、Top-5 对了但答错（生成问题），三类问题的优化手段完全不同。

**五个方向 + 碳管家的具体落点**：

1. **检索优化**：多路召回（向量 + BM25）+ RRF 融合 + Cross-Encoder 重排（Top-20 → Top-5）+ 查询改写。落点：召回侧 Recall@5 从基线 82% 提到 95%，是本章收益最大的一块。
2. **分块优化**：按标准章节结构切、父子块（子块检索/父块生成）、overlap 10–15%。落点：条款被切断导致的"检索到半截"问题基本消失。
3. **Prompt 优化**：Context 按"权威度 + 相似度"排序、强制引用来源、不足时拒答、关键数值要求逐字引用。落点：抑制"检索对了但生成跑偏"。
4. **缓存优化**：Embedding 缓存 + 检索结果缓存（TTL 30min）+ 语义缓存（FAQ 类命中率 50–60%）。落点：降本，不提升准确率。
5. **评估闭环**：RAGAS + 固定回归集 + CI 门禁，任何改动先跑 A/B，指标退化就回滚。落点：保证前四项不"越优化越差"。

**一个必须能讲透的点：分块策略的适用边界与失败案例**

| 策略 | 适用边界 | 典型失败案例 |
|---|---|---|
| 固定长度（512 token） | 结构混乱的网页/新闻 | ISO 标准一个条款被切成两半，检索命中半句、生成缺前提条件 |
| 递归字符切分 | 通用文本，最稳的默认 | 表格被按换行切散，表头与数据行分离，数值失去单位 |
| 结构感知（按章节/条款） | 法规、标准、SOP 等有编号层级的文档 | PDF 无书签时解析不出层级，退化成固定长度；短条款块过碎被淹没 |
| 父子块（Small-to-Big） | 条款长、需要完整上下文才能答 | 父块设成整章，token 成本暴涨且引入无关噪声 |
| 语义切分（句向量断点） | 话题切换明显的长文档 | 切分模型与检索模型不一致，边界错位；阈值不当把一条法规拆碎 |

选型原则：**先看文档有没有稳定结构，有结构就按结构切；没有结构才退回递归/固定长度；条款完整性要求高就叠加父子块**。参数（chunk size / overlap）必须用评测集扫出来，不能拍脑袋——碳因子库最终定 384 token、overlap 12%，就是 256/384/512 三档扫出来的拐点。

#### 追问：
- 追问1：你提到的"多路召回+Re-ranking+查询改写"在碳管家助手上线后，哪一项对回答准确率提升最大，有没有量化对比数据？
  - **答**：贡献最大的是"重排 + 多路召回"这一组的召回/排序环节。量化口径统一为端到端准确率（同一套 300 条人工标注基线）：纯向量 Top-5 基线 75% → 加 Re-ranking 80%（+5pt）→ 加查询改写与多路召回 85%（+5pt）→ 分块优化 89%（+4pt）→ Prompt 与幻觉控制 92%（+3pt）。检索侧同步看 Recall@5：82% → 88% → 93% → 95%，最后一步不再提升检索，只提升"检索到了能不能用对"。单手段的边际收益不能直接相加（重叠会衰减），所以对外只讲这套分阶段数据。
- 追问2：RAGAS评估闭环要持续迭代，碳管家助手多久跑一次评测，评测集如何随法规更新而维护？
  - **答**：建议每月一次全量RAGAS评测，法规重大更新（如CBAM新规）后立即补测；评测集按法规版本化标注，更新法规时同步修订参考答案与标注，保证随法规维护。


### 7. 你是怎么理解RAG的知识增强？
**重要度**：★★★

RAG 的知识增强本质是**外挂知识库 + 大模型推理能力**的结合：

- 大模型提供**语言理解和推理能力**（理解问题、组织语言、逻辑推理）。
- RAG 提供**精准的领域知识**（从知识库检索的原文片段）。
- 大模型基于检索到的知识"阅读理解"后生成答案，而非凭记忆"背诵"。

**类比**：大模型像一个博学但不了解最新政策的专家；RAG 相当于给专家一本最新的法规手册，让他查阅后回答。

#### 追问：
- 追问1：当检索到的知识本身存在错误（如旧版排放因子），RAG的"外挂知识+推理"结构反而会比纯模型更易传播错误吗，如何防范？
  - **答**：RAG不会“更易”传播，但会放大错误源。防范：入库前做版本与权威校验、检索优先返回最新版本（时间戳过滤）、生成要求标注来源便于核查、关键数值（排放因子）结构化直查交叉比对。
- 追问2：碳管家助手中大模型"阅读理解"后生成答案，如果用户追问细节超出检索片段，系统应继续检索还是承认知识不足？
  - **答**：应先二次检索（用追问中的新实体/上下文重写Query再检），仍无相关则明确“当前知识库不足以回答该细节”，不臆造，并可引导用户查看具体标准章节。


### 8. 传统知识库和RAG知识库有什么区别？
**重要度**：★★★

| 维度   | 传统知识库    | RAG 知识库    |
| ---- | -------- | ---------- |
| 检索方式 | 关键词/目录导航 | 语义向量检索     |
| 理解能力 | 无，返回原文   | 大模型理解+生成   |
| 交互方式 | 搜索→阅读    | 自然语言问答     |
| 多源融合 | 需人工整合    | 自动从多文档提取整合 |
| 回答形式 | 原文片段     | 结构化、口语化回答  |
| 精准度  | 依赖用户搜索技巧 | 语义匹配更精准    |

#### 追问：
- 追问1：碳管家助手是否仍需保留传统关键词检索作为兜底，以应对向量检索在精确标准编号匹配上的短板？
  - **答**：建议保留。向量检索在精确编号（如“GB/T 24067”）匹配弱，用ES/BM25做混合召回（Hybrid Search）互补；精确编号类走关键词路高权重，语义类走向量路。
- 追问2：对于"GB/T 24067第4.1条原文"这类用户明确要原文的场景，RAG的结构化口语化回答反而成了劣势，如何兼顾？
  - **答**：提供“原文/引用模式”开关：用户要原文时直接返回命中原文片段+精确章节定位（不重写），默认对话模式才做结构化口语化；Prompt识别“原文/条款”意图切换输出格式。


### 9. 你觉得目前RAG最大的瓶颈是什么？
**重要度**：★★★★

1. **检索准确率**：向量检索的语义匹配不一定等于问题相关。如"碳排放因子"可能检索到无关的同领域内容。Re-ranking 可缓解但未根治。
2. **长文档分块的信息丢失**：分块可能截断关键上下文，导致检索到的片段不完整。
3. **幻觉控制**：即使有检索结果，大模型仍可能"自由发挥"，偏离检索内容。
4. **多轮对话的上下文管理**：多轮对话中指代消解（"它""这个"）影响检索准确率。
5. **知识更新与索引同步**：知识库更新后需重建索引，实时性不足。

#### 追问：
- 追问1：你列的检索准确率瓶颈，在碳管家助手的实际评测里Recall@5大概是多少，Re-ranking把它提升了多少？
  - **答**：按同一套评测集（300 条人工标注基线，扩充到 500 条做回归）：纯向量 Top-5 的 Recall@5 约 0.82，加 Re-ranking 后 0.88（+6pt），再加改写与多路召回到 0.93，全链优化后 0.95。注意 Recall@5 是检索侧指标，它只是端到端准确率的上限；主要瓶颈在长尾术语与跨章节引用，用难例集持续追踪。
- 追问2：长文档分块信息丢失这个瓶颈，是否可通过"父子块"策略在碳标准文档上基本解决，还是仍有残余问题？
  - **答**：能基本缓解。父子块用子块精确检索、父块完整上下文生成，大幅减少截断；残余问题：超大章节父块仍超Context上限、跨父块引用仍需图谱/多跳补足。


### 10. 假设要给电商平台搭建一个百万/千万级的商品知识库问答系统，你会怎么设计？
**重要度**：★★★★

（此题虽是电商场景，但设计思路可迁移到碳管理知识库）

**架构设计**：

1. **数据层**：
   - 向量库：Milvus 集群（分片 + 副本），支持亿级向量。
   - 元数据：MySQL 存储商品结构化信息（价格、库存等）。
   - 全文索引：ElasticSearch 做关键词补充检索。
2. **索引构建**：
   - 商品描述 → 语义分块 → 向量化 → Milvus。
   - 分区策略：按商品类目分区，检索时先按类目过滤再向量检索，减少检索范围。
3. **检索策略**：
   - **多路召回**：向量检索（语义） + ES 检索（关键词） + 结构化查询（属性过滤）。
   - **Re-ranking**：用 Cross-Encoder 模型对召回结果重排。
   - **混合检索**：Top-20 召回 → Re-ranking → Top-5 输入大模型。
4. **大模型生成**：
   - 商品基础信息（价格/库存）从结构化查询获取，不走大模型。
   - 大模型只负责商品描述/评价的自然语言问答。


#### 三种框架实现对比

##### Spring AI 1.0 实现

```java
package com.carbon.guard.shop;

import org.springframework.ai.chat.client.ChatClient;
import org.springframework.ai.chat.model.ChatModel;
import org.springframework.ai.document.Document;
import org.springframework.ai.vectorstore.SearchRequest;
import org.springframework.ai.vectorstore.VectorStore;

import java.util.List;
import java.util.stream.Collectors;

/**
 * 百万/千万级商品知识库：Spring AI 1.0 落地。
 * 规模上量后向量库抽象不变，变的是：分区过滤 + 多路召回 + 重排 + 结构化直查。
 */
public class ShopKnowledgeService {

    /** 结构化数据（价格/库存）直查 MySQL，不进向量库 */
    private final ProductRepository productRepository;
    /** Milvus 集群，按类目 partition，检索时先标量过滤再向量检索 */
    private final VectorStore vectorStore;
    private final CrossEncoderReranker reranker;
    private final ChatClient chatClient;

    public ShopKnowledgeService(ProductRepository productRepository,
                                VectorStore vectorStore,
                                CrossEncoderReranker reranker,
                                ChatModel chatModel) {
        this.productRepository = productRepository;
        this.vectorStore = vectorStore;
        this.reranker = reranker;
        this.chatClient = ChatClient.create(chatModel);
    }

    /**
     * 在线检索：向量召回 Top-20 → 重排 Top-5 → 进 Prompt。
     * 千万级下靠 filterExpression 下推缩小检索范围，等价于 Milvus partition 裁剪。
     */
    public String ask(String userQuery, String category) {
        // 1) 向量召回（语义路）
        List<Document> candidates = vectorStore.similaritySearch(SearchRequest.builder()
                .query(userQuery)
                .topK(20)
                .similarityThreshold(0.6)
                .filterExpression("category == '" + category + "'")
                .build());

        // 2) Cross-Encoder 重排：bge-reranker-large 对 20 条重排取 Top-5
        List<Document> top5 = reranker.rerank(userQuery, candidates, 5);

        // 3) 价格/库存走结构化直查，绝不让大模型编造数字
        String liveFacts = productRepository.queryLiveFacts(top5.stream()
                .map(d -> String.valueOf(d.getMetadata().get("sku")))
                .toList());

        String context = top5.stream().map(Document::getText)
                .collect(Collectors.joining("\n\n"));

        return chatClient.prompt()
                .system("你是电商导购。商品描述依据<资料>；价格库存以<实时数据>为准，禁止臆造。")
                .user(u -> u.text("<资料>\n{ctx}\n</资料>\n<实时数据>\n{facts}\n</实时数据>\n\n问题：{q}")
                        .param("ctx", context)
                        .param("facts", liveFacts)
                        .param("q", userQuery))
                .call()
                .content();
    }
}
```

##### Spring AI 2.0 实现

```java
package com.carbon.guard.shop;

import org.springframework.ai.chat.client.ChatClient;
import org.springframework.ai.chat.model.ChatModel;
import org.springframework.ai.document.Document;
import org.springframework.ai.openai.OpenAiChatOptions;
import org.springframework.ai.tool.ToolCallback;
import org.springframework.ai.tool.function.FunctionToolCallback;
import org.springframework.ai.vectorstore.SearchRequest;
import org.springframework.ai.vectorstore.VectorStore;

import java.util.List;
import java.util.stream.Collectors;

/**
 * 千万级商品知识库：Spring AI 2.0 落地。
 * 2.0 变化：ToolCallback 必须显式注册；ToolCallingAdvisor 由 ChatClient 自动注册完成工具往返。
 */
public class ShopKnowledgeService {

    private final VectorStore vectorStore;
    private final CrossEncoderReranker reranker;
    private final ChatClient chatClient;
    /** 2.0：显式声明为 ToolCallback Bean，工具往返由 ToolCallingAdvisor 自动完成 */
    private final ToolCallback productLookupTool;

    public ShopKnowledgeService(VectorStore vectorStore,
                                CrossEncoderReranker reranker,
                                ProductRepository productRepository,
                                ChatModel chatModel) {
        this.vectorStore = vectorStore;
        this.reranker = reranker;
        this.chatClient = ChatClient.create(chatModel);
        this.productLookupTool = FunctionToolCallback
                .builder("lookupProductFacts", (String sku) -> productRepository.queryLiveFacts(List.of(sku)))
                .description("按 SKU 查询商品实时价格与库存，返回 JSON 字符串")
                .inputType(String.class)
                .build();
    }

    public String ask(String userQuery, String category) {
        // 1) 向量召回 Top-20（语义路），标量过滤下推
        List<Document> candidates = vectorStore.similaritySearch(SearchRequest.builder()
                .query(userQuery)
                .topK(20)
                .similarityThreshold(0.6)
                .filterExpression("category == '" + category + "'")
                .build());

        // 2) Cross-Encoder 重排取 Top-5
        List<Document> top5 = reranker.rerank(userQuery, candidates, 5);
        String context = top5.stream().map(Document::getText).collect(Collectors.joining("\n\n"));

        return chatClient.prompt()
                // 2.0：传 Builder 实例
                .options(OpenAiChatOptions.builder().temperature(0.1).maxTokens(2048))
                .system("你是电商导购。价格库存必须调用 lookupProductFacts 获取，描述依据<资料>。")
                .user(u -> u.text("<资料>\n{ctx}\n</资料>\n\n问题：{q}")
                        .param("ctx", context)
                        .param("q", userQuery))
                // 2.0：toolNames() 已移除，必须传显式的 ToolCallback
                .toolCallbacks(productLookupTool)
                .call()
                .content();
    }
}
```

##### LangChain4j 实现

```java
package com.carbon.guard.shop;

import dev.langchain4j.data.segment.TextSegment;
import dev.langchain4j.model.chat.ChatModel;
import dev.langchain4j.model.embedding.EmbeddingModel;
import dev.langchain4j.rag.content.Content;
import dev.langchain4j.rag.content.retriever.ContentRetriever;
import dev.langchain4j.rag.content.retriever.EmbeddingStoreContentRetriever;
import dev.langchain4j.rag.query.Query;
import dev.langchain4j.service.AiServices;
import dev.langchain4j.service.SystemMessage;
import dev.langchain4j.service.V;
import dev.langchain4j.store.embedding.EmbeddingStore;
import dev.langchain4j.store.embedding.filter.MetadataFilterBuilder;

import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.stream.Collectors;

/**
 * 千万级商品知识库：LangChain4j 1.0。
 * 规模上量靠 EmbeddingStore 换实现（Milvus/Qdrant），业务检索代码不用改。
 */
public class ShopKnowledgeService {

    public interface ShopAssistant {
        @SystemMessage("你是电商导购。商品描述依据检索到的商品资料回答。")
        String chat(@V("question") String question);
    }

    private final ShopAssistant assistant;
    private final EmbeddingStore<TextSegment> embeddingStore;
    private final EmbeddingModel embeddingModel;
    private final CrossEncoderReranker reranker;
    private final ProductRepository productRepository;
    /** 按类目缓存的检索器：过滤条件在建 builder 时就固定下来 */
    private final Map<String, ContentRetriever> retrieverByCategory = new ConcurrentHashMap<>();

    public ShopKnowledgeService(ChatModel chatModel,
                                EmbeddingStore<TextSegment> embeddingStore,
                                EmbeddingModel embeddingModel,
                                CrossEncoderReranker reranker,
                                ProductRepository productRepository) {
        this.embeddingStore = embeddingStore;
        this.embeddingModel = embeddingModel;
        this.reranker = reranker;
        this.productRepository = productRepository;

        // 注意：这里【不】再挂 contentRetriever —— 检索在 ask() 里手动做，
        // 两条链路二选一，同时挂会导致框架再检索一遍
        this.assistant = AiServices.builder(ShopAssistant.class)
                .chatModel(chatModel)
                .build();
    }

    /** 类目 → 检索器：category 走元数据过滤，不能写成 retrieve(query, category) 这种不存在的重载 */
    private ContentRetriever retrieverFor(String category) {
        return retrieverByCategory.computeIfAbsent(category, c ->
                EmbeddingStoreContentRetriever.builder()
                        .embeddingStore(embeddingStore)
                        .embeddingModel(embeddingModel)
                        .maxResults(20)      // 召回 Top-20
                        .minScore(0.6)
                        .filter(new MetadataFilterBuilder().add("category", c).build())
                        .build());
    }

    /**
     * 召回 + 重排 + 结构化直查 三段式。
     * ContentRetriever 只有 retrieve(Query) 一个参数，类目过滤在检索器构建时指定。
     */
    public String ask(String userQuery, String category) {
        // 1) 向量召回：先按类目过滤再检索（预过滤，缩小搜索空间）
        List<TextSegment> candidates = retrieverFor(category)
                .retrieve(Query.from(userQuery)).stream()
                .map(Content::textSegment)
                .toList();

        // 2) Cross-Encoder 重排取 Top-5
        List<TextSegment> top5 = reranker.rerank(userQuery, candidates, 5);

        // 3) 结构化直查拼 Prompt：价格库存不进向量库
        String context = top5.stream().map(TextSegment::text).collect(Collectors.joining("\n\n"));
        String liveFacts = productRepository.queryLiveFacts(skusOf(top5));

        return assistant.chat(userQuery + "\n\n<资料>\n" + context + "\n</资料>\n<实时数据>\n" + liveFacts + "\n</实时数据>");
    }
}
```

#### 追问：
- 追问1：如果把这个设计平移到碳管家助手，亿级向量的Milvus分片策略会按什么维度（文档类型/行业/时间戳）分区最合理？
  - **答**：建议复合分区：主分区按文档类型（标准/法规/因子库）+行业二级分区，时间戳做冷热分离；这样“某行业标准”类查询先定位分区再检索，缩小范围提效。
- 追问2：电商商品多路召回里的Cross-Encoder重排，在碳管家助手面对中英文混排法规时，是否需要专门微调重排模型？
  - **答**：中英文混排法规建议微调或领域适配的Cross-Encoder（如bge-reranker-large做领域continue-pretrain），通用重排在英文术语与中文法规对应上可能不足；先通用版上线，用难例集评估再决定。
- 追问3：千万级商品库增量更新频繁，这套架构的索引更新延迟如何控制在分钟级，是否引入CDC而不是定时全量？
  - **答**：引入CDC（Canal捕获binlog→Kafka→消费者upsert Milvus），变更秒级生效，仅更新变更chunk而非全量；配合RabbitMQ异步解耦并监控消费延迟，保证分钟级。


### 11. 针对商品信息（如价格、描述）可能被商家动态更新的情况，RAG系统如何应对？
**重要度**：★★★

1. **增量索引**：商品更新时，只重建该商品的 chunk 并更新向量，不做全量重建。注意重新分块后块数可能变化，必须按商品 id 先删旧块再写新块（`upsert` 只能覆盖同主键，会留孤儿块，详见第 41 题）。
2. **双写策略**：商品更新同时写 MySQL + 更新 Milvus 向量，通过消息队列异步解耦。
3. **缓存失效**：商品更新时删除相关问答缓存。
4. **时效性标注**：回答中标注"以下信息更新于 XXXX-XX-XX"，提示用户时效性。
5. **结构化数据直接查询**：价格等高时效性数据不走 RAG，直接查 MySQL 实时返回。

#### 追问：
- 追问1：碳排放因子被商家（企业用户）实时修改时，消息队列异步更新Milvus的过程中出现消费积压，会不会返回过期因子，如何保证强一致？
  - **答**：异步窗口存在过期风险。措施：因子等高时效数据直查MySQL作事实源，生成以直查数值为准并标注；消费端幂等+版本号保证最终一致；关键查询走强一致路径。
- 追问2：双写MySQL+Milvus如果其中一路失败，碳管家助手怎么检测并补偿，避免回答与数据库事实不一致？
  - **答**：用消息队列解耦，消费失败进死信队列（DLQ）重试；定时对账比对MySQL与Milvus因子版本，不一致触发补偿重推；监控“双写延迟”与“不一致计数”告警。
- 追问3：价格等高时效数据直接查MySQL而非RAG，那碳管家助手里"企业实时碳数据"是否也应走直查而非向量检索？
  - **答**：应走直查。企业实时碳数据同属高时效、强一致需求，直接查MySQL/时序库返回，不进向量检索；向量库只存文档类知识。


### 12. RAG引擎具体是做什么的？
**重要度**：★★★

RAG 引擎是 RAG 系统的核心编排层，负责：

1. **查询理解**：用户问题改写、意图识别。
2. **检索编排**：多路召回、Re-ranking、过滤。
3. **上下文组装**：将检索结果格式化为 Prompt Context。
4. **生成调用**：调用大模型生成回答。
5. **后处理**：引用标注、安全过滤、结果缓存。

#### 追问：
- 追问1：碳管家助手的RAG引擎在做"查询理解"时，如何识别用户是在问法规条款还是问具体排放因子计算，以选择不同检索路径？
  - **答**：查询理解阶段做意图分类：含标准编号/条款词（“第X条”“ISO X”）走“法规条款”路径（精确+章节过滤）；含“因子/计算/多少”走“数值计算”路径（结构化因子库+公式）；可用小模型分类或规则+LLM判别。
- 追问2：引擎后处理里的"引用标注"如果大模型生成的来源编号与实际检索片段对不上，如何在工程上做引用校验？
  - **答**：后处理做引用溯源：记录每个来源编号对应的检索片段ID，生成后正则抽取回答中的[来源]标记，校验其确实存在于本次检索片段；无法对应则警告或要求模型重述并附真实来源。


### 13. 用于RAG的数据是从哪里来的？
**重要度**：★★★

**碳管家助手的知识库数据来源**：

1. **标准文档**：ISO 14040/14044/14067/14064 系列（PDF）。
2. **国家标准**：GB/T 24040、GB/T 24067 等（Word/PDF）。
3. **行业碳排放因子库**：HiQLCD 数据库中的碳排放因子数据（Excel/数据库）。
4. **法规文件**：CBAM 法规、各地碳交易政策文件。
5. **LCA 方法学指南**：产品碳足迹核算指南。
6. **平台帮助文档**：积木LCA云操作手册。
7. **历史问答**：用户历史高质量问答对（作为 Few-shot 示例）。

#### 追问：
- 追问1：历史问答作为Few-shot示例入库时，如何防止低质量或已过时的历史回答污染新知识库？
  - **答**：入库前对历史问答做质量过滤：人工/模型打分阈值、去重、时效性检查（标创建时间、过期淘汰），仅采纳高赞且通过专家抽检的问答，保留可追溯来源避免劣质样本污染。
- 追问2：HiQLCD等外部因子库的版权与更新频率是否会成为碳管家助手知识质量的隐性风险？
  - **答**：是隐性风险。应对：记录因子来源与版本/更新日期并标metadata；定期与权威源对账，偏差告警；关注版权，仅用授权/公开数据，商用前获许可。


### 14. 针对RAG这部分，有没有自己构建知识库进行对比实验来评估效果？具体使用了哪些知识？如何评估这些知识的质量？
**重要度**：★★★★

**对比实验**：

- 实验组1：纯大模型（无 RAG）→ 评估碳法规问答准确率。
- 实验组2：RAG + Top-5 检索 → 评估准确率提升。
- 实验组3：RAG + Top-5 + Re-ranking → 评估 Re-ranking 增量效果。
- 实验组4：RAG + 查询改写 + Re-ranking → 评估改写效果。

**评估方法**：

- 准备 300 道碳管理领域标准测试题（含标准答案），与全章基线口径一致；冷启动阶段可先跑 100 道小集。
- 指标：检索准确率（Recall@5）、回答准确率（人工评分 1-5）、引用准确率。

**知识质量评估**：

- **覆盖度**：知识库是否覆盖用户常问的问题类型。
- **时效性**：法规是否为最新版本。
- **准确性**：数据是否与权威来源一致。
- **可读性**：分块后是否语义完整。

#### 追问：
- 追问1：300 道测试题是你人工标注的还是领域专家标注的，标注一致性（Inter-annotator agreement）如何保证？
  - **答**：建议领域专家标注为主、团队交叉校验；用标注指南统一口径，计算Inter-annotator agreement（如Cohen's κ），低于阈值复标；关键题由两位专家独立标注取共识。
- 追问2：实验组4（查询改写+Re-ranking）相比实验组2（纯Top-5）的准确率提升，是否足以justify线上增加的那段改写延迟？
  - **答**：看提升/延迟比。若改写延迟<100ms但准确率提升>10pt且用户问题多为口语/术语mismatch，值得；否则按复杂度路由，仅复杂/低置信查询走改写，简单事实类跳过。
- 追问3：你评估"知识质量"的覆盖度指标，有没有量化成可监控的仪表盘，还是仅上线前人工检查？
  - **答**：建议量化。用评测集按题型/行业统计覆盖率与准确率，接入监控仪表盘（如Grafana）持续追踪；不仅上线前人工检查，每次索引更新后自动跑回归并对比历史曲线。


### 15. 你这个AI客服功能里涉及的RAG技术是什么？具体怎么实现？
**重要度**：★★★★

**碳管家AI助手的RAG实现**：

1. **知识库构建**：
   - 文档：ISO 标准PDF + GB/T Word + 碳排放因子Excel + CBAM法规。
   - 分块：按章节标题语义分块，chunk_size=500 token，overlap=50。
   - 向量化：bge-large-zh-v1.5（1024维），本地 ONNX Runtime 推理。
   - 存储：Milvus 2.x，HNSW 索引，建索引参数 M=16、efConstruction=200；检索期设 ef=64。注意别把建索引的 efConstruction 和检索的 ef 混成一个参数。
2. **在线检索**：
   - 用户问题向量化 → Milvus 检索 Top-20 → Re-ranking（bge-reranker-large）取 Top-5。
   - 元数据过滤：按文档类型（标准/法规/因子库）过滤。
3. **Prompt 组装**：
   ```
   System: 你是碳管理专家助手。请基于以下检索到的知识回答用户问题。
   如果检索知识不足以回答，请明确告知用户。

   Context:
   [1] 来源：ISO 14067:2018 第5.3节
       内容：...
   [2] 来源：GB/T 24067-2024 第4.1条
       内容：...

   User: {用户问题}
   ```
4. **大模型生成**：通义千问 Qwen-Plus，流式 SSE 输出。


#### 三种框架实现对比

##### Spring AI 1.0 实现

```java
package com.carbon.guard.assistant;

import org.springframework.ai.chat.client.ChatClient;
import org.springframework.ai.chat.client.advisor.MessageChatMemoryAdvisor;
import org.springframework.ai.chat.memory.InMemoryChatMemoryRepository;
import org.springframework.ai.chat.memory.MessageWindowChatMemory;
import org.springframework.ai.chat.model.ChatModel;
import org.springframework.ai.document.Document;
import org.springframework.ai.vectorstore.SearchRequest;
import org.springframework.ai.vectorstore.VectorStore;

import java.util.List;
import java.util.stream.Collectors;

/**
 * 碳管家 AI 客服：Spring AI 1.0 完整链路（切分→向量化→召回→重排→生成）。
 * 线上参数：chunk=500 token，overlap=50；召回 Top-20，重排取 Top-5。
 */
public class AiCustomerService {

    private final VectorStore vectorStore;
    private final CrossEncoderReranker reranker;
    private final ChatClient chatClient;

    public AiCustomerService(VectorStore vectorStore,
                              CrossEncoderReranker reranker,
                              ChatModel chatModel) {
        this.vectorStore = vectorStore;
        this.reranker = reranker;
        // 1.0：MessageWindowChatMemory 走 builder，存储用 ChatMemoryRepository
        this.chatClient = ChatClient.builder(chatModel)
                .defaultAdvisors(MessageChatMemoryAdvisor.builder(
                                MessageWindowChatMemory.builder()
                                        .chatMemoryRepository(new InMemoryChatMemoryRepository())
                                        .maxMessages(20)
                                        .build())
                        .conversationId("carbon-user-42")
                        .build())
                .build();
    }

    public String ask(String userQuery) {
        // 1) 召回 Top-20（Milvus HNSW）
        List<Document> candidates = vectorStore.similaritySearch(SearchRequest.builder()
                .query(userQuery)
                .topK(20)
                .similarityThreshold(0.5)
                .build());

        // 2) bge-reranker-large 重排取 Top-5
        List<Document> top5 = reranker.rerank(userQuery, candidates, 5);

        // 3) 按"来源: 第X节"编号组装 Context，模型才能给出可溯源引用
        String context = top5.stream()
                .map(d -> "[" + d.getMetadata().get("source") + "] " + d.getText())
                .collect(Collectors.joining("\n\n"));

        // 4) 生成：Prompt 明确"依据不足要告知"，这是抑制幻觉的第一道闸
        return chatClient.prompt()
                .system("""
                        你是碳管理专家助手。请基于以下检索到的知识回答用户问题。
                        如果检索知识不足以回答，请明确告知用户。
                        """)
                .user(u -> u.text("Context:\n{ctx}\n\nUser: {q}")
                        .param("ctx", context)
                        .param("q", userQuery))
                .call()
                .content();
    }
}
```

##### Spring AI 2.0 实现

```java
package com.carbon.guard.assistant;

import org.springframework.ai.chat.client.ChatClient;
import org.springframework.ai.chat.client.advisor.MessageChatMemoryAdvisor;
import org.springframework.ai.chat.memory.ChatMemory;
import org.springframework.ai.chat.memory.InMemoryChatMemoryRepository;
import org.springframework.ai.chat.memory.MessageWindowChatMemory;
import org.springframework.ai.chat.model.ChatModel;
import org.springframework.ai.document.Document;
import org.springframework.ai.openai.OpenAiChatOptions;
import org.springframework.ai.vectorstore.SearchRequest;
import org.springframework.ai.vectorstore.VectorStore;

import java.util.List;
import java.util.stream.Collectors;

/**
 * 碳管家 AI 客服：Spring AI 2.0。
 * 2.0 变化点：Options 传 Builder；conversationId 必须按请求传，
 * 且 ChatMemory.DEFAULT_CONVERSATION_ID 已移除（只剩 ChatMemory.CONVERSATION_ID）。
 */
public class AiCustomerService {

    private final VectorStore vectorStore;
    private final CrossEncoderReranker reranker;
    private final ChatClient chatClient;
    private final ChatMemory chatMemory;

    public AiCustomerService(VectorStore vectorStore,
                              CrossEncoderReranker reranker,
                              ChatModel chatModel) {
        this.vectorStore = vectorStore;
        this.reranker = reranker;
        this.chatMemory = MessageWindowChatMemory.builder()
                .chatMemoryRepository(new InMemoryChatMemoryRepository())
                .maxMessages(20)
                .build();
        this.chatClient = ChatClient.create(chatModel);
    }

    /** 2.0：conversationId 通过 advisor context 按请求传入 */
    public String ask(String userQuery, String conversationId) {
        List<Document> candidates = vectorStore.similaritySearch(SearchRequest.builder()
                .query(userQuery)
                .topK(20)
                .similarityThreshold(0.5)
                .build());

        List<Document> top5 = reranker.rerank(userQuery, candidates, 5);
        String context = top5.stream()
                .map(d -> "[" + d.getMetadata().get("source") + "] " + d.getText())
                .collect(Collectors.joining("\n\n"));

        return chatClient.prompt()
                // 2.0：传 Builder 实例；RAG 场景用低温度抑制发散
                .options(OpenAiChatOptions.builder().temperature(0.2))
                .advisors(a -> a.param(ChatMemory.CONVERSATION_ID, conversationId))
                .advisors(MessageChatMemoryAdvisor.builder(chatMemory).build())
                .system("""
                        你是碳管理专家助手。请基于以下检索到的知识回答用户问题。
                        如果检索知识不足以回答，请明确告知用户。
                        """)
                .user(u -> u.text("Context:\n{ctx}\n\nUser: {q}")
                        .param("ctx", context)
                        .param("q", userQuery))
                .call()
                .content();
    }
}
```

##### LangChain4j 实现

```java
package com.carbon.guard.assistant;

import dev.langchain4j.data.segment.TextSegment;
import dev.langchain4j.memory.chat.MessageWindowChatMemory;
import dev.langchain4j.model.chat.ChatModel;
import dev.langchain4j.model.embedding.EmbeddingModel;
import dev.langchain4j.rag.content.retriever.ContentRetriever;
import dev.langchain4j.rag.content.retriever.EmbeddingStoreContentRetriever;
import dev.langchain4j.service.AiServices;
import dev.langchain4j.service.SystemMessage;
import dev.langchain4j.service.V;
import dev.langchain4j.store.embedding.EmbeddingStore;

import java.util.List;
import java.util.stream.Collectors;

/**
 * 碳管家 AI 客服：LangChain4j 1.0。
 * 重排放在框架外手写：先用 contentRetriever 召回 Top-20，再 bge-reranker 取 Top-5。
 */
public class AiCustomerService {

    public interface CarbonAssistant {
        @SystemMessage("""
                你是碳管理专家助手。请基于检索到的知识回答用户问题，
                知识不足时明确告知用户，不要编造。
                """)
        String chat(@V("question") String question);
    }

    private final CarbonAssistant assistant;
    private final ContentRetriever retriever;
    private final CrossEncoderReranker reranker;

    public AiCustomerService(ChatModel chatModel,
                             EmbeddingStore<TextSegment> embeddingStore,
                             EmbeddingModel embeddingModel,
                             CrossEncoderReranker reranker) {
        this.reranker = reranker;
        this.retriever = EmbeddingStoreContentRetriever.builder()
                .embeddingStore(embeddingStore)
                .embeddingModel(embeddingModel)
                .maxResults(20)       // 召回 Top-20
                .minScore(0.5)
                .build();

        // 注意：检索与重排在 ask() 里手动做，这里不再挂 contentRetriever，
        // 否则框架会自己再检索一遍（两条链路只能选一条）
        this.assistant = AiServices.builder(CarbonAssistant.class)
                .chatModel(chatModel)
                .chatMemoryProvider(id -> MessageWindowChatMemory.builder().maxMessages(20).build())
                .build();
    }

    public String ask(String userQuery) {
        // 1) 召回：1.x 的 retrieve 返回 List<Content>，取 textSegment 才是正文
        List<TextSegment> candidates = retriever.retrieve(
                        dev.langchain4j.rag.query.Query.from(userQuery))
                .stream()
                .map(dev.langchain4j.rag.content.Content::textSegment)
                .toList();

        // 2) 重排取 Top-5，并保留 source 元数据以便生成引用
        List<TextSegment> top5 = reranker.rerank(userQuery, candidates, 5);

        String context = top5.stream()
                .map(s -> "[" + s.metadata().getString("source") + "] " + s.text())
                .collect(Collectors.joining("\n\n"));

        // 3) 生成：把重排后的片段作为上下文随问题一起给模型
        return assistant.chat(userQuery + "\n\nContext:\n" + context);
    }
}
```

#### 追问：
- 追问1：bge-large-zh-v1.5本地ONNX推理在高峰期QPS上是否存在CPU/GPU瓶颈，吞吐不足时如何横向扩展？
  - **答**：可能遇CPU瓶颈。扩展：多实例部署Embedding服务前置负载均衡、GPU推理（ONNX Runtime CUDA）提吞吐、批处理+队列削峰、高峰期用缓存复用相同Query向量。
- 追问2：通义千问Qwen-Plus流式SSE输出时，若检索阶段已耗时150ms，端到端首字延迟（TTFT）还能满足体验要求吗？
  - **答**：检索150ms+模型首token通常数百ms~1s，端到端TTFT约<1.5s通常可接受；若模型首字慢，先推“检索中”占位并流式输出，以检索结果预填减少等待感。
- 追问3：Prompt里要求"检索不足时明确告知用户"，但实际上线后大模型仍可能硬编，如何用后处理强制拦截无引用陈述？
  - **答**：后处理校验：对回答中关键事实/数值检查能否在检索Context找到依据（规则/正则匹配或轻量模型判定）；无依据陈述标记或删除并提示“以下基于检索内容”；硬编数值强制要求附来源。


### 16. 文档分块有哪些策略？如何处理长文档？语义分块如何避免语义断裂？
**重要度**：★★★★★

**分块策略**：

| 策略   | 说明                  | 适用场景         |
| ---- | ------------------- | ------------ |
| 固定长度 | 按 token 数切分（如 500）  | 通用，简单        |
| 滑动窗口 | 固定长度 + 重叠（如 500+50） | 避免边界信息丢失     |
| 语义分块 | 按段落/章节/标题切分         | 结构化文档（标准/法规） |
| 递归分块 | 先按大段落切，再按小段落切       | 层级结构文档       |
| 父子块  | **小块（子块）检索，大块（父块）生成** | 平衡检索精度和上下文完整 |

**长文档处理**：

- 递归分块：先按一级标题切分，超长的章节再按二级标题/段落切分。
- 父子块策略：检索时用小块（精确匹配），生成时扩展到父块（上下文完整）。

**避免语义断裂**：

- overlap 重叠区（50 token）避免句子被截断。
- 按标点符号（句号/换行）切分，不在句中间断开。
- 保留分块的前后标题/层级信息作为元数据。

#### 追问：
- 追问1：碳管家助手按章节标题语义分块，遇到ISO标准里跨章节引用的定义（如"见3.2术语"），分块后上下文如何补全？
  - **答**：分块时把引用的术语定义作为元数据或前缀注入该chunk（如“术语见3.2：碳足迹指…”）；或构建术语表chunk做父子块，引用时连带检索；也可在Prompt附术语表上下文补全。
- 追问2：overlap=50 token在中文里大约多少字，对排放因子表格这类结构化内容，overlap会不会把表头重复切断导致误读？
  - **答**：overlap=50 token中文约30~40字。对表格类结构化内容按表格整体分块而非按token切，避免表头重复切断；表格单独存结构化chunk，overlap仅作用于连续文本防误读。


### 17. 向量数据库如何选型？
**重要度**：★★★★

| 向量库               | 特点             | 适用场景         | 优缺点              |
| ----------------- | -------------- | ------------ | ---------------- |
| **Milvus**        | 分布式、高可用、支持亿级向量 | 大规模生产环境      | 优：性能强、生态好；缺：部署复杂 |
| **PGVector**      | PostgreSQL 插件  | 已有PG的项目、中小规模 | 优：简单易用；缺：性能不如专用库 |
| **Chroma**        | 轻量、Python 原生   | 原型开发、小项目     | 优：易上手；缺：不支持分布式   |
| **ElasticSearch** | 全文+向量混合检索      | 需要关键词+向量混合检索 | 优：混合检索；缺：向量性能一般  |
| **Qdrant**        | Rust 实现，高性能    | 追求性能的场景      | 优：性能好；缺：生态较小     |

**碳管家助手选型**：选择 **Milvus**，但要说得诚实——当前数据量**不构成"必须分布式"的理由**：

1. 当前约 10w 级分块，单机 Milvus 甚至 PGVector 都够用；选 Milvus 主要是看**未来亿级增长、多副本高可用，以及团队已有 Milvus 运维经验**，不是"现在就需要分布式"。
2. HNSW 索引性能好，检索延迟 < 50ms。
3. Spring AI / LangChain4j 都有良好支持。
4. 社区活跃，文档完善。
5. 迁移成本有兜底：业务代码只依赖 `VectorStore` 抽象，真要换库只改配置与过滤语法。

#### 追问：
- 追问1：Milvus部署复杂，碳管家助手在早中期数据量未到10w分块时，是否考虑过先用PGVector降低运维成本再迁移？
  - **答**：可考虑。数据量未到10w时PGVector运维简单、与业务库一体；待量到阈值再迁Milvus。用VectorStore抽象可平滑切换，但过滤语法/索引参数需重写（见前文）。
- 追问2：如果未来要支持图结构检索（Graph RAG），Milvus单机能否承载，还是必须引入Neo4j/HugeGraph形成混合存储？
  - **答**：Milvus单机不适合图遍历。Graph RAG需引入Neo4j/HugeGraph存实体关系，Milvus存向量，二者混合：图做关系推理、向量做语义召回，检索时融合。


### 18. 向量化（Embedding）模型如何选择？
**重要度**：★★★★★

**选型考量**：

1. **语言**：中文为主选中文优化模型（bge-large-zh-v1.5、m3e-base）；英文/多语言选 `text-embedding-3-large` / `text-embedding-3-small`（OpenAI）或 `bge-m3`（开源、可本地部署）。`text-embedding-ada-002` 是 2022 年的模型，已被 3 系列全面取代，别再推荐。
2. **维度**：高维度（1024）精度好但存储/检索开销大；低维度（384）速度快。
3. **部署方式**：云 API（通义千问 Embedding）vs 本地部署（ONNX）。
4. **性能**：MTEB 榜单对比检索效果。

**碳管家助手选择**：

- **bge-large-zh-v1.5**：中文检索效果好，1024维，支持本地 ONNX 部署。
- 单条向量化延迟约 2ms（本地 ONNX、批量 32 条一起推，单进程约 500 条/秒）；在线单条同步请求受调度开销影响约 10~20ms/条，成本为零（只有机器成本）。
- 批量向量化（离线索引）吞吐量约 500 条/秒，10 万 chunk 全量重建约 3~4 分钟（含解析与切分则更长）。

#### 追问：
- 追问1：bge-large-zh-v1.5在碳排放因子这种高度数值化、术语密集的内容上，检索效果是否明显劣于通用语义，有没有测过domain-adapted版本？
  - **答**：可能在数值/术语密集内容略劣于通用语义（bge偏通用文本）。建议测领域适配版（碳语料continue-pretrain或对比m3e/bge-m3）；差距大再替换，否则先用bge-large-zh-v1.5。
- 追问2：本地ONNX推理零成本，但若未来要支持多语言（如欧盟CBAM英文法规），单中文模型是否够用，要不要上bge-m3多语言模型？
  - **答**：单中文模型对CBAM英文法规检索弱。建议上bge-m3（多语言1024维）统一中英，或中英双路Embedding+融合；若主要涉外法规，m3更合适。


### 19. 相似度检索的Top-K如何确定？
**重要度**：★★★★★

Top-K 是 RAG 检索的核心超参数——K 决定了从向量库召回多少个候选 chunk 送入后续处理。

**K 值的影响**：
- **K 太小**（1-2）：召回率低，Top-1 不相关就直接失败；但 context 短、推理快、成本低。
- **K 太大**（20-50）：召回率高但引入大量噪声 chunk，context 变长（成本与延迟上升），且"Lost in the Middle"会让关键信息被淹没。
- **最优 K**：在召回率和精确率之间取平衡，使端到端准确率最高——注意不是让召回率最高。

**碳管家的三段式策略**：
1. **大 K 召回**：向量检索 Top-20（Recall@20 = 98%）。
2. **Re-ranking 精排**：用 bge-reranker-large 对 20 个 chunk 重打分，取 Top-5（重排后 Precision@5 = 72%）。
3. **LLM 推理**：Top-5 chunk（约 2000-3000 token）送入模型生成。

"大召回 → 精排 → 裁剪"是当前 RAG 的默认实践。直接 Top-5 检索的 Recall@5 只有 82%，加 Re-ranking 后升到 88%，再叠加改写/多路召回/分块优化后全链 Recall@5 = 95%——相当于拿到接近 Top-20 的召回（98% → 95%，损失约 3pt），却只付 Top-5 的 context 成本。

注意 Recall@5 是**检索侧**指标，它是端到端准确率的**上限**：全链 Recall@5 = 95%，端到端准确率 92%，两者差的 3 个点就是"检索到了但生成没用对"的损失。

**动态 K**：按问题复杂度自适应——简单事实查询（"碳排放因子单位是什么"）K=3，复杂对比类（"对比钢铁和水泥行业的核算方法差异"）K=10。用轻量意图分类器或阈值规则判断复杂度。

#### 追问：
- 追问1：动态 K 靠什么信号判断"复杂"——query 长度、实体数，还是首次检索的置信度分散度？
  - **答**：综合信号：query 实体数/长度、首次检索返回的相似度分散度（方差大 = 复杂）、是否含多标准/多行业；用轻量分类器或阈值规则，分散度高或实体多则调大 K。
- 追问2：自适应 K 的意图分类一旦出错（复杂问题被判简单、K=3），有没有基于检索置信度的二次扩召回？
  - **答**：有，形成"置信度驱动"的弹性窗口：
    - 先用较小 K 召回，若 Top 结果综合置信度低于阈值，自动扩到更大 K（3→10→20）重新召回+重排。
    - 意图分类仅作初筛，最终以检索置信度为准，避免一次误判锁死召回规模。
    - 误分类样本回灌重训意图模型，长期降低触发扩召回的频率与成本。
- 追问3：大 K 召回 Top-20 再 Rerank 取 Top-5，如果 Reranker 在碳术语上排错，正确 chunk 排第 19 也会被裁掉，如何兜底？
  - **答**：三重兜底：
    - 多路召回互补：向量+BM25 融合，正确 chunk 至少在某一路进前排，降低对单路排序的依赖。
    - 置信度兜底：Top-5 综合置信度仍低时放宽到 Top-10，或触发"未找到"而非硬裁；高 stakes 问题容忍更宽召回。
    - Reranker 误差进评测闭环，用难负样本微调 bge-reranker-large 或加领域词典，提升碳术语排序准度。
- 追问4：先宽后窄增加了 Embedding 与 Rerank 成本，实测的耗时与质量收益比是多少？
  - **答**：收益比很高，额外耗时可控：
    - 质量收益：Recall@5 从基线 82% → 重排后 88% → 全链 95%（+13pt）；额外耗时在本地毫秒级（bge-reranker CPU 单条约 20ms，20 条约 300~400ms；GPU 批处理可压到 <100ms）。
    - 远优于"直接放大 K 送 LLM"——后者是 token 成本翻倍。
    - 延迟敏感场景可把 Rerank 候选从 20 降到 10 再权衡；最终以 A/B 实测为准。
- 追问5：Re-ranking 后取 Top-5 约 2000-3000 token，若遇超长法规条款，5 条是否仍会截断关键上下文，有无父子块补偿？
  - **答**：会截断，用父子块补偿：
    - 检索 Top-5 子块命中后，生成时回拉父块（整章）补充上下文。
    - 或对超长条款建"长文档"检索模式提高 limit；关键条款也可 Long Context 直读。


### 20. 如何组装Prompt（检索结果+System Prompt）？
**重要度**：★★★★★

**设计思路（口头表述）**：组装 Prompt 我按 **System-Context-User 三段式**组织，每段职责分离。**System** 定角色和规则（碳管理专家、严格基于检索、不编造、引用来源、不足时拒答）——这是"指令层"，约束模型行为。**Context** 放检索结果，每段带来源标注（文档名-章节），让引用可追溯——这是"资料层"，只供参考不当指令执行。**User** 放用户原始问题——这是"任务层"。关键设计：
  - ① 检索内容只进 Context 不进 System，避免资料污染指令
  - ② 强制引用来源便于事后核查幻觉
  - ③ 不足时明确拒答而非编造，这是碳管理合规场景的红线
  - 一句话："系统指令管规则、检索上下文管资料、用户消息管任务，三者分层不混"。

```
[System]
你是碳管理领域的专业AI助手，服务于积木LCA云平台。请基于以下检索到的知识回答用户问题。
要求：
1. 严格基于检索内容回答，不编造信息。
2. 如果检索内容不足以回答，请明确告知"当前知识库中暂无相关信息"。
3. 回答中引用来源，格式：[来源：文档名-章节]。
4. 涉及具体数据时，标注数据来源和适用条件。

[Context]
=== 检索结果 1 ===
来源：ISO 14067:2018 第5.3节
内容：产品碳足迹量化方法应遵循ISO 14040和ISO 14044中规定的LCA原则和框架...

=== 检索结果 2 ===
来源：GB/T 24067-2024 第4.1条
内容：产品碳足迹是指产品全生命周期中温室气体排放和清除的总和...

[User]
什么是产品碳足迹？计算时需要遵循哪些标准？
```

#### 追问：
- 追问1：System Prompt要求"标注来源[文档名-章节]"，但当多条检索结果互相矛盾时，Prompt有没有指示模型做冲突声明而非简单拼接？
  - **答**：Prompt需显式指示“当多个来源矛盾时，列出各方观点并说明差异，不强行合并，提示用户以最新/权威版本为准”；生成后处理检测矛盾来源并加冲突提示。
- 追问2：检索结果按什么顺序填入Context——相似度降序还是按文档权威度（ISO优先于企业手册），顺序是否影响回答质量？
  - **答**：建议按“权威度+相似度”综合排序（ISO/国标优先于手册，同权重内按相似度降序），因权威来源放前更易被模型采信（减少Lost-in-middle）；顺序确实影响质量，关键片段靠前。


### 21. RAG的离线索引构建流程是什么？
**重要度**：★★★★

1. **文档采集**：从文件系统/数据库/网络爬取原始文档。
2. **文档解析**：POI/PDFBox 解析为纯文本，提取标题、段落结构。
3. **文本清洗**：去除页眉页脚、目录、空白页等噪声内容。
4. **分块**：按章节语义分块 + 固定长度兜底。
5. **元数据标注**：为每个 chunk 标注来源文档、章节、页码、文档类型。
6. **向量化**：批量调用 Embedding 模型。
7. **入库**：存入 Milvus，建立 HNSW 索引。
8. **验证**：抽样检索验证索引质量。

#### 追问：
- 追问1：文本清洗去除页眉页脚时，会不会误删ISO标准里恰好在页脚的关键版本号（如"2018版"）？
  - **答**：清洗规则加白名单保护：保留含版本号/日期的页脚行（正则匹配“20xx版”“Edition”），或解析时先抽文档元数据（标题页版本）存全局metadata不依赖页脚；抽样校验防误删。
- 追问2：入库后"抽样检索验证"是人工抽查还是有自动化回归集，能否在CI里跑以防止分块逻辑改动引入退化？
  - **答**：建议自动化。建固定回归检索集（问题→期望chunk），CI每次分块逻辑改动后跑比对Recall@K是否退化；人工抽查作补充，纳入流水线门禁。


### 22. 文档解析（PDF/Word/TXT）在Java中如何实现？
**重要度**：★★★★

| 格式           | 库                     | 说明           |
| ------------ | --------------------- | ------------ |
| PDF          | Apache PDFBox / iText | 提取文本、图片、表格   |
| Word(.docx)  | Apache POI (XWPF)     | 提取段落、表格、样式   |
| Excel(.xlsx) | Apache POI (XSSF)     | 提取单元格数据      |
| TXT          | Java IO               | 直接读取         |
| HTML         | Jsoup                 | 解析 HTML，提取正文 |

**碳管家助手实现**：

```java
// PDF 解析（保留页码信息）——PDFBox 3.x，用 Loader.loadPDF
PDDocument doc = Loader.loadPDF(new File("iso14067.pdf"));
PDFTextStripper stripper = new PDFTextStripper();
for (int i = 1; i <= doc.getNumberOfPages(); i++) {
    stripper.setStartPage(i);
    stripper.setEndPage(i);
    String pageText = stripper.getText(doc);
    // 存储为 TextSegment，元数据包含 pageNum
}
```


#### 三种框架实现对比

##### Spring AI 1.0 实现

```java
package com.carbon.guard.etl;

import org.apache.pdfbox.pdmodel.PDDocument;
import org.apache.pdfbox.text.PDFTextStripper;
import org.apache.poi.xwpf.extractor.XWPFWordExtractor;
import org.apache.poi.xwpf.usermodel.XWPFDocument;
import org.springframework.ai.document.Document;
import org.springframework.ai.transformer.splitter.TokenTextSplitter;
import org.springframework.ai.vectorstore.VectorStore;

import java.io.IOException;
import java.io.InputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;

/**
 * 碳管家 ETL：文档解析（PDF/Word/TXT）→ 分块 → 向量库。
 * 关键决策：按页/按段保留来源元数据，回答时才能给出"第X条/第X页"的可溯源引用。
 */
public class DocumentIngestService {

    private final VectorStore vectorStore;

    public DocumentIngestService(VectorStore vectorStore) {
        this.vectorStore = vectorStore;
    }

    /** PDF 解析：逐页提取，页码写入 metadata */
    public List<Document> parsePdf(Path pdfPath) throws IOException {
        List<Document> documents = new ArrayList<>();
        // PDFBox 2.x 写法；3.x 已移除 PDDocument.load，改 Loader.loadPDF(pdfPath.toFile())
        try (PDDocument doc = PDDocument.load(Files.readAllBytes(pdfPath))) {
            PDFTextStripper stripper = new PDFTextStripper();
            for (int i = 1; i <= doc.getNumberOfPages(); i++) {
                stripper.setStartPage(i);
                stripper.setEndPage(i);
                String pageText = stripper.getText(doc);
                if (pageText.isBlank()) {
                    continue;
                }
                documents.add(new Document(pageText, java.util.Map.of(
                        "source", pdfPath.getFileName() + "#page=" + i,
                        "docType", "STANDARD",
                        "pageNum", i)));
            }
        }
        return documents;
    }

    /** Word(.docx) 解析：整篇提取，段落边界天然保留 */
    public List<Document> parseWord(Path docxPath) throws IOException {
        try (InputStream in = Files.newInputStream(docxPath);
             XWPFDocument doc = new XWPFDocument(in);
             XWPFWordExtractor extractor = new XWPFWordExtractor(doc)) {
            String text = extractor.getText();
            return List.of(new Document(text, java.util.Map.of(
                    "source", docxPath.getFileName().toString(),
                    "docType", "STANDARD")));
        }
    }

    /** TXT 解析：直接 IO 读取 */
    public List<Document> parseTxt(Path txtPath) throws IOException {
        String text = Files.readString(txtPath);
        return List.of(new Document(text, java.util.Map.of(
                "source", txtPath.getFileName().toString(),
                "docType", "FAQ")));
    }

    /** 切分后入库：chunk=500 token，overlap=50，避免条款被拦腰截断 */
    public int ingest(List<Document> documents) {
        TokenTextSplitter splitter = TokenTextSplitter.builder()
                .withChunkSize(500)
                .withMinChunkSizeChars(350)
                .withMinChunkLengthToEmbed(10)
                .withKeepSeparator(true)
                .build();

        List<Document> chunks = splitter.apply(documents);
        vectorStore.add(chunks);
        return chunks.size();
    }
}
```

##### Spring AI 2.0 实现

```java
package com.carbon.guard.etl;

import org.apache.pdfbox.pdmodel.PDDocument;
import org.apache.pdfbox.text.PDFTextStripper;
import org.apache.poi.xwpf.extractor.XWPFWordExtractor;
import org.apache.poi.xwpf.usermodel.XWPFDocument;
import org.springframework.ai.document.Document;
import org.springframework.ai.transformer.splitter.TokenTextSplitter;
import org.springframework.ai.vectorstore.VectorStore;

import java.io.IOException;
import java.io.InputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;

/**
 * 碳管家 ETL：Spring AI 2.0（Java 21，可用 record + switch 表达式 + 文本块）。
 * 2.0 解析层与 1.0 一致（都是 Apache PDFBox/POI），差异在切分与入库 API。
 */
public class DocumentIngestService {

    private final VectorStore vectorStore;

    public DocumentIngestService(VectorStore vectorStore) {
        this.vectorStore = vectorStore;
    }

    /** 按扩展名路由解析器：不同格式走不同解析策略 */
    public List<Document> parse(Path path) throws IOException {
        return switch (path.getFileName().toString().toLowerCase().split("\\.")[1]) {
            case "pdf" -> parsePdf(path);
            case "docx" -> parseWord(path);
            case "txt" -> parseTxt(path);
            default -> throw new IllegalArgumentException("不支持的格式: " + path);
        };
    }

    /** PDF：逐页提取并保留页码，跨栏乱序问题用 PDFTextStripperByArea 兜底 */
    public List<Document> parsePdf(Path pdfPath) throws IOException {
        List<Document> documents = new ArrayList<>();
        // PDFBox 2.x 写法；3.x 已移除 PDDocument.load，改 Loader.loadPDF(pdfPath.toFile())
        try (PDDocument doc = PDDocument.load(Files.readAllBytes(pdfPath))) {
            PDFTextStripper stripper = new PDFTextStripper();
            for (int i = 1; i <= doc.getNumberOfPages(); i++) {
                stripper.setStartPage(i);
                stripper.setEndPage(i);
                String pageText = stripper.getText(doc);
                if (!pageText.isBlank()) {
                    documents.add(new Document(pageText, Map.of(
                            "source", pdfPath.getFileName() + "#page=" + i,
                            "docType", "STANDARD")));
                }
            }
        }
        return documents;
    }

    /** Word：整篇提取 */
    public List<Document> parseWord(Path docxPath) throws IOException {
        try (InputStream in = Files.newInputStream(docxPath);
             XWPFDocument doc = new XWPFDocument(in);
             XWPFWordExtractor extractor = new XWPFWordExtractor(doc)) {
            return List.of(new Document(extractor.getText(), Map.of(
                    "source", docxPath.getFileName().toString(),
                    "docType", "STANDARD")));
        }
    }

    /** TXT：直接 IO */
    public List<Document> parseTxt(Path txtPath) throws IOException {
        return List.of(new Document(Files.readString(txtPath), Map.of(
                "source", txtPath.getFileName().toString(),
                "docType", "FAQ")));
    }

    /** 切分入库：2.0 的 TokenTextSplitter 参数名与 1.0 一致 */
    public int ingest(List<Document> documents) {
        TokenTextSplitter splitter = TokenTextSplitter.builder()
                .withChunkSize(500)
                .withMinChunkSizeChars(350)
                .withMinChunkLengthToEmbed(10)
                .withKeepSeparator(true)
                .build();
        List<Document> chunks = splitter.apply(documents);
        vectorStore.add(chunks);
        return chunks.size();
    }
}
```

##### LangChain4j 实现

```java
package com.carbon.guard.etl;

import dev.langchain4j.data.document.Document;
import dev.langchain4j.data.document.DocumentSplitter;
import dev.langchain4j.data.document.Metadata;
import dev.langchain4j.data.document.splitter.DocumentSplitters;
import dev.langchain4j.data.segment.TextSegment;
import dev.langchain4j.model.embedding.EmbeddingModel;
import dev.langchain4j.store.embedding.EmbeddingStore;
import dev.langchain4j.store.embedding.EmbeddingStoreIngestor;

import org.apache.pdfbox.pdmodel.PDDocument;
import org.apache.pdfbox.text.PDFTextStripper;
import org.apache.poi.xwpf.extractor.XWPFWordExtractor;
import org.apache.poi.xwpf.usermodel.XWPFDocument;

import java.io.IOException;
import java.io.InputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;

/**
 * 碳管家 ETL：LangChain4j 1.0。
 * 解析产出 Document，切分+向量化+入库由 EmbeddingStoreIngestor 一条龙完成。
 */
public class DocumentIngestService {

    private final EmbeddingStore<TextSegment> embeddingStore;
    private final EmbeddingModel embeddingModel;

    public DocumentIngestService(EmbeddingStore<TextSegment> embeddingStore,
                                 EmbeddingModel embeddingModel) {
        this.embeddingStore = embeddingStore;
        this.embeddingModel = embeddingModel;
    }

    /** PDF：逐页提取，页码写进 metadata */
    public List<Document> parsePdf(Path pdfPath) throws IOException {
        List<Document> documents = new ArrayList<>();
        // PDFBox 2.x 写法；3.x 已移除 PDDocument.load，改 Loader.loadPDF(pdfPath.toFile())
        try (PDDocument doc = PDDocument.load(Files.readAllBytes(pdfPath))) {
            PDFTextStripper stripper = new PDFTextStripper();
            for (int i = 1; i <= doc.getNumberOfPages(); i++) {
                stripper.setStartPage(i);
                stripper.setEndPage(i);
                String pageText = stripper.getText(doc);
                if (!pageText.isBlank()) {
                    // Document.from 只有 (text) / (text, metadata) 两个签名，
                    // 来源文件名通过 metadata 承载，不放在 name 上
                    documents.add(Document.from(pageText,
                            Metadata.from(Map.of(
                                    "source", pdfPath.getFileName() + "#page=" + i,
                                    "docType", "STANDARD"))));
                }
            }
        }
        return documents;
    }

    /** Word：整篇提取 */
    public List<Document> parseWord(Path docxPath) throws IOException {
        try (InputStream in = Files.newInputStream(docxPath);
             XWPFDocument doc = new XWPFDocument(in);
             XWPFWordExtractor extractor = new XWPFWordExtractor(doc)) {
            return List.of(Document.from(extractor.getText(),
                    Metadata.from(Map.of(
                            "source", docxPath.getFileName().toString(),
                            "docType", "STANDARD"))));
        }
    }

    /** TXT：直接 IO */
    public List<Document> parseTxt(Path txtPath) throws IOException {
        return List.of(Document.from(Files.readString(txtPath),
                Metadata.from(Map.of(
                        "source", txtPath.getFileName().toString(),
                        "docType", "FAQ"))));
    }

    /** 切分+向量化+入库：recursive(500, 50) 即 chunk=500、overlap=50 */
    public void ingest(List<Document> documents) {
        DocumentSplitter splitter = DocumentSplitters.recursive(500, 50);
        EmbeddingStoreIngestor ingestor = EmbeddingStoreIngestor.builder()
                .documentSplitter(splitter)
                .embeddingModel(embeddingModel)
                .embeddingStore(embeddingStore)
                .build();
        ingestor.ingest(documents);
    }
}
```

#### 追问：
- 追问1：ISO标准PDF里的公式、上下标和表格用PDFBox提取常会乱码或丢失，碳管家助手如何保证这些关键数值被准确入库？
  - **答**：
    - ① PDFBox提取文本同时保留表格坐标，公式转文本/图片OCR
    - ② 关键数值（排放因子）规则抽取为结构化字段独立建索引，原文chunk附图片引用
    - ③ 入库前人工抽检公式完整性
- 追问2：按页码存元数据对长标准文档很有用，但PDFBox跨栏排版的文本顺序错乱问题你们是怎么处理的？
  - **答**：PDFBox默认按阅读顺序可能错乱。处理：用PDFTextStripperByArea按栏区域分块提取，或pdflayout等保序解析；跨栏表格按坐标重排后再分块，保证语义连续。


### 23. 如何评估RAG系统的检索质量？
**重要度**：★★★★★

检索质量是 RAG 系统的命脉——检索不到正确的知识，大模型再强也"巧妇难为无米之炊"。完整指标体系如下：

**核心指标**：
1. **召回率（Recall@K）**：Top-K 检索结果中包含"正确答案所在 chunk"的比例。计算方式：准备标注集（每个 query 标注正确答案所在 chunk），统计 Top-K 命中的比例。碳管家全链优化后 Recall@5 = 95%（纯向量 Top-5 基线 82%）。
2. **精确率（Precision@K）**：Top-K 检索结果中相关 chunk 占比。碳管家 Precision@5 = 72%（Top-5 中平均 3.6 个相关）。
3. **MRR（Mean Reciprocal Rank）**：第一个相关结果位置倒数的均值。碳管家 MRR = 0.79（平均第一个相关结果在第 1.3 位）。
4. **NDCG（Normalized Discounted Cumulative Gain）**：考虑相关度等级和位置的排序质量指标。碳管家 NDCG@5 = 0.82。**碳管理场景建议以 NDCG 为主指标**——用户答案常需多条片段共同支撑，NDCG 考虑多级相关与位置权重，比只关心首个命中的 MRR 更全面，MRR 作辅助。

**评估方法**：
- **标注集构建**：从真实用户 query 中抽样——300 条由碳管理专家人工标注做基线，稳定后扩充到 500 条做回归；每条 query 标注正确答案 chunk 和相关度等级（完全相关/部分相关/不相关）。
- **自动评估**：用 RAGAS 框架（Faithfulness、Answer Relevancy、Context Recall、Context Precision）做自动化评测，每日跑回归。
- **A/B 对比**：每次检索策略变更（调整 HNSW 参数、更换 Embedding 模型、换 Reranker）都做 A/B 测试，对比新旧指标。

**碳管家指标（优化后）**：Recall@5=95%, Precision@5=72%, MRR=0.79, NDCG@5=0.82；端到端准确率 92%（基线 75%，纯向量 Top-5）。**读这组数要注意方向**：Recall@5 ≥ 端到端，前者是后者的上限，两个 92% 与 95% 不是同一个指标，别混着说。

#### 追问：
- 追问1：全链 Recall@5=95% 是基于扩充后的 500 条标注集，标注集本身的覆盖偏差（如偏重法规类）会不会高估真实线上的召回率？
  - **答**：会，偏差与缓解如下：
    - 若标注集偏重法规类而线上"因子查询/计算"占比更高，整体 Recall 可能被乐观估计。
    - 缓解：按线上真实意图分布分层加权抽样，定期用线上真实 query 补充标注，缩小分布差。
    - 同时看分意图 Recall，对任何偏低子类的真实召回不盲目信总体 95%。
- 追问2：端到端准确率 92% 与 Faithfulness 94% 是什么关系，检索对了但生成仍错的情况在剩余 8% 里占比多少，如何归因？
  - **答**：两项指标口径不同，不能互相印证：
    - 端到端准确率 = 检索正确且生成正确的比例（分母是所有题，含检索失败的）；Faithfulness 只衡量"生成是否忠实于 context"，分母是已生成的答案。
    - 剩余 8% 中"检索对但生成错"属幻觉/组织失败，需用 Bad Case 分类量化占比（碳管家实测约一半）。
    - 归因：拉 trace 看是 Prompt 约束弱、置信度未拦截、还是数值校验漏过，针对性修 Prompt/阈值/后处理。
- 追问3：RAGAS 每日跑回归，如果某次检索策略变更让 Recall 升但 NDCG 降（相关项排名靠后），以哪个指标为优先决策依据？
  - **答**：以端到端准确率为最终判据，而非单一排序指标：
    - Recall 升、NDCG 降要看是否影响 Top-5 精排后的结果。
    - 因有 Re-ranking 兜底，召回升往往利好最终；NDCG 降若只发生在 5 名之后、不影响送入 LLM 的 Top-5，则可接受。
    - 决策：对比 A/B 的线上准确率与成本，优先保 Recall 与最终准确率，排序质量由 Reranker 补偿。
- 追问4：碳法规场景下"正确答案"是否唯一，同一问题不同权威来源给出不同因子时如何定义 ground truth？
  - **答**：未必唯一，标注允许多标签：
    - 多个权威来源均标正例，评估用集合匹配而非单一匹配。
    - 来源冲突时以"最新生效版本"或"官方发布"为准，评测集注明适用版本。


### 24. 如何评估RAG系统的生成质量？
**重要度**：★★★★

**生成质量评估框架（RAGAS 的生成侧指标）**：

- **Faithfulness（忠实度）**：回答是否忠于检索内容，没有幻觉。做法是把答案拆成原子陈述，逐条验证能否从 context 推出。
- **Answer Relevancy（回答相关性）**：回答是否切题，衡量是否答非所问。
- **Answer Correctness（答案正确性）**：与参考答案比对事实与语义，补上"忠实但答错"的盲区。
- **Noise Robustness（噪声鲁棒性）**：context 里混入无关片段时，回答是否仍不被带偏。

> 注意别把 **Context Precision / Context Recall** 归到生成侧——这两个衡量的是"检索回来的上下文准不准、全不全"，属**检索评估**（见第 23 题，第 58 题有完整指标表）。生成侧只看"拿到上下文之后答得好不好"。

**评估方法**：

- 自动评估：用通义千问 qwen-max 作为裁判，对生成答案进行评分。
- 人工评估：碳管理领域专家对 100 条问答进行 1-5 分打分。
- 用户反馈：点赞/点踩 + 评论，收集线上真实质量数据。

#### 追问：
- 追问1：用通义千问 qwen-max 当裁判评估碳管理答案，会不会出现裁判模型本身不懂LCA方法学而误判，是否应换领域微调模型或专家复核？
  - **答**：通义千问可能不熟LCA。缓解：用领域微调小模型做辅助裁判、关键样本专家复核抽检、RAGAS多用可计算项（Faithfulness用上下文蕴含校验）减少纯LLM裁判依赖。
- 追问2：Faithfulness指标若发现大模型把"1.89 tCO2e/t粗钢"说成"约2.0"，这种数值近似在你的评测里算幻觉还是可接受？
  - **答**：视精度要求。排放因子等关键数值“1.89→约2.0”偏差约6%，建议判不忠实/告警（涉合规）；设相对误差阈值（如<5%容忍，超则标幻觉），通用描述性近似可接受。


### 25. RAG中的Re-ranking（重排）是什么？为什么需要？
**重要度**：★★★★★

**Re-ranking**：对初步检索的 Top-K 结果用更精确的模型重新排序，选出最相关的 Top-N。

**为什么需要**：

- 向量检索（双塔模型）速度快但精度有限，适合召回阶段。
- Re-ranking（Cross-Encoder 模型）将问题和文档拼接后做精细匹配，精度更高但速度慢。
- 两阶段策略：召回（快）→ 重排（准），平衡速度和精度。

**碳管家助手实现**：

- 召回：Milvus 检索 Top-20（< 50ms）。
- 重排：bge-reranker-large 对 20 个结果重排（CPU 约 300~400ms，GPU < 100ms），取 Top-5。
- 效果归因要分清：**重排单独贡献约 +5pt（端到端 75% → 80%）**，整链 75% → 92% 是"重排 + 改写 + 多路召回 + 分块 + 幻觉控制"的合计（见第 60 题分阶段拆解）。检索链路总耗时 < 500ms（GPU 可压到 < 150ms）。

#### 追问：
- 追问1：Re-ranking 单独把端到端从 75% 提到 80%，这个基线是在什么测试集上测的，是否覆盖了中英混合法规这种难例？
  - **答**：基线是 300 条人工标注的端到端回归集（纯向量 Top-5、无重排），且要求含 ≥20% 中英混合法规难例（ISO/CBAM 中英文条款），否则 75%→80% 不具代表性；选型重排模型时用难例加权评估，避免只在国内法规上刷分。
- 追问2：召回Top-20到重排取Top-5，如果前20里根本没有正确答案（漏召回），重排再强也无法补救，如何兜底？
  - **答**：重排无法补救漏召回。兜底：提高召回Top-K（如Top-30）扩大候选、多路召回（向量+BM25+图谱）互补减少漏检、置信度低时触发查询改写/补充检索或拒答、监控空结果率。


### 26. 多路召回在RAG中如何实现？
**重要度**：★★★★

**多路召回策略**：

1. **向量召回**：Embedding + Milvus 语义检索 Top-20。
2. **关键词召回**：ElasticSearch BM25 检索 Top-20。
3. **结构化查询**：MySQL 精确匹配（如碳排放因子数据查询）。
4. **混合合并**：RRF（Reciprocal Rank Fusion）算法融合多路结果排序。

**为什么多路召回**：向量检索擅长语义匹配但可能遗漏精确匹配的关键词；BM25 擅长关键词匹配但不理解语义。两者互补。


#### 三种框架实现对比

##### Spring AI 1.0 实现

```java
package com.carbon.guard.rag;

import co.elastic.clients.elasticsearch.ElasticsearchClient;
import co.elastic.clients.elasticsearch.core.SearchResponse;
import org.springframework.ai.chat.client.ChatClient;
import org.springframework.ai.chat.model.ChatModel;
import org.springframework.ai.document.Document;
import org.springframework.ai.vectorstore.SearchRequest;
import org.springframework.ai.vectorstore.VectorStore;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.stream.Collectors;

/**
 * 碳管家多路召回：向量(语义) + BM25(关键词) + MySQL(结构化因子) → RRF 融合。
 * RRF 公式：score(d) = Σ 1/(k + rank_i)，k=60；不依赖两路分数量纲。
 */
public class MultiRouteRecallService {

    private static final int RECALL_K = 20;
    private static final int RRF_K = 60;

    private final VectorStore vectorStore;
    private final ElasticsearchClient esClient;
    private final EmissionFactorRepository factorRepository;
    private final ChatClient chatClient;

    public MultiRouteRecallService(VectorStore vectorStore,
                                   ElasticsearchClient esClient,
                                   EmissionFactorRepository factorRepository,
                                   ChatModel chatModel) {
        this.vectorStore = vectorStore;
        this.esClient = esClient;
        this.factorRepository = factorRepository;
        this.chatClient = ChatClient.create(chatModel);
    }

    /** 三路召回 + RRF 融合 */
    public List<Document> recall(String userQuery) {
        // 1) 向量路：擅长语义（"碳足迹" ≈ "温室气体排放"）
        List<Document> vectorHits = vectorStore.similaritySearch(SearchRequest.builder()
                .query(userQuery)
                .topK(RECALL_K)
                .similarityThreshold(0.5)
                .build());

        // 2) 关键词路：擅长精确匹配（"ISO 14064-1:2018"）
        //    ES Java Client 没有 search(String, int) 便捷方法，必须构造 SearchRequest，
        //    返回的 SearchResponse 也不是 Spring AI 的 Document，要显式映射
        List<Document> keywordHits = keywordSearch(userQuery, RECALL_K);

        // 3) 结构化路：排放因子数值直查权威库
        List<Document> factorHits = factorRepository.queryFactors(userQuery);

        return rrfFuse(List.of(vectorHits, keywordHits, factorHits));
    }

    /** ES BM25 关键词召回：lambda 构造请求 + 显式映射 */
    private List<Document> keywordSearch(String userQuery, int size) {
        try {
            SearchResponse<Map> resp = esClient.search(s -> s
                            .index("carbon_docs")
                            .query(q -> q.multiMatch(m -> m
                                    .fields("title", "text")
                                    .query(userQuery)))
                            .size(size),
                    Map.class);
            return resp.hits().hits().stream()
                    .map(h -> new Document(h.id(), String.valueOf(h.source().get("text"))))
                    .collect(Collectors.toList());
        } catch (Exception e) {
            return List.of();   // 关键词路异常时退化为纯向量召回
        }
    }

    /** RRF 融合：同名文档在各路排名的倒数之和即为最终分 */
    private List<Document> rrfFuse(List<List<Document>> routes) {
        Map<String, Double> scores = new HashMap<>();
        Map<String, Document> pool = new LinkedHashMap<>();
        for (List<Document> route : routes) {
            for (int i = 0; i < route.size(); i++) {
                Document d = route.get(i);
                String id = d.getId() != null ? d.getId() : d.getText().hashCode() + "";
                scores.merge(id, 1.0 / (RRF_K + i + 1), Double::sum);
                pool.putIfAbsent(id, d);
            }
        }
        return scores.entrySet().stream()
                .sorted(Map.Entry.<String, Double>comparingByValue().reversed())
                .map(e -> pool.get(e.getKey()))
                .limit(5)
                .collect(Collectors.toList());
    }

    /** 生成：结构化因子以"权威直查"身份置顶，不与向量路混排打分 */
    public String ask(String userQuery) {
        List<Document> docs = recall(userQuery);
        String context = docs.stream()
                .map(d -> d.getMetadata().containsKey("sourceType")
                        ? "[权威直查] " + d.getText()
                        : d.getText())
                .collect(Collectors.joining("\n\n"));
        return chatClient.prompt()
                .system("你是碳管理专家助手。标注[权威直查]的数值优先采信，其余依据检索内容回答。")
                .user(u -> u.text("<参考资料>\n{ctx}\n</参考资料>\n\n问题：{q}")
                        .param("ctx", context).param("q", userQuery))
                .call()
                .content();
    }
}
```

##### Spring AI 2.0 实现

```java
package com.carbon.guard.rag;

import co.elastic.clients.elasticsearch.ElasticsearchClient;
import co.elastic.clients.elasticsearch.core.SearchResponse;
import org.springframework.ai.chat.client.ChatClient;
import org.springframework.ai.chat.model.ChatModel;
import org.springframework.ai.document.Document;
import org.springframework.ai.openai.OpenAiChatOptions;
import org.springframework.ai.tool.ToolCallback;
import org.springframework.ai.tool.function.FunctionToolCallback;
import org.springframework.ai.vectorstore.SearchRequest;
import org.springframework.ai.vectorstore.VectorStore;

import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.stream.Collectors;

/**
 * 碳管家多路召回：Spring AI 2.0。
 * 2.0 的 ToolCallingAdvisor 由 ChatClient 自动注册，可让模型自己调结构化查询工具。
 */
public class MultiRouteRecallService {

    private static final int RECALL_K = 20;
    private static final int RRF_K = 60;

    private final VectorStore vectorStore;
    private final ElasticsearchClient esClient;
    private final ChatClient chatClient;
    /** 2.0：工具必须显式声明并注册，不能只写 @Tool 注解 */
    private final ToolCallback lookupEmissionFactorTool;

    public MultiRouteRecallService(VectorStore vectorStore,
                                   ElasticsearchClient esClient,
                                   EmissionFactorRepository factorRepository,
                                   ChatModel chatModel) {
        this.vectorStore = vectorStore;
        this.esClient = esClient;
        this.chatClient = ChatClient.create(chatModel);
        this.lookupEmissionFactorTool = FunctionToolCallback
                .builder("lookupEmissionFactor", (String args) -> factorRepository.queryFactors(args))
                .description("按行业/地区/年份查询权威排放因子，返回 JSON")
                .inputType(String.class)
                .build();
    }

    /** 两路文本召回 + RRF 融合；结构化路改成工具，交给模型按需调用 */
    public List<Document> recall(String userQuery) {
        List<Document> vectorHits = vectorStore.similaritySearch(SearchRequest.builder()
                .query(userQuery)
                .topK(RECALL_K)
                .similarityThreshold(0.5)
                .build());

        List<Document> keywordHits = keywordSearch(userQuery, RECALL_K);

        return rrfFuse(List.of(vectorHits, keywordHits));
    }

    /** ES 没有 search(String, int) 便捷方法：构造 SearchRequest 再显式映射 */
    private List<Document> keywordSearch(String userQuery, int size) {
        try {
            SearchResponse<Map> resp = esClient.search(s -> s
                            .index("carbon_docs")
                            .query(q -> q.multiMatch(m -> m
                                    .fields("title", "text")
                                    .query(userQuery)))
                            .size(size),
                    Map.class);
            return resp.hits().hits().stream()
                    .map(h -> new Document(h.id(), String.valueOf(h.source().get("text"))))
                    .collect(Collectors.toList());
        } catch (Exception e) {
            return List.of();
        }
    }

    /** RRF：按各路排名倒数加权求和，再按总分降序 */
    private List<Document> rrfFuse(List<List<Document>> routes) {
        Map<String, Double> scores = new HashMap<>();
        Map<String, Document> pool = new LinkedHashMap<>();
        for (List<Document> route : routes) {
            for (int i = 0; i < route.size(); i++) {
                Document d = route.get(i);
                String id = d.getId() != null ? d.getId() : d.getText().hashCode() + "";
                scores.merge(id, 1.0 / (RRF_K + i + 1), Double::sum);
                pool.putIfAbsent(id, d);
            }
        }
        return scores.entrySet().stream()
                .sorted(Map.Entry.<String, Double>comparingByValue().reversed())
                .map(e -> pool.get(e.getKey()))
                .limit(5)
                .collect(Collectors.toList());
    }

    /**
     * 生成：结构化因子查询注册为 ToolCallback，
     * 2.0 的 ToolCallingAdvisor 自动完成"模型调用工具 → 回填结果 → 再生成"整个往返。
     */
    public String ask(String userQuery) {
        List<Document> docs = recall(userQuery);
        String context = docs.stream().map(Document::getText).collect(Collectors.joining("\n\n"));

        return chatClient.prompt()
                // 2.0：传 Builder
                .options(OpenAiChatOptions.builder().temperature(0.2))
                .system("你是碳管理专家助手。查询排放因子数值时必须调用 lookupEmissionFactor 工具。")
                .user(u -> u.text("<参考资料>\n{ctx}\n</参考资料>\n\n问题：{q}")
                        .param("ctx", context).param("q", userQuery))
                .toolCallbacks(lookupEmissionFactorTool)
                .call()
                .content();
    }
}
```

##### LangChain4j 实现

```java
package com.carbon.guard.rag;

import dev.langchain4j.data.segment.TextSegment;
import dev.langchain4j.model.chat.ChatModel;
import dev.langchain4j.rag.content.Content;
import dev.langchain4j.rag.content.aggregator.ReciprocalRankFuser;
import dev.langchain4j.rag.content.retriever.ContentRetriever;
import dev.langchain4j.rag.content.retriever.EmbeddingStoreContentRetriever;
import dev.langchain4j.rag.query.Query;
import dev.langchain4j.service.AiServices;
import dev.langchain4j.service.SystemMessage;
import dev.langchain4j.service.V;

import java.util.List;

/**
 * 碳管家多路召回：LangChain4j 1.0。
 * 1.x 内置 ReciprocalRankFuser.fuse(lists)，正是 RRF 算法；k 在实现里固定为 60，
 * 没有接收 k 的重载（要可调 k 就自己写循环）。
 */
public class MultiRouteRecallService {

    public interface CarbonAssistant {
        @SystemMessage("你是碳管理专家助手，依据检索到的知识回答。")
        String chat(@V("question") String question);
    }

    private final CarbonAssistant assistant;
    private final ContentRetriever vectorRetriever;
    private final ContentRetriever keywordRetriever;

    public MultiRouteRecallService(ChatModel chatModel,
                                   EmbeddingStore<TextSegment> embeddingStore,
                                   EmbeddingModel embeddingModel,
                                   ContentRetriever keywordRetriever) {
        // 路1：向量语义召回
        this.vectorRetriever = EmbeddingStoreContentRetriever.builder()
                .embeddingStore(embeddingStore)
                .embeddingModel(embeddingModel)
                .maxResults(20)
                .minScore(0.5)
                .build();
        // 路2：ES BM25 关键词召回（自定义 ContentRetriever）
        this.keywordRetriever = keywordRetriever;

        this.assistant = AiServices.builder(CarbonAssistant.class)
                .chatModel(chatModel)
                .build();
    }

    /** 多路召回 + RRF 融合：fuse(List<List<Content>>) 只有一个参数，k 内部固定 60 */
    public List<Content> recall(String userQuery) {
        List<Content> vectorHits = vectorRetriever.retrieve(Query.from(userQuery));
        List<Content> keywordHits = keywordRetriever.retrieve(Query.from(userQuery));

        // 不要传第二个参数：没有 fuse(lists, k) 这个重载
        return ReciprocalRankFuser.fuse(List.of(vectorHits, keywordHits));
    }

    /** 生成：融合后的片段拼进上下文 */
    public String ask(String userQuery) {
        List<Content> fused = recall(userQuery);
        String context = fused.stream()
                .map(c -> c.textSegment().text())
                .limit(5)
                .reduce((a, b) -> a + "\n\n" + b)
                .orElse("");
        return assistant.chat(userQuery + "\n\n<参考资料>\n" + context + "\n</参考资料>");
    }
}
```

#### 追问：
- 追问1：RRF融合里向量召回和BM25召回的权重固定为均等吗，碳管家助手对"ISO编号"类精确查询是否应动态调高关键词路权重？
  - **答**：不必均等。含标准编号的精确查询动态调高BM25权重（如关键词0.7），语义类调高向量权重；用Self-Query识别编号后在RRF合并时加权。
- 追问2：结构化查询走MySQL查排放因子，与向量召回的结果如何统一排序进同一个Context，类型不一致如何融合打分？
  - **答**：统一打分难。做法：结构化因子结果以“权威直查”身份直接置顶Context不与其他混排；向量/BM25用RRF融合后接其后；或把因子也向量化参与统一RRF但标注来源类型。


### 27. 如何控制RAG的幻觉问题？
**重要度**：★★★★

1. **Prompt 约束**：明确要求"仅基于检索内容回答，不确定时告知用户"。
2. **引用标注**：要求回答中标注来源，便于验证。
3. **后处理校验**：检查生成回答中的关键事实是否能在检索内容中找到对应。
4. **置信度阈值**：检索相似度低于阈值时，不调用大模型，直接返回"未找到相关信息"。
5. **Temperature 降参**：RAG 场景用低 Temperature（0.1-0.3），减少随机性。

#### 追问：
- 追问1：置信度阈值直接拒绝回答会降低用户体验，碳管家助手有没有用"检索到部分信息时先给限定范围回答"的折中策略？
  - **答**：有。当检索到部分相关且置信度中等，返回“基于现有资料，X方面可确定…，但Y暂无明确依据”并附来源，而非直接拒答，兼顾体验与严谨。
- 追问2：后处理校验关键事实是否在上下文里，这个校验本身用大模型做会不会引入第二层幻觉，是否用规则/精确匹配更稳？
  - **答**：建议规则/精确匹配为主。对关键数值、来源编号做字符串/正则比对（是否在Context出现），避免再引入大模型二层幻觉；仅模糊语义一致性可用轻量模型辅助，关键事实走确定性校验。


### 28. 知识库更新频率对RAG系统有什么影响？
**重要度**：★★★★

**先按知识类型定频率**，不同更新节奏对应不同工程方案：
- **更新频繁**（碳法规月更）：必须做增量索引，避免每次全量重建。
- **更新不频繁**（ISO 标准年更）：可低频全量重建。
- **实时性要求高**（碳排放因子动态更新）：需实时索引同步。

**更新场景**：碳管理领域知识更新频繁——ISO 标准换版（如 ISO 14064-1:2018 替代 2006 版；ISO 14067 现行仍是 2018 版，需持续跟进其修订案而非臆造新版号）、CBAM 法规更新（欧盟每季度修订执行细则）、国家碳排放因子库更新（生态环境部年度更新）、行业标准发布（GB/T 新标准）。

**碳管家的三档策略**：
1. **全量重建**（季度）：重新解析所有文档、重新分块、重新 Embedding、全量入库。约 4 小时（10 万文档），凌晨低峰执行。适用于标准文档这类慢变知识。
2. **增量更新**（法规月更 / 实时）：碳法规监测 Agent 定时抓取公开法规源（生态环境部、欧盟 CBAM 官网）→ 自动解析 → **生成「法规变更待确认」工单** → 合规专家确认后才分块、Embedding、增量入库（抓取与解析自动，入库生效人工）。**公开源抓取不直接入库**，与第一章"抓取只生成待录入工单"的口径一致。
3. **直查 + 异步索引**（因子实时）：碳排放因子走数据库直查作为事实源，向量索引异步更新。
4. **失效标记**：法规被修订或废止时标记旧版为"已废止"，检索时过滤或降权，不直接删除（用户可能查历史版本）。
5. **版本管理**：每个 chunk 记录 `doc_id`、`version`、`effective_date`、`status`（active/deprecated/superseded），支持按版本检索。

**时效性保证机制**：
- **文档新鲜度监控**：每周扫描，超过 12 个月未更新的文档触发人工审查。
- **法规变更通知**：订阅法规更新推送（北大法宝、威科先行），变更时自动触发增量更新。
- **用户反馈闭环**：用户点踩"信息过时"时自动标记该 chunk 待审查。

#### 追问：
- 追问1：增量更新依赖法规监测 Agent 抓外网，若官网改版或反爬导致抓取失败，如何及时发现而非默默停更？
  - **答**：靠可观测而非信任：
    - 健康探测：监控每次抓取的成功率/返回结构/内容哈希，连续失败或内容突变即告警。
    - 心跳机制：Agent 定期上报"最后成功时间"，超阈值未更新触发值班通知。
    - 多源交叉：同时订阅北大法宝/威科等推送，单一官网失效仍有替代源；改版时人工调整解析器。
- 追问2：旧版本法规标记"已废止"但保留供历史查询，检索时如何避免新用户误命中旧版，默认过滤策略是什么？
  - **答**：默认只检索 active：
    - 默认返回 status=active（现行有效）的 chunk；旧版仅在用户显式指定版本/历史口径时才纳入。
    - 召回后对同条款多版本做"版本去重"，优先最新有效版，旧版降权或折叠标注"已废止-仅供参考"。
    - 回答中标注所引版本与生效日期，避免用户把废止内容当现行依据。
- 追问3：碳排放因子走"数据库直查+向量异步更新"，异步窗口内用户问到刚更新的因子，会不会拿到旧向量导致回答与直查不一致？
  - **答**：可能短暂不一致，靠事实源单一化兜住：
    - 因子直查为唯一事实源，生成时以直查数值为准并标注时间戳。
    - 向量异步更新设短 TTL + 消费监控，延迟高时降级走直查；非关键场景容忍秒级最终一致。
- 追问4：标准文档季度全量重建时，检索是否降级，如何做到不停服切换新旧索引？
  - **答**：蓝绿双索引 + 别名原子切换：
    - 重建写入新索引，旧索引继续服务在线查询；新索引建完预热验证后原子切换（如 Milvus alias swap）。
    - 进行中对话引用的是旧库快照，切换瞬间最多影响跨边界的后续轮次，概率低且有置信度兜底。
    - 重建在低峰期执行并限速，切换后做一致性校验再下线旧索引，保留可回滚窗口。


### 29. RAG和模型微调（Fine-tuning）的区别及适用场景？
**重要度**：★★★★

| 维度   | RAG          | Fine-tuning    |
| ---- | ------------ | -------------- |
| 知识注入 | 外挂知识库，运行时检索  | 内化到模型权重        |
| 更新成本 | 更新索引即可       | 需重新训练          |
| 实时性  | 实时（更新索引即生效   | 非实时（需训练）       |
| 可溯源  | 可标注来源        | 不可溯源           |
| 适用场景 | 知识频繁更新、需引用来源 | 固定领域、特定风格/格式   |
| 计算   | 无需训练，推理时检索   | 需训练资源          |
| 幻觉控制 | 较好（有检索约束）    | 较差（模型可能"记忆"错误） |

**碳管家助手选择 RAG**：碳法规频繁更新、需引用 ISO/GBT 标准来源、用户需要可溯源回答，RAG 更适合。

#### 追问：
- 追问1：碳管家助手是否需要RAG+微调混合——用微调让模型学会LCA表达风格，用RAG注入最新法规，你有没有评估过这种组合？
  - **答**：评估过/可考虑。微调负责表达风格与领域术语习惯（低成本小模型），RAG负责最新法规与可溯源；组合能在风格统一同时保时效，需权衡微调维护成本与合规可溯源性。
- 追问2：微调在"可溯源"上的劣势，是否可通过微调时把来源标记一起学进去部分缓解，还是本质不可行？
  - **答**：本质难。权重内化无法可靠标注“这句来自哪条标准”，即使学进来源标记也不可验证；可部分缓解（输出带格式引用），但权威可溯源仍靠RAG检索片段+显式引用，不可替代。


### 30. LangChain4j支持的向量数据库有哪些？各自的优缺点是什么？
**重要度**：★★★

LangChain4j 支持的向量库：Milvus、PGVector、Chroma、Weaviate、Pinecone、Qdrant、ElasticSearch、Redis、Cassandra 等。

优缺点见[第七章第 5 题《Milvus/Chroma/PGVector/ElasticSearch 的特点和适用场景》](/08-vector-db-embedding.html#q-7-5)。

#### 追问：
- 追问1：LangChain4j对Milvus的HNSW参数（M、efConstruction）是否暴露可配，还是有默认值，默认在碳管家10w分块下是否够用？
  - **答**：LangChain4j的Milvus集成通过 `MilvusIndexParam`（HNSW）暴露 `m` 和 `efConstruction`，需在建 collection/索引时显式传，没有"开箱默认值"这回事。`M=16、efConstruction=200` 在 10w 分块下够用；高维/高 QPS 建议调大 M（如 32）；检索期单独设 `ef`（如 64~128，需 ≥ topK），ef 越大召回越高、延迟越大。
- 追问2：若选用Qdrant而非Milvus，LangChain4j的API差异会不会让你在碳管家项目里重写大量胶水代码？
  - **答**：LangChain4j对Qdrant有独立集成模块，API风格类似但连接/索引参数不同；因用VectorStore抽象业务检索代码基本不动，仅改配置与少量Builder，胶水代码量可控。


### 31. Spring AI中DocumentReader和TextSplitter的作用是什么？
**重要度**：★★★★

**DocumentReader**：读取不同格式文档并转为 Spring AI 的 `Document` 对象。注意 `get()` 返回的是 `List<Document>`，不是单个 `Document`。

- `TextReader`：读取纯文本。
- `PagePdfDocumentReader`：基于 PDFBox 按页解析 PDF，每页一个 Document，适合需要页码溯源的场景。
- `ParagraphPdfDocumentReader`：基于 PDFBox 的 PDF 目录（outline）按段落/章节解析，适合有书签的标准文档。
- `JsonReader`：解析 JSON。
- `TikaDocumentReader`：基于 Apache Tika 支持 docx/pptx/html 等多种格式，但表格结构会丢。

> 没有 `PDFReader` 这个类；PDF 读取器就是上面两个。

**TextSplitter**：将长文档分割为多个 chunk。

- `TokenTextSplitter`：按 token 数分割（Spring AI 的默认切分器，底层用 jtokkit 的 CL100K 分词）。
- `ContentFormatTransformer`：把文本格式信息（如 Markdown 标题）转成 metadata，供后续检索过滤用，**它本身不是切分器**，别和 `TokenTextSplitter` 并列成"切分策略"。

**使用示例**：

```java
// get() 返回 List<Document>，必须用 List 接
List<Document> docs = new TikaDocumentReader("classpath:iso14067.pdf").get();
// TokenTextSplitter(chunkSize, minChunkSizeChars, minChunkLengthToEmbed, maxNumChunks, keepSeparator)
List<Document> chunks = new TokenTextSplitter(500, 350, 10, 10000, true).apply(docs);
vectorStore.add(chunks);
```

#### 追问：
- 追问1：TikaDocumentReader解析ISO标准PDF时若表格丢失，是换PDFBox定制解析还是接受损失，你们在碳管家项目怎么选？
  - **答**：碳管家选PDFBox定制。含关键表格的ISO标准用PDFBox按坐标提取表格转结构化chunk（或图片+OCR），Tika仅用于无表格纯文本章节，不接受关键表格丢失。
- 追问2：TokenTextSplitter按token切，中文一个token对应几个字不固定，chunk_size=500在中文里实际长度波动是否影响检索质量？
  - **答**：先纠正一个常见误解：chunk_size=500 里的 500 是**切分器自己的 tokenizer**（Spring AI 的 TokenTextSplitter 用 CL100K）算出来的，不是 bge 分词；embedding 模型的分词与切分器无关，两者不必一致，切分器只需要保证"块不超嵌入模型的单块上限"即可。换算上，CL100K 对中文大致 1 token ≈ 1~1.5 字，所以 500 token 约 500~750 字（取中位数说"约 750 字"也行，但不要说 300~700 字——那与 1~2 字/token 自相矛盾）。影响：中文单字密度高时同样的 500 token 覆盖内容更多，条款容易被整块吞下、边界反而更粗；建议按字符数做兜底上限，并监控各 chunk 实际长度分布。


### 32. 如何设计RAG系统的缓存策略？
**重要度**：★★★★

见[第六章第12题《结果缓存策略在高频AI问答中如何使用？》](/02-ai-model-integration.html#q-6-12)。补充 RAG 特有的缓存策略：

- **Embedding 缓存**：同一问题的 Embedding 向量缓存，避免重复向量化。
- **检索结果缓存**：同一问题的 Top-K 检索结果缓存（Redis，TTL 30min）。
- **语义缓存**：用向量相似度匹配已有问答缓存。自测数据（碳管家 FAQ 类 query）：精确匹配命中率约 30%，语义缓存约 50-60%，即**高 20~30 个百分点**；复杂法规/多跳问答命中率显著更低（<10%），不能拿 FAQ 的数字对外泛指。

#### 追问：
- 追问1：语义缓存比精确匹配高 20~30 个百分点，但用户问"最新碳排放因子"这类时效问题若被语义缓存命中返回旧答案，如何加时效性失效？
  - **答**：语义缓存需加失效策略：
    - ① 含“最新/实时”类Query不进语义缓存或短TTL
    - ② 缓存key带数据版本/日期，因子更新时按版本失效
    - ③ 返回附“数据截至时间”，过期提示重查
- 追问2：Embedding缓存与检索结果缓存都用Redis，碳管家助手在高并发下缓存击穿（热点法规问题同时失效）如何防护？
  - **答**：
    - ① 热点key用互斥锁/singleflight只放一个请求回源
    - ② Redis高可用+本地二级缓存
    - ③ 法规类热点预加载
    - ④ 空结果也短缓存防穿透
    - ⑤ 限流保护Milvus不被瞬时打爆


### 33. RAG系统的成本如何优化？
**重要度**：★★★★

1. **本地 Embedding**：用 ONNX 本地推理替代云 API，消除 Embedding 调用成本。
2. **缓存优化**：语义缓存命中率 FAQ 类约 50-60%（复杂法规远低），减少可观的大模型调用。
3. **模型分级**：简单问题用小模型，复杂问题用大模型。
4. **Prompt 精简**：限制 Context 长度，减少 input token。
5. **离线索引**：非实时数据离线处理，避免在线实时计算。

#### 追问：
- 追问1：语义缓存命中率FAQ类约50-60%减少可观大模型调用，但这部分是否主要是低价值FAQ，复杂法规问答的真实命中率会不会低很多？
  - **答**：复杂法规问答语义缓存命中率远低于60%（表述多样、时效敏感）。60%主要是FAQ/通用定义类；复杂多跳/实时类不应依赖语义缓存，需区分缓存策略与TTL。
- 追问2：模型分级里"简单问题用小模型"，碳管家助手怎么界定简单，误判把复杂法规问题路由给小模型会不会引发合规风险？
  - **答**：简单=事实型/定义型/高置信单跳，用分类器或规则（含标准编号/计算词/多实体→复杂）路由。误判风险：复杂法规误给小模型会合规失信——对“法规/合规/计算”类强制走大模型，小模型仅限闲聊/通用定义。


### 34. 生产环境中RAG系统的监控指标有哪些？
**重要度**：★★★★

**检索指标**：

- 检索延迟（P50/P95/P99）
- 检索结果数量分布
- 检索相似度分数分布
- 空结果率（检索无结果的占比）

**生成指标**：

- 大模型调用延迟
- Token 消耗（input/output）
- 流式首字延迟（TTFT）
- 生成质量（用户反馈率）

**系统指标**：

- 知识库文档数量、chunk 数量
- 索引更新时间
- 向量库存储空间
- 缓存命中率


#### 追问：
- 追问1：空结果率（检索无结果占比）突然升高，在碳管家助手里更可能是索引故障还是用户问了知识库外的问题，如何区分告警？
  - **答**：看关联指标：若同时检索延迟飙升/索引写入异常/错误率升→索引故障；若延迟正常但空结果率升且命中新知识盲区→用户问库外问题。结合“是否有近期索引变更”与抽样查询分类判断。
- 追问2：你列的P99检索延迟和TTFT，目前碳管家助手的生产基线和告警阈值是怎么定的？
  - **答**：基线取上线初期P50/P95/P99实测，告警阈值设P99超过基线150%或TTFT>2s告警；阈值随容量调整，写入监控（如Prometheus）并定期回顾。


#### 扩充第三节：RAG检索增强生成（新增10题）


### 35. Hybrid Search（向量检索+关键词检索混合策略）的实现
**重要度**：★★★★

**题目：碳管理知识库中既有语义相近的概念（如"碳足迹"vs"温室气体排放"），又有精确匹配的需求（如ISO标准编号），如何实现Hybrid Search？**

Hybrid Search结合语义检索和关键词检索的优势，解决各自局限性：向量检索擅长语义相似但精确匹配差，关键词检索擅长精确匹配但语义理解弱。

实现架构：
- **向量检索层**：Milvus做语义相似度搜索，cosine similarity，返回Top-K语义相关文档
- **关键词检索层**：Elasticsearch做BM25关键词匹配，支持精确短语匹配和字段级查询
- **融合层**：Reciprocal Rank Fusion（RRF）合并两路结果：`RRF_score = Σ 1/(k + rank_i)`，k通常取60
- RRF优势：不依赖原始分数尺度，天然处理向量score和BM25 score的量级差异

碳管理场景示例：
- 问题"ISO 14064-1:2018的核心要求是什么？"→ 关键词检索精确匹配"ISO 14064-1:2018"，向量检索泛化到"组织层面碳核算标准"
- 问题"钢铁行业碳排放如何计算？"→ 关键词检索匹配"钢铁"+"碳排放计算"，向量检索泛化到"金属加工行业温室气体核算方法"
- 融合后两路互补，既不漏精确结果也不遗漏语义相关内容

Spring AI/LangChain4j实现：
- LangChain4j 没有开箱的混合检索器，正确做法是自己实现：两个 `ContentRetriever`（一个走 `EmbeddingStoreContentRetriever`、一个走 ES/BM25）并行召回，再用 `ReciprocalRankFuser`（k 固定 60）或自写 RRF 按排名融合，包成一个自定义 `ContentRetriever` 注入 `RetrievalAugmentor`
- RRF 公式 `score(d) = Σ 1/(k + rank_i)`，k 取 60；只看排名、不看原始分数量级，天然处理向量分与 BM25 分的尺度差异
- 权重可调：语义密集型问题向量权重0.7，精确匹配型问题关键词权重0.7


#### 三种框架实现对比

##### Spring AI 1.0 实现

```java
package com.carbon.guard.rag;

import co.elastic.clients.elasticsearch.ElasticsearchClient;
import co.elastic.clients.elasticsearch.core.SearchResponse;
import org.springframework.ai.chat.client.ChatClient;
import org.springframework.ai.chat.model.ChatModel;
import org.springframework.ai.document.Document;
import org.springframework.ai.vectorstore.SearchRequest;
import org.springframework.ai.vectorstore.VectorStore;

import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.regex.Pattern;
import java.util.stream.Collectors;

/**
 * 碳管家 Hybrid Search：向量语义 + ES BM25 关键词，RRF 融合。
 * 权重可动态调整：识别到标准编号 → 提高关键词路权重。
 */
public class HybridSearchService {

    private static final int RRF_K = 60;
    /** 标准编号模式：ISO 14064-1:2018 / GB/T 24067-2024 / 第4.1条 */
    private static final Pattern STANDARD_NO = Pattern.compile(
            "(ISO|GB/?T|GB|IEC)\\s*\\d+([-\\.]\\d+)*(:\\d{4})?|第\\s*\\d+(\\.\\d+)*\\s*条");

    private final VectorStore vectorStore;
    private final ElasticsearchClient esClient;
    private final ChatClient chatClient;

    public HybridSearchService(VectorStore vectorStore,
                               ElasticsearchClient esClient,
                               ChatModel chatModel) {
        this.vectorStore = vectorStore;
        this.esClient = esClient;
        this.chatClient = ChatClient.create(chatModel);
    }

    /**
     * 加权 RRF：语义密集型问题向量权重 0.7；
     * 精确编号类问题关键词权重 0.7（规则识别，不用模型，误判代价低）。
     */
    public List<Document> hybridSearch(String userQuery, int topK) {
        boolean isExactQuery = STANDARD_NO.matcher(userQuery).find();
        double vectorWeight = isExactQuery ? 0.3 : 0.7;
        double keywordWeight = 1.0 - vectorWeight;

        List<Document> vectorHits = vectorStore.similaritySearch(SearchRequest.builder()
                .query(userQuery)
                .topK(20)
                .similarityThreshold(0.5)
                .build());

        List<Document> keywordHits = keywordSearch(userQuery, 20);

        return weightedRrfFuse(List.of(vectorHits, keywordHits),
                List.of(vectorWeight, keywordWeight), topK);
    }

    /**
     * ES 侧没有 search(String, int) 这类便捷方法，必须构造 SearchRequest；
     * 返回的 SearchResponse 也不是 Spring AI 的 Document，需要显式映射。
     */
    private List<Document> keywordSearch(String userQuery, int size) {
        try {
            SearchResponse<Map> resp = esClient.search(s -> s
                            .index("carbon_docs")
                            .query(q -> q.match(m -> m.field("text").query(userQuery)))
                            .size(size),
                    Map.class);
            return resp.hits().hits().stream()
                    .map(h -> new Document(h.id(), String.valueOf(h.source().get("text"))))
                    .collect(Collectors.toList());
        } catch (Exception e) {
            return List.of();   // 关键词路异常时退化为纯向量召回
        }
    }

    /** 加权 RRF：score(d) = Σ w_i / (k + rank_i) */
    private List<Document> weightedRrfFuse(List<List<Document>> routes,
                                           List<Double> weights, int topK) {
        Map<String, Double> scores = new HashMap<>();
        Map<String, Document> pool = new LinkedHashMap<>();
        for (int r = 0; r < routes.size(); r++) {
            List<Document> route = routes.get(r);
            double w = weights.get(r);
            for (int i = 0; i < route.size(); i++) {
                Document d = route.get(i);
                String id = d.getId() != null ? d.getId() : d.getText().hashCode() + "";
                scores.merge(id, w / (RRF_K + i + 1), Double::sum);
                pool.putIfAbsent(id, d);
            }
        }
        return scores.entrySet().stream()
                .sorted(Map.Entry.<String, Double>comparingByValue().reversed())
                .map(e -> pool.get(e.getKey()))
                .limit(topK)
                .collect(Collectors.toList());
    }

    public String ask(String userQuery) {
        List<Document> docs = hybridSearch(userQuery, 5);
        String context = docs.stream().map(Document::getText).collect(Collectors.joining("\n\n"));
        return chatClient.prompt()
                .system("你是碳管理专家助手。回答要标注依据的标准编号与章节。")
                .user(u -> u.text("<参考资料>\n{ctx}\n</参考资料>\n\n问题：{q}")
                        .param("ctx", context).param("q", userQuery))
                .call()
                .content();
    }
}
```

##### Spring AI 2.0 实现

```java
package com.carbon.guard.rag;

import co.elastic.clients.elasticsearch.ElasticsearchClient;
import co.elastic.clients.elasticsearch.core.SearchResponse;
import org.springframework.ai.chat.client.ChatClient;
import org.springframework.ai.chat.model.ChatModel;
import org.springframework.ai.document.Document;
import org.springframework.ai.openai.OpenAiChatOptions;
import org.springframework.ai.vectorstore.SearchRequest;
import org.springframework.ai.vectorstore.VectorStore;

import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.regex.Pattern;
import java.util.stream.Collectors;

/**
 * 碳管家 Hybrid Search：Spring AI 2.0。
 * 2.0 下 VectorStore/SearchRequest/RRF 融合的 API 与 1.0 完全一致——本类只负责检索融合，
 * 2.0 的差异在生成侧（Options 传 Builder、ToolCallingAdvisor 自动注册），见第 5 题与第 10 题。
 */
public class HybridSearchService {

    private static final int RRF_K = 60;
    private static final Pattern STANDARD_NO = Pattern.compile(
            "(ISO|GB/?T|GB|IEC)\\s*\\d+([-\\.]\\d+)*(:\\d{4})?|第\\s*\\d+(\\.\\d+)*\\s*条");

    private final VectorStore vectorStore;
    private final ElasticsearchClient esClient;
    private final ChatClient chatClient;

    public HybridSearchService(VectorStore vectorStore,
                               ElasticsearchClient esClient,
                               ChatModel chatModel) {
        this.vectorStore = vectorStore;
        this.esClient = esClient;
        this.chatClient = ChatClient.create(chatModel);
    }

    /** 加权 RRF 融合两路召回 */
    public List<Document> hybridSearch(String userQuery, int topK) {
        boolean isExactQuery = STANDARD_NO.matcher(userQuery).find();
        double vectorWeight = isExactQuery ? 0.3 : 0.7;
        double keywordWeight = 1.0 - vectorWeight;

        List<Document> vectorHits = vectorStore.similaritySearch(SearchRequest.builder()
                .query(userQuery)
                .topK(20)
                .similarityThreshold(0.5)
                .build());
        List<Document> keywordHits = keywordSearch(userQuery, 20);

        Map<String, Double> scores = new HashMap<>();
        Map<String, Document> pool = new LinkedHashMap<>();
        List<List<Document>> routes = List.of(vectorHits, keywordHits);
        List<Double> weights = List.of(vectorWeight, keywordWeight);
        for (int r = 0; r < routes.size(); r++) {
            List<Document> route = routes.get(r);
            for (int i = 0; i < route.size(); i++) {
                Document d = route.get(i);
                String id = d.getId() != null ? d.getId() : d.getText().hashCode() + "";
                scores.merge(id, weights.get(r) / (RRF_K + i + 1), Double::sum);
                pool.putIfAbsent(id, d);
            }
        }
        return scores.entrySet().stream()
                .sorted(Map.Entry.<String, Double>comparingByValue().reversed())
                .map(e -> pool.get(e.getKey()))
                .limit(topK)
                .collect(Collectors.toList());
    }

    /** ES 侧须构造 SearchRequest，并把 SearchResponse 显式映射为 Document */
    private List<Document> keywordSearch(String userQuery, int size) {
        try {
            SearchResponse<Map> resp = esClient.search(s -> s
                            .index("carbon_docs")
                            .query(q -> q.match(m -> m.field("text").query(userQuery)))
                            .size(size),
                    Map.class);
            return resp.hits().hits().stream()
                    .map(h -> new Document(h.id(), String.valueOf(h.source().get("text"))))
                    .collect(Collectors.toList());
        } catch (Exception e) {
            return List.of();
        }
    }

    public String ask(String userQuery) {
        List<Document> docs = hybridSearch(userQuery, 5);
        String context = docs.stream().map(Document::getText).collect(Collectors.joining("\n\n"));
        return chatClient.prompt()
                .options(OpenAiChatOptions.builder().temperature(0.2))
                .system("你是碳管理专家助手。回答要标注依据的标准编号与章节。")
                .user(u -> u.text("<参考资料>\n{ctx}\n</参考资料>\n\n问题：{q}")
                        .param("ctx", context).param("q", userQuery))
                .call()
                .content();
    }
}
```

##### LangChain4j 实现

```java
package com.carbon.guard.rag;

import dev.langchain4j.model.chat.ChatModel;
import dev.langchain4j.rag.content.Content;
import dev.langchain4j.rag.content.retriever.ContentRetriever;
import dev.langchain4j.rag.content.retriever.EmbeddingStoreContentRetriever;
import dev.langchain4j.rag.query.Query;
import dev.langchain4j.service.AiServices;
import dev.langchain4j.service.SystemMessage;
import dev.langchain4j.service.V;

import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.stream.Collectors;

/**
 * 碳管家 Hybrid Search：LangChain4j 1.0。
 * LangChain4j 没有内置混合检索器：手动组合两路 ContentRetriever，再自写 RRF 融合。
 */
public class HybridSearchService {

    public interface CarbonAssistant {
        @SystemMessage("你是碳管理专家助手。回答要标注依据的标准编号与章节。")
        String chat(@V("question") String question);
    }

    private final CarbonAssistant assistant;
    private final ContentRetriever vectorRetriever;
    private final ContentRetriever keywordRetriever;

    public HybridSearchService(ChatModel chatModel,
                               EmbeddingStore<TextSegment> embeddingStore,
                               EmbeddingModel embeddingModel,
                               ContentRetriever keywordRetriever) {
        this.vectorRetriever = EmbeddingStoreContentRetriever.builder()
                .embeddingStore(embeddingStore)
                .embeddingModel(embeddingModel)
                .maxResults(20)
                .minScore(0.5)
                .build();
        this.keywordRetriever = keywordRetriever;
        this.assistant = AiServices.builder(CarbonAssistant.class)
                .chatModel(chatModel)
                .build();
    }

    /**
     * 两路召回 + RRF。
     * 精确编号类查询把 k 从 60 降到 10，让关键词路的精确命中排名更靠前。
     * ReciprocalRankFuser 只有 fuse(List)/fuse(Map) 两个签名、k 固定为 60，
     * 要动态调 k 就自己算：score(d) = Σ 1/(k + rank)。
     */
    public List<Content> hybridSearch(String userQuery, boolean isExactQuery) {
        List<Content> vectorHits = vectorRetriever.retrieve(Query.from(userQuery));
        List<Content> keywordHits = keywordRetriever.retrieve(Query.from(userQuery));
        int k = isExactQuery ? 10 : 60;

        Map<String, Double> scores = new HashMap<>();
        Map<String, Content> pool = new LinkedHashMap<>();
        for (List<Content> route : List.of(vectorHits, keywordHits)) {
            for (int i = 0; i < route.size(); i++) {
                Content c = route.get(i);
                String key = c.textSegment().text();
                scores.merge(key, 1.0 / (k + i + 1), Double::sum);
                pool.putIfAbsent(key, c);
            }
        }
        return scores.entrySet().stream()
                .sorted(Map.Entry.<String, Double>comparingByValue().reversed())
                .map(e -> pool.get(e.getKey()))
                .collect(Collectors.toList());
    }

    public String ask(String userQuery, boolean isExactQuery) {
        List<Content> fused = hybridSearch(userQuery, isExactQuery);
        String context = fused.stream()
                .map(c -> c.textSegment().text())
                .limit(5)
                .reduce((a, b) -> a + "\n\n" + b)
                .orElse("");
        return assistant.chat(userQuery + "\n\n<参考资料>\n" + context + "\n</参考资料>");
    }
}
```

#### 追问：
- 追问1：碳管家场景里"ISO 14064-1:2018"这种精确编号，单靠BM25可能召回但向量路噪声大，RRF的k=60在你们实测里是否最优，调过吗？
  - **答**：k=60是RRF通用默认，但精确编号场景可实测调参：若BM25置信高，降k（如k=10）让精确匹配排名更靠前；建议用验证集扫k∈{10,30,60}选最优。
- 追问2：语义密集型与精确匹配型问题的向量/关键词权重动态切换，是靠规则（识别到编号就用关键词）还是靠模型判断，误判代价多大？
  - **答**：建议规则优先（识别到标准编号/年份/精确术语→关键词路高权重），误判代价低且可控；模型判断更灵活但有误判延迟与成本。误判代价：精确查询走语义可能漏编号，但多路召回兜底不至于完全错误。
- 追问3：LangChain4j没有开箱的混合检索器，你们自定义ContentRetriever时，如何保证法规类文档优先于手册类？
  - **答**：自定义Retriever在融合时给不同文档类型设权重（法规类>手册类），或在元数据过滤阶段优先召回法规；RRF合并后对法规来源加分/置前，保证权威优先。


### 36. Graph RAG（知识图谱+向量检索）原理与场景
**重要度**：★★★

**题目：碳管理领域存在大量实体关系（如排放因子→行业→工艺→产品），如何用Graph RAG结合知识图谱和向量检索提升回答质量？**

Graph RAG利用知识图谱的结构化关系信息增强检索和生成，在实体关系密集的领域效果显著优于纯向量RAG。

原理：
- Step 1：将问题中的实体提取出来（如"钢铁"+"高炉"+"CO2排放因子"）
- Step 2：在知识图谱中做子图检索，沿实体关系路径展开（钢铁→高炉工艺→CO2→排放因子1.89 tCO2e/t粗钢）
- Step 3：将子图转换为文本描述，与向量检索结果一起注入Prompt
- Step 4：LLM基于结构化关系+语义上下文生成答案，答案中可引用具体关系路径

碳管理知识图谱构建：
- 核心实体：排放因子、行业类别、产品、工艺路线、ISO标准、碳核算方法
- 关系类型：属于(industry)、适用(applicable_to)、引用(refers_to)、替代(alternative_to)
- 图数据库选型：Neo4j（小型图）或HugeGraph（大规模图，适合全国行业碳数据）
- 数据来源：ISO标准文档结构化提取、EPA排放因子库、行业LCA数据库

与向量检索互补：
- 向量检索：找到"与钢铁碳排放相关的文档片段"
- 知识图谱：找到"钢铁→高炉→CO2→1.89 tCO2e/t粗钢"的精确关系链（长流程吨钢综合排放约 1.8~2.0，1.89 与全书因子口径一致）
- 融合后答案：不仅语义相关，还有精确的实体关系支撑，减少幻觉

实践挑战：知识图谱构建成本高（需领域专家定义Schema），建议先建核心实体图谱再逐步扩展。

#### 追问：
- 追问1：碳管家知识图谱的Schema（实体与关系）由谁定义、如何保证与ISO标准术语一致，领域专家成本是否成为落地瓶颈？
  - **答**：由碳领域专家+工程师共同定义，参照ISO术语表与行业LCA本体保证一致；可先基于标准文档结构化抽取半自动生成初版专家审校。成本是瓶颈但可分期：先核心实体再扩展。
- 追问2：子图检索把"钢铁→高炉→CO2→1.89 tCO2e/t粗钢"转文本注入Prompt，若图谱里恰好缺该工艺路线数据，是回退纯向量还是返回不确定？
  - **答**：不硬编。子图检索缺该工艺路线时回退向量检索补充，答案标注“图谱暂缺该路线，以下基于文档检索”，或直接返回“暂无该工艺路线权威数据”，避免幻觉。
- 追问3：Neo4j与Milvus在碳管家生产里是双写还是图由向量结果触发查询，两者数据一致性如何维护？
  - **答**：推荐“向量触发图查询”：先向量召回定位实体再查图谱补全关系，避免双写不一致；若双写（因子库同时写MySQL/图/Milvus）用CDC统一事件驱动三端更新保证一致。


### 37. Agentic RAG（Agent驱动的自适应检索）
**重要度**：★★★★

**题目：传统RAG流程是固定的"检索→生成"，Agentic RAG如何让Agent自主决定检索策略和次数？**

Agentic RAG将RAG流程从静态pipeline升级为Agent自主决策的动态过程，核心是让LLM根据问题需要自行规划检索策略。

架构设计：
- **检索Agent**：根据问题判断需要哪些检索动作（单次检索/多跳检索/知识图谱查询/关键词搜索）
- **评估Agent**：评估检索结果是否足够回答问题，若不够则决定补充检索
- **生成Agent**：在检索充分后生成最终答案，标注信息来源

Agentic RAG vs 传统RAG流程对比：
- 传统：Query → 检索Top-K → 生成（一次检索，不管结果质量）
- Agentic：Query → 规划检索策略 → 执行检索 → 评估结果 → 补充检索或生成（自适应循环）

碳管家场景示例：
- 简单问题"什么是碳足迹？"→ Agent判断一次向量检索足够，直接生成
- 复杂问题"根据ISO 14067标准，铝合金产品的碳足迹如何计算？"→ Agent决定先检索ISO 14067内容，再检索铝合金排放因子，再检索LCA计算方法——三跳检索
- 不确定问题"最近的碳排放政策变化？"→ Agent先检索，发现结果时间跨度大，决定追加时间过滤检索"2024-2025年碳政策"

Spring AI实现：使用Advisor Chain模拟Agent决策循环，自定义`AgenticRAGAdvisor`包含检索→评估→补充的逻辑。

#### 追问：
- 追问1：Agent自主决定检索次数，碳管家助手如何约束"铝合金碳足迹"这类三跳检索的总耗时与Token成本，会不会失控？
  - **答**：设上限：最大跳数（如3）、单跳超时、总Token预算；超预算提前生成并提示“信息可能不完整”；Advisor链每跳后检查预算，超限熔断返回已有结果。
- 追问2：评估Agent判断"检索结果是否足够"本身依赖大模型，若评估出错导致过早生成或无限补充，有无熔断机制？
  - **答**：有。评估Agent出错靠硬性约束兜底：最大跳数、总耗时/Token上限、超时返回当前最佳；并设“生成置信度低于阈值则转人工/拒答”，防止无限补充或过早生成。
- 追问3：用Spring AI Advisor Chain模拟Agent决策循环，与直接用LangChain4j的Agent框架相比，状态管理和可追溯性哪个更适合生产？
  - **答**：LangChain4j Agent框架状态管理更原生（内置memory/tool循环、可观测日志）适合复杂生产；Spring AI Advisor Chain更轻量、与Spring生态契合但需自管状态。生产可追溯性优先选LangChain4j Agent或自研带日志Advisor。


### 38. 多跳检索（Multi-hop Retrieval）
**重要度**：★★★★

**题目：碳管理复杂问题往往需要跨多个知识源推理，如"ISO 14064标准与EU ETS法规在碳核算要求上有何差异？"如何实现多跳检索？**

多跳检索是针对需要跨多个知识源逐步推理的问题，设计多次检索策略，每次检索基于前一次的结果或推理。

原理与流程：
- Hop 1：检索"ISO 14064标准碳核算要求"，获得核心条款
- Hop 2：基于Hop 1结果，生成新Query"EU ETS法规碳核算要求"，检索第二条知识
- Hop 3：对比分析两份知识，生成综合答案
- 关键：每跳的Query由LLM基于已有信息动态生成，而非用户原始问题

实现技术：
- **Query Decomposition**：LLM先将复杂问题分解为子问题，每个子问题独立检索
  - 原问题 → 子问题1"ISO 14064的核心要求" + 子问题2"EU ETS的核算规则"
- **Iterative Retrieval**：LLM根据第一轮检索结果生成补充Query，继续检索直到信息充分
- **Chain-of-Thought Retrieval**：将推理过程作为检索线索，逐步深入

LangChain4j实现：
- 自定义`MultiHopRetriever`，内部维护检索历史和当前信息状态
- 每次检索后调用LLM判断"信息是否充分"，不充分则生成新Query继续检索
- 最大跳数限制（如3跳），防止无限循环

碳管理场景常见多跳问题：
- "这个产品的碳足迹是否符合欧盟CBAM要求？"→ 需检索产品碳足迹数据+CBAM法规+判定逻辑
- "该行业的排放因子最近有更新吗？"→ 需检索行业排放因子库+最新政策变更+因子版本对比

#### 追问：
- 追问1：多跳中每跳Query由LLM动态生成，若Hop1检索到的ISO条款本身有歧义，Hop2的Query会不会被带偏，如何验证推理链正确？
  - **答**：每跳后做一致性检查：校验Hop2 Query是否基于Hop1真实内容（不让模型自由发挥），用检索结果反证；最终答案标注每跳来源，人工/自动评估推理链合理性，异常则回退少跳或直答。
- 追问2：最大跳数限制为3，碳管家助手里"产品是否满足CBAM"可能需跨因子库+法规+判定逻辑更多跳，3跳是否不够，如何自适应放宽？
  - **答**：固定3跳不够时按复杂度与置信度动态放宽：评估Agent认为信息不足且未超安全预算允许+1跳（上限如5）；“产品是否满足CBAM”类可在判定逻辑清晰时预置多跳模板。
- 追问3：多跳中间结果如何组织进最终Context，是每跳Top-K拼接还是仅用末跳，信息是否会因拼接而稀释？
  - **答**：建议每跳Top-K拼接但去重压缩，保留各跳关键片段并标注来源跳数；仅用末跳会丢失中间推理依据。控制总长用父子块/摘要避免稀释，每跳取最核心1~2条而非全量。


### 39. 自查询检索（Self-Query Retrieval）
**重要度**：★★★

**题目：用户问"2023年后发布的ISO碳管理标准"，如何让系统自动从自然语言中提取过滤条件（年份、类别）进行精确检索？**

自查询检索（Self-Query Retrieval）让LLM从用户自然语言中自动提取结构化过滤条件，结合语义检索和元数据过滤。

原理：
- LLM分析用户Query，提取语义部分和元数据过滤条件
- 语义部分："ISO碳管理标准" → 向量检索
- 元数据过滤："年份≥2023"、"类别=ISO标准" → Milvus/ES的metadata filter
- 两部分结合：先按元数据过滤缩小候选集，再在候选集内做向量相似度排序

Milvus实现：
- Milvus支持metadata字段过滤：`filter='year >= 2023 && category == "ISO"'`
- 需在向量入库时为每个文档附加元数据：`{year: 2023, category: "ISO", language: "zh"}`
- Spring AI 用顶层类 `org.springframework.ai.vectorstore.filter.FilterExpressionBuilder` 构建过滤条件（**没有** `Filter.ExpressionBuilder` 这个嵌套类），最终要转成字符串塞进 `SearchRequest.filterExpression(...)`：

```java
var b = new FilterExpressionBuilder();
Filter.Expression expr = b.and(b.gte("year", 2023), b.eq("category", "ISO")).build();
List<Document> docs = milvusVectorStore.similaritySearch(
        SearchRequest.builder().query(q).topK(5).filterExpression(expr).build());
// MilvusVectorStore 最终把它翻译成 expr 字符串：year >= 2023 && category == "ISO"
```

LLM提取过滤条件的Prompt设计：
```
从以下用户问题中提取语义查询部分和元数据过滤条件：
用户问题：{query}
可用过滤字段：year(年份), category(类别), industry(行业), region(地区)
输出格式：{semantic_query: "...", filters: {field: value}}
```

碳管家场景优势：
- "钢铁行业2024年的排放因子"→ 语义="排放因子" + filter={industry:"钢铁", year:2024}
- "欧盟碳市场相关的中文资料"→ 语义="碳市场" + filter={region:"EU", language:"zh"}
- 精确过滤大幅减少无关文档，提升RAG精确度和效率

#### 追问：
- 追问1：LLM从"2023年后发布的ISO标准"提取year>=2023，若用户说"近两年的标准"模型能否正确转成具体年份区间，时区/基准日怎么定？
  - **答**：模型需结合基准日（请求日或知识库最新日期）将“近两年”转具体区间（如2024-2025）。时区统一用业务时区（UTC+8）；Prompt给定“当前日期=YYYY-MM-DD”让模型基于该日推算避免歧义。
- 追问2：自查询提取的过滤条件若错误（如把行业"钢铁"误提为"建筑"），Milvus过滤后可能返回空集，如何检测并回退到无过滤检索？
  - **答**：自查询提取的filter先校验合法性（枚举值/范围），若过滤后结果为空或过少自动回退无过滤（或宽松过滤）重检并告警“过滤条件可能不准”；关键查询可让用户确认过滤条件。
- 追问3：Spring AI 的 `FilterExpressionBuilder` 支持的字段，是否需要随知识库元数据 schema 演进而动态注册，否则新字段无法被自查询利用？
  - **答**：需要。`FilterExpressionBuilder` 本身只是语法构造器，不校验字段是否存在——字段名写错不会编译报错，而是在 Milvus 侧静默返回空集或直接报错。所以可用字段必须来自 schema 注册中心的白名单，schema 变更时同步更新白名单与自查询 Prompt 里的"可用过滤字段"清单，否则新字段（如新增 region）无法被利用、废弃字段则会制造幻觉过滤条件。


### 40. RAG评估框架（RAGAS：Faithfulness/AnswerRelevancy/ContextRecall）
**重要度**：★★★★

**题目：如何用RAGAS框架系统评估碳管家AI助手的RAG质量？三个核心指标分别评估什么，如何提升？**

RAGAS（Retrieval Augmented Generation Assessment）是RAG系统评估的标准框架，包含三个核心指标。

**Faithfulness（忠实度）**：
- 评估：生成的答案是否忠实于检索到的上下文，而非模型自行编造
- 计算：将答案拆分为原子陈述，逐一验证是否可从上下文推导
- 碳管理场景关键：排放因子数值必须与上下文中的原始数据一致，不可"近似估算"
- 提升方法：Prompt中强调"仅使用提供的信息回答"；后处理校验数值与上下文一致

**Answer Relevancy（答案相关性）**：
- 评估：生成的答案是否与用户问题高度相关
- 计算：用LLM从答案反向生成可能的问题，与原问题的语义相似度
- 碳管理场景：用户问"碳足迹计算方法"，答案不应跑题到"碳中和政策解读"
- 提升方法：优化检索相关性（更好的Embedding/更精准的Query改写）

**Context Recall（上下文召回率）**：
- 评估：检索到的上下文是否包含了回答问题所需的全部信息
- 计算：用参考答案的每个陈述检查是否在检索上下文中出现
- 碳管理场景关键：ISO标准解读需完整条款上下文，而非片段
- 提升方法：增加Top-K值、使用Hybrid Search、构建知识图谱补充检索

评估实践：
- 构建评估集：先用 **300 条**人工标注做基线（领域专家单人标注成本的上限，覆盖不同难度和领域），稳定后扩充到 **500 条**做日常回归与 A/B。
- 用LangChain4j的Evaluation模块自动化评估流程
- 每月评估一次，跟踪指标趋势，Prompt/检索策略变更后立即评估

#### 追问：
- 追问1：Faithfulness把答案拆原子陈述验证，碳管家助手里"约1.9 tCO2e/t粗钢"这种数值近似算不忠实吗，阈值怎么定？
  - **答**：数值近似是否“不忠实”看误差与场景。排放因子等关键数值“1.89→约2.0”偏差约6%涉合规建议判不忠实/告警；通用描述性近似（如“约1.9”，偏差0.5%）可容忍。设相对误差阈值（如≤5%可接受）。
- 追问2：Context Recall要求检索覆盖参考答案全部信息，但ISO条款常需完整章节，单靠Top-K片段能否真正达标，是否暴露分块缺陷？
  - **答**：可能暴露。ISO完整章节常超单chunk，Top-K片段难覆盖全部。缓解：父子块（父块给完整章节）、提高Top-K、Hybrid/Graph补充；Context Recall不达标说明需调整分块粒度或引入长上下文摘要。


### 41. 动态知识库更新（CDC方式、定时增量同步）
**重要度**：★★★★

**题目：碳管理领域的排放因子库、法规政策等知识持续更新，如何设计动态知识库更新机制确保AI回答的时效性？**

动态知识库更新解决RAG系统的核心痛点：知识过时导致错误答案（如引用已废止的排放因子）。

**CDC（Change Data Capture）方式**：
- 监听业务数据库（MySQL/PostgreSQL）的变更事件（INSERT/UPDATE/DELETE）
- 使用Canal捕获binlog变更，推送到Kafka
- 消费者接收到变更事件后：更新文档 → 重新分块 → 重新Embedding → 更新Milvus向量
- 优势：实时性高（秒级），碳排放因子更新后AI立即获取新数据
- **最容易踩的坑**：`upsert` 只按主键覆盖，解决不了"重新分块后 chunk 数量变化"——一份文档从 8 块变成 5 块，按 id 覆盖只会更新前 5 块，**剩下 3 个旧块仍留在库里、仍会被召回**，答案里就会出现已删除的旧条款。正确做法是**先按 `doc_id` 做 delete-by-expression 清掉该文档的全部旧 chunk（`delete(filter="doc_id == 'ISO14067_2018'")`），再批量 insert 新 chunk**；做不到事务时至少带 `doc_id + version` 标量字段，写入新版本号并在检索时按最新 version 过滤，旧版本定期清理。定时全量重建（见下文"混合策略"）就是兜底清孤儿块的手段。

**定时增量同步**：
- 定时任务（Cron）每小时/每天扫描知识源变更
- 对比上次同步时间戳，仅处理变更文档
- 适合更新频率较低的知识源（ISO标准每年更新1-2次）
- Spring Batch编排增量同步Pipeline：读取→解析→分块→向量化→入库

混合策略推荐：
- 核心业务数据（排放因子、企业碳数据）→ CDC实时更新
- 外部知识源（ISO标准、政策法规）→ 定时增量同步+手动触发更新
- 全量重建：每季度一次，清理累积的向量碎片和过期文档

Spring AI实现：
- `DocumentTransformer` + `EmbeddingModel` + `VectorStore` 组成ETL Pipeline
- 自定义`KnowledgeSyncService`监听CDC事件或定时触发
- 更新后自动触发RAGAS评估，确认新知识的检索和生成质量

#### 追问：
- 追问1：Canal捕获binlog推送Kafka，若消费者更新Milvus时宕机导致offset丢失，重启后会不会重复或漏更向量，如何保证exactly-once？
  - **答**：Kafka消费用幂等+手动提交offset，处理成功再提交；Milvus upsert按主键幂等，重复消费不重复建向量。宕机重启从已提交offset续读，配合“处理中”状态表防重复，必要时事务消息。
- 追问2：季度全量重建清理向量碎片，重建期间用旧索引服务，若新旧索引分块策略不同导致同一问题答案漂移，如何平滑切换？
  - **答**：重建用相同分块策略（策略变更单独灰度）；切换前对新索引跑回归集对比旧索引指标，达标才切；切后用别名原子swap并保留旧索引可回滚，避免分块策略不同导致漂移。
- 追问3：CDC实时更新碳排放因子后自动触发RAGAS评估，若评估发现新因子使某类回答质量下降，系统是回滚还是告警人工介入？
  - **答**：不自动回滚（避免数据陈旧）。策略：触发告警+人工介入复核；保留新旧因子双版本，回答标注“新因子已更新，复核中”；确认新因子有误由人工在源系统修正后重新同步。


### 42. Query Translation（查询改写/扩展/分解）
**重要度**：★★★★

**题目：用户问"碳交易价格怎么算"，但知识库中用的是"碳排放配额定价"，如何通过Query Translation提升检索命中率？**

Query Translation是RAG检索前的预处理步骤，通过LLM对用户原始Query进行改写、扩展或分解，使其更适合向量检索。

**Query Rewriting（改写）**：
- 将用户口语化表述改写为知识库中的专业术语
- "碳交易价格怎么算" → "碳排放配额定价机制与计算方法"
- 用LLM生成改写：`请将以下用户问题改写为更专业、更精确的表述：{query}`
- 碳管理场景常见改写：口语→专业术语、简称→全称、模糊→精确

**Query Expansion（扩展）**：
- 生成多个语义变体Query，全部检索后合并结果
- "碳足迹计算" → ["产品碳足迹核算方法", "LCA碳足迹评估流程", "ISO 14067碳足迹标准"]
- HyDE（Hypothetical Document Embedding）：让LLM先生成一个假设性答案，用答案的Embedding检索（而非问题Embedding）
- HyDE优势：答案表述与知识库文档更接近，检索命中率更高

**Query Decomposition（分解）**：
- 复杂问题分解为子问题，分别检索后合并
- "铝合金产品碳足迹是否满足CBAM要求" → 子问题1"铝合金碳足迹计算" + 子问题2"CBAM合规判定标准"

LangChain4j实现：
- 自定义`QueryTranslationAdvisor`在检索前拦截并改写Query
- 支持配置多种改写策略（Rewrite/Expand/HyDE/Decompose），根据问题复杂度选择

#### 追问：
- 追问1：Query Rewriting把"碳交易价格怎么算"改成专业表述，若改写过度偏离原意（如改成配额期货定价），检索反而跑题，如何约束改写保真度？
  - **答**：约束改写保真：
    - ① 改写Prompt要求“不改变原意、仅术语/表达专业化”
    - ② 改写后与原Query算语义相似度，偏离超阈值则弃用原Query检索
    - ③ 对专业术语建同义词表引导改写方向
- 追问2：HyDE用假设答案的Embedding检索，但碳因子计算类问题模型可能先"编"一个错误答案再检索，反而强化错误，是否适合数值类查询？
  - **答**：不适合数值/计算类。HyDE让模型编假设答案，排放因子计算易编错数值强化错误。HyDE更适合概念/解释类查询；碳因子计算类应走结构化直查+精确检索，不用HyDE。
- 追问3：Query Decomposition对"铝合金是否满足CBAM"拆子问题，若子问题间有依赖（先算足迹再判定），分解后的并行检索会不会丢失顺序逻辑？
  - **答**：有依赖的子问题不应并行。分解时识别依赖（先算足迹再判定），按拓扑顺序串行检索，或并行检索独立子问题、依赖型顺序执行；最终合并保证逻辑链完整，避免丢失先后关系。


### 43. CRAG（Corrective RAG）
**重要度**：★★★

**题目：传统RAG检索可能返回不相关或过时的内容，Corrective RAG如何自动纠正检索质量问题？**

CRAG（Corrective RAG）是在检索结果质量不佳时自动触发纠正动作的RAG增强策略，核心是引入检索结果评估和纠正回路。

流程设计：
- Step 1：正常检索，获取Top-K上下文
- Step 2：用LLM评估检索结果的相关性和可靠性（检索评估器）
- Step 3：根据评估结果选路。CRAG 原论文是**三分支**（Correct / Incorrect / Ambiguous），不要记成两个 Correct：
  - **Correct（结果良好）**：对检索片段做 knowledge refinement（decompose-then-recompose，剔噪保留知识条），再进入生成。
  - **Incorrect（结果无关）**：放弃库内结果，切换到 Web 搜索或其它知识源重新检索（限白名单来源）。
  - **Ambiguous（部分可用/不确定）**：既精炼已检索到的可用部分，同时补充检索缺失信息，两路合并后再生成。

检索评估器设计：
- Prompt：`评估以下检索内容与问题的相关性和时效性。问题：{query}，内容：{context}。输出：{relevant: bool, reason: "..."}`
- 碳管理时效性评估尤其重要：排放因子和法规可能已更新，需检查文档时间戳

纠正策略（碳管家场景）：
- 检索到 2022 年排放因子但当前已有 2024 年更新 → **本轮不阻塞**：加时间过滤重检 + 直查官方因子库取最新值，同时异步触发增量同步；不能指望在线等重建索引（分钟级，用户等不起）。
- 检索结果完全不相关（如检索到建筑行业而非钢铁行业） → 用Self-Query添加行业过滤重新检索
- 检索结果不足 → 用Query Expansion生成变体重新检索

Spring AI实现：自定义`CorrectiveRAGAdvisor`，在Advisor Chain中实现评估→纠正→重试循环。

#### 追问：
- 追问1：检索评估器判"结果过时"后要走知识库更新再检索，若更新本身要分钟级，CRAG 这条纠正路径在用户等待时间内是否可行？
  - **答**：分钟级更新用户等不及。CRAG“结果过时”纠正路径仅对可秒级CDC更新的因子类可行；对需重训/人工发布的法规应改为“标注数据时效+提示用户以最新官方为准”，而非在线等更新。
- 追问2：Incorrect路径切换到Web搜索，碳管家助手若联网搜到非官方或已废止法规，反而比不检索更危险，如何限定可信来源？
  - **答**：Web搜索仅限白名单域名（官方/标准组织/政府），禁开放全网；检索结果做来源可信度打分，非官方/已废止来源降级或屏蔽；关键合规回答仍以库内权威文档为准，Web仅作补充提示。
- 追问3：Ambiguous（部分可用）分支既要精炼已有片段、又要补充检索，补充检索的 Query 由谁生成，会不会陷入与 Agentic RAG 相似的循环失控？
  - **答**：由评估Agent基于已提取可用部分+原问题生成补充Query（同Agentic机制）；防失控靠跳数/Token上限与超时熔断，与Agentic共用约束，避免无限循环。


### 44. 长上下文RAG（Long Context RAG）
**重要度**：★★★★

**题目：通义千问等模型支持超长上下文（128K+ tokens），是否意味着可以放弃分块检索，直接将完整文档放入上下文？请分析Long Context RAG的适用场景和局限。**

Long Context RAG是将完整或大段文档直接放入LLM上下文而非分块检索的策略，随着模型上下文窗口增长（128K→256K→1M），这种方案越来越可行。

适用场景分析：
- **完整标准文档解读**：ISO 14064完整文本约20K tokens，可直接放入128K模型上下文
- **LCA报告全文分析**：一份完整LCA报告约30-50K tokens，128K窗口可容纳
- **多文档对比**：2-3份相关文档同时放入上下文，让LLM跨文档对比分析
- 优势：避免分块导致的上下文断裂和信息丢失，LLM能看到完整逻辑链

局限性分析：
- **注意力稀释**：研究表明LLM在超长上下文中的信息检索准确率下降（"Lost in the Middle"现象），中间位置信息被忽略
- **成本激增**：128K tokens的输入成本约是4K的32倍，每次问答成本从0.02元涨到0.64元
- **延迟增加**：Prefill 128K tokens约需10-15s（vs 4K约1-2s），用户体验下降
- **非结构化噪音**：完整文档含大量无关内容（目录、附录、排版），降低LLM聚焦能力

混合策略推荐：
- 短问题（FAQ）：传统分块RAG，低成本高速度
- 长问题（文档解读）：Long Context RAG + Prompt Caching（文档前缀缓存降低重复成本）
- 报告生成：分块检索关键信息 + Long Context汇总生成

实践：对LCA报告先用分块RAG提取关键数据点，再用Long Context将数据点+原始报告摘要一起放入上下文生成完整答案。

---

---

#### 追问：
- 追问1：128K直接放ISO全文虽避免分块断裂，但"Lost in the Middle"会让中间条款被忽略，碳管家助手是否实测过关键条款位置对答案的影响？
  - **答**：建议实测。Lost-in-the-middle对长标准确实有影响，关键条款（定义、限值）放上下文首尾更稳。碳管家可做实验：同一条款放Context不同位置测准确率，据此定排序（权威+首尾优先）。
- 追问2：长上下文Prefill 10-15s的延迟，在碳管家助手流式输出下首字要等很久，用户体验是否不可接受，有无Prompt Caching真实收益数据？
  - **答**：128K prefill 10-15s体验差，但文档前缀缓存（如ISO全文前缀）可让同文档多次问答复用KV，首字从10s降到数百ms级收益显著；仅首轮贵，后续命中缓存快，可结合“先检索定位章节再长上下文”降本。
- 追问3：你建议的"分块检索关键点+Long Context汇总"，两阶段间若分块检索漏了关键数据点，汇总阶段再长上下文也补不回，如何保证第一跳召回率？
  - **答**：第一跳是汇总的数据基础。措施：提高召回Top-K+HyDE/改写扩大候选、Hybrid多路召回减少漏检、关键数据点单独结构化索引（因子库）保证必中、第一跳后校验关键实体是否已检索到不足则补检。


#### 文档分片（Chunking）策略专题


### 45. 固定长度切分（按字符/Token + overlap）的原理与取舍？
**重要度**：★★★
最朴素：每 N 个字符或 N 个 token 切一块，相邻块重叠 `overlap` 个字符/ token。
- 优点：实现简单、长度可控、利于 batch 嵌入。
- 缺点：极易在句子/条款中间切断，破坏语义。
- **为什么必须加 overlap**：被切断的语义靠重叠区在检索时"至少一块能命中完整上下文"。纯无重叠切分会让跨边界的知识点两边都不完整。

#### 追问：
- 追问1：overlap 设多大合适？设 20% 还是 50%？过大会不会让同一内容重复进向量库导致召回冗余？
  - **答**：overlap 取 chunk 的 10–15% 最稳妥，我们碳法规库定为 10%；过大（如 50%）确实会造成冗余召回、挤占 topK 且翻倍嵌入成本，但 0 overlap 风险更高。
    - 我们块按 256–512 token、overlap 取 10%（约 25–50 token），目标只是"让跨边界条款在相邻两块都能完整命中"，而非追求高覆盖。
    - 50% overlap 会让同一段文字在两个向量里高度相似，检索 topK 时可能把本质相同的两块都召回，挤掉真正不同的候选、稀释召回质量。
    - 冗余可在 Milvus 召回后做去重/rerank（按向量相似度或内容 hash 去掉邻近重复块），但根上仍应控制 overlap 比例，别用大 overlap 掩盖切分粒度问题。
- 追问2：固定按字符切，中文按字、英文按词，token 数差异大，你们碳因子库为什么最后改成按 token 切？
  - **答**：因为嵌入模型与 LLM 都按 token 计费/截断，按字符切会让"实际 token 占用"与"块大小上限"错位；碳因子库大量中英文混排（因子名+单位+英文标准号）必须按 token 对齐。
    - 字符切下中文一个汉字≈1 字符但 BGE-M3 可能拆成多 token，英文一个词也可能数 token，同样"500 字符"实际 token 数浮动极大，易超限或浪费。
    - 碳因子条目常是"中文名称 + 英文标准/化学式 + 数值单位"，中英文密度不均，按 token 切才能稳定保证每块 ≤ 模型单块上限、喂进 Prompt 不超窗。
    - 切分 tokenizer 与 BGE-M3 对齐（LangChain4j 配通义 tokenizer），保证切出来的块 token 数与嵌入、生成阶段一致，不出现截断错位。


### 46. 递归字符切分（RecursiveCharacterTextSplitter）为什么是通用默认？
**重要度**：★★★
按分隔符优先级逐级回退：先用最"硬"的边界切，切不动再降级到更细的边界。

**先把三个框架的默认值说准（这题最容易答错）**：
- **LangChain（Python）** `RecursiveCharacterTextSplitter` 的默认分隔符是 `["\n\n", "\n", " ", ""]`——**四级，只有空行、换行、空格、单字符，没有中文句号 `。`**。
- **中文场景**通常要自己把 `。！？；` 插到 `\n` 之后，变成 `\n\n → \n → 。！？； → 空格 → 单字符`，这是**定制版，不是默认**。
- **LangChain4j** 对应的是 `DocumentSplitters.recursive(chunkSize, overlap)`，默认分隔符同样是 `\n\n / \n / 空格 / 单字符`。
- **Spring AI 没有递归字符切分器**，默认切分器是 `TokenTextSplitter`（按 token 切）；要做字符级递归切分只能自己实现，或直接借 LangChain4j 的 `DocumentSplitters.recursive`。

**为什么它是通用默认**：
- 优先在"自然边界"断开，尽量保住段落/句子完整；只在无处可断时才硬切到单字符。
- 对大多数非结构化文本（新闻、报告、网页）召回效果稳定，参数少、行为可预期，是性价比最高的起点。
- 它的短板也明确：对表格、代码块、纯文字流 PDF 都不友好，需要额外保护（见追问 2）。

#### 追问：
- 追问1：递归切分的中断优先级你们调过吗？比如中文里"`。`"和"`\n`"谁更优先，为什么？
  - **答**：我们用的是"默认四级 + 补中文标点"的定制版，优先级为 `\n\n → \n → 。！？； → 空格 → 单字符`，即段落优先于句末标点。因为碳法规里"空行/换段"比句号更能代表条款边界。
    - 默认清单里本来没有 `。`，中文场景必须自己加；我们把 `。！？；` 放在 `\n` **之后**而不是之前，先在更高层"硬边界"断开，保住"一条款=一段落"的结构，避免把上下两条款并成一块。
    - 中文法规句号密度高，若句末优先会在长条款中间频繁断开，反而破坏“完整条款”语义；我们更希望先按段落/换行保住一条款。
    - 仅在单段落超长（无换行）时才回退到句末标点与单字符硬切作兜底，配合 max chunk size 截断。
- 追问2：递归切分对"表格/代码块"会切坏吗？怎么用正则保护代码块不被拆散？
  - **答**：会切坏——表格行、代码块一旦被按换行/标点切散就丢失结构；我们用“预占位 + 自定义分隔符”在切分前把表格/代码块整块保护起来。
    - 切分前用正则把代码块和 Markdown 表格整块抽出来，替换成占位 token（如 <TABLE_1>），文本按正常分隔符切完后再回填，保证它们不被按换行拆散。
    - 对碳因子 Excel 转来的表格，先转为结构化行（每行一条因子）再单独成块，而不是塞进文本流被递归切分切碎。
    - RecursiveCharacterTextSplitter 的 separators 列表可定制，把表格/代码的边界符加入高优先级 separators，让切分器在表格边界先断、块内不断。


### 47. 句子 / 段落切分：如何保证条款不被截断？
**重要度**：★★★
以句末标点（`。！？`、英文 `.!?`）或空行（段落）为边界切分。
- 保证单条法规/FAQ 语义原子性，检索命中即完整一条，不会半句。
- 适合条款型、问答型文档（标准、规范、FAQ）。

#### 追问：
- 追问1：中文里"`。`"和"`．`"、英文缩写"`U.S.`"里的点会被误判成句末，怎么避免切错？
  - **答**：用“句末标点 + 后接大写/非数字启下”的启发式规则过滤伪句末，必要时上分句模型而非纯正则。
    - 对 U.S.、e.g.、etc. 这类缩写维护英文缩写白名单，缩写后的点不触发断句；中文“．”（全角点）仅当后接换行/引号/句首大写才断。
    - 用正则（?<=[。！？]）结合“后一个字符是空白/引号/换行”才断，过滤掉夹在数字或缩写中间的点。
    - 碳因子库若误切影响大，可直接用 NLP 分句（如 HanLP）替代正则，准确率更高，代价是 ETL 多一步依赖。
- 追问2：一段很长没有句号（如法规长定义），按句子切会整段成一块超限，怎么兜底？
  - **答**：句子切作为首选，超限时回退到“按标点/长度二级切分”的兜底策略，保证单块不超过 max token。
    - 设定硬上限（如 512 token），若某“句子/段”超上限，退化为按逗号/分号甚至按固定 token 窗（带 overlap）二次切分。
    - 长定义切多块后，用父子分片（小块检索、父块带整段上下文）保证召回粒度同时生成时不丢完整定义。
    - ETL 记录“该块为兜底硬切”标记，便于评测时区分、必要时人工复核这些异常长块。


### 48. 结构感知切分（按标题/章节层级）为什么适合碳法规 PDF？
**重要度**：★★★
利用 Markdown/HTML 标题或 PDF 书签的层级（章/节/条/款）切分，每块带层级路径元数据。
- 碳法规 PDF 有固定层级（如"第X章/第X条"），按标题切能保留"这条属于哪个标准哪章"的结构信息。
- 检索时可连同层级路径返回，答案可溯源到具体条款，审计友好。

#### 追问：
- 追问1：PDF 没有结构化书签、只有文字流，怎么从纯文本里识别"第X条"这种章节边界？
  - **答**：用“正则 + 字体/版面特征”从文字流里还原层级，提取“第X章/第X条”作为结构分隔锚点。
    - 用正则匹配 第[一二三四…0-9]+条|第[…]+章|^\s*\d+\. 等模式定位条款起始行，作为结构切分边界。
    - 借助 PDF 解析（如 PDFBox/Apache Tika）提取的字体大小/加粗信息，标题通常字号更大，可辅助区分“条款标题”与“正文”。
    - 解析出的层级写入 Milvus 的 metadata（如 {standard, chapter, article}），检索返回时一并带上，实现答案溯源到具体条款。
- 追问2：结构切出来的块大小悬殊（有的条很长有的很短），短块要不要合并、长块要不要再切？
  - **答**：用“最小/最大块”双向规整——短块向前/后合并到接近下限，长块超出上限再按句/父子拆分，避免极端块。
    - 设最小块阈值（如 <50 token 的短条），与相邻条款合并，防止向量空间里短块语义过窄、检索易被淹没。
    - 超长条款（>512 token）不强行保留整条，改用父子分片：父块存整条、子块按句切做检索，兼顾“完整可溯源”与“检索精准”。
    - 合并/再切都保留层级元数据，保证溯源路径不丢；合并时优先合并同一条下的款/项而非跨条。


### 49. 语义切分（句向量 + 相似度阈值断句）原理与代价？
**重要度**：★★★★
先把句子分别嵌入，计算相邻句向量相似度，相似度低于阈值处断开。
- 断点落在"话题转换"处，块内语义高度一致，检索精度高、避免语义断裂。
- **代价**：切分阶段就要调 embedding 模型，增加切分延迟与一次性的 embedding 成本；阈值敏感，需调参。

#### 追问：
- 追问1：语义切分的相似度阈值怎么定？不同文档（法规 vs 闲聊）要用不同阈值吗？
  - **答**：阈值按文档“话题转换密度”调，法规类用偏高阈值（容忍同条内波动）、通用/闲聊类用偏低阈值（更早断），靠评测集反选而非拍脑袋。
    - 法规文档一段内常连续讲同一法条，句间相似度高，阈值设高（如余弦 0.5+）避免把同一条拆太碎；闲聊/多主题文本阈值调低以便及时断。
    - 阈值对召回质量敏感，我们用固定评测集扫一组阈值（如 0.3/0.5/0.7）看检索@K 与最终回答准确率，选拐点。
    - 不同文档类型在 ETL 按类型存不同阈值参数，路由到对应语义切分配置，不全局一套。
- 追问2：语义切分依赖 embedding 质量，如果切分用的模型和检索用的模型不是同一个，会漂移吗？
  - **答**：会漂移——切分用的 embedding 空间与检索空间不一致，按相似度断的点在检索模型下未必是语义边界，必须“切分/检索用同一 embedding 模型”。
    - 漂移表现：切分模型认为“话题转换”处，在检索模型向量里可能仍很近，导致块边界与检索粒度错位、召回块被错误拼接。
    - 我们统一用 BGE-M3 既做切分句向量、也做入库/检索向量，保证同空间，消除漂移；这是语义切分落地的硬前提。
    - 若将来换嵌入模型，需“切分+重建向量库”同步升级，不能只换检索端，否则历史块边界全部失效。


### 50. Token 级切分（TokenTextSplitter）为什么和模型 token 对齐？
**重要度**：★★★★
按模型 tokenizer 的 token 数切分，而非字符数。
- 模型上下文、计费、截断都以 token 计；按 token 切能保证"一块 ≤ 模型单块上限"，不浪费也不超限。
- 与字符切的本质区别：中英文 token 密度不同，字符切会高估/低估实际 token 占用。

#### 追问：
- 追问1：TokenTextSplitter 用的 tokenizer 必须和在线模型一致吗？不一致会怎样？
  - **答**：切分 tokenizer 必须与“嵌入模型”一致（不必与最终生成 LLM 一致），否则块 token 数与实际嵌入占用错位，出现截断或浪费。
    - 关键对齐对象是 BGE-M3 的 tokenizer：切分按它算 token，保证入库向量对应的文本块正好是切出来的边界，不出现“块内再被嵌入截断”。
    - 若用错 tokenizer（如按 GPT 的 cl100k 切中文），中文子词数估计偏差大，同样 512“token”实际 BGE-M3 可能 700+，超单块上限被嵌入截断、丢尾部。
    - 生成端千问的上下文窗口另算，切分阶段只需保证“嵌入块 ≤ 嵌入模型单块上限”，召回后拼 Prompt 的窗口管理在检索/生成层处理。
- 追问2：chunk 设 512 token，但检索召回 5 块拼进 Prompt 就 2560 token，超出模型窗口怎么办？
  - **答**：召回块数/总长要受“生成窗口预算”约束，在检索层做“窗口感知的 topK 截断 + 摘要/压缩”，不能无脑拼 5 块。
    - 按模型实际窗口给预算：千问 plus/max 现在都是 128K 起，但**上下文仍控制在 4~8K**——窗口大不代表该塞满，塞满既踩 lost-in-the-middle 又让成本线性上升。按块相关性从高到低填，填满即停。
    - topK 不必固定 5，可动态：先召回 10 再按预算裁剪，或对低相关块做摘要压缩，长块用父子分片的父块摘要替代全文。
    - 极端长答案需求场景（整章法规），用 Late Chunking/父子分片只把“命中句”喂模型、父块做溯源引用，而非全文塞 Prompt。


### 51. 父子 / 层级分片（Small-to-Big）为什么兼顾精度与完整？
**重要度**：★★★★
- 小块（child，如 128 token）用于向量检索，粒度细、召回准。
- 父块（parent，如整段 1024 token）用于生成，给模型完整上下文，避免"只看到半句话"。
- 检索命中 child 后，回查其 parent 喂给 LLM。

#### 追问：
- 追问1：child 和 parent 在向量库里怎么存？是两张表还是一块带 parent_id 指针？
  - **答**：一张 collection 里两类记录（或同表带 type 字段），child 存向量+parent_id 指针，parent 存原文不一定要向量，用 parent_id 回查。
    - Milvus 单 collection 存所有块，加 metadata 字段 parent_id（child 指向父块 id，parent 自身为 null/自身），靠标量过滤回查。
    - 仅 child 块建向量索引用于检索；parent 块可只存原文不建向量（省算力），命中 child 后按 parent_id 直接取父块文本。
    - 也可双 collection 隔离，但单表带指针更省管理、避免父子版本不一致；更新时父子同批写入保证对应。
- 追问2：parent 很大（整章）但只命中其中一句，把整章喂给模型是不是太浪费 token？
  - **答**：是，整章喂太浪费；我们用“动态父块”——父块粒度按命中范围自适应收缩，或改用句子级小父块平衡完整与成本。
    - 不用“整章”做父块，父块设为“段落/条款级”（如 512–1024 token），命中句所在段落即父块，token 可控。
    - 若确需更大上下文，采用“命中句 + 前后邻块拼接”而非整章，仅扩到必要邻居，限制拼入长度。
    - 配合检索窗口预算（见 Q6-2），父块超预算时先摘要再喂，避免为一条答案付出整章 token。


### 52. Late Chunking（先整体编码再切）原理与对模型的要求？
**重要度**：★★★
- 传统：先切再分别嵌入，块间上下文丢失。
- Late Chunking：把长文档整体过一次长上下文 embedding 模型得 token 级向量，再按 chunk 边界做平均/池化得到块向量。
- 保留文档全局语义，块向量携带跨段信息，缓解"孤立切块"的信息损失。


#### 三种框架实现对比

##### Spring AI 1.0 实现

```java
package com.carbon.guard.latechunk;

import org.springframework.ai.document.Document;
import org.springframework.ai.embedding.EmbeddingModel;
import org.springframework.ai.vectorstore.VectorStore;

import java.util.ArrayList;
import java.util.List;

/**
 * 碳管家 Late Chunking：整篇标准一次性过长上下文编码器，再按 chunk 边界池化。
 * 对模型的要求：EmbeddingModel 必须能返回 token 级向量（last_hidden_state），
 * 而不是只有一个池化后的句向量 —— 通用云 Embedding API 拿不到 token 级输出，
 * 因此这里用本地 BGE-M3 ONNX 推理自建 EmbeddingModel。
 */
public class LateChunkingIngestService {

    /** 自建 EmbeddingModel：底层调用本地 BGE-M3 ONNX，返回逐 token 向量 */
    private final TokenLevelEmbeddingModel tokenLevelModel;
    private final VectorStore vectorStore;

    public LateChunkingIngestService(TokenLevelEmbeddingModel tokenLevelModel,
                                     VectorStore vectorStore) {
        this.tokenLevelModel = tokenLevelModel;
        this.vectorStore = vectorStore;
    }

    /**
     * Late Chunking 主流程：
     * 1) 整篇文档过一次长上下文编码器（8192 token 内），拿到 token 级向量
     * 2) 按 chunk 边界把 token 向量做平均池化（mean pooling）得到块向量
     * 3) 块向量天然携带全文上下文，条款不再孤立
     *
     * 注意 chunkTokenRanges 是【token 下标】，不能直接拿去 substring 当【字符下标】用：
     * 中文一个字可能对应 1~3 个 token，两者能差一倍以上，切出的原文和池化的向量就不是同一段。
     * 正确做法是用 tokenizer 的 offset_mapping 把 token span 映射回字符 span。
     */
    public int ingest(String fullText, List<int[]> chunkTokenRanges) {
        // 1) 整篇编码：返回 [numTokens][dim] 的二维矩阵
        float[][] tokenVectors = tokenLevelModel.encodeTokenLevel(fullText);
        // 与 token 一一对应的字符偏移：[i] = {charStart, charEnd}
        int[][] offsets = tokenLevelModel.offsetMapping(fullText);

        List<Document> chunks = new ArrayList<>();
        for (int[] range : chunkTokenRanges) {
            int start = range[0];
            int end = range[1];
            // 2) 对该 chunk 覆盖的 token 向量做平均池化
            float[] chunkVector = meanPool(tokenVectors, start, end);
            // 3) token span → 字符 span，再取原文（不要 substring(start, end)）
            int charStart = offsets[start][0];
            int charEnd = offsets[Math.min(end, offsets.length) - 1][1];
            String chunkText = fullText.substring(charStart, charEnd);
            chunks.add(new Document(chunkText, java.util.Map.of(
                    "source", "ISO 14067:2018",
                    "tokenRange", start + "-" + end)));
        }
        // 4) 入库
        vectorStore.add(chunks);
        return chunks.size();
    }

    /** 平均池化：把 chunk 内所有 token 向量求平均，再 L2 归一化 */
    private float[] meanPool(float[][] tokenVectors, int start, int end) {
        int dim = tokenVectors[0].length;
        float[] pooled = new float[dim];
        int count = 0;
        for (int i = start; i < end && i < tokenVectors.length; i++) {
            for (int j = 0; j < dim; j++) {
                pooled[j] += tokenVectors[i][j];
            }
            count++;
        }
        if (count == 0) {
            return pooled;
        }
        double norm = 0;
        for (int j = 0; j < dim; j++) {
            pooled[j] /= count;
            norm += pooled[j] * pooled[j];
        }
        norm = Math.sqrt(norm);
        if (norm > 0) {
            for (int j = 0; j < dim; j++) {
                pooled[j] /= (float) norm;
            }
        }
        return pooled;
    }
}
```

##### Spring AI 2.0 实现

```java
package com.carbon.guard.latechunk;

import org.springframework.ai.document.Document;
import org.springframework.ai.vectorstore.VectorStore;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;

/**
 * 碳管家 Late Chunking：Spring AI 2.0（Java 21）。
 * 2.0 的变化主要在应用层：Document/VectorStore API 与 1.0 一致，
 * Late Chunking 的核心仍是"整篇编码 + 按边界池化"，需自建 token 级 EmbeddingModel。
 */
public class LateChunkingIngestService {

    private final TokenLevelEmbeddingModel tokenLevelModel;
    private final VectorStore vectorStore;

    public LateChunkingIngestService(TokenLevelEmbeddingModel tokenLevelModel,
                                     VectorStore vectorStore) {
        this.tokenLevelModel = tokenLevelModel;
        this.vectorStore = vectorStore;
    }

    /**
     * 用 record 表达 chunk 的 token 边界，2.0 用 Java 21 的 record 更清晰。
     * 超过 8192 token 的超大标准先按结构切大段，每段内做 Late Chunking。
     */
    public record ChunkSpec(int startToken, int endToken, String sectionTitle) {
    }

    public int ingest(String fullText, List<ChunkSpec> specs) {
        // 1) 整篇一次性过长上下文编码器，拿到 token 级向量矩阵
        float[][] tokenVectors = tokenLevelModel.encodeTokenLevel(fullText);
        // token → 字符 的偏移映射，避免拿 token 下标当字符下标做 substring
        int[][] offsets = tokenLevelModel.offsetMapping(fullText);

        List<Document> chunks = new ArrayList<>();
        for (ChunkSpec spec : specs) {
            // 2) 按 chunk 边界做平均池化
            float[] chunkVector = meanPool(tokenVectors, spec.startToken(), spec.endToken());
            // 3) token span → 字符 span 再取原文（中文 1 字 ≈ 1~3 token，不能混用下标）
            int charStart = offsets[spec.startToken()][0];
            int charEnd = offsets[Math.min(spec.endToken(), offsets.length) - 1][1];
            String chunkText = fullText.substring(charStart, charEnd);
            // 4) 章节标题写进 metadata，池化后块仍能定位到原文位置
            chunks.add(new Document(chunkText, Map.of(
                    "source", "ISO 14067:2018",
                    "section", spec.sectionTitle(),
                    "tokenRange", spec.startToken() + "-" + spec.endToken())));
        }
        vectorStore.add(chunks);
        return chunks.size();
    }

    /** 平均池化 + L2 归一化：块向量既保留局部语义又带全文上下文 */
    private float[] meanPool(float[][] tokenVectors, int start, int end) {
        int dim = tokenVectors[0].length;
        float[] pooled = new float[dim];
        int count = 0;
        for (int i = start; i < end && i < tokenVectors.length; i++) {
            for (int j = 0; j < dim; j++) {
                pooled[j] += tokenVectors[i][j];
            }
            count++;
        }
        if (count == 0) {
            return pooled;
        }
        double norm = 0;
        for (int j = 0; j < dim; j++) {
            pooled[j] /= count;
            norm += pooled[j] * pooled[j];
        }
        norm = Math.sqrt(norm);
        if (norm > 0) {
            for (int j = 0; j < dim; j++) {
                pooled[j] /= (float) norm;
            }
        }
        return pooled;
    }
}
```

##### LangChain4j 实现

```java
package com.carbon.guard.latechunk;

import dev.langchain4j.data.embedding.Embedding;
import dev.langchain4j.data.segment.TextSegment;
import dev.langchain4j.model.embedding.EmbeddingModel;
import dev.langchain4j.store.embedding.EmbeddingStore;

import java.util.ArrayList;
import java.util.List;

/**
 * 碳管家 Late Chunking：LangChain4j 1.0。
 * LangChain4j 的 EmbeddingModel 只返回句向量，做不了 Late Chunking，
 * 必须自建实现返回 token 级向量，再手工池化后直接写 EmbeddingStore。
 */
public class LateChunkingIngestService {

    private final TokenLevelEmbeddingModel tokenLevelModel;
    private final EmbeddingStore<TextSegment> embeddingStore;

    public LateChunkingIngestService(TokenLevelEmbeddingModel tokenLevelModel,
                                     EmbeddingStore<TextSegment> embeddingStore) {
        this.tokenLevelModel = tokenLevelModel;
        this.embeddingStore = embeddingStore;
    }

    /** chunk 的 token 边界与对应文本 */
    public record ChunkSpec(int startToken, int endToken, String text) {
    }

    public int ingest(String fullText, List<ChunkSpec> specs) {
        // 1) 整篇编码，拿 token 级向量
        float[][] tokenVectors = tokenLevelModel.encodeTokenLevel(fullText);

        List<Embedding> embeddings = new ArrayList<>();
        List<TextSegment> segments = new ArrayList<>();
        for (ChunkSpec spec : specs) {
            // 2) 按 chunk 边界平均池化 → 块向量
            float[] chunkVector = meanPool(tokenVectors, spec.startToken(), spec.endToken());
            embeddings.add(Embedding.from(chunkVector));
            segments.add(TextSegment.from(spec.text(),
                    dev.langchain4j.data.document.Metadata.from("source", "ISO 14067:2018")));
        }
        // 3) 绕过 EmbeddingStoreIngestor（它会自己调句向量模型），直接写库
        embeddingStore.addAll(embeddings, segments);
        return embeddings.size();
    }

    /** 平均池化 + L2 归一化 */
    private float[] meanPool(float[][] tokenVectors, int start, int end) {
        int dim = tokenVectors[0].length;
        float[] pooled = new float[dim];
        int count = 0;
        for (int i = start; i < end && i < tokenVectors.length; i++) {
            for (int j = 0; j < dim; j++) {
                pooled[j] += tokenVectors[i][j];
            }
            count++;
        }
        if (count == 0) {
            return pooled;
        }
        double norm = 0;
        for (int j = 0; j < dim; j++) {
            pooled[j] /= count;
            norm += pooled[j] * pooled[j];
        }
        norm = Math.sqrt(norm);
        if (norm > 0) {
            for (int j = 0; j < dim; j++) {
                pooled[j] /= (float) norm;
            }
        }
        return pooled;
    }
}
```

#### 追问：
- 追问1：Late Chunking 要求 embedding 模型支持超长上下文，你们用的 BGE-M3 支持吗？长度上限多少？
  - **答**：BGE-M3 支持最长 8192 token 上下文，足以覆盖单份碳法规文档做“整体编码后切”，满足 Late Chunking 的长上下文前提。
    - BGE-M3 原生支持 8192 token 输入，能把整篇（或多页）法规一次性过编码器得到 token 级向量，再按 chunk 边界池化为块向量。
    - 超过 8192 的超大文档需先按结构/段落分大段，每段内做 Late Chunking，避免截断；碳因子条目普遍远小于此上限。
    - 用 Late Chunking 需 embedding 推理支持返回 token 级输出（M3 的 dense 表征可池化），部署时确认 LangChain4j/自研管线能拿到逐 token 向量。
- 追问2：Late Chunking 比普通切分多耗多少算力？值得为碳法规库上这套吗？
  - **答**：算力增量主要来自“整文档过一次长上下文编码器”，约比逐块嵌入多 1–2 倍编码量；对法规这类“少而精、重溯源”的库值得，对海量短文本不划算。
    - 普通切分是 N 个小块各编码一次；Late Chunking 是一整文档编码一次再池化，单文档算力接近“等于总长度编码一次”，块多时反而更省、块少时略增。
    - 碳法规库文档数有限、更新频率低，离线 ETL 阶段多出的编码成本可接受，换来“块携带跨段上下文、召回更准、条款不孤立”的收益明显。
    - 高频增量/海量小文档场景不建议默认上，优先父子+语义切分；把 Late Chunking 留给长报告/标准全文这类长文档专项。


### 53. 分片大小与 overlap 怎么定？结合碳因子库给经验值？
**重要度**：★★★★
- 太小：语义碎片化、检索噪声高、拼进 Prompt 的上下文支离。
- 太大：单块包含多主题、检索命中不精准、易超 token、嵌入稀释。
- 经验：法规条款类用 256–512 token、overlap 10–15%；FAQ 用更小块；长报告用父子分片。

#### 追问：
- 追问1：你们碳因子库最终定的 chunk size 是多少？这个值是拍脑袋还是评测出来的？
  - **答**：最终定为 384 token、overlap 12%，是“经验初值 + 检索召回@K/回答准确率评测”反选的结果，不是拍脑袋。
    - 初值取 256–512 区间中值附近，再用固定评测集（人工/LLM 标注的“问题→应命中条款”）扫 256/384/512 看 topK 召回与最终答案准确率，384 拐点最优。
    - overlap 12% 是在“跨边界条款命中率”与“冗余率”间平衡，评测显示 10–15% 区间差别小，取 12% 留余量。
    - 参数写入配置并随版本记录，后续新增文档类型（如长报告）走不同 profile，不把单一值当全局真理。
- 追问2：分片参数改了，向量库里几万块要不要全量重建？增量文档用新参数会不会和旧块不一致？
  - **答**：必须全量重建以保证一致；增量文档用新参数入库会与旧块“切分粒度不统一”，需灰度+定期重建或按文档版本隔离。
    - 切分参数（size/overlap/策略）变了，旧块向量语义边界与新房不同，混用会让检索粒度错乱，因此改参数即触发全量 re-embed 重建。
    - 重建期间用 Milvus 新 collection + 别名切换（alias），建完一次性切流量，避免在线中断；Redis 缓存的检索结果同步失效刷新。
    - 不能中途让增量用新参数、存量用旧参数；若必须灰度，按“文档批次/版本”打标隔离，检索时按标过滤，杜绝混用。


### 54. 分片策略怎么选型？附决策表与 A/B 验证？
**重要度**：★★★
按"文档类型 × 检索目标"选型：
- 法规/标准/条款 → 结构感知 + 句子切分（保条款完整、可溯源）。
- FAQ/短问答 → 句子切分或固定小窗。
- 长报告/论文 → 父子分片或 Late Chunking。
- 通用网页/新闻 → 递归字符切分（默认）。
- 验证：用固定评测集对比各策略的检索召回@K 与最终回答准确率，A/B 选定。

#### 追问：
- 追问1：决策表落地时，不同章节用不同策略，ETL 管线怎么按文档类型路由到不同 Splitter？
  - **答**：ETL 在“解析层”先给文档打 type 标签，再按 type→Splitter 配置路由，每种类型绑定一套切分参数与后处理。
    - 入口根据文档来源/扩展名/内容特征（PDF 法规 vs FAQ 表 vs 长报告）打 metadata.type，写进调度配置。
    - 用策略工厂（Spring 的 SplitterStrategy 接口）按 type 选实现：法规→结构感知+句子，FAQ→句子小窗，报告→父子/Late Chunking，网页→递归。
    - 每种策略的参数（size/overlap/阈值/保护正则）外置到配置（如 Nacos/yml），路由与调参解耦，新文档类型加一条映射即可。
- 追问2：A/B 的评测集怎么造？你们是人工标注还是用 LLM 当评委（LLM-as-judge）？
  - **答**：评测集以“人工标注黄金集”为基准、LLM-as-judge 做规模化扩量与日常回归，两者结合保证可信又可运营。
    - 人工标注少量高质“问题→标准答案片段/应命中块”黄金集（覆盖各文档类型），作为权威基线，评检索@K 与回答准确率。
    - LLM-as-judge 用千问对“检索块是否支撑答案、回答是否准确”打分，批量跑历史问题做 A/B 对比，成本低、可天天跑。
    - 人工集防 LLM 评委"放水"，LLM 集做广覆盖；新策略上线前必过人工黄金集，日常用 LLM 集监控回归，避免指标虚高。


### 55. 基于分层架构设计一个面向 LCA/碳管理业务的 RAG 知识库系统，你会怎么分层？
**重要度**：★★★★

面向碳管理业务的 RAG 系统可分五层，每层职责清晰、可独立演进：

**1. 数据层**
- 多源接入：PDF 标准/法规（ISO 14067、GHG Protocol）、Excel 因子库、内部 SOP、CBAM 报告模板、客户历史问答。
- 数据清洗：OCR → 版式解析 → 分块 → 元数据标注（标准号、版本、适用范围、产品类别）。

**2. 索引层**
- Embedding：BGE-M3（多语言、稠密+稀疏混合）。
- 向量库：Milvus 存储稠密向量。
- 全文检索：Elasticsearch BM25 补全精确匹配。
- 重排：bge-reranker-large。
- 融合：RRF（Reciprocal Rank Fusion）。

**3. 检索层**
- Query 改写（Query Rewriting）、HyDE、多路召回、多策略重排。
- 指标要分两个：**检索侧 Recall@5 从 82% 提升到 95%**；**端到端答案准确率从 75% 提升到 92%**。前者只说明"该召回的召回了"，后者才是用户感知的指标，两者不能混为一谈（92% 里有 3 个点属生成侧的 Prompt/幻觉控制贡献，见第 60 题）。

**4. 生成层**
- ChatClient 调用 LLM，结合检索结果生成答案。
- Prompt 工程：要求给出依据来源、标注标准号、不确定时明确说明。

**5. 应用层**
- 智能客服、法规解读、CBAM 填报辅助、报告生成。

#### 追问：
- 追问1：为什么 RAG 里要同时保留向量检索和 BM25，而不是只用向量？
  - **答**：向量检索擅长语义相关（如"范围三排放"和"价值链碳排放"语义接近），BM25 擅长精确匹配（如标准号"ISO 14067:2018"、法规条款编号）。碳管理领域专业术语、版本号、数值型因子多，BM25 能避免向量检索的语义漂移，二者融合可互补。实际用 RRF 融合两路结果，兼顾召回率和精确率。
- 追问2：CBAM 报告生成场景下，RAG 和 Agent 如何配合？
  - **答**：RAG 负责"读"和"查"——检索 CBAM 法规、填报模板、历史报告；Agent 负责"做"——调用计算工具、填充 Excel、生成 PDF、多轮确认缺失字段。RAG 提供上下文，Agent 负责执行流程，二者通过 MCP/Function Calling 串联。例如：用户说"帮我生成 CBAM 报告"→Agent 先用 RAG 查法规要求→调用因子库 MCP Server 查排放因子→调用计算引擎算碳足迹→生成报告。
- 追问3：如何评估"端到端准确率从 75% 提升到 92%"是可信的，而不是把检索指标和生成指标混在一起算出来的？
  - **答**：先把指标拆开再谈可信度：
    - 检索侧用 Recall@K / Hit@K / NDCG@K（82% → 95%），端到端用人工判定的"答案是否正确"（75% → 92%），两套分母不同，不能合并成一个百分比。
    - ① 从真实客服日志/法规问答中抽取 query-golden-doc 对，人工标注做 ground truth；② 固定同一批题做 A/B，只变一个因子（消融）；③ 线上埋点看"用户是否采纳答案""是否触发重新提问"；④ 检查 Recall@5 ≥ 端到端，不等式不成立说明口径算错了。
    - 多维度交叉验证才能说明指标真实提升，单一指标容易被刷分。


### 56. RAG 遇到"姓张的有多少人""同名因子""按条件查一批"这类聚合/多匹配查询怎么办？
**重要度**：★★★★

这类问题的本质是：**不是所有问题都适合走向量检索**。用户问"姓张的有哪些人"或"华东区钢铁厂 2023 年排放因子列表"，这是**结构化聚合查询**，答案在数据库里而不是文档分块里。强行走向量检索会召回一堆不相关文本块，模型还可能编造结果。

**核心方案：查询分类路由 + Text-to-SQL 分流**，整体架构分三步：

**① 查询分类（轻量 LLM 判断路由）**

用一个便宜的小模型（如 Qwen-Turbo / GPT-4o-mini），仅做一件事：判断用户查询属于哪一类：

| 类型 | 特征 | 路由到 |
|---|---|---|
| 结构化聚合查询 | "有多少""列出""按条件筛选""姓张的""2023 年的因子" | Text-to-SQL → 数据库 |
| 知识问答 | "什么是范围三""ISO 14067 怎么规定的" | 向量检索（RAG） |
| 混合 | "华东区钢铁厂用的排放因子是多少，依据是什么标准" | 先 SQL 取数据，再 RAG 取依据 |

判断 Prompt 示例：
```
你是一个查询分类器。判断用户问题属于以下哪类：
A. 结构化查询：需要从数据库查具体记录/列表/统计/筛选（如"姓张的有谁""2023 年华东区因子列表"）
B. 知识问答：需要从文档/法规中查找解释/定义/条款
C. 混合：既有数据查询又有知识检索
只输出 A / B / C，不要解释。
```

这一步成本极低（几十 token，小模型），但换掉的是一整类"必然答错"的查询——聚合类走向量检索不是效果差，而是原理上不可能答对。收益大小取决于业务里聚合 query 的占比，别对外承诺没有分母的百分比。

**② Text-to-SQL 分支（处理聚合查询）**

判定为 A 或 C 类时，走 Text-to-SQL 流程：

- **上传表结构**：把业务库的 Schema（表名、字段、注释、外键关系）作为 context 注入 Prompt，让 LLM 理解有哪些表可以查。
- **生成 SQL**：LLM 根据用户问题 + 表结构生成 SQL 语句。
- **安全执行**：生成的 SQL 经过校验（只允许 SELECT，禁止 DDL/DML），限制 LIMIT 上限（如 1000 行），在只读副本上执行。
- **结果格式化**：SQL 结果回传给 LLM 做 natural language 总结，或直接以表格形式返回前端。

Text-to-SQL Prompt 示例：
```
你是一个 SQL 生成助手。根据用户问题和数据库表结构，生成一条只读 SELECT 语句。

数据库表结构：
-- 员工表
CREATE TABLE employee (
  id BIGINT PRIMARY KEY COMMENT '员工ID',
  name VARCHAR(50) COMMENT '姓名',
  department VARCHAR(50) COMMENT '部门',
  ...
);

-- 碳因子表
CREATE TABLE emission_factor (
  id BIGINT PRIMARY KEY,
  name VARCHAR(100) COMMENT '因子名称',
  standard VARCHAR(50) COMMENT '标准号',
  year INT COMMENT '年份',
  region VARCHAR(50) COMMENT '适用地区',
  industry VARCHAR(50) COMMENT '所属行业',
  value DECIMAL(10,6) COMMENT '因子值',
  unit VARCHAR(20) COMMENT '单位',
  ...
);

用户问题：姓张的有哪些人？分别属于什么部门？
要求：只生成 SELECT 语句，加 LIMIT 防止全表扫描。
```

生成结果：`SELECT name, department FROM employee WHERE name LIKE '张%' LIMIT 100;`

**③ RAG 分支（处理知识问答）**

判定为 B 类时，走正常的向量检索 + BM25 混合检索 + 重排，从文档库中检索相关分块交给 LLM 生成答案。

**混合查询（C 类）**：先走 Text-to-SQL 取数据，再把数据结果 + RAG 检索到的法规依据一起拼入 Prompt，让 LLM 综合回答。

**工程要点：**

- **字段存在性校验（最高频的翻车点）**：生成的 SQL 必须逐字段比对 Schema，DDL 里没有的字段（如把 `department` 写成 `dept`、或凭空用了表里不存在的 `industry`）直接拒绝并让模型重生成，别指望数据库报错兜底。
- **聚合结果校验**：COUNT / SUM / GROUP BY 出数后必须交叉验证——用明细抽样核对（`COUNT(*)` 与 `LIMIT 20` 采样是否能对上前 N 条）、分组合计与总量是否一致、单位是否统一后再聚合（t 与 kg 混在一起求和是碳因子聚合最常见的错误）。JOIN 放大行数导致 SUM 翻倍，也要靠"明细对账"发现。
- **口径校验（去重后的实体数 ≠ 行数）**："有多少家企业""多少个产品"问的是**实体数**，而 `COUNT(*)` 数的是**行数**——同一企业有多年份/多因子/多分厂就是多行，直接用 COUNT(*) 会把 1 家企业算成 8 家。必须 `COUNT(DISTINCT company_id)`，AVG 也要先落到实体粒度再去重求均值，否则数据多的大企业被过度加权。回答时要写清口径："按企业去重后 42 家（明细 137 行）"。
- **空结果回退**：`SELECT ... WHERE year=2023 AND region='华东'` 返回 0 行时，不能直接告诉用户"没有数据"（可能是条件过严而非库里没有）。先做一次分层放宽——去掉地区→去掉年份→改成 LIKE 模糊匹配，逐层重试并说明放宽了什么；三层都为空才回答"库中查无该口径数据，请补充产品/年份"，**绝不允许模型自己猜一个数填上**。
- **表结构管理**：Schema 不全量上传（太大），按业务域裁剪——用户问员工就只给 employee 相关表，问因子只给 emission_factor 相关表。可用向量检索表结构本身（对表名/字段名做 embedding），先检索相关表再注入 Prompt。
- **SQL 安全**：SQL Parser 校验语法 + 白名单（只允许 SELECT/WHERE/GROUP BY/ORDER BY/LIMIT），禁止子查询写入、禁止 UNION 跨库，只读账号执行。
- **结果可控**：SQL 结果超 N 行时分页或提示"匹配过多，请加筛选条件"。
- **兜底**：Text-to-SQL 生成失败或 SQL 执行报错时，回退到 RAG 检索 + 追问用户补充条件。
- **缓存**：常见聚合查询（如"今年的因子列表"）结果缓存，避免重复生成 SQL。

**碳管理场景举例：**

| 用户问题 | 分类 | 路由 |
|---|---|---|
| "姓张的有哪些人" | A（结构化） | Text-to-SQL: `SELECT name, department FROM employee WHERE name LIKE '张%'` |
| "姓张的有多少人" | A（结构化聚合） | Text-to-SQL: `SELECT COUNT(*) FROM employee WHERE name LIKE '张%'` |
| "各行业 2023 年平均排放因子" | A（结构化聚合） | Text-to-SQL: `SELECT industry, AVG(value) AS avg_value FROM emission_factor WHERE year=2023 GROUP BY industry ORDER BY avg_value DESC` |
| "华东区钢铁厂 2023 年的排放因子" | A（结构化） | Text-to-SQL: `SELECT name, standard, value, unit FROM emission_factor WHERE region='华东' AND industry='钢铁' AND year=2023` |
| "什么是范围三排放" | B（知识问答） | RAG 向量检索 GHG Protocol 文档 |
| "华东区钢铁厂用的因子是多少，依据什么标准" | C（混合） | 先 SQL 取因子值，再 RAG 检索标准依据，拼接回答 |
| "ISO 14067 和 GHG Protocol 的区别" | B（知识问答） | RAG 向量检索 |
| "去年碳足迹最高的 10 个产品" | A（结构化） | Text-to-SQL: `SELECT product_name, footprint FROM lca_result ORDER BY footprint DESC LIMIT 10` |

#### 追问：
- 追问1：Text-to-SQL 生成的 SQL 如果查出了错误数据怎么办？怎么保证准确性？
  - **答**：三层保障：
    - ① **SQL 校验**：生成后用 SQL Parser 检查语法 + 白名单（只允许 SELECT），禁止危险操作
    - ② **结果审查**：对关键查询（报告生成场景）让 LLM 对 SQL 结果做二次校验——"这条 SQL 查的是用户要的吗？字段对不对？"
    - ③ **可解释性**：LLM 回答时必须附上生成的 SQL 和表结构映射，让用户/审计可以核对
    - 此外，Text-to-SQL 的准确率依赖表结构质量——字段注释清晰、外键关系完整，生成准确率会显著提高。
- 追问2：表结构很大，全部塞进 Prompt token 会爆，怎么裁剪？
  - **答**：
    - ① **按域裁剪**：先对表名/表描述做 embedding，用户问题向量检索最相关的 N 张表，只注入这几张表的 DDL
    - ② **精简 Schema**：只给表名 + 字段名 + 注释 + 主外键，不给索引/约束/默认值等无关信息
    - ③ **分层注入**：先给表概览（表名 + 一句话描述），LLM 选定表后再注入详细 DDL
    - ④ **缓存 Schema embedding**：表结构变动不频繁，embedding 可预计算缓存，不每次实时检索
- 追问3：查询分类器判断错了怎么办？比如把结构化查询误判成了知识问答。
  - **答**：
    - ① **兜底机制**：RAG 分支检索结果如果 top-K 相似度都很低（如 < 0.6），说明文档库里没有匹配内容，大概率是分类错误，自动重试走 Text-to-SQL 分支
    - ② **反馈闭环**：记录分类错误的 case，定期分析并优化分类 Prompt 或加入 few-shot 示例
    - ③ **置信度阈值**：分类器不只输出 A/B/C，还输出置信度，低置信度时并行跑两个分支取更优结果
    - ④ **用户纠偏**：如果 SQL 分支返回"未找到相关表/字段"，提示用户"这是数据查询还是知识问题？"让用户确认路由
- 追问4：你们用的 Text-to-SQL 模型是哪个？市面有哪些专门的 Text-to-SQL 模型？为什么不选它们？能本地部署吗？
  - **答**：我们用的是**通义千问 Qwen-72B + few-shot Prompt**，走 Spring AI 的 `ChatClient` 统一调用。市面上有专门的 Text-to-SQL 模型，但我们评估后没有选，原因如下：

    **主流 Text-to-SQL 模型一览：**

    | 模型 | 来源 | 特点 | 参数量 |
    |---|---|---|---|
    | Qwen3-Coder | 阿里 | 代码生成强，SQL 语法与结构化输出好，有 30B-A3B / 480B-A35B 等档 | 30B~480B |
    | CodeLlama | Meta | 基于 Llama 的代码模型，社区有 SQL 微调版 | 7B~34B |
    | SQLCoder | defog.ai | 专门针对 Text-to-SQL 微调的开源模型，基于 CodeLlama/Llama-3 | 7B/15B/70B |
    | DeepSeek-Coder | 深度求索 | 代码能力强的国产开源模型 | 1.3B~33B |
    | NSQL | NumbersStation | 商业 Text-to-SQL 模型 | 未公开 |

    **为什么不选这些专用模型：**

    1. **业务表结构是私有的**：专用模型在 Spider/WikiSQL 等公开数据集上训练，没见过我们的表名、字段命名和业务术语。直接用反而不如通用模型 + 我们自己维护的 few-shot 示例库（约 50 条"问题→SQL"示例，覆盖员工查询、因子查询、碳足迹查询等高频场景）。
    2. **架构统一性**：Spring AI 统一管理所有 LLM 调用，Text-to-SQL 和 RAG 共用同一个 `ChatClient`，只是 Prompt 不同。引入专用模型意味着多一套部署链路、多一套监控，运维成本增加。
    3. **few-shot 比微调更灵活**：新业务表上线时加几条示例就行，不用重新训练。专用模型每加一批新表就要重新微调，周期长。
    4. **实测准确率够用**：表结构注释清晰 + few-shot 充分时，Qwen-72B 的 SQL 生成准确率能达到 90%+，加上"自我审查"（让模型重新检查 SQL 是否正确）能到 95% 左右。

    **能不能本地部署？**

    **完全可以，而且这是很多企业的实际选择**，尤其对数据安全敏感的碳管理/ESG 场景：

    显存账按 FP16 ≈ 2GB/十亿参数、INT4 ≈ 0.5GB/十亿参数算（另加 10~20% 的 KV Cache 余量）：

    | 方案 | 部署方式 | 硬件需求（FP16 / INT4） | 适合场景 |
    |---|---|---|---|
    | Qwen2.5-Coder-7B | 本地 GPU 部署 | FP16 ≈14GB：1 张 A10/4090 够；INT4 ≈4GB | 轻量级，响应快 |
    | Qwen2.5-Coder-32B | 本地 GPU 部署 | FP16 ≈64GB：1 张 A100-80G 够；INT4 ≈16GB：单卡 A10 可跑 | 精度高，复杂 SQL |
    | SQLCoder-15B | 本地 GPU 部署 | FP16 ≈30GB：1 张 A100-40G 或 2 张 24G | 纯 Text-to-SQL 专用 |
    | DeepSeek-Coder-33B | 本地 GPU 部署 | FP16 ≈66GB：1 张 A100-80G；INT4 ≈17GB | 国产化合规 |
    | Qwen-72B（我们当前方案） | API 调用（阿里云百炼） | 若自建：FP16 ≈144GB，2 张 A100-80G 可跑，4 卡是为长上下文/高并发留余量 | 快速迭代、无需运维模型 |

    我们当前走 API（阿里云百炼平台）而非本地部署，原因：
      - ① 团队精力在业务逻辑而非模型运维
      - ② 72B 自建需要 FP16 约 144GB 显存（2 张 A100-80G 起步），按吞吐留余量后成本仍高，还要算上模型运维人力
      - ③ 数据脱敏后调用 API 可接受
      - 但如果后续客户有私有化部署需求（如大型央企/军工客户要求数据不出内网），方案是：**切换到 Qwen2.5-Coder-14B 本地部署 + 自有 few-shot 示例库**，14B 单卡 A10 即可跑，延迟和成本都可控，准确率在业务域内调优后也能到 90%+。

    **总结一句话**：专用模型能本地部署，但"通用大模型 + 业务 few-shot"在落地速度和灵活性上更优；当私有化/数据安全成为硬约束时，再切到本地部署的代码模型即可。


---


### 57. RAG系统的检索结果置信度你们是如何计算的？低于阈值时怎么处理？
**重要度**：★★★★

**置信度定义**：衡量 RAG 检索结果与用户问题的相关程度，用于判断检索结果是否可信。

**碳管家置信度计算方式**：
1. **向量相似度分数**：bge-large-zh-v1.5 输出 query 与 chunk 的余弦相似度，理论上在 [-1, 1]，实际文本场景基本落在 0.3~0.9。碳管家按分数分布标定：Top-1 相似度 > 0.75 高置信，0.6~0.75 中置信，< 0.6 低置信（这三个值是分位数标出来的，不是通用常数）。
2. **Re-ranking 分数**：bge-reranker-large 输出的是**原始 logit**，不是 0~1 的概率——它可以为负、也可以远大于 1，典型区间在 -10~10，**不能直接和余弦相似度加权**（量纲不同）。
3. **综合置信度**：先用 sigmoid 把 reranker logit 压到 (0,1)，再做 `Confidence = 0.4 × Similarity + 0.6 × sigmoid(RerankerScore)`；也可以干脆只用 reranker 排序、不与余弦融合（Cross-Encoder 本身就更准，融合主要是为了给低分兜底）。**阈值必须在归一后的分布上重新标定**，不能把余弦的 0.75 / 0.6 直接套到 logit 上。

**阈值策略（三档降级）**——下表的置信度是"融合后的归一化分数"，等价于 sigmoid 之后的 (0,1) 空间：

| 置信度 | 策略 | 用户体验 |
|--------|------|----------|
| > 0.75 | 正常 RAG 生成 | 基于知识库内容生成详细回答，标注来源 |
| 0.6 - 0.75 | 附加免责声明 | 生成回答 + "以上信息仅供参考，建议核实最新法规原文" |
| < 0.60 | 降级处理 | 不调用 LLM，返回"根据现有知识库，未找到与您问题高度相关的信息。建议：1）尝试更具体的关键词 2）联系碳管理专家人工咨询" |

**效果**：低置信度降级策略将幻觉率从 15% 降到 3% 以下——因为大部分幻觉发生在检索结果不相关时模型"强行编造"的场景，通过阈值拦截这些场景即可大幅降低幻觉。

#### 追问：
- 追问1：综合置信度 = 0.4×相似度 + 0.6×sigmoid(Reranker)，这个权重是怎么调出来的，换成 0.5/0.5 时降级误杀率和幻觉率如何变化？
  - **答**：权重调参与敏感度：
    - 前提：reranker 的 logit 先过 sigmoid 才能参与加权，否则量纲不同、加权没意义；这一步不做，后面的阈值全是错的。
    - 权重由标注集上扫网格得出：以"降级误杀率"与"漏放幻觉率"双目标最优为准则，Reranker 更准故给 0.6。
    - 若改 0.5/0.5：纯向量分占比上升，对表述差异更敏感，误杀可能略升；但因 Reranker 仍占一半，幻觉率变化不大。
    - 实际以 A/B 回归监控两率，权重是经验值而非铁律，可随模型更换重调。
- 追问2：低置信度直接返回"未找到信息"，会不会把本应触发"建议升级人工"的有价值线索打断，造成用户体验断层？
  - **答**：低置信度下的体验连续性：
    - 不硬断：低置信返回中已内置"建议更具体关键词/联系专家"的引导（[第 58 题](/03-rag.html#q-3-58)三档策略），并非简单丢弃。
    - 对"疑似相关但低置信"可升级人工而非直接拒答，保留线索；高价值咨询走人工闭环。
    - 监控"未找到"后被用户追问/转人工的比例，作为体验断层的量化信号持续优化。
- 追问3：0.6–0.75 中置信档附加免责声明，如果用户忽略声明直接采信，碳管家如何在合规上自证已尽到提示义务？
  - **答**：合规自证已尽提示义务：
    - 声明在回答中显式呈现（非隐藏），并记录"返回内容含免责声明"的日志/时间戳，形成可追溯证据。
    - 关键场景（如合规上报口径）强制要求用户二次确认"已知晓仅供参考"，才允许导出/引用。
    - 服务条款与 UI 均明示 AI 回答非权威依据，配合内容审核与人工复核，构成完整尽责链条。


### 58. 如何评估RAG系统的端到端效果？你们用什么评估框架？
**重要度**：★★★★

**评估维度**：RAG 系统的端到端效果不仅是"检索准确率"，而是用户从提问到获得满意回答的全链路体验。

**碳管家评估体系（5 维度）**：

| 维度 | 指标 | 评估方法 | 目标值 |
|------|------|----------|--------|
| 检索质量 | Recall@5 / Precision@5 | 标注集自动评测 | Recall@5 95% / Precision@5 72% |
| 回答准确性 | Faithfulness（忠实度） | RAGAS 自动评测 + 人工抽检 | 0.94（0-1） |
| 回答相关性 | Answer Relevancy | RAGAS 打分（0-1） | ≥0.85（当前 0.89） |
| 回答相关性 | 用户点赞率（辅助信号） | 线上埋点 | ≥80% |
| 引用准确性 | Citation Accuracy | 人工验证引用是否正确 | 95% |
| 拒绝准确率 | Rejection Accuracy | 检查"无法回答"的判断是否正确 | 90% |

> 量纲别混：RAGAS 的 Faithfulness / Answer Relevancy 都是 **0-1**，5 分制人工评分单独一列，两者不能写成同一个格子（如"4.3/5"不能当 Answer Relevancy 的目标值）。
>
> **端到端准确率 92%**（基线 75%）是这套指标的总出口；它和 Recall@5 95%、Faithfulness 0.94 是三个不同指标，分母不同——见第 23 题追问 2 的说明。

**RAGAS 评估框架**：
- **Faithfulness**：回答是否忠实于检索到的 context（不编造信息）。碳管家 Faithfulness = 0.94。
- **Answer Relevancy**：回答是否与问题相关。碳管家 = 0.89。
- **Context Recall**：检索到的 context 是否覆盖了回答所需的信息。碳管家 = 0.85。
- **Context Precision**：检索到的 context 中相关信息的比例。碳管家 = 0.78。

**评估流程**：
1. **评测集**：先用 300 条人工标注建基线（这是专家标注的成本上限），再扩充到 500 条做日常回归；每条包含 query + 标准答案 + 标注的正确 chunk。
2. **自动评测**：每日跑 RAGAS 回归（CI 集成），对比指标变化。
3. **人工抽检**：每周随机抽取 50 条问答，碳管理专家做 1-5 分评估。
4. **用户反馈**：实时收集用户点赞/点踩，计算 CSAT（Customer Satisfaction）。

#### 追问：
- 追问1：RAGAS 的 Faithfulness 也是由 LLM 打分的，它本身可能误判，碳管家如何校准这个"裁判模型"的可靠性？
  - **答**：裁判模型的校准：
    - 用人工标注子集做"裁判 vs 人"一致性检验（如 Kappa），量化裁判偏差，定期重标定提示词。
    - 对裁判高置信但与人不一致的边界样本重点复核，必要时换更强模型做裁判或多人仲裁。
    - 不单信自动分：Faithfulness 与"碳因子数值校验/引用检查"等硬规则交叉印证，降低单一 LLM 裁判的误判风险。
- 追问2：用户点赞率作为 Answer Relevancy 的代理指标，存在沉默大多数偏差（只有极端满意/不满才点赞），如何补足信号？
  - **答**：点赞偏差的信号补足：
    - 引入隐性信号：追问率、停留时长、复制/导出行为、会话是否继续，比点赞更能反映真实相关度。
    - 主动抽样：对"沉默"会话做轻量问卷或人工抽检，补全中性样本。
    - 用 RAGAS Answer Relevancy 等自动指标与隐性行为联合建模，减少对显式点赞的依赖。
- 追问3：引用准确性目标 95% 但由人工验证，规模化后人工成本能否被自动校验替代，自动校验的边界在哪？
  - **答**：引用准确性自动校验的边界：
    - 可自动校验部分：引用编号/条款是否存在、是否落在检索 context 内、来源链接可达——用规则+检索回查实现，覆盖大部分。
    - 边界：引用的"适用性/解读是否正确"仍需人审或强模型判断，自动难完全替代。
    - 策略：自动校验做全量初筛+告警，人工只复核低置信/高风险引用，95% 目标在人机协同下可持续。


### 59. 检索结果不理想时你们有哪些优化手段？请按效果排序说明。
**重要度**：★★★★

碳管家的端到端准确率从 **75%（纯向量 Top-5 基线）优化到 92%**，检索侧 Recall@5 从 82% 提到 95%。下面按**单手段边际收益**（在 75% 基线上单独加入该手段的实测增量）排序：

1. **Re-ranking（+5pt，收益最大）**：加入 bge-reranker-large 做 Cross-Encoder 精排，将 Top-20 → Top-5。Cross-Encoder 比双塔模型（Bi-Encoder）准确率高 10-15%，因为 Query 和 Document 在同一模型中做交互注意力。
2. **分块策略优化（+4pt）**：从固定长度分块（512 token）改为按标准章节语义分块（保持条款完整性），避免条款被切断导致语义断裂。
3. **查询改写（+3pt）**：用 LLM 将用户原始 query 改写为更利于检索的形式。如"钢铁碳排放"→"钢铁行业 温室气体排放因子 GWP 排放量"。
4. **多路召回（+2.5pt）**：同时做向量检索 + 关键词检索（BM25/ElasticSearch），结果做 RRF 融合。向量检索擅长语义匹配，关键词检索擅长精确匹配（如碳因子数值、标准编号）。与改写合并实施时（两者作用在同一条召回链路上）合计贡献 +5pt，重叠约 0.5pt。
5. **Embedding 模型领域微调（+1pt）**：在 bge-large-zh-v1.5 基础上用碳管理领域数据做对比学习微调，提升碳术语的语义区分度。注意它与查询改写的收益高度重叠（都在修"术语不匹配"），合并实施后边际会被摊薄到 +0.5pt 以内，所以没单列为阶段。
6. **HyDE 假设文档检索（+0.5pt）**：先用 LLM 生成一个"假设答案"，用假设答案的 Embedding 做检索。它只在概念/解释类问题上有效，数值类查询反而有害（见第 42 题追问 2）。
7. **元数据过滤（+0.5pt）**：检索时先按 `doc_type`（标准/法规/因子库）和 `industry`（冶金/化工/建材）过滤，再做向量检索，缩小搜索空间提升精度。小库时收益低，库变大后边际收益上升。

**这些百分比不能相加**：这 7 项单手段消融之和 16.5pt，加上第 4 阶段生成侧的 +3pt 共 19.5pt，明显大于全链实际增益 17pt——差额约 2.5pt 被手段间的重叠吃掉（改写与多路召回、改写与 Embedding 微调、HyDE 与改写都作用在同一条链路上）。对外只讲分阶段账：**75 → 80 → 85 → 89 → 92**（+5/+5/+4/+3 = 17pt，能对上），不要把这些边际百分比叠加成"提升 19.5%"。

#### 追问：
- 追问1：你按投入产出比排序，但如果多个手段叠加后彼此冲突（如 HyDE 改写改变了向量分布反而降低 BM25 命中），如何做组合调优？
  - **答**：手段冲突的组合调优：
    - 不是静态排序，而是按"消融实验"逐个增减，量化每个手段在组合中的边际贡献，剔除负贡献项。
    - 对冲突项做解耦：如 HyDE 改写只用于向量路，BM25 仍用原 query，两路 RRF 融合互不污染。
    - 用标注集 A/B 持续回归，组合以端到端指标为准而非单手段理论收益。
- 追问2：元数据过滤（+0.5pt）看似收益最低，是否在知识库变庞大后其边际收益会显著上升，排序是否随规模变化需重评？
  - **答**：元数据过滤的收益随规模重评：
    - 会。小规模时噪声少、向量检索够用；库变大后"按 doc_type/industry 预过滤"能显著缩小搜索空间、抑制跨域误召回，边际收益上升。
    - 排序不是一次定死，应在规模/数据分布变化后重做消融，重排优化手段优先级。
    - 元数据过滤还可与多租户隔离结合，兼具精度与数据安全价值。
- 追问3：这些优化都基于碳管理语料，若碳管家拓展到国际碳市场（英文/多标准），这套排序是否仍然成立？
  - **答**：拓展国际碳市场的适配：
    - 大框架（Re-ranking、查询改写、多路召回）仍成立，但需换/补多语言 Embedding（如 BGE-M3）与英文语料微调。
    - 多标准带来语义歧义（同词不同口径），元数据过滤与分块策略权重会上升，需重新消融定排序。
    - 结论：方法论可迁移，具体排序与模型选型必须按新语料重评，不能照搬。


### 60. 你们的碳管家AI助手的检索准确率从75%提升到92%，具体是怎么做的？请详细说明每个优化阶段。
**重要度**：★★★★

这是一个分阶段迭代优化的过程，每个阶段解决一个核心瓶颈：

> 口径先说清：这里的 75% → 92% 是**端到端答案准确率**（人工判定"检索正确且回答正确"的比例），不是检索指标。检索侧对应的是 Recall@5 82% → 95%。两个指标分母不同，但必须满足 **Recall@5 ≥ 端到端**。

**阶段一：75% → 80%（加入 Re-ranking）**
- 瓶颈：纯向量检索的 Top-5 中有 2-3 个不相关 chunk，干扰 LLM 生成。
- 方案：加入 bge-reranker-large 做 Cross-Encoder 精排。从 Top-20 中重排选 Top-5，相关 chunk 排名提升。
- 效果：Recall@5 从 82% 提升到 88%，端到端准确率 75% → 80%（+5pt）。
- 耗时：1 天（集成 ONNX 模型 + 调试参数）。

**阶段二：80% → 85%（查询改写 + 多路召回）**
- 瓶颈：用户 query 简短或口语化（"钢铁碳排因子"），Embedding 与知识库文档的表述风格不匹配。
- 方案：用通义千问做 query 改写——将简短 query 扩展为包含碳管理专业术语的完整查询。同时加入 BM25 关键词检索做多路召回，RRF 融合。
- 效果：Recall@5 88% → 93%，端到端 +5pt（主要是查全率提升，减少了"检索不到"的场景）。
- 耗时：3 天（Prompt 调优 + BM25 集成 + RRF 参数调优）。

**阶段三：85% → 89%（分块策略优化）**
- 瓶颈：固定长度分块（512 token）经常将 ISO 标准的一个条款切为两半，导致半截条款语义不完整。
- 方案：改为按标准章节结构做语义分块。注意 PDFBox **没有标题层级语义**——它只能拿到文字流和字号/字重/坐标，所以做法是"PDFBox 提取文本 + 字体坐标 → 用字号聚类 + `第X章/第X条` 正则还原层级 → 按条款分块"（有书签的 PDF 才可直接读 outline，见第 48 题追问 1）。
- 效果：Recall@5 93% → 95%，端到端 +4pt（避免了条款被切断导致的"检索到了半截信息"问题）。
- 耗时：5 天（PDF 结构解析 + 分块逻辑重写 + 全量重建知识库）。

**阶段四：89% → 92%（幻觉控制 + Prompt 优化）**
- 瓶颈：即使检索结果正确，LLM 仍然有时"不忠实"于检索内容（自由发挥编造信息）。
- 方案：强化 System Prompt 约束（"必须基于以下知识库内容回答，不可添加知识库以外的信息"）+ 引用标注 + 置信度阈值过滤 + 后处理碳因子数值校验。
- 效果：端到端 +3pt（减少了"检索正确但回答错误"的幻觉场景）；**Recall@5 停在 95% 不变**——这一步不改善检索，只把"检索到了"转化成"用对了"。
- 耗时：2 天（Prompt 调优 + 校验逻辑开发）。

**总结**：优化的核心思路是"找准瓶颈 → 针对性优化 → 量化效果"，+5/+5/+4/+3 合计 17pt，与 75%→92% 对得上。每次优化都用标注集做 A/B 对比，确保每一步都有可量化的提升。

> 口径提醒：**Recall@5（95%）≥ 端到端准确率（92%）**。召回是端到端的上限——没召回到正确 chunk 就不可能答对；两者差的 3pt 就是"检索到了但生成没用对"的部分。任何让端到端超过 Recall@5 的数字都是错的。

#### 追问：
- 追问1：每个阶段都用标注集做 A/B，但线上真实分布随法规更新而漂移，历史标注集能否代表阶段四之后的新分布，是否会高估 92%？
  - **答**：标注集漂移与高估风险：
    - 会。法规更新后新题型/新术语增多，旧标注集代表性下降，阶段四后的 92% 可能偏乐观。
    - 缓解：评估集每月补 50 条新 query（[第 61 题《如何搭建RAG评估集？评估集需要多少条数据？》](/03-rag.html#q-3-61)），并保留"新鲜度"加权，使指标反映近期分布。
    - 同时看线上真实反馈（拒答率/返工率）作为补充，不全依赖离线 92%。
- 追问2：阶段四靠 Prompt 约束 + 置信度过滤降低幻觉，这把"答错"转成了"拒答"，92% 的准确率是否掩盖了拒答率上升带来的体验下降？
  - **答**：拒答率与体验的权衡：
    - 确实可能：准确率上升若来自"答错→拒答"，需同时监控拒答率/未找到率，不能只看单一准确率。
    - 碳管家以"合规优先"：宁可拒答也不编，但用降级提示+转人工把体验断层降到最低（[第 58 题](/03-rag.html#q-3-58)三档策略）。
    - 目标是"准确率+可接受拒答率"双指标达标，拒答率异常升高即回头调阈值/扩召回。
- 追问3：从 92% 再往上每提升 1% 的边际成本急剧上升，碳管家是否设定了停止优化的 ROI 阈值，依据是什么？
  - **答**：优化停止的 ROI 阈值：
    - 设 ROI 阈值：单点准确率提升带来的"合规风险下降+用户留存"收益 vs 工程/算力/标注成本，边际收益<成本即停。
    - 依据：碳场景把"合规红线"作为硬约束（幻觉必须<3%），达标后剩余提升按性价比排序，不再无上限投入。
    - 阈值随业务阶段调整：新客户拓展期可容忍更高投入，稳定期收紧。


### 61. 在实际项目中，你是如何搭建RAG评估集的？评估集需要多少条数据？
**重要度**：★★★★

**评估集的重要性**：没有评估集就无法量化优化效果，所有"感觉好了一点"都是主观判断。评估集是 RAG 系统优化的"标尺"。

**碳管家评估集构建流程**：

1. **数据来源**：从线上真实用户 query 中抽取（按意图分类分层抽样），而非人工编写。真实 query 代表真实分布。
2. **样本量**：300 条人工标注做基线，扩充到 500 条做回归。低于 200 条统计不显著（置信区间太宽，1~2 个点的差异无法区分），高于 1000 条标注成本过高，500 条是"统计可用 × 专家标得起"的平衡点。
3. **分层抽样**：按意图类型分层——碳法规查询 30%、碳排放因子查询 25%、LCA 方法学 20%、碳交易/碳市场 15%、其他 10%。
4. **标注内容**：每条 query 标注——正确答案摘要（参考回答）、正确答案所在的 chunk ID、相关度等级（完全相关/部分相关/不相关）。
5. **标注质量**：2 人独立标注 → 计算 Fleiss' Kappa 一致性 → Kappa > 0.7 后取共识标注。
6. **持续维护**：每月补充 50 条新 query（反映新法规、新场景），淘汰过时 query。

**评估集使用**：
- **每日回归**：CI Pipeline 每日跑 RAGAS 自动评测，指标下降 > 2% 触发告警。
- **优化验证**：每次检索策略/Prompt 变更前，先在评估集上跑 baseline，变更后对比。
- **A/B 测试**：线上灰度时用评估集指标做决策依据。

#### 追问：
- 追问1：500 条按意图分层抽样，若某类意图（如碳交易）线上实际占比远低于 15%，评估集是否应改为按真实流量而非均匀分层？
  - **答**：分层比例与真实流量：
    - 应兼顾：若以"代表线上体验"为目标，按真实流量占比分层更准；若以"覆盖长尾能力"为目标，对低频高价值意图（如碳交易合规）过采样有必要。
    - 折中：主流意图按流量、低频但高风险意图适当过采样，并分别报告分意图指标。
    - 关键是清楚区分"总体加权准确率"与"分意图准确率"，不被均匀分层误导。
- 追问2：Fleiss' Kappa>0.7 才取共识标注，若两位专家在碳方法学上长期无法达成一致，是否意味着该题本身标注标准模糊需先定规范？
  - **答**：标注不一致的根因处理：
    - 是的。长期低 Kappa 往往暴露标注规范模糊（如"相关"界定不清、方法学边界不明），应先修订标注指南而非硬凑一致。
    - 引入第三方资深专家仲裁，并沉淀"标注 FAQ/边界样例"，把隐性知识显性化。
    - 只有规范统一后 Kappa 才有意义，否则共识标注只是掩盖分歧。
- 追问3：每月补 50 条、淘汰过时 query，淘汰标准是什么，会不会因淘汰了"难样本"而让评估集逐渐变简单、分数虚高？
  - **答**：淘汰标准与难度保持：
    - 淘汰标准：法规废止导致问题失效、标注规范变更、重复冗余、或已稳定 100% 答对且无区分度。
    - 防"分数虚高"：淘汰时保留难样本库，不因"太简单"删掉有区分度的题；新补样本含相当比例近期难题。
    - 监控评估集难度分布（如平均分变化），若整体异常上升提示集在变易，需补难样本校准。


### 62. 大模型的回答你们是如何做质量审计的？有没有自动化方案？
**重要度**：★★★★

**质量审计的目标**：确保 AI 回答符合"准确、相关、安全、合规"四项标准。

**碳管家质量审计体系（3 层）**：

**第一层：实时自动审核（100% 覆盖）**：
- **敏感词过滤**：AI 输出实时扫描敏感词库（政治敏感、违规建议）。
- **碳因子数值校验**：用正则提取回答中的数值，自动查询碳因子数据库做交叉验证，不匹配则标记。
- **引用格式检查**：检查回答是否包含来源引用（"根据 ISO 14067..."），未引用的回答标记为"低引用质量"。
- **长度异常检测**：回答 < 20 字（可能回答不完整）或 > 2000 字（可能冗余）时标记。

**第二层：RAGAS 自动评测（每日）**：
- 每日抽样 100 条问答，跑 Faithfulness / Answer Relevancy / Context Recall / Context Precision 四项指标。
- 指标低于阈值时自动创建 Jira 工单分配给 AI 团队分析。

**第三层：人工抽检（每周）**：
- 碳管理专家每周随机抽检 50 条问答，按 5 分制评分（准确性、完整性、表述友好度）。
- 1-2 分的问答进入"Bad Case 库"，分析根因并制定优化方案。

**Bad Case 分析流程**：
1. 分类（检索错误/Prompt 不当/LLM 幻觉/知识库缺失）。
2. 归因（哪个环节导致的问题）。
3. 修复（针对性优化）。
4. 验证（在评估集上回归确认修复有效）。
5. 沉淀（将修复经验记录到知识库和 Prompt 优化指南）。


#### 追问：
- 追问1：碳因子数值正则提取后查库校验，若回答里是"约 2.1 吨"这类区间/估算表述，正则与校验如何不误杀合理答案？
  - **答**：区间/估算表述的防误杀：
    - 正则支持"约/约X–Y/近似"等修饰符，提取为带精度标记的区间值而非精确点值。
    - 校验时对区间取交集/容差比对（如落在权威值 ±X% 内即通过），估算值标注"近似值"而非硬判错。
    - 仅在明显越界（如差一个数量级）才标记告警，合理估算放行并提示仅供参考。
- 追问2：Bad Case 进入根因分析，但检索错误与 LLM 幻觉常交织（检索半对导致幻觉），分类边界模糊时分析结论是否可靠？
  - **答**：交织场景的分类可靠性：
    - 用"链路还原"而非单标签：重跑该 case，分别替换"理想检索"与"理想生成"做对照实验，定位主因在检索还是生成。
    - 允许"多因"标注（检索不足+生成不忠），而非强制单选；统计各因占比看趋势。
    - 模糊样本进复审队列，由人+强模型共判，结论以对照实验证据为准而非直觉。
- 追问3：实时敏感词过滤 + 审核 API 双重审核，在 50 QPS 下审核链路自身延迟是否成为瓶颈，如何与流式输出协调？
  - **答**：双重审核的延迟与流式协调：
    - 敏感词过滤本地毫秒级、不构成瓶颈；外部审核 API 异步化——对流式输出先做本地快筛，完整回答后再异步送审，发现问题再撤回/打标。
    - 关键合规场景可对"首屏结论"先本地强规则拦截，再补异步深度审核，兼顾实时与安全。
    - 审核服务做缓存/批量与限流，50 QPS 下以"边生成边过滤"为主、深度审核后置，避免阻塞 TTFT。


#### 扩充第十节：大模型基础与概念（新增15题）
