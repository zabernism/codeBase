## 第二十五章：设计模式


> 本章结合AI/Spring场景讲解23种经典设计模式+7种扩展模式，每题以碳管家AI助手的实际代码场景为例。

---

#### 创建型模式

### 1. 单例模式（枚举实现）
**重要度**：★★★★

**定义**：确保一个类只有一个实例，并提供全局访问点。

**AI场景**：碳管家AI助手的`ModelClientManager`——管理所有大模型客户端连接池，全局唯一，避免重复创建连接。

**枚举实现（最佳实践）**：

```java
public enum ModelClientManager {
    INSTANCE;

    // 缓存的是 ChatModel（真正的模型客户端），不是 ChatClient
    private final Map<String, ChatModel> modelMap = new ConcurrentHashMap<>();

    public ChatModel getModel(String modelId) {
        return modelMap.computeIfAbsent(modelId, id -> {
            // ChatClient.builder(...) 的入参必须是 ChatModel 实例，没有 builder(String modelId) 这个重载
            ChatModelFactory factory = ModelFactoryRegistry.get(id);
            return factory.createModel();
        });
    }

    public ChatClient getClient(String modelId) {
        // ChatClient.Builder 是"不可变"的流式构建器：每个 defaultXxx 都返回新 Builder，
        // 因此不能建一次缓存复用，应每次按需 build（成本很低，只是包装器）
        return ChatClient.builder(getModel(modelId))
                .defaultSystem("你是碳核算助手")
                .build();
    }
}

// 使用
ChatClient client = ModelClientManager.INSTANCE.getClient("deepseek-chat");
```

**为什么枚举是实现单例的最佳方式**：
- 线程安全（JVM保证枚举实例唯一）
- 防止反射攻击（枚举构造器私有且JVM特殊处理）
- 防止序列化重建（反序列化时 `ObjectInputStream` 对枚举做特殊处理：按常量名调 `Enum.valueOf` 返回**已有实例**，不执行构造器；注意这**不是** `readResolve`，`java.lang.Enum` 里没有 readResolve，那是普通类单例的兜底写法）
- 代码简洁，无需double-checked locking

**与其他实现对比**：

| 实现方式 | 线程安全 | 防反射 | 防序列化 | 代码复杂度 |
|---------|---------|--------|---------|-----------|
| 饿汉式 | 安全 | 不防 | 不防 | 低 |
| DCL | 安全 | 不防 | 不防 | 高 |
| 静态内部类 | 安全 | 不防 | 不防 | 中 |
| 枚举 | 安全 | 防 | 防 | 低 |

---

#### 追问：
- 追问1：如果 ModelClientManager 需要依赖 Spring 容器中的配置（如 modelId 列表、API Key），枚举单例无法被 Spring 管理，你会如何取舍或改造？
  - **答**：枚举单例适合"无外部依赖的全局无状态对象"；若需注入配置，可保留枚举做持有者，由 Spring 启动时调用 `ModelClientManager.INSTANCE.init(configs)` 注入依赖。
    - 也可改用 Spring 单例 Bean（`@Singleton`），但它只保证"**容器内唯一**"，**既不防反射也不防序列化**：Spring 创建 Bean 本身就是用反射调私有构造器（`ReflectionUtils.makeAccessible`），私有构造挡不住反射；普通 Bean 也不做序列化防护。要严格防破坏仍用枚举，或在该 Bean 构造器里加显式守卫 `if (instance != null) throw new IllegalStateException()`。
    - 若坚持枚举，可让枚举持有 `ApplicationContext` 引用按需取 Bean，但会引入容器耦合，一般不推荐。
- 追问2：在碳管家的多租户场景下，如果不同租户需要连接不同的模型服务端点，全局唯一的单例是否仍然适用？该如何调整设计？
  - **答**：全局唯一"管理器"仍适用，但它管理的是"连接池集合"而非单一连接。
    - 内部按 `tenantId` 维护 `Map<String, ChatClient>` 或 `Map<tenantId, ModelEndpoint>`，`getClient(tenantId)` 按租户路由到各自端点。
    - 若需隔离配额/资源，可为每个租户建独立池并设上限，避免单租户拖垮全局。

### 2. 工厂方法模式（模型工厂）
**重要度**：★★★★

**定义**：定义创建对象的接口，让子类决定实例化哪个类。

**AI场景**：碳管家的`ChatClientFactory`——根据配置创建不同大模型的ChatClient实例。

```java
// 抽象工厂接口
public interface ChatClientFactory {
    ChatClient createClient(ModelConfig config);
}

// 通义千问工厂
public class QwenClientFactory implements ChatClientFactory {
    @Override
    public ChatClient createClient(ModelConfig config) {
        return new QwenChatClient(config.getApiKey(), config.getModelName());
    }
}

// DeepSeek工厂
public class DeepSeekClientFactory implements ChatClientFactory {
    @Override
    public ChatClient createClient(ModelConfig config) {
        return new DeepSeekChatClient(config.getApiKey(), config.getModelName());
    }
}

// 使用
ChatClientFactory factory = FactoryRegistry.getFactory("deepseek");
ChatClient client = factory.createClient(config);
```

**Spring中的工厂方法**：Spring IoC容器本身就是工厂方法模式的实现——`BeanFactory`/`ApplicationContext`根据配置创建Bean实例。`FactoryBean`接口允许自定义Bean创建逻辑。

---

#### 追问：
- 追问1：当新增一个国产大模型（如智谱 GLM）时，用工厂方法模式需要改动哪些地方？能否做到对扩展开放、对修改关闭？
  - **答**：需新增 `GlmClientFactory implements ChatClientFactory` 并在注册表登记，调用方通过配置切换——对"新增"是开放的。
    - 但若 `FactoryRegistry.getFactory("glm")` 的注册写死，则违反"对修改关闭"；用 Spring `Map<String, ChatClientFactory>` 自动注入所有工厂实现，新增只需加 `@Component("glm")`，无需改注册表。
    - 这是工厂方法+自动发现结合，才真正满足开闭原则。
- 追问2：碳管家中 ChatClientFactory 的工厂实例本身是如何注册和获取的？如果用 Spring 的 FactoryBean 来实现，与手写工厂注册表相比有什么优劣？
  - **答**：手写注册表靠 `FactoryRegistry.getFactory(name)` 查 Map；Spring `FactoryBean` 把创建逻辑放进 `ChatClientFactoryBean.getObject()`，由容器按 BeanName 管理生命周期与依赖。
    - 优劣：FactoryBean 天然获得 DI、AOP、生命周期回调与配置注入，单例由容器保证；手写注册表更轻、可控，但需自己管理线程安全与初始化顺序。
    - 若工厂需复用且依赖 Spring Bean，优先 FactoryBean；若只是简单策略选择，注册表 Map 注入更直观。

### 3. 抽象工厂模式
**重要度**：★★★

**定义**：创建一系列相关对象的接口，无需指定具体类。

**AI场景**：碳管家的`AIProviderFactory`——为每个AI Provider创建一整套相关对象（ChatClient + EmbeddingClient + ImageClient）。

```java
public interface AIProviderFactory {
    ChatClient createChatClient();
    EmbeddingClient createEmbeddingClient();
}

public class QwenProviderFactory implements AIProviderFactory {
    @Override
    public ChatClient createChatClient() { return new QwenChatClient(); }
    @Override
    public EmbeddingClient createEmbeddingClient() { return new QwenEmbeddingClient(); }
}

public class DeepSeekProviderFactory implements AIProviderFactory {
    @Override
    public ChatClient createChatClient() { return new DeepSeekChatClient(); }
    @Override
    public EmbeddingClient createEmbeddingClient() { return new BgeEmbeddingClient(); }
}
```

**与工厂方法的区别**：工厂方法创建单一产品，抽象工厂创建产品族。在碳管家中，切换AI Provider时需要同时替换ChatClient和EmbeddingClient，抽象工厂确保一致性。

---

#### 追问：
- 追问1：当某个 AI Provider（如 DeepSeek）只提供 ChatClient 而没有官方 EmbeddingClient 时，抽象工厂的产品族出现"缺件"，你会如何设计以优雅处理这种不一致？
  - **答**：让工厂方法返回 `Optional<EmbeddingClient>` 或抛出 `UnsupportedOperationException`，由上层决定兜底，而不是静默出错。
    - 方案A：用默认 Embedding（如 BGE）补位，`createEmbeddingClient()` 返回共享默认实现。
    - 方案B：抽象工厂加"能力探测" `supportsEmbedding()`，调用方按能力选择；方案C：用 Null Object 返回空 EmbeddingClient 避免 NPE。核心是"缺件"显式化。
- 追问2：在碳管家的实际架构中，切换 Provider 时如何保证 ChatClient 与 EmbeddingClient 的向量维度一致？抽象工厂在这一点上能帮你做什么、不能帮你做什么？
  - **答**：抽象工厂只保证"同一 Provider 下 ChatClient 与 EmbeddingClient 配套创建"，维度一致性是契约层面——需让返回对象携带 `dimension` 元数据并做启动期断言。
    - 抽象工厂帮不了的是：跨库已存向量的维度兼容（旧 Milvus 集合是 768 维，换成 1536 维模型需重建索引）。
    - 可加启动校验+配置中心锁定 dimension，避免检索维度错配导致 RAG 失效。

### 4. 建造者模式（PromptBuilder）
**重要度**：★★★★

**定义**：将复杂对象的构建与表示分离，使得同样的构建过程可以创建不同的表示。

**AI场景**：碳管家的`PromptBuilder`——构建复杂Prompt，支持系统指令+上下文+检索结果+用户问题的灵活组合。

```java
public class PromptBuilder {
    private String systemInstruction;
    private String context;
    private String retrievedDocs;
    private String userQuestion;
    private String outputFormat;

    public PromptBuilder systemInstruction(String instruction) {
        this.systemInstruction = instruction;
        return this;
    }

    public PromptBuilder context(String context) {
        this.context = context;
        return this;
    }

    public PromptBuilder retrievedDocs(String docs) {
        this.retrievedDocs = docs;
        return this;
    }

    public PromptBuilder userQuestion(String question) {
        this.userQuestion = question;
        return this;
    }

    public PromptBuilder outputFormat(String format) {
        this.outputFormat = format;
        return this;
    }

    public String build() {
        StringBuilder sb = new StringBuilder();
        if (systemInstruction != null) sb.append(systemInstruction).append("\n");
        if (context != null) sb.append("对话上下文：").append(context).append("\n");
        if (retrievedDocs != null) sb.append("参考资料：").append(retrievedDocs).append("\n");
        if (outputFormat != null) sb.append("输出格式：").append(outputFormat).append("\n");
        sb.append("用户问题：").append(userQuestion);
        return sb.toString();
    }
}

// 使用
String prompt = new PromptBuilder()
    .systemInstruction("你是碳管理专家助手")
    .retrievedDocs(top5Docs)
    .userQuestion("什么是CBAM?")
    .outputFormat("请用Markdown格式回答")
    .build();
```

**Spring中的建造者**：Spring AI的`ChatClient.builder(chatModel)`就是建造者模式——`ChatClient.Builder`逐步配置defaultSystem/defaultUser/defaultTools/advisor等参数，最后`build()`创建不可变的ChatClient实例。注意 Builder **自身也是不可变**的：每个 `defaultXxx` 都返回新的 Builder，不能"建一次缓存复用"。（`defaultFunctions` 在 Spring AI **1.0.0-M6 起废弃、M7 已移除**，工具统一走 `defaultTools`，传 `ToolCallback` 或 `@Tool` 标注的对象）

---

#### 追问：
- 追问1：Prompt 构建过程中如果 retrievedDocs 超长导致超出模型上下文窗口，PromptBuilder 是否应该负责截断或摘要？职责边界在哪里？
  - **答**：PromptBuilder 只负责"组装"，截断/摘要属于检索与编排层职责。
    - 更合理：RAG 检索后由 `ContextCompressor`/`PromptTrimmer` 按模型 `maxTokens` 做截断、重排序保留 Top-K，或用 LLM/embedding 摘要压缩。
    - PromptBuilder 可暴露 `maxContextTokens` 做"软截断+告警"，但真正语义压缩不应塞进它；构建器保持无状态/可复用，token 预算控制在调用方。
- 追问2：Spring AI 的 ChatClient.Builder 是流式不可变构建，如果并发线程共用同一个 Builder 实例去 build 不同配置的 ChatClient，会出现什么问题？
  - **答**：`ChatClient.Builder` 内部状态通常可变、非线程安全；并发共用同一 Builder 并 `build()` 会导致字段竞态（配置互相覆盖），生成"串味"的 Client。
    - 正确做法：每个线程/每次调用用 `builder.clone()` 或 `ChatClient.builder(model)` 新建 Builder（Spring AI 的 Builder 一般支持复制）。
    - 或把 `build()` 结果（不可变 ChatClient）缓存复用，Builder 本身作模板只 clone 不共享。

### 5. 原型模式
**重要度**：★★★

**定义**：用原型实例指定创建对象的种类，通过拷贝原型创建新对象。

**AI场景**：碳管家的`PromptTemplate`——预定义模板原型，使用时拷贝并填入变量。

