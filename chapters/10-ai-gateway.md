## 第十章：AI网关与多模型治理架构


> 本章聚焦 AI 原生网关与多模型统一治理，覆盖网关选型、核心能力（鉴权/限流/护栏/可观测）、模型无缝切换的工程机制、故障转移与灰度多活，以及架构演进。所有题目结合碳管家 AI 助手（通义千问 Qwen / DeepSeek / 本地 vLLM）的生产实践。

---

### 1. 什么是 AI 网关？它和普通 API 网关（Nginx / Spring Cloud Gateway）的核心区别是什么？
**重要度**：★★★★★

**难度**：★★

**考点**：AI 网关的定位、LLM 流量特殊性、为何不能只靠普通网关

**参考答案**：AI 网关是专为 LLM/多模态推理流量设计的反向代理与治理层，在普通网关的路由/鉴权/限流之上，补齐了 LLM 特有的能力：统一的多 Provider 协议适配（OpenAI/Anthropic/通义/本地 vLLM）、按 token 而非请求数的限流与成本计量、流式（SSE）长连接透传与中途取消、Prompt/响应护栏（注入防护、合规审查）、模型路由与 failover、按模型·租户·Provider 的可观测性。普通网关（Nginx/SCG）只理解 HTTP 请求/响应，不懂 token、不懂流式生成语义、不懂模型降级，直接代理大模型会漏掉上述全部治理点。

**深度解析**：碳管家早期用 Spring Cloud Gateway 直接转发大模型请求，但很快遇到三类问题：
  - ① 429 限流是 RPM/TPM 维度而非 QPS，网关的 QPS 限流拦不住 token 超限
  - ② 流式响应要 30s+，链路上常见的 30~60s 响应超时（运维显式配的 `responseTimeout`、LB/Nginx 的 idle timeout）会把长报告截断——注意 SCG 的 `spring.cloud.gateway.httpclient.response-timeout` **默认并不设置（即不限制）**，真正截断的是显式配置值和上游空闲超时，别把锅甩给默认值
  - ③ 切换模型要改业务代码，无法在网关层做统一路由
  - 于是收敛出独立 AI 网关层：SCG 仍做接入鉴权与粗粒度限流，AI 网关（适配层 + 路由引擎）做模型级治理，两者职责分层。

**易错点**：把"AI 网关"等同于"再套一层 SCG"；忽视 token 维度限流导致 Provider 限流雪崩；用普通网关的短超时配置直接代理 SSE 造成长回答被截断。

#### 追问：
- 追问1：如果预算有限，能否先用 Spring Cloud Gateway + 自定义 Filter 充当 AI 网关，而不是引入 LiteLLM/Kong？
  - **答**：可以，且碳管家初期就是这么做的。SCG 自定义 Filter 链能覆盖鉴权、租户限流、路由、灰度，但 token 计量、模型 failover、护栏要自己写；当 Provider 超过 3 个、需要成本看板与影子评测时，再迁移到专业 AI 网关（保留 SCG 做接入层）。
- 追问2：AI 网关放 SCG 之前还是之后？
  - **答**：两种都行。常见是「客户端 → SCG（鉴权/租户识别/全局限流）→ AI 网关（模型路由/failover/token 计量/护栏）→ Provider」；若用 Kong/APISIX 这类自带 AI 插件的网关，可让 Kong 同时承担接入与 AI 治理，SCG 退化为内部服务网格边车。

### 2. 业界主流 AI 网关方案对比？自研 vs 开源怎么权衡？
**重要度**：★★★★

**难度**：★★★

**考点**：方案选型、LiteLLM / Kong / APISIX / Spring AI / Cloudflare 差异、自研边界

**参考答案**：业界主流方案按"是否能复用现有网关栈、是否要私有化、治理深度"三维度权衡：
- **LiteLLM**：Python，统一 OpenAI 兼容协议代理 100+ 模型，内置负载均衡、fallback、token 计费、虚拟 Key，部署轻、改配置即加模型，适合快速治理多 Provider；弱项是 Java 栈集成要起独立服务、护栏能力靠外接。
- **Kong AI Gateway / APISIX AI Gateway**：基于 OpenResty，原生 AI 插件（路由、限流、语义缓存、护栏、prompt 模板），性能高、与现有 K8s 网关一体；适合已是 Kong/APISIX 技术栈的团队。
- **Spring AI Portable AI Client**：在应用内做统一抽象，不改业务代码切模型；但治理能力（限流/成本/护栏）要自己补，偏"客户端 SDK"而非"独立网关"。
- **Cloudflare AI Gateway**：SaaS，边缘节点做缓存/分析/护栏，零运维但数据出公网、私有化受限。
权衡：已有 K8s 网关栈选 Kong/APISIX；要快速多模型治理且能接受独立 Python 服务选 LiteLLM；强合规私有化、Java 技术栈则 SCG + 自研适配层。

**深度解析**：碳管家选型：接入层用 SCG（团队已熟、鉴权/租户体系现成），模型治理用自研"AI 适配层 + 路由引擎"（因为要深度结合 Nacos 租户配置、Sentinel 熔断、Redis token 计数，开源方案改不动这些内部耦合）。若重做会先上 LiteLLM 做协议归一，再在前面挂 SCG。

**易错点**：只看功能清单不看技术栈耦合（Java 团队硬上 LiteLLM 增加运维面）；把 SaaS 网关用于含敏感碳数据的合规流量；认为"开源=零成本"（Kong 企业版 AI 插件、LiteLLM 团队版都要钱）。

