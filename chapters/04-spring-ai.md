## 第四章：Spring AI框架

> 本章是 Java 侧 AI 落地的第一选择：从 ChatModel / ChatClient / VectorStore / Advisor 等核心抽象，到模型接入、结构化输出、对话记忆、RAG 编排。**全章代码按 Spring AI 1.0 GA 编写**（SearchRequest 走 builder、Advisor 实现 CallAdvisor），0.x 的 `withTopK` / `retrievalAugmentor` 等旧写法在 1.0 已移除，别混用。



### 1. 什么是Spring AI？它的核心定位和目标是什么？
**重要度**：★★★★

**Spring AI**：Spring 官方推出的 AI 应用开发框架，提供统一的抽象层，简化 AI 模型的集成与调用。

**核心定位**：为 Spring 生态提供 AI 能力的标准抽象，让开发者用 Spring 的方式（自动装配、依赖注入、配置驱动）开发 AI 应用。

**核心目标**：

1. **统一抽象**：屏蔽不同大模型供应商的 API 差异，一套代码切换模型。
2. **Spring 生态集成**：与 Spring Boot 自动装配、Actuator 监控、Spring Cloud 无缝集成。
3. **模块化设计**：按需引入 starter 依赖，如 `spring-ai-starter-model-openai`。
4. **企业级特性**：支持 RAG、Function Calling、Memory、Structured Output 等生产级功能。

#### 追问：
- 追问1：Spring AI 的"统一抽象"在碳管家同时接入通义千问、文心和 Ollama 时具体如何避免业务代码与供应商耦合？
  - **答**：业务代码只依赖 `ChatClient`/`ChatModel` 抽象，具体实现（DashScopeChatModel / OpenAiChatModel / OllamaChatModel）由配置决定，供应商差异封装在实现层。
    - 上层只写一次代码，切换模型改 yml 即可，零侵入；
    - 新增供应商只需引入对应 Starter 并注册 Bean，业务无感知。
- 追问2：若某天通义千问的 API 协议发生不兼容变更、导致 ChatModel 抽象层暴露出差异，Spring AI 的抽象还能为上层保持多少透明？
  - **答**：抽象的透明建立在"接口契约稳定"之上；一旦协议字段（如工具调用结构）变动，差异会穿透到实现层。
    - 若仅字段名/格式差异，可在自定义 `ChatModel` 适配层吸收，对上层仍透明；
    - 若涉及返回语义变化（如缺 finish_reason），可能需改 Advisor/解析逻辑，建议核心适配收敛到一处便于快速止血。

### 2. Spring AI的核心设计目标和核心模块有哪些？
**重要度**：★★★★

**核心模块**：

| 模块                  | 核心接口                              | 职责        |
| ------------------- | --------------------------------- | --------- |
| Chat Model          | `ChatModel` / `ChatClient`        | 对话生成、流式输出 |
| Embedding Model     | `EmbeddingModel`                  | 文本向量化     |
| Image Model         | `ImageModel`                      | 文生图       |
| Audio Model         | `TranscriptionModel`（ASR）/ `SpeechModel`（TTS） | 语音转文字 / 文字转语音 |
| Vector Store        | `VectorStore`                     | 向量存储与检索   |
| Document Processing | `DocumentReader` / `TextSplitter` | 文档解析与分块   |
| RAG                 | `RetrievalAugmentationAdvisor`    | 检索增强生成编排  |
| Function Calling    | `@Tool` / `ToolCallback`      | 工具调用      |
| Memory              | `ChatMemory`                      | 对话记忆      |
| Advisor             | `Advisor`                         | 请求/响应拦截增强 |

#### 追问：
- 追问1：在碳管家的 RAG 链路中，VectorStore、DocumentReader 与 RetrievalAugmentationAdvisor 三者的职责边界在哪里，能否互相替代？
  - **答**：职责明确分层，三者不可替代。
    - `DocumentReader`：离线把源文档解析为文本；
    - `VectorStore`：向量存储与相似检索；
    - `RetrievalAugmentationAdvisor`：在线把检索结果注入 Prompt 编排（控制面）。
- 追问2：Advisor 与 ChatMemory 模块如果都去管理对话上下文，会不会产生重复注入或顺序错乱？
  - **答**：不会重复注入，因分工清晰。
    - `ChatMemory` 管历史对话消息，`Advisor` 负责在请求前后把记忆/检索内容编排注入；
    - 只要约定 Chain 顺序且各自只写自己关心的 context key，就不会错乱；风险主要来自两个 Advisor 同写同名 key。

### 3. Spring AI支持哪些大模型？你集成过哪些？
**重要度**：★★★★

**支持的模型供应商**：OpenAI、Anthropic（Claude）、Azure OpenAI、Ollama（本地）、通义千问（DashScope）、文心一言、智谱GLM、MiniMax、Mistral、Vertex AI（Gemini）等。

**碳管家助手集成**：

- **通义千问（Qwen）**：主模型，通过 `spring-ai-alibaba-starter-dashscope` 集成。
- **DeepSeek**：备模型，通过 OpenAI 兼容端点接入（`spring-ai-starter-model-openai` 指向 DeepSeek base-url）。
- **自部署 GLM（vLLM）**：本地降级模型，vLLM 原生兼容 OpenAI API，Java 端用 Spring AI 的 `OpenAiChatModel` 接入，零外部 API 成本且数据不出境。
- **Ollama**：开发测试用，零 API 成本。


#### 三种框架实现对比

##### Spring AI 1.0 实现

```java
// 碳管家助手：主模型通义千问 + 备模型 DeepSeek + 本地降级 GLM(vLLM)
// 关键：三家都是 OpenAI 兼容协议，只需换 base-url，Java 代码零改动
@Configuration
public class ModelRoutingConfig {

    /** 主模型：通义千问（OpenAI 兼容端点） */
    @Bean
    @Primary
    ChatModel qwenChatModel(RestClient.Builder restClientBuilder) {
        OpenAiApi api = OpenAiApi.builder()
                .baseUrl("https://dashscope.aliyuncs.com/compatible-mode")
                .apiKey(System.getenv("DASHSCOPE_API_KEY"))
                .restClientBuilder(restClientBuilder)
                .build();
        return OpenAiChatModel.builder()
                .openAiApi(api)
                .defaultOptions(OpenAiChatOptions.builder()
                        .model("qwen-plus")          // 1.0：model 写在 options 里
                        .temperature(0.3)
                        .build())
                .build();
    }

    /** 备模型：自部署 vLLM（数据不出境，零外部 API 成本） */
    @Bean
    ChatModel vllmChatModel(RestClient.Builder restClientBuilder) {
        OpenAiApi api = OpenAiApi.builder()
                .baseUrl("http://vllm.carbon.internal:8000")
                .apiKey("EMPTY")
                .restClientBuilder(restClientBuilder)
                .build();
        return OpenAiChatModel.builder()
                .openAiApi(api)
                .defaultOptions(OpenAiChatOptions.builder().model("glm-4-9b-chat").build())
                .build();
    }
}
```

```yaml
# application.yml —— 开发/测试环境直接换 starter 即完成切模型
spring:
  ai:
    openai:
      api-key: ${DASHSCOPE_API_KEY}
      base-url: https://dashscope.aliyuncs.com/compatible-mode
      chat:
        options:
          model: qwen-plus
          temperature: 0.3
```

##### Spring AI 2.0 实现

```java
// 2.0 变化：options(...) 接收的是 build 好的 ChatOptions 实例（builder 只是构造手段，不会直接传进去）；
// Options 构造后不要再改——要么每次 builder().build() 新建，要么用 mutate() 派生，不能缓存一个实例重复改
// 另：配置键去掉 .options 段
// 2.0 起 OpenAI 底层换成官方 openai-java SDK：baseUrl/apiKey 都放进 OpenAiChatOptions
@Configuration
public class ModelRoutingConfig {

    @Bean
    @Primary
    ChatModel qwenChatModel() {
        return OpenAiChatModel.builder()
                .options(OpenAiChatOptions.builder()
                        .baseUrl("https://dashscope.aliyuncs.com/compatible-mode")
                        .apiKey(System.getenv("DASHSCOPE_API_KEY"))
                        .model("qwen-plus")
                        .temperature(0.3)
                        .build())
                .build();
    }

    /** 备模型：自部署 vLLM（数据不出境，零外部 API 成本） */
    @Bean
    ChatModel vllmChatModel() {
        return OpenAiChatModel.builder()
                .options(OpenAiChatOptions.builder()
                        .baseUrl("http://vllm.carbon.internal:8000")
                        .apiKey("EMPTY")
                        .model("glm-4-9b-chat")
                        .build())
                .build();
    }
}
```

```yaml
# 2.0：非 chat 模型配置已扁平化（.options 段被移除，属性暂以 deprecated 形式兼容）
spring:
  ai:
    openai:
      api-key: ${DASHSCOPE_API_KEY}
      base-url: https://dashscope.aliyuncs.com/compatible-mode
      chat:
        model: qwen-plus
        temperature: 0.3
      embedding:
        model: text-embedding-v3   # 1.0 这里是 embedding.options.model
```

##### LangChain4j 实现

```java
// LangChain4j 1.x：ChatModel 接口统一，同样吃 OpenAI 兼容端点
// 注意 1.x 的接口名是 dev.langchain4j.model.chat.ChatModel（0.x 的 ChatLanguageModel 已改名）
public class CarbonModels {

    /** 主模型：通义千问 */
    public ChatModel qwen() {
        return OpenAiChatModel.builder()
                .baseUrl("https://dashscope.aliyuncs.com/compatible-mode")
                .apiKey(System.getenv("DASHSCOPE_API_KEY"))
                .modelName("qwen-plus")
                .temperature(0.3)
                .build();
    }

    /** 备模型：自部署 vLLM 承载 GLM */
    public ChatModel vllm() {
        return OpenAiChatModel.builder()
                .baseUrl("http://vllm.carbon.internal:8000")
                .apiKey("EMPTY")
                .modelName("glm-4-9b-chat")
                .build();
    }
}
```

#### 追问：
- 追问1：碳管家同时集成通义千问、文心和 Ollama，当主模型（Qwen）超时降级到文心时，如何保证两次回答的口径和检索上下文一致？
  - **答**：检索上下文（RAG 结果）在路由前由统一检索服务产出，与模型无关，保证"喂给哪个模型都看到同一份证据"。
    - 口径一致性靠固定 System Prompt + 结构化输出约束；
    - 降级时复用同一 Prompt 与检索片段，仅换底层 `ChatModel`。
- 追问2：不同模型对 Function Calling 的参数 Schema 支持程度不一，碳管家的 carbonFactorLookup 工具在切换到 Ollama 本地模型时可能遇到什么兼容问题？
  - **答**：本地小模型对嵌套/必填字段约束弱，可能漏传参数或返回非标准 `tool_calls`，对 parallel tool call、JSON Schema 严格度支持不齐。
    - 工具入参用扁平简单结构并加默认值；
    - 切 Ollama 时做 Schema 兼容校验，失败重试/降级回主模型。

### 4. Spring AI和LangChain的区别？
**重要度**：★★★★

| 维度    | Spring AI      | LangChain (Python) | LangChain4j    |
| ----- | -------------- | ------------------ | -------------- |
| 语言    | Java/Kotlin    | Python             | Java           |
| 生态    | Spring 全家桶     | Python AI 生态       | 独立生态           |
| 自动装配  | ✅ Starter 自动配置 | ❌                  | 部分支持           |
| RAG   | Advisor 模式     | Chain 模式           | Augmentor 模式   |
| Agent | 内置轻量（ChatClient+Tool+Memory 循环，无图编排，可接 LangGraph） | 强（LangGraph 图编排） | 中等（AiServices 声明式） |
| 适合    | Spring Boot 项目 | Python 项目          | 纯 Java AI 项目   |

**选型建议**：Spring Boot 项目首选 Spring AI（Alibaba 扩展对接通义千问）；两者均可做 RAG/Agent 全流程（Spring AI 走 Advisor+ChatClient，LangChain4j 走 AiServices+RetrievalAugmentor）。碳管家按团队栈分工并用：Spring AI Alibaba 做模型调用与流式输出，LangChain4j 做 RAG 链编排——是按生态偏好分工，不是"只有 LangChain4j 能做 RAG/Agent"。

#### 追问：
- 追问1：碳管家"Spring AI 管模型调用、LangChain4j 管 RAG 与 Agent 编排"的双框架方案，引入了哪些额外的维护成本和版本对齐风险？
  - **答**：额外维护成本——两套依赖/版本/社区分别跟进，工具与 Prompt 可能双份维护；版本对齐风险——各自升级可能破坏桥接点（消息格式、Tool 协议）。
    - 建议明确边界（Spring AI 管模型/流式，LangChain4j 管 RAG 编排）并用适配层隔离。
- 追问2：如果只选一个框架，你会偏向哪一方，依据是什么（团队 Java 熟练度、RAG 复杂度、可观测性需求）？
  - **答**：倾向 Spring AI——团队是 Spring Boot 栈，自动装配/Actuator/可观测性开箱即用，RAG 用其 Advisor 足够。
    - 仅当需复杂 Agent 图编排（LangGraph 级）才考虑 LangChain4j；
    - 取舍依据：团队熟悉度 + 运维一致性优先于单点能力。

### 5. Spring AI的核心模块和API有哪些？请描述ChatClient、EmbeddingModel和ImageModel的主要职责。
**重要度**：★★★★

**ChatClient**（核心 API）：

```java
// 同步调用
String answer = chatClient.prompt()
    .system("你是碳管理专家")
    .user("什么是碳足迹？")
    .call()
    .content();

// 流式调用
Flux<String> stream = chatClient.prompt()
    .user(query)
    .stream()
    .content();
```

**EmbeddingModel**：

```java
float[] vector = embeddingModel.embed("产品碳足迹");
```

**ImageModel**：

```java
ImageResponse response = imageModel.prompt(new ImagePrompt("碳减排示意图"));
```

#### 追问：
- 追问1：碳管家把 LCA 报告生成流程图用 ImageModel 产出，而用户上传的是工厂实拍图做识别，这两种"图像"职责是否应由同一个 ImageModel 承担？
  - **答**：职责不同——前者是"文生图"（生成），后者是"图生文/Vision 理解"。
    - Spring AI 的 `ImageModel` 偏文生图，`Media` 多模态偏理解；
    - 建议生成走 `ImageModel`，实拍识别走支持视觉的 `ChatModel` + `Media`，分开更清晰。
- 追问2：ChatClient 的 Fluent API 在配合 Advisor 链式增强后，流式 stream() 的异常点和背压如何传导到客户端？
  - **答**：Advisor 链在 `stream()` 时仍包裹 `Flux`，异常以 `onError` 信号沿 Flux 透传至 WebFlux SSE 响应。
    - 背压由 Reactor 在订阅者（HTTP 写出）与上游（模型流）间自动协调；
    - 自定义 Advisor 避免在响应式链里做同步重操作。

### 6. Spring AI的架构分层是怎样的？如何实现多模型供应商无缝切换？
**重要度**：★★★★

**分层架构**：

```
应用层（ChatClient / Advisor）
        ↓
抽象层（ChatModel / EmbeddingModel 接口）
        ↓
实现层（OpenAiChatModel / DashScopeChatModel / OllamaChatModel）
        ↓
供应商 API（通义千问 / DeepSeek / Ollama）
```

**无缝切换**：只需修改 `application.yml` 配置，无需改代码：

```yaml
spring:
  ai:
    openai:
      api-key: xxx
      chat:
        options:
          model: qwen-vl
# 切换到通义千问只需改为：
# spring:
#   ai:
#     dashscope:
#       api-key: xxx
#       chat:
#         options:
#           model: qwen-plus
```


#### 三种框架实现对比

##### Spring AI 1.0 实现

```java
// 分层：应用层(ChatClient/Advisor) → 抽象层(ChatModel) → 实现层(OpenAi/Ollama...) → 供应商 API
// 无缝切换 = 业务只依赖 ChatModel 抽象 + Bean 装配，业务代码不出现任何供应商类名
@Service
public class CarbonAssistantService {

    // 只依赖抽象接口：换成 Ollama / 通义千问 / DeepSeek，注入的还是 ChatModel
    private final ChatClient chatClient;

    public CarbonAssistantService(ChatModel chatModel) {
        this.chatClient = ChatClient.create(chatModel);
    }

    public String ask(String question) {
        return chatClient.prompt()
                .system("你是碳管理专家，引用数值时必须说明数据来源与版本")
                .user(question)
                .call()
                .content();
    }
}
```

```java
// 抽象层之下用「多 Bean + @Qualifier」做主备/按租户路由，
// 上层依然只见 ChatModel，切换能力不泄漏到业务
@Component
public class TieredChatModelRouter implements ChatModel {

    private final ChatModel primary;   // qwen-plus
    private final ChatModel fallback;  // 本地 vLLM GLM，Qwen 超时/限流时降级

    public TieredChatModelRouter(@Qualifier("qwenChatModel") ChatModel primary,
                                 @Qualifier("vllmChatModel") ChatModel fallback) {
        this.primary = primary;
        this.fallback = fallback;
    }

    @Override
    public ChatResponse call(Prompt prompt) {
        try {
            return primary.call(prompt);
        }
        catch (ResourceAccessException ex) {
            // 降级时复用同一 Prompt 与检索片段，只换底层 ChatModel
            return fallback.call(prompt);
        }
    }

    @Override
    public Flux<ChatResponse> stream(Prompt prompt) {
        return primary.stream(prompt);
    }
}
```

##### Spring AI 2.0 实现

```java
// 2.0：ChatModel 实现内部已移除工具执行循环，直接调用只返回原始响应，
// 所以自定义 ChatModel 时工具往返要自己驱动（或交给 ChatClient 自动注册的 ToolCallingAdvisor）
@Component
public class TieredChatModelRouter implements ChatModel {

    private final ChatModel primary;
    private final ChatModel fallback;

    public TieredChatModelRouter(@Qualifier("qwenChatModel") ChatModel primary,
                                 @Qualifier("vllmChatModel") ChatModel fallback) {
        this.primary = primary;
        this.fallback = fallback;
    }

    @Override
    public ChatResponse call(Prompt prompt) {
        try {
            return primary.call(prompt);
        }
        catch (ResourceAccessException ex) {
            return fallback.call(prompt);
        }
    }

    @Override
    public Flux<ChatResponse> stream(Prompt prompt) {
        return primary.stream(prompt);
    }
}
```

```yaml
# 2.0：配置键扁平化，切换供应商只改这段
spring:
  ai:
    openai:
      api-key: ${DASHSCOPE_API_KEY}
      base-url: https://dashscope.aliyuncs.com/compatible-mode
      chat:
        model: qwen-plus
    ollama:
      base-url: http://localhost:11434
      chat:
        model: qwen2.5:7b      # 2.0 已扁平化；1.0 是 chat.options.model
```

##### LangChain4j 实现

```java
// LangChain4j 的「抽象层」是 dev.langchain4j.model.chat.ChatModel，
// 业务代码通过 AiServices 声明式接口使用，同样不感知供应商
interface CarbonAssistant {
    @SystemMessage("你是碳管理专家，引用数值时必须说明数据来源与版本")
    String chat(@UserMessage String question);
}

public class AssistantFactory {

    public CarbonAssistant build(ChatModel model) {
        return AiServices.builder(CarbonAssistant.class)
                .chatModel(model)   // 传 Qwen / vLLM / Ollama 任意实现
                .build();
    }
}
```

#### 追问：
- 追问1：碳管家在"抽象层—实现层"之间若想插入自建的语义缓存和敏感词审计，应该放在哪一层，会不会破坏无缝切换能力？
  - **答**：放在 Advisor 层（请求前查缓存、拦截敏感词），对模型实现无侵入，不破坏切换能力。
    - 缓存按 (query+模型) 维度命中，审计统一在 Advisor；
    - 这正是 Advisor 作为横切关注点的设计目的。
- 追问2：仅靠 application.yml 切换模型，遇到不同供应商对 temperature、max_tokens 等参数语义不一致时，配置驱动会暴露什么隐患？
  - **答**：参数语义差异（如 temperature 范围、max_tokens 含义）不会因配置切换自动归一，可能某模型"0.3"保守、另一模型"0.3"发散。
    - 建议在自定义 `ChatOptions` 适配层做参数映射/裁剪；
    - 通过配置校验拦截不支持的参数。
- 追问3：当通义千问与文心的返回结构存在差异（如工具调用字段名），实现层之下的适配代码由谁负责兼容，能否完全对上层透明？
  - **答**：差异由各自的 `ChatModel` 实现层（或自定义适配）在 `ChatResponse` 解析时抹平，对上层尽量透明。
    - 极端差异（如流式工具增量格式）可能需上层 Advisor 兼容；
    - 原则：能封在实现层就封在实现层，避免污染业务。

### 7. 为什么选择Spring AI框架？主要优势是什么？
**重要度**：★★★

1. **Spring 生态无缝集成**：自动装配、DI、AOP、Actuator 监控开箱即用。
2. **统一抽象**：一套代码支持多模型切换。
3. **企业级特性**：Advisor 机制（类似拦截器）支持日志、安全、缓存等横切关注点。
4. **RAG 内置支持**：VectorStore、DocumentReader、RetrievalAugmentationAdvisor。
5. **Spring Boot 3 适配**：支持 JDK17+、GraalVM 原生镜像。
6. **官方维护**：Spring 团队主导，版本迭代快，长期维护有保障。

#### 追问：
- 追问1：你列举的"Advisor 横切关注点"优势，在碳管家实际落地时是用了内置 Advisor 还是全自定义，为何？
  - **答**：以自定义为主、内置为辅——`MessageChatMemoryAdvisor`/`QuestionAnswerAdvisor` 用内置，但碳数值校验、敏感词、置信度标注用自定义 `Advisor`。
    - 原因：内置满足通用需求，业务规则（碳数值区间、合规口径）必须自写。
- 追问2：如果未来团队想接入 GraphRAG 或更复杂的 Agent 编排，Spring AI 当前"Agent 较弱"的短板会不会让你重新评估选型？
  - **答**：会纳入评估，但未必整体替换——可在需要时引入 LangChain4j/LangGraph 做编排，Spring AI 继续管模型与基础设施。
    - 是否重构取决于 GraphRAG 业务收益与迁移成本对比，先用适配层试探。

### 8. 生产环境中如何解决Spring AI的性能瓶颈？
**重要度**：★★★★

1. **流式输出**：用 `stream()` 替代 `call()`，减少用户等待感。
2. **缓存**：Advisor 层做语义缓存，避免重复调用大模型。
3. **异步编排**：`CompletableFuture` 并行执行 RAG 检索和上下文加载。
4. **连接池**：1.0 起底层不再用 OkHttp —— 同步调用走 `RestClient`（默认 JDK `HttpClient`，连接池/超时通过自定义 `HttpClient` 或 `RestClient.Builder` 配置），流式走 `WebClient`（Reactor Netty，`ConnectionProvider` + `ReadTimeoutHandler`）。
5. **批量调用**：Embedding 别一条条发，一次传多个文本走 `embed(List<String>)`（返回 `List<float[]>`）或 `embedForResponse(List<String>)`，减少 HTTP 往返次数。
6. **模型分级**：Advisor 中根据问题复杂度路由到不同模型。

#### 追问：
- 追问1：碳管家的语义缓存命中率低（用户问题高度个性化）时，Advisor 层缓存是净收益还是额外延迟，如何度量？
  - **答**：命中率低时是净负担（每次查缓存都 miss + 一点延迟）。
    - 度量：埋点记录命中率、P99 延迟增量、Token 节省量；
    - 设阈值（命中率低于某值）自动降级关闭缓存；个性化场景更该缓存"检索结果"而非整句回答。
- 追问2：用 CompletableFuture 并行 RAG 检索与上下文加载，但检索结果本身就是上下文，这种"伪并行"会不会引入竞态或顺序依赖问题？
  - **答**：会——若二者有依赖（检索结果要并入上下文），并行只是重叠 I/O，真正合并需 `thenCombine` 等待两者就绪。
    - 不存在竞态但无实质加速；
    - 并行只适合互不依赖的多个检索源，合并点用 Future 汇聚，避免提前使用未就绪数据。
- 追问3：模型分级路由（简单问题走小模型）在碳管家这种专业领域，错误地把"CBAM 合规判断"路由到低能模型，风险如何兜底？
  - **答**：兜底：
    - ① 路由特征加"高风险关键词白名单"（CBAM/合规/申报→强制大模型）
    - ② 小模型回答后过校验 Advisor（规则+评判模型），低置信度自动升级大模型重答
    - ③ 关键合规场景默认走最强模型，分级只用于闲聊类

### 9. ChatModel是什么？
**重要度**：★★★★★

`ChatModel` 是 Spring AI 对大模型对话能力的底层抽象接口：

```java
public interface ChatModel extends StreamingChatModel {
    ChatResponse call(Prompt prompt);
    Flux<ChatResponse> stream(Prompt prompt);
}
```

`ChatClient` 是更高层的 Fluent API 封装，底层委托给 `ChatModel`。

#### 追问：
- 追问1：ChatModel 与 ChatClient 的责任边界在碳管家自定义 Qwen 适配时如何划分，流式能力应落在哪一层？
  - **答**：`ChatModel` 是底层协议适配（请求/响应转换、SSE 解析），`ChatClient` 是面向业务的 Fluent 编排（Prompt、Advisor、Tools）。
    - 自定义 Qwen 只实现 `ChatModel`/`StreamingChatModel`；
    - 流式 `stream()` 落在 ChatModel 实现层，ChatClient 直接复用。
- 追问2：当底层供应商返回的 ChatResponse 中没有 finish_reason 或工具调用字段缺失，Spring AI 的抽象是否会让上层难以感知异常？
  - **答**：会存在"静默"风险——缺字段可能被适配层默认填充导致上层以为正常。
    - 建议自定义 `ChatModel` 解析时做契约校验：缺失关键字段（finish_reason/tool_calls）抛 `NonTransientAiException` 或打告警，让上层 Advisor 捕获兜底。

### 10. EmbeddingModel作用是什么？
**重要度**：★★★★

将文本转换为向量，用于 RAG 检索、语义缓存、文本分类等：

```java
public interface EmbeddingModel {
    float[] embed(String text);                              // 单条：返回 float[]，不是 Embedding
    List<float[]> embed(List<String> texts);                 // 批量
    EmbeddingResponse embedForResponse(List<String> texts);  // 需要 usage/token 元信息时用
}
```

> ⚠️ 签名口径：`embed` 返回的是 `float[]` 而不是 `Embedding`；`embedAll(List<String>)` 这个方法在 1.x 已不存在，批量就是 `embed(List<String>)`，要拿 token 用量等元信息才用 `embedForResponse(...)`。第 5 题的 `float[] vector = embeddingModel.embed(...)` 即按此签名。

#### 追问：
- 追问1：碳管家混合使用通义千问 Embedding 与本地 bge-large-zh-v1.5，两套向量分布不一致会导致 Milvus 检索召回率骤降，如何规避？
  - **答**：同一集合必须固定单一 Embedding 模型，禁止混用。
    - 若需切换，需全量重算该集合向量；
    - 用集合名/元数据标注 embedding 版本，检索路由按版本选模型，避免跨分布查询。
- 追问2：知识库每天增量更新，Embedding 模型一旦升级，存量向量是否必须全量重算，重算期间检索一致性如何保证？
  - **答**：必须全量重算才能一致。
    - 策略：新建版本化集合写入新向量，重算完成并校验后原子切换检索指向，旧集合保留可回滚；
    - 重算期间双写或只读旧集合，避免半新半旧导致召回抖动。

### 11. 什么是PromptTemplate？
**重要度**：★★★★

`PromptTemplate` 是 Spring AI 的 Prompt 模板引擎，支持变量占位：

```java
PromptTemplate template = new PromptTemplate(
    "作为碳管理专家，请回答以下问题：{question}。参考标准：{standard}");
Prompt prompt = template.create(Map.of(
    "question", "什么是CBAM？",
    "standard", "ISO 14067"
));
```