```java
public class PromptTemplate implements Cloneable {
    private String template;
    private Map<String, String> variables;

    @Override
    public PromptTemplate clone() {
        PromptTemplate copy = new PromptTemplate();
        copy.template = this.template;
        copy.variables = new HashMap<>(this.variables); // 深拷贝
        return copy;
    }

    public PromptTemplate withVariable(String key, String value) {
        PromptTemplate copy = this.clone();
        copy.variables.put(key, value);
        return copy;
    }
}

// 预定义模板原型
PromptTemplate regulationTemplate = new PromptTemplate(
    "你是碳法规专家。请根据以下参考资料回答用户关于{{regulation}}的问题...",
    new HashMap<>()
);

// 使用时拷贝并填入变量
PromptTemplate instance = regulationTemplate.withVariable("regulation", "CBAM");
```

**深拷贝vs浅拷贝**：原型模式需注意深拷贝问题——如果对象包含引用类型字段，浅拷贝会导致共享内部对象。解决方案：实现`Cloneable`时手动深拷贝引用字段，或使用序列化方式（JSON序列化→反序列化）实现深拷贝。

---

#### 追问：
- 追问1：PromptTemplate 中的 template 字符串是共享引用，如果 withVariable 之外还需要修改模板正文，浅拷贝会带来什么隐患？
  - **答**：当前 `template` 是 `String`（不可变），浅拷贝后单独重赋值只影响该副本、不互相污染；真正风险在于"可变引用字段"——若模板含 `List`/`Map` 等可变片段，浅拷贝会让多实例共享同一对象，一处修改全体受影响。
    - 代码已对 `variables` 做 `new HashMap` 深拷贝，方向正确。
    - 若模板需改正文，应整体深拷贝或改为不可变结构，避免共享引用被意外改写。
- 追问2：在碳管家高并发问答场景下，用 clone 还是用 JSON 序列化做深拷贝性能更优？两者在含循环引用时分别有什么坑？
  - **答**：手写 `clone`（字段拷贝）最快、无序列化开销，适合结构固定、字段明确的模板对象；JSON 序列化（Jackson）每次走反射/IO，慢数倍但实现简单。
    - 循环引用：手写 clone 需自己处理，否则栈溢出；JSON 序列化需 `@JsonIdentityInfo` 或关闭循环引用检测，否则抛 `JsonMappingException`。
    - 高频问答场景建议 clone 或预编译模板对象池，避免每请求 JSON 序列化。

#### 结构型模式

### 6. 代理模式（AOP/远程调用）
**重要度**：★★★★★

**定义**：为其他对象提供代理以控制对这个对象的访问。

**AI场景**：碳管家的`ChatClientProxy`——在大模型调用前后添加缓存、限流、日志、降级逻辑。

```java
public class ChatClientProxy implements ChatClient {
    private final ChatClient target;
    private final RedisTemplate redisTemplate;
    private final RateLimiter rateLimiter;

    @Override
    public String call(String prompt) {
        // 1. 限流检查
        if (!rateLimiter.tryAcquire()) {
            return "服务繁忙，请稍后重试";
        }
        // 2. 缓存检查
        String cached = redisTemplate.opsForValue().get(cacheKey(prompt));
        if (cached != null) return cached;
        // 3. 调用真实对象
        String result = target.call(prompt);
        // 4. 缓存写入
        redisTemplate.opsForValue().set(cacheKey(prompt), result, 30, TimeUnit.MINUTES);
        return result;
    }
}
```

**Spring AOP中的代理**：Spring AOP 的默认代理方式要分两层看——Spring Framework **原生**默认是"有接口走 JDK Proxy、无接口走 CGLIB"；但 **Spring Boot 2.x 起把 `spring.aop.proxy-target-class` 默认设为 `true`**，即**有接口也用 CGLIB**（Boot 3 延续），所以日志里常见 `CglibAopProxy`。要改回 JDK 代理需显式设置 `spring.aop.proxy-target-class=false`。碳管家中`@Transactional`、`@Async`、`@Cacheable`等注解都是通过代理模式实现的。

**动态代理vs静态代理**：

| 维度 | 静态代理 | 动态代理(JDK) | CGLIB代理 |
|------|---------|--------------|----------|
| 代理对象 | 手写 | 运行时生成 | 运行时生成子类 |
| 目标类要求 | 无 | 必须实现接口 | 无(final类不行) |
| 性能 | 高 | 中 | 较高(生成子类) |
| Spring默认 | - | 有接口时 | 无接口时 |

---

#### 追问：
- 追问1：ChatClientProxy 用 Redis 缓存 prompt 到结果的映射，如果大模型输出含实时数据或随机性高（temperature 大），缓存命中会带来什么正确性问题？
  - **答**：缓存会把"本应变化"的回答固化，造成实时数据过期、或高 temperature 下每次本应不同的回答被复用，丧失多样性。
    - 修复：缓存 key 纳入使结果变化的维度——temperature、数据版本号、随机种子/时间戳。
    - 对实时数据（汇率、当日排放）加短 TTL 或禁用缓存；对"可缓存问法"用语义相似度去重而非原始 prompt 精确匹配，避免不同措辞命中错误缓存。
- 追问2：Spring AOP 的 CGLIB 代理无法代理 final 类/方法，如果 ChatClient 的实现类被 final 修饰，你的代理方案会如何失败、如何规避？
  - **答**：CGLIB 通过生成子类做增强，两种后果必须分清：①**final 类** → 无法被继承，代理**在创建阶段就直接失败**（Spring 抛 `BeanCreationException`，根因是 `IllegalArgumentException: Cannot subclass final class ...`），Bean 初始化不出来；②**final 方法** → 代理创建**成功**，但该方法不能被重写，只是**静默不被增强**（事务/日志悄悄失效，最坑）。规避：被代理的类不要加 final，`@Transactional` 等方法不要加 final；若第三方类是 final，改用接口 + JDK 代理或包一层适配器。
    - 规避：
      - ① 让 ChatClient 实现接口，改用 JDK 动态代理（基于接口）
      - ② 去掉 final 修饰
      - ③ 用装饰器/包装类替代 AOP 代理（手动包一层）
    - Spring AI 的 ChatClient 本身就是接口，优先走 JDK Proxy。

### 7. 适配器模式（多模型适配）
**重要度**：★★★★

**定义**：将一个类的接口转换成客户端期望的另一个接口。

**AI场景**：碳管家的`ModelAdapter`——统一不同大模型API的差异（请求格式/响应格式/错误码），对外提供统一接口。

```java
// 统一接口
public interface UnifiedChatClient {
    ChatResponse chat(ChatRequest request);
}

// 通义千问适配器
public class QwenAdapter implements UnifiedChatClient {
    private final QwenClient qwenClient;

    @Override
    public ChatResponse chat(ChatRequest request) {
        QwenRequest qwenReq = convertRequest(request);
        QwenResponse qwenRes = qwenClient.chat(qwenReq);
        return convertResponse(qwenRes);
    }
}

// DeepSeek适配器
public class DeepSeekAdapter implements UnifiedChatClient {
    private final DeepSeekClient deepSeekClient;

    @Override
    public ChatResponse chat(ChatRequest request) {
        DeepSeekRequest dsReq = convertRequest(request);
        DeepSeekResponse dsRes = deepSeekClient.chat(dsReq);
        return convertResponse(dsRes);
    }
}
```

**Spring AI中的适配器**：Spring AI的`ChatModel`接口就是适配器模式的体现——无论底层是OpenAI、Ollama还是Azure OpenAI，都适配为统一的`ChatModel`接口。

---

#### 追问：
- 追问1：不同模型对"错误码"语义不同（如 429 限流 vs 503 不可用），UnifiedChatClient 的 ChatResponse 该如何设计错误模型，才能让上层不感知底层差异？
  - **答**：ChatResponse 内部定义与厂商无关的 `ErrorType` 枚举（如 RATE_LIMITED/UNAVAILABLE/AUTH_FAILED/BAD_REQUEST），适配器把底层 HTTP 状态码/错误体映射为统一枚举+可读 message。
    - 上层只判 `response.getErrorType()` 做重试/降级策略，不感知 429/503 差异。
    - 可附带 `retryable` 布尔与 `retryAfter` 建议，跨厂商保持一致语义。
- 追问2：当通义千问新增了流式+函数调用特性，而旧适配器只适配了同步文本接口，如何在不破坏现有调用方的前提下扩展适配器？
  - **答**：用"能力接口"做增量扩展，旧实现不强制实现新特性——定义可选能力接口（如 `StreamingCapable`/`FunctionCallCapable`），调用方用 `instanceof`/能力探测降级。
    - 或接口方法返回 `CapabilityResult`，不支持时优雅返回 `UNSUPPORTED`，避免改接口签名导致所有适配器编译失败。
    - 新特性走"能力接口"组合，符合接口隔离原则，不破坏现有调用方。

### 8. 装饰器模式（流处理）
**重要度**：★★★★

**定义**：动态地给对象添加额外职责，比生成子类更灵活。

**AI场景**：碳管家的`StreamingChatDecorator`——在大模型流式响应上添加日志、Token计数、内容过滤装饰。

```java
// 基础流处理接口
public interface StreamingChatHandler {
    Flux<String> streamChat(String prompt);
}

// Token计数装饰器
public class TokenCountDecorator implements StreamingChatHandler {
    private final StreamingChatHandler wrapped;
    private final TokenCounter tokenCounter;

    @Override
    public Flux<String> streamChat(String prompt) {
        return wrapped.streamChat(prompt)
            .doOnNext(token -> tokenCounter.increment(1))
            .doOnComplete(() -> log.info("Token count: {}", tokenCounter.getTotal()));
    }
}

// 内容过滤装饰器
public class ContentFilterDecorator implements StreamingChatHandler {
    private final StreamingChatHandler wrapped;

    @Override
    public Flux<String> streamChat(String prompt) {
        return wrapped.streamChat(prompt)
            .filter(token -> !isSensitiveContent(token));
    }
}

// 使用：装饰链
StreamingChatHandler handler = new ContentFilterDecorator(
    new TokenCountDecorator(new BaseStreamingChatHandler()));
```

**与代理模式的区别**：装饰器模式侧重于"增强功能"（可多层装饰），代理模式侧重于"控制访问"（通常一层）。

---

#### 追问：
- 追问1：装饰链中 ContentFilterDecorator 用 filter 丢弃敏感 token，会导致流式输出出现断句/缺字，如何在不破坏 Flux 语义的前提下做缓冲而非逐 token 过滤？
  - **答**：逐 token filter 会切碎词语/句子，应改为"缓冲到词/句边界再判"。
    - 用 `bufferUntil`/`windowUntil` 按标点/语义边界累积后再过滤，或先收集整句再用内容安全 API 批量判断。
    - 更彻底：把过滤下沉到"整段响应"层（对完整 token 流 `reduce` 成完整文本后过滤），流式仅做轻量标记，保证 Flux 背压语义不变。
- 追问2：装饰器与代理模式都能"包装"对象，碳管家的限流+缓存逻辑放在代理里还是装饰器里更合适？为什么？
  - **答**：限流、缓存属于"横切控制访问"语义，放代理更贴切（代理侧重控制访问、通常一层、统一入口）；装饰器侧重"增强功能、可多层组合"，适合日志/计数/过滤等。
    - 实际可结合：代理做入口级限流+缓存，装饰器做流式增强。
    - 碳管家若用 Spring AOP，`@Cacheable`+限流注解即代理式，天然统一；装饰器留给可按场景增删的流处理链。

### 9. 外观模式
**重要度**：★★★

**定义**：为子系统中的一组接口提供一致的界面。

**AI场景**：碳管家的`CarbonAssistantFacade`——将RAG检索、Prompt编排、大模型调用、结果解析等子系统组合为一个简单的问答接口。

```java
@Service
public class CarbonAssistantFacade {
    private final RagService ragService;
    private final PromptBuilderService promptService;
    private final ChatClient chatClient;
    private final ResponseParserService parserService;

    public String ask(String question, String tenantId) {
        List<String> docs = ragService.search(question, tenantId);
        String prompt = promptService.buildPrompt(question, docs, tenantId);
        String rawResponse = chatClient.call(prompt);
        return parserService.parse(rawResponse);
    }
}
```

**外观模式的意义**：客户端只需调用`ask()`，无需了解内部4个子系统的交互细节。这是碳管家AI助手最核心的设计——将复杂的RAG+LLM流水线封装为简单的外观接口。

---

#### 追问：
- 追问1：CarbonAssistantFacade.ask() 把 RAG 检索、Prompt 编排、模型调用、解析串成同步流程，如果某一步超时或失败，外观层应该如何设计降级与部分返回？
  - **答**：外观层应封装"整体失败≠无输出"：每步用超时（如 `timeout`/`withTimeout`）+熔断，模型调用失败可降级到缓存答案/模板话术。
    - RAG 失败时仍可让模型凭自身知识答（标注"未检索到资料"），实现部分返回。
    - 用 `try/catch` 包裹各步返回 `PartialResult`，由外观决定返回完整还是降级内容，对外保持 `ask()` 签名不变。
