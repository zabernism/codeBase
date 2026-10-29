## 第二十三章：Elasticsearch与搜索工程

> 本章聚焦搜索本身的工程细节：倒排索引、分词器与 ik_max_word/ik_smart 的差别、查询与聚合、性能调优。在 RAG 链路中 ES 承担 **BM25 关键词召回**，与 Milvus 的向量召回互补，再由 RRF 融合——见[第三章](/03-rag.html)。



### 1. 倒排索引（inverted index）的原理是什么？与正排索引有何区别？
**重要度**：★★★★★

**难度**：★

**考点**：倒排索引基本结构、正排与倒排的适用场景。

**参考答案**：倒排索引以 term 为 key，记录包含该词的所有 docId 列表（倒排表），并配合词典（term dictionary）定位。正排索引以 docId 为 key，存储该文档的全部字段值。检索时正排需逐文档扫描字段，而倒排可直接通过 term 定位文档集合，因此检索极快；但正排适合按主键取完整文档，倒排适合关键字匹配。碳管家 AI 助手检索"碳排放因子"时，正是靠因子名称的 term 快速命中对应文档。

**深度解析**：官方文档将 inverted index 描述为"包含每个 term 出现在哪些文档中的映射"。词典常驻于 FST（Finite State Transducer）结构，可压缩且支持前缀查找；倒排表以 docId 有序存储，便于求交集（bool 查询）。正排在 ES 中表现为 `_source` 与 doc_values，用于聚合、排序与按 id 取数。注意：倒排只解决"哪些文档含词"，相关性打分另由 BM25 完成。

**易错点**：误以为倒排索引能直接返回文档内容（实际它只存 docId 与词频/位置，内容来自 `_source`）；混淆"正排=列式存储"，ES 的 doc_values 才是真正意义上的正排列式结构。

#### 追问：
- 追问1：为什么词典（term dictionary）要用 FST 而不是哈希表？
  - **答**：FST 兼具压缩与有序特性，能用远小于哈希表的内存存储海量 term，并支持前缀、范围与模糊查询；哈希表虽 O(1) 但无法有序遍历，也不压缩，内存代价高。ES 在堆外使用 FST 加速词典查找。
- 追问2：倒排表里的位置信息（positions）有什么用？
  - **答**：positions 记录 term 在文档中的出现位置，支撑 phrase 查询（"碳排放 因子"须连续相邻）、span 查询与高亮（highlight）。若不开启 index_options 的位置，则无法做短语匹配。

### 2. term、word 与 token 在 ES 分词语境下分别指什么？
**重要度**：★★★★

**难度**：★

**考点**：分词基本概念、索引与检索一致性。

**参考答案**：word 是自然语言中的"词"；token 是 analyzer 处理后产出的最小检索单元；term 是写入倒排索引、可被查询的最小单位（通常等同于规范化后的 token）。例如"碳排放因子"经 ik_max_word 切成多个 token，这些 token 作为 term 存入倒排表。关键在于：索引时 analyzer 产出的 term，必须与检索时 analyzer 产出的 term 一致，否则查不到。碳管家法规检索中，若建库用 ik_smart、查询用 ik_max_word，分词粒度不同会导致召回偏差。

**深度解析**：Lucene 中 term 由 (field, bytes) 组成，是词典的最小键。同一个 field 下"碳排放"和"排放"是两个不同 term。检索时 match 查询会先对输入做 analyzer，再拿得到的 term 去词典查倒排表；term 查询则不做分词，直接拿原串当 term 查。因此 term 查询适合 keyword 字段，match 适合 text 字段。

**易错点**：认为 term 查询"更快所以更好"——它跳过了分析，对 text 字段用 term 查询常因大小写/分词不一致而命中为空；对 keyword 字段才是正确用法。

#### 追问：
- 追问1：为什么对 text 字段用 term 查询经常查不到？
  - **答**：text 字段写入时已被 analyzer 切词并转小写、去停用词，倒排里存的是切后的 term；而 term 查询不分词，用整句原串去匹配，自然对不上。应改用 match 查询或对该字段加 `.keyword` 子字段。
