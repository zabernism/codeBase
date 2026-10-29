## 第五章：MCP协议与AI工具集成

> 本章是 AI 连接外部能力的新协议：MCP 的 Client/Server 架构、传输方式、Spring AI 中的 MCP 支持，以及如何实现自定义 MCP Server（工具 / 资源 / 提示三类能力分别对应 `@McpTool`、`@McpResource`、`@McpPrompt`）。它是 Function Calling 之外，模型侧对接外部系统的事实标准之一。



### 1. MCP（Model Context Protocol）协议详解
**重要度**：★★★★★

**MCP**是Anthropic于2024年提出的开放标准协议，旨在标准化AI模型与外部工具/数据源的交互方式。类比USB-C统一外设接口，MCP统一AI与外部系统的连接方式。取代之前每个工具/数据源都需要定制集成的碎片化局面。

**核心设计理念**：(1) 客户端-服务器架构，AI应用作为Client，工具/数据源作为Server；(2) 基于JSON-RPC 2.0消息协议；(3) 能力协商，Server声明提供的工具/资源/提示模板；(4) 安全性内置（传输加密、认证授权）。

**核心原语（2025-11-25 版）**：
- **Tools（工具）**：模型可调用的函数，类似Function Calling但标准化了描述和结果格式
- **Resources（资源）**：Server暴露的数据，Client可读取（文件、数据库记录、API数据）
- **Prompts（提示模板）**：预定义的提示词模板，支持参数化
- **Elicitation（引导）**：Server 反向向用户索取补充输入（2025-06-18 引入，2025-11-25 增加 URL 模式，可让用户跳转外部页面完成授权/填写）
- **Roots（根目录）**：Client 告诉 Server「你可以访问哪些根目录/工作区」，用于限定 Server 的文件系统边界
- **Sampling（采样）**：Server可以反向请求Client调用LLM（用于Agent链式调用）
- **Logging（日志）**：Server 向 Client 推送结构化日志

⚠️ **版本提醒**：2026-07-28 版规范已把 **Sampling / Roots / Logging 标记为 deprecated**，服务端反向请求统一改走 **MRTR（Multi Round-Trip Requests）**。现在答这题时补一句版本差异是明显的加分项——详见本章最后一题《MCP 规范演进》。

碳管家AI助手使用MCP统一连接碳数据库查询工具、LCA模型计算工具、知识库检索工具，避免为每个工具写定制集成代码。

#### 追问：
- 追问1：MCP 的能力协商在连接建立时完成，若某个 Server 中途新增了工具能力，Client 能否感知？协议本身是否支持运行期重新协商？
  - **答**：MCP 的能力协商在初始化阶段完成一次，协议本身并未定义运行期主动推送能力变更的机制。
    - Client 如需感知新增能力，需主动再次发起 `tools/list`（例如定时轮询、或监听注册中心/Nacos 变更事件）重新拉取工具列表。
    - 生产上通常结合服务发现的变更事件触发 Client 重新协商，而非依赖协议内置的运行期重协商。
- 追问2：碳管家把碳数据库、LCA 计算、知识库统一用 MCP 接入，如果某次用户提问需要跨三个 Server 组合事实，协议层面如何保证这些 Tool 之间的上下文不被泄露或串扰？
  - **答**：MCP 协议本身不跨 Server 共享状态——每次 `tools/call` 都是独立的 JSON-RPC 请求，跨 Server 的事实组合由 Client（AI 对话服务）在内存中聚合。
    - 隔离靠两点：一是工具结果仅在本次对话上下文中拼接，不回写任何其他 Server；二是租户 companyId 在 Client 层统一注入与校验，防止 A 企业数据串入 B 企业的请求上下文。

### 2. MCP的Client/Server架构
**重要度**：★★★★★

**Client职责**：发起连接、发送请求（列出工具/调用工具/读取资源）、管理多个并行连接、聚合多个Server的能力给LLM。AI应用（如Claude Desktop、Spring AI应用）通常是Client。

**Server职责**：注册并暴露能力（Tools/Resources/Prompts）、处理Client请求并返回结果、可主动通过Sampling请求LLM。每个Server专注单一数据源或功能。

**生命周期**：
1. **初始化**：Client发起连接 → 能力协商（协议版本、支持的能力）→ Server返回能力列表
2. **运行**：Client发送`tools/list` → `tools/call` → 处理结果
3. **终止**：任一方可关闭连接

**碳管家架构示例**：
- 一个MCP Client：AI对话服务（Spring AI）
- 多个MCP Server：碳数据库Server（查询企业碳排放数据）、LCA计算Server（产品碳足迹计算）、知识库Server（法规/标准检索）、报告生成Server（生成碳排放报告）

Spring AI通过`McpClient`管理连接，聚合所有Server的工具列表发给LLM。

#### 追问：
- 追问1：当 AI 对话服务作为唯一 Client 同时连接多个 Server，某个 Server 响应缓慢会阻塞其他 Server 的调用吗？如何做隔离与超时控制？
  - **答**：不会整体阻塞——每个 Server 调用彼此独立，Client 用异步（CompletableFuture / 响应式）并发发起，慢 Server 不拖累其他调用。
    - 隔离与超时：单 Server 调用设独立超时（如 10s）；慢 Server 走熔断（Resilience4j），避免连接/线程被耗尽，保护其他健康 Server。
- 追问2：碳管家的多个 MCP Server 各自独立部署，Client 聚合工具列表后如何向 LLM 暴露，才能避免工具数量过多导致 System Prompt 超限或路由混乱？
  - **答**：关键是按需裁剪而非全量暴露。
    - 按领域/租户分组，只把与当前问题相关的工具送入 Prompt（动态裁剪或按意图路由）。
    - 工具描述精简、控制总数；可用向量检索做工具召回，仅把 Top-K 相关工具定义发给 LLM，避免 System Prompt 超限与路由混乱。
- 追问3：如果碳数据库 Server 与 LCA 计算 Server 需要共享同一份企业主数据，MCP 架构下应由谁负责一致性，Client 还是 Server？
  - **答**：应由数据层负责一致性，而非 MCP 协议或 Client。
    - 两个 Server 各自从共享数据源（同一 MySQL/TiDB 主数据服务）读取，一致性由数据库事务/主数据服务保证。
    - Client 只做编排，不持有主数据副本，避免多处副本产生不一致。

### 3. Spring AI中的MCP支持
**重要度**：★★★★★

Spring AI从1.0.0-M5版本开始内置MCP支持，提供`spring-ai-mcp`模块。**三个版本对 MCP 的定位差别很大，面试要能分清**：

- **1.0（2025年5月）**：从 1.0.0-M5 起内置 MCP 支持，提供 `spring-ai-mcp` 模块
- **1.1（2025年11月）**：MCP 成为本版本**最大特性**——提供 Spring Boot 自动配置与完整注解编程模型（`@McpTool`/`@McpResource`/`@McpPrompt`），支持 STDIO / HTTP SSE / Streamable HTTP 三种传输，客户端与服务端各有专用 starter，并集成 OAuth2 安全
- **2.0（2026年6月）**：MCP 升级为**一等公民**——随附 **MCP Java SDK 2.0.0**（符合 2025-11-25 版 MCP 规范）；`mcp-annotations` 模块从社区（`org.springaicommunity.mcp.*`）并入 Spring AI 核心（`org.springframework.ai.mcp.annotation.*`）；WebMVC/WebFlux 传输实现从 MCP Java SDK 移入 Spring AI 自身（groupId 改为 `org.springframework.ai`）；**Streamable HTTP 成为默认传输，取代已废弃的 SSE 传输**；新增统一的 `McpSyncRequestContext` / `McpAsyncRequestContext` 注入入口，日志、进度上报、sampling、elicitation 都从这一个入口拿

主要组件：

**McpClient**：MCP客户端，管理多个Server连接。`@Bean McpClient mcpClient()`配置连接参数。

**McpAsyncClient**：异步版本，支持WebFlux响应式编程。

**工具自动发现**：配置MCP Server连接信息后，Spring AI自动发现Server暴露的工具，注入到`ToolCallbackProvider`中，LLM调用时自动路由。

```yaml
# application.yml
# 注意：配置按【传输方式】分组，没有 connections.<name>.type 这种统一写法
spring:
  ai:
    mcp:
      client:
        streamable-http:              # 2.0 默认传输，生产首选
          connections:
            carbon-db:
              url: http://localhost:8081/mcp
        stdio:                        # 本地命令行工具，Client 拉起子进程
          connections:
            lca-calculator:
              command: java
              args: ["-jar", "lca-mcp-server.jar"]
# 1.x 存量 Server 才需要下面这段（2.0 起 SSE 已废弃，仅作兼容）
#        sse:
#          connections:
#            legacy-server:
#              url: http://localhost:8082/sse
```

**碳管家集成关键点**：(1) 使用Streamable HTTP传输方式连接运行中的微服务Server（SSE仅用于兼容1.x存量Server）；(2) STDIO方式连接本地命令行工具（如Python数据分析脚本）；(3) 工具调用结果缓存复用（相同参数短时间内不重复调用）；(4) 多Server并发调用，聚合结果后交给LLM生成最终回答。

#### 追问：
- 追问1：Spring AI 的 Streamable HTTP 与 STDIO 两种连接并存时，工具自动发现的结果如何统一聚合进同一个 ToolCallbackProvider，生命周期管理有何差异？
  - **答**：启动时 Spring AI 对每种连接分别 `tools/list`，结果合并进统一 `ToolCallbackProvider`。
    - 生命周期差异：STDIO 由 Client 拉起/销毁子进程，随应用启停；Streamable HTTP 是远程连接（2.0 起默认，可走有状态会话也可走无状态部署），需独立管理重连与健康检查，二者超时、重连策略分开配置。
- 追问2：文中提到「工具调用结果缓存复用」，但 Spring AI 的 McpClient 自动发现并不包含缓存逻辑，缓存应加在哪一层才不会破坏工具幂等性假设？
  - **答**：缓存应加在工具实现内部或 Client 调用入口，而非 McpClient 自动发现层。
    - 用 `@Cacheable` 包裹 DAO/远程调用，或在 Client 按 (toolName + 参数) 做只读缓存。
    - 只缓存 GET 类幂等工具，写操作不缓存，避免破坏工具幂等性假设。

### 4. 如何实现自定义MCP Server
**重要度**：★★★★★

**设计思路（口头表述）**：自定义 MCP Server 我用 **MCP 专用的 `@McpTool`/`@McpToolParam` 注解**声明工具，把"查企业碳排放数据"这类业务能力暴露成 MCP 协议的工具，大模型就能跨进程调用。关键设计：
  - ① 工具描述（description）要写清"做什么 + 入参 + 返回"，模型靠它判断何时调
  - ② 传输方式按场景选——Streamable HTTP 连运行中的微服务 Server（跨进程、可独立部署与负载均衡，2.0 默认传输）、STDIO 连本地命令行工具（如 Python 脚本，拉起子进程）；SSE 只在对接 1.x 存量 Server 时保留
  - ③ 工具结果缓存复用（相同参数短时间内不重复调用），但只缓存幂等读操作
  - ④ 多 Server 并发调用聚合结果再交给 LLM 生成最终回答
  - 本质是把"业务能力"标准化成"模型可调用的工具"，解耦模型与业务系统。