- 追问2：当碳管家需要同时支持"同步问答"和"流式问答"两种外观入口时，如何避免 ask() 与 streamAsk() 内部逻辑重复、又保持外观的简单性？
  - **答**：把可复用的"检索+Prompt 构建"抽成私有内部方法（如 `buildContext`），同步版 `ask()` 返回 `String`、流式版 `streamAsk()` 返回 `Flux<String>`，共享前段编排避免重复。
    - 或底层统一返回 `Flux<Token>`，同步版 `ask()` = `.collectList().map(join)`。
    - 外观只暴露两个语义清晰入口，编排逻辑收敛在内部，客户端仍只调一个方法。
- 追问3：外观模式会不会让 CarbonAssistantFacade 成为"上帝类"、把本该分散在子系统的复杂度全收拢到自己身上？你如何界定外观的职责边界？
  - **答**：会——若把检索、解析、重试、降级全塞进外观就变上帝类。边界原则：外观只做"编排与流程串联"，不实现具体算法。
    - 具体能力（RAG 检索、模型调用、解析）下沉到各子系统/领域服务，外观仅协调调用与异常处理。
    - 用模板方法或责任链进一步拆分流程；保持外观"薄"，每个子系统高内聚、可独立测试。

### 10. 桥接模式
**重要度**：★★★

**定义**：将抽象部分与实现部分分离，使它们都可以独立变化。

**AI场景**：碳管家的`ChatService`——将对话类型（法规问答/因子查询/闲聊）与模型实现（通义千问/DeepSeek/自部署GLM）解耦，两者独立扩展。

```java
// 抽象层：对话类型
public abstract class ChatService {
    protected ChatModel chatModel; // 桥接到实现层
    protected ChatService(ChatModel chatModel) { this.chatModel = chatModel; }
    public abstract String chat(String question);
}

// 扩展抽象层：法规问答
public class RegulationChatService extends ChatService {
    @Override
    public String chat(String question) {
        String prompt = "你是碳法规专家..." + question;
        return chatModel.call(prompt);
    }
}

// 组合使用
ChatService service = new RegulationChatService(new DeepSeekChatModel());
```

**桥接模式的优势**：新增对话类型无需修改模型实现，新增模型无需修改对话类型。3种对话类型 x 3种模型 = 9种组合，但只需3+3=6个类。

---

#### 追问：
- 追问1：桥接模式中抽象层（对话类型）和实现层（模型）是两个维度，如果新增"多轮对话带记忆"这一能力，它属于哪个维度？现有桥接结构能否低成本容纳？
  - **答**：记忆是"跨调用状态"，既非对话类型也非模型实现，更像横切能力。
    - 可做成桥接之外的"装饰/组合"层（给 ChatService 包一层 `MemoryDecorator`），或在抽象层加可选 `MemoryStore` 字段（大部分类型用空记忆）。
    - 若多数对话类型都需要记忆，把它作为抽象层的可选组件而非新维度，避免维度爆炸；低成本容纳方式是用组合而非再开一个继承轴。
- 追问2：碳管家把 ChatModel 作为桥接的实现侧注入，如果某个对话类型只能跑在特定模型上（如合规判断必须用 Qwen），如何在桥接结构里表达这种约束而不回到 if-else？
  - **答**：不让调用方随意组合，定义"允许的模型白名单"：在 `ChatService` 抽象层加 `getAllowedModels()`，工厂/路由创建时校验 `model ∈ allowed`，非法组合启动期报错。
    - 或使用"受限子类"——`ComplianceChatService` 构造器只接受 `QwenChatModel`，类型系统即约束。
    - 也可用策略+配置声明 `regulation→qwen` 映射，由装配器按配置注入，避免运行期 if-else。

### 11. 组合模式
**重要度**：★★★

**定义**：将对象组合成树形结构以表示"部分-整体"层次。

**AI场景**：碳管家的`KnowledgeNode`——知识库分类树（碳法规→ISO标准→ISO 14067），支持整体检索或子分类检索。

```java
public abstract class KnowledgeNode {
    protected String name;
    protected List<KnowledgeNode> children = new ArrayList<>();

    public void add(KnowledgeNode node) { children.add(node); }
    public abstract List<String> search(String query);
}

// 叶子节点：具体文档
public class DocumentNode extends KnowledgeNode {
    @Override
    public List<String> search(String query) {
        return milvusService.search(query, this.name);
    }
}

// 组合节点：分类目录
public class CategoryNode extends KnowledgeNode {
    @Override
    public List<String> search(String query) {
        List<String> results = new ArrayList<>();
        for (KnowledgeNode child : children) {
            results.addAll(child.search(query));
        }
        return results;
    }
}
```

---

#### 追问：
- 追问1：KnowledgeNode 的 CategoryNode.search 会递归汇总所有子节点结果，当分类树很深、某子分类在 Milvus 中无数据时会怎样？如何避免一次查询打爆向量库？
  - **答**：递归会把整棵子树展开成大量 Milvus 查询，深树+空数据子分类会造成请求风暴。
    - 优化：
      - ① 在分类节点层做"聚合检索"，一次查询带分类路径过滤，而非逐叶节点查
      - ② 缓存各节点检索结果并带 TTL
      - ③ 对空数据子分类短路返回空，避免无效请求
    - 加并发度限制/批量查询（一次 `search` 多 collection），防止深树造成请求风暴。
- 追问2：组合模式要求叶子与容器节点实现同一接口，如果文档节点需要"更新/删除"而分类节点需要"增删子节点"，统一接口会让单节点被迫实现无意义的空方法，你如何权衡？
  - **答**：这是组合模式的经典痛点（接口膨胀/空实现）。权衡：接口只保留公共的 `search`，更新/删除等差异操作放各自特有接口（如 `WritableNode`），调用方按需 `instanceof` 转换。
    - 或叶子节点实现 `removeChild` 抛 `UnsupportedOperationException`，显式表达不支持。
    - 碳管家场景：检索是共同行为，写操作差异大，宜用"窄接口+类型特定操作"而非强求全统一。

### 12. 享元模式（Token缓存）
**重要度**：★★★

**定义**：运用共享技术有效支持大量细粒度对象。

**AI场景**：碳管家的`TokenCache`——共享相同的Token/嵌入向量，避免重复计算。

```java
public class TokenCache {
    private final Map<String, float[]> embeddingCache = new ConcurrentHashMap<>();

    public float[] getEmbedding(String text) {
        return embeddingCache.computeIfAbsent(text, t -> embeddingModel.embed(t));
    }
}
```

**内部状态vs外部状态**：嵌入向量是内部状态（与文本绑定，可共享），检索时的租户ID是外部状态（不可共享，需传入）。

**Spring中的享元**：Spring Bean默认单例——所有依赖同一Bean的对象共享同一实例，这是享元模式的隐式应用。

---

#### 追问：
- 追问1：TokenCache 用文本做 key 缓存嵌入向量，如果同一段文本因前后空格/换行不同而产生不同 key，缓存命中率会很低，你如何做文本归一化？
  - **答**：入库前对文本做归一化再作 key：去首尾空白、合并多余空格与换行、统一 Unicode（NFKC）、转小写（若语义不区分大小写）。
    - 更稳健：对归一化文本求哈希（SHA-256）作 key，避免超长 key。
    - 注意归一化不能改变语义（如代码/公式大小写敏感处需保留），可在归一化策略上留开关。
- 追问2：享元强调内部状态可共享、外部状态（如租户 ID）要传入，碳管家的嵌入向量是否应该按租户隔离缓存？共享缓存会带来怎样的租户数据泄露风险？
  - **答**：应隔离。嵌入向量虽由文本决定，但"文本含义+检索范围"与租户强相关，共享缓存有越权风险。
    - key 应带 `tenantId` 维度（如 `tenantId + hash(text)`），或每个租户独立缓存命名空间。
    - 共享缓存会导致 A 租户资料被 B 租户检索命中，属数据泄露；但"公共知识库"文本可单独设共享缓存，租户私有内容必须隔离。

#### 行为型模式

### 13. 策略模式（路由策略）
**重要度**：★★★★★

**定义**：定义一系列算法，将每个算法封装起来，使它们可以互相替换。

**AI场景**：碳管家的大模型路由策略——成本优先/速度优先/质量优先/灰度分流，运行时动态切换。

```java
public interface RoutingStrategy {
    String selectModel(ChatRequest request, List<ModelInfo> availableModels);
}

@Component("costFirst")
public class CostFirstStrategy implements RoutingStrategy {
    @Override
    public String selectModel(ChatRequest request, List<ModelInfo> models) {
        return models.stream()
            .min(Comparator.comparing(ModelInfo::getPricePerToken))
            .map(ModelInfo::getModelId)
            .orElse("deepseek-chat");
    }
}

@Component("qualityFirst")   // 兜底策略必须有对应 Bean，否则 getOrDefault 的默认值仍是 null
public class QualityFirstStrategy implements RoutingStrategy {
    @Override
    public String selectModel(ChatRequest request, List<ModelInfo> models) {
        return models.stream()
            .max(Comparator.comparing(ModelInfo::getQualityScore))
            .map(ModelInfo::getModelId)
            .orElse("deepseek-reasoner");
    }
}

// 使用：Spring 自动按 BeanName 注入 Map<String, RoutingStrategy>
@Service
public class RoutingEngine {
    // key 就是 @Component("costFirst") 里的 BeanName（由 DefaultListableBeanFactory.resolveMultipleBeans 装配）
    private final Map<String, RoutingStrategy> strategies;
    private final ModelRegistry registry;
    private final RoutingConfigService configService;

    // 构造器注入：final 字段必须由构造器赋值；Spring 看到参数是 Map<String, XxxStrategy>，
    // 会把容器里所有 XxxStrategy 类型的 Bean 按"BeanName → 实例"装进 Map 传进来，
    // 不需要 @Autowired 标在字段上，也不需要手写注册表。
    public RoutingEngine(Map<String, RoutingStrategy> strategies,
                         ModelRegistry registry,
                         RoutingConfigService configService) {
        this.strategies = strategies;
        this.registry = registry;
        this.configService = configService;
    }

    public String route(ChatRequest request) {
        String strategyName = configService.getRoutingStrategy();
        // 多值依赖允许 0 个候选（注入空 Map 不报错），配置写错时启动期发现不了，必须运行期兜底
        RoutingStrategy strategy = strategies.getOrDefault(strategyName, strategies.get("qualityFirst"));
        if (strategy == null) {
            throw new IllegalStateException("未找到路由策略: " + strategyName);
        }
        return strategy.selectModel(request, registry.list());
    }
}
```

**Spring中的策略**：通过`@Component`注册多个策略实现，通过`Map<String, Strategy>`自动注入，运行时根据配置选择策略。Nacos配置中心可动态切换策略名称。

---

#### 追问：
- 追问1：成本优先/速度优先/质量优先策略如果只按单价或延迟选模型，忽略了"该问题是否适合小模型"，会导致质量崩塌，你会如何把"问题复杂度"也纳入路由决策？
  - **答**：路由决策应多维度打分：先用轻量分类（规则/小模型）估"问题复杂度/风险等级"，简单闲聊走小模型、合规判断走大模型。
    - 把复杂度、单价、延迟、历史质量分加权成 `score`，策略按场景选目标（成本/质量）。
    - 加"回退"：小模型低置信时升级大模型，避免一味省成本牺牲质量。
- 追问2：Nacos 动态切换策略名时，如果新策略类还没加载完成或配置写错，路由会退化成什么行为？如何做策略的兜底与灰度？
  - **答**：`getOrDefault` 只能兜"策略名写错"，兜不住"兜底策略本身没注册"——此时默认值是 `null`，调用 `strategy.selectModel()` 直接 NPE（上面的代码已加显式判空，抛出带策略名的 `IllegalStateException` 并告警，避免 NPE 淹没根因）。兜底策略（如 `qualityFirst`）必须保证有对应 Bean，且启动期用 `@PostConstruct` 校验配置里的策略名在白名单内，把错误前移到启动阶段。
    - 灰度：Nacos 配置支持按租户/比例分流，新策略先小流量（如 5%）验证再全量。
    - 启动期再用 `@PostConstruct` 校验策略名合法性，运行期 + 启动期双保险。
- 追问3：灰度分流策略要把一部分流量切到新模型做 A/B，碳管家该如何采集两路回答的质量指标来判断新模型能否全量？
  - **答**：需可观测的质量评估体系：采集两路回答的延迟、token 成本、用户点赞/点踩，以及自动评分（用强模型按 rubric 打分，或 RAG faithfulness/相关性指标）。
    - 埋点记录 `requestId→group`，离线对比置信区间。
    - 设达标阈值（质量不降、成本更优）才放量，配合人工抽检防止指标作弊。

### 14. 观察者模式（事件监听）
**重要度**：★★★★

**定义**：定义对象间一对多的依赖关系，当一个对象状态改变时，所有依赖者收到通知。

**AI场景**：碳管家的`DocumentUpdateEvent`——知识库文档更新时，通知所有相关子系统（向量索引刷新/缓存清除/告警通知）。