#### 追问：
- 追问1：LiteLLM 的虚拟 Key 机制怎么解决"不向业务暴露真实 Key"？
  - **答**：业务只持 LiteLLM 发的虚拟 Key，真实 Provider Key 存在网关服务端；网关按虚拟 Key 映射租户/配额，并轮询多个真实 Key 做并发提升与单 Key 限流摘除，业务侧无感。
- 追问2：自研 AI 网关最大的坑是什么？
  - **答**：流式透传与背压——自研很容易在网关层缓冲整个响应再转发，导致首字延迟翻倍、客户端断连时服务端空转生成。必须流式转发（逐 chunk 代理）并透传客户端 RST 取消。

### 3. 统一鉴权与密钥治理：多 Provider / 多 API Key 的轮询、降权、轮换怎么做？
**重要度**：★★★★

**难度**：★★★

**考点**：虚拟 Key、多 Key 轮询、429 降权摘除、密钥轮换无感

**参考答案**：在网关层维护「Provider → [真实 Key]」映射，业务用虚拟 Key。每个真实 Key 独立维护限流计数与最近 429 时间；轮询时跳过"降温中"的 Key（命中 429 即标记降权、退避窗口内不再选）；Key 轮换通过配置中心热更新，旧 Key 缓冲期（如 10min）内仍可用于在途请求，新 Key 并行生效，避免明文改代码重启。碳管家用 3 个通义 Key 轮询把单 Key 并发提到 ~15 QPS，命中 429 的 Key 自动降权。

**深度解析**：要点是"Key 维度健康状态"与"租户维度配额"两层分离——Key 轮询解决 Provider 单 Key RPM 上限，租户配额解决多客户成本隔离。轮换时网关持有新旧两套 Key 列表，按 `生效时间` 灰度切流，老 Key 自然淘汰，业务零改动。

**易错点**：轮询不考虑 Key 独立限流，某 Key 被限流仍均分流量导致持续 429；轮换直接删旧 Key 使在途请求批量 401；把真实 Key 写进前端或日志。

#### 追问：
- 追问1：多 Key 轮询下，同一用户的请求落到不同 Key，会不会造成上下文/缓存不一致？
  - **答**：不会。Key 只决定出口通道，与对话上下文无关；上下文由会话 ID 在应用层管理，Key 轮询对上层透明。但计费统计要按虚拟 Key 聚合回租户。
- 追问2：密钥泄露怎么办？
  - **答**：网关侧一键吊销虚拟 Key（业务无感，换映射即可），真实 Key 在网关配置中心加密存储；泄露的真实 Key 在 Provider 后台轮转，网关热更新新 Key，旧 Key 缓冲期后下线。

### 4. 面向 LLM 的限流：RPM/TPM 与请求数限流的本质差异，token 预算限流怎么落地？
**重要度**：★★★★★

**难度**：★★★

**考点**：RPM/TPM 维度、token 预算、多租户配额收口、分布式计数

**参考答案**：普通限流按"请求数/QPS"，但 LLM 的瓶颈是 Provider 的 RPM（请求/分钟）与 TPM（token/分钟）配额。一个长回答可能吃掉数万 token，所以网关限流要升维到 token：每个请求预估/实测 token 消耗，从租户 TPM 配额扣减；TPM 不足则排队或降级。落地：网关用 Redis + Lua 原子脚本维护 `tenant:{id}:tpm:{window}` 计数，按 token 扣减并设滑动窗口；配合 Provider RPM 上限做"请求数+token 数"双层闸门。碳管家按租户设日 token 预算，超限降级或限流。

**深度解析**：token 预算比请求数更贴近成本与 Provider 约束。难点是"请求前未知真实 token 数"——用输入 token 预估（max_tokens 已知）+ 输出上限估算，先扣预估、响应后按真实 usage 校正（多退少补）；校正差额异步落 Redis，避免每次同步阻塞。

**易错点**：只限 QPS 不限 TPM，长回答把 Provider token 配额打爆；预估 token 用字符数粗算误差大；校正用同步写把首字延迟拉高。

#### 追问：
- 追问1：输入 token 可预估，但输出 token 未知，怎么防止"预估小、实际超大"超配额？
  - **答**：以 `input + max_tokens` 作为预扣上限（max_tokens 是硬上限），响应后按真实 output 校正；若某请求 max_tokens 设得极大，网关可对其单独收紧或要求走异步任务。
- 追问2：多租户 TPM 配额怎么和 Provider 全局 RPM 对齐，避免租户叠加超 Provider 总限？
  - **答**：网关设全局 RPM/TPM 硬上限（漏斗形：全局 ≥ 租户之和余量），租户配额之和预留突发余量；命中全局上限时按优先级（核心链路 > 闲聊）抢占，非核心降级。

### 5. 内容安全护栏（Guardrails）：注入防护、敏感词/合规审查、输出红队，为何放网关层？
**重要度**：★★★★★

**难度**：★★★

**考点**：提示词注入防护、护栏位置、延迟预算、合规审查

**参考答案**：护栏放在 AI 网关层而非应用层，是因为它是所有模型流量的统一收口，能"一次建设、全部模型受益"，且可在路由前拦截恶意输入、在响应后审查输出，避免每个业务服务各自实现。典型能力：
  - ① 输入侧——提示词注入检测（如"忽略之前指令"）、敏感词/PII 过滤、租户越权意图识别
  - ② 输出侧——合规审查（碳管家禁止编造排放因子）、有害内容红队过滤、来源标注
  - 碳管家在网关层做注入防护与"禁止编造因子"硬约束，应用层 Advisor 只做业务级增强。