- 追问2：normalizer 与 analyzer 的区别？
  - **答**：normalizer 只做字符级归一化（如小写、去重音）且不分词，专用于 keyword 字段，使其能像 term 一样被精确归一匹配，同时保留整词不分词的语义。

### 3. Elasticsearch 的 analyzer 由哪三部分组成？各自职责是什么？
**重要度**：★★★★

**难度**：★

**考点**：char filter、tokenizer、token filter 三级流水线。

**参考答案**：analyzer 由 char filter → tokenizer → token filter 三级组成。char filter 在分词前对原始字符做处理，如去除 HTML 标签、字符映射；tokenizer 负责切词，决定"词"的边界（如 standard 按空白与标点切，icu 按 Unicode 词切）；token filter 对切出的 token 再加工，如 lowercase 转小写、stop 去停用词、synonym 加同义词。碳管家检索"CO₂排放"时可用 char filter 把全角转半角，保证中英文混排一致。

**深度解析**：官方文档强调三者顺序不可乱——char filter 看到的是原始字符串，tokenizer 输出 token 流，token filter 逐个处理 token。内置 analyzer（standard、simple、keyword、pattern 等）与插件提供的 analyzer（ik_max_word、ik_smart、pinyin 等）本质都是这三者的预设组合——注意 ik 系列不是 ES 内置，靠 `elasticsearch-analysis-ik` 插件提供。可在 `index settings` 中自定义 analyzer，并在 mapping 的 `analyzer`/`search_analyzer` 分别指定，允许索引与检索用不同分析器（如索引细粒度、检索粗粒度）。

**易错点**：在 tokenizer 之前就试图做"去停用词"是错的——停用词属于 token filter 阶段；误把 char filter 当分词器，它不产生 token。

#### 追问：
- 追问1：analyzer（索引期）与 search_analyzer（检索期）不一致会怎样？
  - **答**：索引期切出的 term 集合与检索期切出的 term 集合不同，会导致召回率异常（多召回或漏召回）。典型用法是索引用 ik_max_word 多粒度、检索用 ik_smart，提升精度；但若反向设置则会漏召回。
- 追问2：同义词 synonym 放在哪一级合适？
  - **答**：通常作为 token filter，在 tokenizer 之后对 token 扩展同义词。需注意同义词应在 lowercase 之后、可能影响短语与高亮，且同义词词典更新需要重建或 reindex 才对存量生效。

### 4. ik_max_word 与 ik_smart 有什么区别？在法规全文检索中如何选择？
**重要度**：★★★★★

**难度**：★★

**考点**：中文分词粒度、召回与精度的权衡。

**参考答案**：ik_max_word 做最细粒度切分，把文本拆成尽可能多的词（如"碳排放因子管理办法"拆成"碳排放/排放/因子/管理办法/管理/办法"等），召回高但精度低、索引体积大；ik_smart 做最粗粒度切分，只保留最主要词组，精度高、索引小。碳管家法规全文检索中，建库常用 ik_max_word 以最大化召回，检索端可搭配 ik_smart 提升精度，或用 search_analyzer 单独设置。

**深度解析**：IK 是第三方中文插件，需安装。两者基于同一词典但切词策略不同：max_word 用的是"贪心最长+全切"，smart 用"最少切分"。注意同一字段可建 multi-fields 子字段分别指定不同 analyzer（如 `text` 用 ik_max_word、`text.ik_smart` 用 ik_smart），也可用 `analyzer`/`search_analyzer` 分离索引期与检索期。在 RAG 的法规召回里，细粒度索引能避免"办法"被漏掉。

**易错点**：把 ik_smart 用于索引、ik_max_word 用于检索——这会严重漏召回，因为索引粒度比检索粗，检索切出的细词在索引里不存在。

#### 追问：
- 追问1：自建法规词典（如"碳足迹""CCER"）如何热更新？
  - **答**：IK 自身会监听 dic 文件变更（`last modified` 轮询，约 1 分钟）自动重载主词典；使用远程词典（remote_ext_dict）时按 refresh 间隔拉取。ES 侧没有 `_reload_analyzers` 这个接口，需要强制刷新**检索期**分析器时调用 `POST /<index>/_reload_search_analyzers`（可带 `?ignore_unavailable=true`）。存量文档需 reindex 才能用上新词，新写入自动生效。