```java
// Spring Event 机制（Spring 4.2+ 推荐写法：事件可为任意 POJO，无需继承 ApplicationEvent）
public class DocumentUpdateEvent {   // 普通 POJO 即可
    private final String docId;
    private final String tenantId;

    public DocumentUpdateEvent(String docId, String tenantId) {
        this.docId = docId;
        this.tenantId = tenantId;
    }
    public String getDocId()   { return docId; }
    public String getTenantId(){ return tenantId; }
}

// 观察者1：向量索引刷新
@Component
public class VectorIndexListener {
    @EventListener
    public void onDocumentUpdate(DocumentUpdateEvent event) {
        milvusService.updateIndex(event.getDocId(), event.getTenantId());
    }
}

// 观察者2：缓存清除
@Component
public class CacheEvictListener {
    @EventListener
    public void onDocumentUpdate(DocumentUpdateEvent event) {
        redisTemplate.delete("rag:cache:" + event.getTenantId());
    }
}

// 发布事件
@Service
public class DocumentService {
    @Autowired private ApplicationEventPublisher publisher;

    public void updateDocument(String docId, String tenantId) {
        publisher.publishEvent(new DocumentUpdateEvent(docId, tenantId));
    }
}
```

> 兼容说明：`extends ApplicationEvent` + `super(source)` 是 **Spring 4.2 之前**的写法，仅为兼容老代码保留；新代码一律用 POJO（`@EventListener` 按参数类型匹配）。要把监听挂在事务提交后执行，用 `@TransactionalEventListener(phase = AFTER_COMMIT)`。

**Spring Event的优势**：解耦发布者和订阅者，支持异步事件（`@Async @EventListener`），支持事务边界事件（`@TransactionalEventListener`）。

---

#### 追问：
- 追问1：DocumentUpdateEvent 触发向量索引刷新和缓存清除是同步执行的，如果索引刷新很慢会阻塞发布方，如何用 @Async 改造并保证事件顺序与最终一致？
  - **答**：给监听器加 `@Async` 让刷新/清缓存异步执行，发布方立即返回。顺序：同文档高频更新用事件队列+按 `docId` 分片串行消费，保证单文档内顺序。
    - 最终一致：用 RabbitMQ/Redis Stream 持久化事件，消费失败重试，保证"至少一次"最终索引与缓存一致。
    - 注意异步后 `DocumentService` 不应假设刷新已完成。
- 追问2：多个监听器都订阅同一事件，其中一个抛出异常，Spring 默认会怎样？其它监听器还会执行吗？如何隔离失败？
  - **答**：默认同一线程内同步执行，某监听器抛异常会中断后续监听器（异常向上抛给发布方），其余监听器不再执行。
    - 隔离：
      - ① 每个监听器加 `@Async` 各自独立线程，互不影响
      - ② 监听器内部 `try/catch` 吞掉非致命异常
      - ③ 用 `@TransactionalEventListener` 分离事务边界
    - 关键业务（索引刷新）失败应进重试/死信，不能静默。

### 15. 责任链模式（过滤器链）
**重要度**：★★★★

**定义**：将请求的发送者和接收者解耦，使多个对象都有机会处理请求。

**AI场景**：碳管家的`ChatRequestFilterChain`——AI对话请求经过多个过滤器（鉴权→限流→Prompt校验→敏感词过滤→RAG检索增强→模型调用）。

```java
public abstract class ChatRequestFilter {
    protected ChatRequestFilter next;

    public ChatRequestFilter setNext(ChatRequestFilter next) {
        this.next = next;
        return next;
    }

    public abstract ChatResponse doFilter(ChatRequest request);
}

// 鉴权过滤器
public class AuthFilter extends ChatRequestFilter {
    @Override
    public ChatResponse doFilter(ChatRequest request) {
        if (!authService.validate(request.getToken())) {
            return ChatResponse.error("鉴权失败");
        }
        return next != null ? next.doFilter(request) : null;
    }
}

// 组装责任链
ChatRequestFilter chain = new AuthFilter();
chain.setNext(new RateLimitFilter())
     .setNext(new SensitiveWordFilter())
     .setNext(new RagEnhanceFilter())
     .setNext(new ModelCallFilter());
ChatResponse response = chain.doFilter(request);
```

**Spring中的责任链**：Spring Cloud Gateway的`GlobalFilter`链、Spring Security的`FilterChainProxy`都是责任链模式。

---

#### 追问：
- 追问1：鉴权→限流→Prompt校验→敏感词过滤→RAG增强→模型调用这条链，其中 RAG 增强是耗时步骤，把它放在敏感词过滤之前还是之后更合理？为什么？
  - **答**：建议"敏感词过滤在前、RAG 增强在后"。理由：先拦截违规/敏感提问，避免对违规请求浪费昂贵的向量检索+大模型算力。
    - 对用户可见的"拒绝"应尽早返回。
    - 但 RAG 结果也可能含敏感内容，所以"输出侧"还需再过滤一层，形成入口+出口双重校验。
- 追问2：如果某个过滤器需要根据前序过滤器的处理结果"短路"整条链（如限流直接返回），责任链模式如何在不破坏链结构的前提下传递短路信号？
  - **答**：责任链天然支持短路——过滤器不调用 `next.doFilter()` 即终止。关键在于返回值：`AuthFilter`/`RateLimitFilter` 直接 `return ChatResponse.error(...)` 且不调 `next`，链即停。
    - 用统一的 `ChatResponse`（含 status）表达"已终止"，调用方拿到非 null 即不再继续。
    - 无需特殊信号对象，控制好"何时调用 next"即可。
- 追问3：碳管家想在不重启服务的情况下动态增删过滤器（如临时加一个合规审查过滤器），基于 Spring 的责任链该如何做到配置化、可热更新？
  - **答**：把过滤器定义为 Spring Bean 并带 `order` 与 `enabled` 配置（存 DB/配置中心）。
    - 链组装由 `FilterChainBuilder` 在每次请求（或监听配置变更）按 `enabled+order` 重新排序组装，或用 `ApplicationListener<RefreshEvent>` 在 Nacos 变更时重建链。
    - 注意热更新线程安全：用 `volatile` 引用整条链，原子替换。

### 16. 模板方法模式（AI调用模板）
**重要度**：★★★★

**定义**：定义算法骨架，将某些步骤延迟到子类实现。

**AI场景**：碳管家的`AbstractChatTemplate`——定义RAG问答的固定流程（检索→构建Prompt→调用模型→解析结果），子类只需实现具体步骤。

```java
public abstract class AbstractChatTemplate {
    // 模板方法：定义固定流程
    public final String chat(String question, String tenantId) {
        List<String> docs = retrieve(question, tenantId);
        String prompt = buildPrompt(question, docs);
        String rawResponse = callModel(prompt);
        return parseResponse(rawResponse);
    }

    protected abstract List<String> retrieve(String question, String tenantId);
    protected abstract String buildPrompt(String question, List<String> docs);
    protected abstract String callModel(String prompt);
    protected abstract String parseResponse(String rawResponse);
}

// 法规问答子类
public class RegulationChatTemplate extends AbstractChatTemplate {
    @Override
    protected List<String> retrieve(String question, String tenantId) {
        return ragService.searchRegulation(question, tenantId);
    }
    @Override
    protected String buildPrompt(String question, List<String> docs) {
        return "你是碳法规专家。参考资料：" + docs + "。问题：" + question;
    }
}
```

**Spring中的模板方法**：`AbstractApplicationContext.refresh()`定义了容器刷新的12步固定流程，`RestTemplate`/`JdbcTemplate`也使用了模板方法思想。

---

#### 追问：
- 追问1：AbstractChatTemplate.chat() 是 final 固定流程，如果某个子类（如闲聊）不想做 RAG 检索，模板方法的"钩子方法(hook)"该如何设计而非强行覆盖？
  - **答**：用"钩子方法(hook)"而非强行覆盖 `final` 流程：在模板中把 `retrieve` 设为可空钩子（如 `protected boolean needRetrieve(){return true;}`），`chat()` 里 `if(needRetrieve()) docs=retrieve(...)`。
    - 闲聊子类覆写 `needRetrieve()` 返回 false，并覆写 `buildPrompt` 忽略 docs。
    - 保持 `chat()` 流程不变，子类只控制"是否/如何"做某步，符合模板方法意图。
- 追问2：模板方法把流程写死在父类，如果未来要在"调用模型"前后统一加 Token 计量，是改父类模板还是用装饰器/AOP 更合适？为什么？
  - **答**：优先 AOP/装饰器，不动父类模板。原因：Token 计量是横切关注点，改父类会让所有子类强耦合计量逻辑、且破坏"模板只管流程"的单一职责。
    - 用 `@Around` 切面或 `TokenCountDecorator` 包 `callModel`，对子类透明、可热插拔。
    - 若计量逻辑与流程强绑定且所有子类都需要，才考虑下沉模板（仍建议用钩子 `beforeModel/afterModel`）。

### 17. 命令模式
**重要度**：★★★

**定义**：将请求封装为对象，使请求可参数化、排队、记录、撤销。

**AI场景**：碳管家的`ChatCommand`——将AI对话请求封装为命令对象，支持命令队列、延迟执行、命令日志。

```java
public interface ChatCommand {
    String execute();
    void undo();
}

public class RegulationQueryCommand implements ChatCommand {
    private final String question;
    private final String tenantId;
    private String result;

    @Override
    public String execute() {
        result = chatService.askRegulation(question, tenantId);
        return result;
    }

    @Override
    public void undo() {
        conversationService.deleteLastConversation(tenantId);
    }
}

// 命令调度器
@Service
public class CommandScheduler {
    private final Queue<ChatCommand> commandQueue = new LinkedBlockingQueue<>();

    public void submit(ChatCommand command) { commandQueue.offer(command); }
    public String processNext() {
        ChatCommand command = commandQueue.poll();
        return command != null ? command.execute() : null;
    }
}
```

---

#### 追问：
- 追问1：ChatCommand 的 undo() 删除最后一轮对话，但如果命令执行过程中已经写入了数据库和向量库，undo 如何做到真正的"可撤销"而不留脏数据？
  - **答**：命令需记录"撤销所需补偿信息"，undo 不只是删对话：实现补偿事务，undo 时回滚 DB 写入（`delete` 对应记录）、撤回向量库插入（`milvusService.delete(ids)`），用事务保证原子。
    - 更稳健：事件溯源下追加"反向事件"而非删历史。
    - 若写入跨多系统，用 Saga/本地事务表保证最终一致，避免半撤销脏数据。
- 追问2：CommandScheduler 用内存队列，服务重启后未执行的命令会丢失，碳管家若要求命令不丢，应如何结合持久化与重试？
  - **答**：把命令持久化到 MySQL/Redis 后再入队：提交命令时先 `INSERT` 命令表（status=PENDING），再由调度器取出执行，执行完改 `DONE`。
    - 重启后扫描 `PENDING` 命令重放，结合指数退避重试。
    - 失败超限进死信表人工处理；也可用 RabbitMQ 持久化队列替代内存队列，天然防丢。

### 18. 状态模式（会话状态）
**重要度**：★★★

**定义**：允许对象在内部状态改变时改变行为。

**AI场景**：碳管家的`SessionState`——AI会话有不同状态（初始/活跃/等待人工/已结束），不同状态下行为不同。

```java
// 状态接口
public interface SessionState {
    String handleMessage(SessionContext context, String message);
}

// 活跃状态：正常AI对话
public class ActiveState implements SessionState {
    @Override
    public String handleMessage(SessionContext context, String message) {
        return aiService.chat(message, context.getTenantId());
    }
}

// 等待人工状态
public class WaitingHumanState implements SessionState {
    @Override
    public String handleMessage(SessionContext context, String message) {
        return humanAgentService.forwardMessage(context, message);
    }
}

// 已结束状态
public class EndedState implements SessionState {
    @Override
    public String handleMessage(SessionContext context, String message) {
        return "会话已结束，请重新发起对话";
    }
}

// 会话上下文
public class SessionContext {
    private SessionState state = new ActiveState();

    public String handleMessage(String message) {
        return state.handleMessage(this, message);
    }
    public void setState(SessionState state) { this.state = state; }
}
```

**状态流转**：Active → (检测到需要人工) → WaitingHuman → (人工结束) → Ended → (用户重新提问) → Active

---

#### 追问：
- 追问1：SessionContext 状态切换（Active→WaitingHuman→Ended）由谁触发？如果状态流转条件散落在多处 if 里，状态模式相比简单的状态字段枚举还有什么优势？
  - **答**：切换应由状态对象自身在 `handleMessage` 里根据结果 `context.setState(...)` 触发（自驱动），而非外部 if。优势：把"状态+该状态下的行为+转移条件"内聚到状态类，消除分散 if，新增状态只加类不改旧代码。
    - 比裸枚举+switch 更 OO、易测试、转换逻辑不易遗漏。
- 追问2：碳管家的会话状态需要落库以支持断线重连，状态对象（如 ActiveState）能不能直接序列化？如何设计状态与上下文的持久化？
  - **答**：状态对象通常是无状态行为类（ActiveState 无字段），不应序列化"行为"，应序列化"状态标识+上下文数据"。持久化只存 `stateName`（如"ACTIVE"）和 `SessionContext` 的业务数据（messages、tenantId）。
    - 重连时按 `stateName` 反查注册表重建状态对象（状态用枚举/工厂重建，不序列化实例）。
    - Spring 可用 `@Enumerated` 存状态，上下文 JSON 化存 MySQL。

### 19. 访问者模式
**重要度**：★★★

**定义**：表示一个作用于某对象结构中各元素的操作，使操作可在不改变各元素类的前提下定义新操作。