**深度解析**：护栏必须在"不显著增加首字延迟"前提下做。做法：输入护栏用轻量规则 + 小型分类模型并行（与 RAG 检索并行，不串行加延迟）；输出护栏对流式响应做 chunk 级轻量扫描，仅对高危模式（泄露密钥、编造数值）做中断或打标，不做重模型审查以免拖慢。

**易错点**：把所有护栏都放应用层导致多模型各自一套、出现漏洞；输出护栏用重模型审查把流式首字延迟翻倍；只防输入不防输出（模型被越狱后输出仍可能违规）。

#### 追问：
- 追问1：提示词注入检测误杀正常碳法规问题怎么办？
  - **答**：规则做"高 precision 低 recall"——只拦明确注入句式与越权指令，正常专业问题不拦；可疑但不确定的放行并在日志打标，靠后续输出护栏兜底，避免误伤专业问答。
- 追问2：输出护栏发现模型"编造了排放因子"怎么实时干预？
  - **答**：网关层无法单看文本判断是否编造，所以碳管家把"数值必须来自工具"做成硬约束：响应中数值与 `carbonFactorLookup` 工具返回比对，不一致即拦截并触发重答或转人工，护栏只负责"命中拦截规则则中断"。

### 6. 可观测性：TTFT/TPS/错误率/成本按模型·租户·Provider 维度怎么采集？网关实测 vs Provider usage 口径不一致怎么办？
**重要度**：★★★★★

**难度**：★★

**考点**：LLM 指标定义、TTFT/TPS 采集点、口径对齐、成本归因

**参考答案**：在网关层对每次请求打点：首 token 到达时刻减请求进入时刻得端到端 TTFT（含网络与排队）；末 token 减首 token 除以生成 token 数得 TPS；错误率按 HTTP 状态 + 软错误（降级文案占比、置信度<阈值）计；成本按 `usage.prompt_tokens × 输入单价 + usage.completion_tokens × 输出单价` 计算（缓存命中的输入 token 按缓存价折算），再按租户·模型·Provider 聚合——不能用 total_tokens 当分母，输入/输出单价本来就不同，除法算出来是无意义的比例。维度标签带 `model/tenant/provider/route`。

**深度解析**：口径不一致根因——Provider `usage` 只算它自己推理的 token，不含网关排队、网络重传、重试；网关实测才是用户感知。碳管家以**网关实测为主、Provider usage 为辅做交叉校验**：两者差异超阈告警（防"模型快但链路慢"误导），用户侧 SLA 以网关为准，成本账单以 Provider usage 为准（更准）。

**易错点**：用 Provider usage 当用户体验指标（漏掉排队/网络）；只采成功率不采软错误（返回 200 但内容是降级文案，掩盖故障）；成本不按租户归因导致扯皮。

#### 追问：
- 追问1：流式输出时 TTFT 和 TPS 在网关怎么打点才准？
  - **答**：网关在转发 SSE 时监听首/末 data chunk 时间戳；首 chunk 到即记 TTFT，末 chunk 到记总时长并读 usage 算 TPS；注意网关自身缓冲会污染测量，故须逐 chunk 透传、不整段缓冲。
- 追问2：软错误怎么量化进错误率而不误伤偶发降级？
  - **答**：设滑动窗口，软错误占比（降级文案/低置信应答占成功响应的比例）超阈值才计入错误率推动熔断；单发降级不计入，避免抖动误熔断。

### 7. 无缝切换模型：统一协议抽象如何做到切模型零代码改动？
**重要度**：★★★★★

**难度**：★★★

**考点**：统一抽象、OpenAI 兼容、适配器模式、配置驱动切换

**参考答案**：核心是把"模型差异"收敛到适配层，业务只依赖统一接口（如 Spring AI 的 `ChatModel` 或 LiteLLM 的 OpenAI 兼容端点）。各 Provider 的差异（请求/响应结构、SSE 格式、错误码、Function Calling Schema）由适配器封装；切换模型只需改配置（yml 里的 model 名 / 网关路由权重 / Nacos 配置），业务代码零改动。碳管家通过注入多个 `ChatModel` Bean + 路由层，切通义 Qwen / DeepSeek / 本地 vLLM（注意 Qwen 就是通义系列，不能当成两个独立 Provider）不改业务。

**深度解析**：关键是"接口契约稳定 + 适配层吸收差异"。统一用 OpenAI 兼容协议能最大化复用（多数国产模型已兼容）；不兼容的能力（如某模型不支持 logprobs）在适配层做能力探测与降级（缺则改用检索相关度+ensemble 一致性）。新增 Provider 只需加一个适配器，不扩散到业务。

**易错点**：以为"换 endpoint 就无缝"——忽略参数语义差异（temperature 范围、max_tokens 含义）导致换模型后行为漂移；适配器里写死某模型特例，新增模型时改动扩散到十几个地方。

#### 追问：
- 追问1：统一接口用 `ChatModel` 抽象，但不同模型对 Function Calling 参数 Schema 支持度不一，碳管家的工具在切到本地模型时可能不兼容怎么兜底？
  - **答**：适配层做 Schema 兼容校验，失败则降级回主模型或改走文本解析；对关键工具设"强模型白名单"，小/本地模型不接复杂工具调用。