- 追问2：中文分词对 BM25 打分有何影响？
  - **答**：切词越细，term 在文档中出现频次（tf）与逆文档频率（idf）分布越分散，影响 BM25 的 norm 与 idf，进而改变排序。细粒度易使长文档被过度切分，需配合 minimum_should_match 等控制精度。

### 5. text 与 keyword 类型有何区别？term 查询和 match 查询分别用于什么场景？
**重要度**：★★★★★

**难度**：★★

**考点**：字段映射类型、精确匹配 vs 全文检索。

**参考答案**：text 字段会被 analyzer 分词，用于全文检索（match 查询），支持相关性打分；keyword 字段不分词、整值存储，用于精确匹配（term 查询）、聚合与排序。term 查询直接拿原串当 term 比对，适合 keyword、数值、枚举等；match 查询先分词再做全文匹配，适合 text。碳管家中"法规文号"应设为 keyword 用 term 精确查，"法规正文"设为 text 用 match 全文搜。

**深度解析**：一个字段常配 `fields.keyword` 子字段（多字段），既支持全文又支持精确。官方建议避免对 text 用 term——因为已分词，原串通常不在倒排里。term-level 查询（term/terms/range/exists）走的是结构化匹配、可缓存、不评分；full-text 查询（match/match_phrase）走分析+打分。

**易错点**：对 text 字段直接 term 查询得到空结果还以为数据丢了；用 match 查枚举状态字段导致不必要的分词与召回歧义。

#### 追问：
- 追问1：multi-field 的 `.keyword` 子字段是怎么生成的？
  - **答**：在 mapping 中为 text 字段声明 `fields: { keyword: { type: keyword, ignore_above: 256 } }`，写入时主字段走 analyzer、子字段存原始整值，二者共享同一 `_source`，不额外占用源数据空间，仅多一份索引。
- 追问2：keyword 字段能存多长？超出会怎样？
  - **答**：自己手写的 mapping 里 keyword 若不显式设 `ignore_above` 则默认是 `2147483647`（实际不限长）；常被引用的 256 是**动态映射**自动生成 `.keyword` 子字段时写入的默认值。超长值超出 `ignore_above` 时该值不被索引（仍存于 `_source`），term 查不到。长文本不要用 keyword，超大枚举值可酌情调大或改 text+keyword 双字段。

### 6. Elasticsearch 为什么是"近实时"（NRT）而不是实时？refresh 的作用是什么？
**重要度**：★★★★

**难度**：★★

**考点**：refresh 机制、写入可见性延迟。

**参考答案**：文档写入后先进入内存 buffer 与 translog，默认每 1s 由 refresh 将 buffer 生成一个新的、可被搜索的 segment（写入文件系统缓存），此后才能被检索，因此可见性延迟约 1s，称为近实时。refresh 不涉及磁盘 fsync，仅让数据进 OS cache 即可被搜。碳管家批量导入碳排放因子时，若追求写入吞吐可临时调大 refresh_interval 到 30s 甚至 -1（关闭），导入完再恢复。

**深度解析**：官方文档明确 refresh 使"最近 1s 的变更可被搜索"。注意 refresh 不保证持久化——宕机仍可能丢这 1s 数据，持久化靠 translog 的 fsync。refresh 频率越高，实时性越好但 segment 越多、搜索负担越重。大批量导入关闭 refresh 能显著减少小 segment 与合并开销。

**易错点**：以为 refresh 就已经落盘（其实只是进 filesystem cache）；为追求"实时"把 refresh_interval 设成 0，结果写入被小 segment 拖垮、搜索变慢。

#### 追问：
- 追问1：refresh 和 flush 有什么本质区别？
  - **答**：refresh 把内存 buffer 变成可搜的 segment（在 cache，不 fsync），控制可见性；flush 把 translog 清空并把内存中的 segment 真正 fsync 到磁盘，控制持久化。二者职责正交，频率与触发条件都不同。
- 追问2：导入时把 refresh_interval 设 -1，那新写入能搜到吗？
  - **答**：设 -1 期间不会自动 refresh，写入不可被搜索；导入结束需手动 `_refresh` 或恢复 interval 触发一次 refresh 才能查到。这是典型"先写后刷"的批量优化套路。