**AI场景**：碳管家的`CarbonDataVisitor`——不同角色（合规检查员/报告生成器/数据分析师）对同一碳排放数据执行不同操作。

```java
public interface CarbonDataElement {
    void accept(CarbonDataVisitor visitor);
}

public class EmissionRecord implements CarbonDataElement {
    private double value;
    private String unit;

    @Override
    public void accept(CarbonDataVisitor visitor) { visitor.visit(this); }
}

public class EmissionFactor implements CarbonDataElement {
    private double factorValue;

    @Override
    public void accept(CarbonDataVisitor visitor) { visitor.visit(this); }
}

public interface CarbonDataVisitor {
    void visit(EmissionRecord record);
    void visit(EmissionFactor factor);
}

// 合规检查访问者
public class ComplianceCheckVisitor implements CarbonDataVisitor {
    @Override
    public void visit(EmissionRecord record) { complianceEngine.check(record); }
    @Override
    public void visit(EmissionFactor factor) { versionChecker.check(factor); }
}
```

---

#### 追问：
- 追问1：CarbonDataVisitor 每新增一种数据类型（如 EmissionRecord2），所有访问者都要加一个 visit 方法，这与"对扩展开放"是否矛盾？什么场景下访问者反而得不偿失？
  - **答**：这是访问者模式的固有代价——它"对新增操作开放（加 Visitor 易）、对新增元素封闭差（加元素要改所有 Visitor）"，与开闭原则在"元素维度"上有张力。
    - 得不偿失场景：数据类型频繁变动、操作少而稳定时，可改用 `instanceof`+策略，或 Visitor 只做可选能力探测（`instanceof` 降级）。
    - 碳管家若角色多、数据类型稳定，访问者仍划算。
- 追问2：访问者的 visit 方法里如果需要根据数据元素的运行时类型做不同处理，双分派在 Java 单分派下是如何通过 accept/visit 两次调用实现的？
  - **答**：Java 是单分派（重载在编译期按静态类型定），靠"两次调用"模拟双分派。第一次：`element.accept(visitor)`——按 `element` 实际类型分派到具体 `accept`；第二次：accept 内部 `visitor.visit(this)`——`this` 是具体元素类型，编译期绑定到对应 `visit(ConcreteElement)` 重载。
    - 两次动态绑定叠加，实现"按元素类型+访问者类型"双重分派。

### 20. 备忘录模式
**重要度**：★★

**定义**：在不破坏封装性的前提下，捕获对象内部状态，以便以后恢复。

**AI场景**：碳管家的`ConversationMemento`——保存AI会话的关键状态，支持回退到之前的对话分支。

```java
public class ConversationMemento {
    private final List<Message> messages;
    private final String currentIntent;
    private final int tokenCount;

    public static ConversationMemento save(SessionContext context) {
        return new ConversationMemento(
            new ArrayList<>(context.getMessages()),
            context.getCurrentIntent(),
            context.getTokenCount());
    }

    public void restore(SessionContext context) {
        context.setMessages(new ArrayList<>(messages));
        context.setCurrentIntent(currentIntent);
        context.setTokenCount(tokenCount);
    }
}
```

**实际应用**：当AI对话进入"试探性分支"，保存当前状态快照，若分支走不通则回退到快照点重新探索。

---

#### 追问：
- 追问1：ConversationMemento 保存了 messages、currentIntent、tokenCount，如果会话里有上十万条消息，频繁保存快照会带来怎样的性能与内存开销？如何做增量快照？
  - **答**：全量快照每次拷贝十万级 `Message` 列表，内存与 GC 压力大、保存慢。增量快照：只存"自上一快照以来的 delta"（新增消息），恢复时从最近 full 快照+重放 delta。
    - 或限制快照粒度（按对话轮次/Token 阈值触发），而非每轮都存。
    - 快照存 Redis/落盘而非 JVM 堆，超长会话只保留最近 N 轮+归档历史。
- 追问2：备忘录恢复会把当前会话整体替换回快照，如果用户在快照之后已经产生了"有用"的新对话，盲目回退会丢失这些，碳管家应如何让用户选择回退范围？
  - **答**：不强制整体回退，提供"选择性/分支式"恢复：保存多个快照点（带时间戳/轮次标签），用户选具体回退到哪。
    - 用"对话分支树"而非线性覆盖——新对话作为分支保留，回退时切回旧分支而非删新内容。
    - UI 上展示分支供用户选择，备忘录只负责存/取，回退策略交给前端/会话管理。

### 21. 中介者模式
**重要度**：★★★

**定义**：用一个中介对象封装一系列对象的交互，使各对象不需要显式引用。

**AI场景**：碳管家的`AgentMediator`——多个Agent之间的协作由中介者协调，Agent间不直接通信。

```java
public class AgentMediator {
    private final Map<String, Agent> agents = new HashMap<>();

    public void registerAgent(String name, Agent agent) { agents.put(name, agent); }
    public Object dispatchTo(String agentName, Object input) {
        return agents.get(agentName).execute(input);
    }

    // 协调：法规检索 → 数据校验 → 合规判断 → 报告生成
    public ComplianceReport runComplianceCheck(String question) {
        String regulation = (String) dispatchTo("regulationAgent", question);
        Boolean isValid = (Boolean) dispatchTo("validationAgent", regulation);
        String judgment = (String) dispatchTo("complianceAgent", isValid);
        return (ComplianceReport) dispatchTo("reportAgent", judgment);
    }
}
```

---

#### 追问：
- 追问1：AgentMediator 把"法规检索→数据校验→合规判断→报告生成"硬编码在 runComplianceCheck 里，如果流程要随业务变化调整顺序或插入新 Agent，中介者本身会不会变成难以维护的中心？
  - **答**：会——硬编码流程让中介者膨胀成难以维护的中心。把流程"数据化"而非硬编码：用配置描述 Agent 执行图（DAG/步骤列表：节点+顺序+条件），中介者按配置驱动，新增/调序只改配置。
    - 或中介者退化为"轻量编排器"，每个 Agent 暴露能力，流程由规则引擎/工作流（如 Flowable）定义。
    - 碳管家可把编排逻辑外置到配置中心，避免中介者膨胀成上帝类。
- 追问2：多个 Agent 经中介者协作时，如何避免某个 Agent 执行慢导致整条链路阻塞？是否需要在中介者里引入超时与熔断？
  - **答**：中介者对每个 `dispatchTo` 调用加超时与熔断：用 `CompletableFuture`+`orTimeout`/`completeOnTimeout` 限制单 Agent 耗时，超时降级到默认结果。
    - 接入 Resilience4j 熔断，某 Agent 连续失败则快速失败不拖累链路。
    - 对可并行的 Agent 步骤用 `CompletableFuture.allOf` 并发执行，缩短关键路径。
- 追问3：相比于让 Agent 直接通过消息队列（如 RabbitMQ）通信，中介者模式在碳管家的多 Agent 场景下牺牲了什么（如横向扩展、异步解耦）？
  - **答**：中介者在进程内同步编排，牺牲：
    - ① 横向扩展——Agent 必须同进程，无法跨节点分布
    - ② 异步解耦——调用是同步阻塞，无削峰填谷、无天然重试/持久化
    - ③ 容错——单点中介者故障整链挂
    - MQ 方案用消息解耦、可持久化、天然支持重试与多消费者，但增加延迟与运维成本。
    - 碳管家轻量编排用中介者，重/跨服务协作用 MQ。

### 22. 解释器模式
**重要度**：★★★

**定义**：给定一种语言，定义其文法表示和解释器。

**AI场景**：碳管家的`CarbonQueryInterpreter`——将用户自然语言查询解释为结构化检索条件。

```java
public class CarbonQueryInterpreter {
    private final Map<String, String> keywordMap = Map.of(
        "碳排放因子", "emission_factor",
        "碳足迹", "carbon_footprint",
        "钢铁", "steel",
        "化工", "chemical"
    );

    public SearchCriteria interpret(String naturalQuery) {
        SearchCriteria criteria = new SearchCriteria();
        for (Map.Entry<String, String> entry : keywordMap.entrySet()) {
            if (naturalQuery.contains(entry.getKey())) {
                criteria.addFilter(entry.getValue());
            }
        }
        Pattern yearPattern = Pattern.compile("(\\d{4})年");
        Matcher matcher = yearPattern.matcher(naturalQuery);
        if (matcher.find()) {
            criteria.setYear(Integer.parseInt(matcher.group(1)));
        }
        return criteria;
    }
}
```

---

#### 追问：
- 追问1：CarbonQueryInterpreter 用关键词包含匹配，"碳排放因子"和"碳排放"会同时命中，造成过滤条件误加，如何提升文法匹配的精确度？
  - **答**：包含匹配无词边界会误命中。改进：用最长匹配优先（先匹配"碳排放因子"再排除其子串）、或基于分词（IK/HanLP）做精确词命中而非子串。
    - 用正则词边界（中文用前后非汉字判断）避免部分重叠。
    - 或按"已命中关键词互斥表"去重（命中因子则不再算裸碳排放），提升文法精确度。
- 追问2：解释器模式为每种语法规则建一个类，当查询语言变复杂（嵌套条件、或/非），类数量会爆炸，碳管家是否会改用表达式引擎或 DSL 解析器替代？
  - **答**：会。规则复杂到嵌套/或并非时，手写解释器类数爆炸、难维护。改用表达式引擎（如 AviatorScript/SpEL/MVEL）或 DSL 解析器（ANTLR）描述查询条件，规则以数据/脚本存储。
    - 碳管家可把查询语言做成配置化表达式，运行时由引擎求值，既灵活又避免类膨胀。
    - 解释器模式适合文法稳定简单的场景，复杂文法交给成熟引擎。

### 23. 迭代器模式
**重要度**：★★★

**定义**：提供一种方法顺序访问聚合对象中的元素，不暴露其内部表示。

**AI场景**：碳管家的`DocumentChunkIterator`——遍历知识库中的海量文档分块，支持分页、懒加载。

```java
public class DocumentChunkIterator implements Iterator<DocumentChunk> {
    private final String collectionName;
    private int offset = 0;
    private final int batchSize = 100;
    private List<DocumentChunk> currentBatch;
    private int currentIndex = 0;

    @Override
    public boolean hasNext() {
        if (currentIndex < currentBatch.size()) return true;
        currentBatch = milvusService.queryBatch(collectionName, offset, batchSize);
        offset += batchSize;
        currentIndex = 0;
        return !currentBatch.isEmpty();
    }

    @Override
    public DocumentChunk next() { return currentBatch.get(currentIndex++); }
}
```

---

#### 追问：
- 追问1：DocumentChunkIterator 用 hasNext 里懒加载下一批，如果某批查询 Milvus 失败，迭代器会抛异常导致遍历中断，如何支持失败重试与断点续遍历？
  - **答**：把"取批"异常局部化、支持重试与断点：hasNext 内捕获查询异常，按指数退避重试 N 次，仍失败则抛"可恢复异常"或标记 `failed` 由调用方决定（如跳过/停止）。
    - 记录 `offset`/`lastSuccessId` 作为续遍历游标，重启后从该点继续而非从头。
    - 可把遍历任务持久化（如任务表+checkpoint），失败恢复不丢进度。
- 追问2：迭代器遍历海量分块做批量向量化时，如果遍历过程中知识库被更新（新增/删除文档），迭代器看到的集合还会一致吗？如何保证快照一致性？
  - **答**：不一致——实时查询会看到新增/删除，导致重复处理或漏处理。保证快照：遍历前记录集合的"版本/时间戳快照"（如 Milvus 按 `collection`+`snapshotTs` 过滤或 `create_time<=snapshotTs`），只处理快照点前的数据。
    - 或用游标分批+固定上界，新增文档另起遍历任务。
    - 也可在向量化期间对集合加"只读/冻结"标记，完成后解冻。

#### 扩展模式

### 24. 空对象模式
**重要度**：★★★

**定义**：提供一个不做任何操作的对象替代null，避免null检查。

**AI场景**：碳管家的`NullChatClient`——当模型服务不可用时，返回空对象而非null。

```java
public class NullChatClient implements ChatClient {
    @Override
    public String call(String prompt) { return "AI服务暂不可用，请稍后重试"; }
    @Override
    public Flux<String> stream(String prompt) { return Flux.just("AI服务暂不可用"); }
}

// 使用：无需null检查
ChatClient client = modelAvailable ? realClient : new NullChatClient();
String response = client.call(prompt);
```

---

#### 追问：
- 追问1：NullChatClient 返回"AI服务暂不可用"，但如果调用方依赖返回的 Flux 流做后续处理，空对象返回的 Flux.just(...) 与真实流式语义是否一致？会有什么隐患？
  - **答**：不一致。真实流是逐 token、有背压、可取消的多元素流；`Flux.just(单条)` 是"一次性吐出整句"，无中间 emit、无真正流式体验。
    - 隐患：上游若依赖逐 token 渲染/统计，空对象会破坏节奏；且 `just` 无法模拟错误/完成信号差异。
    - 更贴近语义应返回 `Flux.error`(降级) 或 `Flux.fromIterable(按字切)`，至少保持"多元素流"形态，前端逻辑统一。
