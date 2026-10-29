## 第三十四章：碳数据平台工程化与Java实战

> 本章把前面的 Java 技术栈**落到碳业务场景**：Kafka 承接 MRV 采集削峰、限流与背压、线程池隔离"设备采集"与"碳核算计算"、CompletableFuture 编排多源数据、CDC 与对账。这是从"会八股"跨到"做过真实系统"的关键一章。



### 1. 如何用 Kafka 承接高并发 MRV 碳数据采集流量并削峰？
**重要度**：★★★★

**难度**：★★

**考点**：高并发碳数据采集、消息队列削峰、Kafka 分区与消费并行度设计。

**参考答案**：MRV（监测/报告/核查）数据来自厂区 IoT 电表、燃气表、DCS 设备等，峰值可达数万 TPS。设备侧以 MQTT/HTTP 上报网关，网关按 `enterpriseId + deviceId` 哈希写入 Kafka 指定分区，借助分区实现水平扩展与同设备顺序性。消费端用消费者组并行拉取，写入时序库（TDengine/InfluxDB）与 ES。突发流量由 Kafka 持久化缓冲，按下游写入能力匀速消费，实现削峰填谷。

**深度解析**：削峰本质是用 Kafka 的磁盘缓冲把"瞬时尖峰"转化为"平稳消费"。分区数决定最大并行度，需 ≥ 消费者实例数；按业务键哈希保证同设备数据有序，避免碳数据乱序导致核算口径偏差。网关层可加本地攒批（batch + linger.ms）降低生产端 QPS。《Kafka 权威指南》指出分区是 Kafka 并行度的基本单位，分区数一旦确定扩容收益有限，需前期按峰值 3 倍冗余规划。

**易错点**：分区键选错导致数据倾斜（如全用 enterpriseId 但某集团设备极多）；消费端处理过慢却未扩容消费者，造成 lag 堆积；忽略消息大小与单分区吞吐上限。

#### 追问：
- 追问1：Kafka 消费 lag 持续上涨，应该优先扩容分区还是扩容消费者？
  - **答**：优先扩容消费者实例（受消费者组上限约束）。只有消费者已达分区数上限、仍无法消费时，才增加分区。扩分区会破坏原 key 的顺序性，需评估对同设备有序性的影响，建议低峰期操作并配合重放。
- 追问2：MRV 数据是否必须严格 Exactly-Once？
  - **答**：采集层通常追求 At-Least-Once + 下游幂等。严格 EOS 成本高，碳核算更看重"不丢、可重放、可去重"，故在入库时用 (deviceId, timestamp, seq) 幂等键兜底，而非强依赖事务性 producer。

### 2. 采集链路如何做限流与背压，防止下游时序库被打垮？
**重要度**：★★★★

**难度**：★★

**考点**：限流算法、背压机制、设备采集与计算链路的流量控制。

**参考答案**：在网关入口用令牌桶（Guava RateLimiter / Sentinel）对单设备、单企业做 QPS 限流，峰值超出则本地缓存或快速失败并回传设备端降频。Kafka 消费者通过 `max.poll.records` 与 `pause()/resume()` 实现应用级背压：当下游时序库写入线程池队列超阈值时暂停拉取，待恢复后继续，避免无限堆积 OOM。

**深度解析**：背压（Backpressure）是响应式流的核心概念，语义为"消费者告知生产者减速"。在碳数据场景，设备上行若无法降频，可通过 Kafka 这一缓冲层天然吸收；但消费侧若用无界队列且下游慢，则会内存溢出。正确做法是使用有界队列 + 拒绝策略 + consumer pause。Sentinel 的匀速排队（漏桶）适合平滑 MRV 尖峰。参考 Reactive Streams 规范（Publisher/Subscriber 的 request(n) 语义）。

**易错点**：使用无界 `LinkedBlockingQueue` 导致 OOM；限流只限入口不限消费，下游仍被冲垮；背压触发后未记录丢弃指标，造成碳数据"静默丢失"。

#### 追问：
- 追问1：令牌桶和漏桶在碳采集中如何选择？
  - **答**：入口突发允许用令牌桶（允许短时突发、贴合设备集中上报）；需要绝对平滑写入下游用漏桶（匀速器）。实践中网关用令牌桶、写库侧用漏桶，组合兼顾突发容忍与下游保护。
- 追问2：消费侧背压触发后，Kafka 会重复投递吗？
  - **答**：会。pause 期间未提交 offset，恢复后从上次位点重放。因此下游写入必须是幂等的，否则背压恢复会产生重复 MRV 记录。

### 3. 如何用线程池隔离"设备采集"与"碳核算计算"两类任务？
**重要度**：★★★★

**难度**：★★

**考点**：线程池隔离、资源隔离、避免相互拖累（舱壁模式）。

**参考答案**：采集 I/O 密集（网络收发、协议解析），核算 CPU/内存密集（因子匹配、LCA 模型计算），混用同一池会相互阻塞。采用舱壁模式：独立两个 `ThreadPoolExecutor`——采集池核心线程多、队列大；核算池根据 CPU 核数设线程数并配有界队列。两者异常隔离，核算 OOM/慢任务不影响采集上报，保障 MRV 数据不丢。

**深度解析**：线程池隔离源自 Hystrix 的舱壁（Bulkhead）模式。核心参数需按任务类型设定：I/O 密集型线程数可远大于核数（CPU 核数×2）；CPU 密集型约等于核数。拒绝策略对采集用 CallerRuns 或持久化到 Kafka 重放，对核算用丢弃+告警。结合 `ThreadPoolExecutor` 的 `allowCoreThreadTimeOut` 与监控（活跃线程、队列长度）做动态调优。

**易错点**：所有任务共用 `Executors.newFixedThreadPool` 默认无界队列；核算慢任务占满池导致采集线程饥饿；未在拒绝策略里记录可恢复上下文。

#### 追问：
- 追问1：虚拟线程能否替代这种隔离？
  - **答**：虚拟线程降低 I/O 阻塞成本，但 CPU 密集的核算仍应限制Platform线程并发数。JDK 21+ 可在采集用虚拟线程、核算用固定大小载体池，隔离思想不变，只是实现从池线程转向「虚拟线程 + 信号量限并发」。
- 追问2：核算线程池怎么防止单个重企业拖垮全局？
  - **答**：按 enterpriseId 做分桶或加 `Semaphore` 并发配额，限制单企业最大并发核算任务数，配合公平队列避免大客户饿死小客户。

### 4. 如何用 CompletableFuture 编排多源碳数据的并发核算？
**重要度**：★★★★

**难度**：★★

**考点**：CompletableFuture 编排、异步组合、异常兜底、超时控制。

**参考答案**：一笔碳核算需并行拉取能耗、物料、排放因子、LCA 模型等多源数据。用 `CompletableFuture.supplyAsync(..., exec)` 提交各源查询到核算线程池，`thenCombine`/`allOf` 汇聚，最后 `thenApply` 计算碳足迹。每个 future 配 `exceptionally` 兜底返回降级值（如用上一版本因子），并用 `orTimeout`/`completeOnTimeout` 防慢源拖死整体，保证碳管家 AI 助手在 SLA 内返回。

**深度解析**：`CompletableFuture` 基于 ForkJoinPool 或自定义 executor 实现非阻塞编排，`allOf` 等待全部完成但不聚合结果，需自行 `join` 各 future。`orTimeout`（JDK 9+）以超时异常中断慢源；注意 `join()` 抛出 `CompletionException` 需解包。应避免在默认 ForkJoinPool.commonPool 跑阻塞 I/O，必须传入隔离的核算 executor，否则影响 JVM 内其他并行流。

**易错点**：在 `thenApply` 里做阻塞调用阻塞载体线程；`get()` 不设超时导致线程永久挂起；异常只在最后 `join` 才暴露，中间 `exceptionally` 缺失造成结果缺字段却不报错。

#### 追问：
- 追问1：allOf 和 thenCombine 有什么区别？
  - **答**：thenCombine 两两组合并产出新结果，适合固定两源；allOf 等 N 个全部完成但本身不返回值，需手动取各 future 结果，适合多源（>2）汇聚。多源核算用 allOf 更清晰，但务必检查每个 future 是否异常完成。
- 追问2：降级因子会不会导致核算失真被审计质疑？
  - **答**：会。降级必须打标（dataQuality=DEGRADED）并写审计日志，报告侧显式提示"该笔使用上一版本因子估算"，符合 MRV 核查可追溯要求，不能静默替换。

### 5. 百万级产品碳足迹计算，何时选 Spark 而非纯 Java 批处理？
**重要度**：★★★★

**难度**：★★★

**考点**：批处理引擎选型、Java 批处理与分布式计算的取舍、碳足迹计算规模边界。

**参考答案**：单企业日级核算（万级 SKU）用 Java 多线程/Spring Batch 即可，延迟低、运维简单。当需对数亿条 LCA 清单、跨企业横向比对的百万级产品碳足迹做全量重算时，Java 单机受内存与算力限制，应上 Spark 做分布式批处理；对"近实时碳排看板"则用 Kafka Streams 流处理。积木 LCA 云对中小客户走 Java 批，集团级全量模型走 Spark。

**深度解析**：Spark 以 RDD/DataFrame 做内存迭代计算，Shuffle 与分区并行天然适合百万级因子矩阵乘法；流式场景另由 Kafka Streams 承接（见题15）。纯 Java 优势在于无集群运维、链路短、易调试，但扩展靠垂直扩容。经验法则：数据量 < 单机可用内存且 SLA 宽松用 Java；需弹性算力、容错重算、跨节点聚合用 Spark。参考 Spark Tuning Guide 的分区数 = 总核数×2~3。

**易错点**：小数据量强行上 Spark，集群调度开销抵消收益；忽视数据倾斜（某 SKU BOM 极深）导致长尾 task；Java 批处理用单线程循环，亿级数据跑数小时。