```java
@SpringBootApplication
public class CarbonMcpServerApplication {
    public static void main(String[] args) {
        SpringApplication.run(CarbonMcpServerApplication.class, args);
    }
}

@Component
public class CarbonQueryTools {
    
    @McpTool(name = "query_carbon_emission", 
          description = "根据企业ID和时间范围查询碳排放数据")
    public String queryCarbonEmission(
            @McpToolParam(description = "企业ID") String companyId,
            @McpToolParam(description = "开始年份") int startYear,
            @McpToolParam(description = "结束年份") int endYear) {
        // 查数据库
        return emissionData;
    }
    
    @McpTool(name = "calculate_product_carbon_footprint",
          description = "计算产品碳足迹，输入产品信息和工艺参数")
    public String calculateCarbonFootprint(
            @McpToolParam(description = "产品名称") String productName,
            @McpToolParam(description = "生产工艺JSON") String processJson) {
        // LCA计算逻辑
        return footprintResult;
    }
}
```

**工具注册**：使用 MCP 的 `@McpTool` 注解标记方法，Spring AI 自动将其暴露为 MCP Tools；`@McpToolParam` 提供参数描述帮助 LLM 理解。

**资源暴露**：`@McpResource` 注解暴露只读数据资源（如碳排放因子库、碳因子字典）。⚠️ **注意别写成 `@Resource`**——那是 jakarta 的依赖注入注解（管 Bean 注入），和 MCP 的 Resources 完全不是一回事。

**提示模板**：`@McpPrompt` 注解定义可参数化的提示词模板。

**与 ChatModel 侧 `@Tool` 的区别（高频易混）**：Spring AI 里有两个"工具注解"，别搞混——
| | ChatModel 侧 | MCP Server 侧 |
|---|---|---|
| 注解 | `@Tool` / `@ToolParam` | `@McpTool` / `@McpToolParam` |
| 作用 | 把 Java 方法注册成**本进程内**模型的工具（ToolCallback） | 把能力暴露成**跨进程 MCP 协议**的工具，供任意 MCP Client 调用 |
| 位置 | 1.0 起引入，2.0 唯一形态（`FunctionCallback` 已移除） | 1.1 引入，2.0 并入 Spring AI 核心（`org.springframework.ai.mcp.annotation.*`） |


#### 三种框架实现对比

##### Spring AI 1.1 实现

```java
package com.carbon.guard.mcp;

import org.springaicommunity.mcp.annotation.McpTool;
import org.springaicommunity.mcp.annotation.McpToolParam;
import org.springframework.stereotype.Component;

import java.util.List;

/**
 * Spring AI 1.1 的 MCP 注解包名是 org.springaicommunity.mcp.annotation.*
 * （2.0 迁到 org.springframework.ai.mcp.annotation.*）
 * 1.0 时代【没有】@McpTool，只能用 MCP Java SDK 的 McpServer.sync(...).tools(McpServerFeatures...) 函数式注册
 */
@Component
public class CarbonMcpTools {

    /** @McpTool 会把方法暴露成 MCP tool；参数用 @McpToolParam 标注 */
    @McpTool(name = "query_emission_factor",
             description = "按行业与活动名称查询碳排放因子")
    public FactorResult queryEmissionFactor(
            @McpToolParam(description = "行业名称，如 钢铁") String industry,
            @McpToolParam(description = "活动名称，如 高炉炼铁") String activity) {
        return new FactorResult(industry, activity, 1.89, "tCO2e/t", "GB/T 32150.1-2015");
    }

    public record FactorResult(String industry, String activity,
                               double value, String unit, String source) {}
}
```

```java
// Server 启动（MCP Java SDK）：本地进程用 stdio，远程微服务用 Streamable HTTP
package com.carbon.guard.mcp;

import io.modelcontextprotocol.server.McpServer;
import io.modelcontextprotocol.server.McpServerFeatures;
import io.modelcontextprotocol.server.McpSyncServer;
import io.modelcontextprotocol.server.transport.StdioServerTransportProvider;
import io.modelcontextprotocol.spec.McpSchema;
import org.springframework.stereotype.Component;

import java.util.List;

@Component
public class CarbonMcpServerConfig {

    /** 2.0 起 Streamable HTTP 是默认传输；SSE 只用于兼容 1.x 存量 Server */
    public McpSyncServer carbonMcpServer(CarbonMcpTools tools) {
        // Tool / CallToolResult / TextContent 都在 McpSchema 下，
        // McpServerFeatures 只提供 SyncToolSpecification / AsyncToolSpecification
        McpServerFeatures.SyncToolSpecification spec = new McpServerFeatures.SyncToolSpecification(
                McpSchema.Tool.builder()
                        .name("query_emission_factor")
                        .description("按行业与活动名称查询碳排放因子")
                        .inputSchema(schema)                 // 入参 JSON Schema
                        .build(),
                (exchange, args) -> {
                    String result = tools.queryEmissionFactor(
                            (String) args.get("industry"), (String) args.get("activity"));
                    return new McpSchema.CallToolResult(
                            List.of(new McpSchema.TextContent(result)), false);
                });

        return McpServer.sync(new StdioServerTransportProvider())   // 远程部署换成 Streamable HTTP transport
                .serverInfo("carbon-factor-server", "1.0.0")
                .tools(spec)
                .build();
    }
}
```

##### Spring AI 2.0 实现

```java
package com.carbon.guard.mcp;

import org.springframework.ai.mcp.annotation.McpTool;
import org.springframework.ai.mcp.annotation.McpToolParam;
import org.springframework.stereotype.Component;

/**
 * 2.0 变化：
 * 1) MCP 注解包名迁到 org.springframework.ai.mcp.annotation.*（@McpTool/@McpToolParam/
 *    @McpResource/@McpPrompt/@McpComplete）
 * 2) 随附 MCP Java SDK 2.0.0，符合 2025-11-25 MCP 规范
 * 3) Streamable HTTP 成为默认传输，取代已废弃的 SSE
 * 4) @McpTool 抛 checked exception 会被包成 UndeclaredThrowableException 上抛，
 *    要让模型看到错误信息，必须包成 RuntimeException
 */
@Component
public class CarbonMcpTools {

    @McpTool(name = "query_emission_factor",
             description = "按行业与活动名称查询碳排放因子")
    public FactorResult queryEmissionFactor(
            @McpToolParam(description = "行业名称，如 钢铁") String industry,
            @McpToolParam(description = "活动名称，如 高炉炼铁") String activity) {
        try {
            return factorService.lookup(industry, activity);
        } catch (IllegalArgumentException e) {
            // checked exception 会被包成 UndeclaredThrowableException，模型读不懂，
            // 所以统一转 RuntimeException 并把可读信息放进 message
            throw new RuntimeException("未找到该行业/活动的排放因子: " + industry + "/" + activity, e);
        }
    }

    public record FactorResult(String industry, String activity,
                               double value, String unit, String source) {}
}
```

##### LangChain4j 实现