- 追问2：空对象与直接抛异常（Fail-Fast）两种策略，在碳管家的对外 API 与内部批处理场景下分别该选哪种？
  - **答**：看"能否恢复/是否应中断"。对外 API：用空对象降级，返回友好提示而非 500，保证可用性（如模型不可用给兜底话术）。
    - 内部批处理：用 Fail-Fast 抛异常，立即暴露问题、避免脏数据扩散、便于重试/告警。
    - 可结合：批处理用异常中断+死信，在线问答用空对象兜底。

### 25. 对象池模式
**重要度**：★★★

**定义**：复用昂贵对象，避免频繁创建销毁。

**AI场景**：碳管家的`ConnectionPool`——大模型API连接池，复用HTTP连接。

**设计思路（口头表述）**：对象池模式复用"创建昂贵"的对象，避免频繁 new + GC。碳管家场景：大模型 API 的 HTTP 连接（建连含 TLS 握手很贵），借出来用、用完还回去，而不是每次请求新建。关键设计：
  - ① borrow 时池空或对象失效就新建、return 时池满或对象失效就关闭，保证池里都是活对象
  - ② maxPoolSize 限上限防资源耗尽（如 50 个连接对齐 Provider RPM）
  - ③ 用 ConcurrentLinkedQueue 无锁并发安全
  - Spring 里的 HikariCP、HttpClient 连接池都是这个模式。一句话："贵的对象借还复用，池满/失效就关，并发用无锁队列"。

```java
public class ModelConnectionPool {
    private final Queue<ModelConnection> pool = new ConcurrentLinkedQueue<>();
    private final int maxPoolSize = 50;

    public ModelConnection borrowConnection() {
        ModelConnection conn = pool.poll();
        if (conn == null || !conn.isAlive()) { conn = createNewConnection(); }
        return conn;
    }

    public void returnConnection(ModelConnection conn) {
        if (pool.size() < maxPoolSize && conn.isAlive()) { pool.offer(conn); }
        else { conn.close(); }
    }
}
```

**Spring中的对象池**：`HttpClient`连接池、`DataSource`连接池（HikariCP）都是对象池模式。

---

#### 追问：
- 追问1：ModelConnectionPool 的 borrowConnection 在池空时新建连接，没有上限控制（只 return 时检查 maxPoolSize），高并发下连接数会失控，如何改成获取时也限流/阻塞？
  - **答**：获取时应受上限约束：用 `Semaphore` 控制最大并发连接数，池空且未达上限则新建，达上限则 `acquire` 阻塞（或带超时 `tryAcquire`）。
    - 或 `borrow` 时判断 `activeCount < maxPoolSize` 否则等待/拒绝，避免无限制新建。
    - 结合连接最大空闲回收，防泄漏堆积。
- 追问2：大模型 API 连接是 HTTP 长连接还是短连接？对象池复用连接时如何处理服务端主动断开、token 过期等"连接已失效"情况？
  - **答**：大模型流式调用多用 HTTP/2 或带 `keep-alive` 的长连接（SSE/流式），底层 HTTP 客户端（WebClient+连接池）复用 TCP。处理失效：borrow 时校验 `isAlive()`/`lastUsedTime`，超阈值或检测到断开则丢弃重建。
    - token 过期：连接本身不直接带 token（请求头携带），token 失效由调用层刷新后重发，连接可继续复用（只要 TCP 未断）。
    - 加心跳/失败重建机制。
- 追问3：如果碳管家同时对接 10 个模型，是每个模型一个独立连接池还是共享一个池？连接池数量与大小该如何根据各自 QPS 与限流配额来配置？
  - **答**：按模型隔离——每个模型独立连接池。理由：各模型 QPS、限流配额、endpoint、超时不同，共享池会互相挤占、难调优。
    - 大小配置：按各模型 `配额QPS×平均RT` 估算（池大小≈并发峰值），如 deepseek 配额高可设大、小模型设小。
    - 总连接数受容器/文件句限，需全局上限+监控，避免打满本地端口。

### 26. 回调模式
**重要度**：★★★

**定义**：将函数/方法作为参数传递，由被调用方在适当时机回调。

**AI场景**：碳管家的流式响应处理——大模型每生成一个Token就回调处理函数。

```java
public interface StreamCallback {
    void onNext(String token);
    void onComplete(String fullResponse);
    void onError(Exception e);
}

@Service
public class StreamingChatService {
    public void streamChat(String prompt, StreamCallback callback) {
        chatClient.stream(prompt)
            .subscribe(callback::onNext, callback::onError,
                () -> callback.onComplete(collectFullResponse()));
    }
}
```

---

#### 追问：
- 追问1：StreamCallback 的 onNext 每收到一个 token 就回调，如果前端断连（客户端取消订阅），回调链如何感知并停止向大模型拉流以免浪费配额？
  - **答**：订阅取消要传播到上游。用响应式 `Disposable`/`Cancellation`：前端断连触发 `subscription.cancel()`，WebClient/SSE 的 `subscribe` 拿到取消信号后停止请求（HTTP 断流）。
    - 在 `onNext` 前检查 `isDisposed()`/前端连接状态，已断则不再向大模型拉流。
    - 关键：回调链要持有并正确传播 `cancel`，否则会继续消耗 token 配额。
- 追问2：回调模式中 onError 与 onComplete 的语义顺序在响应式流里有何保证？如果 onNext 抛异常，onComplete 还会被调用吗？
  - **答**：响应式流规范（Reactive Streams）：`onError` 与 `onComplete` 互斥，二者至多一个且为终止信号；`onNext` 抛异常视为错误，会转为 `onError` 并终止序列，`onComplete` 不会被调用。
    - 即 `onNext` 异常→序列以 `onError` 结束，不会再有 `onComplete`。
    - 实现上要保证 `onError`/`onComplete` 只调一次，避免"已完成又报错"的非法状态。

### 27. 发布-订阅模式
**重要度**：★★★★

**定义**：发布者和订阅者通过事件总线解耦通信。

**与观察者的区别**：发布-订阅通过事件总线解耦，发布者和订阅者互不知道对方；观察者模式中观察者直接注册到被观察者。

Spring Event + RabbitMQ是碳管家中发布-订阅的典型实现：本地事件用Spring ApplicationEvent，跨服务事件用RabbitMQ。

---

#### 追问：
- 追问1：碳管家"本地用 Spring Event、跨服务用 RabbitMQ"，一条文档更新事件既要本地清缓存又要跨服务通知，如何保证本地事务提交与消息发布的原子性（避免缓存清了但消息没发）？
  - **答**：经典"本地事务+可靠消息"问题。方案：事务内先写"消息表"(OUTBOX)，事务提交后由独立线程/定时任务读取并发布到 RabbitMQ（事务消息/Outbox 模式）。
    - 或用 RabbitMQ 事务/Spring `TransactionSynchronization` 在事务提交后发消息。
    - 保证：本地提交成功才发 MQ，失败则不发，避免"缓存清了消息没发"的不一致。
- 追问2：RabbitMQ 消费者处理文档更新事件失败（如向量库写入超时），如何做重试与死信队列，避免事件丢失？
  - **答**：启用重试+死信队列(DLQ)。消费者用 `@RabbitListener` 配置 `retry` 次数与退避，失败后重入队。
    - 超过最大重试投递到 DLX→DLQ，消息不丢、可人工/定时复盘。
    - 处理要幂等（同 docId 重复消费安全），避免重试造成重复索引。
- 追问3：发布-订阅相比观察者模式解耦了发布订阅双方，但引入了消息中间件的运维与一致性成本，碳管家哪些事件适合走 MQ、哪些只需本地事件？
  - **答**：按"是否跨服务/是否需要持久异步"划分。走 MQ：跨服务通知（文档更新通知其他微服务、审计上报、AI 结果异步落库）、需削峰/可靠投递的（批量索引）。
    - 本地事件(Spring Event)：同进程内、低延迟、可同步的处理（清本地缓存、更新内存状态）。
    - 原则：进程内解耦用 Event，跨进程可靠通信才上 MQ，避免过度引入中间件。

### 28. 装配器模式
**重要度**：★★★

**定义**：将多个组件按配置组装成完整系统。

**AI场景**：Spring AI的`ChatClient.Builder`——将System Prompt、User Prompt、Tools、Advisors等组件装配成完整的ChatClient。

```java
ChatClient client = ChatClient.builder(chatModel)
    .defaultSystem("你是碳管理专家助手")
    .defaultTools(calculateCarbonFootprintTool, queryEmissionFactorTool)  // ToolCallback / @Tool 对象；defaultFunctions 自 1.0.0-M6 废弃、M7 移除
    .defaultAdvisors(new QuestionAnswerAdvisor(ragService))
    .build();
```

Spring IoC容器本身就是装配器——根据配置将各Bean组装成完整应用。

---

#### 追问：
- 追问1：ChatClient.Builder 把 System Prompt、Functions、Advisors 装配成 ChatClient，如果某个 Advisor（如 QuestionAnswerAdvisor）依赖的 RagService 还没初始化完成，装配期还是运行期暴露问题更友好？
  - **答**：装配期（构建时）暴露更友好。Builder 在 `build()` 时应校验依赖非空/已就绪，缺依赖立即抛清晰异常（fail-fast），避免"构建成功运行才 NPE"。
    - 用构造器注入+Spring 生命周期（`@PostConstruct`/`SmartInitializingSingleton`）确保 `RagService` 先就绪再装配。
    - 运行期才暴露会拖到第一次调用，排查成本高、影响线上。
- 追问2：装配器模式与外观模式都在"组合组件"，碳管家里用 Builder 装配 ChatClient、用 Facade 封装问答流程，两者的职责边界如何区分？
  - **答**：关注点不同。装配器(Builder)：关注"对象如何被构造"——把配置/组件组合成一个可用的 ChatClient 实例（产物是组件）。
    - 外观(Facade)：关注"业务如何被编排"——把 RAG+LLM 等子系统串成一次完整问答（产物是业务流程）。
    - Builder 产出被 Facade 使用，二者是"造工具"与"用工具干活"的层次区别。

### 29. 规约模式
**重要度**：★★★

**定义**：将业务规则封装为可组合的规约对象。

**AI场景**：碳管家的`ComplianceSpecification`——合规检查规则可组合。

**设计思路（口头表述）**：规约模式把"业务规则"封装成对象（实现 `isSatisfiedBy` 接口），让规则能像积木一样用 and/or/not 组合，而不是写一堆 if-else。碳管家合规检查场景："排放值在 0-100"是一个规约、"通过 ISO 认证"是另一个，组合起来就是复杂合规判定。关键设计：
  - ① 每条规则是独立可测对象，新增规则不改老逻辑（开闭原则）
  - ② and/or 用 lambda 组合，规则可运行时动态拼接
  - ③ 规则与数据解耦，同一套规约既能校验单条也能批量校验
  - 一句话："把 if-else 规则提成可组合对象，规则像积木拼搭"。

```java
public interface ComplianceSpecification {
    boolean isSatisfiedBy(EmissionData data);
    ComplianceSpecification and(ComplianceSpecification other);
}

public class ValueRangeSpecification implements ComplianceSpecification {
    private final double min, max;

    @Override
    public boolean isSatisfiedBy(EmissionData data) {
        return data.getValue() >= min && data.getValue() <= max;
    }

    @Override
    public ComplianceSpecification and(ComplianceSpecification other) {
        return data -> this.isSatisfiedBy(data) && other.isSatisfiedBy(data);
    }
}

// 组合规约
ComplianceSpecification spec = new ValueRangeSpecification(0, 100)
    .and(new TimeValiditySpecification())
    .and(new IndustryMatchSpecification("steel"));
boolean compliant = spec.isSatisfiedBy(emissionData);
```

---

#### 追问：
- 追问1：ComplianceSpecification 用 and 组合规约，如果组合链很长（十几个规则），短路求值与失败原因收集如何兼顾（既快又知道哪条不满足）？
  - **答**：默认 `&&` 会短路但不收集原因，需自定义。`isSatisfiedBy` 返回 `Result{passed, failedReasons}` 而非 bool，组合时用 `and` 累加快短（遇 false 仍继续收集其余，或按需短路）。
    - 或提供 `explain()` 返回所有不满足项，便于运营看"哪条不合规"。
    - 短路保证性能，收集保证可解释，二者通过返回结构而非纯 bool 兼顾。
- 追问2：规约模式把规则做成对象便于组合，但规则需要可配置（运营在后台改阈值），是把规约对象序列化存储，还是用规则引擎（如 Drools）更合适？
  - **答**：运营频繁改阈值，用规则引擎/配置化更合适。把阈值存 DB/配置中心，规约读取配置求值，序列化"对象"易失配且不可读。
    - 复杂组合规则用 Drools/表达式引擎以 DSL 管理，运营后台直接改规则。
    - 简单阈值类可用"规约读配置"轻量实现；碳管家合规规则多变，推荐规则引擎+配置热更新。

### 30. 事件溯源模式
**重要度**：★★★★

**定义**：不存储当前状态，而是存储所有变更事件，通过回放事件重建状态。

**AI场景**：碳管家的对话历史——存储每轮对话事件，回放事件重建完整会话。