#### 追问：
- 追问1：Java 批处理如何逼近 Spark 的吞吐？
  - **答**：用分片（按 productId 取模）+ 线程池并行 + 堆外/列式存储 + 避免频繁 GC；对因子矩阵用本地缓存与向量化计算。仍受单机核数与内存上限约束，本质是「垂直扩展」。
- 追问2：积木LCA云为什么不全用 Kafka Streams 做实时？
  - **答**：LCA 计算是重模型（多层级 BOM 展开），实时流成本高且多数客户按日/月核算即可。Kafka Streams 仅用于「排放在线监测告警」这类轻量实时场景，重核算仍走批，符合成本与精度权衡。

### 6. Spring Batch 在碳核算批处理中如何组织 Job/Step？
**重要度**：★★★★

**难度**：★★

**考点**：Spring Batch 核心模型、Chunk 处理、Skip/Retry、可重启性。

**参考答案**：将一次碳核算建模为 `Job`，内部 `Step` 按"读 MRV 数据 → 匹配因子 → 计算碳足迹 → 写结果"串联。用 `ItemReader` 分片读时序库、`ItemProcessor` 做因子匹配与计算、`ItemWriter` 批量入库。配置 `chunk-size`（如 500）控制事务边界，`SkipPolicy` 跳过单条脏数据、`Retry` 重试因子库超时，`JobRepository` 持久化执行状态支持失败重启续跑。

**深度解析**：Spring Batch 通过 JobRepository（存 DB）记录 `BATCH_STEP_EXECUTION` 状态，使 Job 可重启且从断点继续（基于 `executionId`）。Chunk 模式把 N 条 item 打包在一事务内，平衡吞吐与回滚成本。Reader 用分页/游标避免全量加载 OOM。`FaultTolerantStepBuilder` 提供 skip/retry/rollback 精细策略。参考 Spring Batch 官方文档的「Chunk-Oriented Processing」模型。

**易错点**：chunk-size 过大导致单事务锁表久、回滚成本高；未配置 skip 策略使一条脏数据中断整批；Reader 未做游标分页，全量读入内存 OOM。

#### 追问：
- 追问1：Spring Batch 和多线程 Step 怎么配合？
  - **答**：可用 `TaskExecutor` 让 Step 多线程跑（parallel steps）或用 `PartitionStep` 把数据分片分发到多个 worker（本地或远程）。分片键按 enterpriseId 划分，保证同企业数据不被并发写冲突。
- 追问2：重启会不会重复计算已成功的 chunk？
  - **答**：不会，JobRepository 记录已提交 chunk 的 status=COMPLETED，重启从第一个未完成的 chunk 续跑；但下游写入必须幂等，防止重复提交同 chunk 产生重复结果。

### 7. 碳核算批处理如何保证幂等，避免重复计算导致数据不一致？
**重要度**：★★★★

**难度**：★★★

**考点**：批处理幂等、幂等键设计、状态机、去重与补偿。

**参考答案**：以 `(batchId, enterpriseId, productId, calcVersion, factorVersion)` 作为幂等键。每次核算先写「核算任务状态表」：PENDING→RUNNING→SUCCESS/FAILED（状态机）。写入结果前用幂等键 `INSERT ... ON CONFLICT DO NOTHING` 或先查后写（带版本）。任务重启时查询状态，SUCCESS 直接跳过，保证同批重复执行不产生双份碳足迹，审计口径一致。

**深度解析**：幂等本质是「相同输入多次执行得到相同且唯一结果」。状态机防止并发/重试导致 RUNNING 被覆盖；数据库唯一索引是最终防线。因子版本纳入键，保证因子更新后旧结果不被新批次误覆盖。对于已发布的核查报告，采用"新版本另存 + 旧版本保留不可变"而非覆盖更新，满足 MRV 不可篡改追溯。参考分布式系统幂等设计（唯一约束 + 乐观锁 version 字段）。

**易错点**：仅依赖应用层去重，未加 DB 唯一索引，并发下仍插入重复；幂等键漏掉 factorVersion，因子更新后算错历史；状态机缺少终态保护，重试覆盖已成功记录。

#### 追问：
- 追问1：状态机和唯一索引哪个更重要？
  - **答**：唯一索引是底线（防并发双写），状态机是流程约束（防逻辑错乱）。两者互补：索引保证存储唯一，状态机保证过程可见与可恢复，缺一不可。
- 追问2：已发布报告的数据还能被重算覆盖吗？
  - **答**：不能。已发布（PUBLISHED）状态进入不可变区，重算只能生成新版本并标记 superseded，旧版本保留供核查比对，符合碳数据审计可追溯要求。

### 8. 碳排放因子库如何做版本管理（更新、历史追溯、生效时间）？
**重要度**：★★★★

**难度**：★★★

**考点**：因子库版本模型、生效时间窗、时区与边界、历史可比性。

**参考答案**：因子表采用「生效时间 + 失效时间」双字段的渐变维（SCD Type 2）模型：`factorId, value, effectiveFrom, effectiveTo(null 表示当前)`。更新因子时旧行 `effectiveTo=now`，插入新行 `effectiveFrom=now`。核算时按数据发生时间 `t` 取 `effectiveFrom <= t < effectiveTo` 的版本，保证历史排放用当时因子、当期用新因子，跨年比对口径一致。

**深度解析**：这是典型的 Slowly Changing Dimension 处理。关键点：
  - ① 生效时间用 UTC 避免时区歧义，展示时按企业本地时区转换
  - ② 边界用半开区间 `[from, to)` 防重叠
  - ③ 因子变更需审批流（MRV 核查要求可追溯），变更记录写审计表
  - ④ 批量因子导入要校验生效时间不与现有区间冲突
  - 积木 LCA 云对外提供因子版本 API，调用方传 `asOf` 时间精确取数。

**易错点**：用 `effectiveTo` 闭区间导致边界日因子被算两次；更新时直接 UPDATE 覆盖旧值，丢失历史；时区处理错误导致跨日排放用错因子版本。

#### 追问：
- 追问1：因子突然修订（如发现算错），历史报告怎么处理？
  - **答**：不篡改已发布版本，新增「修订版」因子并标记 corrected，同时触发受影响批次的重算（生成新报告版本），旧版保留并标注「已被修订版取代」，审计链路可查。
- 追问2：渐变维会不会让因子表无限膨胀？
  - **答**：会，但因子更新频率低（年/季度级），膨胀可控。可加冷热分离：当前+近 N 年热存，更早归档到 OSS/历史库，查询时按需回载。

### 9. 如何用 CDC（Canal/Debezium）把因子变更同步到 ES 和 Milvus？
**重要度**：★★★★

**难度**：★★★

**考点**：CDC 原理、Binlog/WAL 解析、因子检索与向量检索同步、异构写入。

**参考答案**：因子库是 MySQL/PostgreSQL，因子更新经 Canal（MySQL binlog）或 Debezium（PG logical replication）捕获变更事件，发到 Kafka。下游消费者将变更写入 ES（供关键词/结构化检索，如按 `category+region` 查因子）与 Milvus（因子文本/描述做 Embedding 后存向量，支撑碳管家 AI 助手的语义检索"找相似排放因子"）。保证因子主库为唯一写源，ES/Milvus 为派生读副本。

**深度解析**：Canal 伪装成 MySQL 从库拉 binlog，Debezium 基于 PG 的 logical decoding 读 WAL，二者都把行级变更转为结构化 event（before/after）。写入 ES 用 upsert by factorId；写 Milvus 需先调 Embedding 模型把因子描述向量化再 insert/upsert（按 factorId 做主键保证幂等）。CDC 天然带 `op` 类型（c/u/d），delete 需同步删 ES/Milvus。参考 Debezium 官方文档的 event envelope 结构。

**易错点**：Embedding 调用是网络 I/O，同步 consumer 里直接调用会拖慢整个 CDC 管道；delete 事件未处理导致 ES/Milvus 残留脏因子；未用 factorId 做目标主键，重复 upsert 产生重复向量。

#### 追问：
- 追问1：Embedding 调用放在 CDC 同步链里会不会阻塞？
  - **答**：会。应将 Embedding 调用异步化（发到独立 Embedding 任务队列或用虚拟线程），或用「先写原文到 ES，向量化走异步 Job 补写 Milvus」，解耦变更捕获与重计算，保证 CDC 管道高吞吐。
- 追问2：Canal 和 Debezium 怎么选？
  - **答**：MySQL 且只需简单订阅选 Canal（部署轻、国内生态成熟）；多源（PG/Oracle/MySQL）且要 exactly-once、schema 演进、Kafka Connect 集成选 Debezium，生态更标准。

### 10. CDC 同步到 ES/Milvus 如何保证最终一致与对账？
**重要度**：★★★★

**难度**：★★★

**考点**：最终一致性、对账 Job、乱序与丢失补偿、延迟监控。

**参考答案**：CDC 是异步链路，存在秒级延迟与极端丢事件可能，需最终一致保障。方案：
  - ① 写 ES/Milvus 时带 `updatedAt` 版本号，仅当新事件版本更高才应用（防乱序覆盖）
  - ② 定时对账 Job 扫因子主库，与 ES/Milvus 按 `updatedAt`/`checksum` 比对，差异则补偿修复
  - ③ 监控 CDC lag，超阈值告警
  - 碳管家 AI 助手检索因子时优先信任主库核对关键结果。

**深度解析**：最终一致指"无新写入后，副本收敛到主库状态"。乱序来自 Kafka 分区重平衡或重试，用单调递增版本号（或 binlog 位点/时间戳）做条件更新可消歧。对账 Job 是兜底，按 `factorId` 分批比对 checksum，修复量应极小；若长期大量差异说明管道故障。参考 CAP 理论：分区下选 AP + 最终一致，用对账补强一致性。

**易错点**：对账 Job 全表扫拖垮主库；版本号用本地时钟导致跨机乱序误判；只监控有无事件不监控 lag，延迟 hours 才发现。

#### 追问：
- 追问1：对账 Job 怎么做才不拖垮主库？
  - **答**：按 factorId 范围分片、限速（每次限 N 条+sleep）、走从库读；用上次对账的最大 updatedAt 做增量扫描，仅比对变更区间，避免全表。