```java
package com.carbon.guard.mcp;

import dev.langchain4j.service.AiServices;
import org.springframework.stereotype.Service;

/**
 * LangChain4j 的定位不同：它主要是 MCP 的【客户端】，
 * 通过 langchain4j-mcp 模块把远端 MCP 工具转成 ToolSpecification 喂给 AiServices。
 * 自己写 MCP Server 则用 MCP Java SDK 原生实现（与 Spring AI 无关）
 */
@Service
public class CarbonMcpClient {

    private final CarbonAssistant assistant;

    public CarbonMcpClient(ChatLanguageModel model, McpToolProvider provider) {
        this.assistant = AiServices.builder(CarbonAssistant.class)
                .chatModel(model)
                .tools(provider.tools())     // 远端 MCP 工具转成的本地工具
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
- 追问1：用 @McpTool 暴露的 queryCarbonEmission 返回的是字符串，复杂对象序列化失败时 LLM 拿到的错误信息该如何设计才利于二次修正？
  - **答**：返回结构化错误而非原始异常堆栈。
    - 捕获序列化/转换异常，返回含「错误类型 + 缺失字段 + 期望格式」的 JSON，如 `{"error":"invalid_param","detail":"processJson 缺少字段 xxx"}`。
    - LLM 据此修正参数后重试，而不是因拿到堆栈而无法处理。
    - 补充（2.0.0 起的行为变化）：MCP Server 会**按声明的 JSON Schema 先校验入参**，校验失败直接返回 `isError=true` 的结果；另外 `@McpTool` 方法抛出的**受检异常**会被包成 `UndeclaredThrowableException` 向上抛出、不会传回模型，所以要让模型看到错误信息，应主动包成 `RuntimeException`。
- 追问2：碳因子数据库通过 @McpResource 暴露，Client 读取资源的权限与 @McpTool 调用的权限是同一套鉴权吗？多租户下如何隔离？
  - **答**：建议统一鉴权——在同一网关/拦截器中对 Tools 与 Resources 都校验 JWT 中的 companyId。
    - 多租户隔离：资源 URI 带租户前缀；Server 内部按 companyId 做行级过滤，防止跨租户读取碳因子数据。
    - 补充：2.0 为 MCP Server 注入了统一的 `McpSyncRequestContext` / `McpAsyncRequestContext`，日志、进度上报、sampling、elicitation 都从这一个入口拿，多租户上下文传递比 1.x 更顺。

### 5. MCP vs Function Calling的区别
**重要度**：★★★★★

| 维度 | MCP | Function Calling |
|------|-----|---------------------------|
| 标准化 | 开放标准，跨模型跨平台 | 各供应商自有 Schema，不统一 |
| 架构 | Client-Server分离 | 内嵌在API调用中 |
| 工具发现 | 动态发现（tools/list） | 每次请求时显式声明tools参数 |
| 生命周期 | 可有会话（≤2025-11-25，`initialize` 握手 + `Mcp-Session-Id`）；2026-07-28 起协议无状态 | 无状态请求-响应 |
| 资源管理 | 支持资源读取 | 无原生资源概念 |
| 复用性 | Server可被多个Client共享 | 绑定在请求中 |
| 认证 | 规范定义基于 OAuth 2.1 的授权模型，需 Server 自行实现 | 需自行实现 |

**核心区别**：Function Calling 是 API 调用的一部分，工具定义必须随每次请求下发；MCP 是独立的协议层，把**工具定义的维护与分发**标准化到 Server 侧——Client 通过 `tools/list` 拉取，应用不必为每个模型/框架各写一份 schema。但要注意两点常见误答：① `initialize` 握手只交换能力标志（capabilities），工具定义走的是独立的 `tools/list`；② **即便工具来自 MCP Server，注入 LLM 请求时仍要每次携带 tools schema**，模型靠它才能决定调不调，模型侧 Token 一分没省——省的是集成、治理与版本一致性的工程成本（真要省 Token 得配 prompt caching）。对碳管家场景，MCP 的价值在于碳数据库查询工具、LCA 计算工具、知识库工具由各自团队独立迭代，Client 只维护一份接入逻辑。

**互补关系**：Spring AI可使用MCP管理工具后端，通过Function Calling接口暴露给LLM。两者不是替代关系，而是不同层次的标准。

#### 追问：
- 追问1：MCP 把工具定义集中到 Server 侧维护，但注入模型请求时仍要每次携带 schema——工具定义变更（如新增必填参数）时，旧 Client 缓存的 schema 会引发什么运行时问题？
  - **答**：先纠正前提：省的不是模型 Token。每次 LLM 请求都要带 tools schema，MCP 省的是「多渠道各自维护定义」的工程成本；真正被缓存的是 Client 侧的 `tools/list` 结果。
    - 旧 Client 仍按旧 schema 发起调用，会触发 Server 端参数校验失败（缺必填项），返回错误。
    - 运行时影响可控：LLM 收到错误可修正参数重试；根治靠 Server 向后兼容（新参数可选 + 默认值），以及变更后主动让 Client 重跑 `tools/list`——协议没有变更推送，必须由 Client 轮询或由注册中心事件触发。
- 追问2：通义千问通过 Spring AI 既支持 Function Calling 又支持 MCP，碳管家选型时是否会出现同一工具两套定义（MCP + Function）并存，如何避免冲突？
  - **答**：存在重复定义风险，需明确单一事实来源。
    - 以 MCP Server 的工具定义为准，Function Calling 仅作为暴露给模型的兼容适配层，避免两套独立维护。
    - 统一工具名/描述生成，防止 LLM 同时看到两份同名工具造成路由歧义。

### 6. MCP的传输方式（Stdio/SSE/Streamable HTTP）
**重要度**：★★★★★

**Stdio（标准输入输出）**：通过进程的标准输入/输出通信。适合本地进程（命令行工具、脚本）。Client启动Server子进程，通过stdin发送JSON-RPC请求，stdout接收响应。延迟最低，但只能本地通信。

**SSE（Server-Sent Events）**：基于HTTP的单向流。Server通过SSE推送消息给Client，Client通过HTTP POST发送请求。适合网络通信，但需要两个通道（SSE接收 + POST发送），略显复杂。

**Streamable HTTP**：单一HTTP端点支持双向流，简化部署，适合云环境。**Spring AI 2.0 起它是默认传输，取代了已废弃的 SSE 传输**；其无状态变体可换取远程部署的水平扩展能力，代价是失去双向通信（服务端无法主动推送）。MCP Java SDK 2.0.0 中 `mcp-spring-webmvc` / `mcp-spring-webflux` 已从 `io.modelcontextprotocol.sdk` 迁到 `org.springframework.ai`。

**碳管家选型**：
- 开发/测试阶段：Stdio方式连接本地工具，快速调试
- 微服务间：Streamable HTTP方式连接（碳数据库服务、LCA计算服务）——2.0 默认传输，可独立部署与负载均衡；SSE 只在对接 1.x 存量 Server 时保留
- 生产环境：Streamable HTTP（性能更好，部署更简单）
- 使用JSON-RPC 2.0作为统一消息格式，传输层可插拔切换

#### 追问：
- 追问1：Stdio 方式下 Server 是 Client 的子进程，若 Server 崩溃重启，已建立的会话状态（如分页游标）如何恢复？
  - **答**：Stdio 无持久会话，进程崩溃即状态丢失，恢复靠状态外置。
    - 分页游标/状态存 Redis 或随请求参数回传，使工具调用无状态化。
    - Client 检测子进程退出后重启并重新初始化；会话上下文由 Client 侧对话内存保留，不依赖子进程存活。
- 追问2：碳管家生产环境选 Streamable HTTP，若网关对长连接做了超时断开，双向流中断后工具调用结果会丢失吗，怎样兜底？
  - **答**：中断会导致在途调用失败，结果可能丢失。
    - 兜底：调用加超时 + 重试（仅幂等工具）；结果改异步回调/轮询而非依赖长流。
    - 网关调大 idle 超时或用心跳保活，避免误断长连接。

### 7. MCP在微服务架构中的应用
**重要度**：★★★★

**工具即微服务**：每个MCP Server作为一个独立微服务部署，负责特定领域的能力。AI对话服务（Client）通过MCP协议统一调用。

**服务划分**：
```
AI对话服务 (MCP Client)
├── 碳数据库MCP Server ──── MySQL/TiDB (企业碳排放数据)
├── LCA计算MCP Server ──── 计算引擎 (产品碳足迹/EPD)
├── 知识库MCP Server ──── Milvus + MinIO (法规标准/最佳实践)
├── 报告生成MCP Server ─── 模板引擎 (自动生成报告)
└── 外部APIMCP Server ─── 第三方碳因子库/气候数据
```

**优势**：(1) 解耦：AI服务不直接依赖业务逻辑，通过MCP协议抽象；(2) 独立扩展：热门工具独立扩容；(3) 技术多样性：各Server可用不同语言；（4）渐进迁移：新工具用MCP接入，旧工具逐步改造。

**服务注册与发现**：MCP Server 作为普通服务实例注册到 Consul/Nacos（只登记地址、端口与元数据），Client 从注册中心拿到实例列表后连上去 `tools/list` 拉工具。这里有两个常见误答要纠正：① 注册中心不保存工具列表，工具清单只能通过 `tools/list` 从 Server 现取；② MCP 协议**没有能力变更推送机制**，Server 宕机时 Client 不会「自动感知并移除工具」——只能靠调用失败或心跳超时发现，再由注册中心健康状态触发重跑 `tools/list`（或直接把该实例摘出路由）。**这正是必须做健康检查 + 熔断的原因**，不能指望协议替你兜底。

#### 追问：
- 追问1：知识库 MCP Server 背后是 Milvus + MinIO，当它和碳数据库 Server 同时被调用时，跨 Server 的事务与一致性如何保证？
  - **答**：MCP 不提供跨 Server 分布式事务；碳管家场景多为读组合，无需强一致。
    - 各 Server 独立返回，Client 聚合结果即可。
    - 若确需强一致，在业务层走 Saga / 本地事务表做补偿，而非依赖协议层。
- 追问2：服务注册发现用 Nacos，Server 宕机时 Client 从工具列表移除存在感知延迟，这段时间内发起的工具调用会怎样失败，能否优雅降级？
  - **答**：该窗口内的调用会抛连接异常。
    - 优雅降级：调用失败走熔断 + 返回缓存/兜底答案，并标注「部分数据暂不可用」。
    - 缩短 Nacos 心跳/监听延迟，加快工具列表更新，缩小故障窗口。
- 追问3：各 Server 技术栈不同（Java/Python），工具描述的语义标准由谁约束，如何防止不同语言实现的工具参数 schema 不一致？
  - **答**：由统一的工具契约约束，而非各语言自定。
    - 集中维护工具 schema（OpenAPI / JSON Schema 规范），各语言实现按同一份契约生成 `@Tool` 定义。
    - CI 中校验 schema 一致性，防止参数名/类型漂移。

### 8. MCP的安全性（认证、授权、沙箱）
**重要度**：★★★★

**传输层安全**：HTTP 系传输应由部署方强制 TLS，并按 MCP 授权模型走 OAuth 2.1（规范只定义授权模型，实现与否在 Server）。**stdio 不是「天然安全」**——它只是不走网络、不需要 TLS，但它继承 Client 的完整进程权限、没有身份认证与网络边界，风险落在进程信任与供应链上；因此 stdio Server 仍要防命令注入与路径穿越，并对可执行文件做来源校验与版本锁定。

**认证机制**：
- **Bearer Token**：Client在请求头携带JWT Token
- **OAuth 2.0**：适合多租户场景
- **mTLS**：服务间使用双向证书认证

**授权**：MCP Server按用户/租户维度控制工具访问权限。碳数据库中，企业A的用户只能查询企业A的排放数据。

**沙箱隔离**：
- 工具执行的副作用隔离（读写限制特定目录/数据库）
- 资源访问白名单
- 工具调用频率限制（防止滥用）
- 输入验证与净化（防止Prompt注入通过工具参数攻击底层系统）

**审计日志**：所有MCP工具调用记录完整审计日志：谁在什么时候调用了什么工具，参数和结果，用于合规审查和安全追溯。

#### 追问：
- 追问1：碳数据按企业隔离，JWT 中的 companyId 在 MCP 调用链中如何透传，Server 之间转发调用时会不会丢失租户上下文？
  - **答**：透传靠在每个调用环节显式携带租户标识。
    - Client 在每个 `tools/call` 的元数据（或下游 HTTP Header）中注入 companyId。
    - 若 Server 间有 Sampling / 转发调用，也需显式传递租户上下文，不依赖线程本地隐式传递；每个 Server 入口校验 companyId 与数据归属一致。
- 追问2：文中提到「输入验证防止 Prompt 注入通过工具参数攻击底层系统」，工具参数在 JSON-RPC 里本质是结构化数据，注入风险具体发生在哪一步？
  - **答**：风险不在 JSON-RPC 传输本身，而在参数被拼接进下游命令/SQL/脚本时。
    - 若工具把参数拼 SQL、或传给 STDIO 子进程的 shell/脚本，恶意 payload 会触发注入。
    - 防护在工具实现层做参数白名单/转义/预编译，结构化只保证传输，不保证语义安全。

### 9. Tool Calling实现原理（从Prompt到工具调用到结果解析）
**重要度**：★★★★

**完整流程**：
1. **用户提问**："查询我公司2023年的碳排放总量"
2. **System Prompt注入工具定义**：LLM收到的Prompt中包含工具列表（名称、描述、参数schema）
3. **LLM决策**：模型分析问题，决定调用`query_carbon_emission(companyId="123", startYear=2023, endYear=2023)`
4. **返回Tool Call**：LLM不返回文本，返回function_call对象（JSON格式，含工具名和参数）
5. **框架执行工具**：Spring AI解析function_call，路由到对应工具实现，执行获取结果
6. **结果注入上下文**：工具返回的碳排放数据注入到对话上下文
7. **二次推理**：LLM收到工具结果后，基于数据生成自然语言回答："您公司2023年碳排放总量为128.5万吨CO2e..."
8. **流式输出**：最终回答通过SSE逐token推送给用户

**Spring AI的实现**：
```java
@PostMapping("/chat")
public Flux<ServerSentEvent<String>> chat(@RequestBody ChatRequest request) {
    return chatClient.prompt()
        .user(request.getQuery())
        .tools(carbonQueryTools, lcaTools)  // 注册工具
        .stream()
        .chatResponse()
        .map(resp -> ServerSentEvent.builder(resp).build());
}
```


#### 三种框架实现对比

##### Spring AI 1.0 实现

```java
package com.carbon.guard.tool.principle;

import org.springframework.ai.chat.model.ChatResponse;
import org.springframework.ai.chat.messages.ToolCall;
import org.springframework.ai.tool.ToolCallback;
import org.springframework.stereotype.Component;

import java.util.List;

/**
 * Tool Calling 完整链路（Spring AI 1.0）：
 *
 * [1] 工具注册：@Tool 注解方法 / FunctionToolCallback -> ToolCallback
 *     ToolCallback.getToolDefinition() 给出 name/description/inputSchema(JSON Schema)
 * [2] 随请求下发：框架把工具定义放进 chat completions 的 tools 字段
 * [3] 模型决策：模型返回 tool_calls[{id,name,arguments}]，此时还没有真正执行
 * [4] 参数解析：框架把 arguments(JSON 字符串) 反序列化成方法参数
 * [5] 本地执行：框架按 name 找到 ToolCallback.call(arguments) 执行
 * [6] 结果回灌：执行结果作为 tool 消息，与原 assistant 消息一起追加进 messages
 * [7] 再次请求：模型基于 tool 结果生成自然语言答案
 * [8] 循环终止：模型不再返回 tool_calls
 */
@Component
public class ToolCallingPrinciple {

    /** 展示第 4-6 步的原始实现（框架内部就是这个逻辑） */
    public void executeToolCall(ChatResponse response, List<ToolCallback> tools) {
        for (ToolCall toolCall : response.getResult().getOutput().getToolCalls()) {
            ToolCallback matched = tools.stream()
                    .filter(t -> t.getToolDefinition().name().equals(toolCall.name()))
                    .findFirst()
                    .orElseThrow(() -> new IllegalStateException("未知工具: " + toolCall.name()));

            // arguments 是 JSON 字符串，需要反序列化后再执行
            String observation = matched.call(toolCall.arguments());
            // observation 会被回灌成 tool 消息，再次请求模型
            System.out.println("[tool] " + toolCall.name() + " -> " + observation);
        }
    }
}
```

##### Spring AI 2.0 实现

```java
package com.carbon.guard.tool.principle;