```java
public class ConversationEventStore {
    private final List<ConversationEvent> events = new ArrayList<>();

    public void append(ConversationEvent event) { events.add(event); }

    public SessionContext rebuild(String sessionId) {
        SessionContext context = new SessionContext();
        events.stream()
            .filter(e -> e.getSessionId().equals(sessionId))
            .forEach(e -> e.apply(context));
        return context;
    }
}
```

**优势**：完整审计日志、可回退到任意时间点、支持时间旅行查询。

---

#### 追问：
- 追问1：ConversationEventStore 用事件回放重建会话，如果事件累积到百万级，每次重建都从头回放会很慢，如何做周期性快照+增量回放？
  - **答**：用"快照+增量回放"降低重建成本。定期（如每 1000 事件/每轮）保存会话快照（full state），重建时先加载最近快照再只回放其后事件。
    - 快照与事件同存（MySQL/对象存储），按 `snapshotId` 定位。
    - 可配合事件归档（冷数据移出热表），百万级只需回放近期增量，秒级重建。
- 追问2：事件溯源下"修改/删除"不能改历史事件，只能追加反向事件，碳管家若需要合规审计的不可篡改性与用户"撤回消息"的体验之间如何平衡？
  - **答**：两条线并存。合规审计：保留不可变事件日志（追加 `MessageDeletedEvent` 而非删除原事件），满足审计不可篡改。
    - 用户体验：展示层按"有效事件"（排除撤回/反向事件）重建当前可见会话，用户看到的是"已撤回"效果。
    - 即存储不可变、视图可撤销，二者通过"反向事件+投影视图"解耦。
- 追问3：事件溯源与关系型数据库的现状表相比，在碳管家的对话审计、跨租户数据隔离、以及故障恢复时各有什么利弊？
  - **答**：审计：事件溯源天然全量日志、可回溯，关系表只能看当前态、需另建审计表。跨租户隔离：关系表用 `tenant_id` 分区/行级权限简单直接；事件溯源需每条事件带 `tenantId` 并在回放/查询时过滤，隔离靠投影。
    - 故障恢复：事件溯源可重放重建、容错强；关系表靠备份+事务。
    - 碳管家对话审计用事件溯源，业务读写表用关系型，二者互补（CQRS）。


#### 设计模式高频题深化

> **本节定位：速答版。** 下面 10 道题（31-40）与第 1-16 题在设计模式上是重叠的，区别只在于**出题口吻更接近真实面试的连续追问**——面试官往往不给场景，直接问"单例怎么写才线程安全""Spring 的 BeanFactory 算哪种工厂"。所以本节只保留"面试现场 30 秒能说完"的版本；需要完整代码、UML、落地案例的，请看前面各题。
>
> 为避免整节停留在背定义，单例、策略、观察者、代理这 4 道最容易问穿到源码的题补了 Spring 源码级细节（三级缓存、`resolveMultipleBeans()`、`multicastEvent()`、`wrapIfNecessary()`）；其余 6 题各补一句"关键陷阱"，那是面试官真正想听的区分度。

### 31. 单例模式怎么写才线程安全？DCL 为什么必须加 volatile？
**重要度**：★★★★
单例保证全局唯一实例。DCL（双重检查锁）先判空再进 synchronized，第二次判空防重复创建；volatile 禁止指令重排，避免"半初始化对象"被别的线程拿到。

- 推荐写法：枚举单例（Effective Java 推荐，天然防反射/反序列化破坏）或静态内部类（懒加载 + 类加载器保证线程安全）。
- 碳管家全局配置、RAG 检索器、Embedding 客户端都用单例，避免重复建连接池。
- **源码级补充（Spring 容器单例）**：`DefaultSingletonBeanRegistry.getSingleton(beanName, allowEarlyReference)` 用了三级缓存——`singletonObjects`（一级，成品）、`earlySingletonObjects`（二级，半成品/提前暴露的代理）、`singletonFactories`（三级，`ObjectFactory` lambda）。A、B 循环依赖时，A 实例化后先把 `ObjectFactory` 放进三级，B 注入 A 时从三级取到 A 的早期引用并升级到二级，B 创建完成后 A 继续填充属性。**为什么必须是三级而不是两级**：若只有二级，早期引用一被创建就得立刻决定"要不要生成 AOP 代理"，而正常生命周期里代理是初始化后由 `BeanPostProcessor` 织入的；`ObjectFactory` 把"要不要提前生成代理"推迟到真正被别的 Bean 引用时才决定，两者才能兼容。另外，构造器注入的循环依赖三级缓存救不了（对象还没实例化就要注入），只能 `@Lazy` 或改 setter。

#### 追问：
- 追问1：为什么 new 一个对象不是原子的？volatile 在多核下到底拦住了哪一步重排？
  - **答**：`new` 在字节码层面至少是三步：
    - ① 分配内存
    - ② 执行构造器初始化对象
    - ③ 把引用赋给栈变量
  - JIT/CPU 会重排，可能先执行③再②，此时别的线程看到"非 null 但半初始化"的引用就出问题。
    - 多核下 volatile 通过内存屏障（StoreStore/LoadStore）禁止"引用赋值"与"字段写入"的重排，并保证可见性，让其他核立刻看到完整对象。
- 追问2：Spring 的 @Singleton Bean 算单例吗？它是怎么保证容器里只有一个的？和 DCL 单例冲突吗？
  - **答**：算单例，但语义不同：它是"容器级单例"，靠 IoC 容器缓存（一级缓存 `singletonObjects`）保证同一容器只实例化一次，其内部本质也是"查缓存→加锁→再查→创建"的 DCL 逻辑。
    - 和手写 DCL 不冲突：手写单例是类自己管自己，Spring 是容器替你管；Spring Bean 默认作用域就是 singleton。
    - 注意：Spring 单例是"每容器一个"，多容器/多类加载器会各自一份；构造期循环引用还需三级缓存处理。

### 32. 工厂模式（简单/工厂方法/抽象工厂）区别？Spring 的 BeanFactory 算哪种？
**重要度**：★★★★
简单工厂集中创建；工厂方法把创建延迟到子类；抽象工厂创建产品族（一组相关对象）。

- Spring 的 BeanFactory / ApplicationContext 本质是"超级工厂"：按 BeanDefinition 生产各类 Bean，配合策略可看做工厂方法思想的极致应用。
- 碳管家多模型接入（通义/OpenAI 兼容/本地模型）用工厂方法按配置产出不同 ChatClient。
- **关键陷阱**：面试官问"BeanFactory 算哪种"时，别硬塞进三种里——它是**注册表式工厂**（存 BeanDefinition，`getBean()` 时才实例化，即延迟创建），三种经典工厂都没有"先注册定义、再按名取"的这层。真正容易翻车的是另一组：`BeanFactory` 是容器本身，`FactoryBean` 是"用工厂方式创建某个 Bean 的扩展点"（`getObject()` 返回的才是 Bean），名字反着念意思完全不同。

#### 追问：
- 追问1：你们切换大模型供应商，工厂方法是怎么隔离变化的？新增一个厂商要改几处？
  - **答**：定义 ModelClient 接口 + 各厂商 XxxModelClient 实现，ModelClientFactory.getClient(type) 按配置返回；切换供应商只改配置文件（type=openai）或新增一个实现类。
    - 新增厂商改两处：
      - ① 新增实现类
      - ② 工厂的注册/路由（用 `Map<type, Supplier>` 消除 if-else）
    - 调用方代码零改动，变化边界收敛在工厂一处，符合开闭原则。
- 追问2：工厂方法和直接用 if-else new 对象比，除了"好看"到底解决什么实际问题？
  - **答**：if-else 能用，但问题在"创建逻辑散落、扩展要改老代码、无法编译期约束"。工厂方法把"创建"收敛成可测试、可替换的单一职责单元。
    - 实际收益：
      - ① 调用方依赖抽象不依赖具体类
      - ② 能结合 Spring 注入/策略做运行时选择
      - ③ 集中治理创建异常与兜底
    - 对象少且稳定时 if-else 反而更直白，不必硬上工厂。

### 33. 策略模式？你在碳因子计算 / RAG 检索里怎么用的？
**重要度**：★★★★
定义算法族，各自封装可互换，让调用方不关心具体实现。

- 碳因子计算有多种口径（缺省因子/实测数据/行业均值），抽象成 CarbonFactorStrategy，运行时按数据质量选择。
- RAG 检索也有多策略（向量/BM25/混合），同样用策略模式，检索器接口统一、可组合。
- **源码级补充（Map 注入到底怎么发生的）**：`@Autowired Map<String, CarbonFactorStrategy>` 不是 Spring 的"特殊语法"，而是 `DefaultListableBeanFactory.resolveMultipleBeans()` 的一个分支——它发现依赖类型是 Map/Collection/数组且元素类型不是可直接解析的依赖时，先用 `findAutowireCandidates()` 按类型捞出全部候选 BeanName，再 `adaptMap` 装成 Map：**key 取 BeanName**（`@Component("factor-default")` 里的名字），value 是对应实例，底层是 `LinkedHashMap`（大致按 Bean 注册顺序，别把遍历顺序当契约；需要确定顺序就用 List + `@Order`）。两个必须记住的后果：① **多值依赖允许 0 个候选**（注入空 Map 不报错，单值依赖才会 `NoSuchBeanDefinitionException`），所以策略名写错在启动期发现不了，必须自己 `getOrDefault` 兜底；② 若 Map 的 key 类型写成 `Class<?>`，key 会变成 Bean 类型而不是名字，别写错。

#### 追问：
- 追问1：策略模式通常配合什么一起用（工厂/上下文）？你们怎么把策略名映射到具体实现？
  - **答**：策略一般配合"工厂（按名产出策略）+ 上下文（持有当前策略并暴露 execute）"使用。
    - 映射：用 `Map<String, CarbonFactorStrategy>` 在 Spring 注入所有实现，key 为策略名（如 @Component("factor-default")），运行期按数据质量取；也可用策略枚举持有 lambda，把"名称→行为"直接写在枚举里省去一堆类。
- 追问2：策略太多（几十种因子口径）时，类爆炸怎么治理？用枚举 + lambda 行不行？
  - **答**：口径到几十种时纯接口+实现类会类爆炸，可改用"枚举/Map + lambda/函数式"收口。
    - 例：`enum FactorStrategy { DEFAULT(q -> ...), MEASURED(q -> ...) }`，或在工厂里用 `Map<String, Function<Req, Resp>>` 注册，行为即数据。
    - 何时仍用类：行为复杂、有独立状态/依赖注入、需单测隔离时类更清晰；轻量纯计算用 lambda 足够。

### 34. 模板方法模式？结合 RAG 流程 / 报表生成。
**重要度**：★★★★
父类定义算法骨架（固定步骤），把可变步骤留成抽象方法由子类填充。

- RAG 流水线：检索→重排→拼 prompt→调用 LLM→后处理，是稳定骨架；不同业务（问答/报告生成）只重写拼 prompt 与后处理。
- 报表生成：取数→算因子→套模板→导出，骨架固定，LCA 报告与组织碳报告各自实现细节。
- **关键陷阱**：① 父类**构造器里别调抽象方法**——子类字段还没初始化，钩子拿到的是 null/default，是典型的"继承 + 初始化顺序"事故；② `JdbcTemplate`/`RedisTemplate` 是"模板方法 + 回调（Callback）"的组合，骨架在模板类、变化点用 `RowMapper`/`ConnectionCallback` 接口传进去，**不是靠子类继承**——面试说成"继承式模板方法"会被追问穿。

#### 追问：
- 追问1：模板方法里"钩子方法(hook)"和抽象方法区别？你哪些步骤用钩子而非强制重写？
  - **答**：抽象方法子类必须实现（骨架里"必走的变步"）；钩子是空/默认实现的可选方法，子类按需覆写。
    - 我们用钩子控制"是否启用后处理/是否落审计"，默认 false，子类重写返回 true 才执行，避免每个子类都写一遍空方法。
    - 钩子还能做流程开关：父类 `if (hook())` 决定是否走某步，提升骨架灵活性。
- 追问2：模板方法和策略模式都能"换算法"，面试时怎么区分该用哪个？
  - **答**：模板方法是"父类定步骤、子类填空"，强调步骤顺序固定、控制点在父类；策略是"算法整体可替换、调用方持有"，强调行为平等互换。
    - 选模板方法：流程骨架稳定、只是某些步骤不同（如 RAG 流水线固定顺序）。
    - 选策略：同一动作有多种等价算法、运行时切换（如不同碳因子口径算同一个值）。二者常组合：模板方法调用策略完成某一步。

### 35. 观察者模式？Spring 事件机制 ApplicationEvent 与 MQ 解耦。
**重要度**：★★★★
定义一对多依赖，被观察者状态变化自动通知所有观察者，双方解耦。