### 7. translog、flush 与 fsync 如何共同保证数据不丢？
**重要度**：★★★★

**难度**：★★

**考点**：持久化链路、故障恢复。

**参考答案**：每次写入先写内存 buffer，并追加到 translog（事务日志）。translog 默认每次写请求都 fsync（request 模式），因此即使尚未 flush，宕机后也能用 translog 重放恢复。flush 负责把内存 segment fsync 到磁盘并清空 translog，默认每 30 分钟或 translog 达 512MB 触发。fsync 才是真正落盘。碳管家因子数据若要求不丢，应保证 translog 的 durability 为 request。

**深度解析**：官方文档指出 translog 的目的是"崩溃后恢复尚未 flush 的数据"。可配置 `index.translog.durability=async` 提升写入性能，但故障时可能丢失一个刷新周期内数据——这是吞吐与安全的权衡。flush 后旧 translog 被删除，新写入从新 translog 开始。fsync 由 Lucene 在 flush 时调用，保证 segment 文件持久。

**易错点**：认为 refresh=持久化，实则 refresh 不 fsync；把 durability 改成 async 却声称"数据不丢"，是自相矛盾。

#### 追问：
- 追问1：durability 设 async 后最多能丢多少数据？
  - **答**：async 模式下 translog 按 `sync_interval`（默认 5s）定期 fsync，故最坏丢失约一个 sync_interval 内的写入。适合可重放的来源（如 CDC 重跑），不适合不可重建的源头。
- 追问2：节点重启后 ES 如何恢复？
  - **答**：节点启动先加载已 flush 的 segment，再重放 translog 中尚未落盘的写操作恢复最新状态，最后做 shard recovery 与 primary/replica 对齐。

### 8. segment 是什么？merge（段合并）解决了什么问题？
**重要度**：★★★★

**难度**：★★

**考点**：Lucene segment 不可变、合并收益与代价。

**参考答案**：segment 是 Lucene 不可变的倒排索引文件，每次 refresh/flush 都会生成新 segment。小 segment 过多会拖慢搜索（需合并多段结果）并占用文件句柄。ES 后台的 merge 进程将多个小 segment 合成大 segment，减少段数、提升查询效率，并物理删除被标记为删除的文档（delete 只打标记，merge 才真清）。碳管家大批量导入后常触发大量 merge，可观察 `segments.count` 指标。

**深度解析**：官方文档说明 merge 由 `merge scheduler` 自动调度，可通过 `refresh_interval`、批量写入减少小段产生。merge 是 IO/CPU 密集型，过度合并会争抢资源，可用 `force merge`（通常只用于只读/冷索引，如将冷法规索引合并为 1 段）手动收尾，但会对热索引造成停顿。

**易错点**：对热索引执行 force merge——会触发巨量 IO 并阻塞写入；以为删除文档立刻释放空间（需等 merge 才真正回收）。

#### 追问：
- 追问1：为什么文档删除只是"标记删除"？
  - **答**：segment 不可变，无法原地改；delete 在 .liv 文件（或 doc values 的 del 位图）标记该 docId 已删，查询时跳过。只有 merge 重写段时才真正剔除被删文档、回收空间。
- 追问2：merge 会重新打分吗？会影响 BM25 吗？
  - **答**：merge 只重组物理段、不改倒排统计，BM25 所需的 tf/idf/norm 不变，打分不漂移。但段数变化会影响 `max_doc` 类聚合的合并方式，性能上更优而非语义变化。

### 9. bool 查询中 must、should、filter、must_not 各自的作用与区别是什么？
**重要度**：★★★★

**难度**：★★

**考点**：bool 子句语义、评分与过滤。

**参考答案**：must 子句参与相关性打分且必须匹配；filter 子句必须匹配但不参与打分、结果可被缓存（适合状态、时间范围等结构化条件）；should 表示"或"，是否必须命中取决于上下文——bool 中**只有 should** 时默认 `minimum_should_match=1`（至少命中一个）；若已存在 `must` 或 `filter`，则 should 默认只需满足 0 个、仅参与打分。should 参与打分；must_not 必须不匹配、不参与打分、不缓存。碳管家检索法规时可把"发布日期范围"放 filter、"关键词"放 must，既快又不影响排序。