import org.springframework.ai.chat.client.ChatClient;
import org.springframework.ai.chat.messages.Message;
import org.springframework.ai.chat.messages.ToolCall;
import org.springframework.ai.chat.messages.ToolResponseMessage;
import org.springframework.ai.chat.messages.UserMessage;
import org.springframework.ai.chat.model.ChatModel;
import org.springframework.ai.chat.model.ChatResponse;
import org.springframework.ai.chat.prompt.ChatOptions;
import org.springframework.ai.chat.prompt.Prompt;
import org.springframework.ai.tool.ToolCallback;
import org.springframework.stereotype.Component;

import java.util.ArrayList;
import java.util.List;

/**
 * 2.0 变化（重要）：
 * 1) ToolCallingAdvisor 由 ChatClient 【自动注册】，
 *    它在一次 adviseCall 里就把"下发工具→模型决策→执行→回灌→再请求"整圈跑完，
 *    最终只返回最终答案给用户
 * 2) ChatModel.call() 行为改变：只返回模型的原始响应，【不再自动执行工具】，
 *    所以自己写 ReAct 循环时必须手动执行工具再回灌
 * 3) 工具必须显式注册 ToolCallback Bean（toolNames() 已移除）
 */
@Component
public class ToolCallingPrinciple {

    private final ChatModel chatModel;

    public ToolCallingPrinciple(ChatModel chatModel) {   // chatModel 由构造器注入
        this.chatModel = chatModel;
    }

    /** 走 ChatClient：工具往返由 ToolCallingAdvisor 自动完成 */
    public String askWithTool(String question, List<ToolCallback> tools) {
        ChatClient chatClient = ChatClient.builder(chatModel).build();
        String answer = chatClient
                .prompt()
                .user(question)
                .tools(tools.toArray(new ToolCallback[0]))
                .call()
                .content();   // 已是最终答案（工具已执行并回灌）
        return answer;
    }

    /** 自己控制循环（ReAct）：ChatModel.call() 不执行工具，必须手动做
     *  关键：工具定义必须随每次请求下发（ChatOptions.tools），否则模型不可能返回 tool_calls，
     *  整个循环第一轮就走「无 tool_call → 直接返回文本」的分支，示例等于空转 */
    public String askManualLoop(String question, List<ToolCallback> tools) {
        List<Message> messages = new ArrayList<>();
        messages.add(new UserMessage(question));

        for (int i = 0; i < 5; i++) {
            // 1) 下发工具：工具 schema 走 ChatOptions.tools，和 messages 一起发给模型
            ChatOptions options = ChatOptions.builder()
                    .toolCallbacks(tools.toArray(new ToolCallback[0]))
                    .build();
            ChatResponse response = chatModel.call(new Prompt(messages, options));

            List<ToolCall> calls = response.getResult().getOutput().getToolCalls();
            if (calls.isEmpty()) {
                return response.getResult().getOutput().getText();
            }

            // 2) 回灌：assistant 消息（带 tool_calls）+ 每个工具结果各一条 ToolResponseMessage
            messages.add(response.getResult().getOutput());
            List<ToolResponseMessage.ToolResponse> toolResponses = new ArrayList<>();
            for (ToolCall call : calls) {
                String observation = tools.stream()
                        .filter(t -> t.getToolDefinition().name().equals(call.name()))
                        .findFirst().orElseThrow()
                        .call(call.arguments());
                toolResponses.add(new ToolResponseMessage.ToolResponse(call.id(), call.name(), observation));
            }
            messages.add(new ToolResponseMessage(toolResponses));
        }
        return "超出最大步数";
    }
}
```

##### LangChain4j 实现

```java
package com.carbon.guard.tool.principle;

import dev.langchain4j.agent.tool.Tool;
import dev.langchain4j.model.chat.ChatLanguageModel;
import dev.langchain4j.service.AiServices;
import org.springframework.stereotype.Component;

/**
 * LangChain4j 1.x 的 Tool Calling 链路：
 * [1] @Tool + @P 注解 -> 启动时生成 ToolSpecification（name/description/参数 schema）
 * [2] AiServices 把 ToolSpecification 随请求发给模型
 * [3] 模型返回工具名+参数 -> 框架按名字反射调用
 * [4] 结果回灌 -> 模型生成最终答案
 * 整个循环由 AiServices 内部完成，业务侧看不到中间步骤
 */
@Component
public class ToolCallingPrinciple {

    private final CarbonAssistant assistant;

    public ToolCallingPrinciple(ChatLanguageModel model) {
        this.assistant = AiServices.builder(CarbonAssistant.class)
                .chatModel(model)
                .tools(new FactorTools())
                .build();
    }

    public String ask(String question) {
        return assistant.chat(question);
    }

    static class FactorTools {
        @Tool("按行业与活动名称查询碳排放因子")
        String lookup(@P("行业") String industry, @P("活动") String activity) {
            return industry + "-" + activity + ": 1.89 tCO2e/t";
        }
    }

    interface CarbonAssistant {
        @dev.langchain4j.service.UserMessage("{{it}}")
        String chat(String message);
    }
}
```

#### 追问：
- 追问1：LLM 返回 function_call 后若参数类型与 schema 不符（如年份给了字符串），框架在哪一层校验，失败是否会让整轮对话丢失上下文？
  - **答**：校验在框架解析 `function_call` 阶段（Spring AI 按 `@ToolParam` 类型反序列化）。
    - 类型不符抛转换异常，但不直接丢上下文：捕获后把错误注入对话，LLM 修正参数重试。
    - 更鲁棒的做法是把年份在 schema 声明为 string，由工具内部转换，降低强类型摩擦。
- 追问2：碳排放数据注入上下文后做二次推理，如果数据量很大超出上下文窗口，碳管家如何裁剪注入内容而不影响答案准确性？
  - **答**：裁剪靠聚合与按需取用，而非全量塞入。
    - 先聚合/降采样，只注入汇总值、趋势，而非逐条明细。
    - 超长时截断并标注「已省略 N 条明细」；大数据走 RAG 检索相关片段或落缓存按需取，避免窗口溢出。

### 10. 多工具并发调用与编排
**重要度**：★★★★

**并发调用**：当LLM需要调用多个独立的工具时，并行执行提升效率。用户问"比较A产品和B产品的碳足迹及推荐减排方案"，可并发调用产品A碳足迹计算、产品B碳足迹计算、减排方案知识库检索三个工具。

**顺序依赖编排**：工具间有依赖关系时需顺序执行。如先"查询企业产品列表"，再遍历"计算每个产品碳足迹"。

**Spring AI的工具编排**：
```java
// 并发调用示例
List<CompletableFuture<String>> futures = toolCalls.stream()
    .map(call -> CompletableFuture.supplyAsync(() -> executeTool(call)))
    .toList();

// 等待所有结果
List<String> results = futures.stream()
    .map(CompletableFuture::join)
    .toList();
```

**DAG工作流**：复杂任务如"生成碳排放报告"包含多个步骤：数据查询 → 数据计算 → 图表生成 → 报告撰写。使用有向无环图(DAG)定义工具执行顺序和并发度。碳管家使用Spring AI + 自定义编排引擎实现。

#### 追问：
- 追问1：并发调用多个工具时用 CompletableFuture，若其中一个工具调用失败，已完成的工具结果是否还用于回答，还是整体重试？
  - **答**：通常部分成功结果仍可用于回答，不整体重试。
    - 失败工具结果标记缺失，已完成结果注入上下文，LLM 基于可用数据回答并说明缺失项。
    - 仅当失败的是强依赖项时才整体重试/降级，避免浪费已得结果。
- 追问2：DAG 工作流中「数据查询→计算→图表→撰写」若图表生成依赖计算与查询两个前置结果，某个前置超时如何在不重跑已完成节点的前提下重试？
  - **答**：DAG 按节点缓存中间结果，支持断点续跑。
    - 已完成节点产物存临时存储（Redis / 对象存储），前置超时只重跑失败的前置节点，下游复用已缓存产物。
    - 重试用幂等节点 + 检查点，避免从头执行整条链路。
- 追问3：碳管家用自定义编排引擎而非 Spring AI 内置，自定义引擎在失败回滚、断点续跑上与 LangChain4j 的链相比有什么取舍？
  - **答**：取舍在控制力 vs 复用成本。
    - 自定义引擎可精细控制检查点、状态持久化、断点续跑，契合长报告生成业务。
    - LangChain4j 链开箱即用，但长流程状态持久化较弱；碳管家选自定义以掌握回滚/续跑语义，代价是自行维护。

### 11. 工具调用结果的缓存策略
**重要度**：★★★

**缓存层次**：
1. **参数级精确缓存**：相同参数返回相同结果。Caffeine本地缓存（TTL 5分钟）
2. **语义缓存**：相似问题命中缓存。使用向量相似度判断
3. **分层缓存**：本地缓存（ms级）→ Redis（分布式，ms级）→ 数据库

**碳管家缓存实践**：
```java
@Cacheable(value = "carbon_query", 
           key = "#companyId + '_' + #startYear + '_' + #endYear",
           unless = "#result == null")
public String queryCarbonEmission(String companyId, int startYear, int endYear) {
    // 数据库查询
}
```

**缓存失效策略**：
- TTL自动过期（碳排放数据按天更新，缓存1天）
- 数据变更时主动失效
- 用户反馈"答案不对"时清除相关缓存

**缓存一致性**：Carbon数据的变更（人工录入新数据、IoT设备上报）触发缓存更新。使用Canal监听MySQL binlog，变更后刷新Redis缓存。

#### 追问：
- 追问1：语义缓存用向量相似度判断命中，碳排放数据查询的「相似问题」边界如何界定，避免命中错误的数据造成合规问题？
  - **答**：边界靠「强维度精确 + 弱问法模糊」的约束。
    - companyId / 年份 / scope 等必须精确匹配才命中，只模糊匹配问法措辞。
    - 命中返回前再校验租户与参数一致性，防止「相似问法」跨企业误命中；合规上宁可不命中也不错答。
- 追问2：用 Canal 监听 binlog 刷新 Redis，若 Canal 自身延迟或断流，缓存与数据库会出现多大时间窗口的不一致，如何向用户标注？
  - **答**：不一致窗口约等于 Canal 同步延迟（通常秒级，断流时可能分钟级）。
    - 向用户标注数据「更新时间 / 口径日期」，提示数据可能非实时。
    - 强一致场景（如合规报送）绕过缓存直查库，保证关键数据准确。
- 追问3：Caffeine 本地缓存 TTL 5 分钟，多实例部署下各节点缓存不一致，碳管家是否依赖分布式缓存作为唯一真相源？
  - **答**：不能把缓存当唯一真相源——**唯一真相源是 MySQL/TiDB**，Redis 是分布式缓存层（带 TTL 与降级），Caffeine 只是进程内一级缓存。
    - 写路径：事务 commit 后由 Canal 订阅 binlog 触发，失效 Redis 对应 key（Cache-Aside 失效，不是「先清 Redis 再同步」——binlog 由 DB 产生，不由 Redis 触发），同时广播各节点清本地 Caffeine。
    - Redis 挂了要有降级：本地缓存 + 只读请求兜底直查 DB，配合单飞（single-flight）防击穿，不能把可用性押在 Redis 上。
    - 本地不一致窗口受 TTL 限制，非关键数据可接受；关键路径（合规报送）绕过缓存直查 DB。

### 12. 工具调用的错误处理与重试
**重要度**：★★★★

**错误分类与处理**：

| 错误类型 | 处理策略 | 示例 |
|----------|----------|------|
| 参数错误 | 返回描述性错误，LLM自动修正 | 年份超出数据范围 |
| 超时 | 有限重试（1-2次）+ 降级 | 数据库查询超10秒 |
| 服务不可用 | 熔断 + 降级回答 | 碳排放计算服务宕机 |
| 部分结果 | 返回已有数据 + 标注缺失 | 部分年份无数据 |

**重试策略**：
```java
@Retryable(value = {TimeoutException.class}, 
          maxAttempts = 3, 
          backoff = @Backoff(delay = 1000, multiplier = 2))