- 追问2：新增 Provider 时，编译器报错点散布在十几个 switch，怎么管"改动扩散"？
  - **答**：集中路由入口（一个 `ModelRouter`/策略表），所有模型选择走它，不在各处散写 switch；用注册表 + 策略模式，新 Provider 只注册不改动既有分支。

### 8. 输出契约兼容：temperature/max_tokens/JSON mode/Function Calling Schema 差异，如何保证换模型不崩？
**重要度**：★★★★

**难度**：★★★

**考点**：参数语义归一、Prompt 版本绑定、Schema 兼容、切换校验

**参考答案**：切换模型前必须做"契约对齐"：
  - ① 参数归一——在适配层把业务语义参数映射成各模型实际范围（如 temperature 0~1 统一，超范围钳制）
  - ② 结构化输出——优先用 JSON mode/Structured Output，不支持的模型降级为 Function Calling 或宽松解析+字段校验
  - ③ Prompt 版本绑定——在配置中心把"模型→Prompt 模板版本"绑定，切换时联动加载对应模板，避免 A 模型写的 Prompt 在 B 模型崩
  - ④ 切换前在灰度环境用评测集验证兼容性

**深度解析**：碳管家实践：为不同模型维护 Prompt 变体，切换时按模型维度路由对应模板；关键报告场景只路由到支持 JSON mode 的强模型，小模型只做草稿；返回做宽松解析 + 必填字段补全校验，解析失败重试一次 + 正则兜底。

**易错点**：认为配置驱动切模型就万事大吉，忽略 Prompt 在某模型下不生效；JSON 解析失败直接抛异常中断整条链；不同模型 temperature 同值却一个保守一个发散，输出质量漂移无人发现。

#### 追问：
- 追问1：配置中心能否承载"模型→Prompt 版本"绑定与切换校验？
  - **答**：能，且应该。Nacos 存 `model → promptVersion` 元数据，切换模型时网关/适配层联动拉取对应模板；变更走评审 + 灰度环境评测集验证后再全量。
- 追问2：小模型不支持 JSON mode 时结构化报告怎么出？
  - **答**：
    - ① 优先路由强模型做结构化输出
    - ② 小模型下改用 Function Calling 约束（比纯 JSON 稳）
    - ③ 返回做宽松解析 + 字段补全校验
    - ④ 关键报告场景强制走强模型

### 9. 流式 in-flight 切换：切换瞬间正在 SSE 输出的会话怎么不断流、上下文一致？
**重要度**：★★★★

**难度**：★★★★

**考点**：流式切换、in-flight 请求、会话级版本锁、无缝续传

**参考答案**：切换配置只影响**新请求**，进行中（in-flight）请求按旧配置跑完，不被截断——这是碳管家"会话级版本锁"的核心：切换事件到达时，进行中会话绑定旧 `model_version` 直至结束，新请求按新值路由。对**流式**会话：网关在转发 SSE 时若触发模型切换，不中断已建立的流，已推送的 chunk 保留，后续 chunk 仍来自原模型；若原模型故障需 failover，则区分"首字前"（直接切备选，用户无感）与"首字后"（已输出部分标记"响应不完整"，failover 到备选续生成或返回降级提示，不强行拼接两段不同模型的输出造成错乱）。

**深度解析**：真正"无缝续传"很难——两段模型输出风格/口径不同，拼接会崩。务实做法是：首字前故障→透明切备选（用户只看到一次完整回答）；首字后故障→已生成部分保留并标记，failover 重答整句（用户看到一次"重新生成"而非拼接残次）。降级上下文一致性靠"检索结果在路由前统一产出"保证——喂给哪个模型都看到同一份 RAG 证据。

**易错点**：切换瞬间粗暴断流导致用户看到半截回答；试图拼接两个模型的输出造成口径错乱；认为"配置热更新"能自动让在途流式会话也换模型（实际会截断）。

#### 追问：
- 追问1：首字后故障 failover 到备选模型，两段回答风格/合规口径不一致用户能接受"重新生成"吗？
  - **答**：比拼接残次更可接受。碳管家对关键法规类 query 禁用跨模型降级或仅降级到同口径模型，并做合规一致性 checksum 比对，异常走默认模型重试，保证口径统一。
- 追问2：网关怎么知道"首字已出"以便决定切还是续？
  - **答**：网关在 SSE 转发时维护请求状态机（pending→first_token_sent→streaming→done），首字到达即翻状态；故障处理按当前状态分支：pending 直接 failover，first_token_sent 后走重答/降级。

### 10. 缓存与预热：模型切换导致语义缓存/Prompt Cache 失效如何处理？对话记忆/检索结果跨模型复用？
**重要度**：★★★★

**难度**：★★★

**考点**：语义缓存失效、Prompt Cache 跨模型、记忆复用、切换预热

**参考答案**：语义缓存（相似问题→答案）按"问题语义 + 模型"为 key——切到新模型会使原缓存命中率骤降，因为不同模型答案不同。对策：
  - ① 高频 FAQ 类缓存按"问题语义"为主 key、模型为辅助维度，简单问题跨模型复用度高者可放宽模型维度
  - ② RAG 检索结果与对话记忆与模型无关，切换时直接复用（同一份证据喂新模型），不重建
  - ③ 切换前预热——对新模型跑热点 query 重建语义缓存 + 触发 Provider 侧 Prompt Cache 预热（如通义/DeepSeek 的 prefix cache），避免切换后首波冷请求全打慢
  - ④ 切换后保留旧模型缓存一段 TTL 供回滚，新缓存达标再切流量