- Spring 的 ApplicationEvent + @EventListener 是进程内观察者；跨服务用 MQ（发布/订阅）做分布式观察者。
- 碳管家：核算完成发领域事件，触发"生成报告 / 推送通知 / 落审计日志"三个监听器。注意 Spring 默认是**同一线程内同步串行**执行，一个慢或抛异常会拖住/中断后面的；要"互不阻塞"必须给监听器加 `@Async`（配 `@EnableAsync` + 自定义线程池）或换线程池版 `ApplicationEventMulticaster`，此时才需自行处理异常与顺序。
- **源码级补充（同步还是异步到底由谁决定）**：看 `SimpleApplicationEventMulticaster.multicastEvent()`——它先 `Executor executor = getTaskExecutor()`，然后遍历 `getApplicationListeners(event, type)`：`executor != null` 走 `executor.execute(() -> invokeListener(...))`（异步），`executor == null` 就直接 `invokeListener(...)`。**默认这个 taskExecutor 是 null**，所以默认派发 = 发布者线程内串行同步，监听器抛异常会原样冒泡回 `publishEvent()` 调用方，并中断后面还没执行的监听器。想改异步，正规做法是注册一个 `applicationEventMulticaster` Bean 并 `setTaskExecutor(...)`；`@Async` 走的是另一条路（`AsyncExecutionInterceptor` 代理提交线程池），粒度是单个监听器。顺带记住 `@TransactionalEventListener` 的 `phase` 默认就是 `AFTER_COMMIT`（事务提交后才派发，监听器里再写库属于新事务）；若显式写成 `BEFORE_COMMIT`，监听器抛异常会连发布方的事务一起回滚，语义完全不同。

#### 追问：
- 追问1：Spring 事件默认同步还是异步？监听器抛异常会影响发布方吗？怎么改异步？
  - **答**：默认同步，发布方在 `publishEvent` 内直接调用监听器，监听器抛异常会沿调用栈冒泡回发布方，中断后续逻辑。
    - 改异步：监听器加 @Async（需 @EnableAsync），或给 ApplicationEventMulticaster 配线程池；异步后异常不再影响发布方，但需自行处理（AsyncUncaughtExceptionHandler）。
    - 多监听器默认按 @Order 顺序同步执行，一个抛异常后面的不执行。
- 追问2：进程内观察者和 MQ 观察者怎么选？哪些场景用了 MQ 反而过度设计？
  - **答**：进程内观察者：同 JVM、低延迟、无网络开销，适合"核算完成→生成报告/落日志"这种强一致、不跨服务的联动。
    - 用 MQ：需跨服务解耦、要削峰/重试/持久化、或发布方不想关心谁消费（多团队）时。
    - 过度设计信号：只有一个消费方且同服务、对延迟极敏感、无需重试——此时 MQ 引入运维与一致性成本反而拖累。

### 36. 责任链模式？结合 RAG 的 query 改写/重排链路、Sentinel 限流。
**重要度**：★★★★
把多个处理节点串成链，请求沿链传递，每个节点决定是否继续。

- RAG 的 QueryPipeline：意图识别→改写→检索→重排→压缩，每步是链上一环，可插拔。
- Sentinel 的 ProcessorSlotChain、Servlet Filter、MyBatis 插件都是责任链。
- **关键陷阱**：顺序即语义。Sentinel 的 `ProcessorSlotChain` 靠 `@Spi(order = ...)` 排序（NodeSelector→ClusterBuilder→Statistic→Authority→System→Flow→Degrade），顺序错了会出现"先限流后统计"这类指标永远为 0 的假象；Servlet Filter 的 `chain.doFilter()` 前后各有一段代码（经典 AOP 环绕），不是"处理完就传给下一个"的单向链——面试把这两者混为一谈，追问"filter 怎么实现耗时统计"就露馅。

#### 追问：
- 追问1：责任链和装饰器听起来都"套娃"，区别在哪？什么时候用链、什么时候用包装？
  - **答**：责任链是"请求沿固定链路传下去，每个节点决定继续 or 中断"，节点间协作承接、目标一致（如 RAG 改写链）。
    - 装饰器是"给同一对象逐层包功能，外观不变、职责叠加"，强调增强而非传递控制。
    - 一句话区分：责任链——"谁来处理/要不要继续"；装饰器——"在原有基础上加一层能力"。
- 追问2：你们的 RAG 链路某环节失败了，是中断还是跳过？怎么设计容错？
  - **答**：按节点性质分级：改写/意图识别失败用"降级跳过"（拿原始 query 继续），检索失败则整体降级到"直连 LLM 兜底"。
    - 设计：每个节点包 try-catch，抛 ChainSkipException 表示跳过继续；链上有 fallback 节点或全局兜底返回。
    - 容错原则：非核心节点可跳过保可用，核心节点（检索/模型调用）失败走兜底答案并标记低置信度返回用户。

### 37. 代理模式（JDK 动态代理 / CGLIB）？Spring AOP、MyBatis Mapper。
**重要度**：★★★★★
代理在不改原类的前提下增强行为（日志/事务/限流）。JDK 动态代理基于接口，CGLIB 基于继承字节码增强。

- Spring AOP 的代理选择：Framework 原生默认"有接口走 JDK、无接口走 CGLIB"，但 **Spring Boot 2.x 起 `spring.aop.proxy-target-class` 默认 `true`，有接口也走 CGLIB**（可用该配置改回 JDK 代理）；MyBatis 用 JDK 代理把 Mapper 接口变成 SQL 执行器。
- 碳管家用代理统一给外部 LLM 调用加超时、重试、埋点。
- **源码级补充（判定到底发生在哪一行）**：链路是 `AbstractAutoProxyCreator.postProcessAfterInitialization()` → `wrapIfNecessary(bean, beanName, cacheKey)`。`wrapIfNecessary` 先挡基础设施类（`Advice`/`Pointcut`/`Advisor`）和 `shouldSkip()`，再 `getAdvicesAndAdvisorsForBean()` 找可应用的 Advisor：返回 `DO_NOT_PROXY` 就把 `advisedBeans.put(cacheKey, FALSE)` 并原样返回 Bean，否则 `createProxy(...)` → `ProxyFactory.getProxy()` → `DefaultAopProxyFactory.createAopProxy()`。真正的判定只有一条 if：`config.isOptimize() || config.isProxyTargetClass() || hasNoUserSuppliedProxyInterfaces(config)` 成立时，若 `targetClass.isInterface()` 或已是 `Proxy` 类仍用 `JdkDynamicAopProxy`，否则 `ObjenesisCglibAopProxy`；不成立（即 proxyTargetClass=false 且有接口）才走 JDK。所以别背"Spring 默认 CGLIB"这个结论，要背**条件**。补一个联动点：循环依赖时 `getEarlyBeanReference()` 会提前调 `wrapIfNecessary` 生成代理，保证别的 Bean 注入到的是代理而不是裸对象。

#### 追问：
- 追问1：JDK 动态代理为什么只能代理接口？CGLIB 代理 final 类/方法会怎样？
  - **答**：JDK 动态代理运行时生成"实现该接口的新类"，靠接口方法表转发 InvocationHandler，没有接口就无方法可声明，故只能代理接口。
    - CGLIB 通过继承目标类、重写非 final 方法做增强。两种后果要分开：**final 类** → 无法继承，代理**创建即失败**（`BeanCreationException`，根因 `Cannot subclass final class`）；**final 方法** → 代理创建成功，但该方法不被重写、**静默不增强**。
    - 故 Spring AOP 遇到 final 方法会"看起来注入了但事务/日志不生效"，这类 bug 极难查；final 类则直接启动报错。设计时应避免对需要代理的类/方法加 final。
- 追问2：AOP 代理下的 self-invocation（自己调自己）为什么切面不生效？怎么绕？
  - **答**：AOP 增强的是"代理对象"的方法；同类里 `this.methodB()` 是原始对象自己调自己，没走代理，拦截器链不会触发。
    - 绕法：
      - ① 注入自身代理（@Lazy 自注入或 `AopContext.currentProxy()`）再调
      - ② 把被调方法拆到另一个 Bean
      - ③ 用 AspectJ 编译/加载期织入（非 Spring 代理）
    - @Transactional 自调用失效是同因，是最常见的坑。

### 38. 建造者模式（Builder）？结合 LCA 模型 / 复杂对象构建。
**重要度**：★★★★
把复杂对象的构建与表示分离，链式调用分步设参，最后 build() 产出。

- LCA 清单（工序→单元过程→数据流→因子）字段极多且可选，用 Builder 避免满屏构造参数。
- StringBuilder、OkHttp Request.Builder、Spring 的 BeanDefinitionBuilder 都是典型。
- **关键陷阱**：① `build()` 里对可变集合要做**防御性拷贝**（`List.copyOf(...)`），否则调用方后续改原 list 会"隔空改到"已构造好的对象；② Lombok `@Builder` 只生成设值代码，**不校验必填、不校验互斥字段**，关键业务对象仍要手写 `build()` 校验；③ Builder 是有状态对象、非线程安全，别做成单例或静态字段复用。

#### 追问：
- 追问1：Builder 和构造函数重载（ telescoping constructor）比，解决了什么痛点？
  - **答**：telescoping constructor 层层重载（ctor(a), ctor(a,b), ...），调用方要传一堆无用默认值、参数顺序易错、可读性差、可选字段被迫传。
    - Builder 用链式设参、只设关心的项，参数名自解释、编译期类型安全，且能复用同一 Builder 产出多个变体。
    - 代价是多了 Builder 类与一次 build() 调用，对象字段多（>4 个可选）时才划算。
- 追问2：你们 Builder 的 build() 做参数校验吗？校验失败抛什么、调用方怎么处理？
  - **答**：build() 里做必填校验与业务约束（如因子值≥0、必填工序非空），不合法直接抛异常，不让"半成品对象"流出。
    - 抛 IllegalArgumentException（参数非法）或自定义 IllegalState/LcaBuildException 带中文错误码，便于调用方 catch 后提示用户。
    - 调用方在 build() 外包 try-catch 转成业务校验失败返回；也可在 setter 阶段就 fail-fast 提前暴露。

### 39. 适配器模式？结合多模型接入、老系统兼容。
**重要度**：★★★★
把一个不兼容的接口转成调用方期望的接口，做"转接头"。

- 多模型接入：各家 SDK 入参/返回不同，写 ModelAdapter 统一成内部 ChatRequest/ChatResponse。
- 老系统（遗留 SOAP/CSV）用适配器转成新 REST 接口，渐进替换。
- **关键陷阱**：适配器必须做**双向翻译**——不只把上游响应转成内部 DTO，还要把上游的**错误码/异常**翻译成内部统一异常（否则 OpenAI 的 429 直接穿透成业务 500，重试策略认不出来）；同时守住边界，适配器里只做协议转换，别顺手写业务编排（那样它会退化成"上帝类"，也是防腐层失效的典型症状）。

#### 追问：
- 追问1：适配器和外观(Facade) 都能"包一层"，区别在哪？面试怎么区分？
  - **答**：适配器是"接口不兼容时做一对一转换"，让 A 能接上 B（如各家模型 SDK → 内部 ChatRequest）。
    - Facade 是"把一群杂乱子系统包成一个简单统一入口"，降低复杂度、少暴露细节，不解决兼容问题。
    - 区分：适配器——"换插头让能插上"；Facade——"把一堆开关收成一个总闸"。
- 追问2：适配器多了会不会让调用链变长、排错变难？你们怎么控制数量？
  - **答**：适配器本质是"防腐层(ACL)"，数量应等于"外部不兼容接口数"，不该无限膨胀；内部统一接口收敛后调用方只认一套。
    - 控制：
      - ① 统一内部契约（ChatRequest/ChatResponse），新增供应商只加一个适配器
      - ② 适配器内做入参/返回标准化与异常翻译，把脏数据挡在边界
    - ③在适配器入口统一埋点日志，便于定位是哪家上游出问题。

### 40. 装饰器模式？结合 IO 流式包装、RAG 的 query 增强。
**重要度**：★★★★
动态给对象加职责，比继承灵活，可层层嵌套。

- Java IO：BufferedInputStream → FileInputStream，层层加缓冲/解码，是经典装饰器。
- RAG 中 QueryEnhancer 也类似：给原始 query 依次叠"上下文补充/同义词扩展/术语标准化"，每层独立可组合。
- **关键陷阱**：装饰器**顺序即结果**——"先同义词扩展再术语标准化"和反过来的召回率不一样，链路顺序必须固定并写进单测；另外装饰后对象与原始对象不是同一个实例（`equals`/`hashCode` 可能被破坏），拿它当缓存 key 或做幂等判断会出问题，这一点和 IO 流"包装后要逐层 close、最外层 close 会连带关内层"是同一类坑。

#### 追问：
- 追问1：装饰器和代理都能"包一层加功能"，核心区别是什么（关注点）？
  - **答**：核心区别在"关注点"：装饰器关注"给对象动态叠加职责"，强调功能增强且可层层组合，装饰器与被装饰者实现同一接口、地位平等。
    - 代理关注"控制对原对象的访问"（延迟加载/权限/事务/埋点），往往不增加新行为语义而是管控。
    - 一句话：装饰器是"我还能再加一层能力"；代理是"你不能直接碰原对象，得经过我"。
- 追问2：装饰器层层嵌套过深时，出问题怎么定位是哪一层引入的？
  - **答**：先靠"每层独立、接口一致"做隔离测试——单独给某层写单测验证其输入输出，定位哪层变形。
    - 运行时排错：在每层装饰器入口/出口统一打 trace 日志（入参、出参、耗时），用同一 traceId 串起来看哪层结果异常。
    - 也可给装饰器命名/编号并在日志打印，避免匿名嵌套；RAG 的 QueryEnhancer 链就给每步打标签便于回溯。


---