- 追问2：AI 助手检索到陈旧因子怎么兜底？
  - **答**：检索结果带因子 updatedAt 与来源标记；对核查级场景回查主库校验版本，非核查级展示时提示"数据同步时间"，并优先返回最新生效版本。

### 11. 碳数据质量校验怎么做：异常值、缺失值、单位归一？
**重要度**：★★★

**难度**：★★

**考点**：数据质量规则、单位归一化、缺失与异常处理、MRV 数据可信度。

**参考答案**：采集入库前做三层校验：
  - ① 单位归一——把 kWh、MJ、tce 等统一换算到标准单位（如 kgCO₂e 对应的能量基准），用单位换算表 + 维度校验
  - ② 异常值——用统计法（3σ/箱线图）或业务阈值（如单设备瞬时功率超额定 3 倍）标记异常
  - ③ 缺失值——按设备上报频率检测断点，缺失用插值/上一周期/标记为估算并打标
  - 异常数据进「待核查队列」不进正式核算。

**深度解析**：单位归一需维护「单位维度表」（基本量纲：能量/质量/体积 + 换算系数），换算时校验量纲一致防止 kg 当 kWh 用。异常检测分统计与业务两类，业务阈值更可靠（如排放不可能为负）。缺失处理要区分「真缺失」与「设备离线」，后者应告警而非静默填充。所有质量动作写 `data_quality` 标记，报告侧可追溯。参考 GB/T 32150 等对数据质量的合规性要求。

**易错点**：单位换算漏掉温度/压力修正（如气体体积标况换算）；异常值直接删除导致总量偏低；用均值填充掩盖设备真实停机。

#### 追问：
- 追问1：负数排放值一定异常吗？
  - **答**：多数场景是异常（如碳汇/抵消项可负，但需单独科目）。普通能耗排放为负必为异常（表计反转/采集错误），应隔离核查，不应直接置零。
- 追问2：单位换算表怎么防错？
  - **答**：换算表受版本管理 + 审批，换算逻辑用维度量纲校验（能量→能量才合法），上线前用已知样例回归测试，关键路径加双写比对。

### 12. 海量因子与设备时序数据如何存储与分区？
**重要度**：★★★

**难度**：★★★

**考点**：时序库选型、分区策略、冷热分离、因子库与时序库职责划分。

**参考答案**：MRV 时序数据（设备高频采样）用时序库（TDengine/InfluxDB/TimescaleDB），按 `deviceId + 时间` 分区 + 按天/月分片，配合降采样（原始 1s→1m→1h 聚合）控成本。碳排放因子属低频维度数据，存关系库（MySQL）走 SCD 版本管理，热因子缓存 Redis。积木 LCA 云将「原始时序」与「聚合指标」分层，查询按时间范围路由到对应粒度。

**深度解析**：时序库针对 append-only、按时间范围查询优化，TTL 自动过期原始数据；降采样用连续聚合（TimescaleDB CAGG）或流式预聚合降低存储与查询压力。分区键选设备+时间可让单设备查询局部化；避免按企业大分区导致热点。因子库放关系库因其需事务、版本、关联查询，不宜进时序库。参考时序数据库 Benchmark（TSBS）的写入/查询模式结论。

**易错点**：时序库未设 TTL 导致存储爆炸；降采样在查询时实时算拖慢看板；因子与时序混库，版本管理复杂化。

#### 追问：
- 追问1：TDengine 和 TimescaleDB 怎么选？
  - **答**：TDengine 单机写入极高、运维轻，适合设备量大且以设备为中心的场景；TimescaleDB 基于 PG、SQL 生态完整、易与因子库联合查询，适合需复杂关联分析的团队。
- 追问2：降采样丢失细节被审计质疑怎么办？
  - **答**：原始数据按合规期（如 5 年）保留在冷存/对象存储，降采样仅服务看板；核查时可回载原始重算，保留「原始+聚合」双轨可追溯。

### 13. 虚拟线程（JDK 21+）在碳批处理中如何加速 I/O 密集的 Embedding 调用？
**重要度**：★★★★★

**难度**：★★★

**考点**：虚拟线程原理、与平台线程区别、I/O 密集场景收益、pinned 风险。

**参考答案**：碳核算中调用 Embedding 模型把因子/清单文本向量化是典型 I/O 阻塞（网络 RPC）。JDK 21+ 用虚拟线程 `Thread.ofVirtual().start(...)` 或 `Executors.newVirtualThreadPerTaskExecutor()`，每个调用一个虚拟线程，底层载体（载体线程）在阻塞时自动让出，使少量平台线程支撑海量并发 Embedding 请求，批处理吞吐大幅提升，且代码仍是直观的同步写法。

**深度解析**：虚拟线程是 JVM 托管轻量线程，`park` 时释放载体线程（carrier）去跑其他虚拟线程，消除「一请求一平台线程」的内存与调度开销。关键风险是「pinned」：在 `synchronized` 块或 native 调用中阻塞会使载体线程无法让出（JDK 21 仍有局限，JDK 24 已缓解）。故 Embedding 调用应避免 `synchronized`、用 `ReentrantLock`，且不要在虚拟线程里跑长 CPU 密集任务。参考 JEP 444。

**易错点**：在虚拟线程内用 `synchronized` 包裹阻塞 RPC 导致载体被 pin，并发退化；把重 CPU 的因子计算放进虚拟线程，反而无收益且争抢载体；线程池又包一层虚拟线程（多余）。

#### 追问：
- 追问1：虚拟线程能替代核算的 CPU 密集并行吗？
  - **答**：不能。虚拟线程只为 I/O 阻塞降本，CPU 密集仍受载体线程数（≈核数）限制，应限制并发或用普通线程池，否则频繁的载体切换反而拖累。
- 追问2：怎么判断 Embedding 调用是否发生 pin？
  - **答**：JDK 21 开启 `-Djdk.tracePinnedThreads=full`，日志会打印 pin 的堆栈；改用 ReentrantLock 替换 synchronized、缩小临界区即可消除，提升载体利用率。

### 14. 碳数据采集网关如何设计高可用与故障转移？
**重要度**：★★★★

**难度**：★★

**考点**：采集网关高可用、Kafka 多副本、设备端重传、数据零丢失。

**参考答案**：网关无状态多实例部署，前置 LB；写入 Kafka 用 `acks=all` + 多副本（replication.factor≥3）保证 broker 故障不丢消息。设备端上报带 `seq` 与本地缓存，网关不可达时设备暂存并按指数退避重传。消费侧用消费者组自动 rebalance 接管故障实例分区。全链路以"至少一次 + 幂等去重"保 MRV 数据不丢不错。

**深度解析**：`acks=all` 需配合 min.insync.replicas≥2，防止单副本写入即确认却在副本同步前宕机丢数据。网关无状态使其可水平扩容；设备端重传需有上限与死信（超限转人工/文件补录）。消费端 enable.auto.commit=false，处理成功再手动提交，避免"提交了但没处理完"的丢失。参考 Kafka 的 durability 配置矩阵。

**易错点**：acks=1 看似快但 leader 宕机丢数据；自动提交 offset 导致消费失败却已提交；设备端无重传上限造成存储雪崩。

#### 追问：
- 追问1：broker 全部重启期间设备数据怎么办？
  - **答**：设备端断网缓存（环形缓冲/本地文件），恢复后补传；网关层也短暂缓存。Kafka 恢复后立即重放，靠幂等键去重，保证采集连续性。