**深度解析**：Prompt Cache（如 Anthropic/通义 prefix cache）是 Provider 侧按前缀缓存 KV，切模型必失效，且不同模型向量空间不同，本地语义缓存也不能无差别复用。碳管家把"检索上下文"作为模型无关资产独立管理，模型切换只影响生成侧缓存，检索/记忆零成本复用。

**易错点**：用"问题"单维度做语义缓存 key，切模型后返回别的模型的答案造成口径错误；切换模型不预热导致首波请求全慢、触发误熔断；把对话记忆也按模型缓存导致上下文错乱。

#### 追问：
- 追问1：RAG 检索结果和对话记忆真的与模型完全无关吗？
  - **答**：检索结果本身无关，但"喂给模型的片段格式"可能因模型上下文窗口/指令跟随能力不同需调整；记忆以结构化对话记录存储（模型无关），注入时按目标模型模板渲染，所以存储无关、渲染可微调。
- 追问2：切换预热怎么做才不影响线上？
  - **答**：用影子流量（复制线上 query 但不返回用户）对新模型跑热点 query 建缓存 + 触发 Provider Prompt Cache；或离线批量对高频问题预生成并写入语义缓存，切换时直接命中。

### 11. Failover 与口径一致：降级回答如何与 RAG 一致、避免重试风暴？
**重要度**：★★★★★

**难度**：★★★

**考点**：故障转移、上下文一致、重试退避、熔断协同

**参考答案**：Failover 链（主模型→备模型→缓存→引导）要保证降级回答与 RAG 检索上下文一致——检索在路由前由统一检索服务产出，降级时复用同一 Prompt 与检索片段，仅换底层 `ChatModel`，所以证据同源、口径不乱。避免重试风暴靠：
  - ① 指数退避 + 抖动（backoff+jitter），区分可重试（429/超时）与不可重试（业务错）
  - ② 限制单请求重试次数与全局并发重试配额
  - ③ 网关对重试流量打标单独限流，避免叠加放大 Provider 限流

**深度解析**：碳管家降级链：主（通义 Qwen-Plus）→备（DeepSeek）→备（本地 vLLM 自部署的 Qwen）→缓存回复→人工转接，每级记录日志。注意**同源模型只算容量冗余、不算故障域隔离**——通义和自部署 Qwen 是同一套权重，百炼整体不可用时只有 DeepSeek 和本地 vLLM 是真 failover；把"通义 → Qwen"当两级就等于没有冗余。重试只在"首字前"完成才对用户无感，超时才降级提示。熔断（Sentinel 错误率>10%）与重试协同：持续超时→错误率超阈→熔断，后续直接走 fallback，不再无效重试。

**易错点**：failover 时重新检索导致主备答案证据不同、口径漂移；重试无退避无配额，429 时疯狂重试放大成雪崩；把"返回降级文案"当成功（应计入软错误推动熔断）。

#### 追问：
- 追问1：主备模型输出风格差异大，降级后用户察觉"换模型了"怎么缓解？
  - **答**：统一输出约束（Structured Output 固定 Schema）+ 后置合规校验（Drools 规则统一口径与条款引用）+ 关键法规类禁用跨模型降级，把差异压到用户无感。
- 追问2：重试打标单独限流具体怎么实现？
  - **答**：网关在重试请求头打 `x-retry: true`，限流层对该维度单独设较低配额（如正常流量 90%、重试 10%），防止重试挤占正常请求，同时全局并发重试用信号量封顶。

### 12. 影子流量评测：新模型上线前如何用 Shadow/Canary 在网关层做无风险评测？
**重要度**：★★★★

**难度**：★★★

**考点**：影子流量、Canary、会话一致性哈希、无风险评测

**参考答案**：新模型上线前用**影子流量（Shadow）**：网关复制线上真实请求，同时发给基线模型与新模型，基线结果返回用户、新模型结果只记录不参与响应，用评测集（准确率/合规/成本/延迟）离线对比，验证通过再切 Canary（1%→5%→20%→50%→100%）。灰度期间用**会话级一致性哈希**：同一 sessionId 稳定路由到同一模型版本，避免多轮对话中途串版本导致上下文错乱。碳管家用 Nacos 存灰度比例 + 网关按权重/会话哈希路由。

**深度解析**：影子模式关键是"复制请求但不能让新模型产生副作用"（不写库、不调外部工具、不返回用户）；评测维度除质量外还要看成本与延迟是否达标。Canary 用滞后（hysteresis）防抖动：错误率超阈才回滚，恢复后缓慢加量，避免频繁来回切。

**易错点**：影子流量让新模型真实调用了写操作/计费工具造成脏数据；灰度按请求随机而非按会话，多轮对话中途换模型导致上下文断裂；Canary 无滞后在指标抖动时频繁回滚。


#### 三种框架实现对比

##### Spring AI 1.0 实现