public String callCarbonService(QueryRequest request) {
    // 可能超时的远程调用
}
```

**降级策略**：核心工具不可用时，返回缓存结果或"该功能暂时不可用，请稍后重试"的提示。

**LLM层面的容错**：工具返回错误后，将错误信息注入上下文，LLM可以根据错误调整回答（如告知用户目前能查询的范围）。

#### 追问：
- 追问1：重试策略用了指数退避，工具调用本身是写操作（如录入排放数据）时重试是否会带来重复副作用，如何保证幂等？
  - **答**：写操作重试需幂等保护，否则会重复录入。
    - 调用带唯一请求 ID / 幂等键，Server 侧去重。
    - 仅对读 / 可重试写做自动重试；录入类写操作默认不自动重试，改由业务确认或走幂等表。
- 追问2：熔断降级返回「功能暂时不可用」，但若降级本身也依赖缓存且缓存失效，最终用户体验如何兜底，是否告知数据时效？
  - **答**：多级兜底，保证体验不崩。
    - 缓存失效再退「静态缺省 / 历史快照」，并明确告知「当前为 X 前数据，功能恢复后可刷新」。
    - 不返回错误堆栈，给可理解提示，关键处标注数据时效。

### 13. 动态工具注册与发现
**重要度**：★★★★

**静态注册**：启动时配置好的工具列表，运行期间不变。简单但不够灵活。

**动态注册**：
- 新MCP Server上线 → 自动发现并注册工具
- Server下线 → 自动移除工具
- 运行时更新工具定义（如新增参数）

**实现方案**：
```java
@Component
public class DynamicToolRegistry {
    
    private final Map<String, ToolCallback> tools = new ConcurrentHashMap<>();
    
    // 监听服务注册中心变更
    @EventListener
    public void onServerOnline(McpServerOnlineEvent event) {
        List<ToolSpec> specs = event.getServer().listTools();
        specs.forEach(spec -> tools.put(spec.getName(), createCallback(spec)));
    }
    
    @EventListener  
    public void onServerOffline(McpServerOfflineEvent event) {
        event.getToolNames().forEach(tools::remove);
    }
}
```

**碳管家场景**：企业A的碳数据库MCP Server注册时携带企业A的数据范围，企业B使用不同Server。多租户场景下按租户动态路由工具调用，确保数据隔离。

#### 追问：
- 追问1：多租户下企业 A、B 用不同 Server 且工具同名，DynamicToolRegistry 如何在不混淆的前提下按请求租户路由到正确的回调？
  - **答**：registry 的 key 带租户维度，避免同名混淆。
    - 以 `tenantId::toolName` 为键存储回调。
    - 路由时按当前请求 companyId 取对应租户回调，同名工具因 key 不同而隔离，不串租户。
- 追问2：Server 运行时更新工具定义（如新增参数），已持有旧 schema 的 Client 调用新参数会怎样，是否支持向后兼容的版本协商？
  - **答**：旧 Client 按旧 schema 调用，若新参数为必填则失败。
    - 向后兼容靠新参数设默认值 / 可选。
    - 协议层可带 schema 版本号，Client 声明支持版本，Server 按版本返回兼容定义，必要时触发重协商。
- 追问3：动态上下线若频繁发生（如滚动发布），工具列表抖动会不会导致 LLM 路由错误，如何做平滑过渡？
  - **答**：会短期影响路由，需平滑处理。
    - 下线前优雅摘流：先停止接收新调用，再移除工具。
    - Client 保留旧列表短暂宽限期，配合版本灰度，避免工具列表瞬时抖动导致 LLM 调用失败。

### 14. MCP与LangChain4j的集成
**重要度**：★★★★

**LangChain4j**也支持MCP集成，作为工具后端的标准协议。

**集成方式**：

**设计思路（口头表述）**：MCP 与 LangChain4j 集成是把 MCP Server 暴露的工具，通过 `McpToolProvider` 桥接成 LangChain4j 的 ToolProvider，让 AiServices 能调用。关键设计：
  - ① McpClient 连 MCP Server（本地用 stdio、远程用 Streamable HTTP 传输），`listTools()` 拿工具 schema
  - ② McpToolProvider 把 MCP 工具适配成 LangChain4j 的 ToolSpecification，注入 AiServices
  - ③ 和 Spring AI 集成对比——LangChain4j 偏工具链式编排、Spring AI 偏 Spring 生态，碳管家两者并存：Spring AI 管对话、LangChain4j 管 RAG，共享 MCP 工具层避免重复建连
  - 一句话："MCP 出工具、McpToolProvider 桥接、AiServices 调用，跨框架共享工具层"。

```java
// LangChain4j + MCP 集成（langchain4j-mcp 1.x）
// 1) 建传输：本地 Server 用 stdio；远程 Server 用 StreamableHttpMcpTransport.Builder().url(...)
McpTransport transport = new StdioMcpTransport.Builder()
        .command(List.of("npx", "-y", "@modelcontextprotocol/server-filesystem"))
        .build();

// 2) 建客户端（DefaultMcpClient 是 McpClient 的唯一通用实现）
McpClient mcpClient = new DefaultMcpClient.Builder()
        .transport(transport)
        .build();

// 3) 包装成 ToolProvider（只能用 builder，没有单参构造）
ToolProvider toolProvider = McpToolProvider.builder()
        .mcpClients(List.of(mcpClient))
        .build();

ChatLanguageModel model = OpenAiChatModel.builder()
    .apiKey(System.getenv("OPENAI_API_KEY"))
    .build();

// 4) 传给【自己定义的业务接口】，不能传 AiServices.class 本身
CarbonAssistant assistant = AiServices.builder(CarbonAssistant.class)
    .chatModel(model)
    .toolProvider(toolProvider)
    .build();

// 业务接口由你声明，AiServices 负责生成动态代理
interface CarbonAssistant {
    String chat(String question);
}
```

**对比Spring AI的MCP集成**：LangChain4j更偏重工具链式编排，Spring AI更偏重Spring生态集成。碳管家使用Spring AI是自然的——Spring Boot为基础，Spring AI做AI对话层，LangChain4j处理复杂的RAG链路（文档切分、向量检索、重排序）。


#### 三种框架实现对比

##### Spring AI 1.0 实现

```java
package com.carbon.guard.mcp;

import org.springframework.ai.chat.client.ChatClient;
import org.springframework.ai.tool.ToolCallbackProvider;
import org.springframework.stereotype.Component;

/**
 * Spring AI 1.x 的正确用法：交给 spring-ai-starter-mcp-client 自动装配。
 * starter 按 application.yml 的 spring.ai.mcp.client.* 建好 McpSyncClient，
 * 并暴露 ToolCallbackProvider（内部是 SyncMcpToolCallbackProvider）；
 * 直接注入挂到 ChatClient 上即可，不需要自己 new transport，
 * 也不需要手写"MCP 工具 → ToolCallback"的适配器。
 */
@Component
public class CarbonMcpIntegration {

    private final ChatClient chatClient;

    public CarbonMcpIntegration(ChatClient.Builder builder, ToolCallbackProvider mcpToolProvider) {
        this.chatClient = builder
                .defaultToolCallbacks(mcpToolProvider.getToolCallbacks())   // starter 汇总所有已连接 MCP Server 的工具
                .build();
    }

    public String chat(String question) {
        return chatClient.prompt().user(question).call().content();
    }
}

// 确实需要手写客户端时，用的是 MCP Java SDK 的 API（不是 Spring AI 的类）：
// McpClient mcpClient = McpClient.sync(
//         new HttpClientSseClientTransport("http://localhost:8081/sse")).build();
// ⚠️ 既有 API 里没有 org.springframework.ai.mcp.SseMcpTransport，
//    也没有 McpSyncClient.builder()，别照旧博客抄
```

##### Spring AI 2.0 实现

```java
package com.carbon.guard.mcp;

import org.springframework.ai.chat.client.ChatClient;
import org.springframework.ai.tool.ToolCallbackProvider;
import org.springframework.stereotype.Component;

/**
 * 2.0 变化：
 * 1) 默认传输从 SSE 换成 Streamable HTTP（SSE 已废弃），改 yml 即可，代码不变
 * 2) MCP 成为一等公民，starter 仍负责装配 McpSyncClient 与 ToolCallbackProvider
 * 3) 不要写 McpSyncClient.builder()——MCP 客户端构造是 MCP Java SDK 的 McpClient.sync(...)
 */
@Component
public class CarbonMcpIntegration {

    private final ChatClient chatClient;

    public CarbonMcpIntegration(ChatClient.Builder builder, ToolCallbackProvider mcpToolProvider) {
        this.chatClient = builder
                .defaultToolCallbacks(mcpToolProvider.getToolCallbacks())
                .build();
    }

    public String chat(String question) {
        return chatClient.prompt().user(question).call().content();
    }
}
```

```yaml
# 1.x：SSE
spring:
  ai:
    mcp:
      client:
        sse:
          connections:
            carbon-server:
              url: http://localhost:8081
# 2.0：Streamable HTTP（默认，SSE 仅作兼容）
#   streamable-http:
#     connections:
#       carbon-server:
#         url: http://localhost:8081
```

##### LangChain4j 实现

```java
package com.carbon.guard.mcp;

import dev.langchain4j.agent.tool.ToolSpecification;
import dev.langchain4j.mcp.McpToolSpecification;
import dev.langchain4j.mcp.client.McpClient;
import dev.langchain4j.model.chat.ChatLanguageModel;
import dev.langchain4j.service.AiServices;
import org.springframework.stereotype.Component;

import java.util.List;

/**
 * LangChain4j 1.x：官方 langchain4j-mcp 模块提供 MCP 客户端，
 * 把远端 MCP 工具转成 ToolSpecification，再喂给 AiServices
 */
@Component
public class CarbonMcpIntegration {

    private final CarbonAssistant assistant;