**深度解析**：官方文档强调 filter 上下文（filter/must_not）走的是"filter context"，跳过评分、命中可被 bitset 缓存复用，性能优于 must。must 与 should 走 query context 计算 score。当 bool 同时含 must，should 默认只需满足 0 个；仅含 should 时至少满足 1 个，或用 minimum_should_match 显式控制。

**易错点**：把本应过滤的条件放进 must，白白付出打分开销且无法利用缓存；忽略 minimum_should_match 导致 should 全可选、召回失控。

#### 追问：
- 追问1：filter 的缓存是什么机制？
  - **答**：ES 用 filter cache（现为 per-segment bitset，随段自动失效）缓存 filter 结果，相同 filter 再次命中直接复用 bitset 做交集，跳过倒排遍历，速度极快。注意高基数字段（如精确时间戳）缓存收益低。
- 追问2：must_not 能放进 filter 上下文吗？
  - **答**：能。must_not 本就属于 filter context，不参与打分、不缓存（历史版本有差异，现代版本 filter 与 must_not 均为 filter context），用于排除，如排除已废止法规。

### 10. filter 不评分且可缓存，而 constant_score 又是什么？两者如何选？
**重要度**：★★★

**难度**：★★

**考点**：评分优化、constant_score 用途。

**参考答案**：filter 完全不评分、可被缓存，适合纯结构化过滤；constant_score 把任意查询包进 filter 上下文，并给所有命中文档一个恒定分数（默认 1.0），即"能匹配但分数恒定"。当你需要某条件必须命中、又不想让它影响 BM25 排序（或想让多个条件同分加权）时用 constant_score。碳管家检索"行业=电力"且必须命中但排序由其他相关性决定时，可用 constant_score 包行业条件。

**深度解析**：官方文档指出 constant_score 内部将 query 转成 filter context，故同样享受缓存且不评分，仅附加固定 boost。与纯 filter 的区别在于：filter 作为 bool 子句时不产出分数；constant_score 作为顶层查询会返回固定分，便于在 bool 的 should 中做可控加权（不同 should 给不同 constant 分）。

**易错点**：用 must+match 给结构化条件打分导致排序被无关字段污染；误以为 constant_score 会重新计算 BM25（它给的是常量分）。

#### 追问：
- 追问1：constant_score 与给 filter 加 boost 有何不同？
  - **答**：filter 本身不返回分数，加 boost 无效；constant_score 把查询作为可评分顶层（定分）返回，因此能用其常量分参与外层排序/加权。简言之 filter 无分，constant_score 有固定分。
- 追问2：什么时候不要用 constant_score？
  - **答**：需要按 BM25 真实相关性排序、且查询本身就有区分度时，用 constant_score 会抹平相关性，使结果顺序退化为固定分（同分时退化为 _doc 顺序），不利于精准召回。

### 11. BM25 相关性算分的直觉是什么？相比 TF-IDF 改进了什么？
**重要度**：★★★★

**难度**：★★★

**考点**：BM25 公式直觉、饱和度与长度归一。

**参考答案**：BM25 分数随 term 在文档中出现频次（tf）上升而增加，但有"饱和"——出现 10 次并不比 2 次重要 5 倍；同时用逆文档频率（idf）惩罚常见词、奖励稀有词；并用文档长度归一：长文档天然含更多词，BM25 降低其 tf 权重以防长文占优。ES 默认 `BM25Similarity`。碳管家检索"碳排放因子"时，命中稀有专业词"因子"的文档会比命中常见词"的"得分更高。

**深度解析**：官方文档称 BM25 是 Probabilistic Relevance Model。相比 TF-IDF 的线性 tf，BM25 引入 `k1` 控制 tf 饱和度、`b`（默认 0.75）控制长度归一强度，避免长文档与词频堆砌作弊。可经 `index.similarity` 自定义 `BM25` 的 k1/b。注意 BM25 只看词频统计，不理解语义——这正是需搭配向量检索（Milvus）的原因。

**易错点**：以为 tf 越高分越高无上限（BM25 已饱和）；用 BM25 做语义相似度（它只统计共现，不懂含义）。