#### 追问：
- 追问1：碳管家把 ISO 标准编号作为 {standard} 变量注入，若用户恶意构造 {standard} 内容做 Prompt 注入，模板机制能否防御？
  - **答**：`PromptTemplate` 仅做文本替换，无注入防御。
    - 防御需在变量落库前做白名单校验（standard 必须是已知 ISO 编号集合）；
    - 并用独立 System/User 消息隔离系统指令与用户变量，避免用户变量被当作指令。
- 追问2：当模板变量过多（角色、标准、行业、语言、格式）时，PromptTemplate 的可维护性和版本管理怎样落地？
  - **答**：把模板外置到配置中心（Nacos）按版本管理，代码只引用模板键。
    - 变量用结构化 Map + Schema 校验；
    - 变更走评审+灰度，配合评测回归，避免长 Prompt 硬编码在 Java 里。

### 12. Spring AI流式响应原理是什么？
**重要度**：★★★★

**原理**：基于 Reactor 的 `Flux`，底层使用 SSE（Server-Sent Events）协议。

- `ChatModel.stream()` 返回 `Flux<ChatResponse>`，大模型每生成一个 token 就通过 Flux 推送。
- Controller 返回 `Flux<String>`，Spring WebFlux 自动转为 SSE 格式推送给客户端。
- 底层 HTTP 客户端不是 OkHttp：流式走 `WebClient`（Reactor Netty），用 `bodyToFlux(String.class)` 把 SSE 的 `data:` 行拆成 `Flux<String>` 后再映射成 `ChatResponse`；同步 `call()` 走 `RestClient`。

#### 追问：
- 追问1：SSE 在 Spring Cloud Gateway 或 Nginx 反向代理下若被缓冲，碳管家的"流式体验"是否实际失效，如何排查？
  - **答**：会失效——缓冲把分片攒成整块，前端看不到逐字效果。
    - 排查：检查 Gateway/Nginx 的 `proxy_buffering off`、响应 `Content-Type: text/event-stream`、禁用 gzip 对 SSE 的缓冲；
    - 用 curl 直连后端对比是否流式。
- 追问2：流式输出中途模型报错或触发内容安全拦截，已推送给前端的片段如何撤回或追加错误提示？
  - **答**：SSE 已发出的片段无法撤回。
    - 策略：前端约定结束帧/`[DONE]`/`error` 事件，出错时追加 error 事件让前端收尾提示；
    - 敏感内容在生成前/分块时做流式审核，命中即停止推送并发送错误事件。

### 13. Spring AI函数调用（FunctionCall）原理是什么？
**重要度**：★★★★★

**原理**：大模型根据用户问题判断是否需要调用外部函数（Tool），返回函数名和参数，Spring AI 执行函数后将结果返回给大模型。

**Spring AI 1.0 实现**（基于 `@Tool` 注解）：

```java
// 工具类：@Tool 必须标在【普通方法】上——框架扫描的是 Bean 实例的方法
@Component
public class CarbonFactorTools {

    @Tool(description = "按行业与活动名称查询碳排放因子")
    public String queryCarbonFactor(@ToolParam(description = "行业") String industry,
                                    @ToolParam(description = "活动") String activity) {
        return carbonFactorService.query(industry, activity);
    }
}

// 大模型调用：传工具对象（或 ToolCallback），不传名字
String answer = chatClient.prompt()
    .user("钢铁的碳排放因子是多少？")
    .tools(new CarbonFactorTools())
    .call()
    .content();
```

> ⚠️ 两个常见错法：① 把 `@Tool` 标在 `@Bean` **工厂方法**上——框架扫描的是 Bean 实例的方法，注解挂在工厂方法上不会被识别，**注册出来的工具数是 0**，运行时模型永远不会调用工具（而且不报错，只是"它就是不调"，最难排查）；② `.tools("queryCarbonFactor")` 这种按 bean 名传字符串是 1.0 之前的按名解析写法，2.0 已移除，正确做法是传工具对象或 `ToolCallback`（Bean 方式：注册 `ToolCallback` Bean，再 `.tools(toolCallback)` 或 `.defaultTools(...)`）。

**流程**：

1. Spring AI 将 `@Tool` 方法的签名和描述传给大模型。
2. 大模型判断需要调用工具，返回 `tool_calls`（函数名 + 参数）。
3. Spring AI 反射执行对应方法，获取结果。
4. 将结果作为 `tool` 角色消息追加到对话，再次调用大模型。
5. 大模型基于工具返回结果生成最终回答。

#### 追问：
- 追问1：碳管家的 queryCarbonFactor 工具返回超大 JSON 撑爆上下文窗口时，框架层面有无截断或分页机制？
  - **答**：Spring AI 默认不截断工具结果，需自处。
    - 建议工具实现里做裁剪（只返回 `{value, unit, source}` 必要字段）、分页/聚合；
    - 或在 Advisor 中对超长 `tool` 消息截断，也可限返回条数。
- 追问2：若工具执行耗时很长（如调用企业碳数据中台），流式回答在等待工具结果期间前端应如何表现，Spring AI 是否原生支持"工具进行中"事件？
  - **答**：Spring AI 原生不直接发"工具进行中"事件。
    - 做法：前端先展示"正在查询碳数据中台…"占位（首字即返回提示），工具结果回来后再流式生成；
    - 或在自定义 Advisor/流式封装里插入状态 SSE 事件区分"思考中/检索中/生成中"。

### 14. Spring AI中Prompt是什么？怎么构建一个有效的Prompt？
**重要度**：★★★★

**Prompt**：Spring AI 中 `Prompt` 是消息列表的封装，包含 System Message、User Message、Assistant Message 等：

```java
Prompt prompt = new Prompt(List.of(
    new SystemMessage("你是碳管理专家"),
    new UserMessage("什么是碳足迹？")
));
```

**有效 Prompt 构建**：

1. **角色定义**：System Message 明确角色和规则。
2. **上下文注入**：RAG 检索结果作为 Context。
3. **示例引导**：Few-shot 示例。
4. **输出格式**：明确要求 JSON/Markdown 等格式。
5. **约束条件**：限制回答范围、禁止编造。

#### 追问：
- 追问1：碳管家要求"禁止编造排放因子"，但 System Prompt 的约束对模型并不总是有效，除 Prompt 外还需哪些工程兜底（如工具必查）？
  - **答**：工程兜底：
    - ① 涉及数值必须走 `carbonFactorLookup` 等工具，Prompt 明确"无工具结果不得编造"
    - ② `CarbonValidationAdvisor` 校验回答中数值是否与工具返回一致
    - ③ 对无法查证问题引导"需人工/查库"而非模型凭记忆作答
- 追问2：Few-shot 示例若取自真实客户问答，是否会把客户敏感数据写进 System Prompt 模板，如何脱敏？
  - **答**：会泄漏风险。
    - 脱敏：示例中的企业名/产品/数值做泛化替换（如"某企业A的钢铁"）或用合成样例；
    - 敏感示例存受控配置并加密，禁止直存原文；必要时用检索注入而非硬编码进 System Prompt。

### 15. 如果你要设计一个基于Spring AI的AIGC平台，你会怎么做？
**重要度**：★★★★

**设计思路（口头表述）**：基于 Spring AI 设计 AIGC 平台我按"分层 + 适配"组织，从上到下五层：前端（React/Vue）→ API Gateway（限流鉴权）→ 应用服务（Spring Boot3，内嵌 ChatClient+Advisor、RAG+Memory+Tools）→ AI 适配层（多模型路由，统一抽象屏蔽厂商差异）→ 模型供应商（通义/文心/Ollama）+ 基础设施（Milvus/Redis/MySQL/MQ）。关键设计：
  - ① 用 Spring AI 的 ChatClient 做统一调用入口、Advisor 做横切（检索/记忆/日志）
  - ② 适配层是多模型路由的关键，业务只依赖抽象不绑定厂商
  - ③ 基础设施按职责分——Milvus 向量检索、Redis 缓存限流、MySQL 业务数据、MQ 异步削峰
  - 一句话："分层解耦 + 适配层屏蔽厂商 + Advisor 横切能力"。

**架构设计**：

```
┌─────────────────────────────┐
│       前端（React/Vue）       │
├─────────────────────────────┤
│    API Gateway（限流/鉴权）   │
├─────────────────────────────┤
│  应用服务（Spring Boot 3）    │
│  ┌───────────────────────┐  │
│  │ ChatClient + Advisor  │  │
│  │ RAG + Memory + Tools  │  │
│  └───────────────────────┘  │
├─────────────────────────────┤
│ AI 适配层（多模型路由）       │
├─────────────────────────────┤
│ 模型供应商（通义/文心/Ollama） │
├─────────────────────────────┤
│ 基础设施                     │
│ Milvus | Redis | MySQL | MQ │
└─────────────────────────────┘
```

**核心模块**：

1. **统一模型网关**：多模型路由、负载均衡、限流熔断。
2. **RAG 引擎**：知识库管理、文档解析、向量检索、Re-ranking。
3. **Agent 编排**：Tool 管理、多轮对话、任务编排。
4. **Prompt 管理**：模板版本管理、A/B 测试。
5. **监控告警**：Token 消耗、响应延迟、质量评估。

**AIGC 和普通问答平台的关键差异——生成侧链路**（只讲 LLM+RAG 是答偏了，必须补这块）：

- **多模态生成能力**：`ImageModel`（文生图/图生图）、`SpeechModel`（TTS 配音）、`TranscriptionModel`（ASR 字幕），视频类走异步任务调用专用供应商，不在 ChatModel 里。
- **异步生成任务队列**：图片/视频/长音频动辄数十秒，必须"提交任务→返回 taskId→MQ 消费→回调/轮询"，不能占着 HTTP 连接同步等。用 MQ（如 RocketMQ 延迟消息）+ 任务表（taskId、状态、参数、产物 URL、失败原因）。
- **产物存储与分发**：生成结果落对象存储（OSS/MinIO），DB 只存元数据与 URL，走 CDN 分发，并做生命周期清理。
- **内容审核链路**：生成前审 Prompt（涉政/侵权/敏感词），生成后审图片/音频（多模态审核），命中则拦截、打标、留证；审核是同步关口，不能事后补。
- **配额与计费**：按生成类型分别计量（张数/秒数/Token），与任务队列绑定做限流。

#### 追问：
- 追问1：你画的架构里"AI 适配层多模型路由"与"模型供应商"之间若加熔断和灰度，路由决策依据（延迟、成本、质量）如何量化？
  - **答**：量化指标：延迟用 P95 推理耗时，成本用 Token×单价，质量用评测集得分/用户反馈率。
    - 路由可做加权打分或规则（延迟超阈值降级、成本超预算切小模型、质量低回退强模型）；
    - 灰度按客户/流量比例放。
- 追问2：碳管家的知识库（Milvus）与 MySQL 业务数据如何在该平台中保证"检索结果可溯源到具体文档章节"，防止幻觉？
  - **答**：检索返回携带 `doc_id + chunk_id + 章节号 + 页码` 元数据，回答中强制引用来源（结构化输出含 references 字段）。
    - MySQL 业务数据通过工具查询并返回来源标识；
    - 在 `QuestionAnswerAdvisor` 注入时连同来源元数据一并传入并核对。
- 追问3：监控告警里"质量评估"具体用什么信号（人工反馈、评测模型打分、RAGAS）驱动，低分时如何自动回滚 Prompt 或模型版本？
  - **答**：信号融合：用户点赞/踩（人工反馈）、离线评测集 LLM 打分、RAGAS（faithfulness/answer relevancy）。
    - 低分触发：告警+定位到具体 Prompt/模型版本；
    - 回滚到上一稳定版本（Prompt/Advisor 配置存版本化，Nacos 一键回退），小流量灰度验证后再全量。

### 16. 用Spring AI写一个Agent的过程大概是什么样的？
**重要度**：★★★★

**设计思路（口头表述）**：写一个 Spring AI Agent 我分三步走。第一步**定义工具**——用 `@Tool` 注解把"查碳排放因子""查 CBAM 法规"这类业务能力封装成方法，注解的 description 是关键，它决定大模型能不能准确判断何时调用。第二步**配置 ChatClient**——把工具、System Prompt（角色约束）、ChatMemory（多轮记忆）通过 builder 注入，`defaultTools` 让模型知道有哪些工具可用，`MessageChatMemoryAdvisor` 负责上下文承载。第三步**执行**——发 prompt 后大模型自主决策调用顺序：先调因子查询、再调法规查询、最后综合回答，整个编排是模型驱动而非我硬编码 if-else。核心是"能力声明"与"调用编排"解耦——我只声明工具，编排交给模型。

```java
// 1. 定义工具
@Tool(description = "查询碳排放因子数据库")
public CarbonFactor queryFactor(String product) { ... }

@Tool(description = "获取CBAM最新法规")
public String getCbamRegulation() { ... }

// 2. 配置 ChatClient + Tools + Memory
@Bean
ChatClient chatClient(ChatClient.Builder builder, ChatMemory memory) {
    return builder
        .defaultSystem("你是碳管理专家，可以查询碳排放因子和碳法规")
        .defaultTools(queryFactor, getCbamRegulation)
        .defaultAdvisors(new MessageChatMemoryAdvisor(memory))
        .build();
}

// 3. 执行 Agent
String answer = chatClient.prompt()
    .user("帮我查询钢铁的碳排放因子，并说明CBAM对钢铁产品的影响")
    .call()
    .content();
// 大模型自动决策：先调用 queryFactor("钢铁")，再调用 getCbamRegulation()，最后综合回答
```


#### 三种框架实现对比

##### Spring AI 1.0 实现

```java
// 第 1 步：声明工具能力（description 决定模型何时调用，务必写清「做什么/入参/返回」）
public class CarbonFactorTools {

    private final CarbonFactorService factorService;

    public CarbonFactorTools(CarbonFactorService factorService) {
        this.factorService = factorService;
    }

    @Tool(description = "查询指定产品的碳排放因子，返回值、单位和数据来源")
    public CarbonFactor queryFactor(
            @ToolParam(description = "产品名称，如 钢铁/水泥/铝") String product) {
        return factorService.lookup(product);
    }

    @Tool(description = "获取 CBAM 最新法规条款要点")
    public String getCbamRegulation() {
        return regulationService.summary();
    }
}

// 第 2 步：装配 ChatClient（工具 + System Prompt + 记忆）
@Configuration
public class AgentConfig {

    @Bean
    ChatMemory chatMemory() {
        return MessageWindowChatMemory.builder()
                .chatMemoryRepository(new InMemoryChatMemoryRepository())
                .maxMessages(20)
                .build();
    }

    @Bean
    ChatClient carbonAgent(ChatModel chatModel, ChatMemory chatMemory,
                           CarbonFactorTools factorTools) {
        return ChatClient.builder(chatModel)
                .defaultSystem("你是碳管理专家，可查询碳排放因子与 CBAM 法规，数值必须带来源")
                .defaultTools(factorTools)
                .defaultAdvisors(MessageChatMemoryAdvisor.builder(chatMemory).build())
                .build();
    }
}

// 第 3 步：执行——模型自主决定调用顺序，业务不写 if-else
@Service
public class CarbonAgentService {

    private final ChatClient agent;

    public CarbonAgentService(ChatClient agent) {
        this.agent = agent;
    }

    public String ask(String question, String conversationId) {
        return agent.prompt()
                .user(question)
                .advisors(a -> a.param(ChatMemory.CONVERSATION_ID, conversationId))
                .call()
                .content();
    }
}
```

##### Spring AI 2.0 实现

```java
// 2.0 变化：工具必须显式注册（ToolCallback Bean 或 @Tool 对象），toolNames() 已移除；
// ChatClient 会自动注册 ToolCallingAdvisor 负责完整工具往返
@Configuration
public class AgentConfig {

    @Bean
    ChatMemory chatMemory() {
        return MessageWindowChatMemory.builder()
                .chatMemoryRepository(new InMemoryChatMemoryRepository())
                .maxMessages(20)
                .build();
    }

    @Bean
    ToolCallback carbonFactorLookup(CarbonFactorService factorService) {
        return FunctionToolCallback.builder("carbonFactorLookup", factorService::lookup)
                .description("查询指定产品的碳排放因子，返回值、单位和数据来源")
                .inputType(CarbonFactorQuery.class)
                .build();
    }

    @Bean
    ChatClient carbonAgent(ChatModel chatModel, ChatMemory chatMemory,
                           ToolCallback carbonFactorLookup) {
        return ChatClient.builder(chatModel)
                .defaultSystem("你是碳管理专家，可查询碳排放因子与 CBAM 法规，数值必须带来源")
                .defaultTools(carbonFactorLookup)
                .defaultAdvisors(MessageChatMemoryAdvisor.builder(chatMemory).build())
                .build();
    }
}

@Service
public class CarbonAgentService {

    private final ChatClient agent;

    public CarbonAgentService(ChatClient agent) {
        this.agent = agent;
    }

    public String ask(String question, String conversationId) {
        // 2.0：conversationId 必填，漏传直接抛 IllegalArgumentException
        return agent.prompt()
                .user(question)
                .advisors(a -> a.param(ChatMemory.CONVERSATION_ID, conversationId))
                .call()
                .content();
    }
}
```

##### LangChain4j 实现

```java
// LangChain4j 1.x：同样「声明能力 + 交给模型编排」，但入口是自己声明的接口方法
public class CarbonFactorTools {

    private final CarbonFactorService factorService;

    public CarbonFactorTools(CarbonFactorService factorService) {
        this.factorService = factorService;
    }

    @Tool("查询指定产品的碳排放因子，返回值、单位和数据来源")
    CarbonFactor queryFactor(@P("产品名称，如 钢铁/水泥/铝") String product) {
        return factorService.lookup(product);
    }
}

interface CarbonAgent {
    @SystemMessage("你是碳管理专家，可查询碳排放因子，数值必须带来源")
    String chat(@MemoryId String conversationId, @UserMessage String question);
}

public class AgentFactory {

    public CarbonAgent build(ChatModel model, CarbonFactorTools tools) {
        return AiServices.builder(CarbonAgent.class)
                .chatModel(model)
                .chatMemoryProvider(memoryId -> MessageWindowChatMemory.builder()
                        .id(memoryId)
                        .maxMessages(20)
                        .build())
                .tools(tools)
                .build();
    }
}
```

#### 追问：
- 追问1：示例里大模型"自动决策"先查因子再查法规，若两个工具返回结果相互矛盾（如因子库与法规口径不一致），Agent 如何察觉并追问？
  - **答**：Agent 难自察觉矛盾。
    - 兜底：
      - ① 工具结果带回 `source/版本/口径` 元数据，由校验 Advisor 比对冲突并提示"数据存在口径差异，建议人工确认"
      - ② System Prompt 要求遇矛盾显式说明并追问用户
      - ③ 关键数值以权威源（最新法规/因子库版本）为准
- 追问2：defaultTools 把所有工具暴露给每次对话，碳管家如何避免用户诱导 Agent 调用越权工具（如删除数据类接口）？
  - **答**：最小权限。
    - ① 不把高危/写操作工具注册进对话 Agent
    - ② 工具按角色/权限过滤（据用户身份动态裁剪可用 Tool 列表）
    - ③ 高敏感工具加二次确认或仅限内部后台
    - ④ Advisor 层校验工具调用合法性

### 17. 整个过程完全是大模型自己决策吗？
**重要度**：★★★

**基本是的，但有约束**：

- 大模型基于 System Prompt 中的工具描述和对话上下文，自主选择是否调用工具、调用哪个工具、传什么参数。
- 开发者通过 Prompt 设计和工具描述来引导决策，但不能完全控制。
- **安全约束**：可限制工具调用次数（如最多3次），防止死循环；对工具执行结果做校验。

#### 追问：
- 追问1：你说"限制工具调用最多3次防止死循环"，但若第3次仍返回不完整的因子，碳管家是放弃回答还是降级到人工，如何设计？
  - **答**：不硬放弃。
    - 设计：达到上限仍未凑齐关键数据→返回"部分结论 + 明确告知缺失项 + 建议转人工/补充信息"而非空回答；
    - 同时记录该次失败用于评测；简单兜底可降级到更强模型再试一次（计不同预算）。
- 追问2：在碳合规这种强监管场景，"模型自主决策"是否应该对关键动作（如对外发送企业碳数据）做人工确认闸口？
  - **答**：必须加闸口。
    - 涉及对外发送/申报/删除等不可逆或强监管动作，模型只生成"建议动作 + 草稿"，实际执行需人工确认（human-in-the-loop）；
    - 在 Agent 工具层对这类动作加确认标记，由应用层拦截待审。

### 18. 如何设计多模型支持架构？
**重要度**：★★★