```java
package com.carbon.guard.shadow;

import org.springframework.cloud.gateway.filter.GatewayFilterChain;
import org.springframework.cloud.gateway.route.RouteLocator;
import org.springframework.cloud.gateway.route.RouteLocatorBuilder;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.server.reactive.ServerHttpRequest;
import org.springframework.stereotype.Component;
import org.springframework.web.reactive.function.client.WebClient;
import org.springframework.web.server.ServerWebExchange;
import org.springframework.core.Ordered;
import reactor.core.publisher.Mono;

import java.util.Map;

/**
 * 影子流量（Shadow）：
 * 1) 真实请求仍走【生产模型】，用户只看到生产结果
 * 2) 同一份请求【复制一份】发给影子模型，结果只落库比对、不返回用户
 * 3) 比对维度：答案质量打分、幻觉率、P95 延迟、成本差异
 */
@Component
public class ShadowEvaluationFilter implements org.springframework.cloud.gateway.filter.GlobalFilter {

    /** 前置 BodyCacheFilter 把请求体缓存到这里：Gateway 的 body 只能被消费一次 */
    private static final String CACHED_BODY = "cachedRequestBody";
    private static final Logger log = LoggerFactory.getLogger(ShadowEvaluationFilter.class);

    private final WebClient webClient;

    public ShadowEvaluationFilter(WebClient.Builder builder) {
        this.webClient = builder.build();
    }

    @Override
    public Mono<Void> filter(ServerWebExchange exchange, GatewayFilterChain chain) {
        ServerHttpRequest request = exchange.getRequest();
        String key = sampleKey(request);

        // 采样：按 sessionId（无则 requestId）哈希分桶，同一会话稳定落同一侧，只对 5% 流量做影子评测。
        // 按 path 哈希会让某个接口 100% 走影子、其余 0%，不是 5%。
        if (Math.floorMod(key.hashCode(), 100) < 5) {
            // 与生产请求并行发出，不阻塞用户响应
            shadowCall(request, traceId(exchange))
                    .subscribe(result -> record(key, result),
                            err -> log.warn("shadow failed: {}", err.getMessage()));
        }
        return chain.filter(exchange);
    }

    private String sampleKey(ServerHttpRequest request) {
        String sessionId = request.getHeaders().getFirst("x-session-id");
        return sessionId != null ? sessionId : request.getId();   // requestId 兜底
    }

    private String traceId(ServerWebExchange exchange) {
        String traceId = exchange.getRequest().getHeaders().getFirst("x-trace-id");
        return traceId != null ? traceId : exchange.getRequest().getId();
    }

    /** 影子调用：转发原始请求体，结果只入库比对，绝不回给用户 */
    private Mono<String> shadowCall(ServerHttpRequest request, String traceId) {
        String body = (String) request.getAttributes().get(CACHED_BODY);
        if (body == null) {
            // 拿不到原始 messages 就别发——影子模型看不到问题，评了也没意义
            return Mono.empty();
        }
        return webClient.post()
                .uri("http://shadow-llm-gateway/chat")
                .header("x-shadow", "true")        // 影子侧据此禁用写操作/工具副作用
                .header("x-trace-id", traceId)     // 生产结果与影子结果靠 traceId 关联
                .bodyValue(Map.of("model", "qwen3-candidate", "payload", body))
                .retrieve()
                .bodyToMono(String.class);
    }

    private void record(String key, String result) {
        // 落库 → 离线评测流水线（对比生产答案、打幻觉率、算成本）
    }
}
```

##### Spring AI 2.0 实现

```java
package com.carbon.guard.shadow;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.cloud.gateway.filter.GatewayFilterChain;
import org.springframework.core.Ordered;
import org.springframework.http.server.reactive.ServerHttpRequest;
import org.springframework.stereotype.Component;
import org.springframework.web.reactive.function.client.WebClient;
import org.springframework.web.server.ServerWebExchange;
import reactor.core.publisher.Mono;

import java.util.Map;

/**
 * 2.0 变化：
 * 1) 评测维度可以接上 StructuredOutputValidationAdvisor / 结构化输出，
 *    让影子结果按固定 JSON schema 落库，便于离线比对
 * 2) 网关层本身与 Spring AI 版本无关，差别在影子侧的"打分"实现
 */
@Component
public class ShadowEvaluationFilter implements org.springframework.cloud.gateway.filter.GlobalFilter {

    private static final String CACHED_BODY = "cachedRequestBody";   // 前置 BodyCacheFilter 写入
    private static final Logger log = LoggerFactory.getLogger(ShadowEvaluationFilter.class);

    private final WebClient webClient;

    public ShadowEvaluationFilter(WebClient.Builder builder) {
        this.webClient = builder.build();
    }

    @Override
    public Mono<Void> filter(ServerWebExchange exchange, GatewayFilterChain chain) {
        ServerHttpRequest request = exchange.getRequest();
        String key = request.getHeaders().getFirst("x-session-id") != null
                ? request.getHeaders().getFirst("x-session-id")
                : request.getId();

        if (Math.floorMod(key.hashCode(), 100) < 5) {
            shadowCall(request, exchange.getRequest().getHeaders().getFirst("x-trace-id"))
                    .subscribe(result -> record(key, result),
                            err -> log.warn("shadow failed: {}", err.getMessage()));
        }
        return chain.filter(exchange);
    }

    private Mono<String> shadowCall(ServerHttpRequest request, String traceId) {
        String body = (String) request.getAttributes().get(CACHED_BODY);
        if (body == null) {
            return Mono.empty();   // 没有原始 messages 就不发影子请求
        }
        return webClient.post()
                .uri("http://shadow-llm-gateway/chat")
                .header("x-shadow", "true")
                .header("x-trace-id", traceId == null ? request.getId() : traceId)
                .bodyValue(Map.of("model", "qwen3-candidate", "payload", body))
                .retrieve()
                .bodyToMono(String.class);
    }

    private void record(String key, String result) {
        // 按固定 JSON schema 落库，便于离线比对
    }
}
```