#### 追问：
- 追问1：k1 和 b 分别怎么调？
  - **答**：k1（默认 1.2）越大越允许 tf 继续贡献分数，适合短文本精细区分；b（默认 0.75）越大长度惩罚越强，长文越吃亏。法规长文档可适当降 b 减轻惩罚，需结合相关性评测（如 nDCG）调参。
- 追问2：BM25 能跨字段融合打分吗？
  - **答**：multi_match 的 `best_fields`（默认）本质是 `dis_max`：取各字段中的**最高分**作为主分，其余字段分按 `tie_breaker`（默认 **0**，即完全不参与）折算加权，而不是简单相加；也可用 bool 的 should 给不同字段不同 boost 自行加权。注意 `coord`（协调因子）在 ES 6.0 已随 TF-IDF 一起移除，不要再写"coord/dis_max 思路"。

### 12. 聚合（aggregation）中 bucket 与 metric 分别是什么？terms 与 date_histogram 举例。
**重要度**：★★★★

**难度**：★★

**考点**：聚合分类、常见聚合类型。

**参考答案**：bucket 聚合按某种规则把文档分桶（分组），如 terms 按字段值分桶、date_histogram 按时间区间分桶；metric 聚合对桶内数值做统计，如 avg、max、sum、value_count。碳管家可按"行业"terms 分桶统计各行业碳排放总量（sum），或按"月份"date_histogram 看排放趋势。聚合在 query 过滤后的文档集上执行，可嵌套（桶内再套桶/指标）。

**深度解析**：官方文档把聚合分为 bucket、metric、pipeline（基于其他聚合结果再算）三类。terms 聚合近似 TopN 分桶，受 `size` 与 `shard_size` 影响，分布式下为近似结果（靠 `shard_size` 提升精度）。date_histogram 需指定 `calendar_interval`（如 month）或 `fixed_interval`。聚合走 doc_values 列式存储，比加载 _source 高效。

**易错点**：以为 terms 聚合是精确全量（默认返回近似 TopN，未进 TopN 的文档量计入 `sum_other_doc_count`，**不是** missing 桶——missing 是"字段缺失"的独立参数）；在 text 字段上直接聚合报错（需 keyword 子字段）。

#### 追问：
- 追问1：terms 聚合的近似性怎么缓解？
  - **答**：调大 `shard_size`（各分片取更多候选再合并）与 `size`，可逼近精确；或用 `composite` 聚合做深翻页式全量遍历。对超高频词还可设 `min_doc_count`、exclude 过滤噪声桶。
- 追问2：聚合为什么要求字段有 doc_values？
  - **答**：doc_values 是列式正排，聚合/排序需按字段快速遍历所有文档值，列式比行式 _source 解析快且省内存。text 字段无 doc_values，故聚合须用 keyword 子字段（其有 doc_values）。

### 13. 聚合深度分页与 from/size 深翻页有什么性能问题？search_after 如何解决？
**重要度**：★★★★

**难度**：★★★

**考点**：深翻页代价、search_after 原理。

**参考答案**：from/size 翻页时，ES 需在每个分片取 `from+size` 条再协调节点合并排序，from 很大时各分片搬运海量数据、内存与 CPU 暴涨，且受 `index.max_result_window`（默认 10000）限制。聚合深翻页同理，terms 靠 shard_size 近似。search_after 用上一页最后一条的排序值作为游标，避免全局 from 偏移，每次只取一页，性能稳定，适合深翻页与导出。碳管家导出万级因子清单宜用 search_after。

**深度解析**：官方文档建议"深翻页用 search_after 而非 from/size"。search_after 依赖稳定排序（如 `_score`+`_id` 或业务唯一键），无状态、不能跳页；scroll 适合全量快照导出但占用上下文资源、已不推荐用于实时翻页。max_result_window 是保护而非限制正确性，调大它只是放开保护，深翻页仍慢。

**易错点**：为"导出全部"把 max_result_window 调到很大，结果深翻页把集群打挂；用 scroll 做用户实时翻页，占用大量 scroll 上下文拖垮节点。

