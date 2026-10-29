## 第十七章：Spring全家桶深度

> 本章是全库题量最大的一章，按"自动装配 → AOP → 事务 → MVC → 安全 → 事件 → Bean 生命周期 → 循环依赖 → 扩展点 → SpEL → 测试 → 监控 → 配置管理 → 异步 → 定时任务"逐块展开。注意：**"一、""二、"这些是分组小标题，下面的 `### N.` 才是题目。**



#### 一、Spring Boot 自动装配深入

### 1. Spring Boot自动装配原理与AutoConfigurationImportSelector机制
**重要度**：★★★★★

**题目：**
请详细说明Spring Boot自动装配的完整原理链路，包括@SpringBootApplication注解的组成、AutoConfigurationImportSelector的工作机制，以及Spring Boot 3.x中自动装配机制的重要变化。

**解答：**
Spring Boot自动装配的入口是@SpringBootApplication注解，它是一个组合注解，包含了@EnableAutoConfiguration。@EnableAutoConfiguration通过@Import(AutoConfigurationImportSelector.class)引入了自动配置导入选择器。

AutoConfigurationImportSelector实现了DeferredImportSelector接口，这意味着它的执行时机晚于普通的ImportSelector，是在所有@Configuration类处理完成之后才执行。其核心方法selectImports调用getAutoConfigurationEntry，该方法经过以下步骤：首先加载候选配置类：Spring Boot 3.x 通过 ImportCandidates.load() 从 `META-INF/spring/org.springframework.boot.autoconfigure.AutoConfiguration.imports` 加载；2.x 则通过 SpringFactoriesLoader 从 `META-INF/spring.factories` 的 `EnableAutoConfiguration` key 加载（`.imports` 文件在 2.x 不存在）；然后通过removeDuplicates去重；接着通过getExclusions排除被exclude指定的类；最后通过filter根据@Conditional条件进行过滤，只有满足条件的配置类才会被实际注册。

Spring Boot 3.x的重大变化在于：废弃了spring.factories方式，改为使用独立的imports文件，每个自动配置类用@AutoConfiguration注解标注，并可通过before/beforeName/after/afterName属性声明加载顺序。这一设计解耦了配置类的声明与条件过滤，使自动装配更加清晰和可维护。测试切片（如 @WebMvcTest）则通过 @ImportAutoConfiguration + @OverrideAutoConfiguration 只导入部分自动配置类，与 imports 文件格式无关。

**AI/碳管理场景关联：**
在碳管家AI助手中，引入 spring-ai-starter-model-openai 后，自动装配会根据classpath扫描到OpenAiAutoConfiguration，自动创建ChatClient、EmbeddingModel等Bean并注入到容器。开发者只需在application.yml中配置spring.ai.openai.api-key和spring.ai.openai.chat.options.model参数，即可在碳管家服务中直接通过依赖注入使用ChatClient进行碳排放法规问答的RAG推理。同时，spring-ai-starter-vector-store-milvus 的自动装配会创建MilvusVectorStore，连接Milvus向量数据库存储碳法规文档的嵌入向量，整个过程零XML配置、零手动Bean声明。

---

#### 追问：
- 追问1：如果多个自动配置类之间存在依赖顺序（如向量库先于ChatClient初始化），AutoConfiguration.imports文件里的before/after声明与@Conditional条件过滤的执行先后关系是怎样的？
  - **答**：before/after 决定的是候选自动配置类的"处理/注册顺序"，而 @Conditional 过滤发生在 selectImports→filter 阶段，对每个候选类独立评估。
    - 两者关系：AutoConfigurationSorter 先按 before/after 排好候选列表顺序，再逐个做条件过滤。@ConditionalOnClass 这类只看 classpath 的条件互不影响；但 @ConditionalOnBean / @ConditionalOnSingleCandidate 依赖前置配置类已注册的 BeanDefinition，顺序会**实质影响条件结果**——这正是 Spring 提供 before/after 排序的核心原因。
    - 所以"条件不感知被依赖项是否已注册"只对 OnClass 类条件成立；要让 OnBean 条件稳定命中，必须把被依赖的自动配置类显式写进 before/beforeName，而不是依赖 imports 文件里的书写顺序。
- 追问2：在碳管家AI助手中，若同时引入spring-ai-openai和spring-ai-azure两个starter，它们的自动配置类会发生冲突吗？如何通过@ConditionalOnMissingBean和@Qualifier解决多模型ChatClient并存的问题？
  - **答**：两个 starter 各自的 OpenAiAutoConfiguration / AzureOpenAiAutoConfiguration 都会注册 ChatClient Bean，类型相同会 NoUniqueBeanDefinitionException。
    - 单模型：ChatClient 用 @ConditionalOnMissingBean 保证只有一个候选。
    - 多模型并存：各自用 @Bean(name="chatClientOpenAi"/"chatClientAzure") 显式命名 + @Qualifier 注入；Spring AI 的 ChatClient.Builder 通常按模型前缀区分，避免直接冲突。

### 2. @Conditional条件注解族详解与自定义条件
**重要度**：★★★★

**题目：**
请详细说明Spring Boot中@Conditional注解族的工作原理，列举常见的条件注解，并说明如何自定义一个@ConditionalOnCarbonAiEnabled条件注解。

**解答：**
@Conditional是Spring 4.0引入的条件化Bean注册核心注解，它接受一个Condition接口实现类作为参数。Spring Boot在此基础上扩展了丰富的条件注解族：@ConditionalOnClass（类路径存在指定类时生效）、@ConditionalOnMissingBean（容器中不存在指定Bean时生效）、@ConditionalOnProperty（配置属性满足条件时生效）、@ConditionalOnWebApplication（Web应用环境时生效）、@ConditionalOnExpression（SpEL表达式为true时生效）、@ConditionalOnBean（容器中存在指定Bean时生效）、@ConditionalOnMissingClass、@ConditionalOnSingleCandidate等。

这些条件注解的底层都通过Condition.matches方法实现判断。在自动装配过程中，ConfigurationClassParser会调用ConditionEvaluator.shouldSkip()方法，对每个配置类及其Bean方法逐一进行条件评估，不满足条件的直接跳过注册。条件评估发生在Bean定义注册阶段，而非实例化阶段，因此不会产生不必要的对象创建开销。

自定义条件注解的标准做法是：首先实现Condition接口，在matches方法中通过ConditionContext获取环境配置、BeanFactory、ResourceLoader等上下文信息，结合AnnotatedTypeMetadata进行条件判断；然后创建自定义注解并通过@Conditional关联Condition实现类。

```java
// 自定义条件：碳AI功能开关
public class OnCarbonAiEnabledCondition implements Condition {
    @Override
    public boolean matches(ConditionContext context, AnnotatedTypeMetadata metadata) {
        Environment env = context.getEnvironment();
        return env.getProperty("carbon.ai.enabled", Boolean.class, true)
            && env.containsProperty("carbon.ai.llm.api-key");
    }
}
@Target({ElementType.TYPE, ElementType.METHOD})
@Retention(RetentionPolicy.RUNTIME)
@Conditional(OnCarbonAiEnabledCondition.class)
public @interface ConditionalOnCarbonAiEnabled {
}
```

**AI/碳管理场景关联：**
在碳管家AI助手中，可以通过@ConditionalOnCarbonAiEnabled实现AI功能的按需开关。当carbon.ai.enabled=false时（如降级模式或成本控制期间），系统不创建ChatClient和EmbeddingModel等AI相关Bean，而是自动回退到传统的关键词检索模式。同时，可以结合@ConditionalOnProperty实现多模型切换：当配置carbon.ai.provider=qwen时加载通义千问相关 Bean，carbon.ai.provider=deepseek时加载 DeepSeek Bean，carbon.ai.provider=glm时加载自部署 GLM(vLLM) Bean，实现碳法规问答引擎的灵活切换。

---

#### 追问：
- 追问1：你自定义的@ConditionalOnCarbonAiEnabled在matches里读取了环境配置，此时Nacos/配置中心的远程配置到底加载完了没有？这个条件判断会拿到错误结果吗？
  - **答**：能读到，不会拿错。Spring Cloud 2020+ 改用 ConfigData 机制（`spring.config.import=nacos:...`），在 `ConfigDataEnvironmentPostProcessor`（`prepareEnvironment` 阶段）就把 Nacos 的 PropertySource 装进 `Environment`，早于 `ConfigurationClassPostProcessor` 解析 `@Conditional`/执行 `Condition.matches`，所以远程开关是生效的（老版本走 bootstrap 上下文，同样早于 BeanDefinition 注册）。
    - **但有个真坑**：`@ConditionalOnProperty`/`@Conditional` 只在**启动时判断一次**，Nacos 后续推送变更时它不会重新求值——Bean 已经创建好了。要做"运行时开关"，得用 `@RefreshScope` + 每次调用时读 `Environment`（详见追问2）。条件注解解决的是"启动时装不装"，不是"运行时开不开"。
- 追问2：在碳管家AI助手中用@ConditionalOnProperty切换openai/azure/qwen模型时，如果用户在运行时通过配置中心热更新provider，已创建的Bean会自动重建吗？为什么，又该如何实现真正的运行时模型热切换？
  - **答**：不会。@ConditionalOnProperty 只在启动时的条件评估阶段生效一次，运行中改 Nacos 不会销毁/重建已存在的 ChatClient Bean。
    - 真正的运行时热切换：用 @RefreshScope 包裹模型 Bean，配置变更触发重建；或在调用层用路由/策略持有多个 ChatClient，按当前 provider 动态选，零重建、无请求中断（推荐）。

### 3. 自定义Spring Boot Starter开发完整流程
**重要度**：★★★★

**题目：**
请详细说明如何从零开发一个自定义Spring Boot Starter，包括命名规范、目录结构、自动配置类编写、条件注解使用、配置属性绑定以及publish到团队内部Maven仓库的完整流程。

**解答：**
开发自定义Starter需要遵循Spring Boot的官方规范。命名方面，官方Starter使用spring-boot-starter-xxx前缀，第三方Starter应使用xxx-spring-boot-starter命名，以避免混淆。例如碳管家的Starter应命名为carbon-ai-spring-boot-starter。

目录结构上，Starter通常包含两个模块：autoconfigure模块（放置自动配置逻辑）和starter模块（仅包含pom依赖聚合）。简单场景也可合并为单模块。核心文件包括：自动配置类（使用@AutoConfiguration或@Configuration）、配置属性类（使用@ConfigurationProperties）、条件注解、META-INF/spring/org.springframework.boot.autoconfigure.AutoConfiguration.imports文件。

配置属性绑定使用@ConfigurationProperties注解将application.yml中的配置前缀映射到Java对象字段，支持JSR-303校验（@NotBlank、@Min等）。Spring Boot 3.x 中，配置属性类只要是单构造器（record 或普通类都算），就会自动走构造器绑定，**不需要也不推荐**再标 `@ConstructorBinding`；该注解从 3.0 起只用于"有多个构造器、需要指定其中一个"的场景（且标在类上而非构造器上）。不可变对象天然适合这种绑定方式，可提升线程安全性。

```java
@AutoConfiguration
@ConditionalOnClass(ChatClient.class)
@EnableConfigurationProperties(CarbonAiProperties.class)
public class CarbonAiAutoConfiguration {

    @Bean
    @ConditionalOnMissingBean
    @ConditionalOnProperty(prefix = "carbon.ai", name = "enabled", havingValue = "true")
    public CarbonChatService carbonChatService(ChatClient.Builder builder,
                                                CarbonAiProperties properties,
                                                VectorStore vectorStore) {
        return new CarbonChatService(builder.build(), vectorStore, properties);
    }
}

@ConfigurationProperties(prefix = "carbon.ai")
public record CarbonAiProperties(
    boolean enabled,
    String model,
    int maxTokens,
    double temperature,
    int topK
) {}
```

imports文件内容为：`com.carbon.ai.autoconfigure.CarbonAiAutoConfiguration`

发布流程：在pom.xml中配置maven-deploy-plugin，使用mvn clean deploy推送到内部Nexus仓库。团队其他服务只需在pom.xml中引入carbon-ai-spring-boot-starter依赖，即可获得碳AI问答能力的开箱即用支持。

**AI/碳管理场景关联：**
积木LCA云平台可以将碳管家AI助手的核心能力封装为carbon-ai-spring-boot-starter，内部包含RAG检索、向量存储、模型调用、对话记忆等模块。多个SaaS租户服务只需引入该Starter并配置API Key和Milvus连接信息，即可快速获得碳法规智能问答、碳排放计算辅助、碳报告生成等AI能力，实现AI能力的跨服务复用和统一升级。

---

#### 追问：
- 追问1：carbon-ai-spring-boot-starter里用@ConfigurationProperties绑定配置，如果用户没有配置任何carbon.ai.*属性，Starter里的@ConditionalOnMissingBean会创建出一个带默认值的Bean吗？默认值是怎么生效的，会不会造成"静默可用"而运维无感知？
  - **答**：要看写法，不能一概而论。本题示例的 @Bean 上同时有 `@ConditionalOnProperty(havingValue = "true")`，而 record 里的 `boolean enabled` 未配置时取原始类型默认值 false，所以未显式开启时**根本不会创建 Bean**，不存在"静默可用"。
    - 真正有静默可用风险的是另一种写法：只用 `@ConditionalOnMissingBean`，同时属性类里把 `enabled` 默认值写成 true——此时类在 classpath 就直接装配。风险是运维无感知，出问题才发现 AI 一直在跑。
    - 改进：enabled 默认值设为 false，或用 @ConditionalOnProperty(havingValue = "true") 要求显式开启；actuator/configprops 暴露配置来源便于巡检。
- 追问2：把RAG检索、向量存储、对话记忆都塞进一个Starter对外发布，当某个租户只需要对话记忆能力而不想引入Milvus依赖时，这种"全量打包"设计会带来什么启动和健康检查上的副作用？
  - **答**：全量打包副作用明显：
    - 不需要 Milvus 的租户也被强制带入 milvus-sdk 依赖与自动配置，Milvus 不可达时启动卡连接、健康检查失败。
    - @ConditionalOnClass(VectorStore) 存在即装配，无法按需剔除。
    - 改进：拆成 carbon-ai-core / carbon-ai-rag / carbon-ai-memory 多个 starter，用 optional 依赖 + @ConditionalOnProperty 真正按需装配，健康检查按模块隔离。

### 4. Spring Boot SPI机制与自动装配的扩展点
**重要度**：★★★★

**题目：**
请说明Spring Boot中的SPI（Service Provider Interface）机制，包括与传统Java SPI的区别、spring.factories的作用，以及Spring Boot 3.x中spring.factories废弃后的替代方案。

**解答：**
Java标准SPI通过META-INF/services/目录下的文件声明接口实现类，使用ServiceLoader加载。其缺点是全量加载所有实现，无法按条件过滤，且无法与Spring容器集成。Spring Boot在此基础上设计了自己的SPI机制。

Spring Boot 2.x通过META-INF/spring.factories文件实现SPI，该文件以key=value格式存储，常见的key包括：org.springframework.boot.autoconfigure.EnableAutoConfiguration（自动配置类列表）、org.springframework.context.ApplicationListener（应用监听器）、org.springframework.boot.diagnostics.FailureAnalyzer（故障分析器）、org.springframework.boot.env.EnvironmentPostProcessor（环境后置处理器，在 spring-boot 包下）等。SpringFactoriesLoader通过缓存机制一次性加载所有spring.factories并按key分组。

Spring Boot 3.x对SPI机制进行了重大重构：自动配置类不再通过spring.factories声明，而是使用独立的META-INF/spring/org.springframework.boot.autoconfigure.AutoConfiguration.imports文件，每行一个全限定类名。这一变更的核心动机是：spring.factories中自动配置类与其他扩展点混在一起，导致启动时需要加载大量不必要的配置类元数据；分离后，自动配置的加载更加高效，且支持更精细的条件过滤。

但其他类型的SPI扩展点（如ApplicationListener、EnvironmentPostProcessor、FailureAnalyzer）仍然保留在spring.factories中。这种分离设计使得自动配置（高频使用、需要条件过滤）与其他扩展点（低频使用、无条件加载）各得其所。

**AI/碳管理场景关联：**
在碳管家AI助手中，可以通过EnvironmentPostProcessor实现AI模型配置的动态初始化：在Spring环境准备阶段，从远程配置中心或加密的密钥管理服务中读取大模型 API Key（通义千问/DeepSeek/自部署GLM 三家）和Milvus连接信息，注入到Spring Environment中。这样开发人员无需在配置文件中明文存储密钥，提升了碳管理SaaS平台的安全合规水平。同时，可以注册自定义的FailureAnalyzer，当AI模型连接失败时给出友好的诊断提示，帮助运维人员快速定位碳法规问答服务不可用的根因。

---

#### 追问：
- 追问1：你提到用EnvironmentPostProcessor从密钥管理服务动态注入API Key，但EnvironmentPostProcessor运行在环境准备阶段、早于Bean创建，此时你的密钥管理服务本身依赖Spring容器吗？若出现网络抖动导致拉取失败，应用是直接启动失败还是降级？
  - **答**：不依赖 Spring 容器。EnvironmentPostProcessor 由 SpringApplication 在环境准备阶段直接反射实例化并调用，此时 BeanFactory 还没创建，密钥服务应是轻量客户端（HTTP/KMS SDK），不能用 @Autowired。
    - 网络抖动策略取决于安全策略：默认建议启动失败并告警，避免明文密钥落地；若要求高可用，可本地加密缓存上次密钥降级，但需短过期。
- 追问2：Spring Boot 3.x把自动配置从spring.factories拆分到AutoConfiguration.imports，但FailureAnalyzer等扩展点仍留在spring.factories，如果在碳管家AI助手中自定义了AI连接失败的FailureAnalyzer，在3.x下它还能被加载吗？为什么？
  - **答**：能。Spring Boot 3.x 仅把"自动配置类"从 spring.factories 移到 AutoConfiguration.imports，其余 SPI 扩展点（FailureAnalyzer、EnvironmentPostProcessor、ApplicationListener 等）仍按 spring.factories 的 key 加载。
    - 所以自定义 AI 连接失败 FailureAnalyzer 注册在 META-INF/spring.factories 的 org.springframework.boot.diagnostics.FailureAnalyzer 下，3.x 依旧生效。

#### 二、Spring AOP 原理

### 5. JDK动态代理与CGLIB代理的原理与选择策略
**重要度**：★★★★★

**题目：**
请详细对比JDK动态代理和CGLIB代理的实现原理、性能差异、适用场景，以及Spring AOP中代理策略的选择机制。

**解答：**
JDK动态代理基于java.lang.reflect.Proxy和InvocationHandler接口实现。其核心原理是在运行时动态生成一个实现了目标接口的代理类（$Proxy0等），通过InvocationHandler.invoke方法拦截所有方法调用。JDK代理要求目标类必须实现至少一个接口，代理对象是接口的实例而非目标类的子类。生成的代理类字节码在 JDK 8 及以前位于 `com.sun.proxy` 包（类名 `com.sun.proxy.$Proxy0`）；JDK 9+ 模块化后改放在动态模块中，形如 `jdk.proxy1.$Proxy0`。代理类默认不落盘，需 `-Djdk.proxy.ProxyGenerator.saveGeneratedFiles=true` 才能看到。

CGLIB（Code Generation Library）基于ASM字节码框架，通过在运行时动态生成目标类的子类来实现代理。CGLIB不需要目标类实现接口，但要求目标类不能是final类，被代理的方法不能是final或static方法。CGLIB通过MethodInterceptor拦截方法调用，生成的代理类是目标类的子类。

性能方面，在JDK 8+中JDK动态代理的创建速度和调用性能已大幅优化，与CGLIB差距缩小。CGLIB在首次创建代理类时较慢（需要生成字节码），但方法调用通过FastClass机制（直接通过索引调用方法，避免反射）在旧版JDK中性能更优。在JDK 17+中，两者性能差异已不显著。

Spring AOP的代理选择策略：如果目标类实现了接口，默认使用JDK动态代理（Spring Boot 2.x起默认改为CGLIB）；可通过spring.aop.proxy-target-class=true或@EnableAspectJAutoProxy(proxyTargetClass=true)强制使用CGLIB。Spring Boot 2.0 起默认 `spring.aop.proxy-target-class=true` 走 CGLIB，免去对接口的依赖、使类级注解（如 @Transactional）一致生效。注意：自调用（this.xxx()）不走代理的问题在 JDK 动态代理和 CGLIB 下都存在，需靠拆分 Bean / AopContext.currentProxy() / 注入自身代理解决，切 CGLIB 并不能"避免"自调用失效。

**AI/碳管理场景关联：**
在碳管家AI助手中，CarbonChatService通常不实现接口（直接是具体类），因此Spring会使用CGLIB代理来拦截其chat方法，实现调用日志记录、Token用量统计、响应延迟监控等横切关注点。需要注意的是，如果CarbonChatService中有final方法（如工具方法），CGLIB无法代理这些方法，AOP切面不会生效。因此设计AI服务类时应避免在需要被拦截的方法上使用final修饰符。

---

#### 追问：
- 追问1：碳管家AI助手中CarbonChatService不实现接口因此走CGLIB，若某天为了便于单元测试给它抽出了一个接口，代理策略会突然从CGLIB变回JDK动态代理吗？这会让你在12.7设计的final方法拦截失效问题以什么形式暴露？
  - **答**：不会变。Spring Boot 2.x/3.x 默认 `spring.aop.proxy-target-class=true`（AopAutoConfiguration 中 matchIfMissing=true，即 CglibAutoProxyConfiguration），即使抽了接口仍然走 CGLIB，代理方式不变。只有显式把它配成 false，或在纯 Spring Framework（非 Boot）环境未开启 proxyTargetClass 时，才会切回 JDK 动态代理。
    - 12.7 的 final 方法拦截失效会以"切面不生效且无任何报错"的隐蔽形式暴露（若真切到 JDK 代理则表现为直接绕开拦截）。
    - 稳妥做法：显式写下 spring.aop.proxy-target-class=true，不要依赖默认值，避免升级或换框架时行为突变。
- 追问2：CGLIB通过生成子类代理，如果CarbonChatService的成员变量在构造器中就发起了Milvus预热调用，CGLIB代理对象的构造与父类构造的执行关系会让预热逻辑被执行几次？
  - **答**：只执行一次。Spring 的 CglibAopProxy 通过 Objenesis 直接实例化代理对象，**不调用父类构造器**，所以目标类的构造器只在容器创建目标实例（原对象）时执行这一次，代理不会再额外触发一次。
    - 但把有副作用的预热写进构造器依然危险：可能早于依赖就绪、@Lazy 下被延迟触发、抛异常直接导致 Bean 创建失败。
    - 正确做法：预热放 @PostConstruct / SmartLifecycle，避免有副作用的初始化放在构造器。

### 6. AOP核心概念与切面编程实践
**重要度**：★★★★

**题目：**
请详细说明Spring AOP的核心概念（切面、切点、通知、织入），并编写一个完整的切面示例，包含五种通知类型。

**解答：**
Spring AOP的核心概念包括：Aspect（切面，封装横切关注点的模块）、JoinPoint（连接点，程序执行中的某个点，Spring AOP仅支持方法级连接点）、Pointcut（切点，定义哪些连接点需要被拦截，使用AspectJ切点表达式）、Advice（通知，在切点处执行的动作，分为Before、After、AfterReturning、AfterThrowing、Around五种）、Weaving（织入，将切面应用到目标对象的过程，Spring AOP使用运行时织入）、Target Object（目标对象）、Proxy（代理对象）。

切点表达式语法：execution(修饰符 返回类型 包名.类名.方法名(参数类型) 异常)，例如execution(* com.carbon.ai.service.*.*(..))匹配ai.service包下所有方法。可以通过&&、||、!组合多个切点，使用@annotation、@within、@args等注解切点精确匹配。

```java
@Aspect
@Component
@Order(1)
public class CarbonAiAspect {

    @Pointcut("@annotation(com.carbon.ai.annotation.AiTraced)")
    public void aiTracedMethods() {}

    @Before("aiTracedMethods() && args(question, userId)")
    public void doBefore(JoinPoint jp, String question, String userId) {
        MDC.put("traceId", UUID.randomUUID().toString());
        log.info("[AI调用开始] 用户={}, 问题={}, 方法={}", userId, question, jp.getSignature().getName());
    }

    @AfterReturning(pointcut = "aiTracedMethods()", returning = "result")
    public void doAfterReturning(JoinPoint jp, Object result) {
        log.info("[AI调用成功] 方法={}, 响应长度={}", jp.getSignature().getName(),
                 result != null ? result.toString().length() : 0);
        Metrics.counter("carbon.ai.invocation.success").increment();
    }

    @AfterThrowing(pointcut = "aiTracedMethods()", throwing = "ex")
    public void doAfterThrowing(JoinPoint jp, Exception ex) {
        log.error("[AI调用异常] 方法={}, 异常={}", jp.getSignature().getName(), ex.getMessage());
        Metrics.counter("carbon.ai.invocation.failure").increment();
    }

    @After("aiTracedMethods()")
    public void doAfter(JoinPoint jp) {
        MDC.remove("traceId");
    }

    @Around("aiTracedMethods()")
    public Object doAround(ProceedingJoinPoint pjp) throws Throwable {
        long start = System.currentTimeMillis();
        try {
            Object result = pjp.proceed();
            long cost = System.currentTimeMillis() - start;
            Metrics.timer("carbon.ai.invocation.duration").record(cost, TimeUnit.MILLISECONDS);
            if (cost > 5000) {
                log.warn("[AI调用超时警告] 方法={}, 耗时={}ms", pjp.getSignature().getName(), cost);
            }
            return result;
        } catch (Throwable ex) {
            Metrics.counter("carbon.ai.invocation.error").increment();
            throw ex;
        }
    }
}
```

**AI/碳管理场景关联：**
通过@AiTraced注解标记碳管家AI助手的核心方法（如ragSearch、generateCarbonReport、chatWithCarbonAssistant），上述切面会自动记录每次AI调用的耗时、成功率和Token消耗，并上报到Micrometer监控系统。当碳排放法规问答响应时间超过5秒时触发告警，帮助运维团队及时发现Milvus向量检索瓶颈或大模型推理延迟问题。

---

#### 追问：
- 追问1：你的@Around切面里用try-catch包住pjp.proceed()并重新throw异常，如果@AfterThrowing切面和@Around切面同时存在，异常会先被谁处理？两者对异常的重抛/吞掉会产生什么交互？
  - **答**：异常先由 @Around 内的 catch 捕获。执行顺序：目标方法抛异常 → @Around 的 try-catch 捕获 → 若 rethrow，@AfterThrowing 随后触发。
    - 交互风险：@Around 吞掉异常（不 rethrow），@AfterThrowing 永不执行；@Around 改抛其他类型，@AfterThrowing 按原类型匹配可能不匹配。
    - 原则：统计/监控用 @Around 只记录不吞异常，异常透传给 @AfterThrowing。
- 追问2：在碳管家AI助手中，ragSearch和generateCarbonReport都被@AiTraced标记，若ragSearch内部又调用了generateCarbonReport（同类内部调用），嵌套的AOP统计耗时会出现什么偏差？
  - **答**：会有偏差。ragSearch 内部 this.generateCarbonReport 是同类自调用，不经过代理，generateCarbonReport 上的 @AiTraced 切面不生效，其耗时不会被独立统计，并入 ragSearch 总耗时。
    - 结果："内层耗时"缺失、外层统计偏大。
    - 修复：抽到独立 Bean 或经 AopContext.currentProxy() 调用，使其走代理被切面拦截，耗时才能分层。

### 7. AOP在AI日志监控与Token用量追踪中的深度应用
**重要度**：★★★★

**题目：**
请设计一个基于AOP的AI服务监控系统，能够统计每次大模型调用的Token消耗、成本、响应时间，并实现按租户维度的用量聚合，支持月度配额检查与超额拦截。

**解答：**
设计思路是通过自定义注解@AiMetered标记需要计量的AI方法，结合AOP切面拦截方法调用，从入参中提取租户ID和问题文本，从返回值中提取Token使用量和模型类型，实时统计并持久化到时序数据库，同时检查租户月度配额。

```java
@Target(ElementType.METHOD)
@Retention(RetentionPolicy.RUNTIME)
public @interface AiMetered {
    String model() default "qwen-max";
    String tenantIdParam() default "tenantId";
    String costPerToken() default "0.000002"; // 美元/Token，约 2 美元/百万 Token，可按模型覆盖
}

@Aspect
@Component
public class AiMeterAspect {

    @Autowired
    private TenantQuotaService quotaService;
    @Autowired
    private MeterRegistry meterRegistry;
    @Autowired
    private AiUsageRepository usageRepository;

    @Around("@annotation(aiMetered)")
    public Object meter(ProceedingJoinPoint pjp, AiMetered aiMetered) throws Throwable {
        // 1. 提取租户ID（从方法参数中按注解配置的参数名查找）
        String tenantId = extractTenantId(pjp, aiMetered.tenantIdParam());

        // 2. 检查租户月度配额
        long monthlyUsed = quotaService.getMonthlyTokenUsage(tenantId);
        long monthlyLimit = quotaService.getMonthlyLimit(tenantId);
        if (monthlyUsed >= monthlyLimit) {
            log.warn("租户{}已达月度Token配额上限{}/{}, 拒绝AI调用", tenantId, monthlyUsed, monthlyLimit);
            meterRegistry.counter("carbon.ai.quota.exceeded",
                "tenant", tenantId, "model", aiMetered.model()).increment();
            throw new QuotaExceededException("碳AI助手月度使用量已达上限，请联系管理员升级配额");
        }

        // 3. 执行AI调用并计时
        long start = System.currentTimeMillis();
        Object result = pjp.proceed();
        long duration = System.currentTimeMillis() - start;

        // 4. 从返回值提取Token用量
        AiResponse aiResponse = (AiResponse) result;
        int promptTokens = aiResponse.getUsage().getPromptTokens();
        int completionTokens = aiResponse.getUsage().getCompletionTokens();
        int totalTokens = promptTokens + completionTokens;
        BigDecimal cost = BigDecimal.valueOf(totalTokens)
            .multiply(BigDecimal.valueOf(Double.parseDouble(aiMetered.costPerToken())));

        // 5. 持久化用量记录
        AiUsageRecord record = AiUsageRecord.builder()
            .tenantId(tenantId)
            .model(aiMetered.model())
            .promptTokens(promptTokens)
            .completionTokens(completionTokens)
            .totalTokens(totalTokens)
            .cost(cost)
            .durationMs(duration)
            .callTime(LocalDateTime.now())
            .build();
        usageRepository.save(record);

        // 6. 更新Micrometer指标（按租户+模型维度）
        Tags tags = Tags.of("tenant", tenantId, "model", aiMetered.model());
        meterRegistry.counter("carbon.ai.tokens.total", tags).increment(totalTokens);
        meterRegistry.counter("carbon.ai.tokens.prompt", tags).increment(promptTokens);
        meterRegistry.counter("carbon.ai.tokens.completion", tags).increment(completionTokens);
        // 按值类型选指标：累计量（请求数/token/成本）用 Counter 逐次累加；
        // 分布（延迟/大小）用 Timer 或 DistributionSummary；瞬时值（队列长度/活跃连接）才用 Gauge，
        // 且 Gauge 必须绑长生命周期的对象（如 AtomicInteger 字段或集合的 size），传字面量会被立即回收、读数恒为 0
        meterRegistry.counter("carbon.ai.cost.total", tags).increment(cost.doubleValue());
        meterRegistry.timer("carbon.ai.latency", tags).record(duration, TimeUnit.MILLISECONDS);

        // 7. 更新租户配额缓存
        quotaService.incrementTokenUsage(tenantId, totalTokens);

        return result;
    }

    private String extractTenantId(ProceedingJoinPoint pjp, String paramName) {
        // 通过反射或参数名解析获取租户ID
        MethodSignature signature = (MethodSignature) pjp.getSignature();
        String[] paramNames = signature.getParameterNames();
        for (int i = 0; i < paramNames.length; i++) {
            if (paramNames[i].equals(paramName)) {
                return String.valueOf(pjp.getArgs()[i]);
            }
        }
        return "default";
    }
}
```

**AI/碳管理场景关联：**
积木LCA云平台采用SaaS多租户模式，不同企业客户的碳管家AI助手使用量差异巨大。通过此AOP方案，平台可以精确统计每个租户调用通义千问 qwen-max 进行碳法规问答时的Token消耗和API成本，实现按量计费和配额管理。当某租户月度Token消耗超过合同约定的配额上限时，系统自动拦截后续AI调用并引导用户联系商务升级套餐，有效控制了大模型API调用成本。

---

#### 追问：
- 追问1：你在@Around里从返回值强转AiResponse并提取Token用量，如果某个被@AiMetered标记的方法返回的是Mono/Flux响应式结果或CompletableFuture异步结果，这种同步强转会从哪一步开始出错？
  - **答**：会从"强转"那步出错。方法返回 Mono/Flux 时，pjp.proceed() 返回的是响应式流而非 AiResponse，直接 (AiResponse) result 会 ClassCastException；CompletableFuture 同理。
    - 修正：对响应式/异步返回类型，切面不应同步强转，应在 onNext/onSuccess 回调里提取 Token 用量（如 doOnSuccess 计量），阻塞式计量要适配异步结果包装。
- 追问2：按租户维度扣减配额时，你用quotaService.incrementTokenUsage更新的是本地缓存还是数据库？如果切面执行成功但后续持久化usageRepository.save失败，会出现Token"已扣但无记录"的不一致吗，如何对账？
  - **答**：配额计数通常用 Redis/本地缓存做实时（快），DB 做持久化与对账。
    - 若切面已 increment 缓存但 usageRepository.save 失败，会出现"已扣无记录"不一致。
    - 兜底：
      - ① 先持久化明细再更新计数（以 DB 为准）
      - ② 用本地消息表/事务消息把 save 与计数放同一本地事务
      - ③ 对账任务定时用 usage 明细重算各租户实际用量，纠正缓存偏差
- 追问3：当上百个租户并发调用AI且都经过这个切面做配额检查与Micrometer打点，切面本身会不会成为热点锁或内存压力的来源？在高并发下你会怎么优化这段计量逻辑？
  - **答**：会。incrementTokenUsage 若用 synchronized 或集中 Redis key 会成热点；Micrometer 高基数 tag 有内存压力。
    - 优化：
      - ① 配额计数用 Redis INCR 原子命令无锁
      - ② 滑动窗口/批量聚合减少写频
      - ③ MeterRegistry 控制 tag 基数（租户维度按需，必要时降采样或分桶）
      - ④ 计量非关键路径可异步化（发事件由监听器落库），不阻塞主调用

### 8. AOP在API鉴权与数据权限控制中的应用
**重要度**：★★★★

**题目：**
请设计一个基于AOP的API鉴权切面，支持RBAC角色权限检查和数据范围控制（如某企业用户只能访问本企业的碳排放数据），并结合碳管理场景说明实现细节。

**解答：**
在SaaS碳管理平台中，鉴权分为两个层次：API访问权限（RBAC角色控制，决定用户能否调用某个接口）和数据范围权限（数据隔离控制，决定用户能查看哪些企业的数据）。通过AOP切面统一拦截，避免在每个Controller方法中重复编写鉴权代码。

```java
@Target(ElementType.METHOD)
@Retention(RetentionPolicy.RUNTIME)
public @interface RequiresPermission {
    String value();              // 权限标识，如 "carbon:report:query"
    DataScope dataScope() default DataScope.SELF_ORG; // 数据范围
}

public enum DataScope {
    ALL,          // 全部数据（平台管理员）
    SELF_ORG,     // 本组织数据
    SELF_DEPT     // 本部门数据
}

@Aspect
@Component
public class PermissionAspect {

    @Autowired
    private SecurityContextService securityContextService;
    @Autowired
    private OrganizationService organizationService;

    @Around("@annotation(requiresPermission)")
    public Object checkPermission(ProceedingJoinPoint pjp, RequiresPermission requiresPermission) throws Throwable {
        // 1. 获取当前登录用户
        CarbonUser currentUser = securityContextService.getCurrentUser();
        if (currentUser == null) {
            throw new UnauthorizedException("未登录或登录已过期");
        }

        // 2. RBAC权限检查：用户角色是否拥有该权限标识
        Set<String> userPermissions = securityContextService.getUserPermissions(currentUser.getId());
        if (!userPermissions.contains(requiresPermission.value())) {
            log.warn("用户{}无权限访问{}", currentUser.getUsername(), requiresPermission.value());
            throw new ForbiddenException("无权执行此操作：" + requiresPermission.value());
        }

        // 3. 数据范围权限控制：向ThreadLocal注入数据范围过滤条件
        DataScope scope = requiresPermission.dataScope();
        DataScopeContext context = new DataScopeContext();
        context.setUserId(currentUser.getId());
        context.setOrgId(currentUser.getOrgId());
        context.setDeptId(currentUser.getDeptId());
        context.setScope(scope);

        if (scope == DataScope.SELF_ORG) {
            List<Long> accessibleOrgIds = organizationService.getSubOrgIds(currentUser.getOrgId());
            context.setAccessibleOrgIds(accessibleOrgIds);
        }
        DataScopeContextHolder.set(context);

        try {
            return pjp.proceed();
        } finally {
            DataScopeContextHolder.clear(); // 清理ThreadLocal防止内存泄漏
        }
    }
}
```

在MyBatis-Plus或JPA层面，通过拦截器读取DataScopeContextHolder中的数据范围上下文，自动在SQL中追加`WHERE org_id IN (accessibleOrgIds)`条件，实现数据权限的透明过滤。

**AI/碳管理场景关联：**
碳管家AI助手的ragSearch接口标注@RequiresPermission(value = "carbon:ai:chat", dataScope = DataScope.SELF_ORG)，确保A企业的碳管理人员只能基于A企业的碳排放数据和碳法规知识库进行AI问答，无法跨企业检索。当用户提问"我们公司去年的碳排放趋势如何"时，AI系统在RAG检索阶段自动注入当前用户的企业ID过滤条件，仅从该企业的碳排放数据库和向量空间中检索相关数据，保障了SaaS平台的数据隔离安全。

---

#### 追问：
- 追问1：你把数据范围过滤条件写入ThreadLocal并在finally里清理，但如果被拦截的Controller方法内部又提交了异步任务（@Async）去查数据，子线程还能读到这个ThreadLocal里的组织ID吗？这会造成越权还是漏查？
  - **答**：读不到。ThreadLocal 是线程级隔离，@Async 由另一线程池线程执行，不继承父线程 DataScopeContext，子线程查数据无 org 过滤——属于"漏查"/或查全量（取决于实现）。
    - 修复：用 TaskDecorator/ContextCopyingTaskDecorator 拷贝上下文到异步线程；或用 TransmittableThreadLocal 跨线程传递；或把 orgId 显式作为参数传入异步方法。
- 追问2：DataScopeContextHolder通过MyBatis拦截器往SQL拼WHERE org_id IN (...)，如果某个查询用了UNION或子查询，拼接的租户过滤条件会完整地覆盖所有结果集分支吗？举一个会漏掉隔离的SQL例子。
  - **答**：不一定覆盖。MyBatis 拦截器通常只在最外层 SQL 拼 WHERE org_id IN(...)，对 UNION 各分支、子查询内层不会自动注入。
    - 例：`SELECT * FROM a WHERE ... UNION SELECT * FROM b WHERE ...` 仅外层有过滤，分支 b 可能返回其他租户数据；或子查询内层 other 表无 org 过滤。
    - 修复：拦截器对每个 SELECT 块（或所有相关 FROM 表）注入过滤，或统一用 row-level 视图/DB 层策略。
- 追问3：在碳管家AI助手的RAG检索阶段注入租户过滤，这个过滤是作用在Milvus的collection级别、partition级别还是query表达式级别？若误把A企业的向量写入了共享collection而仅靠query表达式过滤，会有什么数据泄露风险？
  - **答**：推荐 partition 级隔离（每租户独立 partition 或独立 collection），过滤作用在 partition key 上最安全。
    - query 表达式级过滤只在应用层生效，若向量误写入共享 collection，仅靠 query 过滤存在越权风险：向量库索引/统计可被旁路、内部绕过应用直接查拿到全量、混存影响召回质量。
    - 租户数据应物理隔离（独立 collection/partition），query 过滤仅作防御纵深。

#### 三、Spring 事务管理

### 9. Spring事务传播行为详解与场景选择
**重要度**：★★★★

**题目：**
请详细说明Spring的7种事务传播行为（PROPAGATION_REQUIRED、REQUIRES_NEW、NESTED、SUPPORTS、NOT_SUPPORTED、NEVER、MANDATORY），并针对每种行为给出碳管理场景下的使用示例。

**解答：**
Spring定义了7种事务传播行为，决定了当前方法是否加入外层事务或创建新事务：

1. **REQUIRED（默认）**：当前有事务则加入，没有则新建。适用于大多数业务场景。碳管家中，AI问答记录保存和Token用量记录保存在同一个事务中，任一失败全部回滚。

2. **REQUIRES_NEW**：无论当前是否有事务，都新建独立事务，外层事务挂起。适用于日志记录等不应被外层事务回滚影响的操作。碳管家中，AI调用异常时需要记录错误日志到数据库，即使外层事务回滚，错误日志仍需保留：`@Transactional(propagation = Propagation.REQUIRES_NEW)`。

3. **NESTED**：当前有事务则创建嵌套事务（基于Savepoint），没有则新建。嵌套事务的回滚不影响外层事务，但外层事务回滚会连带回滚嵌套事务。碳管家中，批量生成碳排放报告时，每份报告的生成是嵌套事务，单份报告生成失败不影响其他报告，但外层批量任务失败时所有报告都回滚。

4. **SUPPORTS**：当前有事务则加入，没有则以非事务方式执行。适用于查询操作，碳管家中查询碳排放历史数据使用SUPPORTS，有事务则参与一致性读，无事务则普通查询。

5. **NOT_SUPPORTED**：以非事务方式执行，当前有事务则挂起。适用于耗时操作避免长事务。碳管家中，AI大模型推理调用（可能耗时10秒以上）使用NOT_SUPPORTED，避免长时间占用数据库连接。

6. **NEVER**：以非事务方式执行，当前有事务则抛异常。碳管家中，调用外部碳排认证API时使用NEVER，确保不会在事务中等待外部HTTP响应。

7. **MANDATORY**：必须在事务中执行，否则抛异常。碳管家中，核心的碳排放数据写入方法使用MANDATORY，强制调用方必须提供事务上下文，防止误调用导致数据不一致。

**AI/碳管理场景关联：**
碳管家AI助手在生成碳排放报告时的典型事务设计：外层方法generateReport使用REQUIRED创建主事务，内部调用persistReport（REQUIRED，加入主事务）、recordAiUsage（REQUIRES_NEW，独立事务记录Token用量）、sendNotification（NOT_SUPPORTED，非事务方式发送通知）。当报告保存失败时主事务回滚，但Token用量记录因独立事务而保留，通知不发送。这种设计确保了AI调用成本记录的完整性，即使报告生成失败也能追踪Token消耗。

---

#### 追问：
- 追问1：你说AI大模型推理调用要用NOT_SUPPORTED避免长事务占用连接，但ChatClient底层用的是HTTP连接池而非数据库连接，Spring的事务挂起机制到底释放的是什么资源？NOT_SUPPORTED在这里真正解决的问题是什么？
  - **答**：事务挂起释放的是"数据库连接/事务上下文"资源。ChatClient 走 HTTP 连接池不占 DB 连接，但若方法处于 REQUIRED 事务中，会在整个 AI 推理期间（数秒）持有一条 DB 连接不释放，阻塞连接池。
    - NOT_SUPPORTED 把外层事务挂起、方法以非事务执行，使 DB 连接尽早归还池，真正解决"长耗时 AI 调用占用数据库连接导致连接池耗尽"。
- 追问2：generateReport里recordAiUsage用REQUIRES_NEW，如果主事务在persistReport成功之后、recordAiUsage之前JVM崩溃，Token用量记录会丢失吗？这种"成本记录与主业务不一致"在计费对账上怎么兜底？
  - **答**：会丢失。REQUIRES_NEW 的 recordAiUsage 在独立事务，若主事务在它之前崩溃，它根本没触发，Token 用量记录缺失。
    - 兜底：
      - ① 用本地消息表，主业务落库时写"待记账"消息，后台任务补偿记账保证最终一致
      - ② 计费以 usage 明细表为准定期对账，发现主业务成功但无用量记录则补记
      - ③ 关键成本用 TCC 把扣费作为主流程一部分

### 10. 事务隔离级别与数据库隔离级别的协同关系
**重要度**：★★★★

**题目：**
请说明Spring事务的5种隔离级别（DEFAULT、READ_UNCOMMITTED、READ_COMMITTED、REPEATABLE_READ、SERIALIZABLE），它们与底层数据库隔离级别的关系，以及在并发碳数据统计场景中如何选择。

**解答：**
Spring事务隔离级别是对底层数据库隔离级别的封装和覆盖。DEFAULT表示使用数据库默认隔离级别（MySQL InnoDB为REPEATABLE_READ，Oracle为READ_COMMITTED）。其余四种与SQL标准定义一致，但最终生效的隔离级别取决于数据库引擎的支持情况。

各隔离级别解决的问题：READ_UNCOMMITTED存在脏读（读到未提交数据）；READ_COMMITTED解决脏读但存在不可重复读（同一事务内两次读取结果不同）；REPEATABLE_READ解决不可重复读但存在幻读（同一事务内两次范围查询结果集不同）；SERIALIZABLE解决所有并发问题但性能最差。

MySQL InnoDB的特殊性：其在REPEATABLE_READ级别下通过MVCC（多版本并发控制）和Next-Key Locking机制，已经解决了幻读问题，因此 InnoDB 的 RR 在幻读维度达到了 SQL 标准中通常需 SERIALIZABLE 才能保证的程度（但二者并不等价：SERIALIZABLE 还会对普通 SELECT 加共享范围锁，语义更强、性能更差）。

在碳管理平台中的选择策略：碳排放数据写入场景（如录入碳排放源数据）使用MySQL默认的REPEATABLE_READ即可，InnoDB的MVCC机制能保证读取一致性。但AI批量统计场景需要特别注意：当AI助手批量读取多张碳排放表生成汇总报告时，如果并发有数据写入操作，可能读到不一致的中间状态。解决方案是使用乐观锁（version字段）或在关键统计接口使用SERIALIZABLE隔离级别（牺牲并发性能换取强一致性）。

```java
@Service
public class CarbonReportService {

    @Transactional(isolation = Isolation.REPEATABLE_READ)
    public CarbonStatistics generateAnnualReport(Long orgId, int year) {
        // 在RR隔离级别下，整个方法内的多次读取看到的是同一快照
        List<EmissionSource> sources = emissionSourceMapper.findByOrgAndYear(orgId, year);
        BigDecimal totalEmission = sources.stream()
            .map(EmissionSource::getEmissionAmount)
            .reduce(BigDecimal.ZERO, BigDecimal::add);
        // 此时即使有新数据写入，读取的sources仍是一致快照
        List<Offset> offsets = offsetMapper.findByOrgAndYear(orgId, year);
        BigDecimal netEmission = totalEmission.subtract(
            offsets.stream().map(Offset::getAmount).reduce(BigDecimal.ZERO, BigDecimal::add));
        return new CarbonStatistics(totalEmission, netEmission);
    }

    @Transactional(isolation = Isolation.SERIALIZABLE)
    public void batchImportEmissionData(Long orgId, List<EmissionData> dataList) {
        // 串行化隔离级别防止并发导入导致的数据重复
        for (EmissionData data : dataList) {
            if (emissionMapper.existsByUniqueKey(orgId, data.getUniqueKey())) {
                throw new DuplicateDataException("碳排放数据重复：" + data.getUniqueKey());
            }
            emissionMapper.insert(data);
        }
    }
}
```

**AI/碳管理场景关联：**
碳管家AI助手在生成企业年度碳排报告时，需要从碳排放源表、碳抵消表、碳配额表等多张表读取数据进行汇总计算。使用REPEATABLE_READ隔离级别确保AI在整个报告生成过程中看到的是同一时间点的数据快照，避免因并发写入导致报告数据前后矛盾。对于AI辅助的批量碳排放数据导入接口，使用SERIALIZABLE级别防止并发导入产生重复记录。

---

#### 追问：
- 追问1：碳管家AI助手生成年度碳报告时用REPEATABLE_READ保证快照一致，如果报告生成过程中需要调用大模型推理（耗时数秒）并多次查库，这期间MVCC快照会一直保持，会不会导致读到的碳排放源数据"太旧"而漏掉刚提交的关键修正数据？
  - **答**：会。RR 下整个方法期间 MVCC 快照固定，若报告生成跨数秒且在 LLM 推理期间有修正数据提交，本次报告读到旧快照，可能漏掉关键修正。
    - 权衡：
      - ① 报告生成不在事务内做长耗时 LLM 调用，先把数据快照读到内存（短事务），再在事务外汇总
      - ② 或接受"报告基于生成开始时刻快照"并在报告注明数据截至时间
      - ③ 实时性高则用 READ_COMMITTED + version 乐观锁
- 追问2：你用SERIALIZABLE做批量导入防重复，但SERIALIZABLE在MySQL下会加间隙锁，如果多个企业的导入请求并发执行，会不会出现大面积锁等待甚至死锁？生产上你会如何权衡？
  - **答**：会。SERIALIZABLE 在 MySQL 下加 Next-Key 间隙锁，多企业并发导入相同/相邻唯一键范围会互斥等待，高并发可能死锁。
    - 生产权衡：
      - ① 导入改为唯一约束 + 捕获 DuplicateKeyException，隔离级别降 RC/RR
      - ② 用分布式锁按 orgId 分桶减小锁粒度
      - ③ 批量导入放低峰期、分批提交
      - ④ 用幂等唯一键 + 应用层去重，避免依赖 SERIALIZABLE 强锁

### 11. @Transactional失效的8大场景与根因分析
**重要度**：★★★★★

**题目：**
请列举@Transactional注解失效的所有常见场景，分析每个场景的根因，并给出碳管理项目中的修复方案。

**解答：**
@Transactional失效是Spring面试高频考点，常见失效场景及其根因如下：

**场景1：方法非public**。Spring AOP通过CGLIB或JDK代理拦截方法调用，默认仅对public方法生成事务代理。protected、private、包级可见的方法标注@Transactional不生效。根因是AbstractFallbackTransactionAttributeSource.computeTransactionAttribute方法中显式检查了Modifier.isPublic。

**场景2：同类内部方法调用**。同一个类中方法A调用方法B，即使B标注了@Transactional也不生效。根因是内部调用使用this引用而非代理对象，不经过AOP拦截链。解决方案：通过AopContext.currentProxy()获取代理对象调用，或将方法B拆到另一个Bean中。

**场景3：异常被catch吞掉**。方法内部try-catch捕获了异常且未重新抛出，事务管理器感知不到异常，不会触发回滚。解决方案：catch后手动调用TransactionAspectSupport.currentTransactionStatus().setRollbackOnly()，或将异常重新抛出。

**场景4：rollbackFor未配置**。Spring默认仅对RuntimeException和Error回滚，对checked Exception不回滚。碳管理中如果抛出IOException等checked异常，需配置@Transactional(rollbackFor = Exception.class)。

**场景5：数据库引擎不支持事务**。MySQL的MyISAM引擎不支持事务，需使用InnoDB。检查表的ENGINE配置。

**场景6：事务管理器未配置**。Spring Boot自动配置了DataSourceTransactionManager，但多数据源场景下需手动配置对应的事务管理器，并通过@Transactional(transactionManager = "xxx")指定。

**场景7：Bean未被Spring管理**。通过new创建的对象不经过Spring代理，@Transactional不生效。确保类标注了@Component等Spring注解。

**场景8：传播行为配置不当**。方法配置了NOT_SUPPORTED或NEVER传播行为，会以非事务方式执行。

```java
@Service
public class CarbonDataServiceImpl implements CarbonDataService {

    @Autowired
    private CarbonDataService self; // 通过依赖注入获取代理对象

    @Transactional(rollbackFor = Exception.class)
    public void importCarbonData(List<CarbonData> list) {
        for (CarbonData data : list) {
            try {
                // 错误：内部调用不经过代理
                // this.saveOne(data);

                // 正确：通过注入的代理对象调用
                self.saveOne(data);
            } catch (Exception e) {
                log.error("导入失败: {}", data, e);
                // 内层已加入同一事务，这里的 markRollbackOnly 才能连带撤销内层的 insert
                TransactionAspectSupport.currentTransactionStatus().setRollbackOnly();
                throw e;
            }
        }
    }

    // REQUIRED：加入外层事务，与外层同生共死；不能写成 REQUIRES_NEW（见下方说明）
    @Transactional(rollbackFor = Exception.class, propagation = Propagation.REQUIRED)
    public void saveOne(CarbonData data) {
        carbonDataMapper.insert(data);
    }
}
```

**关于 REQUIRES_NEW 的坑**：如果把 `saveOne` 改成 `Propagation.REQUIRES_NEW`，内层就是**独立事务、会先提交**；外层随后 `setRollbackOnly` 或抛异常回滚，**撤销不了已经提交的内层数据**，最终表现为"导入报错但部分数据已落库"。确需 REQUIRES_NEW 单条独立提交时，必须显式接受这种部分提交并配补偿删除，绝不能与 setRollbackOnly 混用；若想"内层失败只回滚自己、外层可继续"应改用 `NESTED`（依赖数据库 savepoint）。

**AI/碳管理场景关联：**
碳管家AI助手在处理碳法规问答对话保存时，曾出现同类内部调用导致@Transactional失效的问题：chat方法内部直接调用saveChatRecord方法，当保存对话记录失败时事务未回滚，导致Token用量已扣减但对话记录丢失。修复方案是将saveChatRecord方法提取到独立的ChatRecordService中，通过依赖注入调用，确保事务代理生效。同时配置rollbackFor = Exception.class确保所有异常都触发回滚，保障对话记录与Token用量的数据一致性。

---

#### 追问：
- 追问1：你把saveOne拆到独立Service并通过self代理调用解决同类调用失效，但如果你用@Autowired注入的self本身又经过CGLIB代理，递归调用链上每一次self.saveOne都会重新走一遍事务拦截吗？深度批量导入时有性能隐患吗？
  - **答**：会。self 是代理对象，每次 self.saveOne 都走一遍事务拦截（开启/提交/回滚），深度批量导入 N 条就 N 次事务开销，性能差且连接占用高。
    - 优化：
      - ① 批量导入改为单事务一次 insertBatch，避免逐条事务
      - ② 若需逐条 REQUIRES_NEW 隔离，考虑批量提交减少事务次数
      - ③ 用 JDBC batch / MyBatis foreach 批量写，事务只在外层开一次
- 追问2：在碳管家AI助手中，chat方法保存对话记录和扣减Token若分属两个事务，当扣减Token成功但对话记录因@Transactional失效而没回滚，会出现用户Token被扣却查不到对话的"幽灵扣费"，你如何设计让二者要么都成功要么都失败？
  - **答**：把"扣 Token"与"存对话记录"放进同一本地事务（REQUIRED，同事务管理器），对话失败则事务回滚同时撤销 Token 扣减，避免幽灵扣费。
    - 若二者分属不同服务/数据源，用 TCC/本地消息表保证最终一致：扣减作为 Try 预扣，对话落库成功再 Confirm 真正扣减，失败 Cancel 释放预扣，确保二者对齐。

### 12. 分布式事务方案对比与在微服务碳管理中的实践
**重要度**：★★★★

**题目：**
请对比分布式事务的主流方案（2PC、3PC、TCC、Saga、本地消息表、事务消息），分析各自的优缺点，并说明在积木LCA云平台微服务架构中如何选择分布式事务方案。

**解答：**
分布式事务方案的演进路径是从强一致性到最终一致性的权衡：

**2PC（两阶段提交）**：协调者先发送prepare请求让所有参与者锁定资源，再发送commit/rollback。优点是强一致性，缺点是同步阻塞、协调者单点故障、数据不一致风险（网络分区时）。XA协议是2PC的标准实现，性能较差，不适合高并发场景。

**3PC**：在2PC基础上增加CanCommit阶段和超时机制，降低了阻塞范围，但引入了新的不一致风险，实际应用较少。

**TCC（Try-Confirm-Cancel）**：业务层面的两阶段提交。Try阶段预留资源（如预扣Token配额），Confirm阶段确认执行（实际扣减），Cancel阶段释放资源（回滚预扣）。优点是性能好、可控性强，缺点是业务侵入大、需实现三个接口、需处理空回滚、幂等、悬挂等问题。适合对一致性要求高且并发量大的场景。

**Saga**：将长事务拆分为多个本地事务，每个事务有对应的补偿操作。正常执行T1→T2→T3，失败时执行C3→C2→C1补偿。优点是无资源锁定、适合长流程事务，缺点是缺乏隔离性（中间状态可见）、补偿逻辑复杂。

**本地消息表**：在本地事务中同时写入业务数据和消息表，通过后台任务轮询消息表发送消息到MQ。优点是实现简单、无需额外组件，缺点是消息表压力大、有延迟。

**事务消息（RocketMQ）**：利用RocketMQ的半消息机制实现最终一致性。发送方先发半消息，执行本地事务后commit/rollback半消息。优点是性能好、可靠性高，缺点是依赖RocketMQ。

在积木LCA云平台微服务架构中的方案选择：

1. **AI问答+计费场景（TCC）**：用户调用碳管家AI助手，需同时扣减Token配额（计费服务）和保存对话记录（AI服务）。使用TCC方案，Try阶段预扣Token配额，Confirm阶段确认扣减并保存记录，Cancel阶段释放预扣配额。

2. **碳报告生成+通知场景（Saga）**：AI生成碳排放报告后需更新报告状态（报告服务）、发送通知（通知服务）、推送数据到监管平台（对接服务）。使用Saga编排模式，任一步骤失败自动触发补偿。

3. **碳数据同步场景（本地消息表+MQ）**：碳排放数据变更需同步到AI向量库和数仓。在数据写入事务中同时写入消息表，后台任务读取消息表发送到RocketMQ，各消费者独立更新向量库和数仓。

**AI/碳管理场景关联：**
碳管家AI助手的"一键生成碳报告"功能涉及多个微服务的协作：AI服务调用大模型生成报告内容、报告服务保存报告文件、计费服务扣减Token配额、通知服务发送完成提醒。采用Seata Saga模式，由AI服务作为编排者，依次调用各服务的正向操作，如果通知服务失败，则自动执行报告服务删除和计费服务退费的补偿操作，确保跨服务数据最终一致。同时，对于Token配额扣减这一强一致性需求场景，采用TCC模式确保配额不会超扣。

---

#### 追问：
- 追问1：Token配额扣减用TCC，Try阶段预扣配额，如果Confirm阶段（实际扣减并保存记录）失败了，空回滚和悬挂问题会如何表现？用户会看到配额被永久预扣无法恢复吗？
  - **答**：Confirm 失败需重试保证最终扣减。空回滚：Try 未执行却收到 Cancel，记录"空回滚"标记后返回成功，避免误判；悬挂：Cancel 早于 Try 到达，Try 到达发现已有空回滚标记应直接丢弃，防预扣后又被释放。
    - 用户视角：Confirm 失败会重试至成功，配额最终正确；若 Try 预扣后长期 Confirm 不上，需超时兜底（定时扫描"已预扣未确认"做确认/释放），不会永久预扣。
- 追问2：报告生成用Seata Saga编排，补偿操作（删除报告、退费）本身如果也失败了，Saga怎么保证最终一致？在碳管家AI助手场景里，补偿失败会留下"半生成报告"的脏数据吗？
  - **答**：Saga 靠"重试补偿 + 最终一致"保证。补偿失败：
    - ① 补偿操作设计为幂等，由协调器按指数退避重试至成功
    - ② 失败记死信/告警，人工或定时任务介入
    - ③ 关键补偿（退费）走可靠队列确保不丢
    - "半生成报告"会留脏数据，需用状态机标记"生成失败/已补偿"，前端据此展示，并定期扫描异常状态修复，保证最终一致而非强一致。
- 追问3：在你的方案里AI问答+计费同时涉及TCC和本地消息表，如果引入RocketMQ事务消息后Broker与本地库之间出现"半消息已发但本地事务回滚"的情况，碳管家AI助手会怎样处理这份额外的消息，如何避免重复生成报告？
  - **答**：半消息在本地事务回滚时会被 broker 丢弃（不投递），正常不触发消费。但若异常导致"本地已回滚却错误 commit 半消息"，消费者可能收到。
    - 防重复：
      - ① 消费端用 reportId/msgKey 做幂等（唯一约束/去重表），同消息只生成一次报告
      - ② 本地事务与半消息严格对齐，仅本地成功才 commit
      - ③ 消费失败重试 + 幂等，避免重复生成

#### 四、Spring MVC 原理

### 13. DispatcherServlet请求处理完整流程
**重要度**：★★★★★

**题目：**
请详细描述Spring MVC中DispatcherServlet处理一个HTTP请求的完整流程，包括各个组件的调用顺序和职责。

**解答：**
DispatcherServlet是Spring MVC的前端控制器，所有请求经过前端控制器统一分发。完整处理流程如下：

1. **请求到达DispatcherServlet**：客户端发送HTTP请求，首先经过Servlet容器的Filter链（如Spring Security过滤器链、字符编码过滤器等），然后到达DispatcherServlet。

2. **doDispatch方法入口**：DispatcherServlet的doService方法设置请求属性（如上下文信息），然后调用doDispatch方法进行核心分发。

3. **multipart检查**：调用checkMultipart方法判断是否为文件上传请求，如果是则将请求包装为MultipartHttpServletRequest。碳管理中上传碳排放Excel文件时走此流程。

4. **HandlerMapping查找处理器**：调用getHandler方法，遍历所有已注册的HandlerMapping（如RequestMappingHandlerMapping、BeanNameUrlHandlerMapping），根据URL路径和HTTP方法找到对应的HandlerExecutionChain。HandlerExecutionChain包含目标Handler（Controller方法）和一组HandlerInterceptor（拦截器）。

5. **拦截器前置处理**：调用 `applyPreHandle`，按顺序执行 HandlerInterceptor.preHandle；任一拦截器返回 false 则立即中断请求——**不会进入参数解析与 Controller**，且只会对"已成功执行完 preHandle 的那些拦截器"逆序回调 afterCompletion。

6. **HandlerAdapter适配**：根据 Handler 类型选择对应的 HandlerAdapter（如 RequestMappingHandlerAdapter），调用其 `handle` 方法；参数解析与 Controller 反射调用都发生在这个 handle 内部（见第 7、8 步）。

7. **参数解析与绑定（ha.handle 内部第一步）**：HandlerAdapter调用HandlerMethodArgumentResolver解析方法参数（如@RequestBody反序列化JSON、@PathVariable提取路径变量、@RequestHeader提取请求头），DataBinder完成参数绑定和校验。

8. **Controller方法执行**：通过反射调用Controller方法，执行业务逻辑，返回ModelAndView或直接返回对象（@ResponseBody场景由HttpMessageConverter序列化为JSON）。

9. **拦截器后置处理**：逆序执行HandlerInterceptor.postHandle方法，可对ModelAndView进行修改。

10. **视图渲染或响应写入**：如果是REST API（@ResponseBody），结果通过HttpMessageConverter（如MappingJackson2HttpMessageConverter）序列化为JSON写入响应体。如果是页面渲染，ViewResolver解析视图名并渲染HTML。

11. **异常处理**：如果执行过程中抛出异常，DispatcherServlet调用HandlerExceptionResolver（如ExceptionHandlerExceptionResolver）处理异常，@ExceptionHandler方法在此阶段被调用。

12. **拦截器完成处理**：无论正常或异常，都会执行HandlerInterceptor.afterCompletion方法进行资源清理。

**AI/碳管理场景关联：**
碳管家AI助手的POST /api/carbon-ai/chat请求经过完整流程：Filter链中Spring Security验证JWT Token→DispatcherServlet→RequestMappingHandlerMapping匹配到AiController.chat方法→拦截器preHandle检查租户配额→HandlerAdapter解析@RequestBody ChatRequest→Controller调用CarbonChatService.chat→ChatService执行RAG检索+大模型推理→@ResponseBody将ChatResponse序列化为JSON→拦截器afterCompletion记录调用日志。整个过程约300-5000ms，可通过拦截器统计各阶段耗时定位性能瓶颈。

---

#### 追问：
- 追问1：你提到AI对话请求在DispatcherServlet前先经过Spring Security过滤链验证JWT，如果JWT校验通过但后续HandlerInterceptor的租户配额检查在preHandle里返回false，此时已经经过的安全上下文会被清理吗？会不会有ThreadLocal泄漏？
  - **答**：Spring Security 的 SecurityContext 在请求结束由过滤器统一清理（5.x 是 SecurityContextPersistenceFilter，6.x 是 SecurityContextHolderFilter，在 finally 中 clearContext），不依赖 interceptor，正常不会泄漏；但自定义 TenantContext 等 ThreadLocal 必须在 afterCompletion 清理，否则线程池复用会串租户。
    - 统一用 once-per-request 清理或 TransmittableThreadLocal + 清理，避免 JWT 校验通过、preHandle 返回 false 后仍残留上下文。
- 追问2：碳管家AI助手的chat接口响应可能长达5秒，如果客户端在模型推理中途断开了HTTP连接，DispatcherServlet和HandlerAdapter能感知到吗？正在进行的Milvus检索和大模型推理会被中断还是继续跑完浪费资源？
  - **答**：默认不感知。Servlet 容器在请求线程写响应时才发现连接断开，controller 仍在跑，Milvus 检索与 LLM 推理会继续跑完（浪费资源与 Token）。
    - 改善：
      - ① 用响应式/Callable/DeferredResult 配合客户端断开回调中断下游
      - ② LLM 调用设较短超时
      - ③ 异步场景监听 response 关闭事件取消 CompletableFuture/HTTP 调用
      - ④ 网关层超时与后端对齐

### 14. 拦截器（HandlerInterceptor）与过滤器（Filter）的对比与选择
**重要度**：★★★★

**题目：**
请详细对比Spring MVC中拦截器和过滤器的区别，包括执行顺序、作用范围、依赖注入能力，并说明在碳管理AI项目中如何合理选择使用。

**解答：**
拦截器和过滤器都是请求处理的横切组件，但存在本质区别：

**生命周期与规范**：Filter是Servlet规范的一部分，定义在javax.servlet（Jakarta EE中为jakarta.servlet）包下，由Servlet容器管理。HandlerInterceptor是Spring MVC框架的组件，定义在org.springframework.web.servlet包下，由Spring容器管理。

**执行时机与范围**：Filter在DispatcherServlet之前和之后执行，能拦截所有请求（包括静态资源、错误页面）。HandlerInterceptor在DispatcherServlet内部执行，仅拦截进入Spring MVC的请求，不拦截静态资源。执行顺序为：Filter→DispatcherServlet→Interceptor.preHandle→Controller→Interceptor.postHandle→视图渲染→Interceptor.afterCompletion→DispatcherServlet→Filter。

**依赖注入**：Filter作为Servlet组件，默认不支持Spring依赖注入（需通过DelegatingFilterProxy或FilterRegistrationBean将Filter注册为Spring Bean才能使用@Autowired）。HandlerInterceptor天然是Spring Bean，直接支持依赖注入。

**功能能力**：Filter可以修改请求和响应对象（如Gzip压缩、跨域处理、字符编码）。HandlerInterceptor可以访问HandlerExecutionChain，知道目标处理器信息，可以中断处理链但不能直接修改请求/响应对象的底层流。

**执行顺序控制**：Filter通过@Order或FilterRegistrationBean.setOrder控制顺序。Interceptor通过实现Ordered接口或注册时的order参数控制顺序。

在碳管理AI项目中的选择原则：

**使用Filter的场景**：JWT Token解析和验证（在Spring Security之前预处理）、CORS跨域处理、Gzip响应压缩、请求日志记录（记录原始请求体，因为Interceptor中请求流可能已被消费）。碳管家中，所有/api/carbon-ai/**请求的CORS策略通过CorsFilter统一配置。

**使用Interceptor的场景**：API权限检查（需要知道目标Controller方法及其权限注解）、租户上下文设置（从Token提取租户ID放入ThreadLocal）、API调用审计日志（需要知道具体调用的方法）、限流检查（按API维度限流）。碳管家中，AiApiInterceptor拦截所有AI接口，在preHandle中检查租户Token配额并设置TenantContext。

```java
@Component
public class TenantContextInterceptor implements HandlerInterceptor {

    @Autowired
    private JwtTokenService jwtTokenService;
    @Autowired
    private TenantQuotaService quotaService;

    @Override
    public boolean preHandle(HttpServletRequest request, HttpServletResponse response,
                             Object handler) throws Exception {
        if (!(handler instanceof HandlerMethod)) return true;

        // 从Authorization头提取JWT并解析租户ID
        String token = request.getHeader("Authorization");
        if (token == null || !token.startsWith("Bearer ")) {
            response.sendError(401, "未提供有效的认证Token");
            return false;
        }

        CarbonUser user = jwtTokenService.parseToken(token.substring(7));

        // 先做配额检查，再写 ThreadLocal：preHandle 返回 false 时本拦截器的 afterCompletion 不会被调用，
        // 若先 set 再 return false，TenantContext 会永久残留，线程池复用即串租户
        if (!quotaService.checkQuota(user.getTenantId())) {
            response.setStatus(429);
            response.setContentType("application/json;charset=UTF-8");
            response.getWriter().write("{\"code\":429,\"message\":\"碳AI助手调用次数已达上限\"}");
            return false;
        }

        TenantContext.set(TenantContext.builder()
            .tenantId(user.getTenantId())
            .userId(user.getId())
            .username(user.getUsername())
            .role(user.getRole())
            .build());

        return true;
    }

    @Override
    public void afterCompletion(HttpServletRequest request, HttpServletResponse response,
                                Object handler, Exception ex) {
        TenantContext.clear(); // 清理ThreadLocal
    }
}
```

**这是拦截器里最常见的 ThreadLocal 泄漏写法**：`afterCompletion` 只对 preHandle 返回 true 的拦截器回调；preHandle 里 `return false` 时，`triggerAfterCompletion` 只会逆序回调"已经成功执行完 preHandle 的那些拦截器"，**当前拦截器自己 set 的 ThreadLocal 不会被清**。所以要么把配额判断放在 set 之前（如上），要么在每个 return false 分支前手动 `TenantContext.clear()`。

**AI/碳管理场景关联：**
碳管家AI助手采用Filter+Interceptor双层设计：CorsFilter处理跨域、JwtAuthFilter（Spring Security）完成JWT认证；TenantContextInterceptor设置租户上下文和配额检查、AiAuditInterceptor记录AI调用审计日志。分层设计使职责清晰：Filter层关注协议级处理，Interceptor层关注业务级鉴权，避免了在每个Controller方法中重复编写租户检查和配额校验代码。

---

#### 追问：
- 追问1：你的TenantContextInterceptor在preHandle里解析JWT并set到ThreadLocal、afterCompletion里清理，但如果Controller方法里抛出的异常被@ControllerAdvice捕获处理后正常返回，afterCompletion仍会执行吗？租户上下文会不会残留到下一个请求复用同一线程时？
  - **答**：会。@ControllerAdvice 的 @ExceptionHandler 在 DispatcherServlet 异常处理阶段被调用，但 HandlerInterceptor.afterCompletion 仍会在之后执行（无论正常或异常返回），TenantContext 清理依然发生，不会残留。
    - 注意：异常若发生在 preHandle 之前或 filter 阶段，interceptor 的 afterCompletion 可能不触发，需在 filter 也做兜底清理。
- 追问2：RateLimitFilter基于Redis做每用户每分钟20次限流，在碳管家AI助手的多实例部署下，如果各个Pod各自用本地Redis连接且未共享限流计数，限流会失效吗？分布式限流该怎么做？
  - **答**：会失效。各 Pod 用本地独立 Redis（或未共用同一实例），限流计数分散，单 Pod 不超阈但全局已超，限流形同虚设。
    - 分布式限流：
      - ① 所有 Pod 连同一 Redis，用 INCR+EXPIRE 或 Lua 脚本原子做"每用户每分钟 N 次"
      - ② 或用网关层（Nginx/APISIX/Sentinel）统一限流
      - ③ Redis + 滑动窗口/令牌桶保证全局一致

### 15. 统一异常处理（@ControllerAdvice + @ExceptionHandler）
**重要度**：★★★★

**题目：**
请设计碳管理AI助手的统一异常处理方案，包括全局异常处理器、自定义异常体系、统一响应格式，并处理AI服务特有的异常（如模型超时、Token超限、内容违规等）。

**解答：**
统一异常处理的核心是@ControllerAdvice（或@RestControllerAdvice）配合@ExceptionHandler，集中管理所有异常的处理逻辑，避免在Controller中散落大量try-catch。

```java
// 统一响应格式
@Data
@Schema(description = "统一响应格式")
public class ApiResponse<T> {
    private int code;
    private String message;
    private T data;
    private String traceId;
    private long timestamp;

    public static <T> ApiResponse<T> success(T data) {
        return ApiResponse.<T>builder()
            .code(200).message("success").data(data)
            .traceId(MDC.get("traceId"))
            .timestamp(System.currentTimeMillis())
            .build();
    }

    public static <T> ApiResponse<T> error(int code, String message) {
        return ApiResponse.<T>builder()
            .code(code).message(message)
            .traceId(MDC.get("traceId"))
            .timestamp(System.currentTimeMillis())
            .build();
    }
}

// 自定义异常体系
@Getter
public abstract class CarbonAiException extends RuntimeException {
    private final int code;
    protected CarbonAiException(int code, String message) {
        super(message);
        this.code = code;
    }
}

public class ModelTimeoutException extends CarbonAiException {
    public ModelTimeoutException(String model, long timeoutMs) {
        super(504, String.format("AI模型[%s]响应超时（%dms），请稍后重试", model, timeoutMs));
    }
}

public class TokenLimitExceededException extends CarbonAiException {
    public TokenLimitExceededException(int used, int limit) {
        super(429, String.format("Token用量超限：%d/%d，请精简问题或联系管理员", used, limit));
    }
}

public class ContentViolationException extends CarbonAiException {
    public ContentViolationException(String reason) {
        super(400, "内容审核未通过：" + reason);
    }
}

public class VectorStoreException extends CarbonAiException {
    public VectorStoreException(String detail) {
        super(500, "碳知识库检索失败：" + detail);
    }
}

// 全局异常处理器
@RestControllerAdvice
@Slf4j
public class GlobalExceptionHandler {

    @Autowired
    private MeterRegistry meterRegistry;

    // 业务异常 - 已知错误，返回具体信息
    @ExceptionHandler(CarbonAiException.class)
    public ResponseEntity<ApiResponse<Void>> handleCarbonAiException(CarbonAiException ex) {
        log.warn("碳AI业务异常: code={}, msg={}", ex.getCode(), ex.getMessage());
        meterRegistry.counter("carbon.ai.exception",
            "type", ex.getClass().getSimpleName()).increment();
        return ResponseEntity.status(ex.getCode())
            .body(ApiResponse.error(ex.getCode(), ex.getMessage()));
    }

    // 参数校验异常
    @ExceptionHandler(MethodArgumentNotValidException.class)
    public ResponseEntity<ApiResponse<Map<String, String>>> handleValidation(
            MethodArgumentNotValidException ex) {
        Map<String, String> errors = new HashMap<>();
        ex.getBindingResult().getFieldErrors().forEach(e ->
            errors.put(e.getField(), e.getDefaultMessage()));
        return ResponseEntity.badRequest()
            .body(ApiResponse.<Map<String, String>>builder()
                .code(400).message("参数校验失败").data(errors).build());
    }

    // Spring Security 认证异常（注意：只覆盖 Controller 内抛出的情况）
    // Filter 链中的认证失败（ProviderManager / AuthenticationEntryPoint 层）根本到不了
    // HandlerExceptionResolver，必须由 SecurityFilterChain 的 authenticationEntryPoint 处理
    @ExceptionHandler(AuthenticationException.class)
    public ResponseEntity<ApiResponse<Void>> handleAuth(AuthenticationException ex) {
        return ResponseEntity.status(401)
            .body(ApiResponse.error(401, "认证失败：" + ex.getMessage()));
    }

    // Spring Security 授权异常（同理：Filter 层的 AccessDeniedException 由 ExceptionTranslationFilter
    // 转交 accessDeniedHandler，不会进到 @ControllerAdvice）
    @ExceptionHandler(AccessDeniedException.class)
    public ResponseEntity<ApiResponse<Void>> handleAccessDenied(AccessDeniedException ex) {
        return ResponseEntity.status(403)
            .body(ApiResponse.error(403, "无权访问此资源"));
    }

    // 未知异常 - 兜底处理，不暴露内部细节
    @ExceptionHandler(Exception.class)
    public ResponseEntity<ApiResponse<Void>> handleUnknown(Exception ex) {
        log.error("未知异常", ex);
        String traceId = MDC.get("traceId");
        meterRegistry.counter("carbon.ai.exception", "type", "UNKNOWN").increment();
        return ResponseEntity.status(500)
            .body(ApiResponse.error(500, "系统内部错误，请联系管理员，追踪号：" + traceId));
    }
}
```

**边界提醒**：`@RestControllerAdvice` 只能处理 DispatcherServlet 内（Controller、参数解析、返回值序列化）抛出的异常；Filter 层的认证失败由 `AuthenticationEntryPoint` 处理、授权失败由 `AccessDeniedHandler` 处理，二者要配套，否则 Filter 抛出的异常会走容器默认错误页（或 Spring Boot 的 `/error`）。

**AI/碳管理场景关联：**
碳管家AI助手的异常处理覆盖AI调用全链路：当大模型 API响应超过30秒时，Feign抛出RetryableException，全局处理器将其包装为ModelTimeoutException返回友好提示；当用户提问触发内容安全策略时，AI服务抛出ContentViolationException告知用户修改问题；当Milvus向量库连接异常时，抛出VectorStoreException并触发降级策略（回退到关键词检索）。所有异常均通过traceId关联全链路日志，便于快速定位问题。

---

#### 追问：
- 追问1：你用@ExceptionHandler(Exception.class)兜底返回traceId，但大模型调用偶尔会返回超长堆栈（如Milvus序列化异常），直接把堆栈塞进日志会不会有敏感信息（如API Key、SQL）泄露到traceId关联的日志里？
  - **答**：会。异常堆栈可能含 SQL（含参数/数据），若 prompt 拼接进异常还可能带用户碳数据；配置类可能打印敏感信息。
    - 防护：
      - ① 日志脱敏（正则过滤 key/password/SQL 参数）
      - ② 只记 ex.getMessage() 而非全堆栈到业务日志，全堆栈仅落受控 debug 日志
      - ③ MDC 关联 traceId，敏感字段不输出
      - ④ 日志框架加脱敏转换器
- 追问2：当AI服务降级（如Milvus不可用回退关键词检索）时，你抛出VectorStoreException，全局处理器返回500，但前端更希望的是"部分能力降级可用"而非整体报错，这种语义该在异常体系里怎么区分设计？
  - **答**：应区分异常语义。设计分级异常：VectorStoreException（基础设施不可用）→可降级为"关键词检索"的 DegradedResponse（HTTP 200 + degraded=true），而非 500。
    - 做法：自定义 CarbonDegradedException，全局处理器返回 200 带降级标记与提示；或用 ResponseEntity 在业务层直接回退；前端据 degraded 标记展示"部分能力受限"，提升可用性。
- 追问3：ModelTimeoutException返回504，但HTTP 504在网关层（如Nginx/K8s Ingress）通常会触发重试，若重试又打到另一个AI实例再次超时，会不会造成Token被重复计费？怎么在异常设计上防止重试放大成本？
  - **答**：会放大成本。网关对 504 重试会再打一个新请求，可能再次调用 LLM 计费，且首次推理可能仍在跑。
    - 防护：
      - ① LLM 调用层做幂等，每次请求带 client 生成的 requestId，服务端去重，重复请求返回首次结果不重复计费
      - ② 网关层对 AI 接口禁用自动重试或仅对安全操作重试
      - ③ 超时设合理上限 + 幂等令牌
      - ④ 用缓存按 requestId 复用结果

### 16. Spring MVC参数解析与数据绑定机制
**重要度**：★★★

**题目：**
请说明Spring MVC中HandlerMethodArgumentResolver的工作原理，列举内置的参数解析器，并实现一个自定义参数解析器用于自动注入当前登录的碳管理用户信息。

**解答：**
HandlerMethodArgumentResolver是Spring MVC参数解析的核心接口，负责将HTTP请求中的数据转换为Controller方法的参数对象。该接口定义两个方法：supportsParameter判断是否支持该参数类型的解析，resolveArgument执行实际的解析逻辑。

Spring MVC内置了约30种参数解析器，按优先级链式调用，常见的包括：@RequestParam（解析查询参数）、@PathVariable（解析路径变量）、@RequestBody（通过HttpMessageConverter反序列化请求体）、@RequestHeader（解析请求头）、@CookieValue（解析Cookie）、@ModelAttribute（数据绑定和校验）、@Valid/@Validated（触发参数校验）、HttpServletRequest/HttpServletResponse（注入原生Servlet对象）、Principal（注入认证主体）、@SessionAttribute（从Session获取属性）、@RequestPart（处理multipart文件上传）等。

RequestMappingHandlerAdapter在初始化时将所有参数解析器组合为HandlerMethodArgumentResolverComposite，按顺序尝试解析，第一个supports返回true的解析器负责实际解析。

```java
// 自定义注解标记需要注入当前用户的参数
@Target(ElementType.PARAMETER)
@Retention(RetentionPolicy.RUNTIME)
public @interface CurrentUser {
}

// 自定义参数解析器
public class CurrentUserArgumentResolver implements HandlerMethodArgumentResolver {

    @Autowired
    private JwtTokenService jwtTokenService;

    @Override
    public boolean supportsParameter(MethodParameter parameter) {
        return parameter.hasParameterAnnotation(CurrentUser.class)
            && CarbonUser.class.isAssignableFrom(parameter.getParameterType());
    }

    @Override
    public Object resolveArgument(MethodParameter parameter, ModelAndViewContainer mavContainer,
            NativeWebRequest webRequest, WebDataBinderFactory binderFactory) throws Exception {
        HttpServletRequest request = webRequest.getNativeRequest(HttpServletRequest.class);
        String token = request.getHeader("Authorization");
        if (token == null || !token.startsWith("Bearer ")) {
            throw new UnauthorizedException("未提供认证Token");
        }
        // 解析JWT并构建CarbonUser对象，无需在Controller中手动解析
        return jwtTokenService.parseToken(token.substring(7));
    }
}

// 注册自定义解析器
@Configuration
public class WebMvcConfig implements WebMvcConfigurer {
    @Autowired
    private CurrentUserArgumentResolver currentUserArgumentResolver;

    @Override
    public void addArgumentResolvers(List<HandlerMethodArgumentResolver> resolvers) {
        resolvers.add(0, currentUserArgumentResolver); // 最高优先级
    }
}

// Controller使用：直接注入CarbonUser，无需手动解析Token
@RestController
@RequestMapping("/api/carbon-ai")
public class AiController {

    @PostMapping("/chat")
    public ApiResponse<ChatResponse> chat(@CurrentUser CarbonUser user,
                                           @Valid @RequestBody ChatRequest request) {
        // user已自动注入，包含tenantId, userId, role等信息
        ChatResponse response = carbonChatService.chat(user, request);
        return ApiResponse.success(response);
    }
}
```

**AI/碳管理场景关联：**
通过@CurrentUser注解和自定义参数解析器，碳管家AI助手的所有Controller方法无需手动从Request中提取和解析JWT Token，直接通过参数注入获取当前登录的CarbonUser对象（包含租户ID、用户ID、角色等）。这大大简化了Controller代码，同时确保了用户信息的一致性来源。在chat接口中，CarbonUser的tenantId被自动用于RAG检索时的数据范围过滤，userId用于对话记录归属，role用于AI功能权限判断。

---

#### 追问：
- 追问1：你的@CurrentUser解析器在resolveArgument里直接解析JWT，如果请求里根本没有Authorization头，这里抛UnauthorizedException，它会被12.15的全局异常处理器捕获吗？还是会卡在参数解析阶段以不同状态码返回？
  - **答**：会。参数解析器在 HandlerAdapter 调 Controller 前执行，抛出的 UnauthorizedException 沿调用栈上抛，由 DispatcherServlet 异常解析链交给 @ExceptionHandler 处理，最终返回 401（取决于处理器映射）。
    - 若参数解析阶段某些异常未被 @ExceptionHandler 覆盖，Spring 可能返回 500，需确保异常类型被处理器显式捕获并映射正确状态码。
- 追问2：@Valid @RequestBody做参数校验，若用户提问的ChatRequest里携带了一段极长的恶意文本（比如10MB），在HttpMessageConverter反序列化和@Valid校验之间，应用会先因为请求体过大OOM还是先被校验拒绝？边界在哪？
  - **答**：都不会——`application/json` 的请求体**不受** `server.tomcat.max-http-form-post-size`（maxPostSize）约束，该参数只对 `application/x-www-form-urlencoded` 和 `multipart/form-data` 生效；10MB JSON 会被正常读进内存由 Jackson 反序列化，`@Valid` 也是在反序列化之后才执行，拦不住体积。
    - 真正能限 JSON 的手段：① 网关层（Nginx `client_max_body_size`、APISIX/SCG 的 max-body）；② 自建 Filter 在进入 Controller 前校验 `Content-Length` 并直接返回 413（流式读取时用 `ContentCachingRequestWrapper` 统计字节数）；③ `server.tomcat.max-swallow-size` 控制被拒绝请求最多吞掉多少字节再断开，需与前两者配合；④ 只有 WebFlux 才有 `spring.codec.max-in-memory-size`。
    - 结论：单靠 Tomcat 的 form 类参数不能给 JSON 兜底，必须在网关或自建 Filter 里做，且要在反序列化之前。

#### 五、Spring Security

### 17. Spring Security认证授权核心流程详解
**重要度**：★★★★

**题目：**
请详细说明Spring Security的认证（Authentication）和授权（Authorization）完整流程，包括核心组件（SecurityFilterChain、AuthenticationManager、UserDetailsService、AccessDecisionManager等）的协作关系。

**解答：**
Spring Security的核心架构基于Servlet Filter链，通过DelegatingFilterProxy将Spring管理的Filter注册到Servlet容器中。Spring Boot 3.x（Spring Security 6.x）移除了WebSecurityConfigurerAdapter，改用SecurityFilterChain Bean进行声明式配置。

**认证流程：**
1. 请求进入SecurityFilterChain，经过一系列Filter（Spring Security 6.x：SecurityContextHolderFilter、UsernamePasswordAuthenticationFilter、ExceptionTranslationFilter、AuthorizationFilter等）。
   - 版本差异：5.x 对应的是 SecurityContextPersistenceFilter（6.0 起被 SecurityContextHolderFilter 取代，且默认不再自动保存上下文）与 FilterSecurityInterceptor（6.x 被 AuthorizationFilter 取代）。
2. 认证Filter（如JwtAuthenticationFilter）从请求中提取凭证（JWT Token），构建未认证的Authentication对象（如UsernamePasswordAuthenticationToken）。
3. 调用AuthenticationManager.authenticate()方法，默认实现ProviderManager遍历所有AuthenticationProvider。
4. AuthenticationProvider（如DaoAuthenticationProvider）调用UserDetailsService.loadUserByUsername()加载用户信息，PasswordEncoder验证密码。
5. 认证成功后，创建已认证的Authentication对象（包含权限列表），存入SecurityContext，由SecurityContextHolder（基于ThreadLocal）管理。
6. 认证失败抛出AuthenticationException，由AuthenticationEntryPoint处理（返回401）。

**授权流程：**
1. 请求通过认证后到达授权Filter（AuthorizationFilter，Spring Security 6.x替代了FilterSecurityInterceptor）。
2. 根据SecurityConfig中配置的授权规则（如requestMatchers("/api/admin/**").hasRole("ADMIN")）进行匹配。
3. 如果规则匹配，调用AuthorizationManager.check()方法，检查当前Authentication的authorities是否包含所需权限。
4. 授权通过则放行请求到Controller；授权失败抛出AccessDeniedException，由AccessDeniedHandler处理（返回403）。

**方法级授权：** 通过@PreAuthorize、@PostAuthorize、@Secured注解实现，由MethodSecurityInterceptor（Spring Security 5.x）或AOP + AuthorizationManagerBeforeMethodInterceptor（6.x）拦截。@PreAuthorize在方法执行前检查，支持SpEL表达式如@PreAuthorize("hasRole('ADMIN') and @quotaService.checkQuota(#tenantId)")。

```java
@Configuration
@EnableWebSecurity
@EnableMethodSecurity
public class SecurityConfig {

    @Bean
    public SecurityFilterChain filterChain(HttpSecurity http,
            JwtAuthenticationFilter jwtFilter) throws Exception {
        return http
            .csrf(csrf -> csrf.disable())
            .sessionManagement(session ->
                session.sessionCreationPolicy(SessionCreationPolicy.STATELESS))
            .authorizeHttpRequests(auth -> auth
                .requestMatchers("/api/auth/login", "/api/auth/refresh").permitAll()
                .requestMatchers("/actuator/health").permitAll()
                .requestMatchers("/api/carbon-ai/**").authenticated()
                .requestMatchers("/api/admin/**").hasRole("ADMIN")
                .anyRequest().authenticated())
            .addFilterBefore(jwtFilter, UsernamePasswordAuthenticationFilter.class)
            .exceptionHandling(ex -> ex
                .authenticationEntryPoint(new JwtAuthEntryPoint())
                .accessDeniedHandler(new CustomAccessDeniedHandler()))
            .build();
    }

    @Bean
    public PasswordEncoder passwordEncoder() {
        return new BCryptPasswordEncoder();
    }
}
```

**AI/碳管理场景关联：**
碳管家AI助手采用无状态JWT认证：用户登录后获取JWT Token，后续请求在Authorization头中携带Token。JwtAuthenticationFilter解析Token并设置SecurityContext，AuthorizationFilter根据URL规则进行粗粒度授权（如/api/admin/**需要ADMIN角色），@PreAuthorize注解在方法级进行细粒度授权（如carbon:ai:chat权限）。当普通用户尝试调用碳报告审批接口时，授权检查失败返回403，AI服务记录审计日志。

---

#### 追问：
- 追问1：你用SecurityFilterChain + @PreAuthorize做方法级授权，但碳管家AI助手的"租户数据隔离"靠的是TenantContext而不是Spring Security的authorities，如果一个ADMIN角色用户算改了URL里的orgId参数，@PreAuthorize能拦住跨租户访问吗？
  - **答**：拦不住。@PreAuthorize 基于 authorities/角色，不感知 URL 里的 orgId 参数；ADMIN 改 orgId 仍被放行，靠 TenantContext/数据权限才真正隔离。
    - 正确：数据隔离不能只靠角色，必须由数据权限切面按"当前用户所属租户"强制过滤，忽略（或校验）请求传入的 orgId；@PreAuthorize 只做功能权限，数据权限在查询条件层强制注入。
- 追问2：Spring Security 6的AuthorizationFilter在FilterSecurityInterceptor位置，但你的AI接口鉴权逻辑有一部分放在了自定义HandlerInterceptor里，这两层授权职责重叠会产生"一处放行另一处拦截"的混乱吗？怎么划分边界？
  - **答**：会混乱。AuthorizationFilter 在 Filter 层、Interceptor 在 DispatcherServlet 内，职责重叠易"一处放一处拦"。
    - 划分边界：
      - ① Spring Security 的 AuthorizationFilter 负责认证与功能级（角色/scope）授权
      - ② HandlerInterceptor 负责租户上下文设置、配额/限流等业务级前置检查
      - ③ 数据范围隔离放到数据访问层（MyBatis 拦截器）统一强制

### 18. JWT集成方案与Token刷新机制
**重要度**：★★★★

**题目：**
请设计一个完整的JWT认证方案，包括Token生成与解析、双Token机制（Access Token + Refresh Token）、Token续期策略、黑名单机制，并说明在碳管理SaaS多租户场景下的特殊处理。

**解答：**
JWT（JSON Web Token）由Header（算法类型）、Payload（声明信息）和Signature（签名）三部分组成。在Spring Security中集成JWT需要自定义JwtAuthenticationFilter拦截请求、JwtTokenService管理Token生命周期。

**双Token机制设计：**
- Access Token：有效期短（如30分钟），用于API认证。Payload中包含userId、tenantId、username、role、permissions等信息。
- Refresh Token：有效期长（如7天），仅用于获取新的Access Token。存储在Redis中，绑定用户ID和设备信息，支持主动撤销。

**Token刷新流程：**
1. 客户端请求携带Access Token，如果过期返回401并附带refresh_token提示。
2. 客户端使用Refresh Token调用/api/auth/refresh接口。
3. 服务端验证Refresh Token有效性（签名验证+Redis存在性校验），生成新的Access Token和Refresh Token（旋转机制，旧的Refresh Token失效）。
4. 返回新Token对，客户端更新本地存储。

**黑名单机制：** 当用户修改密码、注销登录或管理员强制踢出时，将对应的Access Token的JTI（JWT ID）加入Redis黑名单，设置过期时间为Token剩余有效期。JwtAuthenticationFilter在验证Token时检查黑名单。

注意：黑名单命中要抛**独立的 `TokenRevokedException`**（自定义 AuthenticationException 子类），不能借 `ExpiredJwtException`——否则 Filter 里的 catch 会把"已撤销"当成"已过期"，走 refresh 换新 token 的分支，撤销就形同虚设。校验时机也要在签名解析成功之后单独判断，不要和过期判断混在一段逻辑里。

```java
@Service
public class JwtTokenService {

    @Value("${jwt.secret}")
    private String secret;
    @Value("${jwt.access-token-expiration:1800000}") // 30分钟
    private long accessTokenExpiration;
    @Value("${jwt.refresh-token-expiration:604800000}") // 7天
    private long refreshTokenExpiration;

    @Autowired
    private StringRedisTemplate redisTemplate;

    public TokenPair generateTokenPair(CarbonUser user) {
        String accessToken = buildAccessToken(user);
        String refreshToken = buildRefreshToken(user);
        // Refresh Token存入Redis，key为userId+deviceId
        String refreshKey = "jwt:refresh:" + user.getId() + ":" + user.getDeviceId();
        redisTemplate.opsForValue().set(refreshKey, refreshToken,
            refreshTokenExpiration, TimeUnit.MILLISECONDS);
        return new TokenPair(accessToken, refreshToken);
    }

    private String buildAccessToken(CarbonUser user) {
        return Jwts.builder()
            .subject(user.getId().toString())
            .claim("tenantId", user.getTenantId())
            .claim("username", user.getUsername())
            .claim("role", user.getRole())
            .claim("permissions", user.getPermissions())
            .claim("deviceId", user.getDeviceId())
            .issuedAt(new Date())
            .expiration(new Date(System.currentTimeMillis() + accessTokenExpiration))
            .signWith(Keys.hmacShaKeyFor(secret.getBytes()))
            .compact();
    }

    public CarbonUser parseToken(String token) {
        Jws<Claims> jws = Jwts.parser()
            .verifyWith(Keys.hmacShaKeyFor(secret.getBytes()))
            .build()
            .parseSignedClaims(token);
        Claims claims = jws.getPayload();

        // 检查黑名单（在签名解析成功之后单独判断，用独立异常类型，避免被当成"过期"触发 refresh）
        String jti = claims.getId();
        if (Boolean.TRUE.equals(redisTemplate.hasKey("jwt:blacklist:" + jti))) {
            throw new TokenRevokedException("Token已被撤销，请重新登录");
        }

        return CarbonUser.builder()
            .id(Long.parseLong(claims.getSubject()))
            .tenantId(claims.get("tenantId", Long.class))
            .username(claims.get("username", String.class))
            .role(claims.get("role", String.class))
            .permissions((Set<String>) claims.get("permissions"))
            .build();
    }

    public void revokeToken(String token) {
        Claims claims = Jwts.parser()
            .verifyWith(Keys.hmacShaKeyFor(secret.getBytes()))
            .build()
            .parseSignedClaims(token).getPayload();
        long remainingTime = claims.getExpiration().getTime() - System.currentTimeMillis();
        if (remainingTime > 0) {
            redisTemplate.opsForValue().set("jwt:blacklist:" + claims.getId(),
                "revoked", remainingTime, TimeUnit.MILLISECONDS);
        }
    }

    public TokenPair refreshToken(String refreshToken) {
        // 验证Refresh Token签名
        CarbonUser user = parseToken(refreshToken);
        // 验证Redis中是否存在（防止已撤销的Refresh Token被复用）
        String refreshKey = "jwt:refresh:" + user.getId() + ":" + user.getDeviceId();
        String storedToken = redisTemplate.opsForValue().get(refreshKey);
        if (!refreshToken.equals(storedToken)) {
            redisTemplate.delete(refreshKey); // 删除该设备的 refresh token（其他设备会话不受影响）
            throw new InvalidTokenException("Refresh Token无效，请重新登录");
        }
        // 旋转：删除旧Refresh Token，生成新的Token对
        redisTemplate.delete(refreshKey);
        return generateTokenPair(user);
    }
}
```

**AI/碳管理场景关联：**
在碳管家AI助手中，JWT的tenantId声明用于多租户数据隔离。当企业A的用户登录后，所有AI问答请求的JWT中都携带tenantId=A的声明，JwtAuthenticationFilter解析后注入TenantContext，RAG检索时自动只查询企业A的碳排放知识库。当企业管理员在后台修改了某用户的AI使用权限后，调用revokeToken撤销该用户当前的Access Token，强制其重新登录获取新Token和新权限。对于碳管家AI助手的长时间对话场景（如持续10分钟以上的碳排放分析对话），客户端在Access Token过期前自动使用Refresh Token续期，确保对话不中断。

---

#### 追问：
- 追问1：Refresh Token旋转机制里，如果用户在两个设备同时用旧Refresh Token刷新，第一个刷新成功后旧Token被删除，第二个会失败强制重新登录，这种"互相踢下线"在碳管家AI助手的长时间对话场景里会不会误伤正常用户？
  - **答**：会误伤。旋转删旧 token，第二设备用旧 token 刷新失败被强制登出，正常用户"被踢"。
    - 缓解：
      - ① 允许多设备：旋转时不立即删旧 token，给旧 token 短宽限期（同时有效 N 分钟）再失效
      - ② 或按设备维度管理 refresh token，旋转只废该设备旧 token
      - ③ 用 token family 标识同用户多会话，仅检测到盗用才强制全部失效
- 追问2：你用Redis存Refresh Token和黑名单，如果Redis宕机，所有Token刷新和黑名单校验都会失败，此时AI服务是全面拒绝登录还是降级放行？这个单点依赖在架构上怎么化解？
  - **答**：取决于设计。Refresh Token/黑名单强依赖 Redis，Redis 宕机会让刷新与注销校验失败——fail-fast 则全部拒绝登录（可用性差），降级放行则有安全风险。
    - 化解：
      - ① Refresh Token 也持久化 DB 做主存，Redis 不可用时降级查 DB
      - ② 黑名单用短 TTL，Redis 挂时临时接受旧 token 但缩短有效期
      - ③ Redis 用哨兵/集群高可用
      - ④ 关键鉴权避免强单点
- 追问3：Access Token的tenantId声明在JWT payload里，当用户被管理员调整了所属租户，旧的Access Token在过期前仍带着旧tenantId，RAG检索时仍会查旧租户数据，这种"权限变更延迟生效"在合规上可接受吗，如何缩短？
  - **答**：有合规风险但常见可接受，需缩短生效延迟。旧 Access Token 过期前带旧 tenantId，RAG 仍查旧租户。
    - 缩短手段：
      - ① 租户变更时把该用户旧 token 加黑名单强制失效，重登
      - ② 缩短 Access Token 有效期（如 15 分钟）让旧 token 快速自然过期
      - ③ 用 token/租户版本号声明，校验比对最新版本不一致即拒
      - ④ 重要场景用后端会话状态而非纯无状态 JWT

### 19. OAuth2授权码模式与Spring Authorization Server集成
**重要度**：★★★

**题目：**
请说明OAuth2四种授权模式的适用场景，详细描述授权码模式（Authorization Code）的流程，并说明如何使用Spring Authorization Server搭建碳管理平台的统一认证中心。

**解答：**
OAuth2定义了四种授权模式，但 **OAuth 2.1 草案已删除简化模式（Implicit）与密码模式（ROPC）**，实际可用只剩两种：授权码模式（Authorization Code + PKCE，最安全，适用于有后端的 Web 应用与 SPA/移动端等公共客户端）、客户端凭证模式（Client Credentials，适用于服务间通信、无用户参与）。Implicit 的问题是把 access token 直接暴露在前端 URL 里；ROPC 则让第三方应用接触用户密码，二者在 2.1 中均被移除，SPA/移动端统一走"授权码 + PKCE"。

**授权码模式流程：**
1. 用户访问客户端应用，客户端重定向到授权服务器的授权端点（/oauth2/authorize），携带client_id、redirect_uri、response_type=code、scope、state参数。
2. 授权服务器展示登录和授权确认页面，用户登录并同意授权。
3. 授权服务器重定向到客户端的redirect_uri，携带授权码code和state参数。
4. 客户端后端使用授权码code、client_id、client_secret向授权服务器的Token端点（/oauth2/token）交换Access Token。
5. 授权服务器验证code和client凭证，返回Access Token（可选Refresh Token）。
6. 客户端使用Access Token访问受保护的资源服务器API。

授权码模式的安全性在于：客户端密钥（client_secret）仅在后端使用，不暴露给前端；授权码是一次性的且有时效性（通常10分钟）；state参数防止CSRF攻击。

Spring Authorization Server（Spring Boot 3.x版本）是Spring官方的OAuth2授权服务器实现：

```java
@Configuration
public class AuthServerConfig {

    @Bean
    @Order(1)
    public SecurityFilterChain authServerFilterChain(HttpSecurity http) throws Exception {
        OAuth2AuthorizationServerConfiguration.applyDefaultSecurity(http);
        http.getConfigurer(OAuth2AuthorizationServerConfigurer.class)
            .oidc(Customizer.withDefaults()); // 启用OIDC
        http.exceptionHandling(ex ->
            ex.defaultAuthenticationEntryPointFor(
                new LoginUrlAuthenticationEntryPoint("/login"),
                new MediaTypeRequestMatcher(MediaType.TEXT_HTML)))
            .oauth2ResourceServer(rs -> rs.jwt(Customizer.withDefaults()));
        return http.build();
    }

    @Bean
    public RegisteredClientRepository registeredClientRepository(PasswordEncoder encoder) {
        RegisteredClient carbonAiClient = RegisteredClient.withId(UUID.randomUUID().toString())
            .clientId("carbon-ai-client")
            .clientSecret(encoder.encode("carbon-secret"))
            .clientAuthenticationMethod(ClientAuthenticationMethod.CLIENT_SECRET_BASIC)
            .authorizationGrantType(AuthorizationGrantType.AUTHORIZATION_CODE)
            .authorizationGrantType(AuthorizationGrantType.REFRESH_TOKEN)
            .authorizationGrantType(AuthorizationGrantType.CLIENT_CREDENTIALS)
            .redirectUri("https://carbon.example.com/callback")
            .scope(OidcScopes.OPENID)
            .scope("carbon:ai:chat")
            .scope("carbon:report:read")
            .scope("carbon:report:write")
            .clientSettings(ClientSettings.builder().requireAuthorizationConsent(true).build())
            .tokenSettings(TokenSettings.builder()
                .accessTokenTimeToLive(Duration.ofMinutes(30))
                .refreshTokenTimeToLive(Duration.ofDays(7))
                .reuseRefreshTokens(false)
                .build())
            .build();
        return new InMemoryRegisteredClientRepository(carbonAiClient);
    }

    @Bean
    public JWKSource<SecurityContext> jwkSource() {
        RSAKey rsaKey = generateRsaKey();
        JWKSet jwkSet = new JWKSet(rsaKey);
        return (selector, ctx) -> selector.select(jwkSet);
    }

    @Bean
    public JwtDecoder jwtDecoder(JWKSource<SecurityContext> jwkSource) {
        return OAuth2AuthorizationServerConfiguration.jwtDecoder(jwkSource);
    }
}
```

**AI/碳管理场景关联：**
积木LCA云平台作为SaaS平台，需要支持第三方碳咨询机构通过API接入碳管家AI助手。通过OAuth2授权码模式，咨询机构的应用可以引导用户跳转到积木LCA的认证中心登录，用户授权后获得具有carbon:ai:chat scope的Access Token，即可调用AI问答API。服务间通信（如碳管家AI服务调用碳排放计算服务）使用Client Credentials模式，无需用户参与。这种设计实现了第三方应用的安全接入和细粒度权限控制。

---

#### 追问：
- 追问1：第三方碳咨询机构通过授权码模式拿到carbon:ai:chat的scope调用AI问答，但AI问答返回的内容可能涉及A企业私有碳排放数据，OAuth2的scope能约束到"只能问本机构数据"吗？scope和你的租户数据隔离是怎么配合的？
  - **答**：scope 只能限定"能调哪些接口/哪类能力"，无法约束到"只能问本机构数据"。数据隔离由租户体系负责。
    - 第三方机构拿到 carbon:ai:chat scope 后，其 token 仍绑定自身 tenantId，RAG 与查询按该 tenantId 过滤，scope 与租户隔离正交：scope 管"能不能用"，tenantId 管"能用谁的数据"。需确保第三方接入也走租户过滤。
- 追问2：Spring Authorization Server用RSA做JWT签名，如果用于签名的私钥泄露或需要轮转，已发出的Access Token会集体失效吗？在碳管家AI助手的线上环境怎么做无感密钥轮转？
  - **答**：会集体失效（若只认新公钥）。无感轮转：
    - ① JWT 头带 kid/jku 标识密钥 ID，资源服务器维护"旧+新"多公钥集合，旧 token 用旧公钥、新 token 用新公钥，过渡期都有效
    - ② 轮转先发新 key 保留旧 key 一段时间，待旧 token 自然过期再下线
    - ③ 用 JWKS 端点动态发布公钥，验证方自动获取，实现无缝轮转

### 20. RBAC权限模型设计与API安全实践
**重要度**：★★★★

**题目：**
请设计碳管理平台的RBAC（Role-Based Access Control）权限模型，包括数据库表设计、权限注解体系、数据权限过滤，并说明API安全防护的最佳实践。

**解答：**
RBAC权限模型通过"用户-角色-权限"三层结构实现权限管理。在SaaS碳管理平台中扩展为"租户-用户-角色-权限"四层，加入租户隔离维度。

**数据库表设计：**
- sys_tenant（租户表）：id, tenant_name, tenant_code, status, ai_quota
- sys_user（用户表）：id, tenant_id, username, password, email, phone, status
- sys_role（角色表）：id, tenant_id, role_name, role_code, data_scope
- sys_menu（菜单/权限表）：id, parent_id, menu_name, permission, menu_type(M目录/菜单/按钮)
- sys_user_role（用户角色关联）：user_id, role_id
- sys_role_menu（角色权限关联）：role_id, menu_id
- sys_org（组织表）：id, tenant_id, parent_id, org_name（用于数据范围控制）

**权限注解体系：**

```java
// ① 功能权限：直接在方法上写 SpEL，权限标识显式可见，便于审计与检索
@PreAuthorize("@carbonPermissionChecker.hasPermission(authentication, 'carbon:report:list')")
@GetMapping("/api/carbon/report/list")
public List<CarbonReportVO> list() { ... }

// ② 数据范围：用独立注解 + AOP，不要硬塞进 @PreAuthorize（SpEL 里取不到注解属性）
@Target(ElementType.METHOD)
@Retention(RetentionPolicy.RUNTIME)
public @interface DataScopeFilter {
    DataScope value() default DataScope.SELF_ORG;   // DataScope 是 dto 包下的枚举
}

@Aspect
@Component
public class DataScopeAspect {

    @Around("@annotation(filter)")
    public Object around(ProceedingJoinPoint pjp, DataScopeFilter filter) throws Throwable {
        DataScopeContext ctx = new DataScopeContext();
        ctx.setUserId(SecurityUtils.getUserId());
        ctx.setScope(filter.value());
        if (filter.value() == DataScope.SELF_ORG) {
            ctx.setAccessibleOrgIds(orgService.getSubOrgIds(SecurityUtils.getOrgId()));
        }
        DataScopeContextHolder.set(ctx);   // MyBatis 拦截器读它拼 WHERE org_id IN (...)
        try {
            return pjp.proceed();
        } finally {
            DataScopeContextHolder.clear();
        }
    }
}

// 自定义权限检查器：入参就是权限标识本身，不再靠占位注释
@Component("carbonPermissionChecker")
public class CarbonPermissionChecker {

    @Autowired
    private PermissionService permissionService;

    public boolean hasPermission(Authentication auth, String permission) {
        if (auth == null || !(auth.getPrincipal() instanceof CarbonUser user)) {
            return false;
        }
        // 1. 功能权限：从 JWT / Redis 缓存的权限集合里判断
        if (!permissionService.getPermissions(user.getId()).contains(permission)) {
            return false;
        }
        // 2. 数据范围权限：读 DataScopeAspect 注入的上下文
        DataScopeContext context = DataScopeContextHolder.get();
        return context == null || context.getScope() == DataScope.ALL
            || permissionService.checkDataScope(user, context);
    }
}

// API安全防护配置
@Configuration
public class ApiSecurityConfig {

    @Bean
    public SecurityFilterChain apiFilterChain(HttpSecurity http) throws Exception {
        return http
            .csrf(csrf -> csrf.disable())
            .sessionManagement(s -> s.sessionCreationPolicy(SessionCreationPolicy.STATELESS))
            .authorizeHttpRequests(auth -> auth
                .requestMatchers("/api/auth/**").permitAll()
                .requestMatchers(HttpMethod.GET, "/api/carbon/report/**").hasAnyRole("VIEWER", "ANALYST", "ADMIN")
                .requestMatchers(HttpMethod.POST, "/api/carbon/report/**").hasAnyRole("ANALYST", "ADMIN")
                .requestMatchers(HttpMethod.DELETE, "/api/carbon/report/**").hasRole("ADMIN")
                .requestMatchers("/api/carbon-ai/**").hasAuthority("carbon:ai:chat")
                .anyRequest().authenticated())
            // 速率限制：每用户每分钟最多20次AI调用
            .addFilterBefore(new RateLimitFilter(redisTemplate, 20, 60), JwtAuthenticationFilter.class)
            // XSS防护
            .addFilterBefore(new XssFilter(), JwtAuthenticationFilter.class)
            .exceptionHandling(ex -> ex
                .authenticationEntryPoint(new JwtAuthEntryPoint())
                .accessDeniedHandler(new CarbonAccessDeniedHandler()))
            .oauth2ResourceServer(rs -> rs.jwt(Customizer.withDefaults()))
            .build();
    }
}

// 速率限制过滤器
public class RateLimitFilter extends OncePerRequestFilter {

    private final StringRedisTemplate redis;
    private final int maxRequests;
    private final int windowSeconds;

    @Override
    protected void doFilterInternal(HttpServletRequest request, HttpServletResponse response,
            FilterChain chain) throws ServletException, IOException {
        String token = request.getHeader("Authorization");
        if (token != null) {
            String userId = extractUserId(token);
            String key = "rate_limit:" + userId + ":" + request.getRequestURI();
            Long count = redis.opsForValue().increment(key);
            if (count == 1) {
                redis.expire(key, windowSeconds, TimeUnit.SECONDS);
            }
            if (count > maxRequests) {
                response.setStatus(429);
                response.setHeader("Retry-After", String.valueOf(windowSeconds));
                response.setContentType("application/json;charset=UTF-8");
                response.getWriter().write("{\"code\":429,\"message\":\"请求过于频繁，请稍后重试\"}");
                return;
            }
        }
        chain.doFilter(request, response);
    }
}
```

**AI/碳管理场景关联：**
积木LCA云平台的RBAC模型设计了三种核心角色：碳管理员（ADMIN，可管理碳排放数据源、AI知识库、用户权限）、碳分析师（ANALYST，可使用AI助手进行碳排分析、生成报告）、碳查看者（VIEWER，仅可查看碳排报告和AI问答历史）。通过@RequiresPermission("carbon:ai:chat")注解确保只有获得AI权限的用户才能调用碳管家AI助手。速率限制过滤器防止恶意用户高频调用AI接口消耗Token配额。XSS过滤器防止用户在AI对话中注入恶意脚本。

---

#### 追问：
- 追问1：你的RBAC表设计里sys_role有data_scope字段，但数据范围的实际过滤又靠AOP+ThreadLocal拼SQL，如果某个新开发的报表接口忘了加@RequiresPermission注解，会出现没有任何data_scope过滤的越权查询吗？怎么从架构上兜底？
  - **答**：会。新报表接口没加 @RequiresPermission，AOP 不注入 data_scope，SQL 无 org 过滤，出现越权全量查询。
    - 架构兜底：
      - ① MyBatis 拦截器对带 org_id 主表的 mapper 默认注入租户过滤（无法关闭，除非显式豁免），不依赖手动加注解
      - ② 或租户隔离下沉到 DB（RLS 行级安全）
      - ③ CI 扫描缺失注解接口并拦截
      - ④ 默认拒绝：未声明数据范围的接口视为只查本租户
- 追问2：RateLimitFilter每用户每分钟20次，但租户是按企业买的套餐配额（月度Token上限），接口级限流和配额级限流是两套独立机制，当接口没限流但配额已耗尽时，XSS过滤和限流这些Filter还会正常放行请求直到AOP配额检查才拦截，这种"迟滞拦截"会不会浪费大模型调用前的计算资源？
  - **答**：会。Filter 只做接口级限流、不查配额，请求穿过 Filter 链到达 AOP 配额检查才被拦，前面已消耗解析/校验等资源。
    - 优化：
      - ① 把配额检查也前置到 Filter/Interceptor（早期拦截）
      - ② 或配额用 Redis 原子计数在网关层做第一道闸门
      - ③ 轻量预检：Filter 阶段用缓存快速判断租户配额是否耗尽，耗尽直接 429，避免进入 AI 调用链

#### 六、Spring 事件机制

### 21. Spring事件发布-订阅模式与ApplicationEvent体系
**重要度**：★★★★

**题目：**
请说明Spring事件机制的完整体系，包括ApplicationEvent、ApplicationEventPublisher、ApplicationListener的工作原理，以及在Spring Boot 3.x中的演进。

**解答：**
Spring事件机制基于观察者模式，实现了发布者和订阅者的解耦。核心组件包括：

**ApplicationEvent**：所有事件的基类。Spring 4.2之后，事件不再强制继承ApplicationEvent，任意Java对象都可以作为事件。在Spring Boot 3.x中，推荐使用基于POJO的事件，配合@EventListener注解。

**ApplicationEventPublisher**：事件发布接口，ApplicationContext继承了该接口。通过applicationEventPublisher.publishEvent(event)发布事件。Spring会同步调用所有匹配的监听器（除非配置为异步）。

**ApplicationListener**：事件监听接口，泛型参数指定监听的事件类型。可以通过@EventListener注解替代接口实现，支持条件过滤（condition属性使用SpEL表达式）。

**事件处理流程**：
1. 发布者调用publishEvent发布事件。
2. ApplicationEventMulticastor（默认SimpleApplicationEventMulticastor）遍历所有注册的监听器。
3. 通过EventType匹配找到对应的监听器，调用onApplicationEvent方法。
4. 默认同步执行（在发布线程中），可通过taskExecutor配置为异步。

**Spring Boot 3.x的演进**：
- 推荐使用@EventListener注解而非实现ApplicationListener接口。
- 支持泛型事件：通过ResolvableType实现泛型类型的事件匹配，如AiEvent<T>可以被不同的监听器按泛型类型分别处理。
- 支持事务事件：@TransactionalEventListener监听事务特定阶段的事件（BEFORE_COMMIT、AFTER_COMMIT、AFTER_ROLLBACK、AFTER_COMPLETION），实现事务提交后再触发事件处理。

```java
// 事件定义（POJO）
public record CarbonAiChatEvent(
    Long tenantId,
    Long userId,
    String question,
    String answer,
    int tokenUsed,
    String model,
    LocalDateTime chatTime
) {}

public record CarbonReportGeneratedEvent(
    Long tenantId,
    Long reportId,
    String reportType,
    String fileUrl,
    Long generatedBy
) {}

// 事件发布
@Service
public class CarbonChatService {

    @Autowired
    private ApplicationEventPublisher eventPublisher;

    public ChatResponse chat(CarbonUser user, ChatRequest request) {
        // ... RAG检索和大模型推理 ...
        ChatResponse response = doRagChat(user, request);

        // 发布AI对话事件（chat() 无事务上下文，靠监听器的 fallbackExecution 兜底）
        eventPublisher.publishEvent(new CarbonAiChatEvent(
            user.getTenantId(), user.getId(),
            request.getQuestion(), response.getAnswer(),
            response.getTokenUsed(), response.getModel(),
            LocalDateTime.now()
        ));

        return response;
    }
}

// 事件监听
@Component
public class CarbonAiEventListener {

    @Autowired
    private AiUsageService usageService;
    @Autowired
    private NotificationService notificationService;
    @Autowired
    private MeterRegistry meterRegistry;

    // 事务提交后异步记录Token用量。
    // 关键：chat() 本身没有 @Transactional，而 @TransactionalEventListener 默认 fallbackExecution=false，
    // 没有事务时监听器会被直接丢弃、且不报错 —— 必须显式打开 fallbackExecution
    @Async
    @TransactionalEventListener(phase = TransactionPhase.AFTER_COMMIT, fallbackExecution = true)
    public void handleChatEvent(CarbonAiChatEvent event) {
        usageService.recordUsage(event.tenantId(), event.userId(),
            event.tokenUsed(), event.model());
        meterRegistry.counter("carbon.ai.chat.events",
            "tenant", event.tenantId().toString()).increment();
    }

    // 条件监听：仅当Token超过1000时触发告警
    @EventListener(condition = "#event.tokenUsed > 1000")
    public void handleHighTokenUsage(CarbonAiChatEvent event) {
        log.warn("租户{}单次AI调用Token超过1000: {} tokens",
            event.tenantId(), event.tokenUsed());
        notificationService.notifyAdmin(
            "AI Token用量告警",
            String.format("租户%d单次调用消耗%d Token", event.tenantId(), event.tokenUsed()));
    }
}
```

**最容易被忽略的一个坑**：`@TransactionalEventListener` 默认 `fallbackExecution = false`——发布事件时如果当前线程没有事务，监听器**既不执行也不报错**，Token 用量、审计日志就这么静默丢失。两种修法：给发布方 `chat()` 加 `@Transactional`（但 LLM 调用耗时数秒，不该包在事务里），或给监听器设 `fallbackExecution = true`（本示例取后者）。

**AI/碳管理场景关联：**
碳管家AI助手通过事件机制解耦AI对话与后续处理。当用户完成一次碳法规问答后，CarbonChatService发布CarbonAiChatEvent，多个监听器独立处理：Token用量记录器更新租户配额、监控指标上报器更新Prometheus指标、高用量告警器检查是否超阈值、对话历史保存器异步写入对话记录。这种设计使AI对话主流程的响应时间不受后置处理影响，同时新增后置处理（如未来需要增加AI对话质量评分）只需新增监听器，无需修改ChatService代码。

---

#### 追问：
- 追问1：你的CarbonAiChatEvent监听器里有@Async异步记录用量、也有同步的condition监听告警，如果事件发布后主流程立即返回响应、而异步监听器在3秒后才写库，用户此时查"我的本月Token用量"会不会读到旧数据？
  - **答**：会。@Async 用量记录延迟落库，用户立即查"本月用量"可能读到旧值。
    - 缓解：
      - ① 配额计数放 Redis 实时更新（立即可见），DB 落库异步仅做明细与对账
      - ② 查询用量优先读 Redis 聚合值，DB 作明细源
      - ③ 前端提示"用量统计有分钟级延迟"
      - ④ 关键计费以 Redis 计数 + 异步持久化，保证实时与最终一致
- 追问2：Spring默认事件同步执行，如果某个监听器（如高用量告警通知管理员）抛了未捕获异常，会影响其他监听器执行和chat主流程返回吗？@TransactionalEventListener在事务回滚时又会不会把事件吞掉？
  - **答**：同步监听器抛未捕获异常会沿发布链上抛，可能影响后续监听器与主流程（若在主事务内发布且未捕获）。
    - 缓解：
      - ① 监听器内部 try-catch 吞掉非关键异常仅告警
      - ② 用 @Async 解耦，异常不回主流程
      - ③ @TransactionalEventListener 默认事务回滚不发布，若需回滚后也发补偿事件用 phase=AFTER_ROLLBACK；多监听器用 @Order 控制顺序

### 22. 异步事件处理与@EventListener事务绑定
**重要度**：★★★★

**题目：**
请说明@Async与@EventListener/@TransactionalEventListener的组合使用方式，分析异步事件中的事务上下文丢失问题，并给出碳管理AI项目中的解决方案。

**解答：**
@Async和@EventListener的组合使事件监听器在独立线程中异步执行，不阻塞发布者线程。@TransactionalEventListener则将事件处理绑定到事务的生命周期，只有当事务到达指定阶段时才触发监听器。

**组合使用的问题：**
1. **事务上下文丢失**：@Async标注的方法在新线程中执行，ThreadLocal中的事务上下文和SecurityContext不会自动传递。如果异步监听器中需要访问数据库，会创建新的事务而非加入原事务。
2. **SecurityContext丢失**：Spring Security的SecurityContextHolder基于ThreadLocal，异步线程中无法获取当前用户信息。
3. **MDC（日志上下文）丢失**：traceId等日志上下文不会传递到异步线程。
4. **事件顺序不可保证**：多个异步监听器的执行顺序不确定。

**解决方案：**

```java
// 1. 配置异步任务装饰器传递上下文
@Configuration
@EnableAsync
public class AsyncConfig implements AsyncConfigurer {

    @Bean
    public TaskExecutor taskExecutor() {
        ThreadPoolTaskExecutor executor = new ThreadPoolTaskExecutor();
        executor.setCorePoolSize(10);
        executor.setMaxPoolSize(50);
        executor.setQueueCapacity(200);
        executor.setThreadNamePrefix("carbon-ai-async-");
        // 设置装饰器传递上下文
        executor.setTaskDecorator(new ContextCopyingTaskDecorator());
        executor.initialize();
        return executor;
    }
}

// 2. 上下文传递装饰器
public class ContextCopyingTaskDecorator implements TaskDecorator {
    @Override
    public Runnable decorate(Runnable runnable) {
        // 在发布线程捕获上下文
        SecurityContext securityContext = SecurityContextHolder.getContext();
        Map<String, String> mdcContext = MDC.getCopyOfContextMap();
        TenantContext tenantContext = TenantContext.get();

        return () -> {
            try {
                // 在异步线程中恢复上下文
                if (securityContext != null) {
                    SecurityContextHolder.setContext(securityContext);
                }
                if (mdcContext != null) {
                    MDC.setContextMap(mdcContext);
                }
                if (tenantContext != null) {
                    TenantContext.set(tenantContext);
                }
                runnable.run();
            } finally {
                // 清理ThreadLocal防止线程池泄漏
                SecurityContextHolder.clearContext();
                MDC.clear();
                TenantContext.clear();
            }
        };
    }
}

// 3. 事件中携带必要的上下文数据，避免依赖ThreadLocal
public record CarbonReportGeneratedEvent(
    Long tenantId,
    Long userId,
    Long reportId,
    String reportType,
    String fileUrl,
    String traceId  // 显式传递traceId
) {}

// 4. 异步事务事件监听器
@Component
@Slf4j
public class CarbonReportEventListener {

    @Autowired
    private ReportNotificationService notificationService;
    @Autowired
    private AiTrainingDataService trainingDataService;
    @Autowired
    private TenantQuotaService quotaService;

    // 事务提交后异步执行：发送报告生成通知
    @Async("taskExecutor")
    @TransactionalEventListener(phase = TransactionPhase.AFTER_COMMIT)
    public void onReportGenerated(CarbonReportGeneratedEvent event) {
        MDC.put("traceId", event.traceId());
        try {
            log.info("开始处理报告生成事件: reportId={}", event.reportId());

            // 发送通知（新事务，不依赖原事务）
            notificationService.notifyReportReady(event.tenantId(), event.userId(),
                event.reportId(), event.fileUrl());

            // 将AI生成的报告加入训练数据集，用于后续模型微调
            trainingDataService.addReportToTrainingSet(event.tenantId(), event.reportId());

            // 归还AI生成报告消耗的额外配额
            quotaService.deductReportQuota(event.tenantId());
        } catch (Exception e) {
            log.error("报告事件处理失败: reportId={}", event.reportId(), e);
            // 异步事件失败不影响主流程，但需记录告警
            throw e;
        } finally {
            MDC.clear();
        }
    }

    // 事务回滚后执行：清理临时文件
    @Async("taskExecutor")
    @TransactionalEventListener(phase = TransactionPhase.AFTER_ROLLBACK)
    public void onReportGenerationFailed(CarbonReportGeneratedEvent event) {
        log.warn("报告生成事务回滚，清理临时文件: reportId={}", event.reportId());
        fileStorageService.deleteTempFile(event.fileUrl());
    }
}
```

**AI/碳管理场景关联：**
碳管家AI助手的报告生成流程使用事务事件机制：AI生成碳排放报告并保存到数据库（主事务），事务提交后异步触发通知发送、训练数据收集和配额扣减。如果报告保存事务回滚（如数据库异常），AFTER_ROLLBACK监听器自动清理AI生成的临时报告文件，避免存储浪费。通过ContextCopyingTaskDecorator，异步线程中仍能获取租户上下文用于数据隔离，确保通知服务能正确定位目标租户。

---

#### 追问：
- 追问1：你用ContextCopyingTaskDecorator手动拷贝SecurityContext/TenantContext到异步线程，但CompletableFuture.supplyAsync自己开的线程不走ThreadPoolTaskExecutor，这种"绕过装饰器"的写法会悄悄丢失租户上下文吗？怎么统一管控？
  - **答**：会丢失。CompletableFuture.supplyAsync 默认用 ForkJoinPool，不经过 ThreadPoolTaskExecutor 的 ContextCopyingTaskDecorator，SecurityContext/TenantContext 不拷贝，异步线程查数据无租户上下文→漏查或越权。
    - 统一管控：
      - ① 所有异步统一走自定义 ThreadPoolTaskExecutor（带装饰器）
      - ② 封装工具类禁止直接用 supplyAsync，改用带上下文的 executor
      - ③ 或用 TransmittableThreadLocal 全局跨线程传递
- 追问2：AFTER_ROLLBACK监听器清理临时文件，如果报告主事务回滚是因为数据库宕机而非业务错误，此时去调fileStorageService.deleteTempFile会不会也连不上存储，导致清理本身失败留下孤儿文件？
  - **答**：会留下孤儿文件。AFTER_ROLLBACK 监听器执行 deleteTempFile，若存储也连不上则清理失败。
    - 兜底：
      - ① 清理加重试 + 死信（失败记补偿表，定时重试删除）
      - ② 临时文件带 TTL/过期时间，存储层定期扫描过期文件自动清理
      - ③ 清理失败仅告警不阻断，由独立"孤儿文件回收"任务兜底
      - ④ 写文件前先落"待清理"元数据

### 23. Spring事件机制在AI服务编排中的应用
**重要度**：★★★

**题目：**
请设计一个基于Spring事件机制的AI服务编排方案，用于处理碳管家AI助手的复杂问答场景（如用户提问需要同时检索碳法规库、碳排放因子库和企业碳排放数据，然后由AI综合生成答案）。

**解答：**
复杂AI问答需要并行检索多个知识源，然后综合生成答案。使用事件机制实现服务编排，将检索任务拆分为独立事件，并行处理后汇总。

```java
// 检索请求事件（用于触发并行检索）
public record CarbonRagRetrieveEvent(
    String sessionId,
    String query,
    Long tenantId,
    CompletableFuture<List<RetrievalResult>> future,
    RetrievalSource source  // 检索源类型
) {}

// 检索完成事件（用于汇总结果）
public record CarbonRagRetrievedEvent(
    String sessionId,
    RetrievalSource source,
    List<RetrievalResult> results,
    long durationMs
) {}

// 编排服务：发起并行检索
@Slf4j                              // 下面用了 log.warn，别漏注解
@Service
public class CarbonRagOrchestrator {

    // Spring AI 自动装配的是 ChatClient.Builder，需自行 build 出 ChatClient
    private final ChatClient chatClient;

    public CarbonRagOrchestrator(ChatClient.Builder builder) {
        this.chatClient = builder.build();
    }

    @Autowired
    private ApplicationEventPublisher eventPublisher;
    @Autowired
    @Qualifier("ragExecutor")
    private ThreadPoolTaskExecutor ragExecutor;

    public CarbonAiResponse orchestratedChat(CarbonUser user, String query) {
        String sessionId = UUID.randomUUID().toString();
        long startTime = System.currentTimeMillis();

        // 1. 并行发起三个检索源的检索
        List<CompletableFuture<List<RetrievalResult>>> futures = new ArrayList<>();
        List<RetrievalSource> sources = List.of(
            RetrievalSource.CARBON_LAW,      // 碳法规知识库
            RetrievalSource.EMISSION_FACTOR, // 碳排放因子库
            RetrievalSource.ORG_DATA         // 企业碳排放数据
        );

        for (RetrievalSource source : sources) {
            CompletableFuture<List<RetrievalResult>> future = new CompletableFuture<>();
            futures.add(future);
            // 发布检索事件，由对应的监听器并行处理
            eventPublisher.publishEvent(new CarbonRagRetrieveEvent(
                sessionId, query, user.getTenantId(), future, source));
        }

        // 2. 等待所有检索完成（设置超时）
        CompletableFuture<Void> allFutures = CompletableFuture.allOf(
            futures.toArray(new CompletableFuture[0]));
        try {
            allFutures.get(10, TimeUnit.SECONDS); // 最多等待10秒
        } catch (TimeoutException e) {
            log.warn("部分检索源超时，使用已完成的检索结果继续生成");
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt(); // 恢复中断标志，不要吞掉
            log.warn("检索等待被中断，使用已完成的检索结果继续生成");
        } catch (ExecutionException e) {
            // allOf 只要有一个子任务异常完成就会抛出，此处降级为"只用已成功的结果"
            log.warn("部分检索源异常，使用已完成的检索结果继续生成", e.getCause());
        }

        // 3. 收集所有成功的检索结果
        List<RetrievalResult> allResults = futures.stream()
            .filter(CompletableFuture::isDone)
            .filter(f -> !f.isCompletedExceptionally())
            .map(f -> f.getNow(List.of()))
            .flatMap(List::stream)
            .sorted(Comparator.comparingDouble(RetrievalResult::getScore).reversed())
            .limit(10) // 取Top-10最相关的检索片段
            .collect(Collectors.toList());

        // 4. 发布检索完成事件（用于监控和审计）
        eventPublisher.publishEvent(new CarbonRagRetrievedEvent(
            sessionId, null, allResults, System.currentTimeMillis() - startTime));

        // 5. 调用大模型综合生成答案
        String prompt = buildRagPrompt(query, allResults, user);
        String answer = chatClient.prompt(prompt).call().content();

        return new CarbonAiResponse(answer, allResults, sessionId);
    }
}

// 检索监听器：各检索源独立处理
@Component
public class CarbonRagRetrieveListener {

    @Autowired
    private VectorStore carbonLawVectorStore;
    @Autowired
    private EmissionFactorService factorService;
    @Autowired
    private OrgCarbonDataService orgDataService;

    @EventListener
    @Async("ragExecutor")
    public void onRetrieve(CarbonRagRetrieveEvent event) {
        try {
            List<RetrievalResult> results = switch (event.source()) {
                case CARBON_LAW -> retrieveFromCarbonLaw(event);
                case EMISSION_FACTOR -> retrieveFromFactorDb(event);
                case ORG_DATA -> retrieveFromOrgData(event);
            };
            event.future().complete(results);
        } catch (Exception e) {
            log.error("检索失败: source={}, session={}", event.source(), event.sessionId(), e);
            event.future().complete(List.of()); // 失败返回空列表，不阻塞整体流程
        }
    }

    private List<RetrievalResult> retrieveFromCarbonLaw(CarbonRagRetrieveEvent event) {
        // Spring AI 1.x 的 SearchRequest 用 builder：query(..)/topK(..)/filterExpression(..)，
        // 0.8/1.0-M 时代的 SearchRequest.query(..).withTopK(..) 已移除
        return carbonLawVectorStore.similaritySearch(
            SearchRequest.builder()
                .query(event.query())
                .topK(5)
                .filterExpression("tenant_id == " + event.tenantId())
                .build()
        );
    }

    private List<RetrievalResult> retrieveFromFactorDb(CarbonRagRetrieveEvent event) {
        return factorService.searchByQuery(event.query()).stream()
            .map(f -> new RetrievalResult(f.toString(), 0.85, "FACTOR"))
            .collect(Collectors.toList());
    }

    private List<RetrievalResult> retrieveFromOrgData(CarbonRagRetrieveEvent event) {
        return orgDataService.queryByTenantAndKeyword(event.tenantId(), event.query())
            .stream()
            .map(d -> new RetrievalResult(d.toJson(), 0.90, "ORG_DATA"))
            .collect(Collectors.toList());
    }
}
```

**AI/碳管理场景关联：**
当企业用户提问"我们公司2024年碳排放量相比去年变化如何？是否符合最新碳法规要求？"时，编排服务同时检索三个知识源：碳法规向量库匹配相关法规条款、碳排放因子库查找计算方法、企业碳排放数据库查询历史排放数据。三个检索并行执行，最快3秒内完成。然后AI综合三个来源的信息生成完整回答，既包含企业碳排放数据的同比分析，又关联最新的碳法规合规要求。事件机制使各检索源解耦，新增检索源（如碳交易市场价格数据）只需新增监听器，无需修改编排逻辑。

---

#### 追问：
- 追问1：你用CompletableFuture + 事件实现三路并行检索并在10秒超时后取已完成结果，如果碳法规库和因子库都按时返回但企业数据检索因Milvus慢而超时，最终答案会"缺一块"地回答用户，这种信息不全的回答在碳合规场景下会不会给出误导性结论？怎么标注"部分检索缺失"？
  - **答**：会误导。碳合规场景"缺一块"的回答可能遗漏关键法规/排放因子导致错误结论。
    - 处理：
      - ① 超时源在答案显式标注"企业数据暂未返回，以下基于法规库+因子库"，让用户知悉不完整
      - ② 设最低可用集：核心源（法规库）超时则整体降级/重试，非核心缺失才标注
      - ③ 给答案打"置信度/完整度"标记
      - ④ 缺失部分异步补查后主动推送补充
- 追问2：CarbonRagRetrieveEvent里直接带着CompletableFuture在监听器里complete，如果某个检索源监听器因异常没调用complete也没completeExceptionally，编排线程会一直阻塞在allOf.get(10s)吗？超时后该future的状态会怎样影响后续结果收集？
  - **答**：会。某监听器异常且既未 complete 也未 completeExceptionally，该 CompletableFuture 永不结束，allOf.get(10s) 在 10 秒超时后返回（被打断），不会永久阻塞。
    - 但超时后该 future 仍可能后续被 complete，结果被忽略或回调晚到。修复：
      - ① 每个源 future 都包 exceptionally 确保必 complete/completeExceptionally
      - ② 编排侧对单个 future 单独设 orTimeout，保证任何源都能在时限内结束

### 24. 事件驱动架构与领域事件的实践
**重要度**：★★★

**题目：**
请说明领域驱动设计（DDD）中领域事件的概念，以及如何在Spring项目中实现领域事件驱动的微服务架构，结合碳管理场景给出完整实践。

**解答：**
领域事件（Domain Event）是DDD中的核心概念，表示领域中发生的重要业务事件。与普通技术事件不同，领域事件具有业务语义，使用业务语言命名（如"碳排放报告已提交"、"碳配额已分配"），是业务专家能理解的概念。

领域事件驱动架构的核心思想是：当某个聚合根执行了引起状态变化的操作后，发布对应的领域事件，其他模块或服务通过订阅事件进行响应。这种设计实现了模块间的松耦合，符合DDD中"一个聚合只修改自己的状态"的原则。

**Spring项目中的领域事件实践：**

在单体应用中，使用Spring的ApplicationEventPublisher发布事件，@EventListener订阅。在微服务中，需要结合消息中间件（如RocketMQ、Kafka）实现跨服务的事件传播。通常的架构模式是：聚合根发布本地领域事件→事件存储表持久化→后台任务读取并发送到MQ→其他服务订阅MQ消息处理。

```java
// 领域事件定义
public abstract class DomainEvent {
    private final String eventId = UUID.randomUUID().toString();
    private final LocalDateTime occurredOn = LocalDateTime.now();
    private final Long tenantId;

    protected DomainEvent(Long tenantId) {
        this.tenantId = tenantId;
    }
    // getters...
}

public class CarbonReportSubmittedEvent extends DomainEvent {
    private final Long reportId;
    private final Long orgId;
    private final int reportYear;
    private final BigDecimal totalEmission;
    private final String submittedBy;

    // constructor, getters...
}

// 聚合根发布事件
@Entity
public class CarbonReport extends AggregateRoot {

    public void submit(CarbonUser submitter) {
        if (this.status != ReportStatus.DRAFT) {
            throw new IllegalStateException("只有草稿状态的报告可以提交");
        }
        this.status = ReportStatus.SUBMITTED;
        this.submitTime = LocalDateTime.now();

        // 发布领域事件
        this.addDomainEvent(new CarbonReportSubmittedEvent(
            this.tenantId, this.id, this.orgId,
            this.reportYear, this.totalEmission,
            submitter.getUsername()
        ));
    }
}

// 抽象聚合根基类
public abstract class AggregateRoot {
    @Transient
    private final List<DomainEvent> domainEvents = new ArrayList<>();

    protected void addDomainEvent(DomainEvent event) {
        this.domainEvents.add(event);
    }

    public List<DomainEvent> getDomainEvents() {
        return Collections.unmodifiableList(domainEvents);
    }

    public void clearDomainEvents() {
        this.domainEvents.clear();
    }
}

// 事件发布器：在事务提交后发布事件
@Component
public class DomainEventPublisher {

    private final RocketMQTemplate rocketMQTemplate;
    private final EventStoreRepository eventStoreRepository;

    public DomainEventPublisher(RocketMQTemplate rocketMQTemplate,
                                EventStoreRepository eventStoreRepository) {
        this.rocketMQTemplate = rocketMQTemplate;
        this.eventStoreRepository = eventStoreRepository;
    }

    // 监听"业务事件本身"：事务提交后才被调用
    @TransactionalEventListener(phase = TransactionPhase.AFTER_COMMIT)
    public void onReportSubmitted(CarbonReportSubmittedEvent event) {
        // 1) 事件存储（Event Sourcing，可选）
        eventStoreRepository.save(event);

        // 2) 事务已提交，业务数据已落库，这里可以安全地发 MQ / 调外部接口
        //    AFTER_COMMIT 时业务数据虽已提交，但事务资源（连接、会话）可能尚未完全释放，
        //    同步发送会等 broker ack 再返回，失败可感知、可补偿，比 asyncSend 更稳
        rocketMQTemplate.syncSend("carbon-report-submitted",
            MessageBuilder.withPayload(event).build());
    }
}

// Repository在保存后触发事件发布
@Repository
public class CarbonReportRepository {

    @Autowired
    private ApplicationEventPublisher eventPublisher;

    @Transactional
    public CarbonReport save(CarbonReport report) {
        CarbonReport saved = entityManager.merge(report);
        // 发布所有积累的领域事件
        report.getDomainEvents().forEach(eventPublisher::publishEvent);
        report.clearDomainEvents();
        return saved;
    }
}

// 跨微服务的事件消费者（通过RocketMQ）
@Component
@RocketMQMessageListener(topic = "carbon-report-submitted",
    consumerGroup = "ai-service-consumer")
public class CarbonReportEventConsumer implements RocketMQListener<CarbonReportSubmittedEvent> {

    @Autowired
    private CarbonChatService chatService;

    @Override
    public void onMessage(CarbonReportSubmittedEvent event) {
        // AI服务接收到报告提交事件后，自动生成报告摘要
        log.info("收到碳排放报告提交事件: reportId={}, tenant={}",
            event.getReportId(), event.getTenantId());

        // 触发AI自动分析：将报告数据发送给AI生成摘要
        chatService.autoAnalyzeReport(event.getReportId(), event.getTenantId());
    }
}
```

**关于监听的事件类型**：`@TransactionalEventListener` 的入参必须是**业务事件本身**（本例 `CarbonReportSubmittedEvent`），不是"事务生命周期事件"——Spring 里并没有 `AfterCompletionEvent` 这个类。若确实要监听事务本身的完成回调，Spring 5.3+ 提供的是 `TransactionExecutionEvent` 家族（`AfterCommitTransactionExecutionEvent`、`AfterCompletionTransactionExecutionEvent` 等），或者直接注册 `TransactionSynchronization`；日常业务代码用不到这一层。

**AI/碳管理场景关联：**
碳管理平台采用领域事件驱动的微服务架构。当企业用户通过报告服务提交碳排放报告后，报告服务发布CarbonReportSubmittedEvent领域事件。该事件通过RocketMQ传播到多个服务：AI服务接收事件后自动分析报告并生成AI摘要、通知服务接收事件后向企业管理员发送提交确认通知、合规服务接收事件后检查报告是否满足碳法规要求。整个流程各服务松耦合，AI分析失败不会阻断报告提交主流程，且新增事件消费者（如未来的碳交易服务）无需修改报告服务代码。

---

#### 追问：
- 追问1：报告提交后通过RocketMQ广播给AI服务自动生成摘要，如果AI服务消费失败并重试3次后仍失败，这条领域事件会进入死信队列，此时用户的报告已提交成功但永远没有AI摘要，业务上怎么补偿和通知？
  - **答**：业务补偿：
    - ① 死信消息由"补偿消费者"接管，告警通知运营/用户"摘要生成失败"
    - ② 提供手动/定时重试入口重新触发摘要生成
    - ③ 报告状态标记"已提交待摘要"，前端展示并可手动重试
    - ④ 用最终一致，摘要失败不影响报告主流程，仅摘要缺失，由补偿任务兜底
- 追问2：聚合根在submit时addDomainEvent，再由Repository.save后发布，如果save成功但事件发布到MQ之前应用崩溃，这个领域事件就丢了，AI摘要永远不会触发，这种"本地事务与MQ的非原子性"在碳管家场景怎么用事务消息或本地消息表兜底？
  - **答**：会丢。Repository.save 与 MQ 发布非原子，崩溃则事件丢失、AI 摘要永不触发。
    - 兜底：
      - ① 本地消息表/事务消息：save 与写消息表同一本地事务，后台任务读消息表发 MQ
      - ② 或领域事件先存库（OUTBOX 模式）由独立发布者投递
      - ③ 用 RocketMQ 事务消息（半消息+本地状态回查）保证原子
      - ④ 消费端幂等，重复投递安全

#### 七、Spring Bean 生命周期

### 25. Spring Bean生命周期的完整流程
**重要度**：★★★★★

**题目：**
请详细描述Spring Bean从创建到销毁的完整生命周期，包括实例化、属性赋值、初始化、使用、销毁各阶段的执行顺序和回调方法。

**解答：**
Spring Bean的生命周期是Spring框架的核心机制之一，完整流程分为四大阶段：

**一、实例化（Instantiation）**
Spring通过反射调用构造方法创建Bean实例。此阶段可以通过BeanPostProcessor的postProcessBeforeInstantiation和postProcessAfterInstantiation方法进行干预（如返回代理对象替代真实实例）。对于通过工厂方法创建的Bean，调用@Bean标注的工厂方法而非构造方法。

**二、属性赋值（Populate Properties）**
Spring根据BeanDefinition中的属性信息，通过setter方法或字段注入完成依赖注入。此阶段处理@Autowired、@Value、@Resource等注解。三级缓存机制在此时处理循环依赖。调用InstantiationAwareBeanPostProcessor.postProcessProperties方法进行属性注入的后处理（如@Autowired的注入逻辑实际由AutowiredAnnotationBeanPostProcessor在此阶段实现）。

**三、初始化（Initialization）**
按以下顺序执行：
1. 调用Aware接口回调：BeanNameAware.setBeanName → BeanClassLoaderAware.setBeanClassLoader → BeanFactoryAware.setBeanFactory（如果是ApplicationContext环境，还会调用ApplicationContextAware.setApplicationContext等）。
2. 调用BeanPostProcessor.postProcessBeforeInitialization：所有BeanPostProcessor的前置处理。@PostConstruct注解的处理（由CommonAnnotationBeanPostProcessor实现）在此阶段执行。
3. 调用InitializingBean.afterPropertiesSet：如果Bean实现了InitializingBean接口。
4. 调用自定义init-method：通过@Bean(initMethod="xxx")或XML配置的init-method指定的方法。
5. 调用BeanPostProcessor.postProcessAfterInitialization：所有BeanPostProcessor的后置处理。AOP代理的创建（由AbstractAutoProxyCreator实现）在此阶段完成。

**四、使用（In Use）**
Bean完全初始化后驻留在Spring容器中，供应用程序使用。单例Bean在整个容器生命周期内存在，原型Bean每次获取都创建新实例。

**五、销毁（Destruction）**
当容器关闭时，按以下顺序执行：
1. 调用@PreDestroy注解标注的方法（由CommonAnnotationBeanPostProcessor处理）。
2. 调用DisposableBean.destroy（如果Bean实现了DisposableBean接口）。
3. 调用自定义destroy-method（通过@Bean(destroyMethod="xxx")指定）。

```java
@Component
public class CarbonAiLifecycleBean implements BeanNameAware, BeanFactoryAware,
        InitializingBean, DisposableBean {

    private static final Logger log = LoggerFactory.getLogger(CarbonAiLifecycleBean.class);

    // 1. 实例化（构造方法）
    public CarbonAiLifecycleBean() {
        log.info("1. 实例化: 构造方法被调用");
    }

    // 2. 属性赋值（依赖注入）
    @Autowired
    public void setChatClient(ChatClient chatClient) {
        log.info("2. 属性赋值: ChatClient注入完成");
    }

    // 3.1 BeanNameAware回调
    @Override
    public void setBeanName(String name) {
        log.info("3.1 BeanNameAware: beanName={}", name);
    }

    // 3.2 BeanFactoryAware回调
    @Override
    public void setBeanFactory(BeanFactory beanFactory) throws BeansException {
        log.info("3.2 BeanFactoryAware: BeanFactory注入完成");
    }

    // 3.3 @PostConstruct
    @PostConstruct
    public void postConstruct() {
        log.info("3.3 @PostConstruct: 初始化前自定义逻辑");
    }

    // 3.4 InitializingBean
    @Override
    public void afterPropertiesSet() throws Exception {
        log.info("3.4 InitializingBean.afterPropertiesSet: 属性设置完成");
    }

    // 3.5 自定义init-method
    public void customInit() {
        log.info("3.5 customInit: 自定义初始化方法");
    }

    // 4. 使用阶段 - 业务方法
    public String chat(String question) {
        return "AI回答: " + question;
    }

    // 5.1 @PreDestroy
    @PreDestroy
    public void preDestroy() {
        log.info("5.1 @PreDestroy: 销毁前自定义逻辑");
    }

    // 5.2 DisposableBean
    @Override
    public void destroy() throws Exception {
        log.info("5.2 DisposableBean.destroy: Bean销毁");
    }

    // 5.3 自定义destroy-method
    public void customDestroy() {
        log.info("5.3 customDestroy: 自定义销毁方法");
    }
}
```

**AI/碳管理场景关联：**
碳管家AI助手的CarbonChatService在@PostConstruct阶段预热Milvus连接池和加载碳法规知识库索引，确保第一次用户提问时不会有冷启动延迟。在@PreDestroy阶段优雅关闭大模型HTTP连接池，等待进行中的AI请求完成（设置最大等待时间30秒），避免因服务关闭导致用户对话中断。通过实现SmartLifecycle接口，可以控制AI服务的启动顺序（在Milvus和Redis就绪后再启动），确保依赖组件可用。

---

#### 追问：
- 追问1：你说CarbonChatService在@PostConstruct预热Milvus连接池，但如果预热依赖的Redis Bean因网络问题还没初始化完，@PostConstruct阶段拿到的Redis连接会是null还是抛错？预热失败会导致整个AI服务启动失败吗？
  - **答**：取决于注入方式。若 Redis Bean 未就绪，构造器/字段注入在 @PostConstruct 前已完成（Spring 保证依赖先初始化）一般不会 null；但 @Lazy 或手动 getBean 才拿可能拿到未就绪连接。
    - @PostConstruct 内调用失败（连接异常抛错）默认导致 Bean 初始化失败、应用启动失败。建议预热加 try-catch 降级（标记 unhealthy 但允许启动），或用 SmartLifecycle 控制顺序避免硬失败。
- 追问2：实现了SmartLifecycle的Bean可以通过getPhase控制启动顺序，但如果CarbonChatService依赖的MilvusVectorStore本身没有实现SmartLifecycle，仅靠@DependsOn或注入关系，Spring能保证Milvus一定先于ChatService预热完成吗？
  - **答**：不能保证"预热完成"。SmartLifecycle 只对实现该接口的 Bean 按 phase 排序；MilvusVectorStore 没实现则仅靠 @DependsOn/注入关系，Spring 能保证"ChatService 创建在 Milvus 之后"（依赖先实例化），但预热是运行时行为，@DependsOn 管不了预热完成。
    - 稳妥：让 MilvusVectorStore 也实现 SmartLifecycle/InitializingBean，ChatService 依赖它，且预热在 start() 完成后再置更高 phase。

### 26. Bean初始化过程与延迟初始化策略
**重要度**：★★★★

**题目：**
请说明Spring中Bean的初始化时机（饿汉式 vs 懒加载），@Lazy注解的使用场景，以及在AI服务启动中的性能优化实践。

**解答：**
Spring默认在容器启动时创建所有单例Bean（饿汉式），确保依赖关系在启动时就能暴露问题。但某些Bean的初始化代价很高（如AI模型客户端建立连接、向量库索引加载），此时可以使用@Lazy注解延迟初始化。

**@Lazy的作用：**
- 标注在类上：该Bean在第一次被引用时才初始化，而非容器启动时。
- 标注在@Autowired/@Resource字段上：注入一个代理对象，代理对象在第一次方法调用时触发真实Bean的初始化。
- 标注在@Configuration类上：该配置类中的所有@Bean方法都变为懒加载。

**@Lazy的底层原理：**
标注@Lazy的Bean在容器启动时仅注册BeanDefinition，不创建实例。当其他Bean依赖它时，Spring注入一个CGLIB代理对象（而非真实Bean），代理对象拦截所有方法调用，在第一次调用时触发getBean创建真实实例并转发调用。

```java
@Configuration
public class CarbonAiConfig {

    // 大模型客户端：启动时不初始化，首次调用AI时才创建连接
    // 注意：Spring AI 没有 OpenAiChatClient，链路是 OpenAiApi → OpenAiChatModel → ChatClient.create(model)，
    // baseUrl/apiKey 属于 OpenAiApi
    @Bean
    @Lazy
    public ChatClient openAiChatClient(CarbonAiProperties properties) {
        log.info("初始化大模型 ChatClient（懒加载）");
        OpenAiApi openAiApi = OpenAiApi.builder()
            .apiKey(properties.apiKey())
            .baseUrl(properties.baseUrl())
            .build();
        OpenAiChatModel chatModel = OpenAiChatModel.builder()
            .openAiApi(openAiApi)
            .defaultOptions(OpenAiChatOptions.builder().model(properties.model()).build())
            .build();
        return ChatClient.create(chatModel);
    }

    // 向量存储：启动时即初始化，因为健康检查依赖
    @Bean
    public MilvusVectorStore milvusVectorStore(MilvusClient milvusClient) {
        log.info("初始化MilvusVectorStore");
        return new MilvusVectorStore(milvusClient);
    }

    // 碳法规知识库索引：懒加载，首次问答时加载
    @Bean
    @Lazy
    public CarbonLawIndex carbonLawIndex(MilvusVectorStore vectorStore) {
        log.info("加载碳法规知识库索引（懒加载）");
        CarbonLawIndex index = new CarbonLawIndex(vectorStore);
        index.loadIndex(); // 加载预构建的索引
        return index;
    }
}

// 在注入点也可使用@Lazy
@Service
public class CarbonChatService {

    @Autowired
    @Lazy  // 注入代理对象，首次调用chat()时才初始化ChatClient
    private ChatClient chatClient;

    @Autowired
    @Lazy
    private CarbonLawIndex carbonLawIndex;

    public String chat(String question) {
        // 首次调用时触发ChatClient和CarbonLawIndex的初始化
        return chatClient.prompt(question).call().content();
    }
}
```

**@Lazy的注意事项：**
1. 懒加载Bean的初始化异常延迟到运行时暴露，可能掩盖配置问题。
2. @Lazy注解的Bean如果被非@Lazy的Bean依赖，需要在注入点也加@Lazy，否则会在启动时触发初始化。
3. 懒加载不影响Bean的生命周期回调，只是推迟了执行时机。

**AI/碳管理场景关联：**
碳管家AI助手的应用启动优化策略：Milvus连接和Redis连接在启动时初始化（健康检查依赖），大模型 ChatClient 和碳法规知识库索引使用@Lazy延迟初始化。这样应用启动时间从15秒减少到5秒，而AI功能在首次调用时多约3秒初始化时间（可通过预热接口在部署后主动触发）。对于SaaS多租户场景，可以为每个租户的AI配置使用@Lazy，避免低活跃租户的AI客户端占用连接资源。

---

#### 追问：
- 追问1：你把ChatClient和碳法规索引设为@Lazy，首问会多3秒冷启动，如果恰好在K8s刚完成滚动更新后的流量洪峰期，大量首问同时触发懒加载，会不会把Milvus和大模型API打挂？怎么用启动后预热接口削峰？
  - **答**：会。滚动更新后大量首问同时触发懒加载，集中初始化 Milvus 连接池/加载索引，可能压垮 Milvus 与 LLM API。
    - 削峰：
      - ① 启动完成调预热接口提前加载再接入流量（K8s readiness 探针在预热后才通过）
      - ② 用 @PostConstruct/SmartLifecycle 预热关键 Bean
      - ③ 限制并发初始化（信号量）避免同时建大量连接
      - ④ 预热失败不影响启动但标记降级
- 追问2：@Lazy注入代理对象，在12.31提到的"提前AOP"场景下，这个懒加载代理和AOP代理是同一层代理还是嵌套代理？委托调用时会不会出现"懒加载代理里包着AOP代理"导致final方法或类型强转异常？
  - **答**：是嵌套代理。@Lazy 生成 CGLIB 代理，AOP 也生成 CGLIB 代理，二者可能嵌套（外层 lazy 包内层 AOP 或反之）。
    - 委托调用时：lazy 代理首次触发目标初始化，目标若已是 AOP 代理则正常；但类型强转需注意代理类型（都是子类，强转为具体类可能失败若层级不对）。
    - final 方法仍无法被任一层代理拦截；关键 Bean 尽量不叠加 @Lazy 与 AOP，或确保代理类型一致。

### 27. Bean销毁过程与资源释放策略
**重要度**：★★★★

**题目：**
请说明Spring Bean销毁阶段的执行流程，以及如何确保AI服务优雅停机时正确释放资源（如关闭HTTP连接池、刷新缓冲数据、等待异步任务完成）。

**解答：**
Spring容器关闭时，通过registerShutdownHook注册的JVM关闭钩子触发容器的close方法，进而执行所有单例Bean的销毁流程。销毁顺序与初始化顺序相反，确保被依赖的Bean最后销毁。

**销毁阶段的回调顺序：**
1. @PreDestroy注解方法（由InitDestroyAnnotationBeanPostProcessor处理）
2. DisposableBean.destroy()方法（afterPropertiesSet 是 InitializingBean 的初始化方法，不属销毁阶段）
3. 自定义destroy-method方法
4. BeanPostProcessor销毁后处理（如有）

**优雅停机的挑战：**
在AI服务中，Bean销毁时需要处理：进行中的AI请求需要等待完成或超时、HTTP连接池需要优雅关闭、内存中的对话上下文需要持久化、消息队列消费者需要停止消费并确认已消费消息、定时任务需要等待当前执行完成。

```java
@Component
public class CarbonAiGracefulShutdown implements SmartLifecycle {

    private volatile boolean running = false;
    @Autowired
    private ChatClient chatClient;
    @Autowired
    private ExecutorService aiRequestExecutor;
    @Autowired
    private ConversationContextCache contextCache;
    @Autowired
    private MeterRegistry meterRegistry;

    @Override
    public void start() {
        running = true;
        log.info("碳管家AI服务启动");
    }

    @Override
    public void stop() {
        running = false;
        log.info("碳管家AI服务开始优雅停机...");

        // 1. 停止接收新的AI请求
        // （通过HealthIndicator返回OUT_OF_SERVICE，负载均衡器不再路由请求）

        // 2. 等待进行中的AI请求完成（最多等待60秒）
        aiRequestExecutor.shutdown();
        try {
            if (!aiRequestExecutor.awaitTermination(60, TimeUnit.SECONDS)) {
                log.warn("部分AI请求未在60秒内完成，强制关闭");
                aiRequestExecutor.shutdownNow();
            }
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }

        // 3. 持久化内存中的对话上下文
        try {
            int saved = contextCache.flushToRedis();
            log.info("已持久化{}个对话上下文到Redis", saved);
        } catch (Exception e) {
            log.error("对话上下文持久化失败", e);
        }

        // 4. 关闭大模型HTTP连接池
        if (chatClient instanceof AutoCloseable closeable) {
            try {
                closeable.close();
                log.info("ChatClient连接池已关闭");
            } catch (Exception e) {
                log.error("ChatClient关闭失败", e);
            }
        }

        // 5. 上报停机指标
        meterRegistry.counter("carbon.ai.shutdown").increment();
        log.info("碳管家AI服务优雅停机完成");
    }

    @Override
    public boolean isRunning() {
        return running;
    }

    @Override
    public int getPhase() {
        return Integer.MIN_VALUE; // 最先启动，最后销毁
    }
}

// 配置优雅停机超时
@Configuration
public class GracefulShutdownConfig {

    @Bean
    public GracefulShutdown gracefulShutdownCustomizer() {
        return new GracefulShutdown();
    }
}

// application.yml
// server:
//   shutdown: graceful
// spring:
//   lifecycle:
//     timeout-per-shutdown-phase: 60s
```

**AI/碳管理场景关联：**
碳管家AI助手在K8s滚动更新时通过优雅停机确保服务连续性。当Pod收到SIGTERM信号时，SmartLifecycle.stop()方法执行：首先通过健康检查标记为不可用（K8s Service摘除Pod），等待进行中的AI问答请求完成（最长60秒），将活跃对话上下文保存到Redis（新Pod接管后可恢复对话），最后关闭大模型API连接池。配合K8s的preStop hook和terminationGracePeriodSeconds配置，实现零中断滚动更新。

---

#### 追问：
- 追问1：优雅停机时你等待进行中的AI请求最多60秒，如果此时有一个提问触发了大模型30秒推理+Milvus慢查询，加上网络抖动实际超过60秒，shutdownNow会中断正在call的HTTP调用吗？用户会收到半截答案还是连接重置？
  - **答**：shutdownNow 会中断线程（Thread.interrupt），正在执行的 HTTP 调用若响应中断（底层 socket 抛 InterruptedIOException）会中止，但很多同步 HTTP 客户端不响应中断，会继续跑到自身超时。
    - 结果：用户可能收到连接重置/半截答案，或请求被丢弃。改善：
      - ① LLM 调用设自身超时 < 停机窗口
      - ② 停机拒绝新请求，进行中请求等自身超时而非强杀
      - ③ 用可取消客户端（WebClient）响应中断，干净取消
- 追问2：你把对话上下文flushToRedis，如果Redis在停机窗口恰好主从切换不可用，flush失败但应用照常关闭，这部分未持久化的对话上下文会丢失吗？新Pod接管后用户对话断点该怎么恢复？
  - **答**：会丢失未 flush 的上下文。Redis 主从切换 flush 失败、应用照关，未持久化对话断点丢失。
    - 恢复：
      - ① flush 加重试 + 超时，尽量在停机窗口内完成
      - ② 对话上下文同时写多副本（Redis + DB/对象存储），Redis 不可用降级写 DB
      - ③ 新 Pod 接管后从持久化源恢复最近上下文
      - ④ 客户端带 sessionId 重连主动拉断点
      - ⑤ 关键上下文视可重建，不必强一致

### 28. BeanPostProcessor原理与自定义实现
**重要度**：★★★★

**题目：**
请详细说明BeanPostProcessor的工作原理、执行时机，并实现一个自定义BeanPostProcessor用于自动为AI服务Bean添加性能监控代理。

**解答：**
BeanPostProcessor是Spring最核心的扩展点之一，它允许在Bean初始化前后对Bean实例进行自定义处理。Spring内部大量使用BeanPostProcessor实现各种功能：@Autowired的注入由AutowiredAnnotationBeanPostProcessor完成，@PostConstruct的回调由CommonAnnotationBeanPostProcessor完成，AOP代理由AbstractAutoProxyCreator完成。

**执行时机：**
BeanPostProcessor的两个方法在Bean的初始化阶段执行：
- postProcessBeforeInitialization：在InitializingBean.afterPropertiesSet和@PostConstruct之前执行
- postProcessAfterInitialization：在InitializingBean.afterPropertiesSet和自定义init-method之后执行，AOP代理在此阶段创建

**关键特性：**
1. BeanPostProcessor本身是特殊的Bean，在容器启动时优先于普通Bean实例化。
2. BeanPostProcessor不会作用于其他BeanPostProcessor，避免循环依赖问题。
3. 通过实现Ordered或PriorityOrdered接口控制多个BeanPostProcessor的执行顺序。

```java
// 自定义注解：标记需要性能监控的AI服务
@Target(ElementType.TYPE)
@Retention(RetentionPolicy.RUNTIME)
public @interface AiMonitored {
    String name() default "";
    long warningThreshold() default 3000; // 默认3秒告警阈值
}

// 自定义BeanPostProcessor
@Component
@Order(Ordered.HIGHEST_PRECEDENCE + 100)
public class AiMonitorBeanPostProcessor implements BeanPostProcessor {

    @Autowired
    private MeterRegistry meterRegistry;

    @Override
    public Object postProcessBeforeInitialization(Object bean, String beanName) {
        return bean; // 初始化前不做处理
    }

    @Override
    public Object postProcessAfterInitialization(Object bean, String beanName) {
        // 1. 检查类上是否有@AiMonitored注解
        AiMonitored annotation = AnnotationUtils.findAnnotation(bean.getClass(), AiMonitored.class);
        if (annotation == null) {
            return bean;
        }

        String serviceName = annotation.name().isEmpty() ? beanName : annotation.name();
        long threshold = annotation.warningThreshold();

        // 2. 创建CGLIB代理
        Enhancer enhancer = new Enhancer();
        enhancer.setSuperclass(bean.getClass());
        enhancer.setCallback(new AiMonitorInterceptor(serviceName, threshold, meterRegistry));

        log.info("为AI服务[{}]创建性能监控代理, 告警阈值={}ms", serviceName, threshold);
        return enhancer.create();
    }

    // 方法拦截器
    @AllArgsConstructor
    private static class AiMonitorInterceptor implements MethodInterceptor {
        private final String serviceName;
        private final long warningThreshold;
        private final MeterRegistry meterRegistry;

        @Override
        public Object intercept(Object obj, Method method, Object[] args, MethodProxy proxy) throws Throwable {
            // 跳过toString、equals等Object方法
            if (method.getDeclaringClass() == Object.class) {
                return proxy.invokeSuper(obj, args);
            }

            String methodName = serviceName + "." + method.getName();
            long start = System.currentTimeMillis();

            try {
                Object result = proxy.invokeSuper(obj, args);
                long duration = System.currentTimeMillis() - start;

                // 记录调用耗时
                meterRegistry.timer("carbon.ai.method.duration",
                    "service", serviceName,
                    "method", method.getName()
                ).record(duration, TimeUnit.MILLISECONDS);

                // 超时告警
                if (duration > warningThreshold) {
                    log.warn("AI服务方法[{}]执行耗时{}ms, 超过阈值{}ms",
                        methodName, duration, warningThreshold);
                    meterRegistry.counter("carbon.ai.method.slow",
                        "service", serviceName).increment();
                }

                return result;
            } catch (Throwable ex) {
                meterRegistry.counter("carbon.ai.method.error",
                    "service", serviceName,
                    "method", method.getName(),
                    "error", ex.getClass().getSimpleName()
                ).increment();
                throw ex;
            }
        }
    }
}

// 使用：标注@AiMonitored自动获得性能监控
@Service
@AiMonitored(name = "carbonChat", warningThreshold = 5000)
public class CarbonChatService {
    public String chat(String question) { ... }
    public String generateReport(Long orgId) { ... }
}
```

**AI/碳管理场景关联：**
通过自定义AiMonitorBeanPostProcessor，碳管家AI助手中所有标注@AiMonitored的服务自动获得方法级性能监控能力。CarbonChatService的chat方法、CarbonReportService的generateReport方法等被自动代理，调用耗时、成功率和错误率自动上报到Micrometer。运维团队通过Grafana看板实时监控各AI方法的P50/P95/P99延迟，当chat方法P95超过5秒时触发告警，及时排查是Milvus检索慢还是大模型推理慢。

---

#### 追问：
- 追问1：你的AiMonitorBeanPostProcessor用CGLIB给@AiMonitored的Bean包了一层代理，如果这个Bean同时被12.7的AiMeterAspect（AOP）代理，两层代理的嵌套顺序是什么？方法耗时的统计会不会把AOP切面自身的时间也算进去？
  - **答**：嵌套顺序取决于代理创建时机：BeanPostProcessor 在初始化后包一层 CGLIB 监控代理，AOP 切面也在 postProcessAfterInitialization 包代理，多层代理嵌套。
    - 耗时统计会包含外层到内层的所有时间，可能把其他切面（如 AiMeterAspect）自身开销计入。控制：
      - ① 明确代理层级，监控代理包最外层，统计的应是"业务方法总耗时"含切面
      - ② 用 Micrometer 分层打点区分"业务"与"切面"耗时
- 追问2：BeanPostProcessor本身优先于普通Bean实例化，如果你的监控处理器依赖MeterRegistry而这个Registry又依赖其他还没就绪的Bean，初始化顺序会不会导致监控处理器自己创建失败？
  - **答**：会。BeanPostProcessor 在容器早期实例化，若它依赖的 MeterRegistry 还没就绪（MeterRegistry 自身也被其他 BPP 处理），会导致监控处理器创建失败或拿到半成品。
    - 解决：
      - ① BeanPostProcessor 尽量不依赖其他业务 Bean，MeterRegistry 用懒加载/延迟获取（postProcess 内按需 getBean，而非字段注入）
      - ② 让 MeterRegistry 尽早初始化（无依赖、高优先级）
      - ③ 监控处理器只做"标记"，实际打点在方法调用时取 Registry

#### 八、Spring 循环依赖

### 29. 三级缓存机制详解
**重要度**：★★★★★

**题目：**
请详细说明Spring解决循环依赖的三级缓存机制，包括每级缓存的作用、循环依赖的解决过程，以及为什么需要三级而非两级缓存。

**解答：**
Spring通过三级缓存（DefaultSingletonBeanRegistry中的三个Map）解决单例Bean的setter注入循环依赖问题：

**一级缓存（singletonObjects）**：存储完全初始化完成的单例Bean（成品Bean）。Map<String, Object>，存放经过完整生命周期（实例化→属性赋值→初始化）的Bean。

**二级缓存（earlySingletonObjects）**：存储早期暴露的半成品Bean引用（已实例化但未完成属性赋值和初始化）。Map<String, Object>，存放ObjectFactory提前生成的Bean引用。

**三级缓存（singletonFactories）**：存储ObjectFactory（对象工厂），能够生产Bean的早期引用。Map<String, ObjectFactory<?>>，在Bean实例化后、属性赋值前注册。

**循环依赖解决过程（以A依赖B，B依赖A为例）：**
1. 创建A：调用getBean("A")，一级缓存没有，开始创建A。
2. A实例化：通过构造方法创建A的实例（此时A未完成属性赋值）。
3. A注册三级缓存：将A的ObjectFactory放入三级缓存singletonFactories。
4. A属性赋值：发现A依赖B，调用getBean("B")。
5. 创建B：一级缓存没有B，开始创建B。
6. B实例化：通过构造方法创建B的实例。
7. B注册三级缓存：将B的ObjectFactory放入三级缓存。
8. B属性赋值：发现B依赖A，调用getBean("A")。
9. 查找A：一级缓存没有A→二级缓存没有A→三级缓存有A的ObjectFactory。
10. 调用A的ObjectFactory.getObject()获取A的早期引用，放入二级缓存earlySingletonObjects，从三级缓存移除。
11. B获得A的早期引用，完成属性赋值和初始化，B放入一级缓存。
12. A获得完全初始化的B，完成属性赋值和初始化，A放入一级缓存。

**为什么需要三级而非两级？**
三级缓存的ObjectFactory不是直接存储Bean引用，而是一个工厂，能够在获取早期引用时决定是否需要创建AOP代理。如果只有两级缓存，Spring必须在A实例化后立即判断是否需要创建代理（提前AOP），这破坏了Spring的设计原则——AOP代理应该在初始化后阶段（postProcessAfterInitialization）创建。三级缓存通过ObjectFactory延迟了这个决策：如果A没有被其他Bean循环依赖，AOP代理在正常的初始化后阶段创建；如果A被循环依赖，ObjectFactory提前调用SmartInstantiationAwareBeanPostProcessor.getEarlyBeanReference创建代理。

```java
// DefaultSingletonBeanRegistry核心代码（简化）
public class DefaultSingletonBeanRegistry {

    // 一级缓存：成品Bean
    private final Map<String, Object> singletonObjects = new ConcurrentHashMap<>();
    // 二级缓存：早期半成品Bean
    private final Map<String, Object> earlySingletonObjects = new ConcurrentHashMap<>();
    // 三级缓存：ObjectFactory
    private final Map<String, ObjectFactory<?>> singletonFactories = new HashMap<>();

    protected Object getSingleton(String beanName, boolean allowEarlyReference) {
        // 1. 从一级缓存查找
        Object singletonObject = this.singletonObjects.get(beanName);
        if (singletonObject == null && isSingletonCurrentlyInCreation(beanName)) {
            // 2. 从二级缓存查找
            singletonObject = this.earlySingletonObjects.get(beanName);
            if (singletonObject == null && allowEarlyReference) {
                synchronized (this.singletonObjects) {
                    // Double-check
                    singletonObject = this.singletonObjects.get(beanName);
                    if (singletonObject == null) {
                        singletonObject = this.earlySingletonObjects.get(beanName);
                        if (singletonObject == null) {
                            // 3. 从三级缓存获取ObjectFactory并生产早期引用
                            ObjectFactory<?> singletonFactory = this.singletonFactories.get(beanName);
                            if (singletonFactory != null) {
                                singletonObject = singletonFactory.getObject();
                                this.earlySingletonObjects.put(beanName, singletonObject);
                                this.singletonFactories.remove(beanName);
                            }
                        }
                    }
                }
            }
        }
        return singletonObject;
    }
}
```

**AI/碳管理场景关联：**
碳管家AI助手中，CarbonChatService依赖CarbonLawIndex（碳法规索引），而CarbonLawIndex在初始化时需要通过CarbonChatService进行向量编码。Spring三级缓存机制自动解决这个循环依赖：先创建CarbonChatService的早期引用，CarbonLawIndex注入该引用完成初始化，然后CarbonChatService完成属性赋值获得完全初始化的CarbonLawIndex。但如果CarbonChatService的构造方法需要CarbonLawIndex参数（构造器循环依赖），三级缓存无法解决，需要重构为setter注入或使用@Lazy注解。

---

#### 追问：
- 追问1：你举的CarbonChatService依赖CarbonLawIndex且后者又依赖前者的例子，如果两者都是构造器注入，三级缓存救不了会直接抛BeanCurrentlyInCreationException，但在实际碳管家项目里这种"互相需要对方才能完成实例化"的死锁，根因是设计问题还是Spring机制缺陷？
  - **答**：是设计问题。两者构造器互相需要对方完成实例化，三级缓存无法解决（三级缓存只救单例 setters/字段注入循环，构造器注入循环直接抛 BeanCurrentlyInCreationException）。
    - 根因是职责耦合：CarbonChatService 与 CarbonLawIndex 应是依赖而非互相拥有。应重构：提取共享依赖（如 EmbeddingService）让二者都依赖它而非互相依赖，从设计上消除循环。
- 追问2：三级缓存的ObjectFactory在获取早期引用时会调用getEarlyBeanReference，如果此时触发了提前AOP生成代理，而之后正常初始化阶段又因为某种原因没走postProcessAfterInitialization，会不会出现"二级缓存里的代理"和"最终应该进一级缓存的Bean"不是同一个对象？
  - **答**：不会不一致。earlyProxyReferences 记录已提前代理的 beanName，getEarlyBeanReference 生成早期代理放入二级缓存；后续正常初始化再走 postProcessAfterInitialization 时，因 earlyProxyReferences 已含该 beanName，AbstractAutoProxyCreator 跳过再次代理，返回早期代理。
    - 最终放入一级缓存的就是二级缓存里的那个代理对象，二者同一引用，不会分裂成两个不同对象。

### 30. 构造器循环依赖的解决方案
**重要度**：★★★★

**题目：**
请说明为什么Spring无法解决构造器循环依赖，并给出在碳管理AI项目中的解决方案（@Lazy、setter注入、重构设计）。

**解答：**
Spring三级缓存机制无法解决构造器循环依赖，根本原因是：构造器循环依赖发生在Bean的实例化阶段，而三级缓存的ObjectFactory是在实例化之后注册的。当A的构造方法需要B时，A还未完成实例化，无法将A的ObjectFactory注册到三级缓存，因此B无法获取A的早期引用，形成死锁。

具体过程：创建A→A构造方法需要B→创建B→B构造方法需要A→getBean("A")→一级缓存没有A→二级缓存没有A→三级缓存也没有A（A未实例化，ObjectFactory未注册）→抛出BeanCurrentlyInCreationException。

**解决方案：**

**方案1：@Lazy注解注入代理对象**
在构造器参数上标注@Lazy，Spring注入一个代理对象而非真实Bean，代理对象在第一次方法调用时触发真实Bean的创建。

```java
@Service
public class CarbonChatService {
    private final CarbonLawIndex lawIndex;

    // @Lazy注入代理对象，打破构造器循环依赖
    public CarbonChatService(@Lazy CarbonLawIndex lawIndex) {
        this.lawIndex = lawIndex;
    }

    public String chat(String question) {
        // 首次调用时触发CarbonLawIndex的真实初始化
        return lawIndex.search(question);
    }
}
```

**方案2：改为setter注入或字段注入**
将构造器注入改为setter/字段注入，使循环依赖发生在属性赋值阶段而非实例化阶段。

```java
@Service
public class CarbonLawIndex {
    @Autowired
    private CarbonChatService chatService; // 字段注入：发生在属性赋值阶段，三级缓存可解决（若用 setter 写法同理）

    public List<RetrievalResult> search(String query) {
        // 真实实现里会用 chatService 完成向量编码后再检索，这里用占位结果演示正确的返回类型
        return List.of(new RetrievalResult(query, 0.0, "STUB"));
    }
}
```

**方案3：引入中间层重构设计（推荐）**
将循环依赖的共通逻辑提取到第三方组件中，消除直接的循环依赖。

```java
// 重构前：CarbonChatService ←→ CarbonLawIndex 循环依赖
// 重构后：引入EmbeddingService作为中间层

@Service
public class EmbeddingService {
    // Spring AI 1.x：EmbeddingClient 已更名为 EmbeddingModel
    private final EmbeddingModel embeddingModel;

    public EmbeddingService(EmbeddingModel embeddingModel) {
        this.embeddingModel = embeddingModel;
    }

    public float[] embed(String text) {
        return embeddingModel.embed(text);
    }
}

@Service
public class CarbonChatService {
    private final EmbeddingService embeddingService;
    private final CarbonLawIndex lawIndex;

    // 不再直接依赖循环，通过EmbeddingService间接协作
    public CarbonChatService(EmbeddingService embeddingService, CarbonLawIndex lawIndex) {
        this.embeddingService = embeddingService;
        this.lawIndex = lawIndex;
    }
}

@Service
public class CarbonLawIndex {
    private final EmbeddingService embeddingService;

    public CarbonLawIndex(EmbeddingService embeddingService) {
        this.embeddingService = embeddingService;
    }

    public List<RetrievalResult> search(String query) {
        float[] vector = embeddingService.embed(query);
        return vectorStore.search(vector);
    }
}
```

**AI/碳管理场景关联：**
碳管家AI助手最初存在CarbonChatService与CarbonLawIndex的构造器循环依赖：ChatService需要LawIndex进行RAG检索，LawIndex需要ChatService的EmbeddingModel（旧名 EmbeddingClient）进行向量编码。采用方案3引入独立的EmbeddingService，将向量编码能力抽取为独立服务，CarbonChatService和CarbonLawIndex都依赖EmbeddingService而非互相依赖。重构后代码更符合单一职责原则，且EmbeddingService可独立复用（如碳排放数据的批量向量化任务也可使用）。

---

#### 追问：
- 追问1：你用@Lazy注入代理打破构造器循环依赖，但@Lazy代理是CGLIB生成的，CarbonLawIndex真正被调用search时才触发初始化，如果此时CarbonChatService已经因为别的原因在关闭，这次延迟初始化会拿到一个正在销毁的Bean吗？
  - **答**：可能。@Lazy 代理首次调用 search 时才真正初始化 CarbonLawIndex，若此时 ChatService 已在关闭/上下文销毁中，目标 Bean 可能已被销毁或不可用，延迟初始化会失败或拿到坏 Bean。
    - 防范：
      - ① 关闭期间禁止新调用（优雅停机先停接收请求）
      - ② @Lazy 目标 Bean 加状态检查，已销毁则快速失败
      - ③ 关键路径避免"临关闭才懒加载"
      - ④ SmartLifecycle 关闭前先停业务再销毁 Bean
- 追问2：方案3引入EmbeddingService中间层是最优解，但EmbeddingModel本身如果又依赖一个需要ChatService提供配置的组件，中间层会不会只是把循环依赖"下移"而不是真正消除？怎么判断拆分是否彻底？
  - **答**：可能只是下移。若 EmbeddingService 中间层依赖的组件又反过来需要 ChatService 提供的配置，循环从"ChatService↔LawIndex"变成"EmbeddingService↔某组件"，没真正消除。
    - 判断是否彻底：
      - ① 看拆分后是否还有任一边指向原循环任一端
      - ② 真正解法是提取"双方都需要的纯下层能力"（配置/客户端）作公共底座，上层单向依赖它
      - ③ 用依赖图检查无环
      - ④ 若无法彻底，暴露为接口+@Lazy，但优先重构而非绕开

### 31. 三级缓存与AOP代理的交互机制
**重要度**：★★★★

**题目：**
请详细说明当循环依赖遇到AOP代理时，Spring如何通过三级缓存确保代理对象的一致性，分析"提前AOP"的过程。

**解答：**
当Bean需要被AOP代理（如标注了@Aspect切面或匹配切点表达式）且同时存在循环依赖时，Spring需要确保循环依赖中注入的引用和最终容器中的Bean是同一个代理对象。这就是"提前AOP"的由来。

**正常AOP代理创建流程（无循环依赖）：**
1. Bean实例化→属性赋值→初始化→postProcessAfterInitialization→AbstractAutoProxyCreator创建AOP代理→代理对象放入一级缓存。
2. 其他Bean获取时得到代理对象，一切正常。

**循环依赖场景的AOP代理创建流程：**
当A依赖B，B依赖A，且A需要被AOP代理时：
1. A实例化后，注册ObjectFactory到三级缓存。ObjectFactory的getObject方法内部调用SmartInstantiationAwareBeanPostProcessor.getEarlyBeanReference。
2. A属性赋值时需要B，触发B的创建。
3. B属性赋值时需要A，从三级缓存获取A的ObjectFactory。
4. ObjectFactory.getObject()调用getEarlyBeanReference，此时AbstractAutoProxyCreator检查A是否需要代理，如果需要则创建AOP代理对象返回。这就是"提前AOP"。
5. AOP代理对象放入二级缓存earlySingletonObjects，三级缓存移除A的ObjectFactory。
6. B获得A的代理对象引用，完成初始化，B放入一级缓存。
7. A获得B的引用，完成属性赋值。
8. A进入初始化后阶段，AbstractAutoProxyCreator.postProcessAfterInitialization检查A是否已有早期代理（通过wrappedBean == bean判断），如果已经创建了早期代理，则不再重复创建，直接返回已有代理。
9. 最终一级缓存中的A是代理对象，B持有的也是同一个代理对象，一致性得到保证。

**关键代码分析：**

```java
// AbstractAutoProxyCreator
@Override
public Object getEarlyBeanReference(Object bean, String beanName) {
    Object cacheKey = getCacheKey(bean.getClass(), beanName);
    this.earlyProxyReferences.put(cacheKey, bean); // 记录已提前创建代理
    return wrapIfNecessary(bean, beanName, cacheKey); // 如果需要则创建代理
}

@Override
public Object postProcessAfterInitialization(Object bean, String beanName) {
    if (bean != null) {
        Object cacheKey = getCacheKey(bean.getClass(), beanName);
        // 如果已经提前创建了代理（earlyProxyReferences中有记录），
        // 则不再重复创建，直接返回原始bean
        // 此原始bean在外层会被替换为二级缓存中的代理对象
        if (this.earlyProxyReferences.remove(cacheKey) != bean) {
            return wrapIfNecessary(bean, beanName, cacheKey);
        }
    }
    return bean;
}
```

**为什么二级缓存中存的是代理而非原始对象？**
如果二级缓存存原始对象，B注入的是原始对象A，而一级缓存最终存的是代理对象A，导致B持有的A引用和容器中的A不是同一对象，后续A的AOP增强对B不可见。通过提前创建代理并存入二级缓存，确保B注入的就是代理对象A，与最终容器中的A一致。

**AI/碳管理场景关联：**
碳管家AI助手的CarbonChatService同时被AOP切面（用于Token计量和性能监控）和CarbonLawIndex循环依赖。Spring的提前AOP机制确保CarbonLawIndex注入的CarbonChatService引用就是被AiMeterAspect代理后的对象，后续CarbonLawIndex调用chatService.embed()时，Token计量切面能正常拦截。如果Spring不做提前AOP，CarbonLawIndex持有的是原始CarbonChatService，Token计量将失效。

---

#### 追问：
- 追问1：你说提前AOP确保CarbonLawIndex拿到的是被AiMeterAspect代理后的CarbonChatService，但如果AiMeterAspect本身也是个Bean，它的初始化又依赖CarbonChatService（为了拿到MeterRegistry之外的东西），这不就形成了"切面依赖目标Bean"的新循环吗？Spring怎么处理这种切面自身的循环？
  - **答**：这个说法要更正——`AbstractAutoProxyCreator` 确实在 `postProcessAfterInitialization` 才织入（这是正常路径），但循环依赖场景下走的是另一个入口：`getEarlyBeanReference` 在属性注入阶段就提前把代理建好。所以"切面依赖目标 Bean"这条链在 setter 注入下**可能**被容忍（切面拿到的可能是目标 Bean 的早期引用甚至原始对象），在**构造器注入下会直接 BeanCurrentlyInCreationException**；而且 Boot 2.6+ 默认 `spring.main.allow-circular-references=false`，这类结构默认启动就失败，别指望三级缓存兜住。
    - 正解是断掉这条依赖：切面不要依赖业务 Bean（需要计量就注入 MeterRegistry，需要租户上下文就用 ThreadLocal/上下文传递），切面保持无状态。
- 追问2：earlyProxyReferences用bean引用做key判断"是否已经提前代理过"，如果同一个类被两个不同的ObjectFactory各生成一次早期引用（如多实例场景），这个map的key碰撞会不会导致其中一个代理被错误跳过？
  - **答**：不会错误跳过。earlyProxyReferences 是 Map<String,Object>（key=beanName），同一 beanName 只会有一个早期引用；多实例（同类型多个 Bean）各有不同 beanName，key 不碰撞。
    - 即使两个 ObjectFactory 各生成一次早期引用，也是不同 beanName 分别对应，互不干扰；只有同一 beanName 重复获取早期引用才命中缓存（预期行为，避免重复代理）。key 用 beanName 安全。

### 32. 循环依赖的风险与最佳实践
**重要度**：★★★★

**题目：**
请说明循环依赖对AI项目的潜在风险，Spring Boot 2.6+默认禁止循环依赖的影响，以及在碳管理项目中的最佳实践。

**解答：**
循环依赖虽然被Spring三级缓存机制解决（setter注入场景），但仍然存在多方面风险：

**风险1：设计异味**。循环依赖通常意味着模块职责划分不当，两个类承担了过多职责且边界不清。长期积累会导致代码难以维护和测试。

**风险2：初始化顺序敏感**。虽然三级缓存解决了引用问题，但Bean的初始化顺序不确定可能导致NPE。例如A的@PostConstruct中使用B的某个属性，但B此时可能还未完全初始化。

**风险3：代理一致性风险**。在复杂的AOP+循环依赖场景中，如果BeanPostProcessor处理顺序异常，可能导致不同位置获取的Bean引用不一致。

**风险4：测试困难**。循环依赖使得单元测试时难以Mock单个Bean，必须同时初始化两个Bean。

**Spring Boot 2.6+的变化**：
从Spring Boot 2.6开始，spring.main.allow-circular-references默认为false，循环依赖会直接报错启动失败。这一变更旨在引导开发者消除循环依赖而非依赖框架的兜底机制。可以通过配置spring.main.allow-circular-references=true恢复旧行为，但不推荐。

**最佳实践：**

1. **引入中间层**：将循环依赖的共通逻辑提取到第三方服务中。
2. **使用事件机制解耦**：通过ApplicationEvent发布事件替代直接方法调用。
3. **使用@Lazy作为临时方案**：在无法立即重构时使用@Lazy打破循环。
4. **接口隔离**：定义接口作为中介，实现依赖倒置。
5. **设计时遵循单向依赖原则**：模块A依赖模块B，则B不应反向依赖A。

```java
// 碳管理项目中的循环依赖消除实践

// 反模式：CarbonChatService ←→ CarbonReportService 循环依赖
// ChatService需要ReportService获取报告数据进行问答
// ReportService需要ChatService生成报告摘要

// 正确做法：引入CarbonDataAccessService中间层
@Service
public class CarbonDataAccessService {
    private final CarbonReportRepository reportRepo;
    private final EmissionDataRepository emissionRepo;

    public CarbonReport getReport(Long reportId) { return reportRepo.findById(reportId); }
    public List<EmissionData> getEmissionData(Long orgId) { return emissionRepo.findByOrgId(orgId); }
}

@Service
public class CarbonChatService {
    private final CarbonDataAccessService dataAccessService; // 依赖数据访问层而非ReportService
    private final ChatClient chatClient;

    public String chat(Long tenantId, String question) {
        List<EmissionData> data = dataAccessService.getEmissionData(tenantId);
        // 使用数据+问题调用AI
        return chatClient.prompt(buildPrompt(question, data)).call().content();
    }
}

@Service
public class CarbonReportService {
    private final CarbonDataAccessService dataAccessService;
    private final ChatClient chatClient; // 直接依赖ChatClient而非ChatService

    public CarbonReport generateReport(Long orgId) {
        List<EmissionData> data = dataAccessService.getEmissionData(orgId);
        String summary = chatClient.prompt(buildReportPrompt(data)).call().content();
        return new CarbonReport(data, summary);
    }
}
```

**AI/碳管理场景关联：**
碳管家AI助手在初期开发中出现了多处循环依赖（ChatService↔ReportService、ChatService↔LawIndexService等）。团队在Spring Boot 2.6升级时决定彻底消除循环依赖：引入CarbonDataAccessService作为数据访问中间层，ChatService和ReportService都依赖数据访问层而非互相依赖；通过事件机制实现ChatService生成回答后发布CarbonAiChatEvent，ReportService监听该事件异步生成报告。重构后代码可测试性大幅提升，单元测试中可以独立Mock数据访问层测试ChatService和ReportService。

---

#### 追问：
- 追问1：Spring Boot 2.6默认禁用了循环依赖，如果碳管家AI助手升级后CI直接启动失败报循环依赖，团队是应该立刻配allow-circular-references=true蒙混过关，还是借机做你提到的中间层重构？二者在长期维护成本上差多少？
  - **答**：应借机重构而非 allow-circular-references=true。允许循环依赖只是把设计债藏起来，长期维护成本更高：隐式耦合难测试难理解、阻碍升级（Spring 未来可能彻底移除）。
    - 重构为中间层/事件/接口，短期有成本但长期可维护性、可测试性更好。仅在极端紧急且重构风险高时临时开启并立技术债单跟踪，不应作永久方案。
- 追问2：你用事件机制让ChatService发CarbonAiChatEvent、ReportService监听来消除ChatService↔ReportService循环，但事件本质是"解耦"也意味着"隐式依赖"，新人接手时如何得知"改了ChatService的回答结构会影响ReportService的生成"，这种隐性耦合怎么通过文档或契约测试暴露？
  - **答**：用文档 + 契约测试暴露。
    - ① 领域事件定义处写明"发布时机、影响哪些监听者"，@EventListener 列清单
    - ② 事件 payload 用强类型 DTO，配契约测试（Pact/Spring Contract）验证发布方与消费方对事件结构的约定
    - ③ CI 检测"修改 ChatService 回答结构"是否破坏 ReportService 消费契约
    - ④ 架构图/ADR 记录事件依赖
    - ⑤ 监控消费失败告警

#### 九、Spring 扩展点

### 33. BeanPostProcessor扩展点详解
**重要度**：★★★

**题目：**
请详细说明BeanPostProcessor的扩展能力，列举Spring内部常用的BeanPostProcessor实现及其作用，并设计一个自定义BeanPostProcessor用于碳管理AI服务的配置校验。

**解答：**
BeanPostProcessor是Spring最核心的扩展点，在Bean初始化前后提供拦截能力。Spring框架自身大量使用BeanPostProcessor实现框架级功能：

**Spring内置BeanPostProcessor：**
- AutowiredAnnotationBeanPostProcessor：处理@Autowired和@Value注解，完成依赖注入。
- CommonAnnotationBeanPostProcessor：处理@PostConstruct、@PreDestroy、@Resource注解。
- AbstractAutoProxyCreator（AspectJAwareAdvisorAutoProxyCreator）：AOP代理创建器，在postProcessAfterInitialization阶段创建代理对象。
- ScheduledAnnotationBeanPostProcessor：处理@Scheduled注解，注册定时任务。
- AsyncAnnotationBeanPostProcessor：处理@Async注解，创建异步代理。
- MethodValidationPostProcessor：处理@Validated注解，创建校验代理。

**易混淆：BeanFactoryPostProcessor（BFPP）不属于 BeanPostProcessor：**
- BeanDefinitionRegistryPostProcessor / BeanFactoryPostProcessor：ConfigurationClassPostProcessor（解析@Configuration、@Bean、@ComponentScan，是自动装配的入口）、PropertySourcesPlaceholderConfigurer（解析${}占位符）。
- 它们在**容器启动早期**、任何 Bean 实例化之前运行，只改 BeanDefinition，**不参与** postProcessBeforeInitialization / postProcessAfterInitialization。
- 对照：BFPP 改的是"Bean 的定义"（容器启动早期，一次）；BPP 改的是"Bean 的实例"（每个 Bean 实例化时，各一次）。两者时机完全不同，别混在一个清单里。

**自定义BeanPostProcessor实现AI配置校验：**

```java
// 自定义注解：标记需要配置校验的AI服务
@Target(ElementType.TYPE)
@Retention(RetentionPolicy.RUNTIME)
public @interface CarbonAiConfig {
    String[] requiredProperties();
}

// 自定义BeanPostProcessor
// 注意：BPP 会被容器"过早"实例化，字段注入 @Autowired Environment 时 AutowiredAnnotationBeanPostProcessor
// 可能还没注册，会打出 "is not eligible for getting processed by all BeanPostProcessors" 警告甚至注入不到。
// 所以用构造器注入（或实现 EnvironmentAware）
@Slf4j
@Component
public class CarbonAiConfigValidatorPostProcessor implements BeanPostProcessor, Ordered {

    private final Environment environment;

    public CarbonAiConfigValidatorPostProcessor(Environment environment) {
        this.environment = environment;
    }

    @Override
    public Object postProcessBeforeInitialization(Object bean, String beanName) {
        CarbonAiConfig annotation = AnnotationUtils.findAnnotation(bean.getClass(), CarbonAiConfig.class);
        if (annotation != null) {
            validateConfig(bean, annotation);
        }
        return bean;
    }

    private void validateConfig(Object bean, CarbonAiConfig config) {
        List<String> missingProps = new ArrayList<>();
        for (String prop : config.requiredProperties()) {
            if (!environment.containsProperty(prop) ||
                StringUtils.isBlank(environment.getProperty(prop))) {
                missingProps.add(prop);
            }
        }
        if (!missingProps.isEmpty()) {
            throw new BeanInitializationException(String.format(
                "碳管家AI服务[%s]缺少必要配置项: %s。请在application.yml中配置这些属性。",
                bean.getClass().getSimpleName(), String.join(", ", missingProps)));
        }

        // 校验API Key格式
        String apiKey = environment.getProperty("carbon.ai.llm.api-key");
        if (apiKey != null && apiKey.isBlank()) {
            log.warn("大模型 API Key 配置为空字符串，请检查 Vault 是否成功注入");
        }

        // 校验Milvus连接配置
        String milvusHost = environment.getProperty("carbon.ai.milvus.host");
        Integer milvusPort = environment.getProperty("carbon.ai.milvus.port", Integer.class);
        if (milvusHost != null && (milvusPort == null || milvusPort < 1 || milvusPort > 65535)) {
            throw new BeanInitializationException(
                "Milvus端口配置无效: " + milvusPort);
        }
    }

    @Override
    public Object postProcessAfterInitialization(Object bean, String beanName) {
        return bean;
    }

    @Override
    public int getOrder() {
        // 配置校验要尽量早拿到"原始 Bean"：放到最低优先级会被其他 BPP 先包上代理，校验对象已不是原始实例
        return Ordered.HIGHEST_PRECEDENCE + 1; // +1 让容器自身的内建 BPP 先就位
    }
}

// 使用：标记需要配置校验的AI服务
@Service
@CarbonAiConfig(requiredProperties = {
    "carbon.ai.llm.api-key",
    "carbon.ai.llm.model",
    "carbon.ai.milvus.host",
    "carbon.ai.milvus.port"
})
public class CarbonChatService {
    // 如果缺少任何requiredProperties，容器启动时直接报错
    // fail-fast，避免运行时才发现配置缺失
}
```

**AI/碳管理场景关联：**
碳管家AI助手通过CarbonAiConfigValidatorPostProcessor实现fail-fast配置校验：当CarbonChatService、CarbonLawIndex等AI核心服务缺少必要的配置项（如大模型 API Key、Milvus连接信息）时，应用在启动阶段直接报错并列出缺失的配置项，而非运行时首次调用AI功能时才暴露问题。这大幅缩短了配置问题的发现周期，在CI/CD流水线中部署后立即发现问题而非等待用户使用时才发现。

---

#### 追问：
- 追问1：你的CarbonAiConfigValidatorPostProcessor在postProcessBeforeInitialization里做fail-fast配置校验，但如果某个AI Bean是通过@Lazy延迟初始化的，这个校验是在应用启动时就执行，还是拖到第一次调用AI时才因缺配置而报错？fail-fast还成立吗？
  - **答**：拖到首次调用才报错。BeanPostProcessor 启动期对所有 BeanDefinition 执行校验（含 @Lazy Bean 定义），但 @Lazy Bean 实际初始化发生在首次使用，若缺配置 fail-fast 在首次调用 AI 时才抛错，启动不失败。
    - 影响：fail-fast 时机后移，首用户在高峰期踩雷。改进：
      - ① 关键 AI Bean 不用 @Lazy，启动即校验
      - ② 用 SmartInitializingSingleton/ContextRefreshedEvent 刷新后主动触发一次校验/预热，把失败提前到启动期
- 追问2：你列举了多个内置BeanPostProcessor，如果团队自己写的配置校验处理器和另一个第三方starter的校验处理器都实现了Ordered且order值相同，它们的执行顺序由什么决定？会不会出现"对方先改了Bean导致我校验不到原始状态"？
  - **答**：order 相同则由注册顺序（默认按 Bean 定义/扫描顺序）决定，Spring 不保证跨环境稳定。风险：若对方 BPP 先改了 Bean（如包了代理），我校验到的已是被改对象，可能漏检原始状态。
    - 规避：
      - ① 明确设不同 Ordered 值，让配置校验处理器排极早（最高优先级）拿原始 Bean
      - ② 校验处理器尽量只读取不修改 Bean
      - ③ 用 @Order 小值确保先于业务 BPP
      - ④ 写集成测试验证

### 34. BeanFactoryPostProcessor与BeanDefinitionRegistryPostProcessor
**重要度**：★★★★

**题目：**
请说明BeanFactoryPostProcessor和BeanDefinitionRegistryPostProcessor的作用、执行时机，以及在碳管理项目中动态注册AI服务Bean的应用。

**解答：**
BeanFactoryPostProcessor是Spring容器级的扩展点，在容器加载所有BeanDefinition之后、Bean实例化之前执行，允许修改或添加BeanDefinition。与BeanPostProcessor作用于Bean实例不同，BeanFactoryPostProcessor作用于Bean的元数据（BeanDefinition）。

BeanDefinitionRegistryPostProcessor是BeanFactoryPostProcessor的子接口，额外提供postProcessBeanDefinitionRegistry方法，允许在BeanDefinition注册阶段动态注册新的BeanDefinition。执行时机早于BeanFactoryPostProcessor。

**执行顺序：**
1. BeanDefinitionRegistryPostProcessor.postProcessBeanDefinitionRegistry（按PriorityOrdered→Ordered→无序依次执行）
2. BeanFactoryPostProcessor.postProcessBeanFactory（按PriorityOrdered→Ordered→无序依次执行）
3. Bean实例化→BeanPostProcessor介入

**动态注册AI服务Bean的应用：**

```java
@Component
public class DynamicAiServiceRegistrar implements BeanDefinitionRegistryPostProcessor, PriorityOrdered {

    @Override
    public void postProcessBeanDefinitionRegistry(BeanDefinitionRegistry registry) {
        // 1. 根据配置动态注册不同AI模型的ChatClient Bean
        // 例如：同时注册通义千问、DeepSeek、自部署GLM 三家 ChatClient

        // 注册通义千问 ChatClient
        GenericBeanDefinition qwenDefinition = new GenericBeanDefinition();
        qwenDefinition.setBeanClass(QwenChatClient.class);
        qwenDefinition.getPropertyValues().add("apiKey", "${carbon.ai.qwen.api-key}");
        qwenDefinition.getPropertyValues().add("model", "qwen-max");
        registry.registerBeanDefinition("qwenChatClient", qwenDefinition);

        // 注册 DeepSeek ChatClient（备模型）
        GenericBeanDefinition deepSeekDefinition = new GenericBeanDefinition();
        deepSeekDefinition.setBeanClass(DeepSeekChatClient.class);
        deepSeekDefinition.getPropertyValues().add("apiKey", "${carbon.ai.deepseek.api-key}");
        deepSeekDefinition.getPropertyValues().add("model", "deepseek-chat");
        registry.registerBeanDefinition("deepSeekChatClient", deepSeekDefinition);

        // 注册自部署 GLM ChatClient（本地降级，走 vLLM OpenAI 兼容端点）
        GenericBeanDefinition glmDefinition = new GenericBeanDefinition();
        glmDefinition.setBeanClass(GlmChatClient.class);
        glmDefinition.getPropertyValues().add("apiKey", "${carbon.ai.glm.api-key}");
        glmDefinition.getPropertyValues().add("model", "glm-4");
        registry.registerBeanDefinition("glmChatClient", glmDefinition);

        // 2. 动态注册碳法规知识库的VectorStore Bean
        // 根据租户数量动态注册多个VectorStore
        String[] tenants = System.getProperty("carbon.ai.tenants", "default").split(",");
        for (String tenant : tenants) {
            GenericBeanDefinition vsDefinition = new GenericBeanDefinition();
            vsDefinition.setBeanClass(TenantMilvusVectorStore.class);
            vsDefinition.getPropertyValues().add("collectionName", "carbon_law_" + tenant);
            vsDefinition.getPropertyValues().add("milvusClient", ref("milvusClient"));
            registry.registerBeanDefinition("vectorStore_" + tenant, vsDefinition);
        }

        log.info("动态注册了{}个AI服务BeanDefinition", tenants.length + 1);
    }

    @Override
    public void postProcessBeanFactory(ConfigurableListableBeanFactory beanFactory) {
        // 可以修改已注册的BeanDefinition
        // 例如：为所有AI服务Bean添加initMethod
        for (String beanName : beanFactory.getBeanDefinitionNames()) {
            BeanDefinition bd = beanFactory.getBeanDefinition(beanName);
            if (bd.getBeanClassName() != null &&
                bd.getBeanClassName().contains("CarbonAi")) {
                bd.setInitMethodName("initialize");
                bd.setDestroyMethodName("cleanup");
            }
        }
    }

    @Override
    public int getOrder() {
        return Ordered.HIGHEST_PRECEDENCE;
    }
}
```

**AI/碳管理场景关联：**
积木LCA云平台支持多AI模型切换和租户级知识库隔离。通过BeanDefinitionRegistryPostProcessor，平台在启动时根据配置动态注册不同模型的ChatClient Bean（通义千问、DeepSeek、自部署GLM 等），并按租户注册独立的Milvus VectorStore Bean（每个租户使用独立的collection）。**注意注解属性值必须是编译期常量，`@Qualifier("vectorStore_" + tenantId)` 这种写法编译不过**，正确做法是注入 `Map<String, VectorStore>`（key 即 beanName）按租户 key 取，或用 ObjectProvider/FactoryBean 按租户懒创建。另外这也**不支持**运行时新增租户：数据源/Bean 路由表是启动时固定的，新开租户要么重启生效，要么换动态数据源框架（如 dynamic-datasource 的 addDataSource）或在共享 VectorStore 上按 tenantId 做 partition/路由。

---

#### 追问：
- 追问1：你按租户动态注册独立的Milvus VectorStore Bean（vectorStore_租户ID），但如果租户是在运行中通过管理后台新开通的，BeanDefinitionRegistryPostProcessor只在启动时执行一次，运行时新增租户还能动态注册吗？还是需要改造成运行时用BeanDefinitionRegistry手动注册并刷新生命周期？
  - **答**：不能动态注册。BeanDefinitionRegistryPostProcessor 仅在容器刷新（启动）时执行一次，运行中新开租户无法靠它注册新 VectorStore Bean。
    - 动态方案：
      - ① 运行时用 ConfigurableApplicationContext.getBeanFactory().registerSingleton(beanName, instance) 手动注册已构建好的 Bean
      - ② 或不用"每租户一个 Bean"，改为每租户一个配置对象 + 共享 VectorStore 按 tenantId 路由
      - ③ 用 FactoryBean/ObjectProvider 按租户懒创建
- 追问2：你在postProcessBeanFactory里遍历所有BeanDefinition给类名含"CarbonAi"的Bean强行setInitMethodName("initialize")，如果某个CarbonAi开头的Bean并没有initialize方法，这个强行设置会在启动还是首次getBean时报NoSuchMethod错误？范围误伤怎么避免？
  - **答**：设置 initMethodName 本身不校验方法存在，真正调用在 Bean 初始化阶段（invokeCustomInitMethod）。找不到方法时它会捕获 NoSuchMethodException 并抛 **BeanDefinitionValidationException**（"Could not find an init method named ..."），既不是 NoSuchMethodError 也不是 IllegalStateException；而且这一步发生在 refresh 期间，**启动就会失败**，不是"首次 getBean 才报"。
    - 范围误伤：
      - ① 先判断 BeanDefinition 是否真有 initialize 方法（反射 hasMethod）再设置
      - ② 用 @PostConstruct/InitializingBean 替代"按名强制"
      - ③ 缩小匹配范围（精确类名/注解而非前缀），避免误伤非 AI Bean

### 35. ApplicationContextAware与EnvironmentAware等Aware接口
**重要度**：★★★

**题目：**
请说明Spring的Aware接口体系，包括ApplicationContextAware、EnvironmentAware、BeanNameAware等，并设计一个碳管理AI配置管理器利用这些Aware接口。

**解答：**
Spring的Aware接口是一组标记接口，实现它们的Bean在初始化阶段会获得Spring容器内部组件的引用。但**回调入口有两个，不能混为一谈**：

- **`AbstractAutowireCapableBeanFactory.invokeAwareMethods()`**：在 Bean 属性填充之后、所有 BeanPostProcessor 回调**之前**直接调用，负责三个最基础的接口——`BeanNameAware`、`BeanClassLoaderAware`、`BeanFactoryAware`。这三个**不经过** `ApplicationContextAwareProcessor`。
- **`ApplicationContextAwareProcessor`（一个 BeanPostProcessor）**：在 `postProcessBeforeInitialization` 阶段负责容器级接口——`EnvironmentAware`、`EmbeddedValueResolverAware`、`ResourceLoaderAware`、`ApplicationEventPublisherAware`、`MessageSourceAware`、`ApplicationContextAware` 这 6 个。

所以顺序是：invokeAwareMethods（BeanName/BeanClassLoader/BeanFactory）→ 各类 BPP 的 before → init 方法 → BPP 的 after。答"所有 Aware 都由 ApplicationContextAwareProcessor 处理"是错的。

**常见Aware接口：**
- BeanNameAware.setBeanName：获取Bean在容器中的名称（invokeAwareMethods 调用）。
- BeanClassLoaderAware.setBeanClassLoader：获取类加载器（invokeAwareMethods 调用）。
- BeanFactoryAware.setBeanFactory：获取BeanFactory引用（invokeAwareMethods 调用）。
- EnvironmentAware.setEnvironment：获取Environment对象，可读取配置（ApplicationContextAwareProcessor 调用）。
- ApplicationContextAware.setApplicationContext：获取ApplicationContext，可访问所有容器功能（ApplicationContextAwareProcessor 调用）。
- ResourceLoaderAware.setResourceLoader：获取资源加载器（ApplicationContextAwareProcessor 调用）。
- ApplicationEventPublisherAware.setApplicationEventPublisher：获取事件发布器（ApplicationContextAwareProcessor 调用）。
- MessageSourceAware.setMessageSource：获取国际化消息源（ApplicationContextAwareProcessor 调用）。
- EmbeddedValueResolverAware.setEmbeddedValueResolver：获取占位符解析器（ApplicationContextAwareProcessor 调用）。

**碳管理AI配置管理器：**

```java
@Component
@Slf4j
public class CarbonAiConfigManager implements EnvironmentAware,
        ApplicationContextAware, ApplicationEventPublisherAware {

    private Environment environment;
    private ApplicationContext applicationContext;
    private ApplicationEventPublisher eventPublisher;

    // 缓存AI配置，支持动态刷新
    private volatile CarbonAiConfig config;
    private final Map<String, Object> dynamicConfigCache = new ConcurrentHashMap<>();

    @Override
    public void setEnvironment(Environment environment) {
        this.environment = environment;
        log.info("EnvironmentAware: 获取Environment引用");
        // 初始化时加载配置
        loadConfig();
    }

    @Override
    public void setApplicationContext(ApplicationContext applicationContext) {
        this.applicationContext = applicationContext;
        log.info("ApplicationContextAware: 获取ApplicationContext引用");
        // 注册配置变更监听
        applicationContext.addApplicationListener(
            (ApplicationListener<EnvironmentChangeEvent>) event -> {
                log.info("收到环境变更事件，重新加载AI配置");
                loadConfig();
                eventPublisher.publishEvent(new AiConfigRefreshedEvent(config));
            });
    }

    @Override
    public void setApplicationEventPublisher(ApplicationEventPublisher eventPublisher) {
        this.eventPublisher = eventPublisher;
    }

    private void loadConfig() {
        CarbonAiConfig newConfig = new CarbonAiConfig();
        newConfig.setApiKey(environment.getProperty("carbon.ai.llm.api-key"));
        newConfig.setModel(environment.getProperty("carbon.ai.llm.model", "qwen-max"));
        newConfig.setMaxTokens(environment.getProperty("carbon.ai.max-tokens", Integer.class, 4096));
        newConfig.setTemperature(environment.getProperty("carbon.ai.temperature", Double.class, 0.7));

        // 从Environment中读取Milvus配置
        newConfig.setMilvusHost(environment.getProperty("carbon.ai.milvus.host", "localhost"));
        newConfig.setMilvusPort(environment.getProperty("carbon.ai.milvus.port", Integer.class, 19530));

        // 验证配置完整性
        if (newConfig.getApiKey() == null) {
            log.warn("大模型 API Key 未配置，碳管家AI助手将无法使用");
        }

        this.config = newConfig;
        log.info("AI配置加载完成: model={}, maxTokens={}",
            config.getModel(), config.getMaxTokens());
    }

    // 获取当前AI配置
    public CarbonAiConfig getConfig() {
        return config;
    }

    // 动态获取配置值（支持占位符解析）
    public String resolveConfig(String key) {
        return dynamicConfigCache.computeIfAbsent(key, k -> {
            // 通过ApplicationContext获取配置值
            return environment.getProperty(k);
        });
    }

    // 通过ApplicationContext获取其他Bean（避免循环依赖）
    public <T> T getBean(Class<T> beanType) {
        return applicationContext.getBean(beanType);
    }

    // 发布配置变更事件
    public void publishConfigChange() {
        eventPublisher.publishEvent(new AiConfigRefreshedEvent(config));
    }
}

// 配置变更事件
public record AiConfigRefreshedEvent(CarbonAiConfig config) {}
```

**AI/碳管理场景关联：**
碳管家AI助手的CarbonAiConfigManager通过Aware接口获取Spring容器内部组件：Environment用于读取AI模型配置（API Key、模型名称、Token限制等），ApplicationContext用于动态获取其他Bean（避免循环依赖），ApplicationEventPublisher用于在配置变更时通知所有AI服务重新加载配置。当运维人员通过配置中心修改了模型参数（如将通义千问 qwen-max 切换为 DeepSeek 以降低成本），ConfigManager收到环境变更事件后重新加载配置并发布AiConfigRefreshedEvent，各AI服务监听该事件热更新ChatClient参数，无需重启应用。

---

#### 追问：
- 追问1：你的CarbonAiConfigManager监听EnvironmentChangeEvent做配置热刷新，但如果刷新的瞬间正好有请求在用旧的model/temperature配置调用大模型，配置切换是立即对新旧请求都生效还是会"撕裂"一次调用的上下文？
  - **答**：会撕裂。配置切换瞬间，已在执行的老请求可能前半用旧 model/温度、后半用新值（若调用中两次读配置），一次调用上下文不一致。
    - 缓解：
      - ① 配置读取在请求开始时快照一次（拷到局部变量/请求上下文），整个调用用同一快照
      - ② 或用 @RefreshScope 让 Bean 下次请求才换新实例，进行中请求仍用旧
      - ③ 配置变更语义即"新请求生效"，明确文档化，避免中途切换
- 追问2：通过ApplicationContextAware拿到ApplicationContext后如果缓存起来长期持有，在Spring Boot热重启（如DevTools重启类加载器）场景下，这个旧ApplicationContext引用会不会造成类加载器泄漏，old generation里堆着两个版本的CarbonAi类？
  - **答**：会泄漏。DevTools 用独立类加载器重启，若缓存旧 ApplicationContext 引用，旧 context 持有 Bean/类不被卸载，Metaspace 堆积两个版本 CarbonAi 类，导致膨胀甚至 OOM。
    - 避免：
      - ① 不长期缓存 ApplicationContext，需要时从 Spring 注入或短生命周期获取
      - ② 监听 ContextClosedEvent 清空缓存引用
      - ③ DevTools 仅开发用，生产不用热重启
      - ④ 用弱引用持有

### 36. Spring其他扩展点：ImportSelector、ImportBeanDefinitionRegistrar与FactoryBean
**重要度**：★★★

**题目：**
请说明ImportSelector、ImportBeanDefinitionRegistrar和FactoryBean三种扩展点的原理与区别，并给出碳管理AI项目中各自的应用示例。

**解答：**
这三种扩展点都用于动态注册或创建Bean，但介入时机和能力不同：

**ImportSelector：** 通过@Import引入，selectImports方法返回需要导入的配置类的全限定名数组。Spring Boot的自动装配核心AutoConfigurationImportSelector就是此机制。适合基于条件选择导入一组预定义的配置类。执行时机在BeanDefinition注册阶段。

**ImportBeanDefinitionRegistrar：** 通过@Import引入，registerBeanDefinitions方法直接操作BeanDefinitionRegistry，可以编程式注册任意BeanDefinition。比ImportSelector更灵活，可以动态创建Bean定义而非仅选择已有配置类。MyBatis的@MapperScan和Feign的@EnableFeignClients都使用此机制。

**FactoryBean：** 一种特殊的Bean，getObject方法返回实际的对象实例。当通过getBean("factoryBeanName")获取时返回FactoryBean.getObject()的结果，通过getBean("&factoryBeanName")获取FactoryBean本身。适合创建逻辑复杂的Bean，如MyBatis的MapperFactoryBean、Spring AOP的ProxyFactoryBean。

```java
// 1. ImportSelector：根据配置选择AI模型配置类
public class CarbonAiModelSelector implements ImportSelector {
    @Override
    public String[] selectImports(AnnotationMetadata metadata) {
        String provider = System.getProperty("carbon.ai.provider", "openai");
        return switch (provider) {
            case "openai" -> new String[]{OpenAiModelConfig.class.getName()};
            case "azure" -> new String[]{AzureModelConfig.class.getName()};
            case "local" -> new String[]{LocalModelConfig.class.getName()};
            default -> new String[]{OpenAiModelConfig.class.getName()};
        };
    }
}

// 【必须】没有 @Retention(RUNTIME)，注解默认 CLASS 保留，运行时读不到 @Import，ImportSelector 不会触发
@Retention(RetentionPolicy.RUNTIME)
@Target(ElementType.TYPE)
@Import(CarbonAiModelSelector.class)
public @interface EnableCarbonAi {
}

// 2. ImportBeanDefinitionRegistrar：动态注册AI服务Bean
public class CarbonAiServiceRegistrar implements ImportBeanDefinitionRegistrar {

    @Override
    public void registerBeanDefinitions(AnnotationMetadata metadata,
            BeanDefinitionRegistry registry) {
        // 扫描指定包下的AI服务接口，动态注册为Bean
        Map<String, Object> attrs = metadata.getAnnotationAttributes(EnableCarbonAiServices.class.getName());
        String[] basePackages = (String[]) attrs.get("basePackages");

        ClassPathScanningCandidateComponentProvider scanner =
            new ClassPathScanningCandidateComponentProvider(false) {
            @Override
            protected boolean isCandidateComponent(AnnotatedBeanDefinition bd) {
                return bd.getMetadata().isInterface(); // 只扫描接口
            }
        };
        scanner.addIncludeFilter(new AnnotationTypeFilter(AiService.class));

        for (String pkg : basePackages) {
            for (BeanDefinition bd : scanner.findCandidateComponents(pkg)) {
                String className = bd.getBeanClassName();
                // 为每个AI服务接口注册FactoryBean
                GenericBeanDefinition beanDef = new GenericBeanDefinition();
                beanDef.setBeanClass(CarbonAiServiceFactoryBean.class);
                beanDef.getConstructorArgumentValues().addGenericArgumentValue(className);
                registry.registerBeanDefinition(
                    StringUtils.uncapitalize(className.substring(className.lastIndexOf('.') + 1)),
                    beanDef);
            }
        }
    }
}

@Retention(RetentionPolicy.RUNTIME)
@Target(ElementType.TYPE)
@Import(CarbonAiServiceRegistrar.class)
public @interface EnableCarbonAiServices {
    String[] basePackages();
}

// 3. FactoryBean：创建AI服务代理
public class CarbonAiServiceFactoryBean<T> implements FactoryBean<T> {

    private Class<T> serviceInterface;

    public CarbonAiServiceFactoryBean(Class<T> serviceInterface) {
        this.serviceInterface = serviceInterface;
    }

    @Override
    public T getObject() {
        // 创建JDK动态代理，将方法调用转发到AI ChatClient
        return (T) Proxy.newProxyInstance(
            serviceInterface.getClassLoader(),
            new Class[]{serviceInterface},
            (proxy, method, args) -> {
                // 从方法注解提取Prompt模板
                AiPrompt aiPrompt = method.getAnnotation(AiPrompt.class);
                String promptTemplate = aiPrompt.value();

                // 构建完整Prompt并调用ChatClient
                String prompt = buildPrompt(promptTemplate, args, method);
                ChatClient client = ApplicationContextHolder.getBean(ChatClient.class);
                return client.prompt(prompt).call().content();
            });
    }

    @Override
    public Class<?> getObjectType() {
        return serviceInterface;
    }

    @Override
    public boolean isSingleton() {
        return true;
    }
}

// 使用方式：声明AI服务接口，自动生成代理实现
@AiService
public interface CarbonLawQueryService {

    @AiPrompt("根据以下碳排放数据，判断是否符合{standard}标准的碳法规要求：{data}")
    String checkCompliance(String data, String standard);

    @AiPrompt("请将以下碳排放报告翻译为{language}语言：{report}")
    String translateReport(String report, String language);
}

// 启动类
@SpringBootApplication
@EnableCarbonAiServices(basePackages = "com.carbon.ai.service")
public class CarbonApplication { }
```

调用时直接注入接口即可使用，无需手写实现类：
```java
@RestController
public class CarbonLawController {
    @Autowired
    private CarbonLawQueryService lawQueryService; // 自动注入FactoryBean生成的代理

    @PostMapping("/check")
    public String check(@RequestBody CarbonData data, String standard) {
        return lawQueryService.checkCompliance(data.toJson(), standard);
    }
}
```

**AI/碳管理场景关联：**
通过三种扩展点的组合使用，碳管家AI助手实现了声明式AI服务开发：@EnableCarbonAi通过ImportSelector根据配置选择AI模型提供商；@EnableCarbonAiServices通过ImportBeanDefinitionRegistrar扫描@AiService接口并注册FactoryBean；CarbonAiServiceFactoryBean通过JDK动态代理将接口方法调用转发到ChatClient，开发者只需在接口方法上用@AiPrompt声明Prompt模板即可获得AI能力。这大幅降低了AI服务的开发门槛，碳管理业务开发人员无需了解Spring AI和LangChain4j的API细节，只需定义接口和Prompt即可。

---

#### 追问：
- 追问1：ImportBeanDefinitionRegistrar 注册 FactoryBean 时，若同一 @AiService 接口被 @EnableCarbonAiServices 重复扫描或产生同名 BeanDefinition，Spring 会覆盖还是抛冲突异常，碳管家如何避免？
  - **答**：默认后者覆盖前者（allowBeanDefinitionOverriding=true 时），否则抛 ConflictingBeanDefinitionException；Spring Boot 2.1+ 默认禁用覆盖→抛异常。
    - 碳管家避免：
      - ① 给每个 @AiService 接口生成唯一 beanName（接口名+qualifier）
      - ② registrar 注册前先检查 registry.containsBeanDefinition 去重
      - ③ 用 @ConditionalOnMissingBean 防重复
      - ④ 按接口全限定名保证唯一
- 追问2：CarbonAiServiceFactoryBean 借助 JDK 动态代理把接口方法转发到 ChatClient，如何保证代理对象的线程安全，并避免每次调用都重复解析 @AiPrompt 注解？
  - **答**：线程安全：JDK 动态代理本身线程安全（代理对象共享），关键是 ChatClient 是否线程安全（Spring AI ChatClient 通常无状态、线程安全），方法内不保存可变状态即可。
    - 避免重复解析 @AiPrompt：
      - ① FactoryBean 的 getObject 初始化阶段一次性解析并缓存每个方法的 @AiPrompt 元数据（Method→PromptTemplate 映射），调用时查缓存
      - ② 用 ConcurrentHashMap<Method,PromptMeta> 缓存，不每次反射解析
- 追问3：在碳管家中新增一个本地通义千问 provider 时，ImportSelector 返回的候选配置类变化后，已加载的 Bean 定义会即时生效还是需要重启应用？
  - **答**：需重启（或刷新上下文）。ImportSelector 在配置类解析阶段决定候选配置类，已加载 Bean 定义不会因改 ImportSelector 源码即时变化——除非重新触发上下文刷新。
    - 运行时新增 provider：
      - ① 用 @RefreshScope + 配置驱动动态路由（注册多个 ChatClient 按 provider 名路由），不靠 ImportSelector 静态候选
      - ② 或动态注册 BeanDefinition 实现不重启切换
      - ③ 静态 ImportSelector 适合编译期确定的 provider 集合

#### 十、Spring 表达式语言（SpEL）

### 37. SpEL基础语法与求值机制
**重要度**：★★★★

**题目：**
请说明Spring Expression Language（SpEL）的基础语法、求值流程，并给出在碳管理AI项目中使用SpEL动态构建Prompt的示例。

**解答：**
SpEL是Spring表达式语言，支持在运行时查询和操作对象图。SpEL的核心接口是ExpressionParser（解析表达式）和EvaluationContext（求值上下文）。解析流程为：ExpressionParser.parseExpression将表达式字符串解析为AST（抽象语法树），然后调用Expression.getValue在指定上下文中求值。

SpEL语法特性包括：字面量（字符串、数字、布尔）、属性访问（person.name）、方法调用（person.getName()）、算术运算（+、-、*、/）、关系运算（==、>、<）、逻辑运算（and、or、not）、正则匹配（'123' matches '\\d+'）、集合操作（list[0]、map['key']、list.![name]投影、list.?[age>18]筛选）、三元运算符（cond ? a : b）、Elvis运算符（name ?: 'default'）、类型引用（T(java.lang.Math)）、构造器调用（new com.carbon.Foo()）等。

```java
@Service
public class CarbonPromptBuilder {

    private final ExpressionParser parser = new SpelExpressionParser();

    public String buildPrompt(String template, Map<String, Object> variables) {
        // 创建求值上下文
        StandardEvaluationContext context = new StandardEvaluationContext();
        variables.forEach(context::setVariable);

        // 解析模板中的SpEL表达式并求值
        // 模板示例: "企业#{#org.name}在#{#year}年的碳排放量为#{#data.total}吨，同比增长#{T(Math).round((#data.total - #data.lastYear) / #data.lastYear * 100)}%"
        Expression exp = parser.parseExpression(template, new TemplateParserContext());
        return exp.getValue(context, String.class);
    }

    public String buildRagPrompt(String question, List<RetrievalResult> results) {
        String template = """
            你是碳管理专家。请基于以下检索到的碳法规信息回答问题。

            碳法规知识片段：
            #{#results.![content].stream().limit(5).collect(T(java.util.stream.Collectors).joining('\\n---\\n'))}

            用户问题：#{#question}

            请基于上述碳法规信息回答，如果信息不足请说明。
            """;

        StandardEvaluationContext context = new StandardEvaluationContext();
        context.setVariable("question", question);
        context.setVariable("results", results);
        return parser.parseExpression(template, new TemplateParserContext())
            .getValue(context, String.class);
    }
}
```

**AI/碳管理场景关联：**
碳管家AI助手使用SpEL动态构建RAG Prompt：检索到碳法规知识片段后，通过SpEL投影（results.![content]）提取纯文本内容，通过limit和joining操作拼接为上下文，再组合用户问题生成完整的Prompt。SpEL的集合操作（投影、筛选、聚合）在构建复杂Prompt时非常灵活，无需硬编码字符串拼接逻辑，修改Prompt模板只需修改SpEL表达式字符串，可存储在数据库或配置中心实现热更新。

---

#### 追问：
- 追问1：TemplateParserContext 解析 #{} 模板时，若模板字符串来自用户输入或数据库配置，如何防止 SpEL 注入导致信息泄露或 Runtime.exec 命令执行？
  - **答**：会。若 #{} 模板来自用户输入/DB 且用 StandardEvaluationContext（允许方法调用/类型引用），攻击者可构造 T(java.lang.Runtime).getRuntime().exec(...) 执行命令或读敏感信息。
    - 防护：
      - ① 模板必须由可信来源（开发者/配置）提供，用户只能提供"参数值"而非模板
      - ② 必须动态则用 SimpleEvaluationContext（只读、禁方法调用/类型引用）
      - ③ 白名单限制可用变量与函数
      - ④ 模板静态校验，禁 T()/# 等危险语法
- 追问2：碳管家用 SpEL 拼接 RAG Prompt 时，results.![content] 投影对空集合或超大集合会怎样表现，是否存在上下文超长甚至 OOM 的风险？
  - **答**：会。空集合投影得空列表（不报错）；超大集合投影生成巨大字符串拼进 Prompt，可能超模型上下文窗口甚至 OOM。
    - 防护：
      - ① 投影前对集合截断/分页（topK）
      - ② 对 content 长度设上限并裁剪
      - ③ 统计拼接后总长度，超限降采样并标注"部分已省略"
      - ④ 流式拼接避免一次性在内存拼超大字符串
      - ⑤ RAG 召回本就 topK，投影只作用于已截断集合
- 追问3：SpEL 表达式在每次 RAG 请求中即时 parseExpression，是否做了表达式缓存，AST 解析耗时在高频问答下会不会成为性能瓶颈？
  - **答**：应缓存。频繁 parseExpression 重复构建 AST 有性能开销，高并发问答下成瓶颈。
    - 优化：
      - ① 用 ConcurrentHashMap<String,Expression> 缓存已解析表达式（key=模板串），相同模板复用 Expression 对象
      - ② 模板含动态变量用占位符，解析一次后每次设变量值
      - ③ 缓存需 LRU 上限防内存增长
      - ④ SpEL 解析虽轻量，缓存显著降 CPU

### 38. SpEL在注解中的应用：@Value、@Cacheable、@PreAuthorize
**重要度**：★★★★

**题目：**
请说明SpEL在Spring注解中的应用场景，包括@Value属性注入、@Cacheable缓存Key生成、@PreAuthorize权限表达式，并给出碳管理项目中的使用示例。

**解答：**
SpEL在Spring注解中广泛使用，通过#{...}语法在注解属性中嵌入表达式，Spring在运行时解析求值。

**@Value注解**：用于注入配置值或动态计算值。支持#{...}（SpEL表达式）和${...}（属性占位符）两种语法。#{...}可以引用其他Bean的属性、调用方法、进行运算。

**@Cacheable/@CacheEvict注解**：通过SpEL生成缓存Key、条件判断。可用的SpEL上下文变量包括：#root（根对象）、#method、#target、#args、#result、#p0/#p1（参数名）、自定义参数名。

**@PreAuthorize/@PostAuthorize注解**：通过SpEL表达式定义授权规则。可访问authentication（当前认证信息）、returnObject（返回值，仅@PostAuthorize）、方法参数（通过#参数名引用）。

**必须开启方法级安全**：Spring Security 6（Boot 3 起）已删除 `@EnableGlobalMethodSecurity`，要写 `@EnableMethodSecurity(prePostEnabled 默认为 true)`。漏了这个注解，`@PreAuthorize` **静默不生效**——不报错、不拦截，租户越权校验整段失效，这是线上最隐蔽的一类漏洞。

```java
@Service
public class CarbonReportService {

    // @Value：注入配置值和Bean属性
    @Value("${carbon.ai.model:qwen-max}")
    private String defaultModel;

    @Value("#{@carbonAiConfigManager.getConfig().getMaxTokens()}")
    private int maxTokens; // 引用其他Bean的方法返回值

    @Value("#{systemProperties['carbon.tenant.default'] ?: 'default_tenant'}")
    private String defaultTenant; // Elvis运算符提供默认值

    // @Cacheable：SpEL生成缓存Key + 条件缓存
    @Cacheable(value = "carbonReport",
               key = "#tenantId + '_' + #year + '_' + #reportType",
               condition = "#year >= 2020",
               unless = "#result == null || #result.getStatus() == T(com.carbon.ai.entity.ReportStatus).DRAFT")
    public CarbonReport getReport(Long tenantId, int year, String reportType) {
        // 2020年以前的报告不缓存；草稿状态不缓存
        return reportRepository.findByTenantAndYear(tenantId, year, reportType);
    }

    // @CacheEvict：清除缓存
    @CacheEvict(value = "carbonReport",
                key = "#report.tenantId + '_' + #report.year + '_' + #report.reportType")
    public void updateReport(CarbonReport report) {
        reportRepository.save(report);
    }

    // @PreAuthorize：SpEL权限表达式
    @PreAuthorize("hasRole('ADMIN') or " +
                  "(hasRole('ANALYST') and @tenantPermissionService.canAccessTenant(authentication, #tenantId))")
    public CarbonReport generateReport(Long tenantId, int year) {
        // 管理员可生成任何租户的报告
        // 分析师只能生成本租户的报告（通过@tenantPermissionService校验）
        return doGenerate(tenantId, year);
    }

    // @PostAuthorize：返回值级别的权限检查
    @PostAuthorize("hasRole('ADMIN') or " +
                   "returnObject.getTenantId() == authentication.principal.tenantId")
    public CarbonReport getReportById(Long reportId) {
        CarbonReport report = reportRepository.findById(reportId);
        // 方法执行后检查：返回的报告必须属于当前用户的租户
        return report;
    }

    // @Scheduled：SpEL延迟表达式
    @Scheduled(fixedDelayString = "#{@carbonAiConfigManager.getConfig().getSyncInterval() * 1000}")
    public void syncCarbonLawIndex() {
        // 从配置中动态获取同步间隔
    }
}
```

**AI/碳管理场景关联：**
碳管家AI助手在缓存层面使用SpEL实现精细化缓存策略：碳排放报告按"租户ID_年份_报告类型"组合作为缓存Key，2020年以前的报告不缓存（历史数据不变无需缓存），草稿状态报告不缓存（频繁修改）。权限层面通过@PreAuthorize的SpEL表达式实现租户级数据隔离：分析师生成报告时调用tenantPermissionService.canAccessTenant校验是否有权访问目标租户数据。@PostAuthorize在查询报告后验证返回的报告属于当前用户租户，防止越权访问。

---

#### 追问：
- 追问1：@Cacheable 的 key 用 "#tenantId + '_' + #year"，若日后按租户隔离策略要加 reportVersion，如何保证旧缓存平滑失效而不串数据？
  - **答**：加 reportVersion 到 key 后，旧 key（无版本）与新 key 不同，天然不串数据；旧缓存设 TTL 自动过期，无需手动清。
    - 注意：仅"新增"维度时旧数据仍按旧 key 命中（直到过期），不会错但可能短暂返回旧版本，可接受；若版本变化需立即失效全部旧版，用 CacheEvict 或 Redis 按前缀批量删；key 设计含所有隔离维度保证不串。
- 追问2：@PreAuthorize 基于 SpEL 做租户级隔离，方法参数来自 JSON 反序列化的复杂对象时，SpEL 能否正确引用嵌套属性，权限表达式本身由谁来保证不出错？
  - **答**：能。SpEL 支持属性导航（如 #req.org.id），只要对象已反序列化且字段可访问（getter/公开字段）即可引用嵌套属性。
    - 保证不出错：
      - ① 表达式由开发者编写并单测覆盖，避免拼错属性
      - ② 复杂对象用 DTO 明确字段
      - ③ 权限表达式经安全评审防逻辑错误越权
      - ④ 必要时把租户隔离做成自动注入（不在注解手写），减少人为写错风险
- 追问3：把路由/缓存的 SpEL 表达式写在注解里与写在 Nacos 配置里，哪种更适合碳管家按租户动态调优，各自有什么取舍？
  - **答**：注解内 SpEL：简单、编译期可见、随代码走，但改需发版，不适合按租户动态调优。Nacos 配置：可热更新、按租户差异化调优，但需解析/缓存、有注入时机与一致性问题。
    - 取舍：静态通用规则写注解；租户级、需热调策略放 Nacos（配 @RefreshScope/事件刷新 + 表达式缓存），并加校验防非法表达式。碳管家按租户调优优先 Nacos。

### 39. SpEL高级用法：自定义函数与安全限制
**重要度**：★★★★

**题目：**
请说明SpEL的高级用法，包括注册自定义函数、集合投影与筛选、类型引用，以及SpEL的安全风险与防护措施。

**解答：**
SpEL的高级特性使其具备强大的动态表达能力，但也带来安全考量：

**注册自定义函数**：通过StandardEvaluationContext.registerFunction注册Java方法为SpEL函数，可在表达式中直接调用。

**集合投影（Projection）**：`list.![propertyName]`提取集合中每个元素的某个属性，生成新集合。如`emissions.![amount]`提取所有排放量。

**集合筛选（Selection）**：`list.?[condition]`筛选满足条件的元素。`.^[]`选取第一个匹配项，`.$[]`选取最后一个匹配项。

**类型引用**：`T(java.lang.Math)`引用Java类型，可调用静态方法和访问静态字段。这是SpEL的安全风险之一，恶意表达式可通过`T(java.lang.Runtime).getRuntime().exec('...')`执行系统命令。

**安全防护**：
1. 简单SpEL上下文（SimpleEvaluationContext）替代标准上下文，禁用类型引用和方法调用——这是最有效的一道。
2. 对用户输入的表达式进行白名单校验（只允许属性访问、比较、算术等固定语法）。
3. 表达式长度/嵌套层数做静态自检（自己数括号和括号深度），并在独立线程里求值、超时中断。

**注意**：`SpelParserConfiguration` **不能**用来限制表达式复杂度。它的构造参数只有 compilerMode、classLoader、autoGrowNullReferences、autoGrowCollections、maximumAutoGrowSize——`maximumAutoGrowSize` 限制的是集合自动扩容的大小，跟表达式长度、嵌套深度、执行时间都没关系。用它做"安全防护"是常见误区。

```java
@Service
public class CarbonAiExpressionService {

    private final SpelParserConfiguration config;
    private final ExpressionParser parser;

    public CarbonAiExpressionService() {
        // 这里配的是编译模式（MIXED 表示热点表达式编译成字节码加速），与安全限制无关
        this.config = new SpelParserConfiguration(
            SpelCompilerMode.MIXED,
            this.getClass().getClassLoader()
        );
        this.parser = new SpelExpressionParser(config);
    }

    // 注册碳管理自定义函数
    public StandardEvaluationContext createSafeContext() {
        StandardEvaluationContext context = new StandardEvaluationContext();

        try {
            // 注册碳排放计算函数
            context.registerFunction("calcEmission",
                CarbonUtils.class.getDeclaredMethod("calculateEmission",
                    EmissionData.class));
            // 注册碳排放因子查找函数
            context.registerFunction("findFactor",
                CarbonUtils.class.getDeclaredMethod("findEmissionFactor",
                    String.class, String.class));
            // 注册碳法规查询函数
            context.registerFunction("queryLaw",
                CarbonUtils.class.getDeclaredMethod("queryCarbonLaw", String.class));
        } catch (NoSuchMethodException e) {
            throw new RuntimeException(e);
        }

        return context;
    }

    // 安全的SpEL求值（用于用户自定义的碳排放计算公式）
    public BigDecimal evaluateFormula(String formula, Map<String, Object> params) {
        // 使用SimpleEvaluationContext防止注入攻击
        SimpleEvaluationContext safeContext = SimpleEvaluationContext
            .forReadOnlyDataBinding()
            .withInstanceMethods()  // 允许实例方法调用但禁止类型引用
            .build();
        params.forEach(safeContext::setVariable);

        Expression exp = parser.parseExpression(formula);
        return exp.getValue(safeContext, BigDecimal.class);
    }

    // 集合投影与筛选示例
    public void analyzeEmissions(List<EmissionSource> sources) {
        StandardEvaluationContext context = new StandardEvaluationContext();
        context.setVariable("sources", sources);

        // 投影：提取所有排放源的排放量
        List<BigDecimal> amounts = parser.parseExpression("#sources.![emissionAmount]")
            .getValue(context, List.class);

        // 筛选：找出排放量大于1000吨的排放源
        List<EmissionSource> highEmissions = parser.parseExpression(
            "#sources.?[emissionAmount > 1000]")
            .getValue(context, List.class);

        // 筛选+投影：找出范围1排放源并提取名称
        List<String> scope1Names = parser.parseExpression(
            "#sources.?[scope == 'Scope1'].![sourceName]")
            .getValue(context, List.class);

        // 聚合：计算总排放量
        BigDecimal total = parser.parseExpression(
            "#sources.![emissionAmount].stream().reduce(T(java.math.BigDecimal).ZERO, {a, b -> a.add(b)})")
            .getValue(context, BigDecimal.class);
    }
}
```

**AI/碳管理场景关联：**
碳管家AI助手支持用户自定义碳排放计算公式（如"活动数据×排放因子×氧化率"），通过SpEL安全求值执行用户输入的公式。使用SimpleEvaluationContext确保用户无法通过恶意表达式调用Runtime.exec执行系统命令。同时注册了calcEmission、findFactor等碳管理专用函数，用户在公式中可直接使用`#calcEmission(#data)`进行碳排放计算，无需了解底层API。

---

#### 追问：
- 追问1：SimpleEvaluationContext.forReadOnlyDataBinding().withInstanceMethods() 允许实例方法调用，这是否仍可能被利用（如调用危险 getter），你的白名单边界如何界定？
  - **答**：仍可能。withInstanceMethods 允许调用实例方法，若模型对象有危险 getter（如 getClassLoader、getConnection）可能被间接调用读取敏感信息。
    - 边界界定：
      - ① 仅对可信数据对象开放，禁在含敏感方法的类型上暴露
      - ② 白名单限定可用变量与可调用方法，禁 getClass 等
      - ③ 优先用 readOnlyDataBinding 仅允许属性读、关掉 withInstanceMethods，除非确需方法
      - ④ 表达式输入做静态检查
- 追问2：用户自定义碳排放公式经 SpEL 求值，若公式存在死循环或指数级嵌套投影，有何熔断或复杂度限制手段？
  - **答**：需限制。恶意/错误公式可能死循环或指数级嵌套投影导致 CPU 飙升/OOM。
    - 手段：
      - ① 给 SpEL 求值设超时（单独线程 + Future.get(timeout) 中断）
      - ② 限制投影/递归深度与集合大小
      - ③ 限制单次求值 CPU/内存预算（或用沙箱脚本引擎替代 SpEL）
      - ④ 对公式做静态复杂度分析（圈复杂度/嵌套层数）超限拒绝
      - ⑤ 用户公式先小样本试算异常即拦
- 追问3：注册 calcEmission、findFactor 等自定义函数后，这些函数内部若访问租户数据，如何在 SpEL 求值上下文中传递并校验当前租户身份？
  - **答**：在求值上下文（EvaluationContext）注入当前 TenantContext，或由自定义函数内部从 ThreadLocal/SecurityContext 取租户身份。
    - 校验：
      - ① 自定义函数（calcEmission/findFactor）实现里强制读当前租户 ID，所有数据访问按该租户过滤，禁跨租户
      - ② 函数注册时绑受控实现，不暴露可指定租户参数的入口
      - ③ 求值前校验调用者租户与数据租户一致
      - ④ 公式执行在租户上下文线程内，确保隔离不串

### 40. SpEL在AI动态配置与条件路由中的应用
**重要度**：★★★★

**题目：**
请设计一个基于SpEL的AI服务动态路由方案，根据问题类型、租户等级、时间等因素动态选择AI模型和检索策略。

**解答：**
在多模型、多策略的AI系统中，需要根据上下文动态路由到不同的处理链路。SpEL的动态表达式特性使其成为实现条件路由的理想工具。

```java
// 路由规则配置实体
@Data
public class AiRoutingRule {
    private String name;
    private String condition;     // SpEL条件表达式
    private String model;         // 使用的AI模型
    private String retrievalStrategy; // 检索策略
    private int maxTokens;
    private double temperature;
    private int priority;         // 优先级，数值越小优先级越高
}

// 路由规则示例：
// 1. 高级租户复杂问题 → 通义千问 qwen-max + 混合检索
//    condition: "#tenant.level == 'PREMIUM' and #question.length() > 100"
// 2. 法规查询 → DeepSeek + 法规库检索
//    condition: "#question contains '法规' or #question contains '标准'"
// 3. 简单数值查询 → DeepSeek + 直接计算
//    condition: "#question matches '.*\\d+.*吨.*'"

@Service
public class CarbonAiRouter {

    @Autowired
    private AiRoutingRuleRepository ruleRepository;
    private final ExpressionParser parser = new SpelExpressionParser();

    // 路由缓存：避免每次请求都解析SpEL表达式
    private final Map<String, Expression> expressionCache = new ConcurrentHashMap<>();

    public AiRoutingContext route(CarbonUser tenant, String question) {
        // 构建SpEL上下文
        StandardEvaluationContext context = new StandardEvaluationContext();
        context.setVariable("tenant", tenant);
        context.setVariable("question", question);
        context.setVariable("time", LocalTime.now());
        context.setVariable("quotaUsed", getQuotaUsed(tenant));

        // 按优先级加载路由规则
        List<AiRoutingRule> rules = ruleRepository.findAllByOrderByPriorityAsc();

        for (AiRoutingRule rule : rules) {
            try {
                Expression exp = expressionCache.computeIfAbsent(rule.getCondition(),
                    parser::parseExpression);

                Boolean matched = exp.getValue(context, Boolean.class);
                if (Boolean.TRUE.equals(matched)) {
                    log.info("路由匹配: rule={}, model={}, strategy={}",
                        rule.getName(), rule.getModel(), rule.getRetrievalStrategy());

                    return AiRoutingContext.builder()
                        .model(rule.getModel())
                        .retrievalStrategy(rule.getRetrievalStrategy())
                        .maxTokens(rule.getMaxTokens())
                        .temperature(rule.getTemperature())
                        .build();
                }
            } catch (Exception e) {
                log.error("路由规则求值失败: rule={}", rule.getName(), e);
            }
        }

        // 默认路由
        return AiRoutingContext.builder()
            .model("deepseek-chat")
            .retrievalStrategy("hybrid")
            .maxTokens(2048)
            .temperature(0.7)
            .build();
    }
}

// 碳管家AI服务根据路由结果执行
@Service
public class CarbonChatService {

    @Autowired
    private CarbonAiRouter router;
    @Autowired
    private Map<String, ChatClient> chatClients; // 多模型客户端
    @Autowired
    private Map<String, RetrievalStrategy> strategies; // 多检索策略

    public String chat(CarbonUser user, String question) {
        // 1. 路由决策
        AiRoutingContext ctx = router.route(user, question);

        // 2. 检索策略执行
        RetrievalStrategy strategy = strategies.get(ctx.getRetrievalStrategy());
        List<RetrievalResult> results = strategy.retrieve(question, user.getTenantId());

        // 3. 选择模型调用
        ChatClient client = chatClients.get(ctx.getModel());
        String prompt = buildPrompt(question, results, ctx);

        return client.prompt(prompt)
            // Spring AI 1.x 的 builder 去掉了 with 前缀：maxTokens/temperature（with* 是 0.8/1.0-M 写法）
            .options(OpenAiChatOptions.builder()
                .maxTokens(ctx.getMaxTokens())
                .temperature(ctx.getTemperature())
                .build())
            .call().content();
    }
}
```

**AI/碳管理场景关联：**
碳管家AI助手通过SpEL路由规则实现智能模型选择：高级租户的复杂碳法规分析问题路由到通义千问 qwen-max（更准确但更贵），简单数值查询路由到 DeepSeek（更便宜更快）。当租户当日Token用量超过阈值时，自动降级到更经济的模型，控制AI调用成本。路由规则存储在数据库中，运维人员可通过管理界面动态修改SpEL条件表达式，无需重启应用即可调整路由策略，实现AI服务的灵活管控。

---

#### 追问：
- 追问1：路由规则按 priority 顺序匹配、命中即返回，若多条规则 condition 都满足，如何设计可调试的"命中原因回显"和冲突检测，避免运维配错后难以排查？
  - **答**：
    - ① 冲突检测：规则配置时做静态校验，检测多条规则 condition 可能同时满足且结论不同（决策表/互斥检查），配错即告警
    - ② 命中原因回显：路由结果除 model 外附 hitRuleId/reason 便于排查
    - ③ 提供 dry-run 接口输入（租户/问题类型）返回将命中规则与原因
    - ④ 规则存 DB 加唯一 priority 与覆盖顺序文档，配单测覆盖典型场景
- 追问2：当租户 Token 配额超限自动降级到便宜模型时，降级判定发生在路由阶段还是调用阶段，降级后如何保证用户看到一致的回答质量预期？
  - **答**：应在路由阶段判定。租户配额超限时在路由层就选便宜模型（如 deepseek-chat）而非调用阶段才降级，避免已发请求再切模型导致重复计费/延迟。
    - 保证质量预期：
      - ① 降级返回 degraded=true 与提示"已切换标准模型，回答可能略简"
      - ② 关键合规问答可配置"禁止降级"（仍用强模型，超配额则限流）
      - ③ 用户/租户可设降级偏好，明确预期
- 追问3：路由规则存数据库并热更新，多个 Pod 并发读取与表达式缓存失效如何保证最终一致，且缓存项能否精准失效而不是全量清空？
  - **答**：最终一致：规则存 DB，各 Pod 通过 Nacos/事件/定时拉取刷新本地缓存。精准失效：
    - ① 规则按 id 缓存，更新只 evict 对应 id（ConcurrentHashMap.remove(ruleId)）
    - ② 或发"规则变更事件"携带变更 id 列表，各 Pod 精准更新
    - ③ 加版本号，拉取对比版本只更差异
    - ④ 缓存设短 TTL 兜底防事件丢失
    - ⑤ 多 Pod 一致性靠"事件+定时补偿拉取"双保险

#### 十一、Spring 测试

### 41. @MockBean与@SpyBean的使用与区别
**重要度**：★★★

**题目：**
请说明Spring Boot测试中@MockBean和@SpyBean的作用、区别，以及在对碳管家AI助手进行单元测试时的使用策略。

**解答：**
**版本前提**：Boot 3.4 起 `@MockBean`/`@SpyBean` 已 deprecated（Boot 4 移除），替代是 Spring Framework 6.2 的 `@MockitoBean`/`@MockitoSpyBean`，import 也从 `org.springframework.boot.test.mock.mockito.MockBean` 换成 `org.springframework.test.context.bean.override.mockito.MockitoBean`。两者底层都是 Spring 的 `@BeanOverride` 机制，面试时先说清版本边界再讲用法。

**@MockitoBean（旧 @MockBean）**：创建一个完整的Mockito Mock对象，替换ApplicationContext中同类型的Bean（如果存在）。Mock对象的所有方法默认返回null/0/false，需要通过when().thenReturn()显式定义行为。原有的Bean实例被完全替换，不会执行任何真实逻辑。适合依赖外部服务的组件测试，如Mock ChatClient避免真实调用大模型 API。

**@MockitoSpyBean（旧 @SpyBean）**：创建一个Mockito Spy对象，包装真实的Bean实例。默认调用真实方法，可以通过when().thenReturn()对特定方法进行Stub。适合需要保留大部分真实逻辑但Mock特定方法的场景，如Spy真实CarbonChatService但Mock其调用大模型的部分。

**区别总结**：`@MockitoBean`完全替换，不执行任何真实代码；`@MockitoSpyBean`包装真实对象，默认执行真实代码。**两者对上下文的影响完全一样**——都会改写 bean 定义、往 MergedContextConfiguration 里挂一条自定义项，cache key 因此不同，测试类会各自新建一份 ApplicationContext 缓存条目（这也是切片测试更受推荐的原因）。差别只在替换后的对象行为，不存在"Spy 对上下文影响更小"这回事。

```java
@SpringBootTest
class CarbonChatServiceTest {

    @Autowired
    private CarbonChatService chatService;

    // @MockitoBean（旧写法 @MockBean）：完全Mock ChatClient，不调用真实大模型 API
    @MockitoBean
    private ChatClient chatClient;

    // @MockitoBean：Mock向量存储，不依赖真实Milvus
    @MockitoBean
    private MilvusVectorStore vectorStore;

    // @MockitoSpyBean（旧写法 @SpyBean）：Spy真实Token计量服务，但Mock配额检查方法
    @MockitoSpyBean
    private TokenQuotaService quotaService;

    // 注意：chatClient.prompt(x) 返回 RequestSpec，.call() 返回 ResponseSpec，.content() 才是答案。
    // 直接 when(chatClient.prompt(x).call().content()) 是深链调用，中间 prompt(x) 返回 null 必 NPE；
    // 正确做法是逐层 mock（或 mock(answer = Answers.RETURNS_DEEP_STUBS)、或直接 mock 底层 ChatModel）
    private void stubChatAnswer(String answer) {
        ChatClient.ChatClientRequestSpec requestSpec = mock(ChatClient.ChatClientRequestSpec.class);
        ChatClient.CallResponseSpec responseSpec = mock(ChatClient.CallResponseSpec.class);
        when(chatClient.prompt(anyString())).thenReturn(requestSpec);
        when(requestSpec.call()).thenReturn(responseSpec);
        when(responseSpec.content()).thenReturn(answer);
    }

    @Test
    void shouldReturnAiAnswer_whenChatWithValidQuestion() {
        // Given: Mock ChatClient返回预设答案
        stubChatAnswer("根据碳法规要求，企业需在每年3月前提交碳排放报告。");

        // Mock向量检索返回碳法规片段
        List<RetrievalResult> mockResults = List.of(
            new RetrievalResult("碳排放报告应在每年3月前提交", 0.95, "LAW")
        );
        when(vectorStore.similaritySearch(any(SearchRequest.class)))
            .thenReturn(mockResults);

        // When: 调用真实chatService
        CarbonUser user = CarbonUser.builder().tenantId(1L).build();
        ChatResponse response = chatService.chat(user, "碳排放报告什么时候提交？");

        // Then: 验证结果
        assertThat(response.getAnswer()).contains("3月前提交");
        assertThat(response.getRetrievedResults()).hasSize(1);

        // 验证ChatClient被调用
        verify(chatClient).prompt(contains("碳排放报告什么时候提交"));
    }

    @Test
    void shouldThrowException_whenQuotaExceeded() {
        // Given: Mock配额检查返回已超限
        doReturn(false).when(quotaService).checkQuota(1L);

        // When & Then: 应抛出配额超限异常
        CarbonUser user = CarbonUser.builder().tenantId(1L).build();
        assertThatThrownBy(() -> chatService.chat(user, "碳法规问题"))
            .isInstanceOf(QuotaExceededException.class)
            .hasMessageContaining("配额");

        // 验证ChatClient未被调用（配额检查拦截）
        verify(chatClient, never()).prompt(anyString());
    }

    @Test
    void shouldFallbackToKeywordSearch_whenVectorSearchFails() {
        // Given: 向量检索抛出异常
        when(vectorStore.similaritySearch(any()))
            .thenThrow(new RuntimeException("Milvus连接失败"));

        // 但ChatClient仍返回结果（降级为无RAG的直接问答）
        stubChatAnswer("碳法规要求企业报告碳排放数据。");

        // When: 调用chatService（应降级而非报错）
        ChatResponse response = chatService.chat(
            CarbonUser.builder().tenantId(1L).build(), "碳法规要求");

        // Then: 降级成功，返回AI答案但无检索结果
        assertThat(response.getAnswer()).isNotEmpty();
        assertThat(response.getRetrievedResults()).isEmpty();
    }
}
```

**AI/碳管理场景关联：**
碳管家AI助手的测试策略：@MockitoBean Mock外部依赖（ChatClient、MilvusVectorStore）避免测试时消耗API额度和依赖基础设施；@MockitoSpyBean Spy内部服务（TokenQuotaService、CarbonLawIndex）保留真实业务逻辑仅Mock特定方法。通过测试矩阵覆盖正常问答、配额超限、Milvus故障降级、大模型超时等场景，确保AI助手在各种异常情况下的健壮性。CI/CD流水线每次提交运行全部测试，避免回归问题。

---

#### 追问：
- 追问1：在 @MockitoBean（旧 @MockBean）替换 ChatClient 的集成测试中，若真实 ChatClient 是 Spring AI 的 Bean 而项目同时用 LangChain4j，两套客户端如何分别 Mock 而不互相干扰？
  - **答**：按类型/qualifier 分别 Mock。Spring AI 的 ChatClient 与 LangChain4j 的 AiServices/ChatLanguageModel 是不同类型 Bean，@MockitoBean 按类型替换对应那个，互不干扰。
    - 若项目同时有两个 ChatClient 实现需 @Qualifier 区分（@MockitoBean 支持 name 属性指定 bean 名）。测试：
      - ① 对 Spring AI ChatClient 用 @MockitoBean(name = "springAiChatClient") 返 mock 响应
      - ② 对 LangChain4j 模型接口用另一 @MockitoBean 按类型替换
      - ③ Mock 返回预设 Prompt/Answer，验证路由与业务逻辑不依赖真实模型
- 追问2：@MockitoSpyBean（旧 @SpyBean）包装真实 CarbonChatService 并 Mock 配额检查时，Spy 默认走真实代码，若真实方法内又依赖了被 @MockitoBean 替换的 Bean，调用链会如何表现，会不会出现部分真实部分 Mock 的隐式耦合？
  - **答**：会。@MockitoSpyBean 默认走真实方法，真实方法内部调用被 @MockitoBean 替换的 Bean（如 quotaService）时走 Mock 实现，出现"外层真实、内层 Mock"混合。
    - 这是预期但需小心：
      - ① Spy 仅覆盖要验证的方法，其余走真实，依赖的 Bean 按 Mock 行为返回
      - ② 想整链可控直接 @MockitoBean 整个 Service
      - ③ Spy 真实代码若依赖未 Mock 的 Bean 会真实执行，测试要备齐所有依赖桩，避免隐式耦合导致非预期真实调用
      - ④ 提醒：Spy 与 Mock 一样会新建一份上下文缓存条目，别指望"用 Spy 省一次上下文启动"

### 42. TestRestTemplate与WebTestClient集成测试
**重要度**：★★★

**题目：**
请说明Spring Boot中TestRestTemplate和WebTestClient的使用方式，并编写碳管家AI助手API的端到端集成测试。

**解答：**
TestRestTemplate是RestTemplate的测试替代品，提供便捷的HTTP API测试能力。WebTestClient是Spring WebFlux提供的响应式测试客户端，也适用于Servlet应用的端到端测试，支持流式断言。

```java
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
@AutoConfigureTestDatabase // 使用内存数据库替代真实数据库
class CarbonAiApiIntegrationTest {

    @Autowired
    private TestRestTemplate restTemplate;

    @LocalServerPort
    private int port;

    @MockitoBean
    private ChatClient chatClient;

    @MockitoBean
    private MilvusVectorStore vectorStore;

    private String getBaseUrl() {
        return "http://localhost:" + port + "/api/carbon-ai";
    }

    @Test
    void shouldReturn200_whenChatWithValidToken() {
        // Given: 准备Mock
        // ChatClient 是链式 API，prompt() 返回 RequestSpec、call() 返回 CallResponseSpec，
        // 直接 when(chatClient.prompt(x).call().content()) 中间返回 null 会 NPE，必须逐层 mock
        ChatClient.ChatClientRequestSpec requestSpec = mock(ChatClient.ChatClientRequestSpec.class);
        ChatClient.CallResponseSpec callSpec = mock(ChatClient.CallResponseSpec.class);
        when(chatClient.prompt(anyString())).thenReturn(requestSpec);
        when(requestSpec.call()).thenReturn(callSpec);
        when(callSpec.content()).thenReturn("企业碳排放范围1包含直接排放源。");
        when(vectorStore.similaritySearch(any()))
            .thenReturn(List.of(new RetrievalResult("范围1直接排放", 0.9, "LAW")));

        // 获取JWT Token
        String token = loginAndGetToken("analyst", "password");

        // When: 发起AI问答请求
        HttpHeaders headers = new HttpHeaders();
        headers.setBearerAuth(token);
        headers.setContentType(MediaType.APPLICATION_JSON);

        ChatRequest request = new ChatRequest("什么是碳排放范围1？", "CHAT");
        HttpEntity<ChatRequest> entity = new HttpEntity<>(request, headers);

        ResponseEntity<ApiResponse> response = restTemplate.exchange(
            getBaseUrl() + "/chat",
            HttpMethod.POST,
            entity,
            ApiResponse.class
        );

        // Then: 验证响应
        assertThat(response.getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(response.getBody().getCode()).isEqualTo(200);
        assertThat(response.getBody().getData()).isNotNull();
    }

    @Test
    void shouldReturn401_whenNoTokenProvided() {
        ChatRequest request = new ChatRequest("碳法规问题", "CHAT");
        ResponseEntity<ApiResponse> response = restTemplate.postForEntity(
            getBaseUrl() + "/chat",
            request,
            ApiResponse.class
        );

        assertThat(response.getStatusCode()).isEqualTo(HttpStatus.UNAUTHORIZED);
    }

    @Test
    void shouldReturn429_whenRateLimitExceeded() {
        String token = loginAndGetToken("analyst", "password");

        HttpHeaders headers = new HttpHeaders();
        headers.setBearerAuth(token);
        headers.setContentType(MediaType.APPLICATION_JSON);

        // 连续发送超过限流阈值的请求
        for (int i = 0; i < 21; i++) {
            ChatRequest request = new ChatRequest("问题" + i, "CHAT");
            HttpEntity<ChatRequest> entity = new HttpEntity<>(request, headers);

            ResponseEntity<ApiResponse> response = restTemplate.exchange(
                getBaseUrl() + "/chat",
                HttpMethod.POST,
                entity,
                ApiResponse.class
            );

            if (i < 20) {
                assertThat(response.getStatusCode()).isNotEqualTo(HttpStatus.TOO_MANY_REQUESTS);
            } else {
                // 第21次应被限流
                assertThat(response.getStatusCode()).isEqualTo(HttpStatus.TOO_MANY_REQUESTS);
                assertThat(response.getBody().getMessage()).contains("频繁");
            }
        }
    }

    private String loginAndGetToken(String username, String password) {
        LoginRequest loginReq = new LoginRequest(username, password);
        ResponseEntity<TokenResponse> response = restTemplate.postForEntity(
            "http://localhost:" + port + "/api/auth/login",
            loginReq,
            TokenResponse.class
        );
        return response.getBody().getAccessToken();
    }
}
```

**AI/碳管理场景关联：**
集成测试覆盖碳管家AI助手API的完整链路：认证→限流→AI问答→响应格式。通过TestRestTemplate发起真实HTTP请求，验证JWT认证、权限检查、速率限制、异常处理等全链路行为。Mock ChatClient避免真实API调用费用，但验证了HTTP请求→Controller→Service→ChatClient的完整调用链。测试中使用@AutoConfigureTestDatabase切换到H2内存数据库，确保测试环境隔离且可重复执行。

---

#### 追问：
- 追问1：集成测试用 @AutoConfigureTestDatabase 切到 H2，但碳管家真实用 PostgreSQL，H2 与 PG 在 JSONB、全文检索等特性上的差异会不会让测试通过而生产翻车？
  - **答**：会。H2 与 PG 在 JSONB、全文检索、特定函数（jsonb_path_query、to_tsvector）行为不同，H2 测试通过生产 PG 可能报错/语义不符。
    - 缓解：
      - ① 关键数据访问测试用 Testcontainers 真实 PG 保证特性一致
      - ② H2 仅用于不涉 PG 专有特性的轻量单测
      - ③ 用 JPA 抽象避免原生 SQL，PG 专有逻辑隔离并单独用 PG 测试
      - ④ CI 跑一份真实 PG 集成测试兜底
- 追问2：WebTestClient 相比 TestRestTemplate 在做 AI 流式（SSE）回答测试时有什么优势，碳管家是否覆盖了流式输出的端到端测试？
  - **答**：WebTestClient 更适合。它基于响应式，原生支持 SSE/流式（用 .returnResult()/.toFlux() 消费 data 流），可断言流式块顺序与内容；TestRestTemplate 偏阻塞、对流式支持弱。
    - 碳管家应覆盖流式端到端：
      - ① 用 WebTestClient 测 SSE 首块（TTFT）与完整流
      - ② 断言每段 chunk 结构与终止符
      - ③ 测超时/中断流
      - 建议对 chat 流式接口补 WebTestClient 测试。

### 43. Spring Boot测试切片：@WebMvcTest、@DataJpaTest、@JsonTest
**重要度**：★★★

**题目：**
请说明Spring Boot的测试切片（Test Slices）机制，包括@WebMvcTest、@DataJpaTest、@JsonTest的适用场景，并给出碳管理项目的测试切片实践。

**解答：**
测试切片是Spring Boot提供的轻量级测试方案，仅加载应用上下文中与特定层相关的组件，而非启动完整的ApplicationContext，大幅提升测试速度。

**@WebMvcTest**：仅加载Web层（Controller、HandlerInterceptor、Filter、HandlerExceptionResolver等），不加载Service和Repository层。自动配置MockMvc用于模拟HTTP请求。需要用@MockitoBean Mock Service层依赖。适合Controller层的单元测试。

**@DataJpaTest**：仅加载JPA相关组件（EntityManager、Repository、DataSource），自动配置嵌入式数据库（H2），每个测试方法后回滚事务。适合Repository层的数据库测试。

**@JsonTest**：仅加载Jackson序列化/反序列化组件，自动配置ObjectMapper。适合DTO的JSON序列化测试。

**@RestClientTest**：仅加载RestTemplate/WebClient相关配置，Mock服务端响应。适合HTTP客户端测试。

```java
// 1. @WebMvcTest: 测试AI Controller层
@WebMvcTest(AiController.class)
@Import({GlobalExceptionHandler.class, SecurityConfig.class})
class AiControllerTest {

    @Autowired
    private MockMvc mockMvc;

    @MockitoBean
    private CarbonChatService chatService;

    @MockitoBean
    private JwtTokenService jwtTokenService;

    @Test
    void shouldReturnChatResponse_whenValidRequest() throws Exception {
        // Given
        ChatResponse mockResponse = new ChatResponse("AI回答内容", List.of(), "session-1");
        when(chatService.chat(any(CarbonUser.class), any(ChatRequest.class)))
            .thenReturn(mockResponse);
        when(jwtTokenService.parseToken(anyString()))
            .thenReturn(CarbonUser.builder().tenantId(1L).build());

        // When & Then
        mockMvc.perform(post("/api/carbon-ai/chat")
                .header("Authorization", "Bearer test-token")
                .contentType(MediaType.APPLICATION_JSON)
                .content("""
                    {
                        "question": "什么是碳排放范围1？",
                        "type": "CHAT"
                    }
                    """))
            .andExpect(status().isOk())
            .andExpect(jsonPath("$.code").value(200))
            .andExpect(jsonPath("$.data.answer").value("AI回答内容"))
            .andExpect(jsonPath("$.data.sessionId").value("session-1"));
    }

    @Test
    void shouldReturn400_whenQuestionIsBlank() throws Exception {
        mockMvc.perform(post("/api/carbon-ai/chat")
                .header("Authorization", "Bearer test-token")
                .contentType(MediaType.APPLICATION_JSON)
                .content("""
                    {
                        "question": "",
                        "type": "CHAT"
                    }
                    """))
            .andExpect(status().isBadRequest())
            .andExpect(jsonPath("$.code").value(400));
    }
}

// 2. @DataJpaTest: 测试碳报告Repository层
// 注意：@DataJpaTest 默认会把数据源替换成内嵌 H2（等价于 Replace.ANY）；
// 写成 Replace.NONE 就是"不替换"——用真实数据源，本地没有 PG 时上下文直接启动失败。
// 下面要跑 H2，所以用默认值（不写该注解），或用 Replace.ANY 显式声明。
@DataJpaTest
class CarbonReportRepositoryTest {

    @Autowired
    private TestEntityManager entityManager;

    @Autowired
    private CarbonReportRepository repository;

    @Test
    void shouldFindReportByTenantAndYear() {
        // Given
        CarbonReport report = CarbonReport.builder()
            .tenantId(1L)
            .year(2024)
            .reportType("ANNUAL")
            .totalEmission(new BigDecimal("12500.50"))
            .status(ReportStatus.SUBMITTED)
            .build();
        entityManager.persistAndFlush(report);

        // When
        Optional<CarbonReport> found = repository.findByTenantAndYear(1L, 2024, "ANNUAL");

        // Then
        assertThat(found).isPresent();
        assertThat(found.get().getTotalEmission()).isEqualByComparingTo("12500.50");
    }

    @Test
    void shouldReturnEmpty_whenReportNotExists() {
        Optional<CarbonReport> found = repository.findByTenantAndYear(999L, 2024, "ANNUAL");
        assertThat(found).isEmpty();
    }
}

// 3. @JsonTest: 测试DTO序列化
@JsonTest
class ChatResponseJsonTest {

    @Autowired
    private JacksonTester<ApiResponse<ChatResponse>> jsonTester;

    // 反序列化 ChatRequest 要用对应泛型的 JacksonTester（按泛型自动注入），
    // 不能拿 ApiResponse<ChatResponse> 的 tester 去 parse 另一个类型
    @Autowired
    private JacksonTester<ChatRequest> chatRequestJsonTester;

    @Test
    void shouldSerializeChatResponse() throws IOException {
        ChatResponse response = new ChatResponse(
            "碳排放范围1包含直接排放",
            List.of(new RetrievalResult("法规片段", 0.95, "LAW")),
            "session-123"
        );
        ApiResponse<ChatResponse> apiResponse = ApiResponse.success(response);

        // 验证序列化结果
        String json = jsonTester.write(apiResponse).getJson();
        assertThat(json).contains("\"code\":200");
        assertThat(json).contains("\"answer\":\"碳排放范围1包含直接排放\"");
        assertThat(json).contains("\"sessionId\":\"session-123\"");
    }

    @Test
    void shouldDeserializeChatRequest() throws IOException {
        String json = """
            {
                "question": "碳排放计算方法",
                "type": "CHAT",
                "context": "企业碳排放数据"
            }
            """;

        ChatRequest request = chatRequestJsonTester.parseObject(json).getObject();

        // 验证反序列化
        assertThat(request.getQuestion()).isEqualTo("碳排放计算方法");
        assertThat(request.getType()).isEqualTo("CHAT");
    }
}
```

**AI/碳管理场景关联：**
碳管家AI助手采用分层测试策略：@WebMvcTest测试AiController的请求映射、参数校验和异常处理（2秒内完成）；@DataJpaTest测试CarbonReportRepository的查询逻辑（使用H2内存数据库，5秒内完成）；@JsonTest测试ChatResponse的JSON序列化格式是否符合前端契约（1秒内完成）。通过测试切片，各层测试独立快速执行，CI流水线总时间控制在3分钟内。完整集成测试（@SpringBootTest）仅在合并到主分支时运行。

---

#### 追问：
- 追问1：@WebMvcTest 默认不加载完整 Security 过滤器链，碳管家用它测 AiController 时，JWT 鉴权和 @PreAuthorize 的租户隔离逻辑是如何被纳入或不纳入测试范围的？
  - **答**：这个前提要先更正：classpath 上有 spring-security 时，@WebMvcTest 会照常装配 SecurityAutoConfiguration 和默认 SecurityFilterChain，并不是"不加载过滤器链"——没导入自定义链时，所有请求会一律 401，而不是跳过鉴权。真正不生效的是**方法级鉴权**：@WebMvcTest 不会导入带 @EnableMethodSecurity 的配置类，@PreAuthorize 因此静默失效。想把安全过滤链彻底关掉，要显式写 @AutoConfigureMockMvc(addFilters = false)。
    - 做法：
      - ① @WebMvcTest + @Import({SecurityConfig.class, MethodSecurityConfig.class 带 @EnableMethodSecurity}) + @WithMockUser/@WithAnonymousUser 模拟认证，验证 @PreAuthorize 生效
      - ② 租户隔离（数据权限切面）若依赖 Interceptor 需一并导入相关配置
      - ③ 或用 @SpringBootTest 做更真实鉴权集成测试，@WebMvcTest 仅单元测控制器
- 追问2：测试切片各自独立启动，若 @JsonTest 验证的 ChatResponse 字段契约与前端实际消费字段不一致，如何把契约测试与前端接口定义（如 OpenAPI）联动起来？
  - **答**：
    - ① @JsonTest 只验证序列化/反序列化，不验证前端消费。联动：用 OpenAPI（springdoc）作单一事实源，前端按 openapi.yaml 生成客户端/类型，后端 CI 用 openapi-generator/assertj 校验 ChatResponse 与 OpenAPI 一致
    - ② 加契约测试（Spring Cloud Contract/Pact）由前端定义期望、后端验证
    - ③ 字段变更同步改 OpenAPI 并由 CI 阻断不一致

### 44. AI服务测试策略：Mock LLM、向量库与集成测试
**重要度**：★★★

**题目：**
请设计碳管家AI助手的完整测试策略，包括单元测试、集成测试、端到端测试，以及如何Mock LLM调用和向量库检索进行可控测试。

**解答：**
AI系统测试的挑战在于大模型输出的不确定性和外部依赖的不可控性。需要建立多层次的测试体系：

**第一层：纯单元测试（无Spring上下文）**
测试不依赖Spring容器的工具类和纯逻辑方法。使用JUnit 5 + Mockito，不启动ApplicationContext。

**第二层：切片测试（@WebMvcTest/@DataJpaTest）**
测试各层独立行为。Controller层Mock Service，Service层Mock外部依赖。

**第三层：集成测试（@SpringBootTest + @MockitoBean）**
启动完整ApplicationContext但Mock外部服务（ChatClient、Milvus）。测试组件间协作。

**第四层：契约测试**
验证AI Prompt模板和响应格式的稳定性。使用WireMock Mock 大模型 API（自部署 GLM 走 vLLM 的 OpenAI 兼容端点），验证ChatClient的请求格式和响应解析。

**第五层：端到端测试（Testcontainers）**
使用Testcontainers启动真实Milvus和PostgreSQL，测试完整的RAG流程。

```java
// 策略1: Mock LLM返回可控响应
public class CarbonChatServiceUnitTest {

    @Mock
    private ChatClient chatClient;
    @Mock
    private ChatClient.ChatClientRequestSpec requestSpec;
    @Mock
    private ChatClient.CallResponseSpec responseSpec;
    @Mock
    private VectorStore vectorStore;

    @InjectMocks
    private CarbonChatService chatService;

    @Test
    void shouldBuildCorrectPromptWithRetrievalResults() {
        // Given: Mock向量检索返回碳法规片段
        List<RetrievalResult> results = List.of(
            new RetrievalResult("范围1排放包含直接温室气体排放", 0.95, "LAW")
        );
        when(vectorStore.similaritySearch(any(SearchRequest.class)))
            .thenReturn(results);

        // Mock ChatClient链式调用
        when(chatClient.prompt(anyString())).thenReturn(requestSpec);
        when(requestSpec.call()).thenReturn(responseSpec);
        when(responseSpec.content())
            .thenReturn("碳排放范围1指企业直接温室气体排放。");

        // When
        String answer = chatService.chat(
            CarbonUser.builder().tenantId(1L).build(), "什么是范围1排放？");

        // Then: 验证Prompt包含检索结果
        ArgumentCaptor<String> promptCaptor = ArgumentCaptor.forClass(String.class);
        verify(chatClient).prompt(promptCaptor.capture());
        assertThat(promptCaptor.getValue()).contains("范围1排放包含直接温室气体排放");
        assertThat(answer).contains("直接温室气体排放");
    }
}

// 策略2: WireMock契约测试 - 验证大模型 API调用格式
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
class OpenAiContractTest {

    @RegisterExtension
    static WireMockExtension wireMock = WireMockExtension.newInstance()
        .options(wireMockConfig().dynamicPort())
        .build();

    @Test
    void shouldCallOpenAiApiWithCorrectFormat() {
        // Given: WireMock模拟大模型 API
        wireMock.stubFor(post(urlEqualTo("/v1/chat/completions"))
            .willReturn(aResponse()
                .withHeader("Content-Type", "application/json")
                .withBody("""
                    {
                        "id": "chatcmpl-123",
                        "choices": [{
                            "message": {
                                "role": "assistant",
                                "content": "碳排放范围1指直接排放。"
                            }
                        }],
                        "usage": {"prompt_tokens": 50, "completion_tokens": 20, "total_tokens": 70}
                    }
                    """)));

        // When: 创建指向WireMock的ChatClient
        // 【API 纠错】Spring AI 没有 OpenAiChatClient 这个类，链路是
        // OpenAiApi（持有 baseUrl/apiKey）→ OpenAiChatModel（持有 api + defaultOptions）→ ChatClient.create(model)
        OpenAiApi openAiApi = OpenAiApi.builder()
            .baseUrl(wireMock.getRuntimeInfo().getHttpBaseUrl())
            .apiKey("test-key")
            .build();

        OpenAiChatModel chatModel = OpenAiChatModel.builder()
            .openAiApi(openAiApi)
            // 必须给 defaultOptions，否则请求体里没有 model，下面的 $.model 断言必挂
            .defaultOptions(OpenAiChatOptions.builder().model("gpt-4o-mini").build())
            .build();

        ChatClient client = ChatClient.create(chatModel);

        String response = client.prompt("碳法规问题").call().content();

        // Then: 验证请求格式正确
        wireMock.verify(postRequestedFor(urlEqualTo("/v1/chat/completions"))
            .withHeader("Authorization", equalTo("Bearer test-key"))
            .withHeader("Content-Type", equalTo("application/json"))
            .withRequestBody(matchingJsonPath("$.model"))
            .withRequestBody(matchingJsonPath("$.messages[0].role", equalTo("user"))));

        assertThat(response).isEqualTo("碳排放范围1指直接排放。");
    }
}

// 策略3: Testcontainers端到端测试
@SpringBootTest
@Testcontainers
class CarbonAiE2ETest {

    // 【修正】Milvus standalone 不是单容器就能起：裸跑官方镜像时它依赖 etcd（元数据）和 MinIO（对象存储），
    // 连不上 etcd 会直接退出，E2E 测试一直卡在容器启动。这里用 Network 串起三件套并固定版本号。
    // 更省事的替代：官方模块 org.testcontainers:milvus:1.21.3 的 MilvusContainer，
    // 它内部用 ETCD_USE_EMBED + COMMON_STORAGETYPE=local，才是真正的单容器。
    // 无论哪种都别用 :latest，否则版本不可复现。
    static Network network = Network.newNetwork();

    @Container
    static GenericContainer<?> etcd = new GenericContainer<>("quay.io/coreos/etcd:v3.5.14")
        .withNetwork(network)
        .withNetworkAliases("etcd")
        .withCommand("etcd", "-advertise-client-urls=http://etcd:2379",
                     "-listen-client-urls=http://0.0.0.0:2379")
        .withExposedPorts(2379);

    @Container
    static GenericContainer<?> minio = new GenericContainer<>("minio/minio:RELEASE.2023-03-20T20-16-18Z")
        .withNetwork(network)
        .withNetworkAliases("minio")
        .withEnv("MINIO_ACCESS_KEY", "minioadmin")
        .withEnv("MINIO_SECRET_KEY", "minioadmin")
        .withCommand("minio", "server", "/minio_data")
        .withExposedPorts(9000);

    @Container
    static GenericContainer<?> milvus = new GenericContainer<>("milvusdb/milvus:v2.4.15")
        .withNetwork(network)
        .withNetworkAliases("milvus")
        .withCommand("milvus", "run", "standalone")
        .withEnv("ETCD_ENDPOINTS", "etcd:2379")
        .withEnv("MINIO_ADDRESS", "minio:9000")
        .withExposedPorts(19530, 9091)
        // 端口通≠就绪：standalone 启动要 30~60s，等 /healthz 才稳，否则首个用例必挂
        .waitingFor(Wait.forHttp("/healthz").forPort(9091)
            .withStartupTimeout(Duration.ofMinutes(3)))
        .dependsOn(etcd, minio);

    @Container
    static PostgreSQLContainer<?> postgres = new PostgreSQLContainer<>("postgres:15");

    @Test
    void shouldPerformRagSearch_endToEnd() {
        // 使用真实的Milvus和PostgreSQL进行端到端测试
        // 1. 向Milvus插入碳法规向量
        // 2. 调用AI助手查询
        // 3. 验证检索结果和AI回答
    }
}
```

**AI/碳管理场景关联：**
碳管家AI助手的测试策略确保AI功能质量的同时控制测试成本：单元测试Mock ChatClient验证Prompt构建逻辑和检索结果处理；契约测试使用WireMock验证大模型 API的请求/响应格式，确保SDK升级不破坏兼容性；端到端测试使用Testcontainers启动真实Milvus验证向量检索准确性，但仅在发布前运行。通过捕获ChatClient.prompt的参数验证Prompt包含碳法规检索片段，确保RAG流程正确工作。

---

#### 追问：
- 追问1：用 WireMock 做契约测试时，若通义千问原生 API 与自部署 GLM(vLLM OpenAI 兼容端点) 的响应 Schema 不同，契约测试是否覆盖了多供应商的差异化解析？
  - **答**：应覆盖。不同供应商响应 Schema 不同（通义千问原生格式 vs OpenAI 兼容端点格式），纯 Mock 单一格式不能保证其他解析正确。
    - 做法：
      - ① 为每个 provider 建独立 WireMock stub（按响应结构）测其解析器
      - ② 抽象统一 ResponseAdapter，契约测试验证各 provider→统一内部模型映射
      - ③ CI 矩阵测试所有启用 provider
      - ④ 供应商升级时更新 stub 并回归，防解析断裂
- 追问2：大模型输出具有不确定性，纯断言 AI 回答文本内容的测试会不稳定，碳管家如何对 RAG 回答做"软断言"（如只验证引用来源存在、不验证措辞）？
  - **答**：用软断言。
    - ① 不断言固定文本，改断言结构：引用法规来源是否存在、是否来自知识库、是否含关键字段
    - ② 对答案用语义/关键词匹配（如"是否提及 CBAM"、"是否给出排放因子"）
    - ③ 用确定性 RAG 检索子集做断言（检索到的 chunk 正确），生成部分只验格式与引用
    - ④ 记录回答做人工抽检
    - ⑤ 用固定 seed/温度=0 提升可复现，但仍以软断言为主
- 追问3：Testcontainers 起真实 Milvus 做端到端测试，Embedding 模型一致性如何保证，不同 Embedding 版本生成的向量会不会让检索断言不可重现？
  - **答**：保证可重现：
    - ① Embedding 模型固定版本（如 bge-large-zh-v1.5 v1.5），容器与测试同版本同维度
    - ② 测试用固定语料建索引，断言基于"已知向量应被检索到"而非随机
    - ③ 版本升级同步更新测试基线与断言阈值
    - ④ 用本地/离线 Embedding 模型（不调外部 API）保证稳定
    - ⑤ 向量相似度用阈值断言，容忍微小浮点差异

#### 十二、Spring Boot 监控

### 45. Spring Boot Actuator端点配置与安全
**重要度**：★★★★

**题目：**
请说明Spring Boot Actuator的核心端点（health、info、metrics、env、loggers等），如何配置端点暴露策略和安全控制，以及在碳管理SaaS生产环境中的最佳实践。

**解答：**
Spring Boot Actuator提供生产级监控端点，通过HTTP或JMX暴露应用运行时信息。

**核心端点：**
- /actuator/health：应用健康状态，包含数据库、Redis、Milvus等组件健康检查。
- /actuator/info：应用信息（版本、构建时间等）。
- /actuator/metrics：Micrometer指标数据（JVM、HTTP请求、自定义指标）。
- /actuator/env：环境变量和配置属性（敏感信息默认脱敏）。
- /actuator/loggers：运行时动态调整日志级别。
- /actuator/heapdump：生成堆转储文件（用于内存分析）。
- /actuator/threaddump：线程转储。
- /actuator/mappings：所有URL映射。
- /actuator/beans：所有Spring Bean列表。
- /actuator/configprops：所有@ConfigurationProperties配置。

**安全配置最佳实践：**
health/info 匿名可访问；metrics、prometheus 仅内网 + 认证；loggers、env、beans、heapdump、threaddump 默认不暴露，排障时临时开启（loggers 尤其危险：未认证就能把任意包改成 DEBUG，既刷盘又可能把敏感信息打进日志）。

```yaml
# application-prod.yml
management:
  endpoints:
    web:
      exposure:
        include: health,info,metrics,prometheus  # 仅暴露必要端点（loggers 等排障时临时开）
        exclude: env,beans,heapdump,threaddump   # 禁止暴露敏感端点
      base-path: /manage  # 修改默认路径，避免被扫描（改了之后所有端点路径都跟着变，探针也要改）
  endpoint:
    health:
      show-details: when-authorized  # 认证后才显示详细健康信息
      show-components: when-authorized
      probes:
        enabled: true  # 启用K8s存活/就绪探针
    loggers:
      enabled: true    # 允许运行时调整日志级别
  metrics:
    tags:
      application: carbon-ai-assistant
      tenant: ${carbon.tenant.id:unknown}
    distribution:
      percentiles-histogram:
        http.server.requests: true
        carbon.ai.invocation.duration: true
      percentiles:
        http.server.requests: 0.5,0.95,0.99
```

```java
// 自定义健康检查：AI服务健康指标
@Component
public class CarbonAiHealthIndicator implements HealthIndicator {

    @Autowired
    private ChatClient chatClient;
    @Autowired
    private MilvusVectorStore vectorStore;
    @Autowired
    private TokenQuotaService quotaService;

    @Override
    public Health health() {
        Health.Builder builder = Health.up();
        Map<String, Object> details = new LinkedHashMap<>();

        // 检查大模型连通性
        try {
            long start = System.currentTimeMillis();
            String response = chatClient.prompt("ping").call().content();
            long latency = System.currentTimeMillis() - start;
            details.put("aiModel", Map.of(
                "status", "UP",
                "latency", latency + "ms",
                "response", response != null ? "ok" : "empty"
            ));
        } catch (Exception e) {
            builder.down();
            details.put("aiModel", Map.of("status", "DOWN", "error", e.getMessage()));
        }

        // 检查Milvus向量库连通性
        try {
            long count = vectorStore.count();
            details.put("vectorStore", Map.of(
                "status", "UP",
                "vectorCount", count
            ));
        } catch (Exception e) {
            builder.down();
            details.put("vectorStore", Map.of("status", "DOWN", "error", e.getMessage()));
        }

        // 检查租户配额服务
        try {
            boolean quotaServiceOk = quotaService.isHealthy();
            details.put("quotaService", Map.of("status", quotaServiceOk ? "UP" : "DOWN"));
            if (!quotaServiceOk) builder.down();
        } catch (Exception e) {
            builder.down();
            details.put("quotaService", Map.of("status", "DOWN", "error", e.getMessage()));
        }

        return builder.withDetails(details).build();
    }
}
```

**AI/碳管理场景关联：**
碳管家AI助手的生产监控通过Actuator实现：生产配置已把 `management.endpoints.web.base-path` 改成 /manage，探针路径必须同步改成 /manage/health/readiness（就绪，检查ChatClient和Milvus是否可用）与 /manage/health/liveness（存活），照默认的 /actuator/health/* 配会 404、Pod 永远不 Ready。自定义CarbonAiHealthIndicator在健康检查中验证大模型API连通性、Milvus向量库可用性和Token配额服务状态。当大模型API不可达时，健康状态变为DOWN，K8s自动重启Pod或将Pod从Service中摘除，避免请求路由到不可用的AI服务实例。

---

#### 追问：
- 追问1：CarbonAiHealthIndicator 每次健康检查都真实调用 ChatClient.prompt("ping")，高频探针会不会反而消耗 Token 并污染对话日志，是否有更轻量的健康探测方式？
  - **答**：会。每次探针真实调 LLM 既耗 Token 又往对话日志写 ping 记录。
    - 轻量探测：
      - ① health 只查连通性（Milvus ping、HTTP HEAD 到模型网关、连接池健康），不真正调 generate
      - ② 或用极短/无 Token 的模型网关健康检查接口（如 /v1/models 列表）验可达
      - ③ 探活与业务调用分离，探针调用不写业务对话日志
      - ④ 探针低频 + 缓存健康结果（如每 30s 探一次）
- 追问2：health 端点 show-details=when-authorized，若 K8s 探针使用的 ServiceAccount 拿不到授权，就绪探针会一直失败导致 Pod 无法接入流量，如何平衡安全与可用性？
  - **答**：会。若 K8s 探针用的 ServiceAccount/身份拿不到 health 详情授权，readiness 一直失败→Pod 不接流量→全部不可用。
    - 平衡：
      - ① K8s 探针只需 /health/readiness 返回 200，不应要求 authorized 详情，details 仅对人工/运维端点开启
      - ② 探针端点设无需授权（或单独无详情端点），show-details 仅作用于 /manage/health 完整视图
      - ③ 探针路径与鉴权解耦，可用性优先
- 追问3：自定义健康里把 Milvus 不可达直接 builder.down()，但碳管家已设计了向量检索降级到关键词检索，是否应该让"检索降级可用"也算 UP 而非 DOWN？
  - **答**：应算 UP（降级可用）。若已设计向量检索降级到关键词检索，Milvus 不可达不应直接 builder.down() 让 Pod 被摘流——否则失去降级能力、整体不可用。
    - 改进：
      - ① health 区分组件：Milvus 组件 status=DOWN 但整体 status=UP（withDegraded("vector search degraded to keyword")）
      - ② 设独立 indicator 报 Milvus 状态，整体健康取"核心可用"为准
      - ③ 仅当核心（如 ChatClient 网关）不可达才 DOWN

### 46. Micrometer指标体系与Prometheus集成
**重要度**：★★★★

**题目：**
请设计碳管家AI助手的Micrometer指标体系，包括AI调用指标、检索指标、租户维度指标，并说明如何与Prometheus + Grafana集成实现可视化监控。

**解答：**
Micrometer是Spring Boot的指标门面（类似SLF4J之于日志），提供与厂商无关的指标API，支持Prometheus、Datadog、New Relic等多种监控系统。

**指标类型：**
- Counter（计数器）：单调递增，如AI调用次数、错误次数。
- Gauge（仪表盘）：瞬时值，如当前活跃对话数、Milvus连接数。
- Timer（计时器）：记录耗时分布，如AI调用延迟、向量检索延迟。
- Distribution Summary（分布摘要）：记录事件分布，如Token使用量分布。

**Gauge 两个必踩的坑**：① 它只持**弱引用**，绑一个匿名/局部对象会被 GC 掉，读数变 0，必须由 Bean 字段强引用；② `gauge(name, tags, 数值)` 在 id 已存在时**直接返回旧实例、忽略新对象**，所以"每次用新值重新注册"永远不生效——要更新值只能改原来那个对象，比率类指标更推荐用两个 Counter 相除。

**指标命名规范**：carbon.ai.{module}.{metric}，如carbon.ai.chat.duration、carbon.ai.retrieval.latency。

```java
@Service
public class CarbonAiMetricsRecorder {

    private final MeterRegistry registry;

    // 【关键】gauge 只持弱引用：如果绑定的是个没人引用的临时对象，GC 一收，读数就变 0。
    // 所以活跃对话数必须用类字段（强引用）持有，gauge 只注册一次，业务侧 inc/dec 这个字段
    private final AtomicInteger activeConversations = new AtomicInteger(0);

    public CarbonAiMetricsRecorder(MeterRegistry registry) {
        this.registry = registry;
    }

    // AI调用指标
    public void recordAiInvocation(String model, String tenantId, String method,
                                    boolean success, long durationMs, int tokens) {
        Tags tags = Tags.of(
            "model", model,
            "tenant", tenantId,
            "method", method,
            "status", success ? "success" : "failure"
        );

        // 调用次数
        registry.counter("carbon.ai.invocation.count", tags).increment();

        // 调用耗时
        registry.timer("carbon.ai.invocation.duration", tags)
            .record(durationMs, TimeUnit.MILLISECONDS);

        // Token消耗
        registry.counter("carbon.ai.tokens.used", tags).increment(tokens);

        // 调用结果状态
        if (!success) {
            registry.counter("carbon.ai.invocation.error", tags).increment();
        }
    }

    // 检索指标
    public void recordRetrieval(String source, String tenantId,
                                 int resultCount, long latencyMs, boolean fromCache) {
        Tags tags = Tags.of(
            "source", source,
            "tenant", tenantId,
            "cache_hit", String.valueOf(fromCache)
        );

        registry.counter("carbon.ai.retrieval.count", tags).increment();
        registry.timer("carbon.ai.retrieval.latency", tags)
            .record(latencyMs, TimeUnit.MILLISECONDS);
        // 每次检索返回的条数是个分布，不是"当前值"，用 DistributionSummary 才能统计 count/sum/max；
        // 用 gauge(name, tags, 数值) 只会注册一次并永久停在第一次的值
        registry.summary("carbon.ai.retrieval.results", tags).record(resultCount);
    }

    // 实时状态指标（Gauge）
    public void registerGauges() {
        // 活跃对话数：绑定字段本身（强引用，不会被 GC），值由 onConversationStart/End 维护
        registry.gauge("carbon.ai.conversations.active", activeConversations, AtomicInteger::get);
        // Milvus连接池使用率
        registry.gauge("carbon.ai.milvus.connections.active", milvusPool, pool -> pool.getActiveCount());
        // 各租户剩余配额
        registry.gauge("carbon.ai.quota.remaining", tenantQuotaMap,
            map -> map.values().stream().mapToLong(Long::longValue).sum());
    }

    // 对话开始/结束时改字段值，gauge 自己会读
    public void onConversationStart() {
        activeConversations.incrementAndGet();
    }

    public void onConversationEnd() {
        activeConversations.decrementAndGet();
    }

    // 大模型成本追踪
    public void recordAiCost(String tenantId, String model, BigDecimal cost) {
        Tags tags = Tags.of("tenant", tenantId, "model", model);
        registry.counter("carbon.ai.cost.total", tags).increment(cost.doubleValue());
    }
}

// Prometheus配置
// application.yml（Boot 3+：management.metrics.export.* 整组已移除，
// Prometheus 专属配置迁到 management.prometheus.metrics.export.*，写旧键不报错但静默不生效）
// management:
//   prometheus:
//     metrics:
//       export:
//         enabled: true      // 默认就是 true，可省
//         step: 30s
//   endpoints:
//     web:
//       exposure:
//         include: health,info,metrics,prometheus
```

**Grafana看板设计（PromQL示例）：**
```
# AI调用QPS（按模型分组）
rate(carbon_ai_invocation_count_total[1m])

# AI调用P95延迟
histogram_quantile(0.95, rate(carbon_ai_invocation_duration_seconds_bucket[5m]))

# 各租户Token消耗排行
topk(10, sum by (tenant) (rate(carbon_ai_tokens_used_total[1h])))

# AI错误率
rate(carbon_ai_invocation_error_total[5m]) / rate(carbon_ai_invocation_count_total[5m])

# Milvus检索延迟P99
histogram_quantile(0.99, rate(carbon_ai_retrieval_latency_seconds_bucket[5m]))

# AI服务日均成本
sum by (tenant) (increase(carbon_ai_cost_total[24h]))
```

**AI/碳管理场景关联：**
碳管家AI助手通过Micrometer + Prometheus + Grafana构建完整的监控体系：Grafana看板实时展示AI调用QPS、P95延迟、Token消耗趋势、各租户使用量排行和日均API成本。当AI调用错误率超过5%时触发Alertmanager告警，通过钉钉/企业微信通知运维团队。租户维度的Token消耗排行帮助商务团队识别高频使用客户，为续约和升级提供数据支撑。通过PromQL查询carbon_ai_retrieval_latency_seconds识别Milvus检索瓶颈，指导向量索引优化。

---

#### 追问：
- 追问1：carbon.ai.invocation.duration 用 Timer 记录耗时，但大模型流式输出首字与完整回答的延迟语义不同，指标是记总耗时还是也记首字延迟（TTFT）？
  - **答**：都应记。流式下"首字延迟 TTFT"与"完整回答耗时"语义不同，都关键。
    - ① Timer 记端到端总耗时
    - ② 额外用另一 Timer/直方图记 TTFT（请求发起到首个 chunk 到达）
    - ③ TTFT 反映用户体感（首字快），总耗时反映吞吐
    - ④ 按模型/租户打标，分别设告警（TTFT>某值、总耗时>某值），更准定位"卡推理"还是"卡传输"
- 追问2：按租户维度打 Tag 后，高基数租户会导致 Prometheus 时间序列爆炸，碳管家如何做租户维度聚合同时又避免 cardinality 灾难？
  - **答**：会爆炸。按租户打 tag 若租户数多（数千企业），Prometheus 时间序列随 tag 组合爆炸，内存/存储暴涨。
    - 控制：
      - ① 租户维度不进 Prometheus 高基数 label，改为"租户分桶"（大/中/小客户）或仅对 Top N 租户打明细 tag
      - ② 用量计数用计数器不含租户，或租户维度放日志/旁路系统聚合
      - ③ 用 Recording Rules 预聚合
      - ④ 租户指标走日志+ELK 聚合，Prometheus 只留全局与分桶
- 追问3：AI 调用错误率超 5% 告警，但"错误"是否区分了业务错误（如配额超限）与基础设施错误（Milvus 宕机），不同错误类型的处置是否应不同？
  - **答**：应区分。
    - ① 错误类型分维：配额超限（业务/预期）、Milvus 宕机（基础设施）、模型超时（上游）分别打 error_type tag
    - ② 告警按类型设不同阈值与处置：基础设施错误高优告警+自动降级，业务错误走配额通知而非系统告警
    - ③ 错误率指标按 error_type 拆分，避免"配额超限"稀释真实故障信号
    - ④ 告警路由：基础设施→oncall，业务→运营

### 47. 自定义Metrics与业务指标监控
**重要度**：★★★★

**题目：**
请设计碳管家AI助手的业务指标监控体系，包括AI回答质量评分、用户满意度、碳法规检索准确率、模型幻觉率等业务指标的采集与监控。

**解答：**
技术指标（QPS、延迟）关注系统健康度，业务指标关注AI服务质量。需要设计自定义业务指标采集机制。

```java
@Service
public class CarbonAiBusinessMetrics {

    private final MeterRegistry registry;
    private final AiQualityRepository qualityRepo;

    // 满意度按租户的最新值：用强引用 Map 持有，gauge 只绑它、每次只改值
    private final Map<String, Double> avgRatingByTenant = new ConcurrentHashMap<>();
    // 每日活跃用户数：同样用强引用字段持有
    private final AtomicLong dailyActiveUsers = new AtomicLong(0);

    // AI回答质量评分（用户反馈）
    public void recordUserFeedback(String sessionId, String tenantId,
                                    int rating, String feedback) {
        Tags tags = Tags.of("tenant", tenantId, "rating", String.valueOf(rating));
        registry.counter("carbon.ai.feedback.count", tags).increment();

        // 记录详细反馈到数据库，用于后续分析
        qualityRepo.save(AiFeedback.builder()
            .sessionId(sessionId)
            .tenantId(Long.valueOf(tenantId))
            .rating(rating) // 1-5分
            .feedback(feedback)
            .build());

        // 更新满意度Gauge
        // 【坑】gauge(name, tags, 数值) 只在首次注册时生效：Micrometer 遇到同名同 tag 的 gauge
        // 会直接返回已有实例、忽略这次传入的新对象，满意度会永久停在第一次采到的值。
        // 正确做法一：用类字段（强引用）持有最新值，gauge 只绑一次、业务侧改字段值
        double avgRating = qualityRepo.getAverageRating(tenantId);
        avgRatingByTenant.put(tenantId, avgRating);
        registry.gauge("carbon.ai.satisfaction.score",
            Tags.of("tenant", tenantId), avgRatingByTenant,
            map -> map.getOrDefault(tenantId, 0.0));
    }

    // 检索准确率指标（基于用户是否采纳AI回答）
    public void recordRetrievalAccuracy(String tenantId, String sessionId,
                                         boolean adopted, int retrievedCount) {
        Tags tags = Tags.of("tenant", tenantId, "adopted", String.valueOf(adopted));
        registry.counter("carbon.ai.retrieval.adoption", tags).increment();
    }

    // 模型幻觉检测指标
    public void recordHallucination(String tenantId, String model,
                                      boolean detected, String detail) {
        Tags tags = Tags.of(
            "tenant", tenantId,
            "model", model,
            "hallucination", String.valueOf(detected)
        );
        registry.counter("carbon.ai.hallucination.check", tags).increment();

        if (detected) {
            log.warn("检测到AI幻觉: tenant={}, detail={}", tenantId, detail);
            // 触发告警
        }
    }

    // AI回答分类统计
    public void recordAnswerCategory(String tenantId, String category) {
        registry.counter("carbon.ai.answer.category",
            Tags.of("tenant", tenantId, "category", category)).increment();
    }

    // 碳法规引用准确率
    public void recordLawCitationAccuracy(String tenantId, int totalCitations,
                                           int verifiedCitations) {
        // 比率类指标更好的做法：分子分母各一个 Counter，在 PromQL 里 rate(分子)/rate(分母)，
        // 这样能按时间窗口看趋势；只用 gauge 存当前比率的话，同名同 tag 重复注册会被忽略、值不会更新
        Tags tags = Tags.of("tenant", tenantId);
        registry.counter("carbon.ai.law.citation.total", tags).increment(totalCitations);
        registry.counter("carbon.ai.law.citation.verified", tags).increment(verifiedCitations);
    }

    // 每日AI对话活跃用户数
    @Scheduled(cron = "0 0 * * * *") // 每小时统计
    public void recordDailyActiveUsers() {
        // 同上：gauge 首次注册后就用它绑的那个对象，重复传新数值是空操作。
        // 用字段强引用 + gauge 只绑一次（在 @PostConstruct 里注册），定时任务只更新字段值
        dailyActiveUsers.set(qualityRepo.countDailyActiveUsers());
    }

    @PostConstruct
    void bindGauges() {
        registry.gauge("carbon.ai.daily.active.users", dailyActiveUsers, AtomicLong::get);
    }
}

// 幻觉检测服务（简化版）
@Service
public class HallucinationDetector {

    @Autowired
    private CarbonLawRepository lawRepo;
    @Autowired
    private CarbonAiBusinessMetrics metrics;

    public void checkHallucination(String tenantId, String model,
                                     String question, String answer,
                                     List<RetrievalResult> sources) {
        // 1. 检查AI回答中的碳法规引用是否存在于知识库中
        List<String> citedLaws = extractLawCitations(answer);
        int verified = 0;
        for (String citation : citedLaws) {
            if (lawRepo.existsByCitation(citation)) {
                verified++;
            }
        }

        // 2. 如果引用的法规无法验证，可能是幻觉
        boolean hasHallucination = !citedLaws.isEmpty() && verified < citedLaws.size();

        // 3. 检查回答是否包含来源中不存在的事实性陈述
        boolean hasUnsupportedClaim = checkUnsupportedClaims(answer, sources);

        boolean detected = hasHallucination || hasUnsupportedClaim;

        metrics.recordHallucination(tenantId, model, detected,
            detected ? "法规引用不匹配或无来源支持" : "验证通过");
    }
}
```

**AI/碳管理场景关联：**
碳管家AI助手的业务指标体系关注AI服务质量而非仅技术指标：用户满意度评分（1-5分）通过对话结束后引导用户评分采集，追踪AI回答质量趋势；检索采纳率（用户是否采纳AI提供的碳法规信息）反映RAG检索的准确性；模型幻觉检测通过验证AI回答中引用的碳法规是否真实存在于知识库，识别大模型"编造"法规条款的风险；碳法规引用准确率（验证通过的引用/总引用）确保AI提供的法规信息可信。当幻觉率超过3%时触发告警，运维团队可临时切换到更保守的Prompt模板或降级为仅返回检索结果不加AI总结。

---

#### 追问：
- 追问1：幻觉检测靠"回答中引用的法规是否在知识库存在"，但若 AI 没显式引用法规而是用隐晦表述编造事实，这种无引用幻觉如何被识别和计分？
  - **答**：难但有法。
    - ① 对隐晦表述做"事实可溯性"检查：把回答拆句，对每句做检索召回验证（sentence-level grounding）看知识库是否有支撑
    - ② 用 NLI/置信度模型判断回答与检索片段一致性
    - ③ 要求模型输出必带引用（强制 cite），无引用句降权/标记"未经证实"
    - ④ 用独立校验模型对关键数值/法规二次核对
    - ⑤ 无引用且高自信断言打低分，触发人工复核
- 追问2：检索采纳率基于"用户是否采纳"，碳管家前端如何定义采纳动作（点赞/复制/继续追问），采纳信号噪声大时指标是否可信？
  - **答**：定义要清晰。
    - ① 采纳动作应明确：复制回答、点"有用"、基于回答继续操作（如导出报告）算采纳；误触/随便点赞是噪声
    - ② 降低噪声：用"显式有用/无用"二元 + 后续行为（是否据答案执行）加权
    - ③ 排除自动触发
    - ④ 采纳信号结合"问题类型"分层看，避免某类拉低整体
    - ⑤ 长期用 A/B 看采纳率变化而非单点
- 追问3：满意度评分是事后引导用户打 1-5 分，参与评分的用户本身可能就是满意或不满意的极端人群，如何避免评分分布偏差误导模型优化方向？
  - **答**：会偏差。评分者多为"很满意/很不满意"两端，中间用户沉默，均值误导优化。
    - 缓解：
      - ① 不只看均值，看分布与样本量，低样本时不下结论
      - ② 主动抽样邀请中性用户评分
      - ③ 结合行为指标（采纳率、复访、任务完成率）综合评估，不单靠满意度
      - ④ 对差评做根因分类（模型/检索/产品）定向优化
      - ⑤ 用 NPS 类相对指标辅助

### 48. 分布式追踪集成与AI调用链分析
**重要度**：★★★★

**题目：**
请说明如何在碳管家AI助手中集成Micrometer Tracing + Zipkin实现分布式追踪，重点分析AI调用链（用户请求→RAG检索→大模型调用→响应）的Trace设计与性能分析。

**解答：**
分布式追踪通过Trace ID串联请求在微服务间的完整调用链。Spring Boot 3.x使用Micrometer Tracing替代Spring Cloud Sleuth，支持Zipkin、SkyWalking等追踪后端。

**AI调用链的Span设计：**
- Root Span：carbon-ai.chat（用户AI问答请求）
  - Child Span：carbon-ai.rag.retrieve（RAG检索）
    - Child Span：carbon-ai.milvus.search（Milvus向量搜索）
    - Child Span：carbon-ai.law.query（碳法规数据库查询）
  - Child Span：carbon-ai.llm.invoke（大模型调用）
    - Child Span：carbon-ai.llm.http（大模型 HTTP请求）
  - Child Span：carbon-ai.response.build（响应构建）
  - Child Span：carbon-ai.audit.log（审计日志记录）

```java
@Configuration
public class TracingConfig {
    // application.yml:
    // management:
    //   tracing:
    //     sampling:
    //       probability: 1.0  // 采样率（生产环境可设为0.1）
    //   zipkin:
    //     tracing:
    //       endpoint: http://zipkin:9411/api/v2/spans

    // 【前提】@Observed 靠 ObservedAspect 织入，不注册这个 Bean，注解只会静默失效、一个 Span 都不产生
    @Bean
    public ObservedAspect observedAspect(ObservationRegistry registry) {
        return new ObservedAspect(registry);
    }
}

@Service
@Observed  // Spring Boot 3.x自动创建Span
public class CarbonChatService {

    @Autowired
    private ChatClient chatClient;
    @Autowired
    private VectorStore vectorStore;
    @Autowired
    private Tracer tracer;

    @Observed(name = "carbon.ai.chat",
              contextualName = "AI问答",
              lowCardinalityKeyValue = {"type", "rag"})
    public ChatResponse chat(CarbonUser user, String question) {
        // 1. RAG检索（自动创建子Span）
        List<RetrievalResult> results = retrieveWithContext(question, user.getTenantId());

        // 2. 构建Prompt
        String prompt = buildPrompt(question, results);

        // 3. 调用大模型（手动创建子Span记录详细信息）
        Span llmSpan = tracer.nextSpan().name("carbon.ai.llm.invoke")
            .tag("model", "qwen-max")
            .tag("tenant", user.getTenantId().toString())
            .tag("prompt.length", String.valueOf(prompt.length()))
            .start();
        try (Tracer.SpanInScope scope = tracer.withSpan(llmSpan)) {
            String answer = chatClient.prompt(prompt).call().content();
            llmSpan.tag("answer.length", String.valueOf(answer.length()));
            return new ChatResponse(answer, results, generateSessionId());
        } catch (Exception e) {
            llmSpan.tag("error", e.getClass().getSimpleName());
            llmSpan.error(e);
            throw e;
        } finally {
            llmSpan.end();
        }
    }

    // 【修正】@Observed 是 AOP 环绕，private 方法无法被代理拦截，Span 永远出不来——必须是 public（或至少包可见，且走代理调用）
    // 若不想改可见性，就在方法体内用 observationRegistry.getObservationRegistry 手动埋点：
    //   Observation.createNotStarted("carbon.ai.rag.retrieve", registry).observe(() -> ...)
    @Observed(name = "carbon.ai.rag.retrieve", contextualName = "RAG检索")
    public List<RetrievalResult> retrieveWithContext(String query, Long tenantId) {
        // Milvus检索会自动通过ObservationHandler创建子Span
        return vectorStore.similaritySearch(
            SearchRequest.builder()
                .query(query)
                .topK(5)
                .filterExpression("tenant_id == " + tenantId)
                .build()
        );
    }
}

// 自定义ObservationHandler：在Span中添加AI专属信息
@Component
public class CarbonAiObservationHandler implements ObservationHandler<Observation.Context> {

    @Override
    public boolean supportsContext(Observation.Context context) {
        return context.getName().startsWith("carbon.ai");
    }

    @Override
    public void onStart(Observation.Context context) {
        // 在Span开始时记录AI调用上下文
        context.addLowCardinalityKeyValue(KeyValue.of("ai.service", "carbon-assistant"));
    }

    @Override
    public void onStop(Observation.Context context) {
        // 在Span结束时记录额外信息
        if (context.getError() != null) {
            context.addLowCardinalityKeyValue(KeyValue.of("ai.error", "true"));
        }
    }
}
```

**AI/碳管理场景关联：**
通过分布式追踪，碳管家AI助手在Zipkin中可视化展示完整的AI调用链：用户发起碳法规问答→RAG检索（Milvus向量搜索3个法规片段，耗时200ms）→大模型调用（通义千问 qwen-max 生成回答，耗时3500ms）→审计日志记录（50ms），总耗时3750ms。运维团队通过Trace分析发现大模型调用占比93%的耗时，优化方向聚焦于模型选择（简单问题降级到 DeepSeek）和Prompt精简。当AI回答超时时，通过Trace ID快速定位是Milvus检索慢还是大模型推理慢，实现精准的性能优化和故障定位。

---

#### 追问：
- 追问1：采样率 production 设 0.1 时，偶发的 AI 超时或幻觉 Trace 可能没被采样到，碳管家如何在出错时强制采样（error-based sampling）以保住故障现场？
  - **答**：用错误优先采样。
    - ① 配置 sampler 为"错误必采"：异常/超时/慢请求 trace 强制 100% 采样，正常流量按 0.1 抽样
    - ② OpenTelemetry 的 ParentBased + 自定义 Sampler（含 error tag 即采）
    - ③ 对特定高价值租户/问题也提高采样
    - ④ 保证故障现场必留，正常流量省成本，偶发故障 trace 不丢
- 追问2：Trace 的 Span 里 tag 了 prompt.length 和 answer.length，但 prompt 明文（含用户碳数据）进入 Zipkin 会带来数据合规风险，如何脱敏？
  - **答**：有风险。prompt 含用户碳数据，进 Zipkin 可能违规（隐私/数据出境）。
    - 脱敏：
      - ① span tag 只记 prompt.length/answer.length 与 hash，不记明文
      - ② 确需看内容时脱敏（去标识化、掩码企业名/数值）
      - ③ Zipkin 访问控制+加密存储，限定留存期
      - ④ 敏感字段写入 span 前过滤（SpanProcessor 拦截脱敏）
      - ⑤ 按合规决定是否记录用户输入，必要时仅记问题类型/tenantId
- 追问3：当一次问答跨多个微服务（网关、AI 服务、法规库服务），如何保证租户 ID 和 traceId 在跨服务透传中不被丢失，便于按租户维度分析链路耗时？
  - **答**：靠传播器（Propagation）。
    - ① HTTP 调用在请求头注入 traceparent（W3C）+ 自定义 X-Tenant-Id，下游从 header 提取恢复
    - ② 内部 RPC/MQ 在消息头/属性透传
    - ③ 用 OpenTelemetry 自动 instrumentation 覆盖 HTTP/DB/MQ 自动传播 trace
    - ④ tenantId 在网关/Interceptor 写入 MDC 与消息头，跨服务由拦截器恢复进 ThreadLocal
    - ⑤ 确保 SDK 配置"注入/提取"头，避免中间件吞掉 header

#### 十三、Spring Boot 配置文件管理

### 49. 多环境配置管理策略
**重要度**：★★★

**题目：**
请说明Spring Boot的多环境配置方案，包括Profile机制、配置文件命名规范、环境变量注入，以及碳管理SaaS项目中dev/test/staging/prod的配置管理实践。

**解答：**
Spring Boot通过Profile机制实现多环境配置，每个环境对应不同的配置文件和Profile激活方式。

**配置文件命名规范：**
- application.yml：通用配置，所有环境共享
- application-dev.yml：开发环境配置
- application-test.yml：测试环境配置
- application-staging.yml：预发布环境配置
- application-prod.yml：生产环境配置

**Profile激活方式：**
1. spring.profiles.active配置项（application.yml或命令行参数）
2. 环境变量SPRING_PROFILES_ACTIVE
3. JVM参数-Dspring.profiles.active=prod
4. SpringApplicationBuilder.profiles()编程式设置

```yaml
# application.yml（通用配置）
spring:
  application:
    name: carbon-ai-assistant
  profiles:
    active: ${SPRING_PROFILES_ACTIVE:dev}  # 默认dev环境
  # 注意：spring.ai.openai.model 不是有效属性（不会绑定，也不报错，改了也白改）。
  # Spring AI 1.x 的模型配置在 spring.ai.openai.chat.options.model，指向兼容端点还要配 base-url：
  ai:
    openai:
      base-url: https://dashscope.aliyuncs.com/compatible-mode
      api-key: ${OPENAI_API_KEY}
      chat:
        options:
          model: qwen-max
          temperature: 0.7
    vectorstore:
      milvus:
        collection-name: carbon_law

# application-dev.yml（开发环境）
carbon:
  ai:
    openai:
      api-key: ${OPENAI_API_KEY}  # 从环境变量读取
      model: deepseek-chat  # 开发环境用便宜模型
    milvus:
      host: localhost
      port: 19530
  debug: true

logging:
  level:
    com.carbon.ai: DEBUG
    org.springframework.ai: DEBUG

# application-prod.yml（生产环境）
carbon:
  ai:
    openai:
      api-key: ${OPENAI_API_KEY}
      model: qwen-max  # 生产环境用高质量模型
      max-tokens: 4096
    milvus:
      host: ${MILVUS_HOST}
      port: ${MILVUS_PORT}
  quota:
    default-monthly-tokens: 100000

server:
  port: 8080
  shutdown: graceful

management:
  endpoints:
    web:
      exposure:
        include: health,info,prometheus

logging:
  level:
    com.carbon.ai: INFO
    root: WARN
  file:
    name: /var/log/carbon-ai/application.log
```

**两套前缀的边界**：`spring.ai.*` 是 Spring AI 自动装配的 `OpenAiChatModel` 读的（框架直接生效）；`carbon.ai.*` 是自己 `@ConfigurationProperties` 的业务配置（模型路由、配额、灰度都在这一层）。二者不要都当"模型开关"用——要么只用 `spring.ai.*` 交给自动装配，要么自己 new `OpenAiChatModel` 只用 `carbon.ai.*`，同时改两处最容易出现"改了没生效"。

**配置加密与安全：**
生产环境中API Key等敏感信息不应明文存储在配置文件中，通过Jasypt加密或从Vault/配置中心动态获取。

```java
// 使用Jasypt加密配置
@Configuration
public class JasyptConfig {
    // jasypt.encryptor.password环境变量设置主密钥
    // 配置文件中: ENC(加密后的值)
    // carbon.ai.llm.api-key: ENC(xxxxxx)
}

// 从Vault动态获取密钥
@Component
public class VaultSecretLoader implements EnvironmentPostProcessor {
    @Override
    public void postProcessEnvironment(ConfigurableEnvironment env, SpringApplication app) {
        if (env.getProperty("carbon.secret.vault.enabled", Boolean.class, false)) {
            VaultTemplate vault = new VaultTemplate(/* ... */);
            String qwenKey = vault.opsForKeyValue("secret")
                .get("carbon-ai-qwen").getData().get("api-key").toString();
            String deepSeekKey = vault.opsForKeyValue("secret")
                .get("carbon-ai-deepseek").getData().get("api-key").toString();
            String glmKey = vault.opsForKeyValue("secret")
                .get("carbon-ai-glm").getData().get("api-key").toString();
            Map<String, Object> secrets = Map.of(
                "carbon.ai.qwen.api-key", qwenKey,
                "carbon.ai.deepseek.api-key", deepSeekKey,
                "carbon.ai.glm.api-key", glmKey);
            env.getPropertySources().addFirst(
                new MapPropertySource("vault-secrets", secrets));
        }
    }
}
```

**AI/碳管理场景关联：**
碳管家AI助手在开发环境使用 DeepSeek（成本低）和本地Milvus，测试环境使用 DeepSeek 和测试Milvus集群，预发布环境使用通义千问 qwen-max 和预发布Milvus集群（与生产配置一致但数据量小），生产环境使用通义千问 qwen-max 和生产Milvus集群。API Key通过HashiCorp Vault统一管理（三家供应商 Key 分别存于 secret/carbon-ai/{qwen,deepseek,glm}），应用启动时从Vault拉取，不在配置文件和代码中存储密钥。各环境配置不同的Token配额限制：开发环境1000 Token/天、生产环境按租户合同配额。

---

#### 追问：
- 追问1：dev 用 DeepSeek、prod 用通义千问 qwen-max，两套模型的 Prompt 表现差异可能导致 dev 验证通过的 Prompt 在 prod 效果变差，如何做跨环境的 Prompt 回归？
  - **答**：需跨环境回归。
    - ① Prompt 模板纳入版本管理与测试资产，dev/prod 用同一套（或明确差异）
    - ② 建回归数据集（标准问答对），在 prod 模型上跑评测，对比 dev 结果，发现 Prompt 在强模型上效果下降
    - ③ 用离线评测（RAGAS/人工评分）对比两环境回答质量
    - ④ Prompt 变更走评审+回归门禁，避免"dev 过 prod 翻车"
- 追问2：API Key 从 Vault 拉取，若 Vault 在应用启动时不可达，碳管家是启动失败还是降级到本地缓存密钥，这背后的可用性取舍是什么？
  - **答**：取舍看安全策略。
    - ① 高安全：Vault 不可达则启动失败（fail-fast），避免用明文/旧密钥运行
    - ② 高可用：本地加密缓存上次密钥（短 TTL）降级启动，但需加密落盘+告警
    - ③ 折中：启动若 Vault 不可达用缓存密钥启动并持续重试刷新，同时标记"密钥未刷新"告警
    - 碳管家通常选 fail-fast 或"缓存降级+强告警"，关键是不无声用过期密钥。
- 追问3：各环境 Token 配额不同（dev 1000/天、prod 按合同），配额配置若误配到 dev 值上了生产，有什么配置校验或环境隔离的兜底机制？
  - **答**：兜底：
    - ① 配置校验（启动 fail-fast）：生产配额必须 ≥ 某下限，dev/prod 用不同配置源（Nacos namespace/Profile）物理隔离，避免误用
    - ② 用 CarbonAiConfigValidatorPostProcessor 启动校验配额合理性（如 prod 配额不能为 dev 的 1000/天）
    - ③ 环境变量/配置中心按环境隔离，CI 部署校验配置指纹
    - ④ 配额变更走审批，异常值启动即报错

### 50. 配置中心集成与动态刷新
**重要度**：★★★★

**题目：**
请说明如何将Spring Boot与Nacos/Apollo配置中心集成，实现配置动态刷新，以及碳管理AI助手中哪些配置需要动态刷新。

**解答：**
配置中心实现配置的集中管理、动态刷新和版本回滚，避免修改配置后需要重启应用。

**Nacos Config集成：**

```yaml
# application.yml
spring:
  cloud:
    nacos:
      config:
        server-addr: ${NACOS_HOST}:8848
        namespace: ${NACOS_NAMESPACE:public}
        group: CARBON_AI
        file-extension: yaml
        shared-configs:
          - data-id: carbon-ai-common.yaml  # 共享配置
            group: CARBON_AI
            refresh: true
          - data-id: carbon-ai-model.yaml   # AI模型配置
            group: CARBON_AI
            refresh: true
```

**动态刷新机制：**
- @RefreshScope注解：标注在Bean上，配置变更时销毁并重建Bean。
- @ConfigurationProperties：**前提是接入了配置中心**。Spring Cloud 的 ConfigurationPropertiesRebinder 收到 RefreshEvent 后会 rebind 该前缀的配置Bean，属性才会更新；纯 Spring Boot 没有配置中心时，它不会自己刷新。
- ConfigChangeListener：监听配置变更事件，执行自定义刷新逻辑。

```java
// 方式1: @RefreshScope - 配置变更时Bean重建
@Service
@RefreshScope
public class CarbonChatService {

    @Value("${carbon.ai.llm.model}")
    private String model;

    @Value("${carbon.ai.llm.temperature}")
    private double temperature;

    @Value("${carbon.ai.llm.max-tokens}")
    private int maxTokens;

    // 当Nacos中carbon.ai.llm.model变更时
    // Spring自动销毁并重建此Bean，新值自动注入
}

// 方式2: @ConfigurationProperties - 配合配置中心 rebind 刷新
// 注意：@ConfigurationProperties 类是"配置绑定类"，不该同时标 @Configuration（多余，且和 @RefreshScope 的代理容易叠出怪问题）；
// 和 @RefreshScope 二选一即可：要 rebind 语义就别加 @RefreshScope，要整Bean重建才加
@ConfigurationProperties(prefix = "carbon.ai")
@Data
public class CarbonAiProperties {
    private OpenAiConfig openai = new OpenAiConfig();
    private MilvusConfig milvus = new MilvusConfig();
    private QuotaConfig quota = new QuotaConfig();

    @Data
    public static class OpenAiConfig {
        private String apiKey;
        private String model = "qwen-max";
        private double temperature = 0.7;
        private int maxTokens = 4096;
    }

    @Data
    public static class QuotaConfig {
        private long defaultMonthlyTokens = 100000;
        private int rateLimitPerMinute = 20;
    }
}

// 方式3: 监听配置变更事件，执行自定义逻辑
@Component
public class CarbonAiConfigChangeListener {

    @Autowired
    private ChatClientManager clientManager;

    @EventListener
    public void onConfigChange(RefreshScopeRefreshedEvent event) {
        log.info("检测到配置刷新，重新初始化AI客户端");
        // 配置变更后重建ChatClient（如切换模型）
        clientManager.rebuildChatClient();
    }

    // Nacos原生监听
    @NacosConfigListener(dataId = "carbon-ai-model.yaml", group = "CARBON_AI")  // 属性是 group，没有 groupId
    public void onModelConfigChange(String config) {
        CarbonModelConfig newConfig = parseConfig(config);
        log.info("AI模型配置变更: model={}->{}", currentModel, newConfig.getModel());
        clientManager.switchModel(newConfig.getModel(), newConfig.getTemperature());
    }
}
```

**需要动态刷新的AI配置：**
- 模型选择（model）：从通义千问降级到 DeepSeek 时动态切换
- 温度和Token限制（temperature, maxTokens）：根据回答质量反馈调整
- 租户配额（monthlyTokens, rateLimitPerMinute）：运行时调整配额
- 检索参数（topK, similarityThreshold）：调整RAG检索策略
- 模型开关（enabled）：紧急情况下关闭AI功能
- 降级策略（fallbackEnabled）：控制故障降级行为

**AI/碳管理场景关联：**
碳管家AI助手通过Nacos配置中心实现运行时配置热更新：当大模型 API成本超预算时，运维人员在Nacos控制台将carbon.ai.llm.model从qwen-max改为deepseek-chat，@RefreshScope标记的CarbonChatService自动重建，后续AI调用使用新模型，无需重启应用。当发现某租户频繁调用AI消耗过多Token时，动态调低该租户的rateLimitPerMinute限制。当大模型 API大规模故障时，将carbon.ai.enabled改为false，系统自动降级到自部署 GLM(vLLM) 或关键词检索模式，保障碳法规查询基本可用。

---

#### 追问：
- 追问1：@RefreshScope 重建 CarbonChatService 时，正在进行的 AI 问答请求会怎样，会不会因为 Bean 被销毁而丢失上下文或抛出 NPE？
  - **答**：进行中请求可能 NPE/丢上下文。@RefreshScope Bean 刷新时被销毁重建，正在执行的请求若持有旧 Bean 引用，可能遇旧实例被销毁、字段清空（NPE）或上下文丢失。
    - 缓解：
      - ① 刷新不立即销毁进行中请求持有的实例——RefreshScope 实际延迟到下次获取才换，进行中请求用仍旧实例（请求级引用），结束才用新
      - ② 但需确保 Bean 内部状态可被中途废弃，关键调用加空值保护
      - ③ 或用"双实例"平滑切换避免中断
- 追问2：把 carbon.ai.llm.model 从 qwen-max 动态改为 deepseek-chat，已建立的 ChatClient 长连接是否真的切换，还是只影响新请求、旧请求仍走老模型？
  - **答**：不一定。ChatClient 若底层 HTTP（每次请求新建/用连接池），无"长连接"概念，刷新后新请求带新 model 即生效；但若 ChatClient 把 model 配置固定在构建时、未读刷新后配置，旧请求仍走老 model。
    - 保证切换：
      - ① model 每次调用从刷新后配置/Bean 读取（@RefreshScope 重建 ChatClient 带新 model）
      - ② 旧进行中请求用旧配置，新请求用新，符合"新配置新请求生效"语义
- 追问3：Nacos 配置变更是广播给所有 Pod，若某个 Pod 网络分区没收到刷新事件，会出现多 Pod 模型配置不一致，如何检测并处理这种分裂？
  - **答**：会出现分裂。网络分区的 Pod 没收到刷新事件，仍用旧 model 配置，多 Pod 模型不一致。
    - 检测/处理：
      - ① 配置中心用"拉模式兜底"，各 Pod 定时拉取最新配置（长轮询含，分区时重试），恢复后自动对齐
      - ② 暴露 /config 端点，监控比对各 Pod 实际生效配置，不一致告警
      - ③ 关键配置用"配置版本号"在 health/metrics 暴露，运维可发现分裂
      - ④ 变更后跑校验任务确认所有 Pod 生效，否则告警人工介入

### 51. 配置加密与密钥管理最佳实践
**重要度**：★★★★

**题目：**
请设计碳管理SaaS平台的密钥管理方案，包括通义千问/DeepSeek/自部署GLM 三家供应商 API Key、数据库密码、JWT密钥的加密存储、动态获取和定期轮换策略。

**解答：**
SaaS平台的密钥管理需要遵循"不在代码和配置文件中明文存储密钥"的原则，采用外部密钥管理服务（KMS）+ 动态获取 + 定期轮换的策略。

**密钥管理架构：**
1. 密钥存储：HashiCorp Vault / AWS KMS / 阿里云KMS
2. 密钥获取：应用启动时从KMS拉取，缓存在内存中
3. 密钥轮换：定期更换密钥，支持热更新
4. 密钥审计：记录密钥访问日志

```java
// 【关键前提】EnvironmentPostProcessor 由 META-INF/spring.factories 直接反射实例化，
// 它不是容器 Bean：@Component 不会被扫描、@Scheduled 不会注册、@Autowired 不生效。
// 所以"启动期注入"和"运行期轮换"必须拆成两个类。

// 1) 启动期：只负责从 Vault 拉密钥并塞进 Environment
@Slf4j
public class VaultSecretEnvironmentPostProcessor implements EnvironmentPostProcessor, Ordered {

    private static final Map<String, String> SECRET_CACHE = new ConcurrentHashMap<>();

    @Override
    public int getOrder() {
        return Ordered.HIGHEST_PRECEDENCE + 10;
    }

    @Override
    public void postProcessEnvironment(ConfigurableEnvironment env, SpringApplication app) {
        // 在Spring Environment准备阶段从Vault拉取密钥
        if (env.getProperty("carbon.vault.enabled", Boolean.class, false)) {
            VaultEndpoint endpoint = VaultEndpoint.create(
                env.getProperty("carbon.vault.host"),
                env.getProperty("carbon.vault.port", Integer.class, 8200)
            );
            VaultTemplate vaultTemplate = new VaultTemplate(endpoint,
                new TokenAuthentication(env.getProperty("carbon.vault.token")));

            // 拉取AI相关密钥
            loadSecretsFromVault(env, vaultTemplate);
        }
    }

    private void loadSecretsFromVault(ConfigurableEnvironment env, VaultTemplate vaultTemplate) {
        // 大模型供应商 API Key（通义千问/DeepSeek/自部署GLM 三家）
        addSecretToEnv(env, "carbon.ai.qwen.api-key", getSecret(vaultTemplate, "secret/carbon-ai/qwen", "api-key"));
        addSecretToEnv(env, "carbon.ai.deepseek.api-key", getSecret(vaultTemplate, "secret/carbon-ai/deepseek", "api-key"));
        addSecretToEnv(env, "carbon.ai.glm.api-key", getSecret(vaultTemplate, "secret/carbon-ai/glm", "api-key"));

        // 数据库密码
        String dbPassword = getSecret(vaultTemplate, "secret/carbon-ai/database", "password");
        addSecretToEnv(env, "spring.datasource.password", dbPassword);

        // JWT签名密钥
        String jwtSecret = getSecret(vaultTemplate, "secret/carbon-ai/jwt", "signing-key");
        addSecretToEnv(env, "jwt.secret", jwtSecret);

        // Milvus认证
        String milvusPassword = getSecret(vaultTemplate, "secret/carbon-ai/milvus", "password");
        addSecretToEnv(env, "carbon.ai.milvus.password", milvusPassword);

        log.info("从Vault加载了{}个密钥", SECRET_CACHE.size());
    }

    private String getSecret(VaultTemplate vaultTemplate, String path, String key) {
        VaultResponseSupport<Map<String, Object>> response =
            vaultTemplate.opsForKeyValue("secret").get(path);
        String value = String.valueOf(response.getData().get(key));
        SECRET_CACHE.put(path + "/" + key, value);
        return value;
    }

    // 把密钥作为最高优先级属性源追加到 Environment
    private void addSecretToEnv(ConfigurableEnvironment env, String key, String value) {
        Map<String, Object> map = Map.of(key, value);
        env.getPropertySources().addFirst(new MapPropertySource("vaultSecrets-" + key, map));
    }
}

// 2) 运行期：密钥轮换是容器 Bean，这里才写 @Scheduled
@Slf4j
@Component
@RequiredArgsConstructor
public class VaultSecretRefresher {

    private final VaultTemplate vaultTemplate;
    private final ConfigurableEnvironment environment;
    private final ApplicationEventPublisher eventPublisher;

    @Scheduled(fixedDelay = 3600000) // 每小时检查（Bean 内，@EnableScheduling 后生效）
    public void refreshSecrets() {
        try {
            // 从Vault重新拉取密钥（Vault管理员可能已轮换）
            loadSecretsFromVault(environment, vaultTemplate);
            log.info("密钥刷新完成");

            // 如果JWT密钥变更，重建JWT解析器
            eventPublisher.publishEvent(new SecretRefreshedEvent(refreshedKeys()));
        } catch (Exception e) {
            log.error("密钥刷新失败", e);
        }
    }

    private List<String> refreshedKeys() {
        // 实际实现可对比新旧值，只返回真正变化的 key
        return List.of("secret/carbon-ai/jwt/signing-key");
    }
}

// 密钥变更监听器
@Component
public class SecretRefreshListener {

    @Autowired
    private JwtTokenService jwtService;
    @Autowired
    private ChatClientManager chatClientManager;

    @EventListener
    public void onSecretRefresh(SecretRefreshedEvent event) {
        if (event.getRefreshedKeys().stream().anyMatch(k -> k.startsWith("secret/carbon-ai/")
                && (k.contains("/qwen/") || k.contains("/deepseek/") || k.contains("/glm/")))) {
            // 任一供应商 API Key 变更，重建对应 ChatClient
            chatClientManager.rebuildWithNewApiKey();
        }
        if (event.getRefreshedKeys().contains("secret/carbon-ai/jwt/signing-key")) {
            // JWT密钥变更，重建Token验证器
            jwtService.refreshSigningKey();
        }
    }
}
```

**AI/碳管理场景关联：**
积木LCA云平台的密钥管理方案：通义千问/DeepSeek/自部署GLM 三家供应商 API Key、数据库密码、JWT签名密钥等敏感信息存储在HashiCorp Vault中，应用启动时通过Vault SDK拉取并注入Spring Environment。密钥每30天通过Vault自动轮换，应用每小时检查并更新缓存的密钥。当任一供应商 API Key泄露时，管理员在Vault中立即更换该 Key，所有服务实例在1小时内自动获取新 Key，无需重启。所有密钥访问操作记录在Vault审计日志中，满足SaaS平台的安全合规要求。

---

#### 追问：
- 追问1：JWT 签名密钥每 30 天轮换，旧密钥签发的未过期 Token 在轮换瞬间会集体失效吗，是否需要保留旧密钥做过渡期双密钥验证？
  - **答**：不会（若双密钥）。轮换时保留旧密钥做过渡期验证（jku/kid 指定密钥 ID，验证方持旧+新公钥集合），旧 token 过期前仍可用，新 token 用新密钥。过渡期（旧 token 最长有效期）后下线旧密钥，轮换瞬间无集体失效。
    - 需：
      - ① JWT 头带 kid
      - ② 验证端维护密钥列表
      - ③ 轮换前先部署新公钥再切签名，保证平滑
- 追问2：供应商 API Key 泄露后 1 小时内自动获取新 Key，这 1 小时窗口内已泄露的 Key 是否仍可被滥用，能不能做到秒级吊销？
  - **答**：窗口内仍可被滥用。1 小时自动换新只是"定期轮转"，泄露到换新的窗口旧 Key 仍可用。
    - 秒级吊销：
      - ① 密钥服务支持"立即吊销"接口，发现泄露立刻将旧 Key 加吊销列表（Redis 黑名单），网关/调用层每次请求校验 Key 是否在吊销集
      - ② 或用短期令牌（Key 对应短期 session token），泄露的短期令牌很快过期
      - ③ 网关侧实时校验 + 吊销广播，做到近秒级失效
- 追问3：密钥缓存在内存 secretCache，若容器发生 heap dump 或内存转储被拿走，明文密钥会不会泄露，是否有更安全的零落地方案？
  - **答**：有风险。heap dump/内存转储被拿走可提取明文密钥。
    - 零落地（better）：
      - ① 密钥不缓存明文，用时从 Vault/KMS 取并尽快清出（用完置 null + 禁用生产 heap dump）
      - ② 用 KMS 信封加密，内存只存密文，用时解密到原生类型（byte[]）用完清
      - ③ 用 JVM 安全区/外部 secret 管理（CSI Secret 挂载、env 经 sealing）
      - ④ 禁用生产 heap dump 或加密 dump
      - ⑤ 密钥访问走 mTLS + 短时效

### 52. 配置优先级与外部化配置体系
**重要度**：★★★★

**题目：**
请详细说明Spring Boot的配置优先级体系（从高到低），以及在碳管理项目中如何合理利用配置优先级实现灵活的配置管理。

**解答：**
Spring Boot的配置优先级从高到低（高优先级覆盖低优先级）。严格说，比命令行还高的只有开发期的 DevTools 全局配置（~/.spring-boot-devtools.properties）和测试期的 @TestPropertySource，生产环境里排最前的就是命令行参数：

1. 命令行参数（--property=value，排在可用属性源的最前面）
2. SPRING_APPLICATION_JSON环境变量中的JSON属性
3. ServletConfig初始化参数
4. ServletContext初始化参数
5. JNDI属性（java:comp/env/）
6. Java系统属性（System.getProperties()）
7. 操作系统环境变量
8. RandomValuePropertySource（random.*属性）
9. Profile特定的外部配置文件（application-{profile}.yml，在jar外部）
10. Profile特定的打包内配置文件（application-{profile}.yml，在jar内部）
11. 非Profile的外部配置文件（application.yml，在jar外部）
12. 非Profile的打包内配置文件（application.yml，在jar内部）
13. @PropertySource注解指定的配置文件
14. 默认属性（SpringApplication.setDefaultProperties）

**关键优先级原则：**
- 命令行参数是**最高之一**（严格说仅次于 DevTools 和测试专用属性），适合临时覆盖（如紧急切换模型）
- 配置中心（Nacos/Apollo）属于额外插入的 PropertySource，层级在命令行之后，**不会覆盖命令行参数**
- 环境变量优先级高于配置文件，适合容器化部署注入密钥
- 外部配置文件优先级高于内部配置文件，适合不同部署环境差异化配置
- Profile特定配置优先级高于通用配置

```java
// 碳管理项目配置优先级实践

// 1. 打包内application.yml（最低优先级，通用默认值）
// carbon.ai.llm.model: qwen-max
// carbon.ai.milvus.host: localhost

// 2. 外部application.yml（部署时覆盖，运维管理）
// 放在/config目录或与jar同目录
// carbon.ai.milvus.host: milvus-prod.internal

// 3. 环境变量（容器化部署注入，K8s ConfigMap/Secret）
// CARBON_AI_LLM_API_KEY=xxx
// CARBON_AI_MILVUS_HOST=milvus-prod.internal
// SPRING_PROFILES_ACTIVE=prod

// 4. 命令行参数（最高优先级，紧急运维操作）
// java -jar carbon-ai.jar --carbon.ai.llm.model=deepseek-chat --carbon.ai.enabled=false

// 配置优先级在AI场景中的应用
@Configuration
public class CarbonAiConfigResolution {

    // 紧急降级：通过命令行参数临时关闭AI功能
    // java -jar app.jar --carbon.ai.enabled=false
    // 此时即使配置中心中enabled=true，命令行参数优先级更高，AI功能被关闭

    // 灰度发布：通过环境变量控制AI模型
    // CARBON_AI_LLM_MODEL=qwen-max（仅灰度Pod设置此环境变量）
    @Value("${carbon.ai.llm.model:qwen-max}")
    private String model;

    // 配置优先级验证
    public void printConfigSource() {
        // 通过Environment获取配置值及其来源
        // 有助于排查配置不生效的问题
    }
}

// 配置覆盖诊断
@RestController
@RequestMapping("/api/admin/config")
public class ConfigDiagnosticController {

    @Autowired
    private Environment environment;
    @Autowired
    private ConfigurableEnvironment configurableEnvironment;

    @GetMapping("/diagnostic/{key}")
    public Map<String, Object> diagnoseConfig(@PathVariable String key) {
        Map<String, Object> result = new LinkedHashMap<>();
        result.put("key", key);
        result.put("value", environment.getProperty(key));

        // 查找配置值来源
        for (PropertySource<?> ps : configurableEnvironment.getPropertySources()) {
            if (ps instanceof EnumerablePropertySource<?> eps) {
                if (Arrays.asList(eps.getPropertyNames()).contains(key)) {
                    result.put("source", ps.getName());
                    result.put("rawValue", ps.getProperty(key));
                    break;
                }
            }
        }
        return result;
    }
}
```

**AI/碳管理场景关联：**
碳管家AI助手的配置管理利用优先级体系实现灵活管控：打包内application.yml定义默认配置（通义千问 qwen-max 模型、本地Milvus）；K8s ConfigMap通过环境变量覆盖为生产配置（生产Milvus地址、通义千问 qwen-max 模型）；K8s Secret通过环境变量注入API Key等密钥；Nacos配置中心提供动态可变的业务配置（配额、限流参数）。当需要紧急关闭AI功能时，运维人员通过K8s命令设置命令行参数--carbon.ai.enabled=false并重启Pod，此参数优先级最高，立即生效。配置诊断接口帮助开发者快速排查"配置不生效"问题，定位配置值的实际来源。

---

#### 追问：
- 追问1：紧急用命令行 --carbon.ai.enabled=false 关闭 AI，但若 Nacos 随后推送 enabled=true，命令行参数的高优先级是否仍压过配置中心，会不会被动态刷新覆盖？
  - **答**：不会。命令行参数（--key）是 Environment 里优先级最高的属性源之一，Spring Cloud 的 PropertySourceBootstrapConfiguration 只是把 bootstrap/配置中心的 PropertySource 插入到 commandLineArgs **之后**；Nacos 刷新是替换它自己那份 PropertySource 的内容，**不改变优先级顺序**。所以 `--carbon.ai.enabled=false` 会持续压制配置中心，动态推送 enabled=true 不会翻掉它。
    - 想让"运维开关"彻底不可被动态覆盖：把开关放命令行即可（本来就不会被覆盖）；反过来，如果希望配置中心能接管，就别用命令行兜底，改由外层（K8s ConfigMap/Secret）注入，或把开关拆成独立 key 分权管理。
- 追问2：K8s ConfigMap 环境变量覆盖打包内配置，当配置项改名（如 milvus.host→milvus.endpoint），旧环境变量残留会导致读到 null，碳管家如何做配置项迁移与兼容性？
  - **答**：旧环境变量残留会读到 null（新名 milvus.endpoint 取不到，旧 milvus.host 还在但不被读取）。
    - 兼容：
      - ① 改名时保留旧名读取做兼容（先读新名，null 则回退旧名）
      - ② K8s 部署清单同步清理旧 env 避免残留
      - ③ 启动配置校验：关键项 null 时 fail-fast 并提示"请迁移配置项"
      - ④ @ConfigurationProperties 绑定缺省给合理默认值或明确报错
      - ⑤ 配置迁移文档 + CI 检查环境变量定义
- 追问3：配置诊断接口 /api/admin/config 能读取任意 key 的来源，它本身是否需要更严格的权限控制，避免泄露敏感密钥的真实值？
  - **答**：必须严格鉴权。
    - ① 该端点需独立强鉴权（仅超级管理员，MFA），不在普通租户权限内
    - ② 对敏感 key（含 password/key/secret）做脱敏，返回值掩码（如 xxx***）
    - ③ 记录访问审计日志
    - ④ 支持查"来源"但默认不返真实值，需显式"显示值"权限且审计
    - ⑤ 端点不暴露原始密钥，只暴露"是否已配置/来源类型"
    - ⑥ 网络层限制（仅内网/运维网段）

#### 十四、Spring 异步处理

### 53. @Async异步方法与线程池配置
**重要度**：★★★★★

**题目：**
请说明@Async注解的工作原理、线程池配置方式，以及碳管家AI助手中异步处理的应用场景与线程池调优实践。

**解答：**
@Async注解使方法在独立线程中异步执行，调用方立即返回，不阻塞当前线程。底层通过AOP代理实现：Spring在postProcessAfterInitialization阶段为@Async标注的Bean创建代理对象，方法调用时将任务提交到线程池执行。

**线程池配置：**
默认使用SimpleAsyncTaskExecutor（每次创建新线程，不推荐）。生产环境应自定义ThreadPoolTaskExecutor，配置核心线程数、最大线程数、队列容量和拒绝策略。

```java
@EnableAsync
@Configuration
public class AsyncConfig implements AsyncConfigurer {

    // AI请求专用线程池
    @Bean("aiTaskExecutor")
    public ThreadPoolTaskExecutor aiTaskExecutor() {
        ThreadPoolTaskExecutor executor = new ThreadPoolTaskExecutor();
        executor.setCorePoolSize(10);        // 核心线程数（AI调用IO密集型）
        executor.setMaxPoolSize(50);         // 最大线程数
        executor.setQueueCapacity(200);      // 等待队列
        executor.setKeepAliveSeconds(60);
        executor.setThreadNamePrefix("carbon-ai-async-");
        // AI 调用是秒级慢任务，不能用 CallerRunsPolicy：被拒任务会回灌到调用线程（Web 场景就是 Tomcat 线程），
        // 下游一慢就把容器线程堵死，直接雪崩。这里快速失败，由上层降级/转异步补偿
        executor.setRejectedExecutionHandler(new ThreadPoolExecutor.AbortPolicy());
        executor.setWaitForTasksToCompleteOnShutdown(true);
        executor.setAwaitTerminationSeconds(60); // 优雅停机等待60秒
        executor.initialize();
        return executor;
    }

    // 向量编码专用线程池（CPU密集型）
    @Bean("embeddingExecutor")
    public ThreadPoolTaskExecutor embeddingExecutor() {
        ThreadPoolTaskExecutor executor = new ThreadPoolTaskExecutor();
        int cpuCores = Runtime.getRuntime().availableProcessors();
        executor.setCorePoolSize(cpuCores);      // CPU密集型：核心数=CPU核数
        executor.setMaxPoolSize(cpuCores * 2);
        executor.setQueueCapacity(100);
        executor.setThreadNamePrefix("carbon-embedding-");
        executor.setRejectedExecutionHandler(new ThreadPoolExecutor.AbortPolicy());
        executor.initialize();
        return executor;
    }

    @Override
    public Executor getAsyncExecutor() {
        return aiTaskExecutor(); // 默认异步执行器
    }

    @Override
    public AsyncUncaughtExceptionHandler getAsyncUncaughtExceptionHandler() {
        return (ex, method, params) -> {
            log.error("异步方法异常: method={}, error={}", method.getName(), ex.getMessage(), ex);
            // 发送告警
            alertService.notifyAsyncFailure(method.getName(), ex);
        };
    }
}

// 异步AI调用
@Service
public class CarbonChatService {

    @Async("aiTaskExecutor")
    public CompletableFuture<ChatResponse> chatAsync(CarbonUser user, String question) {
        // 在aiTaskExecutor线程池中异步执行
        ChatResponse response = doChat(user, question);
        return CompletableFuture.completedFuture(response);
    }

    @Async("embeddingExecutor")
    public CompletableFuture<List<float[]>> batchEmbed(List<String> texts) {
        // 注意：parallelStream() 用的是 ForkJoinPool.commonPool，不在 embeddingExecutor 里跑——
        // 结果是只有一个 embeddingExecutor 线程在等 commonPool 的分片，且 commonPool 被框架共用、容易互相拖累。
        // 要真正并行在本池内，用 CompletableFuture + 显式 Executor；更好的是直接调批量 embedding 接口
        // （EmbeddingModel.embed(List<String>) 一次请求多段文本，由服务端批量处理）
        List<float[]> vectors = embeddingModel.embed(texts);
        return CompletableFuture.completedFuture(vectors);
    }
}
```

**线程池调优原则：**
- IO密集型（AI API调用、数据库访问）：线程数 = CPU核数 × (1 + 等待时间/计算时间)，通常为CPU核数的2-10倍
- CPU密集型（向量编码、数据计算）：线程数 = CPU核数 + 1
- 队列容量不宜过大，避免OOM和请求堆积
- 拒绝策略选择：**业务线程池不要用 CallerRunsPolicy**——它把被拒任务塞回调用线程执行，Web 场景下就是堵 Tomcat 线程，下游变慢时压力反向回灌、直接雪崩。正确做法是 AbortPolicy + 上层降级（返回兜底答案/转异步重试），或自定义策略"落盘/MQ 后异步重试"。CallerRunsPolicy 只适合毫秒级短任务的本地限流场景

**AI/碳管理场景关联：**
碳管家AI助手使用多线程池隔离不同类型任务：aiTaskExecutor（IO密集型，10-50线程）处理AI问答异步调用、通知发送等IO操作；embeddingExecutor（CPU密集型，CPU核数线程）处理批量向量编码。当AI问答请求突增、aiTaskExecutor 队列满时走 AbortPolicy 快速失败，由上层降级返回"稍后重试/关键词检索"结果，绝不让慢调用回灌到 Tomcat 线程。优雅停机时设置awaitTerminationSeconds=60秒，确保进行中的AI请求有时间完成。AsyncUncaughtExceptionHandler 只对返回 void 的 @Async 方法生效；返回 CompletableFuture 的方法异常被封进 future，要在链路里用 exceptionally/handle 统一处理并告警。

---

#### 追问：
- 追问1：AI 请求线程池用 CallerRunsPolicy 拒绝策略，在 AI 调用普遍慢（秒级）时，被拒绝任务在调用方线程同步执行会不会反过来拖垮 HTTP 请求线程？
  - **答**：会。AI 调用秒级，被拒绝任务在 HTTP 请求线程同步执行，占用 Tomcat 线程数秒，高拒绝率时大量 Tomcat 线程被占，正常请求无法处理→雪崩。
    - 改进：
      - ① AI 线程池配合理队列+容量，尽量不触发拒绝
      - ② 拒绝时快速失败返回"繁忙/降级"而非占调用线程
      - ③ 或拒绝任务入 MQ 异步重试，不阻塞 HTTP
      - ④ CallerRunsPolicy 更适合短任务，AI 慢调用宜用"快速失败+兜底"
- 追问2：向量编码线程池 AbortPolicy 在队列满时直接抛异常，批量导入碳法规文档时触发拒绝会丢任务吗，如何做背压与失败重试？
  - **答**：会丢。AbortPolicy 直接抛 RejectedExecutionException，批量导入任务若没捕获重试就丢该批编码。
    - 背压/重试：
      - ① 捕获异常，任务入本地队列/DB 待重试
      - ② 有界队列 + 生产者限速（信号量/令牌桶）做背压，满时阻塞生产者而非丢
      - ③ 批量导入本就用分批+失败重试（记已处理 offset 断点续跑）
      - ④ 或换 CallerRuns 让导入线程自己编码（慢但不丢），配合限流
- 追问3：@Async 方法内部若再调用本类另一个 @Async 方法，因自调用不走代理，异步会失效，碳管家代码中如何规避这种自调用陷阱？
  - **答**：规避自调用陷阱：
    - ① 被 @Async 方法抽到独立 Bean，通过依赖注入调用，走代理生效
    - ② 或用 AopContext.currentProxy() 获取代理后调用
    - ③ 注入自身代理（self）调用
    - ④ 编码规范：@Async 方法不与被调方法同 Bean
    - ⑤ 用编译期/单测检测自调用（同类调用即告警）
    - ⑥ Spring @Async 必须走代理，类内 this.xxx() 不生效是根因，重构解耦最稳

### 54. CompletableFuture与异步编排在AI流水线中的应用
**重要度**：★★★★

**题目：**
请设计一个基于CompletableFuture的AI处理流水线，实现碳管家AI助手的并行检索、模型调用和后处理编排。

**解答：**
CompletableFuture提供强大的异步编排能力，支持thenApply、thenCompose、thenCombine、allOf、anyOf等链式操作，适合构建多步骤、并行的AI处理流水线。

```java
@Service
public class CarbonAiPipeline {

    @Autowired
    private ChatClient chatClient;
    @Autowired
    private VectorStore carbonLawVectorStore;
    @Autowired
    private EmissionFactorService factorService;
    @Autowired
    private OrgCarbonDataService orgDataService;
    @Autowired
    @Qualifier("aiTaskExecutor")
    private Executor aiExecutor;

    public CompletableFuture<CarbonAiResponse> executePipeline(
            CarbonUser user, String question) {

        // 阶段1: 并行检索三个数据源
        CompletableFuture<List<RetrievalResult>> lawFuture = CompletableFuture
            .supplyAsync(() -> retrieveFromLaw(question, user.getTenantId()), aiExecutor)
            .exceptionally(ex -> {
                log.warn("碳法规检索失败，降级为空结果", ex);
                return List.of();
            });

        CompletableFuture<List<RetrievalResult>> factorFuture = CompletableFuture
            .supplyAsync(() -> retrieveFromFactorDb(question), aiExecutor)
            .exceptionally(ex -> List.of());

        CompletableFuture<List<RetrievalResult>> orgDataFuture = CompletableFuture
            .supplyAsync(() -> retrieveFromOrgData(user.getTenantId(), question), aiExecutor)
            .exceptionally(ex -> List.of());

        // 阶段2: 等待所有检索完成，合并结果
        CompletableFuture<List<RetrievalResult>> allRetrievalFuture = CompletableFuture
            .allOf(lawFuture, factorFuture, orgDataFuture)
            .thenApply(v -> {
                List<RetrievalResult> all = new ArrayList<>();
                all.addAll(lawFuture.join());
                all.addAll(factorFuture.join());
                all.addAll(orgDataFuture.join());
                // 按相关性分数排序，取Top-10
                return all.stream()
                    .sorted(Comparator.comparingDouble(RetrievalResult::getScore).reversed())
                    .limit(10)
                    .collect(Collectors.toList());
            });

        // 阶段3: 检索结果 + 问题 → 调用大模型
        CompletableFuture<String> answerFuture = allRetrievalFuture
            .thenComposeAsync(results -> {
                String prompt = buildRagPrompt(question, results);
                return CompletableFuture.supplyAsync(() -> {
                    String answer = chatClient.prompt(prompt).call().content();
                    // 异步保存对话记录和Token用量
                    saveChatRecordAsync(user, question, answer, results);
                    return answer;
                }, aiExecutor);
            });

        // 阶段4: 并行执行后处理（质量检查 + 摘要生成）
        CompletableFuture<QualityCheckResult> qualityFuture = answerFuture
            .thenApplyAsync(answer -> checkAnswerQuality(answer, allRetrievalFuture.join()), aiExecutor);

        CompletableFuture<String> summaryFuture = answerFuture
            .thenApplyAsync(answer -> generateSummary(answer), aiExecutor);

        // 阶段5: 汇总所有结果
        CompletableFuture<CarbonAiResponse> pipeline = CompletableFuture
            .allOf(answerFuture, qualityFuture, summaryFuture, allRetrievalFuture)
            .thenApply(v -> CarbonAiResponse.builder()
                .answer(answerFuture.join())
                .retrievedResults(allRetrievalFuture.join())
                .qualityCheck(qualityFuture.join())
                .summary(summaryFuture.join())
                .sessionId(UUID.randomUUID().toString())
                .build());

        // 超时处理：整个流水线最多30秒
        // 【坑】orTimeout 只让"它返回的这个 future"异常完成，**不会取消上游 supplyAsync 的任务**：
        // 超时后大模型请求仍在跑、仍在烧 Token。所以超时回调里要显式 cancel(true) 各阶段 future，
        // 同时给底层 HTTP 客户端设 read-timeout（cancel 只是中断线程，卡在 socket 读上未必立刻断开）
        return pipeline
            .orTimeout(30, TimeUnit.SECONDS)
            .whenComplete((result, ex) -> {
                if (ex instanceof TimeoutException) {
                    lawFuture.cancel(true);
                    factorFuture.cancel(true);
                    orgDataFuture.cancel(true);
                    allRetrievalFuture.cancel(true);
                    answerFuture.cancel(true);
                    qualityFuture.cancel(true);
                    summaryFuture.cancel(true);
                }
            })
            .exceptionally(ex -> {
                if (ex.getCause() instanceof TimeoutException || ex instanceof TimeoutException) {
                    log.error("AI流水线超时");
                    return CarbonAiResponse.timeout(question);
                }
                log.error("AI流水线异常", ex);
                return CarbonAiResponse.error(ex.getMessage());
            });
    }

    // 阻塞式同步包装：仅供测试/非 Web 线程使用，**不要在 Controller 线程里调**（会长时间占住 Tomcat 线程）
    // Web 入口应返回 CompletableFuture 或 Mono，由 MVC/WebFlux 异步处理
    public CarbonAiResponse executeSync(CarbonUser user, String question) {
        try {
            return executePipeline(user, question).get(30, TimeUnit.SECONDS);
        } catch (TimeoutException e) {
            return CarbonAiResponse.timeout(question);
        } catch (Exception e) {
            return CarbonAiResponse.error(e.getMessage());
        }
    }
}
```

**AI/碳管理场景关联：**
碳管家AI助手的处理流水线通过CompletableFuture实现高效并行编排：三个知识源（碳法规库、排放因子库、企业数据）并行检索（耗时约200ms-2s），合并结果后调用大模型生成回答（耗时约3-5s），同时并行执行质量检查和摘要生成。总耗时从串行的8-12秒缩短到并行的4-6秒。每个阶段都有异常处理（exceptionally降级）和超时控制（orTimeout），单个知识源检索失败不影响整体流程，大模型调用超时30秒自动返回降级响应——注意超时同时要取消上游任务，否则"用户已拿到降级结果、Token 还在继续烧"。

---

#### 追问：
- 追问1：用 CompletableFuture 编排"检索+合规校验+生成"并行流水线时，若检索慢但生成快，如何设置合理的 allOf/anyOf 与超时，避免被最慢环节拖死？
  - **答**：设合理超时与降级：
    - ① 用 anyOf 取"检索完成即生成"或用 allOf + 整体 timeout（orTimeout/get(timeout)）避免被最慢拖死
    - ② 各环节独立超时（检索 3s、合规 2s），某环节超时不阻塞整体，缺失部分降级
    - ③ allOf 等三路齐了再生成，但总超时封顶，超时取已完成结果（部分检索标注）
    - ④ 超时用 orTimeout 抛异常，编排侧捕获降级；注意 orTimeout 只让结果 future 异常完成、不取消上游任务，要再 cancel(true) 止血（否则超时后 Token 照烧）
- 追问2：AI 流水线中某个阶段（如大模型生成）抛异常，CompletableFuture 的 exceptionally 如何优雅降级到"仅检索结果"而非整链失败？
  - **答**：用 exceptionally 捕获阶段异常，返回降级结果而非整链失败：
    - ① 生成阶段异常→返回"仅检索结果"（法规片段+因子），标记 partial
    - ② 检索异常→重试一次或降级关键词检索
    - ③ 每个阶段独立 exceptionally，避免一个失败拖垮全链
    - ④ 降级结果带 reason 让前端知悉
    - ⑤ 关键阶段（合规校验）失败可阻断并提示，非关键失败才降级，按重要性区分
- 追问3：多租户并发问答时，CompletableFuture 默认共用 ForkJoinPool 还是自定义线程池，如何避免租户间因共享池而互相阻塞？
  - **答**：应自定义线程池。CompletableFuture 默认用 ForkJoinPool.commonPool()，多租户共享该池，某租户大量任务占满会阻塞其他租户，且 commonPool 还被其它框架复用。
    - 隔离：
      - ① 每类/每租户用独立 ThreadPoolTaskExecutor，按租户路由
      - ② 或按业务分池（检索池/生成池）避免互相挤占
      - ③ 自定义池配合理队列与拒绝策略，配合租户配额限制并发
      - ④ 用 ContextCopyingTaskExecutor 保持租户上下文

### 55. 异步线程池监控与调优
**重要度**：★★★★

**题目：**
请设计碳管家AI助手异步线程池的监控方案，包括线程池状态指标采集、告警策略和动态调优机制。

**解答：**
线程池监控是保障异步处理稳定性的关键，需要实时采集线程池运行指标，设置合理告警阈值，并支持运行时动态调整参数。

```java
// 线程池监控指标采集
@Component
public class ThreadPoolMonitor implements SmartInitializingSingleton {

    @Autowired
    private Map<String, ThreadPoolTaskExecutor> executors;
    @Autowired
    private MeterRegistry meterRegistry;

    @Override
    public void afterSingletonsInstantiated() {
        // 为每个线程池注册监控指标
        executors.forEach((name, executor) -> {
            ThreadPoolExecutor pool = executor.getThreadPoolExecutor();

            // 活跃线程数
            meterRegistry.gauge("thread.pool.active",
                Tags.of("name", name), pool, ThreadPoolExecutor::getActiveCount);
            // 核心线程数
            meterRegistry.gauge("thread.pool.core.size",
                Tags.of("name", name), pool, ThreadPoolExecutor::getCorePoolSize);
            // 最大线程数
            meterRegistry.gauge("thread.pool.max.size",
                Tags.of("name", name), pool, ThreadPoolExecutor::getMaximumPoolSize);
            // 队列大小
            meterRegistry.gauge("thread.pool.queue.size",
                Tags.of("name", name), pool.getQueue(), Queue::size);
            // 已完成任务数
            meterRegistry.gauge("thread.pool.completed",
                Tags.of("name", name), pool, ThreadPoolExecutor::getCompletedTaskCount);
            // 线程池大小
            meterRegistry.gauge("thread.pool.size",
                Tags.of("name", name), pool, ThreadPoolExecutor::getPoolSize);
        });
    }

    // 定时检查线程池健康状态
    @Scheduled(fixedDelay = 10000)
    public void checkThreadPoolHealth() {
        executors.forEach((name, executor) -> {
            ThreadPoolExecutor pool = executor.getThreadPoolExecutor();
            int queueSize = pool.getQueue().size();
            int activeCount = pool.getActiveCount();
            int maxPoolSize = pool.getMaximumPoolSize();

            // 队列使用率超过80%告警
            // getQueue().size() 返回的是"当前排队元素个数"，不是队列容量；拿它当分母恒等于100%（空队列时0/0=NaN）
            // 容量必须在线程池构造时记下来（ThreadPoolExecutor 不暴露容量），与 new ArrayBlockingQueue<>(200) 保持一致
            int queueCapacity = 200;
            double queueUsage = (double) pool.getQueue().size() / queueCapacity * 100;
            if (queueUsage > 80) {
                alertService.send(AlertLevel.WARN,
                    String.format("线程池[%s]队列使用率%.1f%%，可能需要扩容", name, queueUsage));
            }

            // 线程池满载告警
            if (activeCount >= maxPoolSize && queueSize > 0) {
                alertService.send(AlertLevel.CRITICAL,
                    String.format("线程池[%s]已满载（%d/%d），队列积压%d个任务",
                        name, activeCount, maxPoolSize, queueSize));
            }
        });
    }
}

// 动态调参：运行时调整线程池参数
@Slf4j
@RestController
@RequestMapping("/api/admin/threadpool")
public class ThreadPoolManageController {

    @Autowired
    private Map<String, ThreadPoolTaskExecutor> executors;

    @PutMapping("/{name}/params")
    public String adjustParams(@PathVariable String name,
                                @RequestParam Integer corePoolSize,
                                @RequestParam(required = false) Integer maxPoolSize) {
        ThreadPoolTaskExecutor executor = executors.get(name);
        if (executor == null) return "线程池不存在: " + name;

        ThreadPoolExecutor pool = executor.getThreadPoolExecutor();

        // 【顺序很重要】ThreadPoolExecutor 不允许 core > max：直接 setCorePoolSize 传一个大于当前 max 的值会抛
        // IllegalArgumentException（反方向同理：setMaximumPoolSize 传到当前 core 以下也抛）。所以扩容时先调大 max 再调 core，
        // 缩容时先调小 core 再调 max。
        int targetMax = maxPoolSize != null ? maxPoolSize : pool.getMaximumPoolSize();
        if (corePoolSize > targetMax) {
            return "参数非法：corePoolSize(" + corePoolSize + ") 不能大于 maxPoolSize(" + targetMax + ")";
        }
        if (corePoolSize >= pool.getCorePoolSize()) {          // 扩容
            if (maxPoolSize != null) pool.setMaximumPoolSize(maxPoolSize);
            pool.setCorePoolSize(corePoolSize);
        } else {                                                // 缩容
            pool.setCorePoolSize(corePoolSize);
            if (maxPoolSize != null) pool.setMaximumPoolSize(maxPoolSize);
        }
        // 注意：有界队列的 capacity 运行时改不了，要改队列大小只能重建线程池（否则运维会误以为"扩容生效了"）
        log.info("线程池[{}]参数调整: core={}, max={}", name, corePoolSize, targetMax);
        return "调整成功";
    }

    @GetMapping("/{name}/status")
    public Map<String, Object> getStatus(@PathVariable String name) {
        ThreadPoolTaskExecutor executor = executors.get(name);
        ThreadPoolExecutor pool = executor.getThreadPoolExecutor();
        return Map.of(
            "activeCount", pool.getActiveCount(),
            "corePoolSize", pool.getCorePoolSize(),
            "maxPoolSize", pool.getMaximumPoolSize(),
            "queueSize", pool.getQueue().size(),
            "completedTaskCount", pool.getCompletedTaskCount(),
            "taskCount", pool.getTaskCount()
        );
    }
}
```

**一个容易踩的坑**：`getQueue().size()` 是元素个数，不是容量，`ThreadPoolExecutor` 也没有任何接口能拿到队列容量。所以线上线程池必须用**有界队列**（`ArrayBlockingQueue`，或显式指定容量的 `LinkedBlockingQueue`），并在构造处把容量记成常量供监控复用。`LinkedBlockingQueue` 默认容量是 `Integer.MAX_VALUE`，拿它做分母等于没监控——队列堆到几万也不会触发 80% 告警。

**AI/碳管理场景关联：**
碳管家AI助手的aiTaskExecutor线程池通过Micrometer实时监控：当AI问答请求高峰期队列积压超过80%时，自动触发钉钉告警，运维人员通过/api/admin/threadpool/aiTaskExecutor/params接口动态扩容线程池（如从10-50调整到20-80），无需重启应用。Grafana看板展示各线程池的活跃线程数、队列大小和任务完成数趋势，帮助容量规划。当大模型 API延迟增高导致线程池持续满载时，结合Sentinel熔断器自动降级非核心AI功能，保障核心碳法规查询不受影响。

---

#### 追问：
- 追问1：AI 异步线程池的活跃度、队列堆积等指标如何接入 Micrometer，当 queueSize 持续高位时如何自动告警而非等用户投诉？
  - **答**：用 Micrometer 暴露线程池指标：
    - ① 自定义 ThreadPoolTaskExecutor 子类，在 Micrometer 注册 gauge 上报 activeCount、queueSize、poolSize、completedTaskCount
    - ② 或用 ExecutorServiceMetrics.monitor() 包装线程池自动采集
    - ③ 设告警 queueSize 持续高位即告警
    - ④ 结合历史基线做异常检测，不等用户投诉
    - ⑤ 指标按池名+租户（若分池）打 tag 便于定位
- 追问2：线程池 corePoolSize=10、max=50，在 AI 调用 IO 密集且平均 3 秒的场景下，这个配比是根据压测还是经验，有没有饱和度与响应时间的权衡模型？
  - **答**：这是经验值起点，严谨应压测定。IO 密集（等 LLM/Milvus）线程大部分时间阻塞，可适当大池；但线程过多增上下文切换。
    - 权衡模型：
      - ① 用 Little's Law：并发≈吞吐×平均耗时，按目标 QPS 与 3s 估算所需并发线程
      - ② 压测找"响应时间拐点"（吞吐不增、延迟陡升）对应池大小
      - ③ 留余量并监控饱和（queueSize 高位=需扩）
      - ④ 虚拟线程（JDK21）可大幅简化，IO 密集不再受池大小束缚
- 追问3：线程池拒绝任务后被 CallerRunsPolicy 挤到调用线程执行的任务，其耗时是否计入原 HTTP 请求的 trace，会不会掩盖线程池已满的真实信号？
  - **答**：会掩盖。被 CallerRuns 挤到 HTTP 线程执行的任务，耗时算在 HTTP 请求 trace 内，看起来"请求慢"而非"线程池满"，且因没进池、队列不增，queueSize 正常，池满信号被掩盖。
    - 暴露：
      - ① 监控 rejectedCount（拒绝次数），CallerRuns 也计拒绝
      - ② trace 打 tag 标记"executed-by-caller"识别降级执行
      - ③ 告警 rejected>0 即提示容量不足，不能只看 queueSize
      - ④ 根本靠扩容/限流而非依赖 CallerRuns 吸收

### 56. 异步异常处理与重试机制
**重要度**：★★★★

**题目：**
请设计碳管家AI助手的异步异常处理和重试方案，包括@Async异常捕获、Spring Retry集成、指数退避策略和降级兜底。

**解答：**
AI服务调用涉及网络IO，异常和超时不可避免，需要完善的异常处理和重试机制保障服务可用性。

```java
// 1. @Async异常处理：通过AsyncUncaughtExceptionHandler
@Configuration
@EnableAsync
public class AsyncConfig implements AsyncConfigurer {
    @Override
    public AsyncUncaughtExceptionHandler getAsyncUncaughtExceptionHandler() {
        return (ex, method, params) -> {
            log.error("异步方法[{}]执行异常", method.getName(), ex);
            if (ex instanceof OpenAiRateLimitException) {
                // API限流：记录并通知
                alertService.notify("大模型 API限流", ex.getMessage());
            } else if (ex instanceof OpenAiTimeoutException) {
                // API超时：触发降级
                fallbackService.activateFallback();
            }
        };
    }
}

// 2. Spring Retry：自动重试 + 指数退避
// 【前提】@Retryable/@Recover 不会自动生效，必须显式开启：
@Configuration
@EnableRetry   // 漏了这一行，重试和 @Recover 降级全部静默失效（不报错，只是永远不重试）
public class RetryConfig {
}

@Service
public class CarbonChatRetryService {

    @Autowired
    private ChatClient chatClient;
    @Autowired
    private KeywordSearchFallback fallback;

    // 重试配置：最多3次，初始1秒间隔，指数退避倍数2，最大间隔10秒
    @Retryable(
        retryFor = {OpenAiTimeoutException.class, OpenAiServerError.class},
        noRetryFor = {OpenAiInvalidRequestException.class, ContentViolationException.class},
        maxAttempts = 3,
        backoff = @Backoff(delay = 1000, multiplier = 2.0, maxDelay = 10000)
    )
    public String chatWithRetry(String prompt) {
        log.info("调用大模型 API...");
        return chatClient.prompt(prompt).call().content();
        // 超时或服务端错误时自动重试
        // 客户端错误（如API Key无效、内容违规）不重试
    }

    // 重试耗尽后的降级方法
    @Recover
    public String fallbackChat(OpenAiTimeoutException ex, String prompt) {
        log.warn("AI调用重试耗尽，降级到关键词检索: {}", ex.getMessage());
        return fallback.search(prompt); // 降级为关键词检索
    }

    @Recover
    public String fallbackChat(OpenAiServerError ex, String prompt) {
        log.warn("AI服务端错误，降级到缓存回答: {}", ex.getMessage());
        return cacheService.findSimilarAnswer(prompt)
            .orElse("碳管家AI助手暂时不可用，请稍后重试或联系管理员。");
    }
}

// 3. CompletableFuture异常处理链
@Service
public class CarbonAiAsyncService {

    @Async("aiTaskExecutor")
    public CompletableFuture<ChatResponse> chatAsync(CarbonUser user, String question) {
        return CompletableFuture
            .supplyAsync(() -> {
                // 阶段1: RAG检索
                return ragRetrieve(question, user.getTenantId());
            }, aiExecutor)
            .thenComposeAsync(results -> {
                // 阶段2: 调用大模型
                return CompletableFuture.supplyAsync(() -> {
                    return callLlm(question, results);
                }, aiExecutor);
            })
            .thenApplyAsync(answer -> {
                // 阶段3: 后处理
                return postProcess(answer);
            }, aiExecutor)
            .handle((response, ex) -> {
                // 统一异常处理
                if (ex != null) {
                    log.error("AI异步调用失败", ex);
                    return ChatResponse.builder()
                        .answer("抱歉，AI助手暂时无法回答您的问题。")
                        .fallback(true)
                        .error(ex.getCause() != null ?
                            ex.getCause().getMessage() : ex.getMessage())
                        .build();
                }
                return response;
            })
            .orTimeout(30, TimeUnit.SECONDS)
            .exceptionally(ex -> {
                log.error("AI异步调用超时", ex);
                return ChatResponse.timeout(question);
            });
    }
}

// 4. 熔断器集成：Resilience4j
@Service
public class CarbonChatCircuitBreakerService {

    @CircuitBreaker(name = "carbonAiChat", fallbackMethod = "fallbackChat")
    @TimeLimiter(name = "carbonAiChat")
    public CompletableFuture<String> chatWithCircuitBreaker(String prompt) {
        return CompletableFuture.supplyAsync(() -> {
            return chatClient.prompt(prompt).call().content();
        }, aiExecutor);
    }

    // 熔断后的降级方法
    private CompletableFuture<String> fallbackChat(String prompt, Exception ex) {
        log.warn("AI服务熔断，执行降级: {}", ex.getMessage());
        return CompletableFuture.completedFuture(
            "碳管家AI助手当前服务繁忙，已为您切换到基础检索模式。" +
            fallbackService.keywordSearch(prompt)
        );
    }
}

// Resilience4j配置
/*
resilience4j:
  circuitbreaker:
    instances:
      carbonAiChat:
        register-health-indicator: true
        sliding-window-size: 10
        failure-rate-threshold: 50  # 失败率50%触发熔断
        wait-duration-in-open-state: 30s  # 熔断30秒后尝试半开
        permitted-number-of-calls-in-half-open-state: 3
  timelimiter:
    instances:
      carbonAiChat:
        timeout-duration: 30s
*/
```

**AI/碳管理场景关联：**
碳管家AI助手的三层容错策略：第一层Spring Retry自动重试瞬态故障（大模型供应商 5xx错误、网络超时），指数退避避免加重API压力；第二层Resilience4j熔断器在失败率超过50%时触发熔断，30秒后半开探测恢复；第三层降级策略在重试耗尽和熔断期间回退到关键词检索或缓存回答。当大模型 API大规模故障时，用户仍能通过关键词检索获取碳法规信息，虽然没有AI总结但核心查询功能不中断。所有异常和降级事件通过Micrometer指标记录，Grafana看板实时展示重试次数、熔断状态和降级比例。

---

#### 追问：
- 追问1：大模型调用偶发超时，重试时若用同一 prompt 重试会不会把重复请求计为多次 Token 消耗甚至触发限流，重试策略如何与应用层配额协同？
  - **答**：会重复计费与触发限流。协同：
    - ① 重试前检查租户配额，重试也算一次调用并计费（透明）
    - ② 用幂等 requestId，若首次实际已成功（仅响应超时）则不重复计费——但 LLM 侧难知，应用层对"已发请求"做去重/状态记录
    - ③ 重试次数上限 + 退避防雪崩
    - ④ 超时重试谨慎：仅对确定性可重试（网络抖动）重试，生成类超时重试可能重复消耗
    - ⑤ 配额扣减与重试次数联动预算
- 追问2：@Async 方法抛出未捕获异常时，默认 AsyncUncaughtExceptionHandler 只打日志，碳管家如何把异步失败（如后台法规同步失败）转成可观测的告警与补偿任务？
  - **答**：默认 AsyncUncaughtExceptionHandler 仅日志。改进：
    - ① 自定义 AsyncUncaughtExceptionHandler，捕获后发告警（Metrics 错误计数 + 通知）、写失败表
    - ② 对可补偿异步任务（如法规同步）失败后入重试队列/死信
    - ③ 用 @Async 返回 CompletableFuture，在 exceptionally 里统一处理失败与告警
    - ④ 关键异步任务用事务消息/事件确保失败可补偿，不只靠日志
- 追问3：重试对"非幂等"的 AI 写操作（如自动生成并落库碳报告）是危险的，如何区分可重试的查询类调用与不可重试的写入类调用？
  - **答**：区分策略：
    - ① 查询/检索类（RAG 检索、合规校验）天然幂等，可安全重试
    - ② 写入类（自动生成并落库碳报告）非幂等，重试会重复生成/重复计费，禁止盲目重试
    - ③ 用注解/分类标记操作类型（@Retryable 仅用于 query），写入类用"幂等键"（reportId）保证即使重试也只落一次（唯一约束/去重表）
    - ④ 重试框架按操作语义区分策略，写入类用幂等保护而非简单重试

#### 十五、Spring 定时任务

### 57. @Scheduled定时任务与Cron表达式
**重要度**：★★★★

**题目：**
请说明@Scheduled注解的使用方式、Cron表达式语法，以及碳管家AI助手中定时任务的应用场景。

**解答：**
@Scheduled注解标注在方法上，由ScheduledAnnotationBeanPostProcessor在Bean初始化后扫描并注册到ScheduledTaskRegistrar，通过TaskScheduler调度执行。

**@Scheduled参数：**
- cron：Cron表达式，如"0 0 2 * * ?"（每天凌晨2点）
- fixedDelay：上次执行结束后等待指定毫秒再执行下一次
- fixedRate：按固定频率执行（不等上次完成）
- initialDelay：首次执行延迟毫秒数
- zone：时区，默认服务器本地时区

**Cron表达式（6/7位）：**
秒 分 时 日 月 周 [年]
- "0 0 2 * * ?"：每天2:00:00执行
- "0 */30 * * * ?"：每30分钟执行
- "0 0 9-17 * * MON-FRI"：工作日9-17点每小时执行
- "0 0 0 1 * ?"：每月1号0点执行

```java
@Service
@Slf4j
public class CarbonAiScheduledTasks {

    // 1. 每天凌晨2点同步碳法规知识库
    @Scheduled(cron = "0 0 2 * * ?", zone = "Asia/Shanghai")
    public void syncCarbonLawIndex() {
        log.info("开始同步碳法规知识库...");
        try {
            // 从法规数据源拉取最新法规
            List<CarbonLaw> newLaws = lawDataService.fetchLatestLaws();
            // 批量生成嵌入向量：Spring AI 1.x 是 EmbeddingModel.embed(List<String>)（旧名 EmbeddingClient），
            // 一次请求多段文本，别用 parallelStream 逐条 embed（也会跑到 ForkJoinPool.commonPool 上）
            vectorStore.add(newLaws.stream()
                .map(law -> new Document(law.getId().toString(), law.getContent(),
                    Map.of("title", law.getTitle())))
                .collect(Collectors.toList()));
            log.info("碳法规知识库同步完成: 新增{}条法规", newLaws.size());
        } catch (Exception e) {
            log.error("碳法规知识库同步失败", e);
            alertService.notify("碳法规知识库同步失败", e.getMessage());
        }
    }

    // 2. 每5分钟检查AI服务健康状态
    // 别真调 LLM：一天 288 次既烧 Token 又往对话日志里写 ping 记录（与第45题追问1的结论一致）。
    // 这里探模型网关的 /v1/models（无 Token 消耗）或直接看连接池/HTTP 连通性
    private final AtomicInteger consecutiveFailures = new AtomicInteger(0);
    private static final int FAILURE_THRESHOLD = 3;

    @Scheduled(fixedDelay = 300000, initialDelay = 60000)
    public void checkAiServiceHealth() {
        try {
            // 轻量探测：网关可达即可，不生成内容
            boolean reachable = llmGatewayClient.ping(); // GET {baseUrl}/v1/models
            if (!reachable) {
                throw new IllegalStateException("模型网关不可达");
            }
            aiHealthStatus.setHealthy(true);
            consecutiveFailures.set(0);
        } catch (Exception e) {
            int failures = consecutiveFailures.incrementAndGet();
            log.warn("AI服务健康检查失败（连续{}次）: {}", failures, e.getMessage());
            // 连续失败达到阈值才降级，避免单次抖动误触发
            if (failures >= FAILURE_THRESHOLD) {
                aiHealthStatus.setHealthy(false);
                fallbackService.activateFallback();
                alertService.notify("AI服务连续" + failures + "次健康检查失败，已降级到关键词检索");
            }
        }
    }

    // 3. 每天凌晨3点清理过期对话上下文
    @Scheduled(cron = "0 0 3 * * ?")
    public void cleanupExpiredConversations() {
        int deleted = conversationService.cleanupExpired(LocalDateTime.now().minusDays(7));
        log.info("清理过期对话上下文: {}条", deleted);
    }

    // 4. 每月1号生成AI使用量统计报告
    @Scheduled(cron = "0 0 0 1 * ?")
    public void generateMonthlyAiReport() {
        LocalDate lastMonth = LocalDate.now().minusMonths(1);
        List<AiUsageReport> reports = usageService.aggregateMonthlyUsage(lastMonth);
        reports.forEach(report -> {
            notificationService.sendReport(report.getTenantId(), report);
        });
        log.info("月度AI使用量报告已发送: {}个租户", reports.size());
    }

    // 5. 每10分钟刷新碳排放因子缓存
    @Scheduled(fixedDelay = 600000)
    public void refreshEmissionFactorCache() {
        emissionFactorService.refreshCache();
        log.debug("碳排放因子缓存已刷新");
    }
}
```

**AI/碳管理场景关联：**
碳管家AI助手通过定时任务实现知识库自动维护：每天凌晨2点从国家发改委、生态环境部等官方渠道同步最新碳法规，生成向量嵌入并写入Milvus，确保AI回答引用的法规条款始终最新。每5分钟探测一次AI服务可用性（探网关连通性，不真调大模型省 Token），连续3次失败才触发降级，避免单次抖动误判。每月1号自动生成各租户的AI使用量报告，包含Token消耗、调用次数、成本分析等，通过邮件发送给企业管理员。这些定时任务确保了AI助手的知识时效性和服务稳定性。

---

#### 追问：
- 追问1：碳管家用 @Scheduled 定时同步碳法规索引，若任务执行时间超过下次触发周期（如同步 2 小时而 cron 每小时一次），默认是串行堆积还是并发重叠执行？
  - **答**：默认串行（单线程 ScheduledExecutor）。同一 @Scheduled 方法若上一次未结束，下一次不会并发重叠，而是等待（单线程调度下排队），不会并发执行同一任务；但任务很慢会"占用调度线程"导致其他 @Scheduled 任务也被延迟。
    - 风险：同步法规同步 2 小时而 cron 每小时一次，会持续占用调度线程、后续任务滞后。改进：任务自身异步化（@Async），调度线程只触发；或增大调度线程池。
- 追问2：fixedDelay 与 cron 在 Pod 多副本部署下都会各自触发，同一份法规同步任务在多 Pod 上重复执行，单靠 @Scheduled 如何避免重复劳动？
  - **答**：会重复。@Scheduled 在各 Pod 独立触发，多副本下同一任务在多 Pod 同时跑，重复同步/浪费。
    - 避免：
      - ① 用 ShedLock（DB 锁）保证单实例执行
      - ② 或用分布式调度（XXL-Job/Elastic-Job）统一派发
      - ③ 或 leader 选举（仅主 Pod 执行）
      - ④ K8s 下可设该任务只在一个专用 Pod（Job 非常驻）
      - ⑤ 幂等 + 去重兜底，即使重复也不出错

### 58. 分布式定时任务与ShedLock集成
**重要度**：★★★★

**题目：**
在微服务多实例部署场景下，请说明如何使用ShedLock确保定时任务在集群中仅执行一次，以及碳管家AI助手中的实践。

**解答：**
当应用部署多实例时，@Scheduled定时任务在每个实例中都会执行，导致重复执行。ShedLock通过分布式锁机制确保同一时刻只有一个实例执行定时任务。

**ShedLock工作原理：**
1. 定时任务触发时，尝试在共享存储（Redis/JDBC/MongoDB）中获取锁。
2. 获取锁成功的实例执行任务，其他实例跳过。
3. 锁记录带 `lockAtMostFor`（兜底 TTL），防止实例宕机后锁永远不释放。
4. **任务执行完成后 ShedLock 不主动释放锁**：`JdbcTemplateLockProvider.unlock()` 是空实现，锁记录要留到 `lockAtLeastFor` 到期。这正是它防止"节点重启后立刻重跑"的机制，所以 `lockAtLeastFor` 必须小于任务最短间隔、`lockAtMostFor` 必须大于任务最长执行时间。

```java
// ShedLock配置
@Configuration
@EnableScheduling
@EnableSchedulerLock(defaultLockAtMostFor = "PT30M") // 默认锁最大持有30分钟
public class ShedLockConfig {

    @Bean
    public LockProvider lockProvider(DataSource dataSource) {
        return new JdbcTemplateLockProvider(
            JdbcTemplateLockProvider.Configuration.builder()
                .withJdbcTemplate(new JdbcTemplate(dataSource))
                .usingDbTime()
                .build()
        );
    }
}

// 使用@SchedulerLock注解
@Service
public class CarbonAiDistributedScheduledTasks {

    // 碳法规知识库同步：锁30分钟，最少锁5分钟
    @Scheduled(cron = "0 0 2 * * ?")
    @SchedulerLock(name = "syncCarbonLawIndex",
                   lockAtLeastFor = "PT5M",   // 至少锁5分钟（防止节点快速重启重复执行）
                   lockAtMostFor = "PT30M")   // 最多锁30分钟（防止节点宕机锁不释放）
    public void syncCarbonLawIndex() {
        log.info("开始同步碳法规知识库（实例: {}）", instanceId);
        // 只有获取到锁的实例会执行此方法
        doSyncLaws();
    }

    // AI使用量统计报告生成
    @Scheduled(cron = "0 0 0 1 * ?")
    @SchedulerLock(name = "generateMonthlyReport", lockAtMostFor = "PT1H")
    public void generateMonthlyReport() {
        log.info("开始生成月度AI使用量报告");
        doGenerateReport();
    }

    // 向量索引重建
    @Scheduled(cron = "0 0 4 * * SUN") // 每周日凌晨4点
    @SchedulerLock(name = "rebuildVectorIndex", lockAtMostFor = "PT2H")
    public void rebuildVectorIndex() {
        log.info("开始重建Milvus向量索引");
        vectorStore.rebuildIndex();
    }
}
```

**ShedLock vs XXL-Job/Elastic-Job对比：**
- ShedLock：轻量级，仅解决重复执行问题，适合简单的定时任务场景。
- XXL-Job：功能全面的分布式任务调度平台，支持任务路由、失败重试、动态分片、任务监控，适合复杂调度场景。
- Elastic-Job：支持弹性分片，适合大数据量并行处理场景。

**AI/碳管理场景关联：**
碳管家AI助手部署3个实例实现高可用，通过ShedLock确保碳法规知识库同步任务仅在一个实例执行：凌晨2点，3个实例同时触发syncCarbonLawIndex方法，但只有第一个获取到数据库锁的实例执行同步逻辑，其他两个实例直接跳过。lockAtLeastFor=5分钟防止同步过程中实例重启导致另一实例重复执行；lockAtMostFor=30分钟确保实例宕机后锁能自动过期、下一日同步不受影响。注意锁不会"执行完就释放"，锁记录要留到 lockAtLeastFor 到期。对于碳法规向量索引重建这种耗时可能超过1小时的场景，单靠 ShedLock 不够：要么把 lockAtMostFor 放大到远大于最长执行时间（同时接受故障转移变慢），要么拆成可断点续传的子任务由调度中心（XXL-Job，需另行接入）驱动重跑。

---

#### 追问：
- 追问1：ShedLock 基于数据库锁保证单实例执行，若持有锁的 Pod 在任务执行中宕机，锁的过期时间如何设置才能在"防重复"和"故障转移及时性"之间平衡？
  - **答**：锁过期时间设"略大于任务最大执行时长"。太短：任务未完锁过期，另一 Pod 抢锁重复执行；太长：持有锁 Pod 宕机后故障转移要等锁过期才能接手，恢复慢。
    - 平衡：
      - ① 按历史执行时长 P99 + 余量设 lockAtMost
      - ② 任务内定期"续租"（lockAtLeast 较短、运行中续期）防长任务被抢
      - ③ 监控锁持有超时告警
      - ④ 宕机场景接受"最多一个锁周期"的延迟转移
- 追问2：ShedLock 默认锁住的是方法名，若碳管家有多种法规同步任务共用同一锁 key，会不会互相排斥导致本可并行的任务被串行化？
  - **答**：会。ShedLock 默认用方法名/name 作锁 key，若多个不同同步任务 @SchedulerLock(name) 设成相同 name，会互斥串行，本可并行的被串行。
    - 修复：
      - ① 每个任务用唯一 name（如 syncCarbonLaw、syncEmissionFactor）
      - ② 按任务粒度设锁互不干扰
      - ③ 锁 key 可含参数（如租户）实现更细粒度
      - ④ 避免为省事共用同名锁导致吞吐下降
- 追问3：ShedLock 只解决"不重复执行"而不保证"一定执行"，持有锁的 Pod 中途 OOM 后该次同步就丢失了，如何补做失败重试与丢任务检测？
  - **答**：会丢。ShedLock 只保证"不重复"，不保证"一定执行"——持有锁 Pod OOM，任务没跑且锁释放后也没人补。
    - 补救：
      - ① 任务执行前先写"待执行/执行中"状态到 DB（任务表），OOM 后另一 Pod 检测"超时未完成"触发补跑
      - ② 用任务调度表 nextRunTime + 心跳，失败/超时任务重新入队
      - ③ 关键同步任务加监控告警，发现未按时完成即人工/自动补
      - ④ 结合"执行记录对账"确保不漏跑

### 59. 动态定时任务与运行时调度管理
**重要度**：★★★

**题目：**
请设计碳管家AI助手的动态定时任务管理方案，支持通过管理界面增删改查定时任务，运行时调整Cron表达式，无需重启应用。

**解答：**
Spring的@Scheduled注解是静态的，Cron表达式在编译时确定。动态定时任务需要使用Spring的TaskScheduler API编程式管理任务调度。

```java
// 动态定时任务管理服务
@Service
public class DynamicTaskService {

    @Autowired
    private TaskScheduler taskScheduler;

    // 任务配置的持久化仓库（原示例漏声明，直接编译不过）
    @Autowired
    private TaskConfigRepository taskConfigRepository;

    // 存储已调度的任务（任务ID -> ScheduledFuture）
    private final Map<Long, ScheduledFuture<?>> scheduledTasks = new ConcurrentHashMap<>();
    // 存储任务配置
    private final Map<Long, TaskConfig> taskConfigs = new ConcurrentHashMap<>();

    // 管理界面查询用
    public List<TaskConfig> getAllTasks() {
        return taskConfigRepository.findAll();
    }

    // 添加定时任务
    public void addTask(TaskConfig config) {
        Runnable task = createTask(config);
        CronTrigger trigger = new CronTrigger(config.getCronExpression());
        ScheduledFuture<?> future = taskScheduler.schedule(task, trigger);
        scheduledTasks.put(config.getId(), future);
        taskConfigs.put(config.getId(), config);
        log.info("添加定时任务: id={}, name={}, cron={}",
            config.getId(), config.getName(), config.getCronExpression());
    }

    // 更新定时任务（先取消旧任务，再添加新任务）
    public void updateTask(TaskConfig config) {
        cancelTask(config.getId());
        addTask(config);
        log.info("更新定时任务: id={}, newCron={}", config.getId(), config.getCronExpression());
    }

    // 删除定时任务
    public void removeTask(Long taskId) {
        cancelTask(taskId);
        taskConfigs.remove(taskId);
        log.info("删除定时任务: id={}", taskId);
    }

    // 立即执行任务
    public void runTaskNow(Long taskId) {
        TaskConfig config = taskConfigs.get(taskId);
        if (config != null) {
            CompletableFuture.runAsync(() -> createTask(config).run());
            log.info("手动触发任务: id={}", taskId);
        }
    }

    // 暂停任务
    public void pauseTask(Long taskId) {
        cancelTask(taskId);
        log.info("暂停任务: id={}", taskId);
    }

    // 恢复任务
    public void resumeTask(Long taskId) {
        TaskConfig config = taskConfigs.get(taskId);
        if (config != null) {
            addTask(config);
            log.info("恢复任务: id={}", taskId);
        }
    }

    private void cancelTask(Long taskId) {
        ScheduledFuture<?> future = scheduledTasks.get(taskId);
        if (future != null) {
            future.cancel(false);
            scheduledTasks.remove(taskId);
        }
    }

    // 根据配置创建任务Runnable
    private Runnable createTask(TaskConfig config) {
        return () -> {
            try {
                log.info("执行定时任务: {}", config.getName());
                switch (config.getTaskType()) {
                    case SYNC_LAW -> carbonLawSyncService.sync();
                    case REBUILD_INDEX -> vectorIndexService.rebuild(config.getParams());
                    case GENERATE_REPORT -> reportService.generate(config.getParams());
                    case CLEANUP_CACHE -> cacheCleanupService.cleanup(config.getParams());
                    case AI_HEALTH_CHECK -> aiHealthService.check();
                }
            } catch (Exception e) {
                log.error("定时任务执行失败: {}", config.getName(), e);
            }
        };
    }

    // 应用启动时从数据库加载所有启用的定时任务
    // 注意：TaskScheduler 的单机语义，多 Pod 会各自调度一遍——动态任务同样要接 ShedLock 或交给独立调度中心
    @PostConstruct
    public void initTasks() {
        List<TaskConfig> activeTasks = taskConfigRepository.findByEnabledTrue();
        activeTasks.forEach(this::addTask);
        log.info("加载了{}个定时任务", activeTasks.size());
    }
}

// 任务配置实体
@Data
@Entity
public class TaskConfig {
    @Id @GeneratedValue
    private Long id;
    private String name;
    private String cronExpression;
    private TaskType taskType;
    private String params;      // JSON格式的任务参数
    private boolean enabled;
    private String description;
    private LocalDateTime createdAt;
    private LocalDateTime updatedAt;
}

// 管理接口
@RestController
@RequestMapping("/api/admin/tasks")
public class TaskManageController {

    @Autowired
    private DynamicTaskService taskService;

    // 同样是原示例漏掉的依赖
    @Autowired
    private TaskConfigRepository taskConfigRepository;

    @GetMapping
    public List<TaskConfig> listTasks() {
        return taskService.getAllTasks();
    }

    @PostMapping
    public TaskConfig createTask(@RequestBody TaskConfig config) {
        config.setEnabled(true);
        taskConfigRepository.save(config);
        taskService.addTask(config);
        return config;
    }

    @PutMapping("/{id}")
    public TaskConfig updateTask(@PathVariable Long id, @RequestBody TaskConfig config) {
        config.setId(id);
        taskConfigRepository.save(config);
        taskService.updateTask(config);
        return config;
    }

    @DeleteMapping("/{id}")
    public void deleteTask(@PathVariable Long id) {
        taskService.removeTask(id);
        taskConfigRepository.deleteById(id);
    }

    @PostMapping("/{id}/run")
    public void runNow(@PathVariable Long id) {
        taskService.runTaskNow(id);
    }

    @PostMapping("/{id}/pause")
    public void pause(@PathVariable Long id) {
        taskService.pauseTask(id);
    }

    @PostMapping("/{id}/resume")
    public void resume(@PathVariable Long id) {
        taskService.resumeTask(id);
    }
}
```

**AI/碳管理场景关联：**
碳管家AI助手通过动态定时任务管理实现灵活的运维控制：运维人员通过管理界面查看所有定时任务列表（碳法规同步、向量索引重建、缓存清理等），可以临时调整碳法规同步频率（如新法规发布期间从每日改为每4小时同步一次），手动触发向量索引重建（添加新法规后立即更新索引），暂停非关键任务（如月度报告生成在系统高峰期暂停）。任务配置持久化到数据库，应用重启后自动恢复所有任务调度。每个任务的执行日志和结果记录在审计表中，支持执行历史查询。

---

#### 追问：
- 追问1：运行时动态注册/修改定时任务（如按租户配置不同的法规同步频率），如何在不重启的前提下安全增删 Trigger，且避免与 Spring 原生 @Scheduled Bean 冲突？
  - **答**：用独立调度器（ScheduledThreadPoolExecutor / Quartz）管理动态 Trigger，与 Spring @Scheduled Bean 分开：
    - ① @Scheduled 管静态任务，动态任务由自建 SchedulerRegistry 管理（register/unregister Trigger），互不冲突
    - ② 动态 Trigger 存 DB，启动加载，运行时增删即时生效（reschedule）
    - ③ 动态任务与 @Scheduled 用不同线程池，避免互相阻塞
    - ④ 动态任务也走 ShedLock 防多 Pod 重复
    - ⑤ 提供管理 API 安全增删并校验
- 追问2：动态调度配置存数据库，若配置被误删或数据库不可用，正在运行或待触发的动态任务会进入什么状态，有没有默认值兜底？
  - **答**：兜底：
    - ① 动态任务配置从 DB 加载，DB 不可用则用上次内存缓存（启动快照）继续跑并告警
    - ② 配置误删：任务按"最后已知配置"继续执行直到下次刷新，或标记 suspended 暂停并告警，避免静默
    - ③ 关键任务配置有默认值（如默认每小时）兜底，不因子配置缺失而停摆
    - ④ 提供配置版本与回收站，误删可恢复
    - ⑤ DB 恢复后重新对齐配置
- 追问3：不同租户的同步任务并发触发时，如何做资源隔离与配额，避免某个大租户的同步任务占满线程池拖垮其他租户？
  - **答**：隔离：
    - ① 按租户分调度线程池/队列，或大租户限并发度
    - ② 每个租户同步任务带租户配额（最大并发、最大速率），超额排队
    - ③ 用信号量/令牌桶限制单租户资源占用
    - ④ 大租户任务分批，避免一次占满线程池
    - ⑤ 监控各租户同步耗时与资源，异常租户限流
    - ⑥ 共享池设公平调度防大租户饿死小租户
    - ⑦ 关键租户高优先级队列

### 60. 定时任务在AI知识库维护与模型微调中的应用
**重要度**：★★★

**题目：**
请设计碳管家AI助手的知识库自动维护和模型微调调度方案，包括向量索引优化、知识库去重更新、用户反馈收集与模型微调数据准备的定时任务编排。

**解答：**
AI系统的知识库和模型需要持续维护以保持服务质量。通过定时任务编排实现自动化的知识库更新、索引优化和微调数据准备。

```java
@Service
@Slf4j
public class CarbonAiMaintenanceScheduler {

    @Autowired
    private CarbonLawRepository lawRepo;
    @Autowired
    private MilvusVectorStore vectorStore;
    @Autowired
    private EmbeddingModel embeddingModel;
    @Autowired
    private AiFeedbackRepository feedbackRepo;
    @Autowired
    private CarbonLawSourceService lawSourceService;

    // ========== 知识库维护任务 ==========

    // 1. 每天2:00 - 增量同步碳法规
    @Scheduled(cron = "0 0 2 * * ?")
    @SchedulerLock(name = "incrementalSyncLaws", lockAtMostFor = "PT1H")
    public void incrementalSyncLaws() {
        log.info("=== 开始增量同步碳法规 ===");
        LocalDateTime lastSync = syncRecordService.getLastSyncTime();
        List<CarbonLaw> newLaws = lawSourceService.fetchUpdatedSince(lastSync);

        if (newLaws.isEmpty()) {
            log.info("无新增碳法规");
            return;
        }

        // 写入Milvus：VectorStore.add 只接收 List<Document>，不接受 Map；
        // 向量由 VectorStore 内部调 EmbeddingModel 生成，不需要手动 embed 后传 vector。
        // 若确实要自己算向量（如换 embedding 模型做迁移），用 EmbeddingModel.embed(List<String>) 拿 List<float[]>，
        // 注意 Spring AI 1.x 里 EmbeddingClient 已更名 EmbeddingModel，也没有 embedBatch 方法
        List<Document> documents = new ArrayList<>();
        for (CarbonLaw law : newLaws) {
            documents.add(new Document(
                law.getId().toString(),
                law.getContent(),
                Map.of("title", law.getTitle(), "tenant_id", "0")  // 公共法规
            ));
        }
        vectorStore.add(documents);

        syncRecordService.updateLastSyncTime(LocalDateTime.now());
        log.info("=== 增量同步完成: 新增{}条法规 ===", newLaws.size());
    }

    // 2. 每周日3:00 - 向量索引优化
    @Scheduled(cron = "0 0 3 * * SUN")
    @SchedulerLock(name = "optimizeVectorIndex", lockAtMostFor = "PT2H")
    public void optimizeVectorIndex() {
        log.info("=== 开始Milvus向量索引优化 ===");

        // 检查索引状态
        IndexInfo indexInfo = vectorStore.describeIndex();
        if (indexInfo.needsRebuild()) {
            log.info("索引需要重建，开始重建...");
            vectorStore.dropIndex();
            vectorStore.createIndex(IndexParams.IVF_FLAT(1024, MetricType.COSINE));
            log.info("索引重建完成");
        }

        // 统计向量数量
        long totalVectors = vectorStore.count();
        log.info("当前向量总数: {}", totalVectors);

        // 压缩旧数据（6个月前的法规合并摘要）
        List<Long> oldLawIds = lawRepo.findIdsOlderThan(LocalDateTime.now().minusMonths(6));
        if (!oldLawIds.isEmpty()) {
            vectorStore.compact(oldLawIds);
            log.info("压缩了{}条旧法规向量", oldLawIds.size());
        }
    }

    // 3. 每天4:00 - 知识库去重检查
    @Scheduled(cron = "0 0 4 * * ?")
    @SchedulerLock(name = "deduplicateKnowledge", lockAtMostFor = "PT30M")
    public void deduplicateKnowledge() {
        log.info("=== 开始知识库去重 ===");
        // 检测高度相似的向量对（余弦相似度>0.98）
        List<VectorPair> duplicates = vectorStore.findDuplicates(0.98);
        for (VectorPair pair : duplicates) {
            // 保留较新的向量，删除较旧的
            vectorStore.deleteById(pair.getOlderId());
            log.info("删除重复向量: {}（保留{}）", pair.getOlderId(), pair.getNewerId());
        }
        log.info("=== 去重完成: 删除{}条重复向量 ===", duplicates.size());
    }

    // ========== 模型微调数据准备 ==========

    // 4. 每月1号5:00 - 收集用户反馈生成微调数据集
    @Scheduled(cron = "0 0 5 1 * ?")
    @SchedulerLock(name = "prepareFineTuningData", lockAtMostFor = "PT3H")
    public void prepareFineTuningData() {
        log.info("=== 开始准备模型微调数据 ===");
        LocalDate lastMonth = LocalDate.now().minusMonths(1);

        // 1. 收集高质量对话（用户评分4-5分）
        List<AiFeedback> goodFeedbacks = feedbackRepo
            .findByRatingBetweenAndCreatedAtBetween(4, 5,
                lastMonth.atStartOfDay(), lastMonth.plusMonths(1).atStartOfDay());

        // 2. 收集低质量对话（用户评分1-2分），用于学习避免的错误
        List<AiFeedback> badFeedbacks = feedbackRepo
            .findByRatingBetweenAndCreatedAtBetween(1, 2,
                lastMonth.atStartOfDay(), lastMonth.plusMonths(1).atStartOfDay());

        // 3. 构建微调数据集（JSONL格式）
        // 消息顺序必须 system → user → assistant：system 放首条且写任务指令，
        // 评分这类标注只作为样本元数据（下面的 quality 字段），塞进 messages 会被当成正文训练进去
        List<FineTuningExample> examples = new ArrayList<>();
        for (AiFeedback fb : goodFeedbacks) {
            ChatRecord record = chatRecordRepo.findById(fb.getSessionId());
            examples.add(FineTuningExample.builder()
                .messages(List.of(
                    Message.system("你是碳管理领域的法规问答助手，回答需引用具体碳法规条款与排放因子。"),
                    Message.user(record.getQuestion()),
                    Message.assistant(record.getAnswer())
                ))
                .quality("good")
                .build());
        }

        // 4. 导出为微调格式（JSONL messages，通义千问/DeepSeek 通用）
        String filePath = "/data/fine-tuning/carbon-ai-" + lastMonth + ".jsonl";
        fineTuningExporter.export(examples, filePath);
        log.info("=== 微调数据准备完成: {}条优质样本, {}条负面样本 ===",
            goodFeedbacks.size(), badFeedbacks.size());

        // 5. 通知AI团队审核数据集
        notificationService.notifyAiTeam("月度微调数据集已生成",
            String.format("文件: %s, 优质样本: %d, 需审核后上传至对应供应商微调API",
                filePath, goodFeedbacks.size()));
    }

    // 5. 每天5:30 - 更新Prompt模板（基于A/B测试结果）
    @Scheduled(cron = "0 30 5 * * ?")
    @SchedulerLock(name = "updatePromptTemplates", lockAtMostFor = "PT15M")
    public void updatePromptTemplates() {
        log.info("=== 更新Prompt模板 ===");
        // 获取A/B测试结果
        AbTestResult result = abTestService.getLatestResult();
        if (result.hasWinner()) {
            String winnerTemplate = result.getWinnerTemplate();
            promptTemplateService.updateActiveTemplate(winnerTemplate);
            log.info("Prompt模板已更新为版本: {}", result.getWinnerVersion());
        }
    }
}
```

**AI/碳管理场景关联：**
碳管家AI助手通过定时任务编排实现AI系统的自进化：每日增量同步碳法规并生成向量嵌入，确保AI回答引用最新法规；每周优化Milvus索引保持检索性能；每月收集用户反馈（评分4-5分的优质对话）构建微调数据集，提交AI团队审核后按供应商走对应微调 API（通义千问/DeepSeek 的微调接口；自部署 GLM 走 LoRA 本地训练），使AI回答更贴合碳管理领域的专业需求。A/B测试自动评估不同Prompt模板的效果，每日自动选择最优模板。这套自动化维护机制使碳管家AI助手的知识库始终保持最新，AI回答质量随使用量增加而持续提升，形成了"用户使用→反馈收集→数据分析→模型优化→体验提升"的正向闭环。

---

#### 追问：
- 追问1：定时用 AI 做法规知识库增量抽取与向量化，若文档量大，单次批处理如何做分片与断点续跑，避免中途失败全量重来？
  - **答**：分片+断点：
    - ① 按文档/章节分批（每批 100 篇），每批处理完更新 offset/checkpoint 到 DB
    - ② 失败从中断批次续跑，不重头
    - ③ 用任务状态表记录每批状态（pending/doing/done），异常重启从 doing/pending 续
    - ④ 向量化并行分片但控制并发防 Milvus 压力
    - ⑤ 已处理文档用指纹/版本去重避免重复向量化
    - ⑥ 批量写 Milvus 用批量 API 提吞吐
- 追问2：定时触发模型微调/重训练时，如何评估新模型相比线上模型的回答质量，有没有自动化的回归评测门禁，不达标就不发布？
  - **答**：建评测门禁：
    - ① 维护评测集（标准问答/合规题），新模型在子集上跑 RAGAS/人工评分
    - ② 设定质量阈值（准确率、引用准确率、幻觉率），新模型须达标才发布
    - ③ CI/流水线自动跑评测，不达标阻断发布并告警
    - ④ 对比新旧模型指标（回归对比），显著下降即拦
    - ⑤ 人工抽检关键合规题
    - ⑥ 模型注册到模型仓库，发布前灰度+门禁，确保不退化才上线
- 追问3：法规知识库更新后 Milvus 向量需要重建，定时任务与线上 RAG 检索的"索引切换"如何做到平滑（蓝绿 collection），避免检索到 Half-写入的脏数据？
  - **答**：蓝绿 collection：
    - ① 新索引建到独立 collection（carbon_law_v2）与线上 v1 并存
    - ② 构建完校验新索引质量（抽样检索比对）
    - ③ 切换：改路由配置指向 v2（或 alias 切换），线上 RAG 查询瞬间切到新 collection，无脏数据
    - ④ 旧 v1 保留一段时间可回滚
    - ⑤ 切换通过配置/alias 原子切换，避免检索到"半写入"状态
    - ⑥ 切换后监控召回质量，异常回滚 v1


---