##### LangChain4j 实现

```java
package com.carbon.guard.shadow;

import dev.langchain4j.model.chat.ChatModel;
import dev.langchain4j.model.openai.OpenAiChatModel;
import dev.langchain4j.service.AiServices;
import dev.langchain4j.service.SystemMessage;
import dev.langchain4j.service.UserMessage;
import dev.langchain4j.service.V;

import java.time.Duration;
import java.util.concurrent.CompletableFuture;

/**
 * LangChain4j 版的影子评测，和 Spring AI 版的差异集中在三点：
 * 1) 候选模型不是"另一个 HTTP 网关"，而是用同一个 OpenAiChatModel 换 baseUrl + modelName
 *    造出来的第二个 ChatModel 实例——多模型治理在这里就是"多构造一个 Builder"。
 * 2) 打分不手写 prompt + 解析 JSON，而是声明一个接口（Judge），由 AiServices 生成代理实现。
 * 3) baseUrl 约定不同：LangChain4j 的 baseUrl 要带版本段（默认就是 https://api.openai.com/v1，
 *    它只往后拼 /chat/completions），所以接 vLLM 写 http://vllm-server:8000/v1；
 *    Spring AI 的 base-url 则只写到端口（它自己拼 /v1/chat/completions）。
 *    这一点写反了就是 404，是两套框架互迁时最容易踩的坑。
 * 4) ChatMemory 的注入方式也不同：LangChain4j 是 AiServices 的构造参数 .chatMemory(...)，
 *    Spring AI 是 ChatClient 的 advisor（MessageChatMemoryAdvisor）。
 */
public class ShadowEvaluator {

    /** 打分结果直接用 record 承接，AiServices 负责 JSON → record 的反序列化 */
    public record Score(int faithfulness, int relevance, String reason) {}

    /** 接口式声明：方法签名即 Prompt 模板，@V 绑定参数 */
    interface Judge {
        @SystemMessage("你是 RAG 问答评测员，按 1-5 分给出忠实度(faithfulness)与相关性(relevance)，并简述理由。")
        @UserMessage("用户问题：{{question}}\n生产答案：{{prod}}\n候选答案：{{cand}}")
        Score compare(@V("question") String question,
                      @V("prod") String prod,
                      @V("cand") String cand);
    }

    private final ChatModel productionModel;   // 线上模型
    private final ChatModel candidateModel;    // 候选模型：只换 baseUrl + modelName
    private final Judge judge;

    public ShadowEvaluator(String prodBaseUrl, String prodModel,
                           String candBaseUrl, String candModel) {
        this.productionModel = OpenAiChatModel.builder()
                .baseUrl(prodBaseUrl)              // e.g. http://qwen-prod:8000/v1
                .apiKey("inner-token")
                .modelName(prodModel)
                .timeout(Duration.ofSeconds(30))
                .build();
        this.candidateModel = OpenAiChatModel.builder()
                .baseUrl(candBaseUrl)              // e.g. http://qwen-candidate:8000/v1
                .apiKey("inner-token")
                .modelName(candModel)
                .timeout(Duration.ofSeconds(30))
                .temperature(0.0)                  // 评测要可复现，候选侧关掉随机性
                .build();
        // 用生产模型当裁判，避免"候选模型自评"的系统性偏袒
        this.judge = AiServices.builder(Judge.class)
                .chatModel(this.productionModel)
                .build();
    }

    /** 影子对比：生产答案照常回用户，候选答案只落库比对、绝不回传 */
    public CompletableFuture<ShadowResult> compareAsync(String question) {
        String prod = productionModel.chat(question);
        return CompletableFuture.supplyAsync(() -> {
            long start = System.nanoTime();
            String cand = candidateModel.chat(question);
            long latencyMs = (System.nanoTime() - start) / 1_000_000;
            Score score = judge.compare(question, prod, cand);
            return new ShadowResult(question, prod, cand, score, latencyMs);
        });
    }

    public record ShadowResult(String question, String prod, String cand,
                               Score score, long latencyMs) {}
}
```

**两套框架在同一件事上的写法差异（面试常追问）**：

| 维度 | Spring AI | LangChain4j |
|---|---|---|
| 调用形态 | `ChatClient.prompt().system(...).user(...).call().content()` 链式 | `ChatModel.chat(...)` 或 `AiServices` 接口式代理 |
| 多模型治理 | 多个 `ChatClient`/`ChatModel` Bean，靠 Router 或 `@Qualifier` 选 | 多个 `OpenAiChatModel` 实例，构造时换 `baseUrl`/`modelName` |
| 结构化输出 | `StructuredOutputValidationAdvisor` + `.entity(Class)` | `AiServices` 返回 record，自动 JSON 反序列化 |
| 记忆 | `MessageChatMemoryAdvisor`（advisor 挂在 ChatClient 上） | `AiServices.builder().chatMemory(...)`（服务级注入） |
| baseUrl 约定 | 只写到端口，`/v1` 由框架拼 | 必须带 `/v1`，框架只拼 `/chat/completions` |

#### 追问：
- 追问1：影子流量里新模型也要调 RAG/工具，会不会污染线上检索或产生费用？
  - **答**：影子请求打标隔离，检索可复用但工具调用走"影子专用、只读、不落库"通道，计费单独统计不计入用户账单；涉及写/外部通知的工具在影子模式强制短路。