- 追问2：消费实例宕机，正在处理的 chunk 会重复吗？
  - **答**：会。未提交 offset 的分区由 rebalance 分配给其他实例重放，故下游写入必须幂等（见[第 7 题](/30-carbon-data-platform.html#q-34-7)），重复处理不产生双份结果。

### 15. Kafka Streams 与 Spring Batch 在碳场景如何取舍？
**重要度**：★★★

**难度**：★★★

**考点**：流处理 vs 批处理边界、窗口计算、精确一次、适用场景。

**参考答案**：实时排放看板、阈值告警、设备异常实时检测用 Kafka Streams（事件时间窗口 + 状态存储，低延迟，事务保证 exactly-once）；日/月级碳核算、因子版本比对、百万产品碳足迹全量重算用 Spring Batch/Spark（高吞吐、可重跑、易审计）。积木 LCA 云「在线监测告警」走 Kafka Streams，「月度核算报告」走 Spring Batch。二者通过 Kafka 衔接：Kafka Streams 出实时指标，Batch 出权威核算。

**深度解析**：Kafka Streams 优势在流式状态管理（状态存储与 changelog 主题）与 exactly-once（`processing.guarantee=exactly_once_v2`，事务原子提交 offset+状态），适合"持续、低延迟、有状态"，且嵌入 Java 应用无需独立集群；Spring Batch 优势在"有界、可重启、强事务边界、易合规审计"。误用 Kafka Streams 做重批会成本高且难重跑，误用 Batch 做实时则延迟大。经验：看 SLA——秒级用 Kafka Streams，分钟~天级用 Batch/Spark。（对照：独立 Flink 集群亦可做流批一体，但需运维额外集群，碳管家选 Kafka Streams 取其轻量。）

**易错点**：把重 LCA 模型塞进 Kafka Streams 流，单条处理慢拖垮窗口；Batch 硬做实时看板导致频繁全量扫描；两套结果口径不一致且无对账。

#### 追问：
- 追问1：两套系统结果不一致怎么核对？
  - **答**：以 Batch 权威核算为准，Kafka Streams 实时值仅作预警；定时对账 Job 比较二者在重叠窗口的聚合差，超阈值告警并定位（因子版本/时间窗边界差异）。
- 追问2：Kafka Streams 的 exactly-once 对碳数据意味着什么？
  - **答**：意味着每条排放事件在 Sink（如 ES）恰好生效一次，事务提交时 offset 与状态变更原子落盘，故障恢复不重复不丢失，保障实时碳排总量准确，但要求 Sink 支持事务/幂等写入。

### 16. Kafka 分区重均衡（rebalance）对碳数据采集有何影响，如何减小？
**重要度**：★★★

**难度**：★★

**考点**：consumer rebalance 机制、消费停顿、静态成员资格、sticky 分配。

**参考答案**：消费者组扩缩容、实例宕机、心跳超时会触发 rebalance，期间全组暂停消费（stop-the-world），正在处理的 MRV 数据需重放，造成采集延迟尖峰。缓解：开启「静态成员资格」（`group.instance.id`）避免临时重启触发全员重平衡；用 `CooperativeStickyAssignor` 增量再均衡只迁移必要分区；调大 `session.timeout` / `heartbeat` 容错瞬时抖动；处理幂等兜底重放。

**深度解析**：rebalance 本质是重新分配分区所有权，旧协议（eager）会撤销所有分区再分配（全停顿）；增量协作协议（Cooperative Sticky）只动受影响分区，停顿大幅缩短。静态成员让重启的实例保留原 assignment，组员变更才重平衡。参考 KIP-345（静态成员）与 KIP-429（增量协作再均衡）。下游幂等保证重放不产生重复碳数据。

**易错点**：session.timeout 设太短导致网络抖动频繁 rebalance；用默认 RangeAssignor 在扩缩容时大面积迁移；重平衡期间未暂停写库导致重复（依赖幂等补救）。

#### 追问：
- 追问1：消费处理逻辑很慢会诱发 rebalance 吗？
  - **答**：会。若处理超过 max.poll.interval.ms 未 poll，协调器认为实例死掉触发 rebalance。应调大该值或把重处理异步化、主线程及时 poll，避免被误判离线。
- 追问2：增量再均衡就完全无停顿吗？
  - **答**：不是完全无，但仅受影响的少数分区暂停，全局消费基本连续，停顿从「全组秒级」降到「单分区亚秒级」，对碳采集尖峰影响小得多。

### 17. 碳管家 AI 助手接入多源碳数据时，如何保证数据一致性与可追溯？
**重要度**：★★★★

**难度**：★★

**考点**：AI 助手数据接入、多源一致性、引用溯源、幻觉防控。

**参考答案**：碳管家 AI 助手回答依赖三类源：实时因子（ES/Milvus）、核算结果（关系库）、文档知识（向量库）。每次检索统一带 `sourceId + version + asOf` 溯源标记，回答中附引用链接，防止"无来源结论"。多源冲突时以主库/已发布报告为准，AI 仅做聚合不擅自修正数值。关键核查问题回查主库校验，降低幻觉与口径错误。

**深度解析**：RAG（检索增强）系统须把「数据出处」作为一等公民。因子经 CDC 同步存在延迟，AI 回答应展示数据同步时间；核算结果来自 Batch 且带 calcVersion，可追溯。设计上采用「检索→校验→生成」三段：先取带版本的数据，再用规则校验数值合理区间，最后 LLM 组织语言并强制输出引用。参考 LLM 应用中 citation/grounding 最佳实践以降低幻觉。

**易错点**：AI 直接基于向量相似度最高的因子回答，忽略版本与生效时间；回答不含引用，核查时无法溯源；把估算值当权威值输出致误判。

#### 追问：
- 追问1：AI 给出的排放建议若算错谁担责？
  - **答**：AI 仅辅助，最终核查由人/系统复核。设计上 AI 输出须可审计（输入、检索源、版本全留痕），关键动作需人工确认，平台在免责声明与审计日志中明确责任边界。
- 追问2：如何防止 AI 用错版本因子？
  - **答**：检索请求强制带 asOf 时间，向量/ES 查询过滤 effectiveFrom/To 与 updatedAt，返回结果带版本号；生成层 prompt 要求"仅使用提供的数据，不得外推"，并附来源链接。

### 18. 积木 LCA 云对批量 LCA 计算如何做幂等与重试？
**重要度**：★★★★

**难度**：★★★

**考点**：LCA 批量计算、任务分片、幂等键、失败重试与补偿、长任务可观测。

**参考答案**：一次企业级 LCA 计算拆为「产品树展开 → 清单收集 → 因子匹配 → 影响评价」多 Step，按 productId 分片并行。每个产品计算任务用 `(taskId, productId, bomVersion, factorVersion)` 幂等键，结果写「计算任务表」状态机（PENDING→RUNNING→DONE/FAILED）。失败按因子库超时/数据缺失分类重试（超时重试、缺失进待补录不重试），超时任务用看门狗取消并释放资源，避免长尾拖累整批。

**深度解析**：LCA 计算重且树深，单产品失败不应中断整批，故用 per-product 隔离 + Skip/Retry。幂等键含 bomVersion 与 factorVersion，保证 BOM 或因子变更后旧结果不被误覆盖，且同输入重跑得同结果。长任务用「心跳 + 最大执行时长」防卡死；重试用指数退避并设上限，超上限转人工。参考 Spring Batch 的 `SkipPolicy`/`RetryTemplate` 与幂等任务表模式。

**易错点**：整批共享一个事务，单产品失败回滚全部；重试无差别导致"数据缺失"类错误无限重试；幂等键漏 bomVersion，BOM 修订后算错历史。

#### 追问：
- 追问1：BOM 树极深导致单产品算几小时怎么办？
  - **答**：对深层 BOM 做层级缓存（中间节点碳足迹缓存复用），或限制展开深度+近似聚合；超阈值任务拆分更细子任务并行，并用看门狗超时保护，避免占满核算池。
- 追问2：重试成功后之前的部分结果怎么处理？
  - **答**：因幂等键唯一，重试写入会 upsert 覆盖旧部分结果，状态机置 DONE；下游读取以最终 DONE 版本为准，中间失败态不对外暴露，保证对外口径一致。


---


### 19. 用 StructuredTaskScope 编排「多因子库并发查询 + 任一失败全取消」，租户上下文怎么传？
**重要度**：★★★★★

**难度**：★★★

**考点**：结构化并发（StructuredTaskScope）、故障传播与取消、ScopedValue 传递租户上下文、与 ThreadLocal 的取舍。

> **本题与第 13 题的区别**：第 13 题讲"怎么避免 synchronized 钉住载体线程"，是**单任务跑得快**的问题；本题讲"多个子任务怎么编排、失败怎么整体取消、上下文怎么跟着走"，是**任务结构**的问题。两题的 API（虚拟线程）相同，解法层次不同。

**参考答案**：碳足迹核算要同时查电力、物料、运输三个因子库，三者互不依赖、缺一不可——这是结构化并发的典型场景。用 `StructuredTaskScope.ShutdownOnFailure`：每个因子库 `scope.fork()` 一个子任务（内部是虚拟线程），`scope.join()` 等全部结束，`throwIfFailed()` 一旦任一失败就抛出，其余子任务在 scope 关闭时被自动取消，不会留下"野线程"和半个结果集。租户上下文用 `ScopedValue` 而不是 `ThreadLocal`：`ScopedValue.where(TENANT, tenantId).call(() -> {...})` 绑定在作用域上，`fork()` 出的子任务**自动继承**，作用域结束自动解绑，不需要 `remove()`，也不会因为载体线程复用而把 A 租户的 tenantId 带给 B 租户。

```java
static final ScopedValue<String> TENANT = ScopedValue.newInstance();

public FactorBundle queryAll(String tenantId, String productId) throws Exception {
    // 绑定只在本次调用期间有效；fork 出的子任务自动继承该绑定
    return ScopedValue.where(TENANT, tenantId).call(() -> {
        try (var scope = new StructuredTaskScope.ShutdownOnFailure()) {
            Subtask<FactorSet> elec  = scope.fork(() -> elecRepo.find(productId));  // 电力因子库
            Subtask<FactorSet> mat    = scope.fork(() -> matRepo.find(productId));   // 物料因子库
            Subtask<FactorSet> trans  = scope.fork(() -> tranRepo.find(productId));  // 运输因子库

            scope.join();           // 等全部完成，或任一失败后取消其余
            scope.throwIfFailed();  // 有失败就抛，绝不静默返回半个结果

            // 子任务内部 TENANT.get() 拿到的就是本次绑定的 tenantId
            return merge(elec.get(), mat.get(), trans.get());
        }
    });
}
```

**深度解析**：结构化并发把"fork 出的子任务"的生命周期约束在词法作用域内——`try` 块退出前必须所有子任务结束（要么完成、要么被取消），因此不会泄漏线程、也不会出现"父任务已返回、子任务还在写库"的悬挂。`ShutdownOnFailure` 的语义是：任一子任务抛异常 → 立刻取消其余子任务（本质是 interrupt 虚拟线程，阻塞中的 `park` 会响应）→ `join()` 返回 → `throwIfFailed()` 解包并抛出原始异常。`ScopedValue` 与 `ThreadLocal` 的关键差异：① 不可变，只能在 `where()` 里绑定，作用域内无法 `set`，天然线程安全；② 绑定跟着**作用域**走而非跟着线程走，配合结构化并发自动继承到子任务；③ 无生命周期泄漏问题，不需要 `remove()`，平台线程被复用时不会串数据。

- **版本门槛要答准**：`StructuredTaskScope` 自 JDK 21 起是 **preview**（JEP 453），到 JDK 25 仍是 preview（JEP 505，改用 `StructuredTaskScope.open(Joiner)`，`ShutdownOnFailure`/`ShutdownOnSuccess` 标记为 deprecated），跑代码要 `--enable-preview`；`ScopedValue` 在 **JDK 25 转正**（JEP 506），之前是 preview。面试里把这两个的"转正/预览"状态说混是常见扣分点。
- **和 pin 的关系**：`fork()` 出来的也是虚拟线程，所以第 13 题的结论依然成立——子任务里别用 `synchronized` 包阻塞 RPC，否则载体线程照样被钉住，"结构化"解决了编排，解决不了 pin。
- **不适合的场景**：子任务之间需要流水线式传递中间结果（A 的输出是 B 的输入）时，`fork/join` 的"一次分叉一次汇合"表达不了，应改用 `CompletableFuture` 链或显式队列。

**易错点**：用普通 `ExecutorService.submit()` 起子任务——不在结构化作用域内，`ScopedValue` 绑定丢失、失败也不会联动取消；`join()` 后忘记 `throwIfFailed()`，异常被子任务吞掉，`subtask.get()` 直接抛 `IllegalStateException` 或拿到半成品；在 `scope` 关闭后还去 `get()` 结果；把重 CPU 的因子计算也丢进 `fork()`，白占载体线程。

#### 追问：
- 追问1：`ShutdownOnFailure` 和 `ShutdownOnSuccess` 分别适合什么场景？要做"3 秒内拿到最快可用结果"该怎么写？
  - **答**：`ShutdownOnFailure` 是"全都要"——任一失败就整体失败（多因子库联合查询，缺一个就算不出来），`ShutdownOnSuccess` 是"要一个就行"——任一成功就取消其余（多副本/多模型赛马、主备因子源）。
    - 超时场景：`scope.joinUntil(Instant.now().plusSeconds(3))`，超时抛 `TimeoutException`，`try-with-resources` 关闭 scope 时自动取消所有未完成子任务。
    - 赛马场景：`ShutdownOnSuccess` + `scope.result()` 直接取第一个成功结果，其余被取消，省掉手工 `invokeAny` 的线程池管理。
- 追问2：`ScopedValue` 不能在作用域内 `set`，那"跨租户汇总"（一次请求要读多个租户的数据）怎么写？
  - **答**：用嵌套绑定而不是修改——`ScopedValue.where(TENANT, "A").call(() -> ...)` 内部再 `ScopedValue.where(TENANT, "B").call(() -> ...)`，内层覆盖外层、退出内层自动恢复外层，语义清晰且不可变。
    - 若租户是"数据维度"而非"执行身份"，更好的做法是把 `tenantId` 变成方法参数（显式传参），上下文只承载"当前操作者"，避免一个作用域里出现多个身份。
    - 禁止用 `ThreadLocal.set()` 模拟——那等于把可变状态又请回来，虚拟线程 + 线程池复用下必串数据。
- 追问3：这套编排上线后，怎么证明"失败真的全取消了"而不是各跑各的？
  - **答**：埋点三个指标：`fork` 数、`cancel` 数、scope 存活的 P99 时长；构造一个必然超时的因子库做故障注入，断言另外两个子任务的日志在失败后不再有新输出，且总耗时≈最慢成功源而非三者之和。
    - 再断言 `ScopedValue` 绑定：在子任务日志里打 `TENANT.get()`，压测时校验无跨租户串值（这是虚拟线程 + 上下文最容易出的隐性 bug）。

### 20. 碳因子检索中 MySQL 全文、Elasticsearch、Milvus 三者职责如何划分？
**重要度**：★★★★

**难度**：★★

**考点**：检索场景选型、向量检索与文本检索边界、职责单一化、碳因子元数据与语义检索协同。

**参考答案**：MySQL（普通二级/B+ 树索引、唯一索引）负责按因子编码、行业分类的精确等值查询——**FULLTEXT 是分词 + 相关性排序的倒排检索，不是精确匹配**，只在不引入 ES 时做轻量关键词兜底；ES 负责海量碳因子文本的多维过滤与关键词检索（分页、聚合统计）；Milvus 负责语义相似因子召回（LCA 过程名称向量近邻搜索）。三者按「精确 / 关键词 / 语义」分层，避免用 MySQL 扛模糊语义、用 Milvus 扛精确过滤。

**深度解析**：碳因子数据有强结构化属性（来源、年份、地区），精确查询走 MySQL 保证事务一致；ES 的倒排索引适合 `match` 模糊与复合过滤；Milvus 的 ANN（HNSW/IVF）适合「相似排放过程」推荐。混合检索可在应用层融合：先 ES 过滤候选集，再 Milvus 按向量重排，降低向量库压力。

**易错点**：把全部检索压到 Milvus，缺失结构化过滤能力；用 MySQL `LIKE` 做全文，性能随数据量骤降；忽视三库数据一致性导致「查得到但算出来是旧因子」。

#### 追问：
- 追问1：三库数据一致性如何保障？
  - **答**：以 MySQL 为源，通过 CDC（如 Canal）捕获变更，异步同步到 ES 与 Milvus，保证最终一致；并对账任务定时校验向量库与关系库因子版本号，发现漂移即重推。
- 追问2：为什么不让 Milvus 直接做精确过滤？
  - **答**：Milvus 的标量过滤能力弱于 ES，且其 ANN 返回的是近似 TopK，无法做 `group by`、范围聚合等关系运算；强行使用会降低召回精度并增加资源开销。

### 21. 用 Seata AT 模式保证「碳报告生成 + 配额扣减」跨服务一致，原理与局限？
**重要度**：★★★★

**难度**：★★★

**考点**：Seata AT 两阶段、undo_log 回滚、全局锁、跨微服务事务边界、碳配额一致性。

**参考答案**：在「生成碳报告」与「扣减 AI 配额」两个微服务间加 `@GlobalTransactional`。Seata AT 一阶段执行业务 SQL 同时记录 `undo_log` 与 `before/after` 镜像，并加全局锁；二阶段 TC 通知提交则异步清 undo_log，通知回滚则按镜像反向补偿。这样报告生成失败时配额自动回补，避免「扣了配额却没报告」。

**深度解析**：AT 基于数据源代理（`DataSourceProxy`）解析 SQL 生成回滚日志，对业务侵入低。但全局锁在高并发扣减场景可能成为热点，且要求各库有 `undo_log` 表、网络分区时可能悬挂。相比 TCC，AT 无需手写补偿，但牺牲了「预留资源」的强隔离。参考 Seata 1.x 官方文档 AT 模式。

**易错点**：在 AT 事务内混用本地事务与 RPC 导致 undo_log 与业务不一致；热点配额行加全局锁引发长事务阻塞；忘记建 `undo_log` 表。

#### 追问：
- 追问1：AT 与 TCC 在这个场景怎么选？
  - **答**：若配额扣减需要「先冻结再确认」的强隔离（防超发），TCC 更合适；若追求低侵入、可容忍最终一致，AT 足够。报告生成属长任务，常配合 TCC 的 Try 预留配额。
- 追问2：AT 模式回滚失败怎么办？
  - **答**：TC 会重试回滚；`undo_log` 含 `xid` 与 `branchId`，幂等重试安全。极端脏写需人工介入，因此生产应配监控告警与定期 `undo_log` 清理。

### 22. 用 TCC 三阶段实现碳配额扣减，如何处理空回滚、防悬挂、幂等？
**重要度**：★★★★

**难度**：★★★

**考点**：TCC Try-Confirm-Cancel、空回滚、防悬挂、幂等控制、配额冻结语义。

**参考答案**：Try 阶段冻结配额（金额置冻结字段而非直接扣减）；Confirm 真正扣减并清冻结；Cancel 释放冻结。空回滚：Cancel 先于 Try 到达（Try 网络失败），需识别「无 Try 记录」跳过补偿。防悬挂：Try 在网络恢复后迟到到达，需记已回滚标记拒绝执行。幂等：每阶段以 `branchId`/`actionId` 落库标记，重复调用直接返回。

**深度解析**：TCC 核心难点在异常顺序。标准做法是维护「事务动作记录表」：Try 写入 `status=TRYING`；Cancel 若查无记录则写 `status=CANCELLED` 并空回滚；若发现 `status=CANCELLED` 再收到 Try 则直接拒绝（防悬挂）。Confirm/Cancel 均以 `actionId` 唯一约束保证幂等。参考《Seata TCC 防悬挂设计》与 Alibaba TCC 规范。

**易错点**：Cancel 不空回滚导致误释放；Try 迟到造成配额被冻结却不解除（悬挂）；Confirm 未幂等致重复扣减。

#### 追问：
- 追问1：为什么不直接在 Try 里扣减而要先冻结？
  - **答**：直接扣减则 Confirm 时无法区分「已扣」与「未扣」，Cancel 也难回补；冻结把「预留」与「提交」分离，使 Confirm/Cancel 语义清晰且可幂等重入。
- 追问2：actionId 如何生成保证全局唯一？
  - **答**：由 `xid + branchId + actionName` 组合，或业务侧用 `userId + quotaType + 全局事务号` 拼成唯一键，配合数据库唯一索引实现天然幂等。

### 23. 用 Redis + Lua 做碳配额原子扣减防超发，脚本怎么写？
**重要度**：★★★★

**难度**：★★★

**考点**：Redis Lua 原子性、EVAL 脚本、分布式扣减、防超发、返回值设计。

**参考答案**：用一段 Lua 脚本在 Redis 单线程内完成「读取余额→判断≥扣减量→扣减/返回失败」，保证原子。脚本先 `GET quota:{tenant}:{userId}`，若 `tonumber(balance) >= cost` 则 `DECRBY` 并返回 1，否则返回 0。客户端据返回值决定放行或拒绝，杜绝 `GET` 与 `DECR` 间的竞态超发。

**深度解析**：Redis 执行 Lua 期间阻塞其他命令，因此「判断+扣减」不可拆分，比「先 GET 再 DECRBY」安全。需设 Key 过期或初始化防止冷启动无值；扣减失败不落库，由业务层走配额不足流程。注意 Lua 内不可用非确定性命令（如 `TIME` 部分场景），且脚本不宜过长以免阻塞。

**易错点**：用 `INCRBY` 配合应用层判断导致「读后写」竞态超发；Lua 返回字符串与数字混用致客户端解析错误；未处理 Key 不存在导致首次必失败。

#### 追问：
- 追问1：扣减后如何与 MySQL 配额对账？
  - **答**：Redis 作高速扣减层，MySQL 作权威账本；异步将扣减事件发 MQ，消费者更新 MySQL 余额，定时任务比对 Redis 与 MySQL 差异，差异超阈值告警并补偿。
- 追问2：多 Redis 分片下 Lua 还能原子吗？
  - **答**：Lua 仅单实例/单 slot 原子；若配额 Key 被 hash 到不同 slot，需用 Hash Tag（如 `{tenant}` 包裹）保证同槽，或改用 Redis Cluster 的 transaction 局限方案，否则需上层加分布式锁。

### 24. 单机 AtomicInteger/LongAdder 方案与 Redis 分布式多实例方案如何取舍？
**重要度**：★★★

**难度**：★★

**考点**：单机并发计数 vs 分布式原子、LongAdder 高并发优化、分布式一致性、碳配额部署形态。

**参考答案**：若碳配额服务是单实例部署，用 `AtomicInteger`（低竞争）或 `LongAdder`（高并发写，减少 CAS 争用）即可保证原子扣减。但配额服务通常多实例横向扩展，JVM 内计数不共享，必须用 Redis/数据库等集中存储。LongAdder 通过分片 Cell 降低热点，但多线程读取 `sum()` 非瞬时一致，不适合「精确余额」场景。

**深度解析**：`AtomicInteger` 高并发下 CAS 自旋开销大；`LongAdder` 把计数分散到多个 Cell，写快但 `sum()` 是快照和。二者皆仅限单 JVM。分布式下 Redis Lua 或数据库 `UPDATE ... SET balance=balance-cost WHERE balance>=cost` 行锁才是正确方案。参考 JUC 源码 `Striped64`。

**易错点**：多实例仍用 `AtomicInteger` 导致各实例独立计数、总配额被放大超发；用 `LongAdder` 做余额判断致读到过期值。

#### 追问：
- 追问1：数据库行锁扣减和 Redis 比优缺点？
  - **答**：数据库 `WHERE balance>=cost` 强一致、无需对账，但 TPS 受限于单行锁与连接；Redis 吞吐高但需对账补账。配额量小且要求强一致可选 DB，高并发选 Redis+对账。
- 追问2：LongAdder 适合什么碳业务统计？
  - **答**：适合「近似实时计数」如当日调用次数监控、QPS 统计，不需精确余额；做配额扣减判定则不行，因 `sum()` 非原子读改。

### 25. 高并发碳数据采集网关如何限流保护后端？
**重要度**：★★★

**难度**：★★

**考点**：网关限流算法、令牌桶/漏桶、Sentinel 规则、碳数据上报峰值削峰。

**参考答案**：在 API 网关（Spring Cloud Gateway）层用令牌桶算法限流，对单租户/单设备维度设 QPS 阈值；超限返回 429。结合 Sentinel 做热点参数限流（如某工厂设备突发刷数）。限流值应低于后端碳核算服务容量，作为第一道保护，避免海量 IoT 上报直接击穿数据库。

**深度解析**：令牌桶允许短时突发（桶内积攒令牌），比漏桶更贴合 IoT 设备「定时批量上报」特征。Sentinel 支持 `flowRule` 按 QPS/线程数、链路、热点参数限流，并可降级（慢调用比例、异常比例）。网关层无状态易水平扩展，是限流首选位置。参考 Sentinel 1.8 流控文档。

**易错点**：限流维度选错（只限全局不限租户）致大租户挤占小租户；阈值设死不随容量调整；限流后无降级兜底返回友好提示。

#### 追问：
- 追问1：令牌桶和漏桶在碳上报场景差异？
  - **答**：漏桶强制恒定速率，设备突发批量会被丢弃或排队；令牌桶允突发，契合设备整点集中上报。碳采集多选令牌桶，兼顾平滑与突发吸收。
- 追问2：限流后数据丢失怎么办？
  - **答**：网关限流仅拦「超额」请求，客户端应实现退避重试；核心数据走 MQ 异步入队，网关只接「提交成功」不保证处理，由 MQ 削峰保证不丢。

### 26. 用 MQ 削峰填谷承接碳数据上报洪峰，如何保证不丢且有序？
**重要度**：★★★★

**难度**：★★★

**考点**：消息队列削峰、分区有序、幂等消费、碳数据最终一致、死信处理。

**参考答案**：设备上报先发到 Kafka/RocketMQ，网关快速返回 202；消费者按 `tenantId+deviceId` 路由到固定分区保证同一设备顺序，后端批量落库。生产端开 `acks=all` + 本地消息表防丢，消费端用「处理前写去重表」幂等。洪峰时消息堆积由消费者集群横向扩容消费，实现削峰填谷。

**深度解析**：Kafka 分区内有序，故用设备 ID 作 key 保序；RocketMQ 可借 `MessageGroup` 实现。可靠性靠「本地消息表 + 事务消息」或半同步复制。消费幂等用 `msgId` 或业务唯一键（如上报批次号）去重，避免重复落库导致碳数据翻倍。参考 RocketMQ 事务消息与 Kafka 精确一次语义（EOS）。

**易错点**：无分区 key 导致同设备数据乱序、累计值错误；消费失败不进死信致阻塞；重复消费未去重使碳排量虚高。

#### 追问：
- 追问1：消费跟不上堆积怎么处理？
  - **答**：监控 Lag，临时扩容消费者实例（Kafka 受分区数上限约束，需提前多分区）；或开启批量消费 + 异步刷库提升单实例吞吐，必要时降级非核心指标计算。
- 追问2：事务消息如何防止「库写成功但消息未发」？
  - **答**：用 RocketMQ 事务消息：半消息→本地事务→Commit/Rollback；Broker 回查未知状态，本地据消息表状态决定提交，保证「数据库与消息」最终一致。

### 27. 用舱壁隔离（Bulkhead）保护碳核算核心服务不被采集合并拖垮？
**重要度**：★★★★

**难度**：★★

**考点**：舱壁模式、Resilience4j Bulkhead、线程池隔离、服务自我保护、碳核算稳定性。

**参考答案**：碳核算（重 CPU/长耗时）与碳数据采集（高并发 I/O）共用线程池会互相影响。用 Resilience4j `Bulkhead` 对核算接口设独立信号量/线程池上限（如 20 并发），采集接口另设池。某接口被打满时只在自身舱内拒绝，不影响核算，实现故障隔离。

**深度解析**：Bulkhead 两种：`SemaphoreBulkhead`（限并发数，轻量）与 `ThreadPoolBulkhead`（隔离线程池，适合阻塞调用）。核算属 CPU 密集用信号量防过载；采集 I/O 密集用线程池隔离防止连接占满。配合 `TimeLimiter` 防慢调用堆积。参考 Resilience4j 官方 Bulkhead 指南与 Netflix Hystrix 舱壁思想。

**易错点**：所有接口共用默认池致采集洪峰占满线程、核算全超时；信号量舱壁未配超时仍可能堆积；隔离了线程却没隔离连接池。

#### 追问：
- 追问1：Bulkhead 与限流（Sentinel）区别？
  - **答**：限流按 QPS 控入口流量；Bulkhead 控并发占用资源数，防「慢请求堆积耗尽线程」。二者互补：网关限流挡峰值，舱壁保内部资源不被单类请求占满。
- 追问2：线程池舱壁如何设大小？
  - **答**：依任务类型与核数：CPU 密集≈核数，I/O 密集可放大（核数×期望并发因子）；结合压测确定，目标是满负载时拒绝新请求而非无限排队拖垮整体。

### 28. 碳报告生成异步化：提交即返回任务ID，后台生成，如何通知用户？
**重要度**：★★★★

**难度**：★★★

**考点**：异步任务编排、任务状态表、SSE 实时推送、回调通知、碳报告长耗时处理。

**参考答案**：前端提交生成请求，后端落 `report_task`（status=PROCESSING）并返 `taskId`，立刻响应。后台线程/Worker 计算（含因子检索、LCA 模型），进度写任务表。通知二选一：SSE 长连接由前端订阅 `/report/{taskId}/stream` 实时收进度；或完成后 Webhook 回调业务系统。用户也可轮询任务状态。

**深度解析**：SSE（Server-Sent Events）基于 HTTP 单向流，适合「服务端推进度」，比 WebSocket 轻、自带断线重连。后端用 `SseEmitter`（Spring）保持连接，进度变更 `send()`。任务表需含 `status/progress/result_url/error`，保证可查询与幂等重入。报告生成失败写 `FAILED` 并保留原因供排查。

**易错点**：任务表无状态机致重复生成；SSE 连接未设超时致连接泄漏；回调地址未鉴权被伪造；前端未处理断线重连丢进度。

#### 追问：
- 追问1：SSE 与 WebSocket 怎么选？
  - **答**：仅服务端单向推进度/结果用 SSE 更简单、自动重连；需双向交互（如用户中途改参数）才用 WebSocket。碳报告进度推 SSE 足够，省去全双工复杂度。
- 追问2：任务重复提交如何防？
  - **答**：以「租户+报告类型+参数哈希」做幂等键，提交前查无进行中任务则创建，否则返已有 taskId；Worker 取任务前用数据库行锁/Redis 标记防多实例重复执行。

### 29. 多租户碳数据如何用分表/分库做隔离？
**重要度**：★★★

**难度**：★★★

**考点**：多租户隔离策略、ShardingSphere 分片、租户路由、数据安全边界、碳数据合规。

**参考答案**：SaaS 碳管家按租户隔离：采用「共享库分表」——以 `tenant_id` 为分片键，用 ShardingSphere 把 `carbon_emission` 拆为 `carbon_emission_${tenant_id % 64}`。路由在 JDBC 层自动拼分片，SQL 无需改动。超大型租户可独立物理库（独立 datasource）。所有查询强制带 `tenant_id` 避免越权跨租户读。

**深度解析**：隔离三档——字段隔离（同表加 tenant_id，最省但易串）、分表/分库（隔离好、运维复杂）、独立部署（最强）。碳数据涉商业机密，常用分表+行级 `tenant_id` 双保险。ShardingSphere 的 `Hint` 或 `ShardingAlgorithm` 实现路由；注意跨租户聚合统计需单独汇总库。参考 ShardingSphere 5.x 多租户文档。

**易错点**：分片键选错（用 user_id 而非 tenant_id）致同租户数据散落；忘记强制 tenant_id 过滤致越权；跨分片 `JOIN`/`count` 性能崩。

#### 追问：
- 追问1：分表后如何做跨租户统计？
  - **答**：建独立 OLAP 汇总库（如通过 CDC 同步到 StarRocks/ClickHouse），专跑跨租户聚合，避免在生产分表上跑重查询影响在线事务。
- 追问2：分表数量如何定？
  - **答**：按数据量与单表上限（建议≤500万行）估算，留 2–3 倍余量；过多分片增连接与元数据开销，建议 2 的幂（64/128）便于取模与后期再分。

### 30. Milvus collection 与 Redis key 前缀如何实现多租户碳向量隔离？
**重要度**：★★★★

**难度**：★★

**考点**：向量库多租户、Milvus partition/collection、Redis key 命名空间、向量检索隔离、碳因子租户边界。

**参考答案**：Milvus 中每个租户的碳因子向量可用独立 collection（强隔离）或同一 collection 下按 `tenant_id` 建 partition（轻量）。检索时用 `partition_names` 限定，避免跨租户召回。Redis 碳配额/缓存 Key 统一加 `tenant:{tenantId}:` 前缀，清除与统计按前缀批量操作，杜绝串租户。

**深度解析**：collection 隔离资源独占、权限清晰但数量受管控上限；partition 共享 schema、按租户过滤灵活，适合租户多且单租户数据量中等的 LCA 场景。Milvus 2.x 支持 `partition_key` 自动路由。Redis 前缀法简单，配合 `SCAN tenant:{id}:*` 做租户级清理。二者都依赖「写入即带租户标识」的纪律。

**易错点**：向量检索忘传 partition 致跨租户召回泄露因子；Redis 前缀拼错（漏分隔符）致 Key 冲突；清缓存用 `KEYS *` 阻塞生产。

#### 追问：
- 追问1：租户极多时 collection 爆炸怎么办？
  - **答**：改 partition 或字段过滤（在向量库元数据加 tenant_id，检索加 filter_expr），避免每租户一 collection；Milvus 用 `partition_key` 自动分片，兼顾隔离与规模。
- 追问2：Redis 批量删租户数据为什么不用 KEYS？
  - **答**：`KEYS` 全量遍历阻塞单线程实例，生产禁用；应 `SCAN` 游标分批删，或用 Redis 4.0+ 的 `UNLINK` 异步删（后台线程释放内存，不是 7.0 新特性；与 `FLUSHDB ASYNC` 同期提供），或把租户数据放独立 DB 编号整库清。

### 31. 分布式事务边界：碳核算为什么不能重复计算，如何用幂等键 + 去重表排除重试？
**重要度**：★★★

**难度**：★★★

**考点**：幂等设计、MQ 重试、分布式事务边界、重复计算风险、碳核算准确性。

**参考答案**：碳核算若因网络重试、消息重投被重复执行，同一笔排放会被多次计入，总碳量虚高，违背「不重复计算」原则。方案：每条核算任务带全局唯一 `bizKey`（如 `tenant+sourceId+period`），落库时靠「核算流水表」的 `bizKey` 唯一索引挡重，处理前先查「已核算表」，命中则直接返回已有结果。重试分两类处理：**读类**（查因子、查法规）天然幂等，可以放心重试；**写类**（核算落账、扣配额）不幂等，必须走"先占位（插入带唯一索引的流水行）→ 再执行 → 回写状态"的两段式，而不是靠调用方传一个开关来告诉框架"这次是重试"。

**深度解析**：可靠性不能建立在"上游保证不重发"上——MQ 的 at-least-once 语义、RPC 超时后的重试、人工补偿都可能造成重复投递，只能由消费侧用"唯一键 + 状态机"自证。幂等七字诀就是「唯一键 + 状态机」：唯一键（bizKey）保证同一业务事实只落一次，状态机（INIT → RUNNING → DONE/FAILED）保证重复请求要么短路返回、要么安全重入。Seata 的 TCC Cancel、RocketMQ 的重试消费同样依赖这个前提。注意 `idempotent` 不是 Seata / RocketMQ / Spring Retry 的既有参数（Spring Retry 的 `@Retryable` 并没有这个属性），写在代码里是自造开关、没人会读它，真正的幂等要靠数据库约束兜底。

**易错点**：指望调用方传标记来区分"重试/首调"，而不是靠唯一键；只靠上游「保证不重发」；`bizKey` 设计缺时间维度导致历史期被覆盖；用"先查后插"（check-then-act）而没有唯一索引兜底，并发下照样双写。

#### 追问：
- 追问1：这种幂等控制在框架层面具体怎么落地？
  - **答**：不靠注解开关，靠"落库时的一次原子插入"：
    - ① 消费/重试入口先 `INSERT INTO calc_flow(biz_key, status='RUNNING')`，`biz_key` 建唯一索引；插入冲突（DuplicateKey）就是重复请求，直接读已有记录返回，不再执行业务
    - ② 业务执行成功后 `UPDATE ... SET status='DONE'`；失败置 `FAILED` 并允许按 bizKey 重入（可带重试次数上限与退避）
    - ③ 跨服务场景用"本地事务表 / 消息表"（Outbox）保证"业务写入 + 消息发送"原子，避免发消息成功但业务回滚
    - ④ 强一致要求高的落账用 TCC（Try 冻结额度、Confirm 用 bizKey 幂等地落账），与分布式锁配合但要设租约与兜底解锁
- 追问2：bizKey 如何设计才兼顾防重与可追溯？
  - **答**：用 `tenantId:dataSource:entityId:period` 拼接，唯一索引防重；同时保留 `requestId` 便于按原始请求追溯，核算流水表存 `bizKey+requestId+status` 形成审计链。

### 32. 虚拟线程下用 CompletableFuture 编排碳足迹多源聚合，载体线程切换后 MDC / 租户上下文怎么不丢？
**重要度**：★★★

**难度**：★★

**考点**：CompletableFuture 的线程归属、虚拟线程载体线程复用、MDC/租户上下文传递、ScopedValue 与显式传参的取舍。

> **本题与第 4 题的区别**：第 4 题问"用 `allOf` 还是 `thenCombine`、怎么传 executor"，是**编排 API** 的选型；本题默认你已经会编排，问的是"编排跑在虚拟线程上以后，日志里的 traceId 和租户上下文为什么没了"——这是**上下文传播**问题，也是虚拟线程落地最容易踩的坑。

**参考答案**：`CompletableFuture` 的每个 stage 都可能跑在不同的线程上：不带 `Async` 的 `thenApply` 在"完成上一个 stage 的那个线程"里执行，`supplyAsync`/`thenApplyAsync` 则用你传的 executor。把 `Executors.newVirtualThreadPerTaskExecutor()` 传进去以后，每个 stage 都是一个新的虚拟线程，而**载体线程（carrier）是复用的平台线程**——MDC 和 `ThreadLocal` 挂在载体线程上，于是：日志丢 traceId，`TenantContext.get()` 拿到 null 或**上一个任务的残留值**。后者比丢日志严重得多：查询没带租户过滤就是越权，因子版本取错就是核算失真。解法优先级：① 核心链路把 `tenantId` 显式当参数传，最稳；② 必须用隐式上下文时用 `ScopedValue`（不可变、绑定在作用域、子任务继承）；③ 沿用 MDC 的话，把"捕获→恢复→清理"封装成任务装饰器，`whenComplete` 里也要恢复，因为回调同样可能在别的线程。

```java
// 装饰器：捕获当前线程的 MDC 与租户，进入 executor 时恢复，退出时清理
static <T> Supplier<T> contextPropagating(Supplier<T> task, String tenantId) {
    Map<String, String> captured = MDC.getCopyOfContextMap(); // 快照，不是引用
    return () -> {
        Map<String, String> prev = MDC.getCopyOfContextMap();
        if (captured != null) MDC.setContextMap(captured); else MDC.clear();
        try {
            return ScopedValue.where(TENANT, tenantId).call(task::get); // 虚拟线程内也能拿到 tenantId
        } catch (Exception e) {
            throw new CompletionException(e);
        } finally {
            if (prev != null) MDC.setContextMap(prev); else MDC.clear(); // 不清就把上下文留在载体线程上
        }
    };
}

var future = CompletableFuture.supplyAsync(contextPropagating(() -> factorRepo.find(pid), tenantId), vExec)
        .thenCombine(CompletableFuture.supplyAsync(contextPropagating(() -> actRepo.find(pid), tenantId), vExec),
                     CarbonFootprint::assemble)
        .orTimeout(2, TimeUnit.SECONDS);
```

**深度解析**：`CompletableFuture` 本身不携带任何上下文，它只负责"谁在什么时候触发下一个函数"。线程归属规则要背下来：`thenApply/thenCompose/whenComplete` 等**非 Async** 方法由"完成前一 stage 的线程"执行（可能是 `main`、可能是某个虚拟线程）；`xxxAsync(...)` 不带 executor 时用 `ForkJoinPool.commonPool()`。虚拟线程 executor 下，每个任务一个新虚拟线程，但载体线程是共享的少数平台线程，所以：

- **ThreadLocal 会串**：载体线程上残留上一个任务的 `tenantId`，读到的既可能是 null，也可能是别人的值——这是"偶发越权"类事故的典型成因。
- **`InheritableThreadLocal` 救不了**：它只在 `new Thread()` 时复制一次父线程的值，线程池复用、虚拟线程调度下完全不可靠，不要拿它当方案。
- **`ScopedValue` 更合适**：不可变、按作用域绑定/解绑、结构化并发的 `fork()` 子任务自动继承（JDK 25 转正，JEP 506）；但它解决"作用域内继承"，解决不了"跨 executor 提交"——提交到自定义线程池时仍需要在外层 `where()` 里提交，或改用 `StructuredTaskScope`。
- **更好的写法**：如果三个源是"缺一不可、失败即整体失败"，直接用 `StructuredTaskScope.ShutdownOnFailure` 替代 `CompletableFuture`——上下文自动继承，失败自动取消，代码还短一截；`CompletableFuture` 更适合"可独立降级、需要链式转换"的场景。

**易错点**：只在入口 `MDC.put` 就以为全链路都有；`thenApplyAsync` 忘了传 executor 落到 commonPool，既串上下文又用阻塞 I/O 卡住公共池；恢复 MDC 后不清理，污染载体线程上的下一个请求；用 `InheritableThreadLocal` 或静态字段存租户（后者直接线程不安全）。

#### 追问：
- 追问1：`InheritableThreadLocal` 为什么在虚拟线程里不靠谱？JDK 21 之后有官方替代吗？
  - **答**：`InheritableThreadLocal` 的复制发生在创建线程那一刻（`Thread` 构造器里），之后父子线程再无关联；虚拟线程由调度器创建、且载体线程长期复用，复制时机和生命周期都对不上。
    - 官方替代就是 `ScopedValue`（JDK 25 转正，JEP 506）：按作用域绑定、不可变、随结构化并发自动继承；JDK 21 上只能先用 preview（`--enable-preview`）或退回显式传参。
- 追问2：既然 `ScopedValue` 更好，为什么还说"直接换 StructuredTaskScope 更推荐"？
  - **答**：因为 `ScopedValue` 的自动继承依赖结构化并发的 `fork()`；你如果继续用 `CompletableFuture.supplyAsync(..., 自定义线程池)`，绑定不会自动带到池里的线程，仍要手工 `where()` 包一层。
    - 换成 `StructuredTaskScope` 后，"绑定继承"和"失败取消"是同一个机制给的，不需要两套代码；代价是它目前仍是 preview（JDK 25 JEP 505），需要 `--enable-preview`，生产要评估升级节奏。
- 追问3：怎么在上线前证明上下文没丢、也没串？
  - **答**：写一个"租户 A + 租户 B 交替压测"的用例：每个请求在日志里打 `tenantId` 与 `traceId`，断言日志中的 tenantId 与请求入参 100% 一致；再把 executor 的并发压到载体线程数以下和以上各跑一遍（更容易暴露残留）。
    - 加一条断言：Mock 的因子库仓库收到的方法参数里必须带 tenantId——把"隐式上下文"变成"显式参数"，从类型上就不可能丢。

### 33. 碳因子数据通过 CDC 从 MySQL 同步到 ES/Milvus，如何保障一致与对账？
**重要度**：★★★

**难度**：★★★

**考点**：CDC（Change Data Capture）、Canal、最终一致、对账、碳因子版本漂移。

**参考答案**：用 Canal 监听 MySQL `carbon_factor` 的 binlog，实时写入 ES（文本检索）与 Milvus（向量）。每条因子带 `version` 与 `updated_at`。下游消费时校验版本顺序（单调递增），乱序丢弃旧版。每日跑对账 Job：比 MySQL 与 ES/Milvus 的因子数、版本号、关键字段哈希，差异告警并重推。

**深度解析**：CDC 避免「双写」不一致，以 DB 为唯一源。Canal 本身不做 transform，文本向量化在消费端调用 Embedding 完成。需处理 delete（ES 删文档、Milvus 删向量）、schema 变更。最终一致窗口内查到旧因子，业务层可按 `updated_at` 容忍。参考 Canal 与 Debezium 官方文档。

**易错点**：向量化在 CDC 链路超时阻塞整条流；删操作漏同步致脏因子残留；对账只看条数不看内容，字段漂移发现不了。

#### 追问：
- 追问1：CDC 链路故障积压如何止血？
  - **答**：Kafka Streams 开启 exactly-once（processing.guarantee=exactly_once_v2），故障从位点重放；积压时增加并行任务数； Embedding 调用慢则降级为异步旁路向量化，主链路只同步结构化字段，保核心可用。
- 追问2：向量库和关系库版本不一致会算错吗？
  - **答**：会，可能用旧 GWP 因子致排放偏差。故对账必查 `version`，且报告生成时优先取 MySQL 权威因子、向量库仅用于「相似推荐」，关键计算不走近似源。

### 34. 碳管家 AI 助手实时推送核算进度，SSE 断线重连与背压怎么处理？
**重要度**：★★★★

**难度**：★★

**考点**：SSE 生命周期、Spring SseEmitter、超时/重连、背压、AI 流式回答。

**参考答案**：AI 助手边算边推（含 LLM 流式 token 与核算进度），用 `SseEmitter` 维持连接，设 `timeout` 并注册 `onCompletion/onError` 清理。客户端断线后带 `Last-Event-ID` 重连，服务端据 `taskId+offset` 续推。背压方面：若推送快于消费，`SseEmitter.send` 抛 `IllegalStateException` 时标记客户端慢、降级为摘要推送或转轮询。

**深度解析**：SSE 默认文本流、`retry:` 字段控制重连间隔。Spring 中每个 `SseEmitter` 占一个连接，需池化/超时回收防泄漏。AI 流式输出可 `map` 成 SSE 事件；核算进度独立事件类型。背压本质是客户端消费能力，服务端不能无限缓存，应限缓冲队列长度。参考 HTML5 SSE 规范与 Spring WebMVC SseEmitter。

**易错点**：Emitter 不关致内存泄漏；重连不带偏移致进度重复推；未处理客户端慢致服务端 OOM。

#### 追问：
- 追问1：SSE 能推二进制向量吗？
  - **答**：SSE 仅文本，向量需 base64 或 JSON 编码为字符串事件；大向量建议只推「完成+结果 URL」，前端再拉取，避免 SSE 帧过大阻塞。
- 追问2：多实例部署 SSE 如何找到对的连接？
  - **答**：用发布订阅（Redis Pub/Sub 或 MQ）：进度事件发到 `report:{taskId}` 频道，持有该 SseEmitter 的实例消费并推送；无对应连接则丢弃或转持久化待重连拉取。

### 35. 积木LCA云中「报告生成 + 配额扣减」如何用 TCC 避免配额超发与报告孤儿？
**重要度**：★★★

**难度**：★★★

**考点**：TCC 业务落地、配额预留、报告任务与配额绑定、异常补偿、LCA 报告一致性。

**参考答案**：Try：为报告预留 AI 配额（冻结 N 单位），创建 `report_task`（status=RESERVED）。Confirm：报告生成成功，真实扣减冻结配额、置 `status=DONE`。Cancel：生成失败/超时，释放冻结配额、置 `status=CANCELLED`。配额与任务通过 `taskId` 绑定，Confirm/Cancel 幂等，确保「有报告必有扣减、扣了必有报告」二选一，杜绝超发与孤儿报告。

**深度解析**：LCA 报告含大量因子计算与 LLM 调用，耗配额且慢，必须「先预留后使用」。TCC 的冻结量即「最大可能消耗」，Confirm 按实际结算（多退少补）。超时被全局事务定时器触发 Cancel 释放，防配额被永久钉死。参考 Seata TCC 与「配额即资源」建模。

**易错点**：Try 不冻结致并发超发；Confirm 按预估而非实际扣减致账目偏差；超时未触发 Cancel 致配额泄漏。

#### 追问：
- 追问1：Confirm 实际消耗与冻结不一致怎么办？
  - **答**：Try 冻结的是「上限」N（`frozen += N`），Confirm 必须把**整个 N 从冻结水位释放**、只按实际扣余额：`balance -= actual; frozen -= N`，余量 `N - actual` 自动回到可用额度；若 actual>N 属异常需告警人工，正常业务应保证 actual≤N。若是 Cancel 则 `frozen -= N`。**Try 冻 N、Confirm 扣 actual、冻结水位必须全额释放**，这是 TCC 最容易漏的一步——写成 `frozen -= actual` 会永久残留 `N - actual` 的冻结量，配额被慢慢钉死，恰好是本题要防的泄漏。
- 追问2：报告生成极慢，冻结长期占用的对策？
  - **答**：设配额冻结 TTL，超时自动 Cancel 释放并标记任务失败，用户可重提；或对长任务改用「按阶段小步扣减」而非一次性大冻结，降低占用周期。

### 36. 碳数据采集高并发下，如何用 Semaphore + 虚拟线程做下游写入限流与背压？
**重要度**：★★★★

**难度**：★★

**考点**：虚拟线程背压、Semaphore 限流、下游保护、批量写入、采集链路稳定性。

**参考答案**：采集入口接大量设备上报，下游是 MySQL/时序库写入（瓶颈）。用虚拟线程接收（I/O 不占平台线程），但在写库前用 `Semaphore(dbPermits)` 限并发写数（如 50），超出则虚拟线程挂起等待，形成软背压，避免瞬时万级写入压垮 DB。到达许可的虚拟线程批量攒批（`batchInsert`）提升吞吐。

**深度解析**：虚拟线程让「每请求一线程」成本极低，但下游 DB 连接/写入能力有限，必须由 Semaphore 做准入。背压本质是把「下游处理不了的压力」转化为「上游虚拟线程阻塞」而非无限堆积队列。批量写降低单条事务开销。配合连接池（HikariCP）`maximumPoolSize` 双重限流。

**易错点**：只开虚拟线程不限下游，DB 连接耗尽全链路超时；Semaphore 与连接池上限不一致致死锁式阻塞；批量攒批无上限致内存涨。

#### 追问：
- 追问1：Semaphore 和连接池最大连接数如何配？
  - **答**：令 `Semaphore permits ≈ HikariCP maximumPoolSize`（略小），保证「拿到许可必能取连接」，避免许可到手却等连接；二者同向收敛到 DB 真实承受能力。
- 追问2：虚拟线程阻塞在 Semaphore 会钉住载体吗？
  - **答**：不会。`Semaphore.acquire()` 是纯 Java 锁等待，虚拟线程会卸载（unmount）让出 carrier thread，载体可调度其他虚拟线程，这正是虚拟线程相比平台线程的优势。


---