见[第六章第21题《多模型支持架构如何设计？》](/02-ai-model-integration.html#q-6-21)。Spring AI 中通过注入多个 `ChatModel` Bean + 自定义路由逻辑实现。

#### 追问：
- 追问1：注入多个 ChatModel Bean 后，碳管家的路由逻辑放在 Advisor 还是独立 Gateway 层，两种位置对"按客户分级"的扩展性有何差异？
  - **答**：放 Gateway/适配层更适合"按客户分级"——路由是横切关注点，独立层可结合 Nacos 客户配置、限流、成本统一管控，扩展性强。
    - Advisor 内路由则耦合在单次请求链，适合简单场景；
    - 建议路由下沉到独立 AI 网关，Advisor 只做单模型内增强。
- 追问2：同一问题在 Qwen 与文心返回的答案风格/数值不同，多模型架构下如何做一致性校验或投票，避免同一用户两次问答口径漂移？
  - **答**：对关键数值类问题可做"双模型交叉校验"（数值差超阈值则告警/要求人工）；同一用户会话内固定路由到同一模型避免漂移。
    - 或以主模型为准、备选仅降级；
    - 一致性优先于"投票"，因碳领域答案需确定性。
- 追问3：私有 vLLM 与公有云通义千问并存时，鉴权、限流、计费和故障转移应统一在哪一层管理？
  - **答**：统一在 AI 网关/适配层管理：鉴权（API Key/内部 Token）、限流（按客户/模型维度）、计费（Token 统计上报）、故障转移（vLLM 不可用→切公有云）都在该层。
    - 模型实现层只管协议；
    - 这样切换对上层透明且便于治理。

### 19. Spring AI的Starter依赖是如何实现自动装配的？
**重要度**：★★★

基于 Spring Boot 3 的自动装配机制：

1. `spring-ai-starter-model-openai` 的 `META-INF/spring/org.springframework.boot.autoconfigure.AutoConfiguration.imports` 里登记的**不是一个大类**，而是按能力拆开的一组：`OpenAiChatAutoConfiguration`、`OpenAiEmbeddingAutoConfiguration`、`OpenAiImageAutoConfiguration`、`OpenAiAudioSpeechAutoConfiguration`、`OpenAiAudioTranscriptionAutoConfiguration` 等（1.0 起已没有笼统的 `OpenAiAutoConfiguration`）。
2. 每个类各自用 `@ConditionalOnClass`、`@ConditionalOnProperty`（如 `spring.ai.openai.api-key` 是否存在）判断是否生效，只装配自己那项能力。
3. 生效后分别注册对应 Bean：chat 段出 `OpenAiChatModel`、embedding 段出 `OpenAiEmbeddingModel` —— 所以你只配 chat 不配 embedding 时，容器里就只有 ChatModel。


#### 三种框架实现对比

##### Spring AI 1.0 实现

```java
// ===== 1.0：Spring Boot 自动装配走 META-INF/spring/org.springframework.boot.autoconfigure.AutoConfiguration.imports =====
package com.carbon.guard.config;

import org.springframework.boot.autoconfigure.AutoConfiguration;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.context.annotation.Bean;
import org.springframework.ai.openai.OpenAiChatModel;
import org.springframework.ai.openai.api.OpenAiApi;

/**
 * 自定义一个自动装配，等价于官方 starter 的做法：
 * 1) 在 META-INF/spring/org.springframework.boot.autoconfigure.AutoConfiguration.imports 里登记类名
 * 2) 用 @ConditionalOnProperty / @ConditionalOnMissingBean 做条件装配
 * 3) 用 @AutoConfiguration 注解（Spring Boot 3+）
 * 4) ⚠️ 登记在 .imports 里的类必须用 @AutoConfiguration，不能用 @Configuration：
 *    @AutoConfiguration 是 proxyBeanMethods=false 的派生注解，并带 before/after 排序语义；
 *    换成 @Configuration 会丢掉"在用户配置之后、按 after 顺序装配"的保证，还可能被 CGLIB 代理干扰条件判断
 */
@AutoConfiguration
@ConditionalOnProperty(name = "carbon.ai.enabled", havingValue = "true", matchIfMissing = true)
public class CarbonAiAutoConfiguration {

    @Bean
    @ConditionalOnMissingBean
    public OpenAiChatModel carbonChatModel(CarbonAiProperties props) {
        OpenAiApi api = OpenAiApi.builder()
                .baseUrl(props.getBaseUrl())
                .apiKey(props.getApiKey())
                .build();
        return OpenAiChatModel.builder().openAiApi(api).build();
    }
}
```

##### Spring AI 2.0 实现

```java
// ===== 2.0：自动装配写法几乎不变，主要差异在 baseUrl/apiKey 进了 Options =====
package com.carbon.guard.config;

import org.springframework.boot.autoconfigure.AutoConfiguration;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.context.annotation.Bean;
import org.springframework.ai.openai.OpenAiChatModel;
import org.springframework.ai.openai.OpenAiChatOptions;

/**
 * 2.0 差异：不再单独构造 OpenAiApi 再 openAiApi(api) 挂上去，
 * 而是把 baseUrl / apiKey / model 一起放进 OpenAiChatOptions，由 Options 驱动底层官方 SDK
 * （与第 3 题 2.0 段同一套接入方式）
 * 类注解仍是 @AutoConfiguration（不能用 @Configuration，否则丢排序/代理语义，见 1.0 段第 4 条）
 */
@AutoConfiguration
@ConditionalOnProperty(name = "carbon.ai.enabled", havingValue = "true", matchIfMissing = true)
public class CarbonAiAutoConfiguration {

    @Bean
    @ConditionalOnMissingBean
    public OpenAiChatModel carbonChatModel(CarbonAiProperties props) {
        return OpenAiChatModel.builder()
                .options(OpenAiChatOptions.builder()
                        .baseUrl(props.getBaseUrl())
                        .apiKey(props.getApiKey())
                        .model(props.getModel())
                        .build())
                .build();
    }
}
```

##### LangChain4j 实现

```java
// ===== LangChain4j 的自动装配：官方 starter 通过 spring-ai.langchain4j.* 前缀注入 =====
package com.carbon.guard.config;

import dev.langchain4j.model.openai.OpenAiChatModel;
import dev.langchain4j.service.AiServices;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

/**
 * LangChain4j 官方 starter 提供 OpenAiChatModel 自动装配（配置前缀 langchain4j.open-ai.*），
 * 业务侧只需用 AiServices 声明接口
 */
@Configuration
public class LangChain4jConfig {

    @Bean
    public CarbonAssistant carbonAssistant(OpenAiChatModel model) {
        return AiServices.builder(CarbonAssistant.class)
                .chatModel(model)
                .build();
    }
}
```

#### 追问：
- 追问1：碳管家自定义 QwenChatModel 时用 @Primary 覆盖自动装配的默认 Bean，会不会与 Starter 的 @ConditionalOnMissingBean 冲突？
  - **答**：不冲突且正是标准做法——Starter 自动配置用 `@ConditionalOnMissingBean(ChatModel.class)`，你自定义的 `@Primary ChatModel` 已存在即跳过自动装配，由你的 Bean 生效。
    - 注意只覆盖目标类型，避免误伤其它自动配置。
- 追问2：当同时存在 spring-ai-openai 与 spring-ai-alibaba 两个 Starter、类路径都满足 @ConditionalOnClass 时，Bean 装配顺序和覆盖规则如何确定？
  - **答**：顺序由 `AutoConfiguration.imports` 声明顺序与 `@AutoConfigureAfter/Before` 决定；同类型 Bean 按 `@ConditionalOnMissingBean` 语义，先注册的生效、后到的因已存在而跳过。
    - 多个 `ChatModel` 需显式 `@Primary` 指定优先；
    - 建议只引入实际需要的 Starter 避免歧义。

### 20. Spring AI的配置驱动设计理念是什么？
**重要度**：★★★

通过 `application.yml` 配置驱动所有行为，遵循 Spring Boot 的"约定优于配置"理念：

```yaml
spring:
  ai:
    openai:
      api-key: ${OPENAI_API_KEY}
      chat:
        options:
          model: qwen-vl
          temperature: 0.3
          max-tokens: 2000
```

改配置即可切换模型、调整参数，无需改代码。

#### 追问：
- 追问1：碳管家把 temperature、模型名放 Nacos 热更新，但部分参数是构造 ChatClient 时固化的，配置刷新能否真正生效，有何陷阱？
  - **答**：陷阱：若 `ChatClient`/`ChatModel` 启动时构造并固化 options，Nacos 刷新不会自动重建→不生效。
    - 需对 ChatClient/配置类加 `@RefreshScope`，或在变更监听里重建 Bean；
    - 或把可变参数放到每次 `prompt().options()` 动态传入，避免固化。
- 追问2：配置驱动让"改 yml 切模型"很方便，但模型切换导致的 Prompt 兼容差异谁来保证，配置中心能否承载这套校验？
  - **答**：配置中心只管分发，不保证语义兼容。
    - 建议：
      - ① 切换模型前在灰度环境用评测集验证 Prompt 兼容性
      - ② 为不同模型维护 Prompt 变体（按模型维度路由对应模板）
      - ③ 配置中心加"模型→Prompt 版本"绑定元数据，切换时联动并做变更评审

### 21. 如何在Spring AI中实现对话记忆？
**重要度**：★★★★★

**ChatMemory 接口**：

```java
// Spring AI 1.0 GA 的真实签名：conversationId 是【String】，messages 是【列表】
// 单条重载 default void add(String, Message) 仍然保留
public interface ChatMemory {
    void add(String conversationId, List<Message> messages);
    List<Message> get(String conversationId);
    void clear(String conversationId);
    default void add(String conversationId, Message message) { ... }
}
```

**实现**：

- `MessageWindowChatMemory`：**1.0 GA 唯一的窗口内存实现**，只保留最近 N 条消息（超窗丢弃最旧），是官方推荐。
- 持久化不是独立的 Memory 类，而是走 **`ChatMemoryRepository`** 接口：
  - `InMemoryChatMemoryRepository`（默认，纯内存，仅开发/测试用）
  - `JdbcChatMemoryRepository`（**官方内置**的 JDBC 持久化实现）
  - 另有 `CassandraChatMemoryRepository` / `Neo4jChatMemoryRepository`
- ⚠️ **`RedisChatMemory`、`InMemoryChatMemory`、`JdbcChatMemory` 这三个类名在 1.0 GA 都不存在**——1.x 要落 Redis 得自己实现 `ChatMemoryRepository`（像下面那样），别在面试里说"直接用 RedisChatMemory"。
  - **2.0 才官方提供 Redis 实现**（`spring-ai-autoconfigure-model-chat-memory-repository-redis`）。

**使用**：

```java
@Bean
ChatMemory chatMemory(ChatMemoryRepository repository) {
    // 内置实现 + 自研 Repository：窗口策略负责裁剪，Repository 负责持久化
    // 注意：Spring AI 1.x 未内置 Redis 实现，这个 Repository 需自行实现
    return MessageWindowChatMemory.builder()
        .chatMemoryRepository(repository)
        .maxMessages(20)
        .build();
}

// Advisor 自动注入历史对话
ChatClient client = chatClientBuilder
    .defaultAdvisors(new MessageChatMemoryAdvisor(chatMemory))
    .build();
```

**碳管家助手记忆策略**：保留最近5轮对话 + 更早对话的摘要，避免上下文窗口溢出。


#### 三种框架实现对比

##### Spring AI 1.0 实现

```java
package com.carbon.guard.memory;

import org.springframework.ai.chat.memory.ChatMemory;
import org.springframework.ai.chat.memory.ChatMemoryRepository;
import org.springframework.ai.chat.memory.MessageWindowChatMemory;
import org.springframework.ai.chat.client.advisor.MessageChatMemoryAdvisor;
import org.springframework.ai.chat.client.ChatClient;
import org.springframework.stereotype.Service;

/**
 * 1.0 GA 关键点：
 * 1) ChatMemory 的 conversationId 是【String】，不是 UUID
 * 2) 持久化走 ChatMemoryRepository（InMemory/Jdbc/Cassandra/Neo4j），
 *    没有 InMemoryChatMemory / JdbcChatMemory 这两个类
 * 3) builder 方法是 .chatMemoryRepository(...)，1.0.0-M6 之前才是 .chatMemoryStore(...)
 */
@Service
public class CarbonChatMemoryService {

    private final ChatClient chatClient;

    public CarbonChatMemoryService(ChatMemoryRepository repository, ChatClient.Builder builder) {
        // 窗口策略负责裁剪，Repository 负责持久化
        ChatMemory chatMemory = MessageWindowChatMemory.builder()
                .chatMemoryRepository(repository)
                .maxMessages(20)      // 保留最近 10 轮对话
                .build();

        this.chatClient = builder
                .defaultAdvisors(new MessageChatMemoryAdvisor(chatMemory))
                .build();
    }

    public String chat(String conversationId, String userInput) {
        // 1.0：把 conversationId 放进 advisor 上下文
        return chatClient.prompt()
                .advisors(a -> a.param(
                        org.springframework.ai.chat.memory.ChatMemory.CONVERSATION_ID, conversationId))
                .user(userInput)
                .call()
                .content();
    }
}
```

##### Spring AI 2.0 实现

```java
package com.carbon.guard.memory;

import org.springframework.ai.chat.memory.ChatMemory;
import org.springframework.ai.chat.memory.MessageWindowChatMemory;
import org.springframework.ai.chat.client.advisor.MessageChatMemoryAdvisor;
import org.springframework.ai.chat.client.ChatClient;
import org.springframework.stereotype.Service;

/**
 * 2.0 变化：
 * 1) conversationId 【必填】，没有 DEFAULT_CONVERSATION_ID 兜底
 * 2) 提供官方 Redis 实现：spring-ai-autoconfigure-model-chat-memory-repository-redis
 *    前缀 spring.ai.chat.memory.repository.redis.*
 * 3) PromptChatMemoryAdvisor 已移除，只保留 MessageChatMemoryAdvisor
 */
@Service
public class CarbonChatMemoryService {

    private final ChatClient chatClient;

    public CarbonChatMemoryService(ChatMemoryRepository repository, ChatClient.Builder builder) {
        ChatMemory chatMemory = MessageWindowChatMemory.builder()
                .chatMemoryRepository(repository)
                .maxMessages(20)
                .build();

        this.chatClient = builder
                .defaultAdvisors(new MessageChatMemoryAdvisor(chatMemory))
                .build();
    }

    public String chat(String conversationId, String userInput) {
        // 2.0：conversationId 必传，缺失直接抛异常
        return chatClient.prompt()
                .advisors(a -> a.param(ChatMemory.CONVERSATION_ID, conversationId))
                .user(userInput)
                .call()
                .content();
    }
}
```

##### LangChain4j 实现

```java
package com.carbon.guard.memory;

import dev.langchain4j.memory.chat.MessageWindowChatMemory;
import dev.langchain4j.service.AiServices;
import dev.langchain4j.service.MemoryId;
import dev.langchain4j.service.SystemMessage;
import dev.langchain4j.service.UserMessage;
import dev.langchain4j.model.chat.ChatLanguageModel;
import org.springframework.stereotype.Service;

/**
 * LangChain4j 1.x：记忆通过 chatMemoryProvider 挂进 AiServices，
 * 运行时调自己声明的接口方法（AiServices 本身没有 chat 方法）
 */
@Service
public class CarbonChatMemoryService {

    private final CarbonAssistant assistant;

    public CarbonChatMemoryService(ChatLanguageModel model) {
        // 窗口记忆：只保留最近 N 条消息；多实例部署要换 ChatMemoryStore 落 Redis
        this.assistant = AiServices.builder(CarbonAssistant.class)
                .chatModel(model)
                .chatMemoryProvider(id -> MessageWindowChatMemory.builder()
                        .id(id)              // 会话维度隔离
                        .maxMessages(20)
                        .build())
                .build();
    }

    public String chat(String conversationId, String userInput) {
        return assistant.chat(conversationId, userInput);
    }

    interface CarbonAssistant {
        @SystemMessage("你是碳管理专家助手，回答需引用排放因子出处。")
        @UserMessage("{{it}}")
        // 会话隔离必须用 @MemoryId：它会被传给 chatMemoryProvider 的 id 参数
        // 用 @V 只会做模板变量替换，provider 拿不到会话 ID，所有用户会串进同一个记忆
        String chat(@MemoryId String conversationId, String message);
    }
}
```

#### 追问：
- 追问1：碳管家"保留最近5轮+更早摘要"的策略，摘要由谁生成（模型还是规则），摘要本身出错会不会污染后续所有对话？
  - **答**：摘要由模型生成（调用 LLM 对早期对话做压缩），规则难保语义。
    - 风险确实存在——错误摘要会持续污染后续；
    - 缓解：摘要仅保留"已确认事实/用户画像"，不保留待定数值；关键结论以工具/检索结果为准；提供"清空记忆"入口。
- 追问2：1.x 没有官方 Redis 记忆实现，自研 `ChatMemoryRepository`（Redis 版）时 key 怎么设计，同一会话多线程并发写入如何避免消息错乱？
  - **答**：1.x 要落 Redis 只能自己实现 `ChatMemoryRepository`（`findByConversationId` / `saveAll` / `deleteByConversationId`），2.0 官方才补了 `spring-ai-autoconfigure-model-chat-memory-repository-redis`。
    - Key 用 `chat:memory:{tenantId}:{conversationId}` 隔离租户，值用 List 或 ZSet 按 `message_order` 排序；
    - 同一会话并发写入用 Redis 原子操作（Lua 追加）或按 conversationId 加分布式锁串行化 `saveAll`，读侧按 conversationId 幂等。

### 22. Spring AI如何支持结构化输出？
**重要度**：★★★★

```java
// 方式一：Bean 类
record CarbonReport(String productName, double gwp, String unit, List<String> references) {}

CarbonReport report = chatClient.prompt()
    .user("分析钢铁产品碳足迹")
    .call()
    .entity(CarbonReport.class);  // 自动解析为 Java 对象
```

底层通过 JSON Mode 或 Function Calling 让大模型返回 JSON，Spring AI 用 Jackson 反序列化。

#### 追问：
- 追问1：碳管家的 CarbonReport 要求数值带单位与来源，若模型返回的 JSON 字段缺失或数值超范围，.entity() 反序列化失败如何兜底？
  - **答**：兜底：
    - ① 用 `@JsonProperty(required=false)` + 默认值，缺失不崩
    - ② 捕获反序列化异常，降级为"非结构化文本 + 提示用户核对"
    - ③ 后接 `CarbonValidationAdvisor` 校验数值范围/单位，超范围要求重答或转人工
    - ④ 关键字段缺失直接重试一次
- 追问2：结构化输出依赖 JSON Mode 或 Function Calling，当底层模型（如本地 Ollama 小模型）不支持严格 JSON 时，如何保证碳报告字段完整？
  - **答**：local 小模型 JSON 不稳。
    - 做法：
      - ① 优先用支持 JSON Mode 的模型做结构化输出
      - ② 小模型下改用 Function Calling 约束（比纯 JSON 稳）
      - ③ 对返回做宽松解析+字段补全校验
      - ④ 关键报告场景路由到强模型，小模型只做草稿

### 23. Spring AI的异常处理机制是怎样的？
**重要度**：★★★★

```java
try {
    String answer = chatClient.prompt().user(query).call().content();
} catch (NonTransientAiException e) {
    // 不可恢复异常（如认证失败、模型不支持）
    log.error("AI调用失败", e);
    return fallbackResponse();
} catch (TransientAiException e) {
    // 可恢复异常（如限流、超时）
    // 自动重试
} catch (Exception e) {
    // 其他异常
}
```

可通过 Advisor 统一拦截：

```java
public class ExceptionHandlingAdvisor implements CallAdvisor {
    @Override
    public ChatClientResponse adviseCall(ChatClientRequest request, CallAdvisorChain chain) {
        try {
            return chain.nextCall(request);
        } catch (Exception e) {
            return handleException(e);
        }
    }
    @Override
    public int getOrder() { return 0; }
}
```

#### 追问：
- 追问1：TransientAiException 自动重试若叠加网关层限流，会不会造成碳管家对通义千问的"重试风暴"，重试退避策略如何设计？
  - **答**：会放大——重试叠加限流易雪崩。
    - 设计：
      - ① 用指数退避 + 抖动（backoff+jitter）
      - ② 限制单请求重试次数与全局并发重试配额
      - ③ 区分限流（429）与业务错，仅对可恢复且未超预算的做退避重试
      - ④ 网关侧对重试流量打标并单独限流
- 追问2：Advisor 中统一捕获异常后返回兜底回答，该回答是否会被记忆 Advisor 当作正常对话存进 Redis，污染下次上下文？
  - **答**：可能污染——若兜底回答也走记忆 Advisor 的 response 钩子就会被存。
    - 处理：
      - ① 异常处理里标记该消息为"系统兜底/不可信"，记忆 Advisor 跳过存储
      - ② 或把兜底生成放在记忆保存之前并排除
      - ③ 存储时带 `synthetic=true` 标识，注入时过滤

### 24. 如何在Spring AI中集成本地模型（如Ollama）？
**重要度**：★★★

```yaml
spring:
  ai:
    ollama:
      base-url: http://localhost:11434
      chat:
        options:
          model: llama3
```

```java
// 与云模型使用方式完全一致
String answer = chatClient.prompt()
    .user("什么是碳足迹？")
    .call()
    .content();
```

**碳管家助手实践**：开发测试环境用 Ollama + Qwen2.5:7b 本地部署，零 API 成本，CI/CD 流水线中可运行集成测试。


#### 三种框架实现对比

##### Spring AI 1.0 实现

```java
package com.carbon.guard.ollama;

import org.springframework.ai.chat.client.ChatClient;
import org.springframework.ai.ollama.OllamaChatModel;
import org.springframework.ai.ollama.OllamaOptions;
import org.springframework.stereotype.Service;

/**
 * 依赖：spring-ai-starter-model-ollama
 * 配置（1.0）：spring.ai.ollama.base-url / spring.ai.ollama.chat.options.model
 */
@Service
public class OllamaChatService {

    private final ChatClient chatClient;

    public OllamaChatService(OllamaChatModel chatModel) {
        this.chatClient = ChatClient.create(chatModel);
    }

    public String chat(String question) {
        return chatClient.prompt()
                .options(OllamaOptions.builder()
                        .model("qwen2.5:7b")
                        .temperature(0.3)
                        .build())
                .user(question)
                .call()
                .content();
    }
}
```

##### Spring AI 2.0 实现

```java
package com.carbon.guard.ollama;

import org.springframework.ai.chat.client.ChatClient;
import org.springframework.ai.ollama.OllamaChatModel;
import org.springframework.ai.ollama.OllamaOptions;
import org.springframework.stereotype.Service;

/**
 * 2.0 变化：
 * 1) Options 仍是 builder().build() 构造，options(...) 收的是 build 好的 ChatOptions 实例；
 *    构造后不要再改，要么每次新建、要么用 mutate() 派生，不能缓存一个实例重复改
 * 2) 配置属性去掉 .options 段：spring.ai.ollama.chat.model=qwen2.5:7b
 */
@Service
public class OllamaChatService {

    private final ChatClient chatClient;

    public OllamaChatService(OllamaChatModel chatModel) {
        this.chatClient = ChatClient.create(chatModel);
    }

    public String chat(String question) {
        return chatClient.prompt()
                // 2.0：options(...) 收 build 好的 ChatOptions 实例（builder 只是构造手段）
                .options(OllamaOptions.builder()
                        .model("qwen2.5:7b")
                        .temperature(0.3)
                        .build())
                .user(question)
                .call()
                .content();
    }
}
```

##### LangChain4j 实现

```java
package com.carbon.guard.ollama;

import dev.langchain4j.model.ollama.OllamaChatModel;
import dev.langchain4j.service.AiServices;
import org.springframework.stereotype.Service;

/**
 * LangChain4j 通过 OllamaChatModel 直连本地模型
 */
@Service
public class OllamaChatService {

    private final CarbonAssistant assistant;

    public OllamaChatService() {
        OllamaChatModel model = OllamaChatModel.builder()
                .baseUrl("http://localhost:11434")
                .modelName("qwen2.5:7b")
                .temperature(0.3)
                .maxTokens(2048)
                .build();
        this.assistant = AiServices.builder(CarbonAssistant.class)
                .chatModel(model)
                .build();
    }

    public String chat(String question) {
        return assistant.chat(question);
    }

    interface CarbonAssistant {
        @dev.langchain4j.service.UserMessage("{{it}}")
        String chat(String message);
    }
}
```

#### 追问：
- 追问1：碳管家 CI/CD 用 Ollama + Qwen2.5:7b 跑集成测试，但 7B 与线上 72B 能力差距大，测试结果能否代表生产回答质量？
  - **答**：不能代表"回答质量"，仅能验证"链路通畅/工具调用正确"。
    - 质量需分层：单测/Mock 验逻辑，集成测验流程，生产质量用评测集在强模型上回归；
    - CI 用 7B 只为快与零成本，质量门禁另跑评测集。
- 追问2：本地 Ollama 与线上通义千问对工具调用 Schema 的支持度不同，同一套 @Tool 在两种环境表现不一致时如何发现与隔离？
  - **答**：发现：CI 集成测试覆盖各 Tool 的调用/返回校验，环境差异会在测试暴露。
    - 隔离：
      - ① Tool 入参保持简单兼容两种模型
      - ② 对环境不支持的能力在测试里 `@Disabled`/打标
      - ③ 用配置区分环境，必要时为本地模型降配工具集

### 25. Spring AI的生态中还有哪些扩展组件？
**重要度**：★★★

- **Spring AI Alibaba**：阿里扩展，支持通义千问、百炼平台。
- **Vector Stores**：支持 Milvus/PGVector/Chroma 等 10+ 向量库。
- **Document Readers**：PDF/Word/HTML/Markdown 解析。
- **Advisors**：请求/响应拦截增强（日志、安全、缓存、RAG）。
- **Model Context Protocol (MCP) Client**：连接外部 MCP Server。

#### 追问：
- 追问1：碳管家若引入 MCP Client 连接外部 MCP Server，这些 Server 的鉴权、超时与版本如何纳入现有 Spring Cloud 治理体系？
  - **答**：把 MCP Server 当作"外部微服务"治理。
    - ① 鉴权走统一网关/Token，不在 Client 硬编码
    - ② 超时/重试在 MCP Client 封装层配置并接入熔断
    - ③ 版本用 Server 注册元数据 + 兼容约定（语义化版本）
    - ④ 可观测性接 Micrometer，链路追踪纳入 Micrometer Tracing（Sleuth 自 Boot 3 起已停止演进，见第 11 章）
- 追问2：Document Readers 对扫描版 PDF（ISO 标准多为图片扫描）解析效果差，单纯依赖 Spring AI 生态是否够用，需补充什么 OCR 能力？
  - **答**：不够。扫描版 PDF 需先 OCR（如 Tesseract/百度 OCR/自建识别服务）提取文字，再交给 `PdfDocumentReader`/分块。
    - 建议 ETL 前置 OCR 步骤，把图片页转文本并保留页码坐标便于溯源；
    - 复杂表格可引入表格识别模型。

### 26. Spring AI的未来发展方向是什么？
**重要度**：★★

先说结论：**MCP 已经不是"未来方向"**——1.1 GA 就落地了，2.0 是一等公民（Client 默认传输从 SSE 换成 Streamable HTTP，工具可由 starter 自动装配成 `ToolCallback`，见第 5 章）。真正还没闭环的是下面这些：

1. **Agent 框架增强**：对标 LangGraph，补齐多 Agent 编排、状态图与可回放（2.0 的 ToolCallingAdvisor 上浮、渐进式工具披露是铺垫）。
2. **MCP 生态深化（已支持，继续演进）**：Client 侧已稳定，方向在 Server 侧治理——鉴权、注册发现、版本兼容、多 Server 聚合。
3. **可观测性**：与 Micrometer/Micrometer Tracing 深度集成。
4. **AOT/GraalVM**：支持原生镜像编译，降低启动时间和内存占用。
5. **多模态增强**：图片、音频、视频的统一处理。

#### 追问：
- 追问1：你看好 Spring AI 对标 LangGraph 的 Agent 框架，但碳管家已用 LangChain4j 做 Agent，未来是收敛到单框架还是双轨并行？
  - **答**：不建议为追新而迁移。
    - 若 Spring AI Agent 成熟且团队收益明显，可在新模块试点、老模块保留 LangChain4j，长期视维护成本收敛；
    - 短期双轨但需明确边界避免重复；决策依据=迁移成本 vs 长期一致性收益。
- 追问2：AOT/GraalVM 原生镜像对碳管家这种依赖大量反射（工具调用、Jackson）的 AI 应用，会带来哪些构建期挑战？
  - **答**：挑战：反射（Tool 方法、Jackson 序列化类）需显式注册到 native metadata；动态代理/Resource 加载在原生镜像受限；构建慢、调试难。
    - 缓解：用 Spring AOT 自动推导 + 手写 `reflect-config`；
    - 优先对无 AI 的模块做原生化试点。

### 27. 如何对Spring AI应用进行单元测试和集成测试？
**重要度**：★★★★

**单元测试**：Mock `ChatModel`：

```java
// Spring Boot 3.4+ 起 @MockBean / @SpyBean 已废弃（Boot 4 移除），
// Spring Framework 6.2+ 用 @MockitoBean / @MockitoSpyBean 替代
@MockitoBean ChatModel chatModel;

@Test
void testCarbonQuery() {
    // ChatResponse 没有 (String) 构造器，必须由 Generation + AssistantMessage 组装
    when(chatModel.call(any(Prompt.class)))
        .thenReturn(new ChatResponse(List.of(
                new Generation(new AssistantMessage("碳足迹是指...")))));
    String answer = service.query("什么是碳足迹");
    assertThat(answer).contains("碳足迹");
}
```

**集成测试**：Testcontainers 启动 Ollama + Milvus：

```java
@SpringBootTest
@Testcontainers
class RagIntegrationTest {
    // 裸 GenericContainer("milvusdb/milvus") 起不来：standalone 依赖 etcd + MinIO，缺一个就退出。
    // 官方模块 org.testcontainers:milvus 的 MilvusContainer 内部以 ETCD_USE_EMBED=true 启动，
    // 是真单容器，不会额外拉起依赖容器，最省事。
    @Container
    static MilvusContainer milvus = new MilvusContainer("milvusdb/milvus:v2.4.15");

    // OllamaContainer 里没有模型，启动后要先 pull
    @Container
    static OllamaContainer ollama = new OllamaContainer("ollama/ollama:0.3.12");

    @DynamicPropertySource
    static void registerProps(DynamicPropertyRegistry registry) {
        registry.add("spring.ai.ollama.base-url", ollama::getEndpoint);
        registry.add("spring.ai.vectorstore.milvus.client.host", milvus::getHost);
        registry.add("spring.ai.vectorstore.milvus.client.port", () -> milvus.getMappedPort(19530));
    }

    @BeforeAll
    static void pullModel() throws Exception {
        ollama.execInContainer("ollama", "pull", "qwen2.5:7b");
    }

    @Autowired VectorStore vectorStore;
    @Autowired ChatClient.Builder chatClientBuilder;

    @Test
    void testRagPipeline() {
        // 1) 写入：一条带来源元数据的碳因子文档
        vectorStore.add(List.of(new Document(
                "钢铁长流程（高炉-转炉）吨粗钢排放约 1.9 tCO2e/t",
                Map.of("source", "worldsteel-2023", "chunkId", "steel-1"))));

        // 2) 检索：断言召回到刚写入的 chunk —— 这才是集成测试该验的东西
        List<Document> hits = vectorStore.similaritySearch(
                SearchRequest.builder().query("钢铁 吨粗钢 排放").topK(3).build());
        assertThat(hits).isNotEmpty();
        assertThat(hits).anyMatch(d -> "steel-1".equals(d.getMetadata().get("chunkId")));

        // 3) 生成：断言链路通、答案非空；7B 小模型的数值准确性不在这里校验（见追问1）
        String answer = chatClientBuilder.build().prompt()
                .user("钢铁长流程吨粗钢排放多少？")
                .advisors(new QuestionAnswerAdvisor(vectorStore))
                .call().content();
        assertThat(answer).isNotBlank();
    }
}
```



#### 三种框架实现对比

##### Spring AI 1.0 实现

```java
package com.carbon.guard.test;

import org.junit.jupiter.api.Test;
import org.springframework.ai.chat.client.ChatClient;
import org.springframework.ai.chat.model.ChatModel;
import org.springframework.ai.chat.model.ChatResponse;
import org.springframework.ai.chat.model.Generation;
import org.springframework.ai.chat.messages.AssistantMessage;

import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * 1.0 GA 没有内置 MockChatModel / TestChatClient，
 * 单测要自己实现 ChatModel 打桩；集成测试用 @SpringBootTest + 真实模型
 */
class CarbonChatServiceTest {

    /** 自己打桩一个 ChatModel：固定返回，断言提示词与解析逻辑 */
    @Test
    void shouldExtractFactor() {
        ChatModel stub = request -> new ChatResponse(List.of(
                new Generation(new AssistantMessage(
                        "{\"industry\":\"钢铁\",\"value\":1.89,\"unit\":\"tCO2e/t\"}"))));

        CarbonFactorService service = new CarbonFactorService(ChatClient.create(stub));
        EmissionFactor factor = service.extract("钢铁");

        assertThat(factor.industry()).isEqualTo("钢铁");
        assertThat(factor.value()).isEqualTo(1.89);
    }
}
```

##### Spring AI 2.0 实现

```java
package com.carbon.guard.test;

import org.junit.jupiter.api.Test;
import org.springframework.ai.chat.client.ChatClient;
import org.springframework.ai.chat.model.ChatModel;
import org.springframework.ai.chat.model.ChatResponse;
import org.springframework.ai.chat.model.Generation;
import org.springframework.ai.chat.messages.AssistantMessage;

import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * 2.0 仍无官方 MockChatModel，单测继续自己打桩；
 * 集成测试建议用 Testcontainers 起真实模型服务，避免依赖云端 Key
 */
class CarbonChatServiceTest {

    @Test
    void shouldExtractFactor() {
        ChatModel stub = request -> new ChatResponse(List.of(
                new Generation(new AssistantMessage(
                        "{\"industry\":\"钢铁\",\"value\":1.89,\"unit\":\"tCO2e/t\"}"))));

        CarbonFactorService service = new CarbonFactorService(ChatClient.create(stub));
        EmissionFactor factor = service.extract("钢铁");

        assertThat(factor.industry()).isEqualTo("钢铁");
        assertThat(factor.value()).isEqualTo(1.89);
    }
}
```

##### LangChain4j 实现

```java
package com.carbon.guard.test;

import dev.langchain4j.model.chat.ChatLanguageModel;
import dev.langchain4j.model.chat.StreamingChatLanguageModel;
import dev.langchain4j.service.AiServices;
import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * LangChain4j 自带测试替身：FakeChatModel / InMemoryChatModel，
 * 单测不需要自己实现接口
 */
class CarbonChatServiceTest {

    @Test
    void shouldAnswerWithFakeModel() {
        ChatLanguageModel fake = FakeChatModel.builder()
                .responses("钢铁行业排放因子为 1.89 tCO2e/t")
                .build();

        CarbonAssistant assistant = AiServices.builder(CarbonAssistant.class)
                .chatModel(fake)
                .build();

        assertThat(assistant.chat("钢铁行业排放因子？"))
                .contains("1.89");
    }
}
```

#### 追问：
- 追问1：用 Mock ChatModel 做单元测试只能验证"是否调用了工具"，但无法验证"答案数值是否正确"，碳管家如何补上答案正确性的测试？
  - **答**：分层补：
    - ① 单测 Mock 验工具调用/流程
    - ② 加"固定回答快照测试"（Mock 返回标准因子，断言最终 JSON 数值字段正确）
    - ③ 离线评测集在强模型上跑数值准确性校验
    - ④ 关键计算（LCA 公式）抽成纯函数单测，不依赖 LLM
- 追问2：Testcontainers 拉起 Ollama + Milvus 跑 RAG 集成测试，在 CI 资源受限时启动耗时长，如何做分层（单测/Mock/轻量集成）取舍？
  - **答**：分层：
    - ① 纯逻辑/工具单测用 Mock，秒级
    - ② RAG 集成测用轻量方案（内存向量库 + 小模型/Ollama，或只对检索部分做集成）
    - ③ 重集成测（Milvus 全链路）设为 nightly/手动，不在每次 PR 跑
    - ④ 用测试容器复用/缓存镜像缩短启动


#### 扩充第四节：Spring AI框架（新增10题）


### 28. Spring AI 1.0 / 1.1 / 2.0 版本演进与关键特性
**重要度**：★★★★★

**题目：Spring AI 从 1.0 到 2.0 有哪些关键变化？各版本的定位是什么？升级到 2.0 对碳管家AI助手意味着什么？**

**版本时间线（要背准，面试常问）**：
| 版本 | 发布时间 | 定位 |
|---|---|---|
| 1.0.0 GA | 2025年5月 | 首个生产就绪版本，确立 ChatModel / ChatClient / VectorStore / Advisor 四大抽象 |
| 1.1.0 GA | 2025年11月12日 | 850+ 项改进：MCP 集成落地、Prompt Caching、递归 Advisor、模型生态扩张 |
| 2.0.0-M1 | 2025年12月11日 | 首个 2.x 里程碑，基线切到 Spring Boot 4 + Spring Framework 7 + Java 21 |
| 2.0.0 GA | 2026年6月12日 | 架构级重构：工具调用上浮 Advisor 链、MCP 一等公民、Options 全面不可变 |

**1.0 GA（2025年5月）** 标志着从实验性项目到生产就绪框架的跨越，核心抽象：
- **ChatModel统一抽象**：所有LLM接入统一使用`ChatModel`接口，支持OpenAI/Azure/Ollama/通义千问等，碳管家可无缝切换模型供应商
- **Advisor Chain机制**：类似Servlet Filter的链式处理，可在请求前后插入自定义逻辑（如检索、后处理、审计），碳管家可在Advisor中实现RAG检索+结果校验
- **Tool Calling（Function Calling）**：原生支持LLM调用Java方法，碳管家可让LLM调用碳排放计算服务、因子查询API等
- **VectorStore统一接口**：Milvus/PgVector/Chroma等统一API，碳管家可灵活切换向量存储
- **Structured Output**：将LLM输出自动映射为Java POJO，碳管家可将LCA报告映射为`CarbonFootprintReport`对象
- **Observability**：集成Micrometer，自动记录推理延迟、Token消耗、模型调用次数，碳管家可接入Prometheus监控

**1.1 GA（2025年11月）——最值得记的三个特性**：
- **MCP 集成落地**（本版本最大特性）：提供 Spring Boot 自动配置与注解编程模型（`@McpTool` / `@McpResource` / `@McpPrompt`），支持 STDIO、HTTP SSE、Streamable HTTP 三种传输，客户端与服务端各有专用 starter，另有 OAuth2 安全集成
- **Prompt Caching**：为 Anthropic Claude 与 AWS Bedrock 提供五种缓存策略（NONE / SYSTEM_ONLY / TOOLS_ONLY / SYSTEM_AND_TOOLS / CONVERSATION_HISTORY），官方称可降本最多 90%
- **递归 Advisor（Recursive Advisors）**：Advisor 可以调用其他 Advisor，内置两种实现，可编排"生成→自评→改进"的多步 Agent 流程，也是 LLM-as-a-Judge 评测的落地方式

**2.0 GA（2026年6月）——架构级重构，五条主线**：
1. **基线与基础设施**：Spring Boot 4.0/4.1 + Spring Framework 7.0 + **Java 21 起步**（1.x 是 Java 17）；**Jackson 2 → Jackson 3**（包名 `com.fasterxml.jackson` → `tools.jackson`）；全库用 JSpecify 标注空安全（`@NonNull` / `@Nullable`）
2. **Options 全面不可变 + Builder 化**：默认值统一收敛到 Options 层；Options 只能 `builder().build()` 构造且不可变；`copy()` / `fromOptions()` 移除，改用 `mutate()`；**配置属性去掉 `.options` 段**（`spring.ai.openai.embedding.options.model` → `spring.ai.openai.embedding.model`）
3. **API 焦点转向 ChatClient**：`ChatClient` 是面向用户的主入口，`ChatModel` 降级为底层构建块；`ChatClient.options(...)` 接收的仍是 `ChatOptions` **实例**（`builder().build()` 构造，builder 只是构造手段、不会直接传入）
4. **工具调用彻底重构**（最大变化）：各 ChatModel 内部私有的工具执行循环**全部移除**，`ChatModel.call()` 只返回模型原始响应；工具循环上浮为 `ToolCallingAdvisor` 并由 ChatClient 自动注册；新增 `ToolSearchToolCallingAdvisor`（渐进式工具披露）与 `StructuredOutputValidationAdvisor`（结构化输出校验失败自动纠正重试）
5. **MCP 成为一等公民**：随附 **MCP Java SDK 2.0.0**，符合 2025-11-25 版 MCP 规范；`mcp-annotations` 模块并入 Spring AI（`org.springaicommunity.mcp.*` → `org.springframework.ai.mcp.annotation.*`）；WebMVC/WebFlux 传输从 MCP SDK 移入 Spring AI；**Streamable HTTP 成为默认传输，取代已废弃的 SSE 传输**（无状态变体可换远程扩展性，代价是失去双向通信）

**对碳管家的影响：**
- 从0.x迁移到1.0需重构部分代码（API变化较大），但长期维护性显著提升
- Advisor Chain简化了碳管家现有的RAG+后处理Pipeline，不再需要手动编排
- Tool Calling使碳管家从纯问答升级为可执行操作的AI助手（如自动查询企业碳数据）

#### 追问：
- 追问1：从 0.x 迁移到 1.0 时，碳管家哪些已有 Advisor/Prompt 写法会因 API 变化而必须重构，迁移成本如何评估？
  - **答**：主要变动：`Advisor` 接口签名（request/response 钩子）、`ChatClient` Fluent API、Tool 注册（`@Tool` 替代旧 `FunctionCallback` 写法，**2.0 已把 `FunctionCallback` 彻底移除**）、`VectorStore` API。
    - 评估：先跑编译+单测暴露 breaking 点，按模块量化改动量；
    - 优先迁移高频路径，旧写法逐步淘汰。
- 追问2：1.0 的 Observability 接入 Micrometer 后，碳管家的 Token 成本与回答质量能否在 Grafana 中关联到具体客户会话？
  - **答**：可以——以 `conversationId`/`tenantId` 为 Micrometer Tag 记录 Token、延迟、调用次数，Grafana 按会话/客户聚合。
    - 质量分（评测）也带同一 ID 写入时序库；
    - 即可在面板关联"某客户会话的成本 vs 质量"，定位低性价比客户/模型。

### 29. Spring AI的Advisor机制详解
**重要度**：★★★★★

**题目：请详细解释Spring AI的Advisor机制，包括内置Advisor（ChatMemory等）和自定义Advisor的实现方式。**

Advisor机制是Spring AI 1.0的核心设计，类似Web Filter的链式拦截模式，允许在LLM调用前后插入处理逻辑。

Advisor接口：
```java
import reactor.core.publisher.Flux;

// Spring AI 1.0 GA：Advisor 只是 marker interface（空壳），
// 真正的拦截点拆成了 非流式/流式 两个子接口。
// 注意：1.0 GA 用 ChatClientRequest / ChatClientResponse，
// 旧的 AdvisedRequest / AdvisedResponse / CallAroundAdvisorChain 已移除
public interface CallAdvisor extends Advisor {
    ChatClientResponse adviseCall(ChatClientRequest request, CallAdvisorChain chain);
}
public interface StreamAdvisor extends Advisor {
    // 流式是 N 个 chunk，返回值必须是 Flux，不能是单个 ChatClientResponse
    Flux<ChatClientResponse> adviseStream(ChatClientRequest request, StreamAdvisorChain chain);
}
```
- `adviseCall / adviseStream(...)`：LLM 调用**前**处理请求（注入检索上下文、改写 Prompt），拿到 `ChatClientResponse` 后**还能继续处理**（格式校验、敏感词过滤）——前后逻辑写在同一个方法里
- `chain.nextCall(request)`：显式放行到"下一个 Advisor → LLM"；**不调用它即短路**，直接返回你构造的响应（常用于缓存命中直接返回）
- **没有 `context` Map 参数**：要跨 Advisor 传递检索结果、用户信息等状态，用 `ChatClientRequest` 的 `context()`（`ChatClientRequest` 是 `record(prompt, context)`，其中 context 是 `Map<String,Object>`），读用 `request.context().get(key)`，写用 `request.mutate().context(map).build()` 生成新请求再往下传；会话 ID 则用 `.advisors(a -> a.param(ChatMemory.CONVERSATION_ID, cid))` 注入。1.0 之前那套 `AdvisorContext` / `Map<String,Object> context` 参数写法已经没有了

内置Advisor：
- **ChatMemoryAdvisor**：自动在请求中注入历史对话记忆，在响应中保存新对话
  - 1.0 GA 的实现类是 `MessageChatMemoryAdvisor`（配合 `MessageWindowChatMemory`），**没有 `WindowedChatMemory` 这个类**
  - 碳管家场景：保持用户上下文连贯性（"刚才那个排放因子是多少？"需要回溯）
- **QuestionAnswerAdvisor**：集成RAG检索，自动检索向量库并将结果注入Prompt
  - 碳管家场景：核心RAG检索Advisor

自定义Advisor示例（碳管家）：
```java
public class CarbonValidationAdvisor implements CallAdvisor {
    @Override
    public ChatClientResponse adviseCall(ChatClientRequest request, CallAdvisorChain chain) {
        ChatClientResponse response = chain.nextCall(request);
        String answer = response.chatResponse().getResult().getOutput().getText();
        // 校验碳排放数值是否合理
        if (containsCarbonValue(answer) && !validateRange(answer)) {
            return rewriteResponse("碳排放数值异常，请参考最新排放因子库重新确认");
        }
        return response;
    }
    @Override
    public int getOrder() { return 0; }
}
```

Advisor Chain顺序：检索→记忆注入→LLM调用→格式校验→敏感词过滤→置信度标注

#### 追问：
- 追问1：碳管家的 Advisor Chain 顺序是"检索→记忆→LLM→校验→敏感词→置信度"，若 CarbonValidationAdvisor 改写响应内容，会不会与上游 RAG 注入的引用来源脱节，如何保证改后内容仍可溯源？
  - **答**：会脱节风险。
    - 保证：
      - ① 校验 Advisor 只改"数值/措辞"，不删 RAG 注入的引用块
      - ② 改写后保留原 `references` 元数据并随响应透传
      - ③ 若改写涉及结论，要求同步更新引用标注
      - ④ 响应以结构化字段携带 source 而非仅文本
- 追问2：多个 Advisor 通过 context Map 共享数据时，若两个自定义 Advisor 写入同名 key，后写覆盖前写导致的隐性 Bug 如何排查？
  - **答**：排查：
    - ① 约定 key 命名空间（如 `carbon.retrieval.*`、`carbon.validate.*`）
    - ② 用唯一前缀避免冲突
    - ③ 单测每个 Advisor 的输入输出 context
    - ④ 开发态加 Assert 检测重复 key 写入
    - ⑤ 借链路日志打印 context 辅助定位
- 追问3：Advisor 中做同步校验（如调用因子库验证数值）会拉长首字延迟，碳管家如何平衡"回答准确性"与"流式体验"？
  - **答**：平衡：
    - ① 把"必须同步"的校验（关键数值）前置并设超时，超时就先放行标注"待核"
    - ② 非关键校验放流式输出后异步进行，发现问题再追加提示
    - ③ 首字优先——检索/校验并行化，校验不阻塞首个 token 推送
    - ④ 低风险回答放宽同步校验

### 30. Spring AI的Tool Calling内部实现
**重要度**：★★★★

**题目：Spring AI的Tool Calling如何让LLM调用Java方法？请说明其内部实现原理和碳管家场景中的典型应用。**

Tool Calling（原Function Calling）允许LLM在生成过程中识别需要调用外部工具，由框架执行Java方法并将结果返回LLM继续生成。

内部实现流程（**1.x 与 2.0 链路不同，面试要能分清**）：

**1.x：工具循环在 ChatModel 内部**
- Step 1：开发者注册Tool（Java方法）到ChatModel，框架自动生成Function Schema（JSON Schema格式）描述方法名、参数类型、返回类型
- Step 2：将Function Schema列表随Prompt一起发送给LLM
- Step 3：LLM判断是否需要调用Tool，若需要则输出`tool_calls`（指定函数名和参数值）
- Step 4：`ChatModel.call()` 内部拦截`tool_calls`，反序列化参数，通过反射调用对应的Java方法
- Step 5：将方法返回结果序列化为JSON，作为工具消息（`ToolResponseMessage`）追加到对话历史
- Step 6：ChatModel 内部再次发起请求，循环至无`tool_calls` 才把最终答案返回给调用方

**2.0：循环上浮到 ToolCallingAdvisor**
- Step 1：`ToolCallback` 显式注册为 Bean，或 `@Tool` 对象经 `.tools(...)` 挂到 ChatClient
- Step 2：ChatClient 自动注册的 `ToolCallingAdvisor` 把工具 Schema 放进本次请求
- Step 3：`ChatModel.call()` 只做**单次**调用，返回带 `tool_calls` 的原始 `ChatResponse`，**不再执行任何工具**
- Step 4：Advisor 内的 `ToolCallingManager` 解析 `tool_calls`，找到并执行对应 `ToolCallback`
- Step 5：把工具结果包成 `ToolResponseMessage` 追加进消息列表，由 Advisor 发起下一次 ChatModel 调用
- Step 6：重复 3~5 直到无 `tool_calls`，Advisor 才把最终答案交还调用方

**为什么 2.0 要把循环上浮**：
- 可观测——每一轮工具调用都走完整的 Advisor 生命周期，能埋点、能拿到中间轮次的 token 与耗时
- 可干预——自定义 Advisor 能在循环的每一跳前后做校验、改写或熔断；1.x 循环封在 ChatModel 内，外部插不进去
- 支持渐进式工具披露（progressive tool disclosure）——按轮次逐步挂载工具，不必首轮就把全部 Schema 塞给模型

注册方式（2.0：`@Description` + `Function` Bean 的自动注册已随 `SpringBeanToolCallbackResolver` 移除，必须显式声明 `ToolCallback` Bean）：
```java
@Bean
ToolCallback lookupFactorTool(FactorService svc) {
    return FunctionToolCallback.builder("lookupFactor", (LookupRequest r) -> svc.lookup(r))
            .description("按行业与活动名称查询碳排放因子")
            .inputType(LookupRequest.class)
            .build();
}
```

碳管家典型应用：
- `carbonFactorLookup`：LLM调用查询排放因子API，获取精确数值而非凭记忆回答
- `lcaCalculator`：LLM调用碳足迹计算服务，执行精确数学运算而非LLM自行估算
- `regulationSearch`：LLM调用法规检索API，获取最新政策条文
- `enterpriseDataQuery`：LLM调用企业碳数据查询接口，获取真实数据而非通用知识

关键注意：Tool返回结果应简洁（LLM不宜处理超大JSON），碳管家中排放因子查询应只返回{value, unit, source}而非全量数据。


#### 三种框架实现对比

##### Spring AI 1.0 实现

```java
package com.carbon.guard.tool;

import org.springframework.ai.chat.model.ChatResponse;
import org.springframework.ai.tool.ToolCallback;
import org.springframework.ai.tool.ToolCallbackProvider;
import org.springframework.ai.tool.function.FunctionToolCallback;
import org.springframework.context.annotation.Bean;
import org.springframework.stereotype.Component;

import java.util.Map;

/**
 * Tool Calling 内部链路（Spring AI 1.0 GA）：
 * 1) ChatModel 把工具元信息（name/description/参数 JSON Schema）随请求发给模型
 * 2) 模型返回 tool_calls（工具名 + 序列化参数）
 * 3) 框架按名字找到 ToolCallback，反射调用对应方法
 * 4) 把 ToolResponse 作为 tool 消息回灌，模型再生成最终答案
 * 5) 循环直到模型不再返回 tool_calls
 */
@Component
public class CarbonFactorToolProvider {

    /** 用 FunctionToolCallback 把普通方法包装成工具 */
    @Bean
    public ToolCallback factorLookupTool() {
        return FunctionToolCallback.builder("lookupEmissionFactor",
                        (LookupRequest req) -> "{\"steel\":1.89,\"cement\":0.84}")   // 第二参是 Function 实现（此处为桩）；真实场景注入 FactorService 调其方法
                .description("按行业与活动名称查询碳排放因子")
                .inputType(LookupRequest.class)
                .build();
    }

    /** 直接用 @Tool 注解声明，Spring AI 扫描后自动注册为 ToolCallback */
    @Component
    public static class FactorTools {

        @org.springframework.ai.tool.annotation.Tool(description = "按行业与活动名称查询碳排放因子")
        public String lookupEmissionFactor(LookupRequest req) {
            return "{\"steel\":1.89,\"cement\":0.84}";
        }
    }

    public record LookupRequest(String industry, String activity) {}
}
```

##### Spring AI 2.0 实现

```java
package com.carbon.guard.tool;

import org.springframework.ai.tool.ToolCallback;
import org.springframework.ai.tool.function.FunctionToolCallback;
import org.springframework.ai.tool.annotation.Tool;
import org.springframework.context.annotation.Bean;
import org.springframework.stereotype.Component;

/**
 * 2.0 变化（重要）：
 * 1) 工具必须【显式注册 ToolCallback Bean】，toolNames() 已移除
 * 2) ToolCallingAdvisor 由 ChatClient 自动注册，负责完整的"发起→执行→回灌"往返；
 *    ChatModel.call() 只返回原始响应，不再自动执行工具
 * 3) 要关闭自动注册：AdvisorParams.toolCallingAdvisorAutoRegister(false)
 * 4) 工具数量多（几百个）时用 ToolSearchToolCallingAdvisor 做渐进式工具披露
 */
@Component
public class CarbonFactorToolProvider {

    @Bean
    public ToolCallback factorLookupTool() {
        return FunctionToolCallback.builder("lookupEmissionFactor",
                        (LookupRequest req) -> "{\"steel\":1.89,\"cement\":0.84}")   // 第二参是 Function 实现（此处为桩）；真实场景注入 FactorService 调其方法
                .description("按行业与活动名称查询碳排放因子")
                .inputType(LookupRequest.class)
                .build();
    }

    @Component
    public static class FactorTools {
        @Tool(description = "按行业与活动名称查询碳排放因子")
        public String lookupEmissionFactor(LookupRequest req) {
            return "{\"steel\":1.89,\"cement\":0.84}";
        }
    }

    public record LookupRequest(String industry, String activity) {}
}
```

##### LangChain4j 实现

```java
package com.carbon.guard.tool;

import dev.langchain4j.agent.tool.P;
import dev.langchain4j.agent.tool.Tool;
import dev.langchain4j.service.AiServices;
import org.springframework.stereotype.Service;

/**
 * LangChain4j 1.x：用 @Tool + @P 注解声明工具，工具对象作为 POJO 传给 AiServices
 */
@Service
public class CarbonToolService {

    private final CarbonAssistant assistant;

    public CarbonToolService(ChatLanguageModel model) {
        this.assistant = AiServices.builder(CarbonAssistant.class)
                .chatModel(model)
                .tools(new FactorTools())     // 工具对象注入
                .build();
    }

    public String chat(String question) {
        return assistant.chat(question);
    }

    static class FactorTools {
        @Tool("按行业与活动名称查询碳排放因子")
        String lookupEmissionFactor(
                @P("行业名称，例如 钢铁") String industry,
                @P("活动名称，例如 高炉炼铁") String activity) {
            return "{\"steel\":1.89,\"cement\":0.84}";
        }
    }

    interface CarbonAssistant {
        @dev.langchain4j.service.UserMessage("{{it}}")
        String chat(String message);
    }
}
```

#### 追问：
- 追问1：Spring AI 反射调用 Java 方法时若工具抛受检异常，框架会把异常信息原样回传模型还是吞掉，碳管家如何避免异常细节泄露到对外回答？
  - **答**：默认可能把异常转成 tool 错误消息回传模型，细节有泄露风险。
    - 做法：工具内部 try-catch，统一返回"业务友好错误（如'因子库暂时不可用'）"而非堆栈；
    - 敏感异常只记日志不外露；必要时让模型知会用户"稍后重试/转人工"。
- 追问2：你说工具返回应只含 {value, unit, source}，但当模型需要"为什么要选这个因子"的解释时，过度精简的返回是否会削弱回答可信度？
  - **答**：会。折中：返回结构化但含"可选解释字段"（如 `basis`/`applicableScope` 简述选取依据），长度可控。
    - 或在 source 里附文档章节号，模型据此展开；
    - 核心是"必要字段精简 + 可溯源引用"，而非完全无解释。

### 31. Spring AI中如何自定义ChatModel
**重要度**：★★★★

**题目：碳管家使用私有部署的通义千问（vLLM），Spring AI没有原生适配器，如何自定义ChatModel接入？**

自定义ChatModel需实现Spring AI的`ChatModel`接口（或`StreamingChatModel`），将私有模型的API协议适配到Spring AI的统一抽象。

核心接口：
```java
public interface ChatModel extends Model<Prompt, ChatResponse> {
    ChatResponse call(Prompt prompt);
    default ChatOptions getDefaultOptions() { return null; }
}
```

实现步骤：
1. 创建`QwenChatModel`类实现`ChatModel`接口
2. 在`call(Prompt prompt)`方法中：
   - 将Spring AI的Prompt转换为通义千问API格式（messages→JSON）
   - 发送HTTP请求到vLLM的OpenAI兼容端点
   - 解析响应为Spring AI的`ChatResponse`格式
3. 创建`QwenChatOptions`类实现`ChatOptions`，支持配置model、temperature、topP等参数
4. 注册为Spring Bean：`@Bean QwenChatModel qwenChatModel(...)`

简化实现（vLLM OpenAI兼容）：
- vLLM已兼容OpenAI API，可直接使用Spring AI的`OpenAiChatModel`
- 仅需配置：`spring.ai.openai.base-url=http://vllm-server:8000`（**只写到「域名+端口」，不要带 `/v1`**——Spring AI 的 `OpenAiApi` 会自己拼 `chatCompletionsPath`（默认 `/v1/chat/completions`），写成 `.../v1` 会请求 `/v1/v1/chat/completions` 直接 404）
- 但部分参数（如通义千问特有的repetition_penalty）需通过`OpenAiChatOptions`的extra参数传递

完整自定义（非OpenAI兼容模型）：
- 使用RestTemplate/WebClient调用模型原生API
- 处理模型特有的请求/响应格式差异
- 实现StreamingChatModel时需处理SSE流式解析
- 注册`QwenChatModel`到`ChatModel`的Spring Bean，配合`@Primary`标记优先使用

#### 追问：
- 追问1：私有 vLLM 与 Spring AI OpenAiChatModel 仅 base-url 不同，但通义千问特有参数（如 repetition_penalty）走 extra 透传时，若 vLLM 版本升级改名参数，兼容风险由谁承担？
  - **答**：风险由适配层承担——把 vLLM 特有参数封装在自定义 `ChatOptions`/配置映射里，升级时只改映射层不波及业务。
    - 建议参数名集中管理 + 启动时对 vLLM 能力做探测/校验；
    - 改名及时告警而非静默失效。
- 追问2：完整自定义需用 WebClient 处理 SSE 流式解析，流式过程中连接中断或超时，自定义 QwenChatModel 应如何优雅降级而非抛异常中断整条 Advisor 链？
  - **答**：在 `stream()` 实现里用 `Flux` 的 `onErrorResume`：连接中断/超时返回兜底提示或切备用模型，并以 `onError` 信号安全结束流而非抛未捕获异常。
    - Advisor 链捕获后给前端发 error 事件；
    - 同时打点告警，避免整链崩溃。
- 追问3：@Primary 标记的 QwenChatModel 与 Starter 自动装配的默认 Bean 并存时，Spring AI 的 @ConditionalOnMissingBean 是否会因已存在 Bean 而跳过自动配置，导致其它自动装配（如 Embedding）受影响？
  - **答**：不会波及其它——`@ConditionalOnMissingBean` 只针对被判断的那一类型（如 `ChatModel`）。
    - 你自定义 `ChatModel` 只跳过 ChatModel 自动装配，Embedding/VectorStore 等各自独立条件不受影响；
    - 注意别用 `@Primary` 误标到其它类型。

### 32. Spring AI多模态支持
**重要度**：★★★★

**题目：碳管家AI助手需要处理用户上传的碳排放报告PDF、工厂图片、监控视频等多模态内容，Spring AI如何支持多模态输入？**

Spring AI 1.0支持多模态输入（Image为主，Audio/Video逐步完善），允许在ChatModel请求中混合文本和媒体内容。

Image支持（已GA）：
- `Media`类封装图片数据：`new Media(MimeTypeUtils.IMAGE_PNG, imageResource)`
- 在Prompt中混合文本和图片：`Media` 挂在 `UserMessage` 上，再包进 `Prompt`——`new Prompt(List.of(new UserMessage("分析这张碳排放监控图表的趋势", media)))`（`Prompt` 只有 `new Prompt(messages)` 构造，没有 `of(...)` 静态工厂）
- 支持URL和本地文件两种方式传入图片
- 碳管家场景：用户上传工厂烟囱排放图片，AI识别排放类型和估算排放量

Audio支持（实验性）：
- Spring AI的Audio模块支持语音输入（OpenAI Whisper）
- 碳管家场景：现场工程师语音描述工艺流程，AI自动提取关键信息
- 当前仅支持OpenAI Whisper API，私有部署需自定义TranscriptionModel

Video支持（计划中）：
- 目前Spring AI无原生Video支持，需自行将视频关键帧提取后作为多张Image输入
- 碳管家场景：监控视频提取关键帧后分析排放事件

PDF/文档处理：
- Spring AI的ETL Pipeline支持PDF文档加载和解析
- `PdfDocumentReader`提取PDF文本，配合`TextSplitter`分块
- 碳管家场景：用户上传LCA报告PDF → 自动解析 → 分块入库 → RAG检索

实践建议：碳管家应优先实现Image+PDF多模态（最常见需求），Audio作为二期功能，Video暂用关键帧提取方案。

#### 追问：
- 追问1：碳管家用户上传的工厂图片常含图表与表格，纯视觉识别易读错数字，是否应结合 OCR/表格解析而非仅依赖 Media 多模态输入？
  - **答**：应结合。图表/表格数字对精度敏感，纯视觉易错。
    - 建议图片先经 OCR/表格识别抽取结构化数值，再与多模态理解互补；
    - 关键数字走 OCR 抽取而非模型"看"，提高可追溯与准确率，必要时人工核对。
- 追问2：你说 Video 暂用关键帧提取方案，但排放事件可能跨帧，抽帧策略（固定间隔 vs 运动检测）会如何影响"排放事件"识别的召回？
  - **答**：固定间隔可能漏掉短时排放事件（漏检、召回低）；运动/场景变化检测能在事件发生时密集抽帧，召回更高但成本高。
    - 建议按场景混合：常规低帧率 + 运动突变时触发密集抽帧；
    - 并对事件前后上下文帧一并分析。
- 追问3：多模态输入会显著拉长首字延迟与 Token 消耗，碳管家对图片/PDF 是否应做大小与分辨率上限，并在入口层做降级？
  - **答**：应限。入口层设图片大小/分辨率上限（超限压缩或拒绝），PDF 页数/大小上限。
    - 超阈值走异步任务或降级为"先解析文本/RAG"而非实时多模态；
    - 同时按客户等级差异化配额，控制成本与延迟。

### 33. Spring AI与Spring Cloud生态集成
**重要度**：★★★

**题目：碳管家AI助手运行在Spring Cloud微服务架构中，如何将Spring AI与Nacos、Spring Cloud Gateway等组件集成？**

Spring AI与Spring Cloud生态集成，使AI能力成为微服务架构中的一等公民，而非独立旁路系统。

Nacos集成（配置管理）：
- 模型参数动态配置：`spring.ai.openai.chat.temperature`、`spring.ai.openai.chat.model`等参数存储在Nacos配置中心（2.0 已扁平化，1.x 为 `spring.ai.openai.chat.options.*`）
- 运行时热更新：配置变更本身可推送，但 `ChatModel`/`ChatOptions` 由 starter 在启动时一次性绑定构造，**不会自动刷新**——需配合 `@RefreshScope` 重建 Bean、监听 `RefreshEvent` 主动重建，或每请求用 `prompt().options()` 动态传入参数
- 多环境管理：开发环境用Ollama+小模型，生产环境用vLLM+大模型，通过Nacos namespace隔离
- 碳管家场景：不同客户（企业/政府/审核机构）可配置不同的模型参数和Prompt模板

Spring Cloud Gateway集成（路由管理）：
- Boot 4 下 gateway 坐标已拆分，WebFlux 版为 `spring-cloud-starter-gateway-server-webflux`
- AI推理请求通过Gateway统一路由，支持按Region、模型类型、优先级分流
- 自定义`AiRoutePredicateFactory`：根据请求中的问题复杂度Header路由到不同推理服务
- 限流：Gateway对推理API按用户/企业维度限流，防止滥用
- 碳管家场景：企业客户优先路由到72B模型，个人用户路由到7B模型

Micrometer Tracing 集成（可观测性）：
- Spring AI 内置 Observation，自动接入 Micrometer，记录推理延迟、Token 消耗、模型调用次数
- 链路追踪用 **Micrometer Tracing**（`micrometer-tracing-bridge-otel` 或 `micrometer-tracing-bridge-brave` 二选一）——Spring Cloud Sleuth 自 Spring Boot 3 起已停止演进，Boot 4.1 基线不再使用
- TraceId/SpanId 由 Micrometer Tracing 通过 MDC 自动注入日志，串联检索→推理→后处理全链路
- 典型配置：`management.tracing.enabled=true`、`management.otlp.tracing.endpoint=http://otel-collector:4318/v1/traces`（用 Brave+Zipkin 则换 `management.zipkin.tracing.endpoint`）
- 碳管家运维：通过Grafana看板监控AI服务质量，异常时快速定位环节


#### 三种框架实现对比

##### Spring AI 1.0 实现

```java
package com.carbon.guard.cloud;

import org.springframework.ai.chat.client.ChatClient;
import org.springframework.cloud.client.loadbalancer.LoadBalanced;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.web.client.RestClient;
import org.springframework.cloud.gateway.route.RouteLocator;
import org.springframework.cloud.gateway.route.RouteLocatorBuilder;

/**
 * 典型集成点：
 * 1) @LoadBalanced RestClient 调多实例的向量库/因子服务
 * 2) Spring Cloud Gateway 做 AI 网关：限流、鉴权、灰度路由到不同模型
 * 3) Micrometer + Prometheus 埋点，走 Cloud Monitor
 */
@Configuration
public class AiCloudConfig {

    /** 通过服务名调因子微服务（走负载均衡） */
    @Bean
    @LoadBalanced
    public RestClient factorServiceRestClient(RestClient.Builder builder) {
        return builder.baseUrl("http://factor-service").build();
    }

    /** AI 网关路由：按模型名路由到不同后端 */
    @Bean
    public RouteLocator aiRoutes(RouteLocatorBuilder builder) {
        return builder.route("ai-chat", r -> r.path("/ai/chat/**")
                        .and().header("X-Model", "qwen-plus")
                        .filters(f -> f.stripPrefix(1))
                        .uri("lb://llm-gateway-qwen"))
                .route("ai-chat-default", r -> r.path("/ai/chat/**")
                        .filters(f -> f.stripPrefix(1))
                        .uri("lb://llm-gateway-default"))
                .build();
    }
}
```

##### Spring AI 2.0 实现

```java
// 说明：Spring Cloud 集成本身没有 API 差异，本段与 1.0 代码基本相同，
//       2.0 下真正变的是"依赖坐标 + 链路追踪实现"（见上方文字）。
package com.carbon.guard.cloud;

import org.springframework.ai.chat.client.ChatClient;
import org.springframework.cloud.client.loadbalancer.LoadBalanced;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.web.client.RestClient;
import org.springframework.cloud.gateway.route.RouteLocator;
import org.springframework.cloud.gateway.route.RouteLocatorBuilder;

/**
 * 2.0 差异：
 * 1) 多供应商统一由 AI 网关 / Router 抽象处理，ChatClient 只面向统一协议
 * 2) ToolCallingAdvisor 自动注册，网关层无需关心工具编排
 * 3) MCP 服务发现：2.0 客户端支持按传输分子树配置连接（stdio / sse / streamable-http）
 */
@Configuration
public class AiCloudConfig {

    @Bean
    @LoadBalanced
    public RestClient factorServiceRestClient(RestClient.Builder builder) {
        return builder.baseUrl("http://factor-service").build();
    }

    @Bean
    public RouteLocator aiRoutes(RouteLocatorBuilder builder) {
        return builder.route("ai-chat", r -> r.path("/ai/chat/**")
                        .and().header("X-Model", "qwen-plus")
                        .filters(f -> f.stripPrefix(1))
                        .uri("lb://llm-gateway-qwen"))
                .route("ai-chat-default", r -> r.path("/ai/chat/**")
                        .filters(f -> f.stripPrefix(1))
                        .uri("lb://llm-gateway-default"))
                .build();
    }
}
```

##### LangChain4j 实现

```java
package com.carbon.guard.cloud;

import dev.langchain4j.model.chat.ChatLanguageModel;
import dev.langchain4j.service.AiServices;
import org.springframework.cloud.client.loadbalancer.LoadBalanced;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.web.client.RestClient;

/**
 * LangChain4j 与 Spring Cloud 集成方式：
 * 1) ChatLanguageModel Bean 由 Spring 容器管理（starter 自动装配）
 * 2) 需要多供应商路由时，自己实现 ChatLanguageModel 代理做降级/灰度
 */
@Configuration
public class AiCloudConfig {

    @Bean
    @LoadBalanced
    public RestClient factorServiceRestClient(RestClient.Builder builder) {
        return builder.baseUrl("http://factor-service").build();
    }

    /** 多供应商路由：主模型失败降级到备模型 */
    @Bean
    public ChatLanguageModel routingChatModel(ChatLanguageModel primary, ChatLanguageModel backup) {
        return new FallbackChatModel(primary, backup);
    }

    @Bean
    public CarbonAssistant carbonAssistant(ChatLanguageModel model) {
        return AiServices.builder(CarbonAssistant.class)
                .chatModel(model)
                .build();
    }
}
```

#### 追问：
- 追问1：Nacos 热更新 temperature 等参数，但若 ChatClient 在启动时已固化配置，配置刷新能否真正生效，还是需要配合 @RefreshScope 重建 Bean？
  - **答**：需配合——若 `ChatClient`/`ChatModel` options 启动时固化，Nacos 刷新不会自动生效。
    - 解法：
      - ① 对配置类/`ChatClient` 加 `@RefreshScope` 重建
      - ② 或把可变参数每次请求用 `prompt().options()` 动态传入
      - ③ 监听 `RefreshEvent` 主动重建，否则热更新是"假生效"
- 追问2：Gateway 按问题复杂度 Header 路由到不同模型，但这个"复杂度"由谁在请求前判定，若判定错误把合规问题路由到 7B 模型后果如何兜底？
  - **答**：复杂度判定可由入口轻量分类（规则/小模型）或客户端业务标识给出。
    - 兜底：
      - ① 合规/高风险关键词强制走强模型（白名单优先于复杂度）
      - ② 7B 回答后过校验 Advisor，低置信度自动升级重答
      - ③ 错误路由有指标告警，反向优化分类器
- 追问3：Micrometer Tracing 的 Trace ID 串联检索→推理→后处理，但工具调用（如查因子库）若走独立微服务，是否也能纳入同一链路，否则如何定位"慢在工具还是模型"？
  - **答**：能纳入——工具调用的微服务通过 Micrometer Tracing 的传播机制（`W3C` / `B3` header）自动传递 Trace 上下文，只要因子库服务也接入同一 tracing bridge（OTel 或 Brave），整条链路同 TraceID。
    - 定位：在 Grafana 看各 span 耗时区分"检索/工具/模型"瓶颈；
    - 未接入则手动透传 traceId。

### 34. Spring AI的ETL Pipeline
**重要度**：★★★★

**题目：Spring AI提供了文档处理ETL Pipeline（加载→解析→分块→向量化→入库），如何用它构建碳管理知识库？**

Spring AI的ETL Pipeline是RAG知识库构建的核心工具链，覆盖从原始文档到向量存储的完整流程。

Pipeline组成：
- **DocumentReader（加载）**：读取原始文档
  - `PdfDocumentReader`：解析PDF（ISO标准文档、LCA报告）
  - `TextReader`：解析TXT/Markdown
  - `JsonReader`：解析结构化数据（排放因子JSON）
- **DocumentTransformer（解析/分块）**：处理文档内容
  - `TextSplitter`：按Token数分块，`TokenTextSplitter`按模型Token计数精确分块
  - `ContentFormatTransformer`：按格式模板重写文档文本（注入元数据、统一前缀），不做"去空行/标准化标题层级"这类清洗
  - 碳管理分块策略：ISO标准按条款分块（而非固定长度），保持条款完整性
- **EmbeddingModel（向量化）**：将文本块转换为向量
  - `TransformersEmbeddingModel`：本地运行Embedding模型
  - `OpenAiEmbeddingModel`：调用API Embedding服务
  - 碳管家使用通义千问Embedding或本地bge-large-zh-v1.5
- **VectorStore（入库）**：将向量+原文存入向量数据库
  - `MilvusVectorStore`：碳管家使用Milvus存储

完整Pipeline代码示例（Spring AI 没有 `EtlPipeline` 这个类，四步都是独立组件，手工串起来即可）：
```java
// 1) 读取：DocumentReader
Resource resource = new ClassPathResource("iso14064.txt");
List<Document> docs = new TextReader(resource).get();              // PDF 场景换对应 Reader

// 2) 切分：DocumentTransformer（TokenTextSplitter 本身就是 DocumentTransformer；多参构造 1.0 已废弃，用 builder）
docs = TokenTextSplitter.builder()
        .withChunkSize(512)
        .withMinChunkSizeChars(64)
        .build()
        .apply(docs);

// 3) 元数据：需要自定义元数据时自研 DocumentTransformer（或 KeywordMetadataEnricher）
//    docs = new CategoryEnricher(Map.of("category", "ISO标准", "year", "2018")).apply(docs);

// 4) 向量化 + 入库：VectorStore.add(List<Document>) 内部调用 EmbeddingModel 后再写入
vectorStore.add(docs);
```

碳管家定制：为每个文档添加业务元数据（industry、category、year），支持Self-Query检索的元数据过滤。

#### 追问：
- 追问1：ISO 标准按条款分块能保语义完整，但条款间存在引用（如"见 4.2 节"），分块后跨块引用断裂，检索时如何还原上下文？
  - **答**：还原：
    - ① 分块时把被引条款的"标题/核心句"作为上下文注入当前块元数据
    - ② 检索后对 topK 做"引用补全"——识别"见X节"并二次检索被引块并入上下文
    - ③ 或采用"父子分块"（小块检索、大块喂模型）保留条款周边
    - ④ 少量重叠分块缓解断裂
- 追问2：TokenTextSplitter(500,100,...) 的块大小在通义千问与本地 bge 两种 Embedding 下是否都最优，嵌入模型与分块策略耦合时如何调参？
  - **答**：不一定都最优——不同 Embedding 的最佳块长不同（bge 偏中等、Qwen 视模型）。
    - 调参：按所用 Embedding 分别做检索质量实验（Recall@k），选最优块长；
    - 切换 Embedding 时需重新标定分块参数并记录版本避免混用。
- 追问3：碳管家给文档加 industry/year 元数据做 Self-Query 过滤，但若用户问题未明确行业，元数据过滤过严会不会把相关文档全过滤掉导致检索为空？
  - **答**：会。缓解：
    - ① Self-Query 提取不到行业时不强制过滤（宽松兜底全量检索）
    - ② 用"行业缺失=通用"标记，使未指定行业也能命中通用+该行业
    - ③ 先宽后窄：无过滤检索 topK 再用元数据轻量重排而非硬过滤
    - ④ 检索为空时回退无过滤再答

### 35. Spring AI 的 Tool Callback 实现原理（FunctionCallback 已被移除）
**重要度**：★★★★★

**题目：Spring AI 的 Tool Calling 底层是怎么实现的？@Tool 和 ToolCallback 是什么关系，与 LangChain4j 的 @Tool 有何差异？**

⚠️ **版本提醒（高频坑）**：`FunctionCallback` 是 Spring AI **0.x** 的 API，**1.0 引入 `ToolCallback` 并把它标记为废弃，2.0 已彻底移除**——官方 Upgrade Notes 原话是 "2.0 removes the deprecated `FunctionCallback` types and methods entirely"。答这题时如果还在讲 `FunctionCallback.builder()`，会被听出没跟版本。

**ToolCallback 抽象（1.0 起的唯一形态）**：它是 Java 方法与 LLM Tool Schema 之间的桥接——
- `ToolCallback` 携带工具名、描述、入参 JSON Schema，并提供 `call(String input)` 执行入口
- 注册时框架依据 `@Tool` / `@ToolParam` 注解自动生成 JSON Schema
- LLM 返回 tool_call 时，框架按名字路由到对应 `ToolCallback` 实例，把参数 JSON 反序列化后调用 `call()`，再把结果回喂模型

**两种注册方式（现行）**：
1. **`@Tool` 注解（推荐）**：
```java
class CarbonFactorTools {
    @Tool(description = "查询碳排放因子")
    FactorResponse queryFactor(@ToolParam(description = "产品名称") String product) {
        return factorService.lookup(product);
    }
}
// 用法：chatClient.prompt().user("...").tools(new CarbonFactorTools()).call().content();
```
2. **显式 `ToolCallback` Bean**（需要精细控制 Schema / 复用同一工具时）：
```java
@Bean
ToolCallback carbonFactorLookup() {
    return FunctionToolCallback.builder("carbonFactorLookup", this::lookup)
        .description("查询碳排放因子")
        .inputType(FactorRequest.class)
        .build();
}
```
**2.0 起工具必须显式注册**：`toolNames("beanName")` 这种"按 Bean 名自动解析工具"的写法已随 `SpringBeanToolCallbackResolver` 一起移除，工具要么声明成 `ToolCallback` Bean，要么用 `@Tool`，然后通过 `.tools(...)` 传给 `ChatClient`。

**1.x → 2.0 官方迁移对照**（这张表背下来就够答迁移题）：
| 1.x | 2.0 |
|---|---|
| `FunctionCallback` | `ToolCallback` |
| `FunctionCallback.builder().function(name, fn)` | `FunctionToolCallback.builder(name, fn)` |
| `FunctionCallback.builder().method(...)` | `MethodToolCallback.builder()` + `ToolDefinition` |
| `FunctionCallingOptions` | `ToolCallingChatOptions` |
| `defaultFunctions(...)` | `defaultTools(...)` |
| `prompt().functions(cb)` | `prompt().tools(cb)` |

**与 LangChain4j `@Tool` 对比**：
- Spring AI：工具可注册为 Bean（便于依赖注入与配置化），也可用 `@Tool` 标在组件方法上；Schema 由框架从 Java 类型 + 注解生成
- LangChain4j：`@Tool` + `@P` 标注参数，工具对象以 POJO 形式传给 `AiServices`，更贴近"纯 POJO 风格"，但工具类需自行管理
- 碳管家双框架并存时：Tool 定义应只有一份真相源——Spring AI 侧负责执行与调度，LangChain4j 侧专注 RAG 检索，避免两套 Schema 各改各的漂移


#### 三种框架实现对比

##### Spring AI 1.0 实现

```java
package com.carbon.guard.tool;

import org.springframework.ai.tool.ToolCallback;
import org.springframework.ai.tool.function.FunctionToolCallback;
import org.springframework.ai.tool.definition.ToolDefinition;
import org.springframework.stereotype.Component;

/**
 * ToolCallback 是 Spring AI 1.0 GA 统一抽象，取代了已废弃的 FunctionCallback。
 * 它把"工具元信息"与"工具执行"合成一个对象：
 *  - getToolDefinition()：name / description / inputSchema(JSON Schema)，发给模型
 *  - call(String toolInput)：模型给出参数后的实际执行
 */
@Component
public class CarbonToolCallbackDemo {

    public ToolCallback build() {
        return FunctionToolCallback.builder("queryCarbonReport",
                        (ReportQuery req) -> "{\"reportId\":\"R-2026-001\"}")   // 第二参是 Function 实现（此处为桩）
                .description("按报告编号查询碳报告")
                .inputType(ReportQuery.class)
                .build();
    }

    /** 也可以直接实现 ToolCallback 拿到完全控制权 */
    public ToolCallback custom() {
        return new ToolCallback() {
            @Override
            public ToolDefinition getToolDefinition() {
                return ToolDefinition.builder()
                        .name("queryCarbonReport")
                        .description("按报告编号查询碳报告")
                        .inputSchema("""
                                {"type":"object",
                                 "properties":{"reportNo":{"type":"string"}},
                                 "required":["reportNo"]}""")
                        .build();
            }

            @Override
            public String call(String toolInput) {
                return "{\"reportNo\":\"PCF-2026-001\",\"total\":1234.5}";
            }
        };
    }

    public record ReportQuery(String reportNo) {}
}
```

##### Spring AI 2.0 实现

```java
package com.carbon.guard.tool;

import org.springframework.ai.tool.ToolCallback;
import org.springframework.ai.tool.function.FunctionToolCallback;
import org.springframework.ai.tool.definition.ToolDefinition;
import org.springframework.stereotype.Component;

/**
 * 2.0 变化：
 * 1) FunctionCallback 已彻底移除，ToolCallback 是唯一入口
 * 2) ToolCallback 必须注册为 Bean 才会被 ChatClient 装配进请求
 * 3) @Tool 注解的方法会被自动包装成 ToolCallback Bean（需显式声明或用 ToolCallbackProvider）
 */
@Component
public class CarbonToolCallbackDemo {

    public ToolCallback build() {
        return FunctionToolCallback.builder("queryCarbonReport",
                        (ReportQuery req) -> "{\"reportId\":\"R-2026-001\"}")   // 第二参是 Function 实现（此处为桩）
                .description("按报告编号查询碳报告")
                .inputType(ReportQuery.class)
                .build();
    }

    public ToolCallback custom() {
        return new ToolCallback() {
            @Override
            public ToolDefinition getToolDefinition() {
                return ToolDefinition.builder()
                        .name("queryCarbonReport")
                        .description("按报告编号查询碳报告")
                        .inputSchema("""
                                {"type":"object",
                                 "properties":{"reportNo":{"type":"string"}},
                                 "required":["reportNo"]}""")
                        .build();
            }

            @Override
            public String call(String toolInput) {
                return "{\"reportNo\":\"PCF-2026-001\",\"total\":1234.5}";
            }
        };
    }

    public record ReportQuery(String reportNo) {}
}
```

##### LangChain4j 实现

```java
package com.carbon.guard.tool;

import dev.langchain4j.agent.tool.P;
import dev.langchain4j.agent.tool.Tool;
import dev.langchain4j.service.AiServices;
import org.springframework.stereotype.Service;

/**
 * LangChain4j 没有 ToolCallback 这个概念，对应物是：
 *  - @Tool 注解方法 -> 框架内部生成 ToolSpecification（name/description/参数 schema）
 *  - AiServices 启动时把 ToolSpecification 随请求发给模型
 *  - 模型返回工具名+参数 -> 框架反射调用 -> 结果回灌
 */
@Service
public class CarbonToolService {

    private final CarbonAssistant assistant;

    public CarbonToolService(ChatLanguageModel model) {
        this.assistant = AiServices.builder(CarbonAssistant.class)
                .chatModel(model)
                .tools(new ReportTools())
                .build();
    }

    public String chat(String question) {
        return assistant.chat(question);
    }

    static class ReportTools {
        @Tool("按报告编号查询碳报告")
        String queryCarbonReport(@P("报告编号") String reportNo) {
            return "{\"reportNo\":\"" + reportNo + "\",\"total\":1234.5}";
        }
    }

    interface CarbonAssistant {
        @dev.langchain4j.service.UserMessage("{{it}}")
        String chat(String message);
    }
}
```

#### 追问：
- 追问1：Spring AI 基于泛型类型推断生成 JSON Schema，若 FactorRequest 含嵌套对象或泛型集合，Schema 生成是否会失真导致模型传参错误？
  - **答**：会。复杂泛型/嵌套在类型擦除下易失真（如 `List<T>`、`Map`）。
    - 建议：
      - ① 工具入参用具体 POJO 而非裸泛型
      - ② 用 `@JsonProperty`/描述明确字段
      - ③ 对复杂结构做单测验证生成 Schema
      - ④ 必要时手动提供 JSON Schema 覆盖自动推断
- 追问2：碳管家双框架下"Spring AI 管 Tool 调度、LangChain4j 管 RAG"，两套工具定义重复维护，版本不一致时以哪边为准？
  - **答**：需定单一真相源。
    - 建议以 Spring AI 的 Tool 定义为对外执行入口，LangChain4j 侧重 RAG 检索而非重复定义工具；
    - 若两边都要，抽公共"工具契约"模块共享 Schema，版本统一管理，CI 校验一致性避免漂移。

### 36. Spring AI的对话记忆（ChatMemory）持久化
**重要度**：★★★★

**题目：碳管家AI助手的对话需要跨会话持久化（用户昨天问的排放因子今天还能引用），Spring AI的ChatMemory如何持久化到数据库？**

ChatMemory管理对话历史，使LLM能理解上下文引用（如"刚才那个数据"），持久化确保跨会话记忆不丢失。

Spring AI ChatMemory架构：
- `ChatMemory`接口：存储和检索对话历史消息
- `MessageChatMemoryAdvisor`：在请求前注入历史消息，在响应后保存新消息
- 支持窗口模式（最近N轮）和完整模式
- **2.0 起 conversationId 是强制项**：`MessageChatMemoryAdvisor` 每次调用都必须通过 advisor context 传入 `ChatMemory.CONVERSATION_ID`，缺失会直接抛 `IllegalArgumentException`；1.x 里的 `ChatMemory.DEFAULT_CONVERSATION_ID`（值就是字符串 `"default"`）与 advisor 的 `.conversationId(...)` builder 方法均已移除。**这不只是 API 变更，而是安全修复**——1.x 漏传会话 ID 时所有租户的对话会落进同一个 `"default"` 桶，多租户下存在串号越权读取风险（详见[第 56 题](/04-spring-ai.html#q-4-56)）

持久化实现方案：

**方案1：Redis持久化**（推荐，高性能）：
- ⚠️ **版本注意**：Spring AI **1.x 并没有内置 `RedisChatMemory` 这个类**，要落 Redis 得自己实现 `ChatMemoryRepository`（1.0 起的名字，0.x 时代叫 `ChatMemoryStore`，包里已没有这个名字）——面试时说"直接用 RedisChatMemory"会露怯
- **2.0 起官方补上了**：新增 `spring-ai-autoconfigure-model-chat-memory-repository-redis`（Redis 团队参与维护），配置前缀也从 `spring.ai.chat.memory.redis.*` 改为 `spring.ai.chat.memory.repository.redis.*`，自带 starter 与 HNSW/文本检索调优
- 自研时的 Key设计：`chat:memory:{sessionId}`，Value为JSON序列化的消息列表；TTL设置：7天（覆盖碳管理咨询的典型会话周期）
- 优势：读写毫秒级，适合高并发

**方案2：MySQL持久化**（持久可靠）：
- 2.0 官方 `JdbcChatMemoryRepository` 的表 `SPRING_AI_CHAT_MEMORY` 新增 `sequence_id BIGINT` 列与 `(conversation_id, sequence_id)` 索引。原因：旧版靠 `timestamp` 排序，而 MySQL/MariaDB 的 timestamp 默认精度只有**秒**，同一秒写入的消息返回顺序不确定；新增整型序号后跨库排序才一致。**1.x 建的旧表必须先加列并回填**，否则读出的顺序是乱的
- 表设计：`SPRING_AI_CHAT_MEMORY(conversation_id, sequence_id, role, content, timestamp)`（自研表则另起表名，不要与官方表混淆）
- 优势：数据不丢失，可做复杂查询和审计
- 碳管家场景：对话历史是审核日志的一部分，MySQL便于合规审计

**方案3：Milvus向量记忆**（语义检索）：
- 将对话摘要向量化存入Milvus，新会话时检索历史相似对话
- 优势：不局限于同一sessionId，可跨用户跨会话检索相关经验
- 碳管家场景：新客户咨询钢铁行业碳管理时，可检索历史客户相似咨询记录

配置：
```java
@Bean
ChatMemory chatMemory(ChatMemoryRepository repository) {
    // 内置实现 + 自研 Repository：窗口策略负责裁剪，Repository 负责持久化
    // 注意：Spring AI 1.x 未内置 Redis 实现，这个 Repository 需自行实现
    return MessageWindowChatMemory.builder()
        .chatMemoryRepository(repository)
        .maxMessages(20)
        .build();
}
@Bean
Advisor chatMemoryAdvisor(ChatMemory chatMemory) {
    // 窗口裁剪已在 ChatMemory 上配好，Advisor 侧没有 maxMessages()
    // 2.0 里 ChatClient 会自动装配该 Advisor，若再手动注册要注意避免重复写入
    return MessageChatMemoryAdvisor.builder(chatMemory).build();
}
```

#### 追问：
- 追问1：Redis 方案设 7 天 TTL，但碳管理咨询可能跨月，TTL 到期后用户回溯"上月那个因子"会失忆，是否应改为按需归档到 MySQL 而非简单过期？
  - **答**：应归档而非硬过期。
    - 策略：TTL 到期前/后把冷会话摘要与关键结论异步归档到 MySQL（审计可达），热会话续期；
    - 回溯时先查 Redis，未命中再查 MySQL 归档，必要时恢复上下文，兼顾性能与合规长期可追溯。
- 追问2：Milvus 向量记忆跨会话检索历史相似对话，但若检索到错误/已纠正的旧回答并注入上下文，会不会把错误答案"传染"给新客户？
  - **答**：会。防护：
    - ① 向量记忆只检索"已验证/高赞"的历史回答，排除被纠错样本（带 `corrected=true` 标记过滤）
    - ② 注入时标注"历史参考"并提示可能过时
    - ③ 新回答仍走工具/检索校验不盲信记忆
    - ④ 定期清洗低质量记忆
- 追问3：MessageChatMemoryAdvisor 注入历史消息会占用上下文窗口，长会话下历史优先级与摘要策略如何与 RAG 检索结果抢有限的 Token 预算？
  - **答**：统一预算分配：给记忆、RAG、Prompt 各自设 Token 配额（如 RAG 优先保证据，记忆只留最近N轮+摘要），超出按优先级裁剪。
    - 长会话用"滑动窗口+摘要"压缩记忆；
    - RAG 结果与记忆冲突时以 RAG 检索证据为准。

### 37. Spring AI的评测（Evaluation）机制
**重要度**：★★★

**题目：如何用Spring AI的Evaluation机制评估碳管家AI助手的回答质量？请说明评测流程和指标设计。**

先说结论：**Spring AI 2.0 没有内置评测框架**，官方口径是"评测请用外部工具（RAGAS、DeepEval 等）或自建 LLM-as-Judge 流水线"。1.x 曾提供过一套 Evaluator（`RelevancyEvaluator`、`FactCheckingEvaluator` 等），但在 1.0 就已标记 `@Deprecated`，2.0 未延续，面试时不要把废弃能力当现役能力讲。

历史知识（1.x，已 deprecated，不推荐用于新项目）：
- `EvaluationResponse`（不是 `EvaluationResult`）：评测结果封装，字段是 `pass`/`score`/`feedback`——很多资料写成 `EvaluationResult`，是错的
- 基于 LLM 的评测：用另一个 LLM（"评判模型"）对生成答案评分
- 评测维度：正确性、完整性、相关性、格式规范性

评测流程设计：
1. 构建评测集：50-100组碳管理问答（问题+参考答案+评分标准）
2. 自动化评测脚本：
   - 对每个问题调用碳管家AI生成答案
   - 调用评判模型对比生成答案与参考答案
   - 评判Prompt：`请评估以下AI回答与参考答案的一致性...评分1-5分`
3. 汇总评测指标：平均分数、各维度分数、低分案例分析

碳管家评测指标体系：
- **数值准确性**（最关键）：排放因子数值是否与参考值一致（允许±5%误差）
- **法规引用准确性**：引用的ISO标准编号和条款是否正确
- **计算逻辑完整性**：LCA计算步骤是否完整无遗漏
- **来源可追溯性**：答案是否标注信息来源（文档ID/章节号）
- **时效性**：引用的数据是否为最新版本

自动化实现：
- 评测框架用外部方案：RAGAS（Python，原生 faithfulness / answer relevancy / context precision 等指标）、DeepEval（pytest 风格的 LLM 单测），或自研 LLM-as-Judge + 规则校验流水线
- Spring Batch编排评测Pipeline
- 每周自动评测+生成报告
- 评测结果推送至Nacos配置中心，低分维度自动调整对应Advisor参数

---

---

#### 追问：
- 追问1：用"另一个 LLM 当评判模型"评碳管家答案，评判模型本身也可能算错排放因子，如何保证评测分数的可信度，是否需规则校验兜底？
  - **答**：需规则兜底。评判 LLM 只评"格式/相关性/完整性"，数值正确性交给规则校验（对比因子库真值、允许误差区间）。
    - 二者结合：规则判数值、LLM 判语义；
    - 评判模型也用强模型并交叉验证，避免单点误判。
- 追问2：你定的"数值准确性允许±5%误差"对 LCA 计算可能过宽（关键因子偏差 5% 结论就变），不同指标阈值如何分级设定？
  - **答**：分级：
    - ① 关键因子/边界值用严阈值（如 ±1% 或精确匹配）
    - ② 一般描述性指标可放宽（±5%）
    - ③ 按指标敏感度和业务影响定级，写入评测配置
    - ④ 对"是否改变结论"做判定而非仅看绝对差，阈值随场景可调
- 追问3：评测结果推送 Nacos 自动调整 Advisor 参数属于"自动调参"，若调参后质量反而下降，是否有灰度与回滚机制防止全局劣化？
  - **答**：必须有。机制：
    - ① 参数变更走版本化 + 灰度（小流量客户先试）
    - ② 自动对比调参前后评测分，下降则自动回滚上一版本
    - ③ 设人工审批闸口对重大调整
    - ④ 所有 Advisor 参数变更可一键回退，避免全局劣化


#### Spring AI 基础用法

### 38. Spring AI 的 ChatClient Fluent API 怎么用？
**重要度**：★★★★★
`ChatClient` 是最推荐的对话入口，链式构建请求：
```java
ChatClient client = ChatClient.create(chatModel);
ChatResponse resp = client.prompt()
    .system("你是碳管理领域专家")
    .user(u -> u.text("请解释 {term}").param("term", "CBAM"))
    .call()
    .chatResponse();
String text = resp.getResult().getOutput().getText();
```
- `.call()` 返回的是 `CallResponseSpec`（规格对象，不是结果）；要拿结果需再调 `.chatResponse()` 或 `.content()`。`.stream()` 返回 `Flux<ChatResponse>` 用于流式。
- `.entity(MyPoJO.class)` 可直接把回答反序列化为 Java 对象。
- 不同业务用 `client.mutate().defaultSystem(...).build()` 派生子客户端，复用配置而不重复编码。


#### 三种框架实现对比

##### Spring AI 1.0 实现

```java
package com.carbon.guard.client;

import org.springframework.ai.chat.client.ChatClient;
import org.springframework.ai.chat.client.advisor.QuestionAnswerAdvisor;
import org.springframework.ai.vectorstore.SearchRequest;
import org.springframework.stereotype.Service;

import java.util.List;

/**
 * ChatClient 是 1.0 的门面：prompt() -> user/system -> call/stream -> content
 */
@Service
public class CarbonChatService {

    private final ChatClient chatClient;

    public CarbonChatService(ChatClient.Builder builder) {
        this.chatClient = builder.build();
    }

    /** 基本调用 */
    public String ask(String question) {
        return chatClient.prompt()
                .system("你是碳管理专家，仅依据给定资料回答，资料不足要明确说明。")
                .user(question)
                .call()
                .content();
    }

    /** 带元数据与多消息 */
    public String askWithContext(String question, List<String> contexts) {
        String ctx = String.join("\n\n", contexts);
        return chatClient.prompt()
                .system("你是碳管理专家。")
                .user(u -> u.text("参考资料：\n{ctx}\n\n问题：{q}")
                        .param("ctx", ctx)
                        .param("q", question))
                .call()
                .content();
    }

    /** 流式 */
    public org.springframework.web.servlet.mvc.method.annotation.SseEmitter stream(String question) {
        SseEmitter emitter = new SseEmitter(60_000L);
        chatClient.prompt()
                .user(question)
                .stream()
                .content()
                .subscribe(token -> {
                    try { emitter.send(SseEmitter.event().data(token)); }
                    catch (Exception e) { emitter.completeWithError(e); }
                }, emitter::completeWithError, emitter::complete);
        return emitter;
    }

    /** 带检索参数 */
    public String askWithSearch(String question) {
        return chatClient.prompt()
                .user(question)
                .call()
                .chatResponse()
                .getResult()
                .getOutput()
                .getText();
    }
}
```

##### Spring AI 2.0 实现

```java
package com.carbon.guard.client;

import org.springframework.ai.chat.client.ChatClient;
import org.springframework.ai.openai.OpenAiChatOptions;
import org.springframework.stereotype.Service;

/**
 * 2.0 变化：
 * 1) Options 一律用 builder 构造后传入（不可变），不要复用/就地修改已有实例
 * 2) 工具必须显式注册 ToolCallback Bean
 * 3) ToolCallingAdvisor 由 ChatClient 自动注册
 */
@Service
public class CarbonChatService {

    private final ChatClient chatClient;

    public CarbonChatService(ChatClient.Builder builder) {
        this.chatClient = builder.build();
    }

    public String ask(String question) {
        return chatClient.prompt()
                .system("你是碳管理专家，仅依据给定资料回答，资料不足要明确说明。")
                .options(OpenAiChatOptions.builder()
                        .temperature(0.3)
                        .topP(0.9)
                        .build())
                .user(question)
                .call()
                .content();
    }

    public String askWithContext(String question, String ctx) {
        return chatClient.prompt()
                .system("你是碳管理专家。")
                .user(u -> u.text("参考资料：\n{ctx}\n\n问题：{q}")
                        .param("ctx", ctx)
                        .param("q", question))
                .call()
                .content();
    }

    public org.springframework.web.servlet.mvc.method.annotation.SseEmitter stream(String question) {
        SseEmitter emitter = new org.springframework.web.servlet.mvc.method.annotation.SseEmitter(60_000L);
        chatClient.prompt()
                .user(question)
                .stream()
                .content()
                .subscribe(token -> {
                    try { emitter.send(org.springframework.web.servlet.mvc.method.annotation.SseEmitter.event().data(token)); }
                    catch (Exception e) { emitter.completeWithError(e); }
                }, emitter::completeWithError, emitter::complete);
        return emitter;
    }
}
```

##### LangChain4j 实现

```java
package com.carbon.guard.client;

import dev.langchain4j.service.AiServices;
import dev.langchain4j.service.SystemMessage;
import dev.langchain4j.service.UserMessage;
import dev.langchain4j.service.V;
import dev.langchain4j.model.chat.ChatLanguageModel;
import org.springframework.stereotype.Service;

/**
 * LangChain4j 的对位能力：ChatClient 流式 API == AiServices + StreamingChatLanguageModel
 * ChatClient 的 .user(u -> u.text(...).param(...)) == @UserMessage("...{{it}}") + @V
 */
@Service
public class CarbonChatService {

    private final CarbonAssistant assistant;

    public CarbonChatService(ChatLanguageModel model) {
        this.assistant = AiServices.builder(CarbonAssistant.class)
                .chatModel(model)
                .build();
    }

    public String ask(String question) {
        return assistant.chat(question);
    }

    public String askWithContext(String question, String ctx) {
        return assistant.chat(question, ctx);
    }

    interface CarbonAssistant {
        @SystemMessage("你是碳管理专家，仅依据给定资料回答，资料不足要明确说明。")
        @UserMessage("参考资料：\n{{context}}\n\n问题：{{it}}")
        String chat(@V("context") String context, String it);
    }
}
```

#### 追问：
- 追问1：碳管家高并发场景下，ChatClient 应该每次 new 还是全局单例？call() 线程安全吗？
  - **答**：ChatClient 应设计为全局单例/复用，call() 是线程安全的，不应每次请求都 new。
    - 单例依据：`ChatClient` 与内部 `ChatModel` 均为无状态或线程安全封装，注册为 Spring 单例 Bean 即可；每次 new 反而浪费配置解析与连接池建立开销。
    - 线程安全：`call()/stream()` 只读取请求上下文、不修改共享可变状态，可安全被多线程并发调用；真实并发控制在底层 HTTP 连接池（如 WebClient 的 Reactor Netty 池）与限流层。
    - 碳管家实践：高并发下配合 Resilience4j 限流/熔断 + Redis 控制 QPS，避免打满通义千问上游；需要不同角色（系统/审核/摘要）时用 `mutate().build()` 派生子客户端复用底层连接。
- 追问2：`.user(u -> u.text(template).param(...))` 和直接 `new PromptTemplate` 两种写法，什么场景该选哪个？
  - **答**：优先用 Fluent 的 `.user(u -> ...)`，仅在需把模板抽成可复用资源或做复杂渲染时才显式 `PromptTemplate`。
    - Fluent 写法：模板变量与调用点就近，可读性好，适合绝大多数业务问答（如 CBAM 解释、因子查询），减少样板代码。
    - `PromptTemplate`：适合把提示词模板外置（如从 DB/配置文件加载多套模板），或需在多个 Advisor、非 ChatClient 路径（如直接构造 `Prompt` 做批量预生成）复用。
    - 选型要点：两者最终都渲染成 `Message`，性能差异可忽略；重点是"模板是否需在多处/动态加载"。

### 39. SystemMessage / UserMessage / AssistantMessage 怎么直接构造？和 PromptTemplate 的关系？
**重要度**：★★★★
除 Fluent API 外，也可显式构造 `Message` 对象再传入 `ChatModel`：
```java
Message sys = new SystemMessage("你是碳管理专家");
Message user = new UserMessage("什么是CBAM？");
ChatResponse r = chatModel.call(new Prompt(List.of(sys, user)));
```
- `Prompt` 是 `Message` 列表的容器；`UserMessage` 还可携带 `Media`（图片/音频）做多模态。
- `PromptTemplate` 本质是"把变量渲染成 String 再包成 Message"的便捷层；需要精细控制角色/多轮历史时用显式 `Message` 更灵活。

#### 追问：
- 追问1：多轮对话时 AssistantMessage 从哪里来？需要自己把模型上一轮输出包成 AssistantMessage 再塞回 Prompt 吗？
  - **答**：不需要手工包——交给 `ChatMemory` 自动维护，`ChatMemoryAdvisor` 会把上一轮 `AssistantMessage` 写入并读回。
    - 机制：ChatClient 上挂 `MessageChatMemoryAdvisor.builder(memory).build()`，调用处用 `.advisors(a -> a.param(ChatMemory.CONVERSATION_ID, cid))` 传会话 ID（2.0 起 conversationId 必须走 advisor context，顾问构造上没有这个参数），每轮调用前 Advisor 从记忆加载历史（含上次 Assistant 输出），调用后把本轮 User/Assistant 写入记忆；窗口大小配在 `MessageWindowChatMemory.builder().maxMessages(n)` 上，不属于 Advisor。
    - 手工场景：若不用 Advisor，则需在代码里把 `response.getResult().getOutput()` 包成 `AssistantMessage` 追加进 `List<Message>`，否则模型无上下文。
    - 碳管家做法：通过 `conversationId` 隔离租户/用户会话，记忆后端用 Redis，避免每次把完整历史塞进单次请求。
- 追问2：为什么不建议把所有内容都塞进一个 UserMessage，而是拆 System/User？
  - **答**：拆 System/User 是为让模型区分"恒定指令"与"本次输入"，提升遵循度与可维护性。
    - 角色区分：System 承载身份/合规约束（"你是碳管理专家，回答需引用因子来源"），模型对其遵循度最高；User 只放用户问题，避免指令被海量上下文稀释。
    - 复用与治理：System 用 `defaultSystem` 全局固定，便于统一审核口径、切换语气；变更业务 prompt 不动用户请求。
    - 碳管家实践：System 放"必须标注数据来源/不确定时说不知道"，User 放检索到的法规片段+问题，降低幻觉与越权回答。

### 40. Spring AI 的 ETL Pipeline 完整链路是怎样的？
**重要度**：★★★
`ETL Pipeline` 是知识库构建的标准三段式：`DocumentReader` 读 → `DocumentTransformer` 转 → `DocumentWriter` 写。
```java
// Spring AI 没有 EtlPipeline，三段是独立组件，手工串起来即可
Resource resource = new ClassPathResource("iso14064.pdf");
List<Document> docs = new PagePdfDocumentReader(resource).get();        // 1) Reader
docs = TokenTextSplitter.builder().withChunkSize(512).withMinChunkSizeChars(64).build().apply(docs); // 2) Transformer
DocumentWriter writer = vectorStore;                                    // VectorStore 本身实现了 DocumentWriter
writer.accept(docs);                                                    // 3) Writer：向量化后入库
```
- Reader 产出 `List<Document>`；Transformer 做切分/清洗/元数据增强；Writer 把 Document 向量化后写入 `VectorStore`。

#### 追问：
- 追问1：如果一份 PDF 既想按章节切又想在每块打上"来源文件名+页码"元数据，Transformer 链怎么串？
  - **答**：用按章节的 Reader 切分后，串一个自定义 `DocumentTransformer` 注入元数据。
    - 切分：`PagePdfDocumentReader` 按页读、`TokenTextSplitter` 或按标题的 `MarkdownDocumentReader` 控制粒度，每块控制在如 256–512 token 便于向量化。
    - 元数据注入：自定义 `DocumentTransformer` 遍历 `List<Document>`，对每块 `doc.getMetadata().put("source", fileName)` 与 `put("page", pageNo)`，页号可由上游 Reader 的 metadata 透传。
    - 碳管家落地：法规 PDF 入库时统一打 `source/standard/category` 元数据，检索阶段即可用 `filterExpression` 按标准（如 GHG/CBAM）过滤。
- 追问2：ETL 跑失败（如某页解析报错）是整批回滚还是跳过单文档？生产环境怎么做断点续跑？
  - **答**：应是"单文档容错跳过 + 记录失败"，而非整批回滚，并结合去重实现断点续跑。
    - 容错：Transformer/Reader 里 try-catch 单页异常，把失败项（文件名+页码+异常）写入"失败表"，整批继续，避免一份坏 PDF 拖垮全量入库。
    - 断点续跑：以"文件指纹 + 已处理页号"为进度键存 Redis/DB，重启后跳过已完成项；入库时用 Document id（内容哈希）幂等，重复跑不会重复写。
    - 碳管家实践：法规库更新走 RabbitMQ 异步任务，失败页进死信队列人工复核，保证知识库最终一致。

### 41. 常用 DocumentReader 怎么选型？
**重要度**：★★★★
Spring AI 提供多种 `DocumentReader` 适配不同格式：
- `PagePdfDocumentReader`：基于 PDFBox，按页产出，适合法规 PDF，可提取页码。
- `TikaDocumentReader`：基于 Apache Tika，几乎通吃 docx/xlsx/ppt/pdf/html/txt，但粒度较粗。
- `MarkdownDocumentReader`：按 Markdown 标题层级切分，保留结构。
- `JsonReader` / `TextReader`：结构化或纯文本。

#### 追问：
- 追问1：碳法规很多是扫描版 PDF（图片无文字层），PagePdfDocumentReader 读出来是空，怎么处理？
  - **答**：先用 OCR 把扫描页转成文本层，再走常规 Reader 入库。
    - 方案：对无文字层 PDF 调用 OCR（如 PaddleOCR/Tesseract，或阿里云 OCR）识别文字与坐标，重排成文本/Markdown 后再用 `TextReader`/`MarkdownDocumentReader` 接 ETL。
    - 元数据：OCR 阶段保留页码与疑似表格区域标记，便于检索结果回链到原图位置。
    - 碳管家落地：扫描法规入库前先走 OCR 预处理服务（可由 RabbitMQ 触发），解析失败/清晰度过低的页进人工复核队列。
- 追问2：TikaReader 和 PagePdfDocumentReader 产出的 Document 在"页码元数据"上有差异，下游切分怎么统一？
  - **答**：在 ETL 的 Transformer 阶段做"元数据归一化"，统一补 `page` 字段，下游只读归一化后的结构。
    - 差异：`PagePdfDocumentReader` 天然带 `page`；`TikaDocumentReader` 粒度粗、常无页码，需在切分时按分隔符/长度估算或回填。
    - 归一化：写一个 `MetadataNormalizeTransformer`，没有 `page` 的默认 `page=1` 或按块序号生成虚拟页码，并统一 `source` 命名规范（文件名无路径）。
    - 碳管家实践：所有 Reader 输出经同一标准化 Transformer，检索结果展示"来源文件+页码"时格式一致，前端定位可靠。

### 42. VectorStore 的 similaritySearch 高级参数怎么用？
**重要度**：★★★★
`similaritySearch` 不只传 TopK，还支持过滤与阈值：
```java
List<Document> docs = vectorStore.similaritySearch(
    SearchRequest.builder().query("CBAM 范围三")
        .topK(5)
        .similarityThreshold(0.75)
        .filterExpression("category == 'GHG'")
        .build());
```
- `similarityThreshold` 过滤低分噪声；`filterExpression` 按元数据（行业/标准/租户）收窄召回，是做多租户隔离的关键。


#### 三种框架实现对比

##### Spring AI 1.0 实现

```java
package com.carbon.guard.vector;

import org.springframework.ai.document.Document;
import org.springframework.ai.vectorstore.SearchRequest;
import org.springframework.ai.vectorstore.VectorStore;
import org.springframework.stereotype.Service;

import java.util.List;

/**
 * 1.0 的 SearchRequest 是 record，必须走 builder：
 *   query / topK / similarityThreshold / filterExpression
 */
@Service
public class CarbonVectorSearchService {

    private final VectorStore vectorStore;

    public CarbonVectorSearchService(VectorStore vectorStore) {
        this.vectorStore = vectorStore;
    }

    /** 基础检索：topK + 相似度阈值 */
    public List<Document> search(String query) {
        SearchRequest request = SearchRequest.builder()
                .query(query)
                .topK(5)
                .similarityThreshold(0.75)   // 低于此相似度直接丢弃
                .build();
        return vectorStore.similaritySearch(request);
    }

    /** 带元数据过滤：把过滤条件下推给向量库，避免全量召回后再过滤 */
    public List<Document> searchByDocType(String query, String docType) {
        SearchRequest request = SearchRequest.builder()
                .query(query)
                .topK(8)
                .similarityThreshold(0.6)
                .filterExpression("docType == '%s'".formatted(docType))
                .build();
        return vectorStore.similaritySearch(request);
    }

    /** 多条件过滤 + 提高 topK 后在应用层重排 */
    public List<Document> searchAndRerank(String query) {
        SearchRequest request = SearchRequest.builder()
                .query(query)
                .topK(20)                    // 粗召 20 条
                .similarityThreshold(0.5)
                .filterExpression("docType == 'STANDARD' && status == 'ACTIVE'")
                .build();
        return vectorStore.similaritySearch(request).stream()
                .sorted((a, b) -> Double.compare(
                        b.getScore() == null ? 0 : b.getScore(),
                        a.getScore() == null ? 0 : a.getScore()))
                .limit(5)
                .toList();
    }
}
```

##### Spring AI 2.0 实现

```java
package com.carbon.guard.vector;

import org.springframework.ai.document.Document;
import org.springframework.ai.vectorstore.SearchRequest;
import org.springframework.ai.vectorstore.VectorStore;
import org.springframework.stereotype.Service;

import java.util.List;

/**
 * 2.0 的 VectorStore 检索 API 与 1.0 一致（SearchRequest 仍是 record + builder），
 * 主要变化在配置属性：spring.ai.openai.embedding.model（去掉了 .options 段）
 */
@Service
public class CarbonVectorSearchService {

    private final VectorStore vectorStore;

    public CarbonVectorSearchService(VectorStore vectorStore) {
        this.vectorStore = vectorStore;
    }

    public List<Document> search(String query) {
        SearchRequest request = SearchRequest.builder()
                .query(query)
                .topK(5)
                .similarityThreshold(0.75)
                .build();
        return vectorStore.similaritySearch(request);
    }

    public List<Document> searchByDocType(String query, String docType) {
        SearchRequest request = SearchRequest.builder()
                .query(query)
                .topK(8)
                .similarityThreshold(0.6)
                .filterExpression("docType == '%s'".formatted(docType))
                .build();
        return vectorStore.similaritySearch(request);
    }

    public List<Document> searchAndRerank(String query) {
        SearchRequest request = SearchRequest.builder()
                .query(query)
                .topK(20)
                .similarityThreshold(0.5)
                .filterExpression("docType == 'STANDARD' && status == 'ACTIVE'")
                .build();
        return vectorStore.similaritySearch(request).stream()
                .sorted((a, b) -> Double.compare(
                        b.getScore() == null ? 0 : b.getScore(),
                        a.getScore() == null ? 0 : a.getScore()))
                .limit(5)
                .toList();
    }
}
```

##### LangChain4j 实现

```java
package com.carbon.guard.vector;

import dev.langchain4j.data.embedding.Embedding;
import dev.langchain4j.data.segment.TextSegment;
import dev.langchain4j.model.embedding.EmbeddingModel;
import dev.langchain4j.store.embedding.EmbeddingStore;
import dev.langchain4j.store.embedding.EmbeddingSearchRequest;
import dev.langchain4j.store.embedding.EmbeddingStoreIngestor;
import dev.langchain4j.store.embedding.filter.MetadataFilterBuilder;
import org.springframework.stereotype.Service;

import java.util.List;

/**
 * LangChain4j 的对位能力：
 *  VectorStore.similaritySearch(SearchRequest) == EmbeddingStore.search(EmbeddingSearchRequest)
 *  过滤表达式 == MetadataFilterBuilder
 */
@Service
public class CarbonVectorSearchService {

    private final EmbeddingStore<TextSegment> store;
    private final EmbeddingModel embeddingModel;

    public CarbonVectorSearchService(EmbeddingStore<TextSegment> store,
                                     EmbeddingModel embeddingModel) {
        this.store = store;
        this.embeddingModel = embeddingModel;
    }

    /** 灌库 */
    public void ingest(List<TextSegment> segments) {
        EmbeddingStoreIngestor.builder()
                .embeddingModel(embeddingModel)
                .build()
                .ingest(segments);
    }

    /** 基础检索：topK + 相似度阈值 */
    public List<TextSegment> search(String query) {
        Embedding queryEmbedding = embeddingModel.embed(query).content();
        EmbeddingSearchRequest request = EmbeddingSearchRequest.builder()
                .queryEmbedding(queryEmbedding)
                .maxResults(5)                 // topK
                .minScore(0.75)                // 相似度阈值
                .build();
        return store.search(request).matches().stream()
                .map(m -> m.embedded())
                .toList();
    }

    /** 带元数据过滤 */
    public List<TextSegment> searchByDocType(String query, String docType) {
        Embedding queryEmbedding = embeddingModel.embed(query).content();
        EmbeddingSearchRequest request = EmbeddingSearchRequest.builder()
                .queryEmbedding(queryEmbedding)
                .maxResults(8)
                .minScore(0.6)
                .filter(MetadataFilterBuilder.metadataKey("docType").isEqualTo(docType))
                .build();
        return store.search(request).matches().stream()
                .map(m -> m.embedded())
                .toList();
    }
}
```

#### 追问：
- 追问1：similarityThreshold 设 0.75 还是 0.6？阈值过高会不会把"表述不同但相关"的法规漏掉？
  - **答**：阈值没有银弹，碳管家默认取区间中值（如 0.6–0.7）并配合召回后再重排，避免一刀切漏召回。
    - 权衡：阈值过高（如 0.8）精确但易漏"同义异述"法规；过低（如 0.5）召回杂、噪声多、易幻觉，需结合 `topK` 与业务容忍度。
    - 实践：先 `topK=5~8` 宽松召回，再用 rerank 模型（或规则：命中关键词+分数）二次筛选；阈值仅作粗筛下限（如 0.55 以下直接丢弃）。
    - 碳管家做法：法规问答对幻觉零容忍，故用偏低阈值保召回 + rerank 提精度，并在无足够命中时显式回答"未检索到相关依据"。
- 追问2：filterExpression 在 Milvus 后端是怎么落地的？多租户是用 filter 还是独立 collection？
  - **答**：`filterExpression` 在 Milvus 会编译为标量字段的布尔过滤表达式（where 子句），多租户推荐"共享 collection + 租户 filter"，海量租户再考虑按租户分 collection。
    - Milvus 落地：表达式映射到 collection 的标量字段（如 `tenant_id`），检索时向量 ANN 与标量过滤一起执行，过滤在向量检索阶段完成而非事后。
    - 多租户选型：中小规模用 `tenant_id` filter 隔离，省资源、好维护；超大客户/数据隔离合规要求高时，再开独立 collection 或 partition。
    - 碳管家实践：用 `tenant_id` + `category` 复合 filter 做隔离，避免为每个租户建 collection 带来的元数据爆炸。

### 43. VectorStore 抽象的 add / similaritySearch / delete 怎么注入使用？
**重要度**：★★★★
`VectorStore` 是统一抽象，业务代码只依赖接口：
```java
@Autowired VectorStore vectorStore; // MilvusVectorStore / PgVectorStore 实现
vectorStore.add(List.of(doc));
vectorStore.similaritySearch(SearchRequest.builder().query(q).topK(5).build());
vectorStore.delete(List.of("doc-id-1"));
```
- 切换向量库只需换 Starter 依赖与配置，业务代码零改动；`delete` 按 Document id 维度维护知识库生命周期。

#### 追问：
- 追问1：add 时 Document id 怎么定？用内容哈希还是业务主键？重复 add 会怎么样？
  - **答**：用"内容哈希（如 SHA-256 切块文本）"作为 Document id，重复 add 在 Milvus 表现为覆盖/幂等更新而非重复记录。
    - 选型：内容哈希保证"同一段文本重复入库"幂等，避免重复向量；若需版本追踪，可在哈希前缀加 `source+page` 业务主键。
    - 行为：Milvus 以主键 upsert，相同 id 再次 add 会覆盖向量与元数据；不同 id 同内容则产生重复，故哈希去重很重要。
    - 碳管家落地：法规更新时重新算哈希，仅 diff 变化的块写库，删除旧块用 `delete(List.of(id))` 维护生命周期。
- 追问2：批量 add 几万块时，是分批提交还是一次性 add？Milvus 的 batch 大小怎么调？
  - **答**：必须分批提交，单批控制在合理大小（如每批 500–1000 条），避免单次请求超时与内存压力。
    - 分批：几万块一次性 add 会撑爆请求体/超时；按批循环提交并在批间短暂 yield，配合进度落库做断点续跑。
    - batch 调优：Milvus `insert` 批大小受 `batch_size` 与客户端内存约束，实测调优（如 500–2000 视向量维度），并开 `enable_dynamic_field` 方便元数据。
    - 碳管家实践：入库任务由 RabbitMQ 拆分多分片并行写，单 worker 内再按批提交，监控写入 QPS 与失败重试。

### 44. 如何自定义 Advisor 实现请求审计 / 敏感词脱敏？
**重要度**：★★★★
Advisor 是 Spring AI 的拦截器链，围绕 `ChatClientRequest` / `ChatClientResponse` 做横切：
```java
// Spring AI 1.0 GA：要实现自定义 Advisor 得实现 CallAdvisor（非流式），
// 签名是 adviseCall(ChatClientRequest, CallAdvisorChain)
public class AuditAdvisor implements CallAdvisor {
  @Override
  public ChatClientResponse adviseCall(ChatClientRequest request, CallAdvisorChain chain) {
    // 请求侧：调用 chain.nextCall 之前
    String userText = request.prompt().getUserMessage().getText();
    log.info("user={}, promptLen={}", userText, userText.length());
    ChatClientResponse response = chain.nextCall(request);   // ← 放行到下一个 Advisor / LLM
    // 响应侧：拿到响应之后
    String out = response.chatResponse().getResult().getOutput().getText();
    log.info("outChars={}", out.length());
    return response;
  }
  @Override
  public int getOrder() { return 0; }
}
```
- 记日志、鉴权、脱敏、限流分别写在 `chain.nextCall(request)` 的**前后**即可；通过 `ChatClient.builder().defaultAdvisors(new AuditAdvisor())` 挂载。


#### 三种框架实现对比

##### Spring AI 1.0 实现

```java
package com.carbon.guard.advisor;

import org.springframework.ai.chat.client.advisor.api.ChatClientRequest;
import org.springframework.ai.chat.client.advisor.api.ChatClientResponse;
import org.springframework.ai.chat.client.advisor.api.CallAdvisor;
import org.springframework.ai.chat.client.advisor.api.CallAdvisorChain;
import org.springframework.stereotype.Component;

/**
 * 1.0 GA：实现 CallAdvisor（非流式），签名 adviseCall(ChatClientRequest, CallAdvisorChain)
 * 旧的 AdvisedRequest/AdvisedResponse/CallAroundAdvisorChain 在 1.0 GA 已不存在
 */
@Component
public class AuditAndMaskAdvisor implements CallAdvisor {

    private static final java.util.regex.Pattern SENSITIVE =
            java.util.regex.Pattern.compile("(?i)(手机号|身份证|统一社会信用代码)[:：]?\\s*\\S+");
    private static final org.slf4j.Logger log =
            org.slf4j.LoggerFactory.getLogger(AuditAndMaskAdvisor.class);

    @Override
    public ChatClientResponse adviseCall(ChatClientRequest request, CallAdvisorChain chain) {
        // ===== 请求侧：脱敏 + 审计 =====
        String userText = request.prompt().getUserMessage().getText();
        String masked = SENSITIVE.matcher(userText).replaceAll("$1:***");
        ChatClientRequest mutated = request.mutate()
                .prompt(request.prompt().augmentUserMessage(masked))
                .build();

        log.info("[audit] userLen={} masked={}", userText.length(), masked.equals(userText) ? "no" : "yes");

        ChatClientResponse response = chain.nextCall(mutated);

        // ===== 响应侧：二次脱敏（防止模型从知识库拼出敏感字段）+ 审计 =====
        String answer = response.chatResponse().getResult().getOutput().getText();
        String cleanAnswer = SENSITIVE.matcher(answer).replaceAll("$1:***");
        log.info("[audit] outChars={} masked={}", answer.length(), cleanAnswer.equals(answer) ? "no" : "yes");

        if (cleanAnswer.equals(answer)) {
            return response;
        }
        return ChatClientResponse.builder()
                .from(response)
                .chatResponse(replaceText(response.chatResponse(), cleanAnswer))
                .build();
    }

    @Override
    public int getOrder() {
        return 0;   // 数值越小越靠前
    }
}
```

##### Spring AI 2.0 实现

```java
package com.carbon.guard.advisor;

import org.springframework.ai.chat.client.advisor.api.ChatClientRequest;
import org.springframework.ai.chat.client.advisor.api.ChatClientResponse;
import org.springframework.ai.chat.client.advisor.api.CallAdvisor;
import org.springframework.ai.chat.client.advisor.api.CallAdvisorChain;
import org.springframework.stereotype.Component;

/**
 * 2.0 变化：
 * 1) CallAdvisor/CallAdvisorChain 签名不变
 * 2) ToolCallingAdvisor 由 ChatClient 自动注册，要关掉用
 *    AdvisorParams.toolCallingAdvisorAutoRegister(false)
 * 3) 工具必须显式注册 ToolCallback Bean
 * 4) 结构化输出有 StructuredOutputValidationAdvisor 自纠正
 */
@Component
public class AuditAndMaskAdvisor implements CallAdvisor {

    private static final java.util.regex.Pattern SENSITIVE =
            java.util.regex.Pattern.compile("(?i)(手机号|身份证|统一社会信用代码)[:：]?\\s*\\S+");
    private static final org.slf4j.Logger log =
            org.slf4j.LoggerFactory.getLogger(AuditAndMaskAdvisor.class);

    @Override
    public ChatClientResponse adviseCall(ChatClientRequest request, CallAdvisorChain chain) {
        String userText = request.prompt().getUserMessage().getText();
        String masked = SENSITIVE.matcher(userText).replaceAll("$1:***");

        ChatClientRequest mutated = request.mutate()
                .prompt(request.prompt().augmentUserMessage(masked))
                .build();

        log.info("[audit] userLen={}", userText.length());

        ChatClientResponse response = chain.nextCall(mutated);

        // 响应侧同样要脱敏：模型可能从知识库拼出敏感字段（追问2 的结论是双端防护）
        String answer = response.chatResponse().getResult().getOutput().getText();
        String cleanAnswer = SENSITIVE.matcher(answer).replaceAll("$1:***");
        log.info("[audit] outChars={} masked={}", answer.length(), cleanAnswer.equals(answer) ? "no" : "yes");

        if (cleanAnswer.equals(answer)) {
            return response;
        }
        // 2.0 改输出不能原地改 ChatResponse，需 from() 复制后重建一个 response
        return ChatClientResponse.builder()
                .from(response)
                .chatResponse(replaceText(response.chatResponse(), cleanAnswer))
                .build();
    }

    @Override
    public int getOrder() {
        return 0;
    }
}
```

##### LangChain4j 实现

```java
package com.carbon.guard.advisor;

import dev.langchain4j.service.AiServices;
import dev.langchain4j.service.UserMessage;
import org.springframework.stereotype.Service;

import java.util.regex.Pattern;

/**
 * LangChain4j 没有 Advisor 链这一层抽象（1.x），横切逻辑通常靠：
 *  - 在 AiServices 的 @SystemMessage / @UserMessage 模板里做，或
 *  - 包装 ChatLanguageModel 做代理，或
 *  - 自己写一层 Service 门面统一做脱敏与审计
 */
@Service
public class CarbonChatGateway {

    private static final Pattern SENSITIVE =
            Pattern.compile("(?i)(手机号|身份证|统一社会信用代码)[:：]?\\s*\\S+");

    private final CarbonAssistant assistant;

    public CarbonChatGateway(ChatLanguageModel model) {
        this.assistant = AiServices.builder(CarbonAssistant.class)
                .chatModel(model)
                .build();
    }

    public String chat(String userInput) {
        String masked = SENSITIVE.matcher(userInput).replaceAll("$1:***");
        log.info("[audit] userLen={} masked={}", userInput.length(), masked.equals(userInput) ? "no" : "yes");
        String answer = assistant.chat(masked);
        String clean = SENSITIVE.matcher(answer).replaceAll("$1:***");
        log.info("[audit] outChars={}", answer.length());
        return clean;
    }

    interface CarbonAssistant {
        @UserMessage("{{it}}")
        String chat(String message);
    }
}
```

#### 追问：
- 追问1：Advisor 链的执行顺序怎么定？我想"先脱敏再调模型再审计输出"，顺序配错会怎样？
  - **答**：顺序由 `defaultAdvisors` 列表顺序或 `order()` 决定，应排为 `脱敏 → (模型调用) → 审计输出`，配错会漏脱敏或审计不到最终内容。
    - 顺序机制：Advisor 是嵌套责任链，`next.apply` 之前是"请求侧"（脱敏、鉴权），之后是"响应侧"（审计、后处理）；请求侧按顺序、响应侧逆序。
    - 配错后果：若审计放在脱敏前，审计日志会记录未脱敏的敏感词；若脱敏在模型调用后，模型已收到明文。
    - 碳管家实践：用 `@Order`/order 值显式编排 `SensitiveMaskAdvisor`(前) → `ModelCallAdvisor` → `AuditAdvisor`(后)，并在测试中断言顺序。
- 追问2：敏感词脱敏放在 Advisor 里，模型返回里若又拼出敏感信息，输出端要不要再脱一次？
  - **答**：要——请求侧与响应侧都应脱敏，形成"双端防护"，因为模型可能从知识库拼出敏感字段。
    - 原因：检索召回的法规/因子内容可能本身含手机号、企业名等 PII，模型原文复述就会泄露，仅请求侧脱敏不够。
    - 实现：在 AuditAdvisor（响应侧）里对 `ChatClientResponse` 的输出文本再做一遍脱敏正则替换，与请求侧共用同一脱敏词表。
    - 碳管家实践：脱敏词表（客户名、联系人等）统一配置，请求/响应两端 Advisor 引用同一份，保证口径一致、可热更新。

### 45. QuestionAnswerAdvisor 与 RetrievalAugmentationAdvisor 有什么区别？
**重要度**：★★★★★
- `QuestionAnswerAdvisor`：最轻量，内部按 query 查 VectorStore，把命中片段拼接到**用户消息末尾**（不改 System Prompt），开箱即用。
- `RetrievalAugmentationAdvisor`：更完整，由 `QueryTransformer` + `QueryRouter` + `RetrievalAugmentor`（含 `DocumentRetriever`/`QueryExpander`/`DocumentJoiner`）编排，支持多路检索、查询改写、结果聚合。
- 简单场景用前者；要路由/改写/多库融合用后者。

#### 追问：
- 追问1：碳管家既有"法规库"又有"因子库"两个 collection，QuestionAnswerAdvisor 一个 advisor 查不了两个吧？怎么改？
  - **答**：对，单 `QuestionAnswerAdvisor` 只能绑一个 VectorStore；多库需多个 Advisor 或一个 `RetrievalAugmentationAdvisor` 多路检索。
    - 多 Advisor：注册两个 QAA（分别绑法规/因子 VectorStore）都挂到 ChatClient，各自把命中片段拼进 Prompt，由模型综合。
    - 多路检索：用 RAA 的 `QueryRouter` 把查询路由到多个 `DocumentRetriever`（每个对应一个 collection），再 `DocumentJoiner` 合并。
    - 碳管家实践：法规问答走多 Advisor 并联召回，因子查询按需走工具（Tool Calling）精准 lookup，避免无关召回污染。
- 追问2：RetrievalAugmentationAdvisor 的 DocumentJoiner 用 Concatenation 还是 Complementary？会不会超 token 上限？
  - **答**：默认 `Concatenation`（简单拼接），多路结果重叠时用 `Complementary`（互补去重）；必须设上限防止超 token。
    - 选型：`Concatenation` 实现简单、保留全部；`Complementary` 去掉各路重复片段，适合多库高度重叠场景，减少冗余。
    - 防超 token：Joiner 后加"截断/预算"逻辑（按 `topK` 与每块长度预算，如控制在如 2k–4k token 上下文），超出按分数丢弃低分块。
    - 碳管家实践：法规+因子多路召回后，按相关性分数统一重排取前 N 块，并预留 token 预算给系统指令与用户问题。

### 46. Tool / Function Calling 怎么声明和触发？
**重要度**：★★★★
声明工具并注册到 ChatClient：
```java
class FactorTool {
    @Tool(description = "查询某产品的碳排放因子")
    public String queryFactor(@ToolParam(description = "产品名称，如 螺纹钢") String product) {
        return factorService.lookup(product);
    }
}

ChatClient client = ChatClient.builder(chatModel)   // create() 返回的是实例，没有 defaultTools/build
        .defaultTools(new FactorTool())
        .build();
```
- 模型在回复中决定调用工具，框架把参数回传你的方法，执行结果再喂回模型生成最终答案。

#### 追问：
- 追问1：工具方法执行超时或抛异常，框架会怎样？会不会把异常原样返回给模型导致幻觉？
  - **答**：框架会把工具结果回传模型，若直接抛异常栈，模型可能把错误当事实编造；必须捕获并回传"友好错误字符串"。
    - 行为：`@Tool` 方法抛异常默认作为工具返回内容传回模型，模型可能基于堆栈"幻觉"出答案。
    - 实践：工具方法内部 try-catch，超时用 `CompletableFuture`+`get(timeout)` 或 Resilience4j 超时，异常时返回结构化错误（如 `{"error":"因子库暂不可用"}`）而非堆栈。
    - 碳管家落地：因子查询工具加熔断，失败时返回"无法获取该因子，请稍后重试"，并提示模型明确告知用户，而非编造数值。
- 追问2：工具返回的因子数据很大，直接塞回 Prompt 会爆 token，怎么裁剪？
  - **答**：在工具方法内做"字段裁剪 + 数量限制 + 摘要"，只回传模型回答问题所需的列与条目。
    - 裁剪：工具返回前只保留关键字段（因子值、单位、来源、年份），剔除内部 id/长描述；列表结果限制返回前 N 条（如 topK=5）。
    - 摘要：数据量大时先聚合（如按年份求均值、按类别汇总），回传聚合结果而非明细。
    - 碳管家实践：因子 lookup 工具默认返回最匹配的 1–3 条及来源，必要时再由模型决定是否追问用户要更细数据。

### 47. 结构化输出（BeanOutputConverter）怎么用？JSON 不合法怎么办？
**重要度**：★★★★
用 `OutputConverter` 把模型 JSON 直接绑到 POJO：
```java
BeanOutputConverter<CarbonReport> conv = new BeanOutputConverter<>(CarbonReport.class);
String fmt = conv.getFormat(); // 注入 System Prompt 的 JSON Schema
CarbonReport r = conv.convert(response.getOutput().getText());
```
- 用 `getFormat()` 把 JSON Schema 写进 Prompt 约束输出；解析失败则重试或走兜底解析（正则抽取）。


#### 三种框架实现对比

##### Spring AI 1.0 实现

```java
package com.carbon.guard.structured;

import org.springframework.ai.chat.client.ChatClient;
import org.springframework.ai.converter.BeanOutputConverter;
import org.springframework.stereotype.Service;

/**
 * 1.0：BeanOutputConverter 把 POJO 转成 JSON Schema 提示词 + 解析返回 JSON
 */
@Service
public class CarbonFactorService {

    private final ChatClient chatClient;

    public CarbonFactorService(ChatClient.Builder builder) {
        this.chatClient = builder.build();
    }

    public EmissionFactor extract(String industry) {
        return chatClient.prompt()
                .user("请给出" + industry + "行业的碳排放因子")
                .call()
                .entity(EmissionFactor.class);   // 内部等价于 entity(BeanOutputConverter)
    }

    /** 手动使用 converter 以便自定义提示与解析 */
    public EmissionFactor extractManual(String industry) {
        BeanOutputConverter<EmissionFactor> converter =
                new BeanOutputConverter<>(EmissionFactor.class);
        String format = converter.getFormat();   // 形如 {"industry":"...","value":0.0,...}

        String raw = chatClient.prompt()
                .user(u -> u.text("请给出{industry}行业的碳排放因子。\n只输出 JSON，格式：\n{format}")
                        .param("industry", industry)
                        .param("format", format))
                .call()
                .content();

        try {
            return converter.convert(raw);
        } catch (Exception e) {
            // JSON 不合法时的兜底：重试 + 清洗
            String cleaned = raw.replaceAll("^```(?:json)?\\s*|\\s*```$", "").trim();
            try {
                return converter.convert(cleaned);
            } catch (Exception e2) {
                throw new IllegalStateException("模型未返回合法 JSON: " + raw, e2);
            }
        }
    }

    public record EmissionFactor(String industry, double value, String unit, String source) {}
}
```

##### Spring AI 2.0 实现

```java
package com.carbon.guard.structured;

import org.springframework.ai.chat.client.ChatClient;
import org.springframework.ai.chat.client.advisor.StructuredOutputValidationAdvisor;
import org.springframework.stereotype.Service;

/**
 * 2.0 新增 StructuredOutputValidationAdvisor：
 * 结构化输出解析失败时自动带着错误信息重试（默认重试 3 次），
 * 比手写 try/catch 重试更稳
 */
@Service
public class CarbonFactorService {

    private final ChatClient chatClient;

    public CarbonFactorService(ChatClient.Builder builder) {
        this.chatClient = builder
                .defaultAdvisors(new StructuredOutputValidationAdvisor())
                .build();
    }

    public EmissionFactor extract(String industry) {
        return chatClient.prompt()
                .user("请给出" + industry + "行业的碳排放因子")
                .call()
                .entity(EmissionFactor.class);
    }

    public record EmissionFactor(String industry, double value, String unit, String source) {}
}
```

##### LangChain4j 实现

```java
package com.carbon.guard.structured;

import dev.langchain4j.service.AiServices;
import org.springframework.stereotype.Service;

/**
 * LangChain4j：返回 POJO 即结构化输出，框架负责把 JSON 映射到目标类型；
 * 映射失败会抛异常，可用 OutputParser / JsonOutputParser 自定义
 */
@Service
public class CarbonFactorService {

    private final FactorAssistant assistant;

    public CarbonFactorService(ChatLanguageModel model) {
        this.assistant = AiServices.builder(FactorAssistant.class)
                .chatModel(model)
                .build();
    }

    public EmissionFactor extract(String industry) {
        return assistant.extract(industry);
    }

    interface FactorAssistant {
        @dev.langchain4j.service.UserMessage("请给出{{it}}行业的碳排放因子")
        EmissionFactor extract(String industry);
    }

    record EmissionFactor(String industry, double value, String unit, String source) {}
}
```

#### 追问：
- 追问1：模型偶尔返回 ```json 代码块包裹，BeanOutputConverter 能直接解析吗？还是要先去围栏？
  - **答**：`BeanOutputConverter` 内部已能容忍 ```json 围栏，多数情况下无需手动去围栏即可解析。
    - 机制：转换器在 `convert` 时会做清洗（strip markdown 围栏/前后多余文本）再反序列化，标准 ```json...``` 包裹通常可直接解析。
    - 兜底：若遇到非标准包裹或夹带解释文字，可在调用前用正则提取代码块，再交 converter，保证健壮。
    - 碳管家实践：生成 CarbonReport 时对返回文本先"提取最外层 JSON 对象"再 `convert`，解析失败走重试一次 + 正则兜底。
- 追问2：CarbonReport 字段多，模型漏填必填项，是 Prompt 强约束还是代码里补默认值？
  - **答**：双层兜底——Prompt 显式列出必填字段并给示例，代码里对仍为空的关键字段补默认值/标记缺失。
    - Prompt 侧：在 JSON Schema/约束里标注 required 字段、给出 few-shot 示例，降低漏填概率。
    - 代码侧：`convert` 后做校验，`null` 必填项补业务默认值（如 `unit="kgCO2e"`）或置为"未提供"并触发告警，不让缺字段直接空指针。
    - 碳管家实践：报告生成后过一道 `ReportValidator`，缺失关键项（如总排放量）则提示模型补全或返回降级报告。

### 48. 流式响应 stream() 怎么对接 SSE 与中断取消？
**重要度**：★★★★
```java
Flux<String> flux = client.prompt().user(q).stream().content();
return flux; // Controller 返回 Flux<String>，WebFlux 自动转 SSE
```
- 用 `Disposable` 或 `takeUntil` 实现客户端断开即取消订阅；前端监听 `text/event-stream` 增量渲染。

#### 追问：
- 追问1：SSE 在 Nginx/Gateway 下被缓冲，前端看不到逐字效果，怎么排查和关缓冲？
  - **答**：关掉代理层的响应缓冲并设正确响应头，让流式字节直出。
    - 排查：看响应是否"一顿一顿"整段到达——是缓冲；检查 Nginx `proxy_buffering off`、`X-Accel-Buffering: no`，Gateway 路由的 `responseTimeout` 与缓冲配置。
    - 配置：Nginx 加 `proxy_buffering off; proxy_cache off;`，Spring Cloud Gateway 关闭对 SSE 的缓冲并设置足够大的 `max-in-memory-size`。
    - 碳管家实践：SSE 接口单独路由、不走普通缓冲缓存，前端用 `fetch`+`ReadableStream` 或 `EventSource` 增量渲染，并加心跳保活防代理超时断开。
- 追问2：用户中途关闭页面，后端 Flux 还在跑模型，怎么及时 cancel 省 token？
  - **答**：监听客户端断开（连接取消订阅）并主动 `cancel` 上游 Flux，避免无谓的模型调用与 token 消耗。
    - 机制：WebFlux 中客户端断开会触发订阅取消，在 Controller 返回 `Flux` 时框架传播 cancel；可在 `doOnCancel` 里显式中断底层 `stream()` 订阅。
    - 实践：用 `takeUntil`/`timeout` 兜底，或在 `Disposable` 上监听；若已拿到模型连接，调用其 cancel/close 释放连接。
    - 碳管家落地：长文本生成加最大时长上限与 cancel 钩子，断开即停，成本侧靠 Micrometer 统计"中断率"优化体验。

### 49. 对话记忆 ChatMemory 怎么接？多用户怎么隔离？
**重要度**：★★★★
- `MessageWindowChatMemory` 维护最近 N 条消息窗口，超窗丢弃最旧。
- `InMemoryChatMemoryRepository` 单实例；生产环境用 **`MessageWindowChatMemory` + 自研 `ChatMemoryRepository`（落 Redis）** 或官方 `JdbcChatMemoryRepository` 持久化（1.x 无官方 Redis 实现，2.0 补上了官方 Redis repository，见第 36 题）。
- 多用户靠 `conversationId` 隔离：`ChatClient.builder(chatModel).defaultAdvisors(MessageChatMemoryAdvisor.builder(memory).build())`，调用处用 `.advisors(a -> a.param(ChatMemory.CONVERSATION_ID, cid))` 传会话 ID（窗口大小配在 `MessageWindowChatMemory.builder().maxMessages(10)` 上，不在 Advisor 上）。

#### 追问：
- 追问1：窗口只留 10 条，早期"用户身份/项目背景"被丢了对后续回答有影响，怎么保关键信息？
  - **答**：把"长期关键上下文"放进 System/Profile 而非依赖对话窗口，窗口只存短期轮次。
    - 分离：用户身份、项目背景、行业等稳定信息存用户画像/会话 Profile，每轮通过 System 或固定前缀注入，不占窗口。
    - 摘要：被挤出窗口前的旧消息先做 `summary` 压缩成一段摘要再保留，避免硬性丢失背景。
    - 碳管家实践：会话初始化时从用户/企业档案注入"行业、核算标准、语言偏好"到 System，多轮只保留近期问答，背景不丢。
- 追问2：RedisChatMemory 在多实例部署下，并发读写同一 conversationId 会有竞争吗？
  - **答**：会有读写竞争，需靠 Redis 原子操作/锁或串行化访问会话写入来规避。
    - 竞争点：同一用户并发发两条消息时，两边都读历史、都写回，可能互相覆盖导致丢消息。
    - 解决：写入用 Redis 的 list/string 原子 append 或 `WATCH/MULTI` 事务；或对话写入串行化（同 conversationId 路由到同一处理线程/加分布式锁）。
    - 碳管家实践：消息落库走统一会话服务，按 conversationId 加轻量锁或队列化写入，保证多实例下记忆一致。

### 50. Spring AI 的可观测性（Observability）怎么接 Micrometer？
**重要度**：★★★★
Spring AI 内置 Micrometer 埋点：启用 `management.observations.*` 后可采集每次模型调用的 token 用量、耗时、成功率，并串联到分布式链路（Tracing）。
- 关键指标：`gen_ai.client.token.usage`（Histogram，靠属性 `gen_ai.token.type=input|output` 区分方向）、`gen_ai.client.operation.duration`（调用时延）、错误率；配合 Grafana 看板与告警。

#### 追问：
- 追问1：不同模型供应商（通义/DeepSeek）的 token 计量口径不一，Micrometer 指标能对齐对比成本吗？
  - **答**：指标能采集但口径需归一化——用 Micrometer 的 `gen_ai.client.token.usage` 并按 `gen_ai.token.type`（input/output）拆分，成本对账在应用层按单价换算。
    - 指标：Spring AI 埋点带 `gen_ai.system`（qwen/openai）等标签，可按供应商分别统计 token 与调用量。
    - 口径：各厂商 token 计算方式（BPE/字）不同，绝对数不可直接比；对比成本需乘以各自单价（元/千 token）归一到金额维度。
    - 碳管家实践：观测看板按 `model+provider` 分组展示用量与估算费用，月度对账以账单为准、指标作趋势参考。
- 追问2：把用户 query 也打进观测 span 会不会泄露碳数据隐私？怎么脱敏？
  - **答**：会——默认 span 可能记录完整 prompt，需关闭敏感字段记录或对 query 脱敏后再打点。
    - 风险：用户上传的排放数据、企业名进链路追踪（如 Jaeger）会被运维/第三方看到，构成数据泄露。
    - 脱敏：配置观测只记录 query 长度/哈希、或经脱敏 Advisor 替换 PII 后再记；敏感内容用 `低基数` 标签而非原文。
    - 碳管家实践：观测 span 只保留 `query_length`、意图分类标签与 token 数，全文 prompt 默认不落 tracing，确需排查时按权限临时开启。

### 51. 多模态输入（图片/音频/PDF）怎么传给模型？
**重要度**：★★★★
`UserMessage` 支持携带 `Media`：
```java
UserMessage msg = new UserMessage("描述这张图",
    new Media(MimeTypeUtils.IMAGE_PNG, new ByteArrayResource(bytes)));
```
- 文本 + 媒体作为一条消息发送；需模型本身支持多模态（如 qwen-vl）。

#### 追问：
- 追问1：用户上传一张"碳排放报表截图"让 AI 解读，图片先存哪？直接把图片内联编码进 Prompt 有大小限制吗？
  - **答**：图片先落对象存储（OSS）拿 URL，再按需传模型；内联编码直传受请求体/模型输入限制，大图应压缩或改传 URL。
    - 存储：上传经网关存到 OSS/MinIO，返回可访问 URL，避免把大二进制塞进应用内存与 Prompt。
    - 限制：内联编码会显著增大请求体积（约膨胀 1/3）、易超模型输入上限与网关 body 限制；qwen-vl 等既支持传 URL，也支持受限大小的内联编码，大图需先缩放/压缩。
    - 碳管家实践：截图统一存 OSS，ChatClient 用 URL 方式传 `Media`，并记录"图片URL+解读结果"便于溯源，不长期缓存原始敏感图。
- 追问2：多模态请求成本比纯文本高，碳管家怎么判断"该走多模态还是先 OCR 提取文本"？
  - **答**：先做"是否真需要视觉理解"的判断——报表/表格类优先 OCR 提文本走文本 RAG，仅当布局/图表语义关键时才走多模态。
    - 判断逻辑：若图片是规整表格/数字报表，OCR 提文本成本更低且可入库检索；若含图表、手写、版式语义，才调用多模态模型。
    - 成本：多模态按图计费且 token 折算高，能用文本 RAG 解决就不调视觉模型。
    - 碳管家实践：上传后先尝试 OCR/结构化提取，提取成功且能回答问题则走文本链路；识别不清或含图表时降级/升级到多模态解读并提示成本。

### 52. 配置与多模型切换（application.yml + 自定义 ChatModel）？
**重要度**：★★★
```yaml
spring:
  ai:
    dashscope:            # 通义走 dashscope；百度走 qianfan（模型是 ernie-*），provider 与模型名必须对应
      api-key: ${DASHSCOPE_AK}
      chat:
        model: qwen-plus  # 2.0 已扁平化；1.x 写法是 spring.ai.dashscope.chat.options.model
```
- 多个 `ChatModel` Bean 共存时，用 `@Qualifier` 注入；自定义 `ChatModel` 实现 `call()/stream()` 即可接私有化模型。
- 常见坑：把 `qwen-plus` 配到 `spring.ai.qianfan.*` 下——qianfan 是百度文心一言的坐标，启动会因模型名不认识而失败。

#### 追问：
- 追问1：主模型（qwen-plus）和兜底模型（qwen-max）怎么用 Advisor 做故障自动切换？
  - **答**：用自定义 `FallbackAdvisor`（或在调用层）捕获主模型异常/超时，自动改用兜底 `ChatModel` 重试。
    - 实现：自定义 Advisor 在 `chain.nextCall(request)` 外包 try-catch，主模型抛超时/5xx 时改用兜底 `ChatModel` 重新调用。注意 1.0 起链式 API 是 `nextCall/nextStream`，不再是 `next.apply`；且在 Advisor 内绕过链条直接换模型会跳过后续 Advisor 与工具循环，生产上更推荐把降级放在 ChatClient 外层或自定义 `ChatModel` 代理（如 `FallbackChatModel`）里做。
    - 条件：按异常类型/状态码切换（限流、超时、服务不可用），避免对业务错误（如参数错）误切换。
    - 碳管家实践：主用 qwen-plus 控成本，超时可降级到 qwen-max 保可用，切换次数与成功率进 Micrometer 监控告警。
- 追问2：自定义 ChatModel 接公司私有化大模型，流式和非流式都要实现吗？
  - **答**：取决于前端是否需要流式——若产品要逐字输出则 `stream()` 必须实现，否则至少实现 `call()`，建议两者都实现以防切换。
    - 接口：`ChatModel` 的 `call()` 是必选；`stream()` 流式可选但 Spring AI 很多能力（SSE）依赖它。
    - 实现：私有化模型若只提供同步 HTTP，可在 `stream()` 里把单次结果包成单元素 `Flux` 兜底，或真正对接 SSE/流式协议。
    - 碳管家实践：内部推理服务若支持流式则真实现 `stream()`，否则 `stream()` 包成伪流式（整段返回），保证 ChatClient 用法一致。

### 53. 怎么对 Spring AI 应用做单元测试？
**重要度**：★★★
- 用 `MockChatModel` 或 `TestChatClient` 模拟模型返回，断言 Prompt 组装与 Advisor 顺序。
- 测试 RAG：用内存 `SimpleVectorStore` + 假 `EmbeddingModel` 验证检索与拼装逻辑。

#### 追问：
- 追问1：TestChatClient 怎么验证"某个 Advisor 确实被调用且改了 Prompt"？
  - **答**：用 `TestChatClient` 的 `advisorsRequest`/`advisorsResponse` 断言钩子，检查请求/响应里是否出现 Advisor 注入的内容。
    - 断言：配置 `TestChatClient` 的回调，校验 `ChatClientRequest.prompt().getUserMessage().getText()` 是否含脱敏/审计注入的标记。
    - 验证顺序：可用带 `@Order` 的测试 Advisor 记录调用顺序，断言顺序符合预期（脱敏先于审计）。
    - 碳管家实践：单测里 mock 模型返回固定串，断言最终 Prompt 含 System 约束与记忆历史，证明 Advisor 链生效。
- 追问2：涉及真实向量库的集成测试太慢，CI 里怎么用内存实现替代？
  - **答**：测试/CI 用 `SimpleVectorStore` + 假 `EmbeddingModel` 替代真实 Milvus，只验证检索与拼装逻辑。
    - 替代：本地测试注册 `SimpleVectorStore`（内存）和确定性 `EmbeddingModel`（如 hash/常量向量），跑通 ETL→检索→拼装链路。
    - CI：通过 `@Profile("test")` 或测试配置切换 VectorStore Bean，避免起 Milvus 容器拖慢流水线。
    - 碳管家实践：单测用内存向量库快速验证 RAG 逻辑；仅端到端测试/预发才连真实 Milvus，保证 CI 速度与覆盖平衡。

### 54. Spring AI 与 LangChain4j，Java 企业落地应如何选型？
**重要度**：★★★★

两者都是 Java 生态的 LLM 应用框架，但定位与取舍不同。

**Spring AI**：Spring 官方出品，与 Spring Boot 3 / Spring Cloud / Spring Security / Spring Data 深度集成，配置即代码，适合已有 Spring 技术栈的企业项目；社区大、版本演进快、生态扩展多（如 Spring AI Alibaba、Spring AI MCP）。

**LangChain4j**：Java 版 LangChain，API 更接近 Python LangChain，内置更多现成组件（memory、agent、embedding store、tools 抽象），上手曲线对熟悉 LangChain 概念的人更友好；但生态上偏独立，与 Spring 体系整合需额外适配。

选型维度：

| 维度 | Spring AI | LangChain4j |
|---|---|---|
| 与 Spring 生态集成 | 原生支持 | 需适配 |
| 模型供应商抽象 | 统一 `ChatClient` / `ChatModel` | `ChatLanguageModel` |
| Function Calling | `ToolCallback` / `@Tool` | `@Tool` 注解 |
| 向量库 | Spring Data + 多 store | 内置多种 embedding store |
| Agent 编排 | 偏薄，需自研或结合框架 | 内置更完整 |
| 企业可控性 | 强，适合定制化 | 开箱即用 |

在积木 LCA 云平台这类已有 Spring Cloud 微服务体系、对鉴权/配置中心/可观测性要求高的场景，优先 Spring AI；如果要做快速 PoC、或团队有 Python LangChain 背景，可选 LangChain4j 过渡。

#### 追问：
- 追问1：Spring AI 的 `ChatClient` 与 LangChain4j 的 `AiServices` 在编程模型上有什么本质区别？
  - **答**：`ChatClient` 是命令式 API，通过 `chatClient.prompt().system(sys).user(user).call().content()` 链式组装（没有 `advise(...)` 方法，`advise` 是 1.0 之前 `AdvisedRequest` 时代的残留写法），强调"显式控制每次调用"；`AiServices` 是声明式代理，定义接口后框架自动拼装 system/user message、工具调用和返回类型映射，更接近"接口即 Agent"。前者可控性高，后者适合快速开发结构化输出。
- 追问2：如果公司已经用 LangChain4j 做了 PoC，后续要切到 Spring AI，迁移重点是什么？
  - **答**：重点在三层：
    - ① 模型调用层，把 `ChatLanguageModel`/`AiServices` 替换为 `ChatClient`
    - ② 工具层，把 `@Tool` 方法迁移到 Spring AI 的 `ToolCallback`（注意 `FunctionCallback` 在 1.0 已废弃、2.0 已移除，见[第 35 题](/04-spring-ai.html#q-4-35)）
    - ③ 向量与记忆层，把 LangChain4j 的 `EmbeddingStore`/`ChatMemory` 替换为 Spring Data Vector Store 和 `ChatMemory` 实现
    - 迁移时建议先用防腐层抽象，避免业务代码直接依赖框架 API。
- 追问3：Spring AI Alibaba 相比原生 Spring AI，在国产化/企业落地上有哪些增强？
  - **答**：主要增强：
    - ① 对接通义千问、百川、智谱等国产模型
    - ② 提供更贴近国内云环境的 starter 和配置
    - ③ 与阿里云生态（向量检索服务、函数计算、百炼平台）集成更深
    - ④ 在 Agent 编排、A2A 协议、多 Agent 协同上有更多扩展
    - 对于需要信创合规或国产模型支持的碳管理平台，Spring AI Alibaba 是更合适的选择。

### 55. Spring AI 2.0 的工具调用重构：ToolCallingAdvisor 上浮与渐进式工具披露
**重要度**：★★★★★

**题目：Spring AI 2.0 对工具调用做了什么重构？为什么这么改，对企业级 Agent 落地有什么影响？**

**1.x 的问题（官方原话："You could call tools; you could not build on top of tool calling."）**：
- 1.x 每个 ChatModel 内部藏着自己的工具执行循环（`ChatModel.call(prompt)` 会自动执行工具并反复调模型），逻辑埋在实现里，外部无法拦截、无法包装、无法替换执行策略
- 想在工具调用前后做审计、限流、埋点、灰度，只能干等——切不进这个闭环

**2.0 的重构：工具循环上浮为 Advisor 链的一等组件**
- **移除所有 ChatModel 实现里的内部工具循环**：`ChatModel.call(prompt)` / `stream(prompt)` **只返回模型原始响应，不再自动执行工具**
- 新增 `ToolCallingAdvisor`，由 `ChatClient` **自动注册**，负责完整的「模型→工具→模型」往返
- Advisor 链支持**循环**（advisor 可重入下游链）：工具调用循环、结构化输出重试循环、评测循环共用同一套编排机制
- 想完全自己控制每一轮迭代，可关闭自动注册后用 `ToolCallingManager` 手动驱动：`AdvisorParams.toolCallingAdvisorAutoRegister(false)`，或全局 `spring.ai.chat.client.tool-calling.enabled=false`

**渐进式工具披露：ToolSearchToolCallingAdvisor**
- 痛点：几百个工具签名全塞进 System Prompt，Token 成本高、模型也容易选错工具
- 做法：每会话把全量工具索引一次（支持向量库 / Lucene / 正则三种索引方式），等模型表露意图时，再按需检索出相关工具定义动态注入
- 碳管家场景：碳管家挂了「查因子」「算排放」「查法规」「生成报告」「导出 CBAM」等几十个工具，用 ToolSearch 后不必每次请求都带全量 Schema，Token 与选择准确率双改善

**两个健壮性默认值（面试容易加分）**：
- `StructuredOutputValidationAdvisor`：结构化输出校验失败（JSON 带 Markdown 围栏、字段缺失、类型错位）时不把解析器搞崩，而是把**失败原因与期望格式发回模型重试**（默认 3 次）
- 工具调用次数上限：2.0.1 起 `DEFAULT_MAX_CALLS_PER_TOOL = 40`、`DEFAULT_MAX_TOTAL_TOOL_CALLS = 150`，防止 Agent 陷入死循环烧 Token

#### 追问：
- 追问1：2.0 把工具循环从 ChatModel 内部搬到 Advisor，Spring AI Alibaba 或自研的 ChatModel 适配时最容易漏掉什么？
  - **答**：最容易漏的是"我以为框架会自动帮我调工具"。2.0 里 `ChatModel.call()` 返回的是**带 tool_calls 的原始响应**，不执行任何工具——若自研适配层照抄 1.x 的实现（内部自带工具循环），会与自动注册的 `ToolCallingAdvisor` **重复执行一次工具**（副作用类工具如写库、发消息会被执行两遍）。落地自查三条：
    - ① 自研 ChatModel 不再内置工具执行
    - ② 只保留一处 Advisor 注册（手动注册过就关掉自动注册）
    - ③ 对有副作用的工具加幂等键，用测试断言"调用次数 == 1"
- 追问2：ToolSearch 靠向量检索挑工具，那"选错工具"的概率怎么评估？会不会比全量塞进去更差？
  - **答**：确实存在这个风险，分场景看：工具数少（< 30）时全量注入更稳，别过度设计；工具多且语义分化大时 ToolSearch 收益明显（Token 降一个量级）。
    - 评估方法：固定一批真实 query，统计「Top-K 召回工具里含正确工具」的比例（召回率）+「模型最终选对工具」的比例（端到端正确率），两者一起看，只看召回率会高估；
    - 兜底设计：保留"直接指定工具"通道（如 `chatClient.prompt().tools(callback)` 显式传入），检索失败时由业务侧直接指定；
    - 混合策略：高频核心工具常驻注入（白名单），长尾工具交给 ToolSearch。

### 56. Spring AI 2.0 的 ChatMemory 改造：conversationId 强制化与多租户安全
**重要度**：★★★★★

**题目：Spring AI 2.0 为什么把 ChatMemory 的 conversationId 改成强制项？这背后是什么安全问题？**

**问题根源（1.x 的隐患）**：
- 1.x 的 `MessageChatMemoryAdvisor` 若构造时没显式指定会话 ID，会**静默降级**到常量 `ChatMemory.DEFAULT_CONVERSATION_ID`，其值就是字符串 `"default"`
- 后果：在多租户 SaaS 里，所有租户、所有用户的对话历史都落进同一个 `"default"` 桶
- 攻击面：只要某处漏传或传错 ID，就可能读到他人对话内容；审计日志也随之混淆，责任无法追溯

**2.0 的修复：从"默认兜底"改成"缺失即报错"**
- `MessageChatMemoryAdvisor` / `VectorStoreChatMemoryAdvisor` 每次调用必须通过 advisor context 提供 `ChatMemory.CONVERSATION_ID`，缺失或为 null **立即抛 `IllegalArgumentException`**
- 移除 `ChatMemory.DEFAULT_CONVERSATION_ID`
- 移除 advisor builder 上的 `.conversationId(String)`——不再允许在构造时设一个"全局默认会话"
- `BaseChatMemoryAdvisor.getConversationId()` 签名由 `(Map, String)` 改为 `(Map)`，取不到就抛异常
- 移除 `PromptChatMemoryAdvisor`（它把历史当纯文本塞进 system prompt），统一用 `MessageChatMemoryAdvisor`（把历史作为真正的 chat message 加入）

**正确用法（显式传 ID）**：
```java
chatClient.prompt()
    .user("什么是碳足迹？")
    .advisors(a -> a.param(ChatMemory.CONVERSATION_ID, "tenantA:user-1001:session-9"))
    .call()
    .content();
```
**碳管家落地**：会话 ID 用 `tenantId:userId:sessionId` 拼装，入口层（Gateway）从 JWT 解析后透传，**绝不让它来自前端请求体**；这样"漏传"从静默串号变成可观测的显式失败——把安全问题转化成可监控的可用性问题，这是更健康的工程姿态。

**附带的行为调整（升级时容易踩）**：
- `Advisor.DEFAULT_CHAT_MEMORY_PRECEDENCE_ORDER` 从 `HIGHEST_PRECEDENCE + 1000` 改为 `+200`，`ToolCallingAdvisor` 占用 `+300`
- 新默认行为：**工具调用循环内部的历史由 `ToolCallingAdvisor` 自己维护，Memory advisor 只保存最终 user/assistant 对话**，不会把 tool-call message 写进 `ChatMemoryRepository`（很多存储实现不支持 tool-call 消息类型）
- 若必须在循环内使用 memory，需 `disableInternalConversationHistory()`，并把 memory advisor 顺序调到 `+400`

#### 追问：
- 追问1：强制 conversationId 会不会破坏现有代码？升级时怎么快速定位所有需要补 ID 的调用点？
  - **答**：会破坏，而且这是**故意的**——静默兜底正是漏洞本身。定位方法有三：
    - ① 编译期，`MessageChatMemoryAdvisor` 缺失 ID 是在运行期抛异常不是编译期，所以要靠 grep：`grep -rn "MessageChatMemoryAdvisor\|VectorStoreChatMemoryAdvisor"`，逐个检查调用链上是否传了 `ChatMemory.CONVERSATION_ID`
    - ② 运行期，2.0 缺失会直接抛 `IllegalArgumentException` 而不是静默串号，配合灰度日志能快速暴露
    - ③ 架构上治本——把会话 ID 的组装收敛到一个 `ConversationIdResolver`（从 SecurityContext 取 tenantId/userId + 请求头里的 sessionId），让所有 Advisor 共用，杜绝"某处自己拼了个常量"
- 追问2：多租户下除了 conversationId，ChatMemory 层面还有哪些地方容易串号？
  - **答**：四个检查点：
    - ① **ID 拼接**：`tenantId` 必须来自服务端认证上下文而非前端参数，否则改个 tenantId 就能读别人会话
    - ② **存储键**：Redis key 要把 tenantId 拼进前缀（`chat:memory:{tenantId}:{sessionId}`），只按 sessionId 做键会在跨租户复用 ID 时串
    - ③ **向量记忆**：如果用 Milvus 存对话摘要，metadata 里必须带 tenantId 并在检索时强制过滤，否则语义检索会把别的租户的对话召回进来
    - ④ **JDBC 表**：`SPRING_AI_CHAT_MEMORY` **没有独立的 tenant_id 列**（只有 conversation_id / sequence_id / role / content / timestamp），租户隔离只能靠 conversation_id 自身的命名规范保证，所以拼装规则要统一且可审计，不能各写各的

### 57. Spring AI 1.x → 2.0 升级实战：破坏性变更清单与迁移路径
**重要度**：★★★★★

**题目：从 Spring AI 1.x 升级到 2.0，有哪些必须处理的破坏性变更？给出可行的迁移顺序。**

**八类必须处理的变更（按踩坑频率排序）**：
1. **工具 API 全量替换**：全局搜 `FunctionCallback`、`FunctionCallingOptions`、`defaultFunctions`、`.functions(...)`、`toolNames(...)`、`SpringBeanToolCallbackResolver`，按[第 35 题](/04-spring-ai.html#q-4-35)的对照表逐个换成 `ToolCallback` / `ToolCallingChatOptions` / `defaultTools` / `.tools(...)`
2. **确认工具执行路径**：用 `ChatClient` 的要确认自动注册的 `ToolCallingAdvisor` **没有重复注册**（手动注册过就去掉，或用 `AdvisorParams.toolCallingAdvisorAutoRegister(false)` 关掉自动注册）；直接用 `ChatModel` 的必须改成自己用 `ToolCallingManager` 驱动循环
3. **Options 改造**：`copy()` → `mutate()`；`getDefaultOptions()` → `getOptions()`；Options 一律用 builder 构造后 `.build()` 传入（不可变，不要复用或就地修改已有实例）；builder 方法 `.N(...)` → `.n(...)`
4. **配置键扁平化**：删掉 `.options` 段（`spring.ai.openai.embedding.options.model` → `spring.ai.openai.embedding.model`）；Redis memory 前缀改 `spring.ai.chat.memory.repository.redis.*`；Ollama 的 `think-option` → `think`
5. **Chat Memory**：确保每次调用都传 `ChatMemory.CONVERSATION_ID`；JDBC 旧表加 `sequence_id BIGINT` 并回填（PostgreSQL 可用 `ROW_NUMBER() OVER (PARTITION BY conversation_id ORDER BY "timestamp")` 造序号）
6. **MCP 迁移**：注解 import 从 `org.springaicommunity.mcp.*` 改到 `org.springframework.ai.mcp.annotation.*`；传输模块 groupId 从 `io.modelcontextprotocol.sdk` 改到 `org.springframework.ai`；`JsonSchema` → `Map<String, Object>`；`TypeReference` → `ParameterizedTypeReference`
7. **被移动/删除的类**：`JsonParser` → 新增的 `org.springframework.ai.util.JsonHelper`；`ModelOptionsUtils` 的 JSON 方法 → `JsonHelper` / `JacksonUtils`；`AnthropicApi` 及其嵌套 record 全部移除，改 `AnthropicChatModel.builder().apiKey(...).build()`；`Media.Builder.data(Object)` 移除（要按 byte[]/String/URI/URL 分别重载）
8. **被移除的模块**：`spring-ai-azure-openai`、`spring-ai-openai-sdk`、`spring-ai-azure-cosmos-db-store`、`spring-ai-hanadb-store`、`spring-ai-spring-cloud-bindings`、MiniMax 专用支持（改用 Anthropic 兼容端点 `https://api.minimax.io/anthropic`）、OCI GenAI（迁到 `spring-cloud-oracle`）

**推荐迁移顺序**（每步都能独立验证，出问题好回滚）：
1. 先把 Spring Boot 升到 3.5 跑一轮，消掉所有 deprecation 警告——**这些警告就是 2.0 的 breaking change 清单**，是最省力的排查方式
2. 升 JDK 到 21、Spring Boot 到 4.1.x（Spring AI 2.0 GA 的基线是 Boot 4.1 / Spring Framework 7，写 4.0.x 会在依赖解析阶段就卡住）、引入 `spring-ai-bom` 2.0.0
3. 修 Jackson 3 的 import（`com.fasterxml.jackson` → `tools.jackson`）、`ObjectMapper` → `JsonMapper`
4. 批量跑 **OpenRewrite 官方 recipe** 处理机械改动（imports、方法改名、依赖坐标）：
   `mvn org.openrewrite.maven:rewrite-maven-plugin:run -Drewrite.configLocation=.../migrate-to-2-0-0.yaml`
   （用 2.0.0 **GA** 的 yaml，recipe 名以该文件里声明的为准；别再用 `migrate-to-2-0-0-M3.yaml` + `M3*` ——里程碑 recipe 只覆盖 M1→M3 的增量，会漏掉 M3 之后的变更，如 conversationId 强制化、ToolSearch 相关调整；BOM 版本与 recipe 版本必须对齐）
   （recipe 覆盖不到的——直接依赖 provider 底层 API 的代码、工具注册方式、conversationId 接线——仍需手工处理）
5. 手工部分：工具注册改为显式 `ToolCallback`、ChatMemory 的 conversationId 全链路接线、JDBC 加列回填
6. 补测试：**JSON 序列化是最容易漏的一环**——Jackson 3 校验更严，原来能容忍的模糊绑定现在会直接报错，要专门补一轮结构化输出的集成测试
7. 灰度：小流量切，观察报错日志、响应耗时、模型输出效果，再全量

**给碳管家的现实建议**：如果当前跑在 Spring Boot 3.x / Java 17 上，**2.0 不是"必须升"**——它要求 Spring Boot 4 + Java 21，牵动的是整个工程基线（依赖树、Docker 基础镜像、CI 流水线、K8s 探针），成本远高于框架本身。务实路线是：**先在 1.x 上把代码写到"API 干净"**（只用 `ToolCallback`、显式传 conversationId、Options 一律走 builder），等公司基线整体升到 Boot 4 / Java 21 时再切 2.0，那时基本只剩改 import 与依赖坐标的事。


#### 三种框架实现对比

##### Spring AI 1.0 实现

```java
// ===== Spring AI 1.0 GA 的写法（升级前的基线）=====
@Configuration
public class AiConfig1x {

    @Bean
    ChatMemory chatMemory(ChatMemoryRepository repository) {
        // 1.0：持久化走 ChatMemoryRepository（不是 ChatMemoryStore）
        return MessageWindowChatMemory.builder()
                .chatMemoryRepository(repository)
                .maxMessages(20)
                .build();
    }

    @Bean
    ToolCallback factorTool(FactorService factorService) {
        // 1.0：builder 第二参必须是 Function 实现；描述走 .description(...)，不是塞进第二个参数
        return FunctionToolCallback.builder("lookupFactor", (FactorQuery q) -> factorService.lookup(q))
                .description("查询排放因子")
                .inputType(FactorQuery.class)
                .build();
    }

    @Bean
    ChatClient chatClient(ChatModel model) {
        return ChatClient.create(model);
    }
}
```

##### Spring AI 2.0 实现

```java
// ===== Spring AI 2.0 的写法（迁移后）=====
@Configuration
public class AiConfig2x {

    @Bean
    ChatMemory chatMemory(ChatMemoryRepository repository) {
        // 2.0：builder 方法不变，但持久化实现可换官方 Redis 版
        // spring-ai-autoconfigure-model-chat-memory-repository-redis
        // 配置前缀：spring.ai.chat.memory.repository.redis.*
        return MessageWindowChatMemory.builder()
                .chatMemoryRepository(repository)
                .maxMessages(20)
                .build();
    }

    @Bean
    ToolCallback factorTool(FactorService factorService) {
        // 2.0：工具【必须注册为 ToolCallback Bean】，.tools(cb) 仍要显式挂载
        // toolNames() 已移除；builder 第二参必须是 Function 实现
        return FunctionToolCallback.builder("lookupFactor", (FactorQuery q) -> factorService.lookup(q))
                .description("查询排放因子")
                .inputType(FactorQuery.class)
                .build();
    }

    @Bean
    ChatClient chatClient(ChatModel model) {
        return ChatClient.create(model);
    }
}
```

##### LangChain4j 实现

```java
// ===== LangChain4j 1.x 的写法（作为"另一条路"的对照）=====
// 如果目标是从 Spring AI 迁到 LangChain4j，而不是升 Spring AI 2.0：
// 核心映射是 ChatClient -> AiServices，VectorStore -> EmbeddingStore。
@Service
public class AiService1x {

    private final CarbonAssistant assistant;

    public AiService1x(ChatLanguageModel model) {
        this.assistant = AiServices.builder(CarbonAssistant.class)
                .chatModel(model)
                .chatMemoryProvider(id -> MessageWindowChatMemory.builder()
                        .id(id).maxMessages(20).build())
                .tools(new FactorTools())
                .build();
    }

    public String chat(String message) {
        return assistant.chat(message);
    }
}
```

#### 追问：
- 追问1：团队要不要为了"用上 2.0"而把 Java 17 升到 21、Spring Boot 3 升到 4？收益和成本怎么算？
  - **答**：先分清"框架收益"和"基线收益"。2.0 的新能力（MCP 一等公民、工具循环可编排、ToolSearch 渐进式披露）对**已有 MCP 集成、要自研 Agent 编排、多工具场景**的项目收益明显；如果只是 CRUD + 单轮问答 + 几个固定工具，1.x 完全够用，升 2.0 收益接近零。成本侧要算全账：JDK 21 的 GC/ZGC 变更（虚拟线程正式版）、Spring Boot 4 的 `spring-boot-starter-*` 拆分与 Jackson 3 迁移、CI 镜像重建、K8s 镜像基础版本、第三方 starter 兼容性——**Spring Boot 4 的生态兼容期是最大不确定性**，很多内部 starter 还没跟进。建议：
    - ① 在 Boot 3.5 上把 deprecation 清零（这一步收益 80%，成本 20%）
    - ② 框架版本等生态成熟再动
    - ③ 若确实要用 ToolSearch/MCP 一等公民，评估 spring-ai 社区扩展或自研是否更划算
- 追问2：升级过程中最隐蔽的"不报错但行为变了"的情况有哪些？
  - **答**：三类最隐蔽：
    - ① **Options 默认值下沉**——2.0 把默认值统一到 Options 层，且移除了模型默认 temperature 配置，没显式设置 temperature 的代码，采样行为可能与 1.x 不同（合规类回答尤其敏感）
    - ② **Anthropic `maxTokens` 默认值从 500 变成 4096**——依赖旧默认值控成本的代码，成本会直接翻几倍
    - ③ **工具解析兜底默认关闭**（2.0.1 起）——以前模型请求没挂载工具时会从应用级 resolver 里找，现在只执行明确附加到 request 的工具，"工具没被调起来"的表现是**静默不执行**而非报错
    - 排查手段：升级后用同一批 case 做新旧版本对拍，比对输出与调用次数差异，而不是只看有没有抛异常。