#### 追问：
- 追问1：search_after 为什么不能跳页？
  - **答**：它基于上一页末尾的排序游标顺序定位，只知"下一页从哪开始"，没有全局偏移概念，因此只能顺序翻、不能随机跳到第 N 页。需要跳页的交互场景应改用 from/size（浅页）或前端缓存。
- 追问2：scroll 与 search_after 各自的适用边界？
  - **答**：scroll 保留索引快照、适合一次性全量迁移/重建（如 reindex、离线导出），但占资源、非实时；search_after 实时、无快照、适合持续深翻页。现代实践多用 search_after/PIT 替代 scroll。

### 14. ES 与 MySQL 双写如何保证一致性？CDC（Canal/Debezium）方案怎么做？
**重要度**：★★★★

**难度**：★★★

**考点**：双写问题、最终一致、CDC 同步。

**参考答案**：应用同时写 MySQL 与 ES 会出现双写失败、顺序错乱、不一致。更优解是让 ES 作为只读从库：MySQL 为唯一写源，通过 CDC（Canal 监听 binlog 或 Debezium 捕获变更）把增量发到消息队列，消费者异步写 ES，实现最终一致。碳管家把法规元信息存 MySQL，用 Canal 同步到 ES 供检索。还需对账 Job 定期比对差异修复，并监控同步延迟。

**深度解析**：官方与社区均建议避免业务双写。CDC 链路为 MySQL→binlog→Canal/Debezium→MQ→ES Consumer。要点：消费端做幂等（按主键 upsert）、保序（同 key 路由同分区）、处理删除事件；ES 写入用 `_bulk`+retry。最终一致下检索可见性有秒级延迟，需在产品上说明。对账 Job 用 `modified_time` 窗口比对或全量 checksum 兜底。

**易错点**：用双写且没事务，一边成功一边失败无回滚；忽略 CDC 顺序导致旧值覆盖新值；把 ES 当主库写入又期望强一致。

#### 追问：
- 追问1：CDC 消费端如何保证幂等？
  - **答**：以业务主键做 ES 文档 `_id`，upsert 覆盖即天然幂等；同一主键路由到同一 MQ 分区保证顺序；对 update 事件携带全量或合并字段，避免基于旧值计算的丢失更新。
- 追问2：同步延迟过大怎么排查？
  - **答**：看 Canal/Debezium 的 lag 指标、MQ 堆积、ES bulk 拒绝（429 需降速重试）。常见根因：bulk 批次过大触发 reject、消费线程不足、ES refresh 太频。可降刷新频率、扩消费并发、加退避重试。

### 15. 分片（shard）与副本（replica）如何规划？为什么分片数设定后难改？
**重要度**：★★★★

**难度**：★★★

**考点**：分片策略、容量与扩展边界。

**参考答案**：索引由若干主分片（shard）组成，数据按 routing（默认 _id 哈希）分布；副本（replica）是主分片的拷贝，提供高可用与读扩展。分片数在创建索引时固定，决定数据路由与并行度——改分片需 reindex 到新索引，成本高，故"设定后难改"。官方经验：单分片 10–50GB 为宜，过小浪费、过大恢复慢。碳管家法规库按年建索引、每年合理分片数，避免单索引无限膨胀。

**深度解析**：官方文档建议避免过多分片（每分片有集群状态、堆内存开销）。分片过多会让集群状态膨胀、搜索扇出成本高；过少则无法水平扩展、单分片过大恢复慢。副本数可调，随时增减，用于应对读压力与故障转移。可用 ILM（索引生命周期管理）按冷热自动 rollover、收缩（shrink）或拆分（split）。

**易错点**："分片越多写入越快"是误区——过多分片增加协调节点与合并开销；建索引时随意设 5 个分片结果数据翻倍后无法再均摊。

#### 追问：
- 追问1：单分片太大（如 200GB）会有什么问题？
  - **答**：恢复/迁移慢、merge 与查询扇出重、故障重分配耗时长。建议按年/月 rollover 控制单分片规模，或用 split 扩容（需先设为 read-only，有运维代价）。
- 追问2：replica 能提升写入性能吗？
  - **答**：不能，反而因要同步写副本增加写入延迟（ack 需等副本）。副本只提升读吞吐与可用性；写入性能靠主分片并行与 bulk 批量优化。