    public CarbonMcpIntegration(ChatLanguageModel model) {
        McpClient mcpClient = McpClient.builder()
                .transport(dev.langchain4j.mcp.client.transport.StdioMcpTransport.builder()
                        .command("java", "-jar", "carbon-mcp-server.jar")
                        .build())
                .build();

        List<ToolSpecification> tools = mcpClient.listTools().stream()
                .map(McpToolSpecification::toToolSpecification)
                .toList();

        this.assistant = AiServices.builder(CarbonAssistant.class)
                .chatModel(model)
                .tools(tools)          // 远端 MCP 工具 -> 本地工具规格
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
- 追问1：碳管家同时用 Spring AI 做对话层、LangChain4j 做 RAG，两套框架各自持有 MCP Client，工具列表是否会重复加载造成资源浪费？
  - **答**：会重复建连，需合理拆分或共享。
    - 优化：共享同一个 MCP Client / 连接池，或按职责拆分（RAG 工具由 LangChain4j 持有、对话工具由 Spring AI 持有）。
    - 连接数受控，避免每框架各开一套耗尽连接。
- 追问2：LangChain4j 的 McpToolProvider 与 Spring AI 的 ToolCallbackProvider 在工具描述格式上是否一致，跨框架迁移工具要不要重写注解？
  - **答**：映射封装层不同，但工具定义源都在 MCP Server。
    - 二者都基于 MCP 协议 schema，Java 注解/封装不一致，但迁移主要改适配层而非重写工具注解。
    - 统一以 MCP schema 为事实来源，减少重复定义。

### 15. 实战：设计一个碳数据查询MCP Server
**重要度**：★★★★

**需求**：碳管家AI助手需查询企业碳排放数据，支持按企业、年份、排放范围（Scope1/2/3）、排放源类型（燃料燃烧/电力/运输）等维度查询。

**架构设计**：
```
碳数据查询MCP Server
├── Tools
│   ├── query_emission_by_scope    # 按排放范围查询
│   ├── query_emission_trend       # 查询排放趋势
│   ├── compare_company_emission   # 企业排放对比
│   └── get_emission_factors       # 获取排放因子
├── Resources
│   ├── emission_standards         # 排放标准文档
│   └── industry_benchmarks.json   # 行业基准数据
└── Prompts
    └── emission_report_template   # 排放报告提示模板
```

**核心实现**（MCP Server 端必须用 `@McpTool` / `@McpToolParam`——`@Tool`/`@ToolParam` 只注册进程内工具，不会暴露成 MCP 协议工具）：
```java
// 包路径按版本二选一：
//   Spring AI 2.0 → org.springframework.ai.mcp.annotation.{McpTool, McpToolParam}
//   Spring AI 1.1 → org.springaicommunity.mcp.annotation.{McpTool, McpToolParam}
@Component
public class CarbonDataTools {
    
    private final CarbonEmissionRepository repository;
    
    @McpTool(name = "query_emission_by_scope",
          description = "查询企业碳排放数据，支持按排放范围(Scope1/2/3)筛选")
    public EmissionResult queryByScope(
            @McpToolParam(description = "企业ID") String companyId,
            @McpToolParam(description = "排放范围: Scope1/Scope2/Scope3/ALL") 
            String scope,
            @McpToolParam(description = "查询年份") int year) {
        
        EmissionResult result = repository.query(companyId, scope, year);
        return result; // 序列化为JSON返回给LLM
    }
    
    @McpTool(name = "compare_company_emission",
          description = "对比两个或多个企业的排放数据")
    public ComparisonResult compareCompanies(
            @McpToolParam(description = "企业ID列表，逗号分隔") String companyIds,
            @McpToolParam(description = "对比年份") int year) {
        List<String> ids = List.of(companyIds.split(","));
        return repository.compare(ids, year);   // 返回各企业同年排放量对比结果
    }
}
```

**安全设计**：(1) 用户只能查询所属企业的数据（JWT中的companyId校验）；(2) 敏感排放数据脱敏（返回时遮蔽精确值）；(3) 查询频率限制（防止数据爬取）。


#### 三种框架实现对比

##### Spring AI 1.1 实现

```java
package com.carbon.guard.mcp.server;

import org.springaicommunity.mcp.annotation.McpTool;
import org.springaicommunity.mcp.annotation.McpToolParam;
import org.springframework.stereotype.Component;

import java.util.List;

/**
 * 碳数据查询 MCP Server（1.1 注解包名；1.0 时代没有 @McpTool，只能函数式注册）：
 * 暴露三类工具：因子查询、碳足迹计算、报告生成
 */
@Component
public class CarbonDataMcpServer {

    private final FactorService factorService;
    private final FootprintCalculator calculator;

    public CarbonDataMcpServer(FactorService factorService, FootprintCalculator calculator) {
        this.factorService = factorService;
        this.calculator = calculator;
    }

    @McpTool(name = "query_emission_factor",
             description = "按行业、活动名称与年份查询碳排放因子")
    public String queryEmissionFactor(
            @McpToolParam(description = "行业名称") String industry,
            @McpToolParam(description = "活动名称") String activity,
            @McpToolParam(description = "年份，可为空取最新") String year) {
        return factorService.lookup(industry, activity, year);
    }

    @McpTool(name = "calc_footprint",
             description = "根据活动数据与因子计算碳足迹")
    public String calcFootprint(
            @McpToolParam(description = "行业") String industry,
            @McpToolParam(description = "活动数据量") double quantity,
            @McpToolParam(description = "活动名称") String activity) {
        return calculator.compute(industry, activity, quantity);
    }

    @McpTool(name = "list_supported_industries",
             description = "列出因子库已覆盖的行业")
    public List<String> listIndustries() {
        return factorService.industries();
    }
}
```

##### Spring AI 2.0 实现

```java
package com.carbon.guard.mcp.server;

import org.springframework.ai.mcp.annotation.McpTool;
import org.springframework.ai.mcp.annotation.McpToolParam;
import org.springframework.stereotype.Component;

import java.util.List;

/**
 * 碳数据查询 MCP Server（2.0 注解包名 org.springframework.ai.mcp.annotation.*）：
 * 1) 2.0 默认 Streamable HTTP 传输
 * 2) checked exception 必须包成 RuntimeException，否则模型拿到的是
 *    UndeclaredThrowableException，看不出业务原因
 * 3) 可加 @McpResource 暴露因子库文档、@McpPrompt 暴露常用提问模板
 */
@Component
public class CarbonDataMcpServer {

    private final FactorService factorService;
    private final FootprintCalculator calculator;

    public CarbonDataMcpServer(FactorService factorService, FootprintCalculator calculator) {
        this.factorService = factorService;
        this.calculator = calculator;
    }

    @McpTool(name = "query_emission_factor",
             description = "按行业、活动名称与年份查询碳排放因子")
    public String queryEmissionFactor(
            @McpToolParam(description = "行业名称") String industry,
            @McpToolParam(description = "活动名称") String activity,
            @McpToolParam(description = "年份，可为空取最新") String year) {
        try {
            return factorService.lookup(industry, activity, year);
        } catch (IllegalArgumentException e) {
            throw new RuntimeException("因子不存在: " + industry + "/" + activity, e);
        }
    }

    @McpTool(name = "calc_footprint",
             description = "根据活动数据与因子计算碳足迹")
    public String calcFootprint(
            @McpToolParam(description = "行业") String industry,
            @McpToolParam(description = "活动数据量") double quantity,
            @McpToolParam(description = "活动名称") String activity) {
        try {
            return calculator.compute(industry, activity, quantity);
        } catch (Exception e) {
            throw new RuntimeException("碳足迹计算失败: " + e.getMessage(), e);
        }
    }

    @McpTool(name = "list_supported_industries",
             description = "列出因子库已覆盖的行业")
    public List<String> listIndustries() {
        return factorService.industries();
    }
}
```

##### LangChain4j 实现

```java
package com.carbon.guard.mcp.server;

import io.modelcontextprotocol.server.McpServer;
import io.modelcontextprotocol.server.McpServerFeatures;
import io.modelcontextprotocol.server.McpSyncServer;
import io.modelcontextprotocol.server.transport.McpServerTransportProvider;
import io.modelcontextprotocol.spec.McpSchema;
import org.springframework.stereotype.Component;

import java.util.List;

/**
 * 用 MCP Java SDK 原生实现 Server（与 Spring AI 无关，三种框架通用）：
 * 1) 定义 tool + JSON Schema
 * 2) MCP server 可被 Spring AI 客户端、LangChain4j 客户端、Claude Desktop 等任意 MCP 客户端连
 */
@Component
public class CarbonDataMcpServer {

    private final FactorService factorService;

    public CarbonDataMcpServer(FactorService factorService) {
        this.factorService = factorService;
    }

    public McpSyncServer build(McpServerTransportProvider transportProvider) {
        // Tool / CallToolResult / TextContent 都属于 McpSchema，McpServerFeatures 只提供 *ToolSpecification
        McpServerFeatures.SyncToolSpecification spec = new McpServerFeatures.SyncToolSpecification(
                McpSchema.Tool.builder()
                        .name("query_emission_factor")
                        .description("按行业、活动名称与年份查询碳排放因子")
                        .inputSchema("""
                        {"type":"object",
                         "properties":{
                           "industry":{"type":"string","description":"行业名称"},
                           "activity":{"type":"string","description":"活动名称"},
                           "year":{"type":"string","description":"年份，可为空"}},
                         "required":["industry","activity"]}""")
                        .build(),
                (exchange, args) -> {
                    String industry = (String) args.get("industry");
                    String activity = (String) args.get("activity");
                    String year = (String) args.get("year");
                    String result = factorService.lookup(industry, activity, year);
                    return new McpSchema.CallToolResult(
                            List.of(new McpSchema.TextContent(result)), false);
                });

        return McpServer.sync(transportProvider)
                .serverInfo("carbon-data-server", "1.0.0")
                .tools(spec)
                .build();
    }
}
```

#### 追问：
- 追问1：query_emission_by_scope 同时支持 Scope1/2/3/ALL，当查询 ALL 时底层是多次聚合还是单条 SQL，参数组合爆炸时如何限流？
  - **答**：ALL 优先单条分组 SQL（`GROUP BY scope`）一次返回，避免 N 次查询。
    - 限流按 companyId + 维度做令牌桶，限制单位时间查询组合数。
    - 超范围组合直接拒绝并提示合法范围，防止组合爆炸。
- 追问2：安全设计提到敏感数据脱敏，但 LLM 需要数值做趋势分析，脱敏到什么粒度既保护隐私又不破坏分析能力？
  - **答**：按用途分级脱敏。
    - 趋势 / 统计类给精确聚合值即可分析，不暴露个体明细。
    - 明细级精确值仅对有权限角色返回；LLM 默认拿聚合 / 区间值（如区间而非精确），兼顾分析与隐私。
- 追问3：compare_company_emission 传入逗号分隔的 ID 列表，参数校验与越权（比较了无权限的企业）应在 Server 哪一层拦截？
  - **答**：在 Server 工具入口统一拦截，而非 Repository 层才校验。
    - 解析 ID 列表后逐个校验当前 companyId 是否有权访问，越权直接拒绝。
    - 入口做鉴权 + 白名单，防止越权比较其他企业数据。

### 16. MCP的Prompt Templates机制
**重要度**：★★★

**Prompt Templates**是MCP的一个核心原语，允许Server提供可参数化的提示模板。Client获取模板后，填充参数并使用。

**设计目的**：(1) 标准化提示词管理（统一维护，不必硬编码在应用代码中）；(2) 支持领域专家编写提示词供AI调用；(3) 模板参数化，灵活性高。

**碳管家示例**：
```json
{
  "prompts": [
    {
      "name": "carbon_report_analysis",
      "description": "生成企业碳排放分析报告",
      "arguments": [
        {"name": "companyName", "required": true},
        {"name": "reportYear", "required": true},
        {"name": "dataJson", "required": true}
      ],
      "template": "你是一名碳管理专家。请根据以下企业{companyName}在{reportYear}年的碳排放数据{dataJson}，生成专业分析报告..."
    }
  ]
}
```

**与Tool的区别**：Tool是模型调用的函数，Prompt是模型使用的提示词。两者配合使用：Tool获取数据，Prompt定义如何解读数据。

#### 追问：
- 追问1：Prompt Template 由 Server 提供，若多个 Server 提供了同名模板或指令冲突，Client 如何决定使用哪一个，会不会覆盖系统提示？
  - **答**：Client 按命名空间 / 来源 Server 区分同名模板（如 `serverA::report`）。
    - Prompt 模板只作为用户 / 任务提示注入，不覆盖系统提示。
    - 冲突时按场景优先级或显式指定，避免互相覆盖。
- 追问2：碳管家把报告模板放在 MCP Server，模板版本升级后旧对话上下文里引用的是旧模板，如何保证生成报告与模板版本一致？
  - **答**：模板带版本号，生成时记录所用版本并绑定结果。
    - 同一会话内锁定模板版本，不中途切换。
    - 跨会话用最新版，并在报告中标注模板版本，保证可追溯一致。

### 17. MCP的Sampling功能
**重要度**：★★★★

**Sampling**是MCP中Server反向请求Client调用LLM的能力。Server在执行任务时可以请求LLM帮助——这是一个强大的Agent链式调用能力。

⚠️ **版本提醒**：Sampling / Roots / Logging 在 **2026-07-28 版规范里已标记 deprecated**（最早 2027-07 移除），服务端反调 LLM 改走 **MRTR（Multi Round-Trip Requests）**：Server 在处理请求期间返回 `InputRequiredResult`，Client 带上用户答案重试原请求。下面是 Sampling 的经典机制与安全考量，答完记得补这一句版本差异。

**典型场景**：碳报告生成MCP Server在生成报告时，需要LLM对数据进行解读、润色、总结。Server通过Sampling请求Client的LLM能力。

**安全考量**：(1) 用户明确授权后才能启用Sampling；(2) Token消耗归属用户；(3) 防止Server滥用LLM能力。

**碳管家实现**：碳数据查询Server拿到原始排放数据后，通过Sampling让LLM生成易读的数据摘要，再返回给Client。这要求Client启用Sampling能力并管理Token配额。

#### 追问：
- 追问1：Server 通过 Sampling 反向调用 LLM 生成数据摘要，这个二次调用的上下文窗口与主对话共享吗，会不会挤占用户对话的 Token？
  - **答**：通常不共享主对话上下文。
    - Sampling 由 Server 构造独立请求（只带必要数据片段），不把整段用户对话塞入。
    - 仍计 Token 并受配额限制，需控制摘要请求大小，避免挤占用户主对话预算。
- 追问2：Sampling 需用户授权且 Token 归属用户，碳管家多租户计费时如何精确归属每次 Sampling 的 Token 消耗到具体企业？
  - **答**：归属靠请求级打标 + 计费账本。
    - Sampling 请求携带 tenantId / 用户标识，网关统计该次 Token 并写入计费账本。
    - 按企业维度聚合，结合预算 / 配额拦截超额，保证消耗可追溯计费。

### 18. MCP与OpenAI Plugin对比
**重要度**：★★★

| 维度 | MCP | OpenAI Plugin |
|------|-----|---------------|
| 开放性 | 开源标准，任何模型/平台可用 | OpenAI专有（已弃用，被GPTs取代） |
| 架构 | Client-Server | 基于OpenAPI规范的HTTP API |
| 模型绑定 | 模型无关 | 仅绑定厂商特定模型 |
| 工具发现 | 运行时协商 | 清单文件（ai-plugin.json） |
| 生态 | 快速增长，Anthropic/Spring/LangChain | 有限 |
| 部署 | 任意部署 | 需托管在公网 |

**为什么MCP更受青睐**：跨模型、跨平台、轻量级、不绑定特定供应商。碳管家使用国产大模型（如通义千问/Qwen）+ MCP，完全自控。

#### 追问：
- 追问1：OpenAI Plugin 已弃用，但遗留系统若仍依赖其 OpenAPI 清单，碳管家迁移到 MCP 时如何平滑过渡而不重写所有工具？
  - **答**：用适配层过渡，不重写旧逻辑。
    - 写一层 MCP Server 包装原有 OpenAPI 端点（把 OpenAPI 清单映射为 MCP Tools），后端不动。
    - 逐步把后端迁到原生 MCP，前端切换调用，避免一次性重写。
- 追问2：MCP 模型无关的优势在碳管家用通义千问时体现明显，但若未来接入 GPT 类模型，MCP 的哪些抽象会与不同模型的函数调用格式产生摩擦？
  - **答**：摩擦主要在模型适配层。
    - 各家 function_call 参数风格 / 必填约束差异（如 nullable 处理）、流式与多模态支持不一。
    - MCP 抽象了工具协议，但 LLM 适配层仍需针对不同模型微调 schema 与调用约定。

### 19. MCP在Agent框架中的应用
**重要度**：★★★

**Agent需要MCP**：Agent需要多种工具完成复杂任务。MCP提供标准化的工具接入方式，Agent框架可以复用MCP生态中的所有工具。

**多Agent协作**：
- 对话Agent：处理用户对话，分发任务
- 数据分析Agent：调用碳数据MCP Server查询分析
- 报告Agent：调用报告MCP Server生成报告
- 合规Agent：调用法规MCP Server检查合规性

**LangChain4j Agent + MCP**：
```java
// 注意：AiServices.builder(...) 返回的是【业务接口的代理对象】，不能声明成 AiServices<X>；
// McpToolProvider 也只能用 builder 构造，没有单参构造器
ToolProvider mcpProvider = McpToolProvider.builder()
    .mcpClients(List.of(carbonMcpClient))
    .build();

CarbonAssistant assistant = AiServices.builder(CarbonAssistant.class)
    .chatModel(model)
    .toolProvider(mcpProvider)   // MCP 工具
    .chatMemory(MessageWindowChatMemory.withMaxMessages(10))
    .build();
```

**碳管家的Multi-Agent设计**：用户说"帮我生成2023年碳排放报告并检查合规性"→ 协调Agent拆解任务 → 并行分配数据Agent和合规Agent → 汇总结果 → 报告Agent生成最终报告。每个Agent通过MCP Client调用对应的MCP Server。

#### 追问：
- 追问1：多 Agent 协作（对话/数据/报告/合规）各自持有 MCP Client，Agent 间传递的中间结果是否也走 MCP，还是走内存消息，如何避免重复工具调用？
  - **答**：Agent 间走内存 / 消息总线传递中间结果，不走 MCP（MCP 是 Agent→Server）。
    - 共享结果缓存（如 Redis），数据 Agent 取过的数据合规 Agent 直接复用。
    - 协调 Agent 汇总而非各自重复调用，减少工具开销。
- 追问2：协调 Agent 拆解「生成报告并检查合规」后并行分配，若数据 Agent 与合规 Agent 依赖同一份原始数据，重复查询还是共享缓存？
  - **答**：优先共享缓存避免重复查询。
    - 协调 Agent 先取一次原始数据放入共享上下文 / 缓存，两 Agent 各自读取。
    - 仅当数据需不同视图时才分别查询，通常共享同一份以降低延迟与成本。
- 追问3：碳管家 Multi-Agent 中某个 Agent 调用的 MCP Server 超时，协调 Agent 如何感知并决定重试、降级还是换 Agent 接管？
  - **答**：协调 Agent 通过子任务返回状态感知故障。
    - 超时抛异常回传协调层；按策略重试（幂等工具）或降级（返回部分结果 + 标注）。
    - 关键路径可考虑换备用 Agent / Server 接管，保证任务不整体失败。

### 20. MCP服务发现与注册中心集成
**重要度**：★★★

**MCP + 服务注册中心**：MCP Server 作为**普通服务实例**注册到注册中心（Consul/Nacos/Eureka），上报**地址、端口与元数据**——注意注册中心不保存工具列表，工具清单只能在连上 Server 后由 `tools/list` 现取。MCP Client 通过注册中心拿到可用实例地址，再按健康状态挑选。

**健康检查**：Server 定期上报心跳，Client 侧结合心跳与调用结果判断健康。**MCP 协议没有能力变更推送机制**，所以「异常 Server 自动从工具列表移除、恢复后自动添加」不是协议能力，而是工程实现：健康检查过滤实例 → 摘除/重建连接 → 重建后重跑 `tools/list` 刷新工具列表；心跳丢失到摘除之间的窗口靠熔断与降级兜住。

**负载均衡**：多个相同功能的MCP Server实例（如碳数据库查询的多个副本），Client按轮询/最少连接策略智能路由。

**灰度发布**：新版MCP Server注册时带版本标签，按比例路由请求到新版，逐步切量。

---


#### 三种框架实现对比

##### Spring AI 1.0 实现

```java
package com.carbon.guard.mcp.registry;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.cloud.client.discovery.DiscoveryClient;
import org.springframework.stereotype.Component;

import java.util.List;

/**
 * MCP 服务发现（1.x）：
 * MCP 规范本身【没有】服务注册中心机制，业界做法是：
 * 1) 自己把 MCP Server 地址登记到 Nacos/Consul（作为普通服务实例）
 * 2) 客户端从注册中心拿地址列表，按健康状态与负载挑一个连
 * 3) 连接失败要能自动切换到下一个实例（failover）
 */
@Component
public class McpServiceRegistry {

    private final DiscoveryClient discoveryClient;

    public McpServiceRegistry(DiscoveryClient discoveryClient) {
        this.discoveryClient = discoveryClient;
    }

    /** 从注册中心拿所有健康的 MCP server 实例 */
    public List<String> instances(String serviceName) {
        return discoveryClient.getInstances(serviceName).stream()
                .filter(i -> i.getInstanceId() != null)
                .map(i -> "http://" + i.getHost() + ":" + i.getPort() + "/mcp")
                .toList();
    }
}
```

##### Spring AI 2.0 实现

```java
package com.carbon.guard.mcp.registry;

import org.springframework.cloud.client.discovery.DiscoveryClient;
import org.springframework.stereotype.Component;

import java.util.List;

/**
 * 2.0 变化：
 * 1) MCP 客户端配置按传输方式分子树：
 *    spring.ai.mcp.client.streamable-http.connections.*.url
 *    spring.ai.mcp.client.sse.connections.*.url
 *    spring.ai.mcp.client.stdio.connections.*.command
 *    （不存在 spring.ai.mcp.client.connections.<name>.type 这种写法）
 * 2) Streamable HTTP 为默认传输
 * 3) 动态实例列表仍需自己从注册中心取，再动态构建 transport
 */
@Component
public class McpServiceRegistry {

    private final DiscoveryClient discoveryClient;

    public McpServiceRegistry(DiscoveryClient discoveryClient) {
        this.discoveryClient = discoveryClient;
    }

    public List<String> instances(String serviceName) {
        return discoveryClient.getInstances(serviceName).stream()
                .filter(i -> i.getInstanceId() != null)
                .map(i -> "http://" + i.getHost() + ":" + i.getPort() + "/mcp")
                .toList();
    }
}
```

##### LangChain4j 实现

```java
package com.carbon.guard.mcp.registry;

import dev.langchain4j.mcp.client.McpClient;
import org.springframework.cloud.client.discovery.DiscoveryClient;
import org.springframework.stereotype.Component;

import java.util.List;

/**
 * LangChain4j 侧同理：MCP 规范没有注册中心，
 * 自己从 Nacos/Consul 取实例列表，逐个建 MCP 客户端做 failover
 */
@Component
public class McpServiceRegistry {

    private final DiscoveryClient discoveryClient;

    public McpServiceRegistry(DiscoveryClient discoveryClient) {
        this.discoveryClient = discoveryClient;
    }

    public List<String> instances(String serviceName) {
        return discoveryClient.getInstances(serviceName).stream()
                .filter(i -> i.getInstanceId() != null)
                .map(i -> "http://" + i.getHost() + ":" + i.getPort() + "/mcp")
                .toList();
    }

    /** 选一个可用实例建客户端（真实实现里要带健康检查与重试） */
    public McpClient client(String serviceName) {
        for (String url : instances(serviceName)) {
            try {
                return McpClient.builder()
                        .transport(dev.langchain4j.mcp.client.transport.HttpMcpTransport
                                .builder(url).build())
                        .build();
            } catch (Exception ignored) {
                // 换下一个实例
            }
        }
        throw new IllegalStateException("没有可用的 MCP 实例: " + serviceName);
    }
}
```

#### 追问：
- 追问1：灰度发布按版本标签路由，工具定义在新旧版本不一致时，Client 聚合的工具列表是否混用两版，如何按请求维度锁定版本？
  - **答**：会混用两版列表，需按请求锁定版本。
    - 按请求 / 会话 sticky 到同一版本（版本标签 + 一致性哈希）。
    - Client 按版本分别维护工具视图，避免同一调用跨版本混用导致 schema 不匹配。
- 追问2：健康检查心跳丢失到 Client 移除工具存在延迟，这段窗口内发的调用会失败还是被负载均衡重试到其他实例？
  - **答**：取决于 LB 策略。
    - 若 LB 已摘除，则路由到健康实例重试。
    - 若窗口内仍路由到故障实例，则调用失败，由 Client 超时 + 重试（到其他实例）或降级兜底；缩短心跳间隔可减少窗口。
- 追问3：多个碳数据库查询副本做负载均衡，若某副本数据同步落后（主从延迟），用户可能查到旧数据，MCP 层能否感知并路由到最新副本？
  - **答**：MCP 层本身不感知数据新旧，需数据层配合。
    - 读主库 / 半同步复制降低延迟；副本标「只读延迟」由 LB 过滤。
    - MCP Server 可暴露副本延迟指标，Client 优先选延迟低的实例；关键查询直连主库。

### 21. MCP（Model Context Protocol）在 Java AI 架构中解决了什么问题？与 Function Calling 有什么区别？
**重要度**：★★★★

MCP 是 Anthropic 提出的开放协议，旨在让 LLM 以统一、安全、可发现的方式访问外部上下文与工具。

**MCP 解决的核心问题：**

- **工具发现标准化**：过去每个框架/模型有自己定义工具的方式；MCP 让"工具"变成可独立部署、独立描述的服务，LLM 客户端通过 `tools/list`、`tools/call` 等标准接口发现与调用。
- **上下文边界清晰**：把"模型端"和"工具端"解耦，工具可由不同团队用不同语言实现，通过 stdio / Streamable HTTP 暴露。
- **安全与权限**：工具服务端可独立做鉴权、审计、限流，而不是把工具逻辑混在应用进程里。

**MCP 与 Function Calling 的区别：**

| 维度 | Function Calling | MCP |
|---|---|---|
| 本质 | 模型能力：生成调用参数 | 协议：模型与工具之间的通信标准 |
| 绑定性 | 与具体模型/框架强绑定 | 跨模型、跨框架、跨语言 |
| 工具位置 | 通常在应用进程内 | 可独立进程/服务 |
| 生态 | 各厂商 API 差异大 | 统一接口，工具可复用 |

**关系理解**：Function Calling 是"模型发起工具调用的机制"（how to call），MCP 是"工具如何被标准化交付"（how to serve）。二者可共存：模型先通过 Function Calling 发起工具调用，底层由 MCP Client 把调用路由到 MCP Server。

在 Java 中，Spring AI 已提供 MCP starter，可基于 `McpClient` / `McpServer` 快速接入。积木 LCA 云平台可将因子库查询、LCA 计算引擎、报告生成、企业知识库等领域能力分别封装为独立 MCP Server，AI 助手不需要直连数据库，而是通过协议调用这些"领域能力服务"。

#### 追问：
- 追问1：MCP Server 的传输层有哪些选择？在 Java 生产环境中更推荐哪种？
  - **答**：MCP 支持 stdio（本地子进程）、SSE（Server-Sent Events，已废弃，仅兼容 1.x 存量 Server）、Streamable HTTP（2.0 默认）三种传输方式。生产环境首选 **Streamable HTTP**：便于独立部署、负载均衡和跨网络调用，且支持无状态变体；stdio 只适合本地 CLI/IDE 插件场景；SSE 不要在新建服务里用。Java 服务间建议 Streamable HTTP + JSON-RPC，便于与 K8s、网关、可观测性集成。选型时还需考虑认证机制：HTTP 传输天然支持 Bearer Token / OAuth 2.1 等标准授权，而 stdio 依赖进程级信任。
- 追问2：在 LCA/碳管理场景里，可以把哪些能力封装成 MCP Server？
  - **答**：
    - ① 因子库查询 MCP Server（按产品/地区/标准返回排放因子）
    - ② 计算引擎 MCP Server（接收 activity data 返回碳足迹结果）
    - ③ 报告生成 MCP Server（输出 PDF/Excel 报告）
    - ④ 企业知识库 MCP Server（检索 ESG 法规、内部 SOP）
    - ⑤ CBAM 填报 MCP Server（按欧盟模板填充碳足迹数据）
    - 这样 AI 助手不需要直连数据库，而是通过协议调用这些"领域能力服务"，实现工具与业务解耦、可独立迭代。
- 追问3：MCP 和 Agent 的 Tools 是什么关系？未来会取代 Function Calling 吗？
  - **答**：MCP 是"工具的标准化交付协议"，Function Calling 是"模型调用工具的机制"，两者是不同层面的东西。模型先通过 Function Calling 决定调用哪个工具、传什么参数，底层由 MCP Client 把调用路由到对应的 MCP Server 执行。短期内 MCP 不会取代 Function Calling，但会统一工具供给侧的接口形态——未来你不再需要为每个框架单独写 Tool 定义，而是写一个 MCP Server，所有支持 MCP 的客户端都能用。


### 22. MCP 规范演进：从 2025-06-18 到 2026-07-28，协议为什么走向无状态
**重要度**：★★★★

**一句话**：2026-07-28 版是 MCP 发布以来最大的一次改动——**协议从「有会话」变成「无状态」**。这不是小修小补，而是为了让 MCP 真正能跑在网关、K8s、Serverless 这些基础设施上。

**三个版本的关键差异**：

| 维度 | 2025-06-18 | 2025-11-25 | 2026-07-28（当前） |
|---|---|---|---|
| 会话 | `initialize` 握手 + `Mcp-Session-Id` | 同左 | **全部移除，协议无状态** |
| 版本协商 | 握手时协商一次 | 同左 | 每请求在 `_meta` 带 `protocolVersion`，另有 `server/discover` |
| 服务端反向请求 | `sampling/createMessage`、`elicitation/create`、`roots/list` | 同左（新增 URL 模式 elicitation） | **MRTR**：返回 `InputRequiredResult`，客户端带答案重试原请求 |
| Sampling / Roots | 核心能力 | 核心能力 | **deprecated**（最早 2027-07 移除） |
| 列表变更通知 | HTTP GET + `resources/subscribe` | 同左 | `subscriptions/listen` 单一长连按类型订阅 |
| 断线续传 | SSE `Last-Event-ID` 可恢复 | 同左 | **移除**，断流即丢请求，必须重发 |
| 列表缓存 | 无 | 无 | `ttlMs` + `cacheScope` 成为必需字段 |
| 扩展机制 | 无 | 无正式流程 | `extensions` 字段 + 反向 DNS ID + 独立版本 |
| Tasks | 无 | 实验性核心特性 | 移出核心，成为官方扩展（`tasks/get`、`tasks/update`、`tasks/cancel`） |

**为什么必须无状态**（这题的分水岭，答得出说明真读过规范）：

1. **水平扩展**：有会话就必须粘性路由，Pod 一扩缩容会话就断。无状态后任意实例都能接住重试。
2. **网关可治理**：新增 `Mcp-Method` / `Mcp-Name` 请求头后，LB、网关、限流器不用解析 body 就能路由和限流——这正是企业接入 MCP 的前提。
3. **断线恢复的复杂度不划算**：原来的 SSE 续传机制要维护事件缓冲，实现成本高且容易出错；改成「断了就重发」反而更简单可靠。
4. **状态显式化**：需要跨调用保留的状态，改为「服务端签发 handle，作为普通工具参数传给模型」。好处是**状态对模型可见**，可以组合、可以推理，而不是藏在传输层的 session 里。

**MRTR 取代反向请求的机制**（最容易被追问）：

```
Server 收到 tools/call → 需要用户确认
  → 返回 InputRequiredResult {
       resultType: "input_required",
       inputRequests: { confirm: { type: "elicitation", message: "删除3个文件?", schema: {...} } },
       requestState: "eyJzdGVwIjox..."
     }
Client 收集用户答案 → 带 inputResponses + 原样回传的 requestState 重试原请求
  → 任意 Server 实例都能接住（状态都在 payload 里）
```

**对 Java 实现的影响（重要，别答错）**：
- **Spring AI 2.0.0 GA（2026-06-12）随附的 MCP Java SDK 2.0.0，实现的是 2025-11-25 版**，不是最新的 2026-07-28。被问「你们用的哪版规范」时要能说清这个落差。
- 升级到 2026-07-28 需要等 SDK 后续版本；在此之前，自定义 Server 若依赖 session 存状态，要提前改成无状态设计，否则将来迁移会很痛。
- `@McpTool`/`@McpResource`/`@McpPrompt` 注解编程模型是 **1.1 就引入**的（`org.springaicommunity.mcp.annotation`），2.0 只是把它并入核心、包路径迁到 `org.springframework.ai.mcp.annotation` 并稳定下来——别答成「2.0 新增」。规范升级不影响注解层，受影响的是传输与会话层。

#### 追问：
- 追问1：协议去掉 session 后，原来靠 session 维护的分页游标、用户上下文、OAuth 授权态怎么办？
  - **答**：全部改为「显式状态」，分三类处理：
    - 分页游标：由 Server 签发不透明 handle，作为普通工具参数返回给模型，下次调用带回来。
    - 用户/租户上下文：放在每次请求的 `_meta` 或工具参数里显式传递，不依赖线程本地或会话。
    - 授权态：走 OAuth token，每请求携带；需要跨调用的授权决策用 `requestState` 在 MRTR 里回传。
- 追问2：MRTR 相比原来的 elicitation 反向请求，好在哪、代价是什么？
  - **答**：好在可路由、可恢复、可审计，代价是交互回合变多：
    - 好：状态全在 payload 里，任意实例可接重试；不需要长期保持响应流；每次 input_required 都是一次完整的可观测请求。
    - 代价：一次需要用户确认的操作变成「请求 → input_required → 重试」两轮，延迟增加；客户端必须正确回传 `requestState`，实现错了会丢上下文。
    - 约束：服务端只能在处理客户端请求期间发起 elicitation，不能再「凭空」弹窗——这其实是安全收益。
- 追问3：Spring AI 2.0 用的还是 2025-11-25 规范，面试被问「你们跟进最新规范了吗」怎么答才不翻车？
  - **答**：如实说落差，并讲清判断依据，比硬吹更加分：
    - 承认现状：Spring AI 2.0 随附 MCP SDK 2.0.0，对应 2025-11-25；2026-07-28 的无状态化要等 SDK 后续版本。
    - 讲影响面：注解编程模型不受影响，受影响的是传输层与会话管理；我们新写的 Server 已按无状态设计，迁移成本可控。
    - 讲取舍：生产上不追最新规范，追的是「SDK + 规范 + 客户端」三者同时可用；单方面升级会导致 Claude Desktop 等客户端不兼容。

---