- 追问2：会话一致性哈希和按权重灰度怎么共存？
  - **答**：先看灰度权重决定该会话"应走新模型比例"，新会话按哈希落入对应版本；已进入的会话绑定当前版本直到结束（会话级版本锁），权重切换只影响新会话，不中途串版本。

### 13. 多区域容灾：Region 故障切换时如何保历史上下文、不丢对话状态？
**重要度**：★★★

**难度**：★★★

**考点**：多活/主备、向量库副本、对话状态、跨域降级

**参考答案**：Region 故障切换要在"不中断服务"与"不丢上下文"间平衡。先说清一个前提：**开源 Milvus 没有内置的跨 Region/跨集群复制**，所以"共享向量库副本"必须落在具体实现上，工程上三种选法：① 托管版（Zilliz Cloud Global Cluster）由厂商做跨域复制，RPO 秒级、可读写；② 应用层双写——同一批向量同时写主备两个 Milvus 集群，RPO 取决于双写是否同步（同步双写≈0，异步秒级）；③ `milvus-backup` 定期全量备份 + 传输到备域恢复，RPO 分钟级到小时级，只适合可接受滞后的历史数据。碳管家的做法是主备 Region 同属数据合规域、向量库用**双写 + milvus-backup 兜底（RPO 分钟级）**，切换后可继续检索历史（最近几分钟的增量靠双写补齐）；对话状态（Redis 会话）做跨域异步复制，故障域切到备域时能恢复近期上下文。真正跨合规域切换时仅保对话可用、历史检索降级为无上下文问答并提示用户。流量切换用网关按 Region 健康探测自动切（延迟可能增加但服务不中断）。

**深度解析**：难点是"状态一致 vs 切换速度"——同步复制保一致但拖慢写入，异步复制快但可能丢最近几秒会话。碳管家对核心会话做准实时复制（秒级 RPO），非核心会话容忍最终一致；切换时优先同数据域，跨域仅兜底无状态问答。

**易错点**：跨合规域切换仍尝试访问原域向量库导致超时；只切流量不切状态，用户到备域后上下文全丢像"换了个人"；Region 探测抖动造成频繁来回切。

#### 追问：
- 追问1：会话状态跨域复制的 RPO 怎么定？
  - **答**：按业务容忍度：核心碳核算会话 RPO 秒级（准实时复制），闲聊会话可分钟级；用 Redis 跨域复制 + 会话写时双写/异步补偿，切换时以"最近成功复制点"恢复并提示可能缺失。
- 追问2：跨域切换后历史检索降级，用户问"上周的核算"答不上来怎么兜底？
  - **答**：明确提示"当前为跨域容灾模式，历史检索暂不可用"，并提供"转人工/稍后重试"入口；核心历史数据走同域副本优先，仅真跨域才降级。

### 14. 分层演进：引入 Agent 多步工具调用、多模型 ensemble 后，AI 网关如何演进而不成为瓶颈？
**重要度**：★★★★

**难度**：★★★★

**考点**：架构演进、编排→适配→模型、网关职责边界、Agent 流量治理

**参考答案**：演进路线从「路由→模型」到「编排→适配→模型」：网关/适配层只保留模型调用、超时重试、限流降级、协议归一，不再理解业务多步逻辑；Agent 编排（多步工具调用、反思、ensemble）上移到独立的编排层（如 Spring AI Alibaba Graph / LangGraph），编排层调用适配层拿到的统一模型能力与工具。这样网关不被业务复杂度拖垮，且 ensemble（多模型并行投票）在编排层做、网关只负责把单次模型调用高效转发。碳管家推荐分层：客户端 → **SCG（接入/租户鉴权）→ 编排层（Agent/ensemble）→ AI 网关（路由/failover/token 计量/护栏）→ 适配层（多模型统一）→ Provider**。注意网关要放在编排层**之后**：Agent 循环里一次任务会发起 N 次模型调用，如果网关在编排层之前，第 2 次以后的调用就绕过了网关，限流、成本、护栏全部失效；放在编排层之后，才能做到"每一次模型调用都过网关"。

**深度解析**：关键边界——网关做"横切治理"（鉴权/限流/成本/护栏/可观测），编排层做"业务智能"（路由到哪几个模型、怎么融合、何时调工具）。当引入 ensemble，网关对单次调用透明，编排层控制并行度与融合策略，避免网关变成"懂业务的胖网关"。可观测性在网关按单次调用打点，在编排层按"一次 Agent 任务"聚合。

**易错点**：把 Agent 多步逻辑写进网关 Filter 链，网关越来越胖、改一处影响全链路；ensemble 在网关层做导致网关理解业务语义、难扩展；编排层直接调 Provider 绕过网关，丢失统一限流/成本/护栏。

#### 追问：
- 追问1：Agent 多步工具调用下，网关的限流/成本怎么按"一次任务"而非"单次调用"计量？
  - **答**：网关按单次模型调用计量（token/限流），编排层按任务维度聚合（一次 Agent 任务可能 N 次调用）做任务级预算与熔断；两者通过 `taskId` 关联，任务级预算超限时编排层提前终止并降级。
- 追问2：多模型 ensemble 时，网关如何保证各模型调用的"检索上下文"一致？
  - **答**：检索在编排层/统一检索服务产出一次，并行喂给各模型（同一份证据），网关只负责把各模型的调用高效转发与分别计量，上下文一致性由编排层保证而非网关。

---


---