### 16. 在 RAG 场景中，Elasticsearch 与 Milvus 如何分工共存？
**重要度**：★★★★★

**难度**：★★★

**考点**：关键字检索 vs 向量语义检索的互补。

**参考答案**：ES 擅长结构化过滤与关键字（BM25）全文检索，如碳管家按"法规文号、行业、发布日期"精准过滤、按"碳排放因子"关键字召回；Milvus 等向量库擅长语义检索，把查询与文档 embedding 后按余弦/内积找语义相近内容，能理解"温室气体核算"与"碳盘查"的同义。二者常混合：先用 ES 做结构化过滤缩小范围，再在子集上用 Milvus 做语义重排，或用 RRF 融合两路结果，兼顾精度与语义。

**深度解析**：官方与业界实践（如 LangChain 的 ensemble retriever）推荐混合检索（hybrid search）。ES 8.x 也已内置 dense_vector 与 kNN 检索，可在同一引擎内做向量召回，但超大规模向量与 ANN 索引（HNSW/IVF）仍是 Milvus 的强项。分工原则：精确/可解释/过滤用 ES，模糊语义用 Milvus；生产上常双写，文档既进 ES（text+keyword）也进 Milvus（vector）。

**易错点**：只用向量检索丢了精确过滤能力（如无法严格按日期范围）；认为 ES 完全不能做向量（8.x 已支持 kNN，只是规模与算法生态不及专用向量库）。

#### 追问：
- 追问1：混合检索结果怎么融合排序？
  - **答**：常用 RRF（Reciprocal Rank Fusion）按各路排名倒数求和，不依赖分数量纲统一；或把 ES 的 BM25 分与向量距离归一后加权。RRF 简单稳健，避免分数尺度不一致问题。
- 追问2：同一份文档双写 ES 与 Milvus，一致性如何保？
  - **答**：仍以 MySQL/对象存储为主源，CDC 同时驱动两份写入；或先写 ES 再异步 embedding 写 Milvus。需保证文档 id 一致以便关联，并对 embedding 失败做重试与对账，避免语义库缺数据。

### 17. 在 Java 应用中如何高效批量写入 ES？RestHighLevelClient、新 Java API Client 与 Spring Data ES 怎么选？
**重要度**：★★★★

**难度**：★★★

**考点**：Java 客户端演进、批量写入与高并发。

**参考答案**：RestHighLevelClient（RHLC）已废弃，官方推荐新的 Java API Client（基于 Lambda 流式 builder、类型安全、兼容 ES 8.x）。Spring Data ES 封装 Repository/ElasticsearchTemplate，开发快但灵活性弱。高并发批量写入要用 `_bulk` 接口攒批（如每批 5–15MB/数千条），设置合理 timeout 与 retry（指数退避），并控制并发线程数。碳管家导入因子用新 Java API Client 的 `BulkRequest` 异步发送、失败重试。

**深度解析**：官方文档明确 RHLC 在 7.15+ 标记为 deprecated，新 Client 通过 `co.elastic.clients` 提供强类型 API 且自动适配版本。批量要点：避免单条写（network 往返成本高）；用 `bulk` 攒批、`setRefreshPolicy(NONE)` 关刷新；并发用固定线程池 + 背压；遇 429 降速退避。Spring Data ES 适合 CRUD 型业务，复杂聚合/批量建议直接用底层 Client。

**易错点**：仍用已废弃 RHLC 在新项目；每文档一次请求导致写入吞吐极低；不设重试与超时，网络抖动即丢数据。

#### 追问：
- 追问1：bulk 批次多大合适？
  - **答**：经验值每批 5–15MB 或 1000–5000 条，过大易触发 ES 的 http 超时与 `queue full` 拒绝（429），过小则网络往返浪费。应压测找到拐点，并监控 `thread_pool.write.queue` 拒绝数。
- 追问2：新 Java API Client 如何处理版本兼容？
  - **答**：它通过 `ElasticsearchClient` 与 server 协商，JSON 协议向后兼容；建议 Client 版本与集群主版本对齐，跨小版本通常可用，跨大版本（如 7→8）需评估 API 与安全（security）变更。


---
