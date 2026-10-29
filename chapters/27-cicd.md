## 第二十七章：CI/CD与DevOps


> 本章覆盖CI/CD流水线、代码质量、自动化测试、灰度发布、Git工作流、基础设施即代码、容器镜像管理、部署策略与回滚。

---

### 1. CI/CD流水线设计（GitLab CI）
**重要度**：★★★★★

**设计思路（口头表述）**：碳管家 GitLab CI 按 **stages 阶段串行 + 质量门禁** 组织。六个阶段 build→test→quality→package→deploy-staging→deploy-production，前一段失败后段不跑。关键设计：
  - ① build 用 maven cache（.m2）加速依赖下载
  - ② test 产物 junit 报告作为 artifact 传递供看板
  - ③ **quality 阶段是门禁**（SonarQube 分析 + `-Dsonar.qualitygate.wait=true` 等门禁结果，`allow_failure: false` 不许失败），把质量卡在部署前；注意光跑 `mvn verify` 不会触发 Sonar、也不会等 Quality Gate，等于门禁是空的
  - ④ deploy 分 staging（自动）和 production（手动审批）两级，production 靠审批门保护
  - ⑤ 镜像 tag 用 commit sha，可追溯可回滚
  - 一句话："编译→测试→质量门禁→打包→预发→审批→生产"六步走，质量门禁不许跳。

```yaml
variables:
  # Maven 默认本地仓库在 ~/.m2，不在项目目录；不改 repo.local 则下面 cache 的目录永远是空的
  MAVEN_OPTS: "-Dmaven.repo.local=$CI_PROJECT_DIR/.m2/repository"

stages: [build, test, quality, package, deploy-staging, deploy-production]

build:
  script: [mvn -B compile -DskipTests]
  cache: {key: "maven-$CI_COMMIT_REF_SLUG", paths: [.m2/repository]}

test:
  script: [mvn -B test]
  artifacts: {reports: {junit: target/surefire-reports/*.xml}}

quality:
  script: [mvn -B verify sonar:sonar -Dsonar.qualitygate.wait=true]   # 只有 qualitygate.wait 才会等门禁
  allow_failure: false        # 质量门禁不允许失败（也是默认值，写出来表意清晰）

package:
  script:
    - docker build -t $REGISTRY/carbon-assistant:$CI_COMMIT_SHA .
    - docker push $REGISTRY/carbon-assistant:$CI_COMMIT_SHA

deploy-staging:
  script: [kubectl set image deployment/carbon-assistant ... -n staging]
  environment: {name: staging}
  rules: [{if: '$CI_COMMIT_BRANCH == "main"'}]

deploy-production:
  script: [kubectl apply -f k8s/production/]
  environment: {name: production}
  rules: [{if: '$CI_COMMIT_BRANCH == "main"', when: manual}]   # 手动审批（only/except 已 legacy，用 rules）
```

---

#### 追问：
- 追问1：当quality阶段SonarQube因误报阻断了紧急Hotfix PR时，你如何在保证质量门禁严肃性的同时给出逃生通道？
  - **答**：保留门禁刚性，提供受控逃生通道。
    - 引入"质量门禁例外"机制：需指定 Reviewer 双人审批并在 PR 备注误报编号与豁免原因，仅对本 commit 临时放行。
    - 误报应事后在 SonarQube 加白名单或下调规则严重级，而非长期绕过。
    - 紧急 Hotfix 单独走 hotfix 分支并配自动回滚，放行后应在 24h 内补跑分析归档。
- 追问2：碳管家RAG系统依赖Milvus索引与向量模型版本，构建阶段应如何把"检索质量"纳入流水线而非只做代码编译？
  - **答**：将检索质量作为可量化门禁。
    - quality 阶段跑 Golden Dataset，对典型碳法规问答断言 top-k 召回的相关因子命中率。
    - 绑定 Milvus 索引版本与 embedding 模型版本到产物元数据，版本漂移则阻断发布。
    - 用 LLM-as-Judge 对采样问题评检索相关性，设定最低相关分阈值，低于阈值阻止发布。
- 追问3：deploy-production采用手动审批且只触发main，若main上一次提交已发布、本次仅改文档，如何避免无效的半小时部署等待？
  - **答**：用变更感知跳过部署。
    - CI 检测本次 commit 实际变更文件（git diff），仅 docs/ 且无关 k8s/chart 则标记 skip-deploy。
    - 部署前判断最近已发布 commit_sha 是否等于待发布 sha，相等直接 no-op。
    - staging 仍可部署验证文档渲染，production 跳过审批以省等待。

### 2. GitHub Actions流水线
**重要度**：★★★★

**设计思路（口头表述）**：GitHub Actions 我按**阶段串行 + 产物传递**组织。触发靠 `on.push` 到 main/develop。Job 间用 `needs` 串行保证顺序：build-and-test（checkout + 装 JDK17 + mvn test）→ docker-build（打镜像推仓库）→ deploy-staging → 手动审批 → deploy-production。关键设计：
  - ① 每个 job 独立 runner，失败即停不往下走，避免带病部署
  - ② 用官方 action（checkout@v4、setup-java@v4）复用，不自写脚本
  - ③ 镜像构建与部署分离，构建产物（镜像 tag）在 job 间传递，部署 job 只拉对应 tag
  - ④ production 加手动审批门（environment: production），staging 自动
  - 与 GitLab CI 区别：GitHub 用 marketplace 复用 action、GitLab 用 include 模板，思路都是"阶段化 + 产物传递"。

```yaml
name: Carbon Assistant CI/CD
on:
  push: {branches: [main, develop]}

jobs:
  build-and-test:
    runs-on: ubuntu-latest
    steps:
    - uses: actions/checkout@v4
    - uses: actions/setup-java@v4
      with: {java-version: '17', distribution: 'temurin'}
    - run: mvn test

  docker-build:
    needs: build-and-test
    runs-on: ubuntu-latest
    steps:
    - uses: actions/checkout@v4          # 必须先 checkout，否则 workspace 为空、context: . 找不到 Dockerfile
    - uses: docker/setup-buildx-action@v3
    - uses: docker/build-push-action@v6
      with: {context: ., push: true, tags: "registry/carbon-assistant:${{ github.sha }}"}

  deploy-staging:
    needs: docker-build
    runs-on: ubuntu-latest
    if: github.ref == 'refs/heads/main'
    steps:
    - name: Rollout status
      run: kubectl rollout status deployment/carbon-assistant -n staging --timeout=180s
```

---

#### 追问：
- 追问1：对比GitLab CI与GitHub Actions，碳管家若同时维护两套流水线，如何避免触发条件与产物标签不一致导致的"构建漂移"？
  - **答**：统一约定与单一真相源。
    - 两套流水线共用同一份版本/标签生成脚本（统一映射 CI_COMMIT_SHA/COMMIT_SHA），避免标签差异。
    - 触发分支与审批策略抽成共享配置文档并双向校验。
    - 优先收敛到一套 CI（如 GitLab 为主、GitHub 仅镜像），或在同仓库用共享变量约束触发条件，每次 PR 校验两份产物 digest 一致。
- 追问2：docker-build阶段用github.sha打标签，当同一commit被多次触发（push+PR同步）时如何防止镜像被重复构建与覆盖？
  - **答**：用内容寻址去重。
    - 构建前计算 Dockerfile+上下文的 hash，若 Harbor 已存在该 digest 则跳过 push。
    - 启用 registry 内容寻址（同 digest 天然幂等，覆盖无害）。
    - 用 concurrency group 按 commit.sha 串行化，避免同一 sha 并发触发两次构建。

### 3. 代码质量保障（SonarQube + Checkstyle）
**重要度**：★★★★

**SonarQube质量门禁**：

| 指标 | 阈值 |
|------|------|
| 代码覆盖率 | 新增代码 > 60%，核心模块 > 80% |
| 重复代码率 | < 3% |
| Bug数 | 0 |
| 安全漏洞 | 0 |
| 代码异味 | < 5% |

**碳管家实践**：每次PR自动触发SonarQube分析，质量门禁不通过则PR不能合并。重点关注API Key泄露检测、SQL注入检测。

---

#### 追问：
- 追问1：LLM调用链路里大量Prompt模板是字符串拼接，SonarQube的SQL注入/密钥检测规则能否覆盖Prompt注入风险，还需补充什么检测？
  - **答**：原生规则不覆盖 Prompt 注入。
    - 用 Semgrep/自定义规则扫描拼接进 Prompt 的位置，标记未参数化拼接。
    - 输入侧加 Prompt 注入检测（正则/分类器识别"忽略上文"等指令）。
    - 密钥检测可覆盖 Prompt 中硬编码 Key，并用 prompt-lint 强制模板占位符化（用 {var} 而非 + 拼接），纳入 code review。
- 追问2：覆盖率要求新增代码 > 60%、核心模块 > 80%，但LangChain4j的流式问答与工具调用代码难以单测，你如何定义"有效覆盖"而不让团队刷覆盖率？
  - **答**：重质量而非行数。
    - 排除流式/异步 IO 层（jacoco exclusions），只对路由/分块/构建逻辑计覆盖率。
    - 用 mutation testing（PIT）验证断言是否有效，防空壳测试。
    - 补充集成测试与 AI 效果测试作为"等效覆盖"，覆盖率门槛仅约束纯逻辑模块。

### 4. 自动化测试策略
**重要度**：★★★★

**测试金字塔**：

```
E2E测试（少量）：核心流程（碳法规问答→结果验证→报告生成）
  ↓
集成测试（中等）：微服务间调用
  ↓
单元测试（大量）：业务逻辑（Prompt构建/分块策略/路由算法）
```

| 类型 | 工具 | 运行时机 |
|------|------|---------|
| 单元测试 | JUnit5 + Mockito | 每次commit |
| 集成测试 | Spring Boot Test + TestContainers | PR合并前 |
| E2E测试 | Playwright + AI评估 | 部署staging后 |
| 性能测试 | JMeter/Gatling | 版本发布前 |
| AI效果测试 | LLM-as-Judge + Golden Dataset | 版本发布前 |

**TestContainers实践**：集成测试使用Docker容器启动MySQL/Redis/Milvus。

---

#### 追问：
- 追问1：AI效果测试用LLM-as-Judge评估RAG回答质量，当Judge模型自身产生偏见或版本升级时，Golden Dataset的判定基线如何保持可信？
  - **答**：固定 Judge 与人工校验。
    - 锁定 Judge 模型版本并纳入制品元数据，升级需重跑基线并 diff。
    - Golden Dataset 保留人工标注的"标准答案/可接受区间"作为硬基线，Judge 仅做软评分。
    - 对 Judge 输出做一致性抽样人工复核，用 kappa 系数监控漂移，异常回退人工判定。
- 追问2：TestContainers启动MySQL/Redis/Milvus做集成测试，Milvus在CI机器上资源消耗大，如何控制测试时长与成本而不牺牲真实性？
  - **答**：按需与并行。
    - 仅 RAG 相关集成测试才起 Milvus，其余用 mock。
    - 用 Milvus 轻量 standalone + 低维向量数据集验证链路而非精度。
    - 复用容器（reuse=true）与分层缓存；必要时用 Milvus Lite 或向量检索 mock 做单测，standalone 仅跑关键路径。
- 追问3：E2E测试"碳法规问答→报告生成"涉及通义千问联网与外部法规库，如何把不确定性的模型输出变成可断言的稳定测试？
  - **答**：用受控与结构化断言。
    - 测试环境指向 mock LLM（固定回答模板）或通义千问测试账号限流。
    - 只断言结构化输出（必含字段、报告章节、数据格式）而非自由文本。
    - 法规库用 staging 脱敏快照，断言"是否引用正确因子编号"；用 LLM-as-Judge 做宽松语义等价判定。

### 5. 灰度发布/蓝绿部署/金丝雀发布
**重要度**：★★★★★

| 策略 | 原理 | 优点 | 缺点 |
|------|------|------|------|
| 蓝绿部署 | 两套环境切换流量 | 零中断、即时回滚 | 双倍资源 |
| 金丝雀发布 | 先给少量流量新版本 | 渐进验证、影响面小、回滚快（权重切回 0 即可） | 需流量切分设施、观察周期长，多版本并行增加资源与测试成本 |
| 灰度发布 | 按比例/条件分流 | 精细控制 | 配置复杂 |

**碳管家金丝雀发布流程**：5%→20%→50%→100%（每步观察2h），异常立即回滚（< 30s）。

---

#### 追问：
- 追问1：金丝雀切到20%时监控发现P99升高但是错误率正常，你如何区分是"模型吐字慢"还是"检索链路变慢"再决定是否回滚？
  - **答**：分段埋点定位。
    - RAG 链路打 span：检索耗时(Milvus)、重排耗时、LLM 首 token 时延(TTFT)、吐字速率。
    - 看 P99 构成——TTFT 正常但吐字慢是模型侧；检索耗时涨是 Milvus/索引。
    - 按归因决策：检索问题回滚或扩容，模型问题评估是否影响 SLA 再定。
- 追问2：碳管家多租户共享一套RAG服务，金丝雀按百分比分流会把同一租户请求打到新旧两版，如何做会话/租户级粘性路由？
  - **答**：按租户/会话染色的粘性路由。
    - 金丝雀路由 key 用 tenantId 或 sessionId 哈希，而非随机百分比，保证同一租户落固定版本。
    - 新版本先对白名单/内部租户开放，再逐步扩大租户集合。
    - 用 Istio 子集 + 基于 header 的路由规则实现租户级 sticky，避免同一会话跨版本。
- 追问3：<30s回滚承诺在数据库schema已随新版本migrate的情况下如何兑现，是否需要对RAG索引变更做向前兼容设计？
  - **答**：索引需向前兼容。
    - DB 迁移采用可向前兼容的增量（加列不删列），回滚时旧代码仍能读写。
    - Milvus collection 变更走"双写双读/别名切换"，旧 collection 保留，回滚仅切回别名不重建。
    - 破坏性变更单独在低峰窗口做，与 <30s 代码回滚解耦，保证回滚不依赖逆向 migrate。

### 6. Git工作流（GitFlow vs Trunk-Based）
**重要度**：★★★★

| 维度 | GitFlow | Trunk-Based |
|------|---------|-------------|
| 分支 | main/develop/feature/release/hotfix | main + 短命feature分支 |
| 合并频率 | 低 | 高（每天合并） |
| CI/CD | release分支触发 | main分支触发 |
| 适用 | 发布周期长 | 持续部署 |

**碳管家采用Trunk-Based**：main始终可部署，feature分支短命1-2天，合并即触发staging部署。

---

#### 追问：
- 追问1：Trunk-Based要求feature分支1-2天合并，但RAG检索策略重构往往需要数周实验，你用什么机制承载长周期实验而不污染main？
  - **答**：用分支外实验+特性开关。
    - 长实验在独立分支/影子服务进行，通过特性开关（如 Nacos routing.strategy）在 staging 逐步验证。
    - 大重构拆成可独立合并的小步（接口抽象+默认走旧实现），用 flag 隔离新路径。
    - 实验结论经 A/B 对比稳定后再默认开启并删 flag，main 始终可部署。
- 追问2：合并即触发staging部署，若两名开发者在10分钟内先后合并，staging会被频繁重建，如何做部署排队与流量仲裁？
  - **答**：串行化与合并部署。
    - CI 用 concurrency group（staging）对同一环境串行，后者排队或合并最近多次 commit 一起部署。
    - 采用"最新优先"——只部署最新 sha，跳过中间。
    - 或设合并窗口（如每 10min 批量）减少重建抖动，重建期间 staging 用旧版本承接流量。

### 7. 基础设施即代码（Terraform + Ansible）
**重要度**：★★★★

**Terraform管理云基础设施**：

```hcl
resource "alicloud_cs_managed_kubernetes" "carbon_cluster" {
  name                  = "carbon-k8s-cluster"
  worker_number         = 3
  worker_instance_types = ["ecs.c6.xlarge"]      # 复数且是 list，不存在单数 worker_instance_type
  worker_vswitch_ids    = var.worker_vswitch_ids  # 节点池所在交换机，需与集群同 VPC/可用区
  kubernetes_version    = "1.30"                  # 1.28 已 EOL，写受支持版本并纳入季度升级窗口
}
```

**Ansible管理K8s应用部署**：

```yaml
- name: Deploy carbon-assistant
  tasks:
  - name: Apply K8s manifests
    kubernetes.core.k8s:
      definition: "{{ lookup('file', 'k8s/{{ item }}') }}"
      loop: [deployment.yaml, service.yaml, configmap.yaml]
```

**碳管家IaC策略**：Terraform管云资源，Ansible管应用配置，所有变更走Git PR→review→apply→可追溯。

---

#### 追问：
- 追问1：Terraform管理阿里云K8s集群，当Milvus需要换更大规格实例类型时，state文件与工作负载中断如何协调以避免线上检索不可用？
  - **答**：滚动替换+state 一致。
    - 用节点池滚动（先加新规格节点池，cordon 旧节点，drain 迁移 Pod），避免整体中断。
    - Terraform apply 前 refresh state，确保 state 与云一致。
    - Milvus 用多副本+反亲和，drain 时保证有副本在线；变更在低谷窗口并配合 HPA。
- 追问2：Ansible loop部署deployment/service/configmap，configmap含通义千问密钥引用，如何保证IaC变更与Vault密钥轮换不出现时序竞态？
  - **答**：解耦密钥注入。
    - ConfigMap 只存非敏感配置，密钥通过 Vault CSI 动态注入（不进 ConfigMap），避免时序依赖。
    - 若必须引用，Ansible 先等待 Vault 轮换完成再 apply，或用 wait_for 校验 secret 存在。
    - 用 External Secrets Operator 同步 Vault→K8s Secret，IaC 只管 Secret 引用，轮换自动生效。
- 追问3：Terraform apply若因provider版本漂移失败，如何在Git PR审批流程里锁定provider版本并保证多环境一致？
  - **答**：锁版本+一致性校验。
    - 用 required_providers 固定 version 约束并提交 `.terraform.lock.hcl`（HCL 格式，不是 .h5）到 Git。
    - CI 对 PR 跑 terraform validate + plan 并强制 lockfile 一致。
    - 多环境共用同一 module 与 version，apply 前 terraform init -lockfile=readonly 防漂移；CI 镜像固定 terraform+provider 版本。

### 8. 容器镜像管理（Harbor + 镜像扫描）
**重要度**：★★★★

**镜像扫描流程**：
1. `docker push` → Harbor接收镜像
2. Harbor触发Trivy/Clair扫描 → 检查CVE漏洞
3. 严重漏洞 → 阻止部署（Admission Webhook校验）
4. 修复漏洞 → 重新构建 → 扫描通过

**碳管家镜像管理**：私有仓库、自动扫描、标签用commit_sha（可追溯）、基础镜像每月更新。

---

#### 追问：
- 追问1：基础镜像每月更新，但RAG服务依赖的特定Milvus client版本只在旧基础镜像里验证过，更新后回归成本如何控制？
  - **答**：依赖与镜像解耦+回归门禁。
    - Milvus client 作为 Maven 依赖锁定版本（不绑基础镜像），基础镜像只提供 JRE。
    - 更新基础镜像后跑 RAG 集成回归（Golden Dataset）作为发布门禁。
    - 依赖扫描只更新基础镜像 OS 层，Java 依赖层不变；保留上一基础镜像 tag 便于快速回退。
- 追问2：Admission Webhook拦截严重CVE，若新上线当天爆出通义千问SDK的0day漏洞，你如何在不停机前提下处理"阻断还是放行"？
  - **答**：风险分级+临时放行。
    - 评估漏洞实际可利用面（暴露面、是否有 PoC），与业务方共担风险决策。
    - 对 0day 加白名单（按 image digest+namespace）临时放行并加监控告警。
    - 同步紧急修复（升级 SDK/rebuild）走快速通道，放行期限制入站流量并加强 WAF，事后复盘补规则。

### 9. 部署策略与回滚
**重要度**：★★★★

**K8s部署与回滚命令**：

```bash
# 滚动更新
kubectl set image deployment/carbon-assistant app=carbon:v2.0

# 金丝雀更新（Istio）
kubectl apply -f canary-virtualservice.yaml

# 回滚
kubectl rollout undo deployment/carbon-assistant              # 回滚上一版本
kubectl rollout undo deployment/carbon-assistant --to-revision=2  # 指定版本
```

**回滚策略**：K8s 原生**没有**"探针失败自动回滚"能力——readinessProbe 连续失败只会让 Pod 变 NotReady 并从 Service Endpoints 摘流，livenessProbe 失败只会重启容器，两者都不回滚 Deployment。真正的回滚手段有：① 手动 `kubectl rollout undo`（基于 `revisionHistoryLimit` 保留的历史 ReplicaSet）；② 渐进式发布工具（Argo Rollouts / Flagger）分析 Prometheus 错误率、延迟指标后触发 `abort` 自动回滚；③ GitOps（Argo CD）回退 Git 中的期望状态。数据库回滚需单独逆向 SQL。回滚时间 < 30s。

---

#### 追问：
- 追问1：你说"探针失败不会回滚"，那 RAG 冷启动加载向量索引需 2 分钟，探针阈值该怎么配才不至于让 Pod 一直 NotReady 摘流、或被 liveness 反复重启？
  - **答**：先纠正前提——探针不回滚，只做摘流量（readiness）/ 重启容器（liveness）。
    - 冷启动用 `startupProbe` 单独管：`failureThreshold × periodSeconds` 覆盖住 2 分钟加载窗口，startup 通过前不跑 liveness/readiness。
    - readinessProbe 配 `initialDelaySeconds` 或依赖 startupProbe，`failureThreshold` 调大并拉长 `periodSeconds`，运行期抖动不会立刻摘流。
    - livenessProbe 的阈值必须比 readiness 宽松得多（否则加载慢会被反复重启，越重启越起不来）。
    - 索引加载进度暴露为 health detail，运维可观测。
  - 若确实要"指标变差自动回滚"，用 Argo Rollouts 的 analysis + abort，而不是配探针。
- 追问2：数据库回滚需单独逆向SQL，而向量索引（Milvus collection）的schema变更能否像Flyway那样向前兼容地回滚？
  - **答**：Milvus 用别名/双写而非逆向。
    - Milvus 无事务回滚，采用创建新 collection + 别名切换，回滚切回旧别名即可，无需逆向。
    - schema 变更遵循加字段不删，旧代码兼容。
    - 用 Flyway 管理 MySQL，Milvus 索引版本用独立元数据表记录，回滚按版本号切别名；新旧 collection 双写一段时间。
- 追问3：Istio金丝雀回滚时新旧版本并存，若用户会话中混用两版检索结果，如何保证回答上下文不出现"幻觉跳变"？
  - **答**：会话级 sticky + 上下文一致性。
    - 同一 sessionId 路由到固定版本，回滚瞬间已建会话仍走原版直至结束。
    - 对话历史存 Redis 按 session，新版本读取同一历史保证上下文化。
    - 必须切换时提示"已切换到新版本"并重置检索上下文避免混合；双版本共享同一 Milvus 索引保证检索结果一致。

### 10. Pipeline优化与缓存
**重要度**：★★★

| 优化手段 | 效果 |
|---------|------|
| Maven依赖缓存 | 构建50%提速 |
| Docker层缓存 | 构建30%提速 |
| 并行Stage | 总时间减少50% |
| 测试分层 | 快速反馈 |
| 增量构建 | 80%构建跳过 |

**碳管家Pipeline**：优化后从21min→9min。

---

#### 追问：
- 追问1：增量构建跳过80%，但RAG系统的Prompt模板与分块策略变更不触发编译，如何把这些"非Java变更"纳入受影响模块识别？
  - **答**：基于依赖图的变更追踪。
    - 把 Prompt 模板/分块策略作为资源文件，构建系统按文件 hash 判断受影响模块。
    - 维护"配置→模块"映射，模板变更触发对应集成测试而非全量。
    - CI 计算变更影响集（change-impact 分析），非 Java 变更也跑相关 RAG 测试，避免漏测。
- 追问2：Docker层缓存提速30%，但每次FROM基础镜像拉取通义千问大模型client体积很大，如何用多阶段构建与镜像预热能进一步压缩？
  - **答**：多阶段+预热缓存。
    - 多阶段构建：构建阶段含 SDK，运行阶段仅 COPY 产物 + JRE，缩小运行镜像。
    - 基础镜像预拉到 CI runner 与 K8s 节点（imagePullPolicy 缓存 / registry mirror）减少拉取。
    - client 若含模型权重，权重放对象存储/挂载 PVC 懒加载不进镜像；用 distroless/ubi 精简层。

### 11. 环境管理策略
**重要度**：★★★

| 环境 | 用途 | 数据 | 配置 |
|------|------|------|------|
| development | 开发调试 | Mock数据 | 开发配置 |
| staging | 集成验证 | 生产脱敏数据 | 类生产配置 |
| production | 真实服务 | 生产数据 | 生产配置 |

**环境隔离**：K8s Namespace、Nacos按环境分组、各环境独立数据库。

---

#### 追问：
- 追问1：staging用"生产脱敏数据"，但碳因子库与法规库脱敏后语义失真，如何保证RAG检索效果验证在staging仍有意义？
  - **答**：保留语义的脱敏+影子验证。
    - 脱敏仅替换 PII（企业名/账号），保留因子数值与法规条文语义。
    - 用生产快照的只读副本做检索效果验证（见追问2）。
    - staging 跑 Golden Dataset 对比召回率，关注相对指标；关键效果放影子流量（生产复制比对）。
- 追问2：各环境独立数据库，Milvus向量索引在staging重建成本高，能否用生产快照的只读副本做staging检索验证？
  - **答**：可，用快照只读副本。
    - 定期从生产 Milvus 做 collection 快照/备份恢复到 staging（只读），避免重建。
    - staging 检索验证直接读副本，验证索引兼容与召回。
    - 写操作走独立 collection；注意脱敏与权限，只读副本限制访问范围。
- 追问3：Nacos按环境分组，当新版本需要同时调通staging与生产两套配置做灰度时，配置维度该如何设计避免串味？
  - **答**：多维命名空间隔离。
    - Nacos 用 namespace 区分环境，group/tenant 区分租户与版本。
    - 灰度配置用独立 group（如 canary），仅金丝雀实例拉取，主流量读 default。
    - 配置 key 带版本后缀或经 @RefreshScope 按路由策略切换；灰度实例通过 label 选择对应 dataId 防串味。

### 12. 配置中心与动态配置
**重要度**：★★★★

**Nacos配置中心**：支持动态刷新（`@RefreshScope`），无需重启服务。配置变更审计，Nacos记录变更历史。

```yaml
routing:
  strategy: qualityFirst        # 可动态切换
rate-limit:
  tenant-default-qps: 100       # 可动态调整
```

---

#### 追问：
- 追问1：routing.strategy用@RefreshScope动态切换，若切换瞬间正在进行的流式回答已按旧策略路由，如何避免半路改策略导致的回答错乱？
  - **答**：请求级快照+不中途变。
    - 路由策略在请求入口读取并绑定到该请求上下文，整轮对话用同一份。
    - @RefreshScope 只影响新请求，进行中请求用已捕获的旧值。
    - 流式回答持有请求开始时的 strategy 引用，不读动态 bean；切换后给在途请求宽限完成再全量生效。
- 追问2：tenant-default-qps动态调整，但RAG检索受Milvus与LLM双重限流，单维QPS能否真实反映租户成本，是否需按token计量？
  - **答**：需多维权衡。
    - QPS 只反映请求数，RAG 成本更在于 token（检索向量数 + LLM 输入输出 token）。
    - 限流改为复合维度：QPS 上限 + tokens/s 配额 + 并发数。
    - 按租户统计 token 消耗计入成本/计费，动态调 qps 时同步调 token 预算；用 Redis 令牌桶对 token 维度限流。

### 13. 制品管理与版本追溯
**重要度**：★★★

**制品仓库**：Harbor(Docker镜像) + Nexus(JAR包) + MinIO(报告模板)

**追溯链**：Git commit → CI构建 → Docker镜像(commit_sha) → Harbor → K8s部署(commit_sha) → 可追溯到代码变更

---

#### 追问：
- 追问1：commit_sha追溯链到K8s部署，但RAG回答质量还依赖Milvus索引版本与模型版本，这两者如何一并纳入制品追溯？
  - **答**：扩展追溯元数据。
    - 部署时把 Milvus 索引版本（collection alias/版本号）、embedding 与 LLM 模型版本写入部署元数据（annotation/labels）。
    - 每次回答在日志/链路里带 request_id + code_sha + index_version + model_version，可回溯。
    - 制品仓库关联 index/model artifact 版本，形成"代码+数据+模型"三要素追溯链。
- 追问2：MinIO存报告模板，当模板更新而历史报告需重新生成时，如何绑定"报告模板版本"与"生成时的代码版本"做可复现追溯？
  - **答**：模板版本化+快照绑定。
    - 报告模板按版本入库（MinIO 对象带版本号/etag），生成时记录所用模板版本。
    - 报告元数据同时记 code_sha 与 template_version，重建按原版本取模板与代码。
    - 用不可变对象存储版本控制，历史模板不被覆盖；报告 PDF 内嵌生成指纹（sha+模板版）便于审计复现。

### 14. 监控与告警集成到CI/CD
**重要度**：★★★★

**部署后自动验证（Smoke Test）**：

```yaml
deploy-production:
  script:
    - kubectl rollout status deployment/carbon-assistant --timeout=120s
    - sleep 10
    - curl -f https://carbon.example.com/actuator/health
    - python smoke_test.py
    - python monitoring_check.py
```

**自动回滚条件**：健康检查失败/冒烟测试失败/监控指标异常（错误率>10%/P99>10s）。

---

#### 追问：
- 追问1：冒烟测试curl health通过但RAG实际检索返回空，如何把"能回答"而不仅是"服务活着"作为部署后自动验证的通过条件？
  - **答**：语义级冒烟。
    - smoke_test 发真实问答请求（如"什么是CBAM"），断言返回含有效因子/非空且未触发降级。
    - 校验检索链路：top-k 召回数 > 0、Milvus 可达、embedding 服务正常。
    - 对回答做轻量结构断言（含关键实体），失败即回滚；用已知 Golden 问题集抽样验证"能回答"。
- 追问2：错误率>10%触发自动回滚，但大模型偶发超时本就波动，如何设定滑动窗口与基线比对避免正常抖动引发误回滚？
  - **答**：动态基线+滑动窗口。
    - 用滑动窗口（如 5min）统计错误率，结合历史同期基线设阈值。
    - 区分可重试错误（超时）与真实故障（5xx 激增），仅后者触发。
    - 设最小样本量（窗口内 > 100 请求）防小流量误判；连续多窗口超基线才回滚，单次尖峰忽略。
- 追问3：监控指标异常回滚依赖监控数据回流CI，监控与部署系统间如何做身份鉴权与回滚权限隔离防止越权？
  - **答**：最小权限+服务账户。
    - 监控组件用独立 ServiceAccount，仅被授予"触发回滚"的限定权限（RBAC scoped 到特定 deploy）。
    - CI 与监控间用短期 token/mTLS 互信，回滚动作走审计日志。
    - 回滚接口与部署接口分离，监控只能调回滚不能改镜像；关键回滚设二次确认或限频防连锁误触发。

### 15. 数据库变更管理
**重要度**：★★★★

**Flyway/Liquibase版本管理**：

```sql
-- V2.0__add_emission_factor_version.sql
ALTER TABLE emission_factor ADD COLUMN version INT DEFAULT 1;
ALTER TABLE emission_factor ADD COLUMN valid_from DATE;
```

**变更流程**：SQL脚本→Git提交→PR Review→CI验证(staging)→生产自动migrate。**回滚不能靠"逆向 SQL 脚本"自动执行**——Flyway 社区版没有 undo（undo 是 Teams/Enterprise 特性），只能新增一个前滚修复脚本（如 `V2.1__fix_xxx.sql`）把变更改回去，或直接恢复备份；确实需要按版本回退可用 Liquibase 的 `rollback` + tag（rollback 块需手写）。

**最佳实践**：每个变更必须增量式（ALTER不DROP），禁止破坏性变更。

---

#### 追问：
- 追问1：emission_factor加version列，老数据valid_from为NULL如何与RAG检索时的"因子时效"逻辑兼容而不污染结果？
  - **答**：默认时效边界。
    - 检索时因子时效以 valid_from 为准，NULL 视为"历史全期有效/起始日之前版本"。
    - 查询带"适用日期"参数，valid_from IS NULL 或 <= 适用日且 version 当前有效则命中。
    - 数据迁移给老数据补 valid_from 默认值（如建表日）保持逻辑一致；RAG 拼装标注因子版本避免混用。
- 追问2：禁止破坏性变更，但Milvus collection重建相当于破坏性，RAG索引变更如何用"双写双读"平滑迁移而非直接ALTER？
  - **答**：双写双读+别名切换。
    - 建新 collection（new），旧（old）保留。
    - 写入双写 new+old，读取按版本/流量比从 new 逐步切。
    - 校验 new 召回一致后 alias 从 old 切到 new；观察期后停 old 写入并下线，全程可切回 old 无破坏。
- 追问3：生产自动migrate若失败在中间状态（部分租户已migrate），如何做到按租户粒度的可暂停与可补偿回滚？
  - **答**：分租户幂等迁移。
    - migrate 按租户分批，每批幂等（可重跑），失败仅影响当前批。
    - 记录每租户迁移状态表，支持暂停/继续。
    - 补偿按已迁移租户执行"前滚修复脚本"（Flyway 社区版无 undo，逆向要落成新的 V{n+1} 脚本），未迁移不动；用 Saga/状态机管理，超时自动补偿保证最终一致。

### 16. 密钥管理（Vault）
**重要度**：★★★

**HashiCorp Vault管理敏感信息**：

```yaml
kind: SecretProviderClass
spec:
  provider: vault.csi.k8s.io      # 写 provider: vault 会报 "provider not found"
  parameters:
    vaultAddress: "https://vault.internal"
    roleName: "carbon-assistant"              # Vault K8s auth 里绑定的 role，必填
    vaultKubernetesMountPath: "kubernetes"    # Vault 中 kubernetes auth 的挂载路径
    objects: |
      - objectName: "openai-api-key"
        secretPath: "secret/carbon/ai"
        secretKey: "api-key"
```

**碳管家密钥管理**：所有API Key/密码存入Vault，K8s通过CSI Driver动态注入，90天自动轮换，Vault记录访问日志。

---

#### 追问：
- 追问1：通义千问API Key 90天自动轮换，轮换瞬间正在进行的流式对话若持有了旧Key，如何做到无感切换不中断回答？
  - **答**：双 Key 并行期。
    - 轮换采用重叠窗口——新 Key 生效前旧 Key 仍有效一段时间（如 24h）。
    - 客户端支持 Key 列表/自动重试换 Key，流式进行中请求用旧 Key 完成，新请求用新 Key。
    - Vault 注入多 Key，代码按优先级尝试；轮换后监控旧 Key 残留流量，清零再吊销。
- 追问2：Vault记录访问日志，但RAG服务每请求都读Key会产生大量日志，如何在审计完整性与性能开销间权衡？
  - **答**：缓存+抽样审计。
    - K8s CSI 注入 Secret 为文件/内存，服务启动时读一次并缓存，不在每请求访问 Vault。
    - 访问日志只在 Key 读取/轮换时记，不记每次使用。
    - 审计关注"谁在何时轮换/读取"而非每次调用；高频场景关细粒度日志，保留安全事件审计。

### 17. 构建安全（SBOM与签名）
**重要度**：★★★

**SBOM生成**：`mvn cyclonedx:makeBom` → bom.xml（所有Maven依赖及版本）

**镜像签名（Cosign）**：`cosign sign --key cosign.key registry/carbon-assistant:v2.0`

**碳管家安全流水线**：构建 → SBOM生成 → Trivy漏洞扫描 → Cosign签名 → 部署前验证签名

---

#### 追问：
- 追问1：SBOM只覆盖Maven依赖，而RAG系统运行时还会拉取Python侧向量库或模型文件，这部分供应链如何纳入SBOM？
  - **答**：扩展 SBOM 范围。
    - 用 Syft 等工具对镜像整体扫描（含 OS 包、Python 依赖）生成 SBOM，而非仅 Maven。
    - 模型文件记录 hash/来源 URL/许可证纳入 SBOM 元数据。
    - 运行时拉取的向量库若在镜像内则被覆盖，若外部下载则在部署清单记录来源并校验；CI 统一生成多语言 SBOM 合并归档。
- 追问2：Cosign签名验证在部署前，但若攻击者篡改了部署清单里的镜像digest以外字段（如env），签名能否覆盖这类篡改？
  - **答**：签名应覆盖整个清单。
    - Cosign 可对 manifest/blob 签名，篡改任何字段都会使签名校验失败（若签名对象是整份 yaml 而非仅 image）。
    - 建议用 cosign 对 K8s manifest 签名或用 Sigstore 策略校验整个部署对象。
    - 部署前用 policy controller（如 Kyverno）验证签名+字段完整性；仅签 image digest 不够，需签部署 artifact 整体。

### 18. 性能测试集成
**重要度**：★★★★

**Gatling性能测试脚本**：

```scala
class CarbonAssistantSimulation extends Simulation {
  val httpConf = http.baseUrl("https://carbon.example.com")   // Gatling 3.x 是小写 baseUrl（2.x 的 baseURL 在 3.x 编译不过）

  val scn = scenario("Carbon Query")
    .exec(http("ask_regulation")
      .post("/api/chat")
      .body(StringBody("""{"question":"什么是CBAM?","tenantId":"tenant1"}"""))
      .check(status.is(200)))

  setUp(scn.inject(
    rampUsersPerSec(10) to 500 during (60.seconds)  // 10→500 QPS
  ).protocols(httpConf))
}
```

**性能门禁**分两层，不能拿同一个 P99 卡 RAG 问答：

| 层次 | 门禁 |
|------|------|
| 接口层 | 首字时延 TTFT P95 < 2s、HTTP 5xx 错误率 < 1%、QPS > 500 |
| 生成层 | 完整回答 P95 < 30s（按 token 吞吐评估容量），超时率 < 2% |

---

#### 追问：
- 追问1：Gatling打到500 QPS的性能门禁，但RAG回答耗时主要花在LLM推理而非接口，如何用token吞吐而非QPS更真实衡量容量？
  - **答**：以 token 吞吐为容量指标。
    - 统计输入+输出 token/s（TPS）作为真实负载，因 LLM 按 token 计费与耗时。
    - 压测按"并发会话×平均对话长度"构造 token 流量，门禁设 TP99 时延与最大 TPS。
    - 同时监控 Milvus QPS 与 LLM provider 配额，容量瓶颈在 token 而非 HTTP QPS；用 token 维度设限流与扩容阈值。
- 追问2：性能测试用"什么是CBAM"固定问题，无法反映真实长上下文检索，如何用真实脱敏语料做有代表性的压测？
  - **答**：真实语料回放。
    - 从生产日志抽取高频真实问题+对话上下文（脱敏）构造成压测样本集。
    - 覆盖长文档/多轮/复杂检索场景，按分布加权。
    - 用生产脱敏向量库做检索，反映真实索引规模与时延；门禁看 P99 检索+生成时延分布，验证长上下文路径。

### 19. Chaos Engineering（混沌工程）
**重要度**：★★★

**碳管家Chaos Engineering实践**：
- 网络故障：随机切断Pod间网络 → 验证熔断/降级是否生效
- 资源压力：CPU/Memory压力注入 → 验证HPA扩缩是否正常
- 依赖故障：模拟Milvus/Redis不可用 → 验证降级策略是否有效
- 节点故障：随机杀掉K8s节点 → 验证Pod迁移是否正常

**工具**：Chaos Mesh（K8s混沌工程平台）。演练环境分两级：**日常在 staging 演练**（全量故障注入），**生产只在低峰期做小范围灰度演练**（限流/单可用区、需审批与回滚预案），两者爆炸半径与审批要求不同。

---

#### 追问：
- 追问1：模拟Milvus不可用时降级策略返回"检索暂不可用"，但用户仍期待AI回答，降级到纯LLM模式如何保证不编造碳因子数据？
  - **答**：受限降级+明确告知。
    - 纯 LLM 模式加 system 约束：不得编造具体碳因子数值，超出知识则说明"未检索到权威数据"。
    - 回答标注"检索降级，结果仅供参考"。
    - 对涉及法规/因子强事实的问题，降级直接婉拒并引导人工/重试；用置信度与引用缺失检测，缺数据禁止给具体数字。
- 追问2：Chaos Mesh 主要在 staging 演练，但 staging 数据规模远小于生产，故障恢复结论能否外推到生产百万级向量的场景？
  - **答**：规模相关需补充论证。
    - staging 结论验证"机制"正确（熔断/降级生效），但时延/恢复时间不能外推。
    - 生产用影子流量或按比例放大向量规模做专项压测验证恢复 SLA。
    - 对 Milvus 恢复做容量模型估算（恢复时间随向量量增长）；关键故障在生产低峰小范围灰度演练+监控。
- 追问3：随机杀K8s节点验证Pod迁移，但RAG有本地向量缓存，迁移后缓存预热期间延迟骤升，如何把"预热"也纳入混沌演练指标？
  - **答**：把预热作为恢复指标。
    - 演练后监控缓存命中率回升曲线与 P99 回落时间，作为恢复完成判据。
    - 引入预热策略（启动即预热热点向量/惰性加载）缩短空窗。
    - 混沌指标加入"冷启动→预热完成"时延，达标才算演练通过；对比有/无预热副本量化缓存价值并设 SLO。

### 20. DevOps成熟度评估
**重要度**：★★★

**碳管家DevOps成熟度自评**：

| 维度 | L1(初始) | L2(管理) | L3(定义) | L4(度量) | L5(优化) |
|------|---------|---------|---------|---------|---------|
| CI/CD | 手动部署 | 自动CI | 自动CD | 灰度发布 | 持续部署 |
| 测试 | 手动测试 | 单元测试 | 自动化测试 | 性能测试 | Chaos Engineering |
| 监控 | 无监控 | 基础监控 | 全链路监控 | 告警自动化 | 自动扩缩 |
| 安全 | 无扫描 | 依赖扫描 | 镜像扫描 | 密钥管理 | SBOM+签名 |
| IaC | 手动配置 | 脚本化 | Terraform | GitOps | 自愈系统 |

**碳管家当前水平**：L3-L4（自动CD+灰度发布+全链路监控+密钥管理），目标是L5（持续部署+Chaos Engineering+自愈系统）。

---

---

#### 追问：
- 追问1：从L3-L4迈向L5持续部署，RAG的"模型效果回归"尚未像单元测试那样可信自动化，这个瓶颈如何突破才算真正L5？
  - **答**：效果回归自动化可信。
    - 建立稳定的 Golden Dataset + LLM-as-Judge 基线（锁定 Judge 版本），每次发布自动跑效果回归并设门禁。
    - 模型/索引变更走影子对比，效果不退化才进持续部署。
    - 把"效果回归通过率"纳入发布准入，与单测同级；效果回归可全自动且可信才算 L5 持续部署。
- 追问2：评估表里"IaC自愈系统"指什么，碳管家能否在Milvus节点故障后自动重建索引并校验一致性，而非仅重启Pod？
  - **答**：自愈=检测→重建→校验闭环。
    - 自愈系统监控 Milvus 节点健康，故障自动触发新节点加入并重建/加载索引（从备份或副本）。
    - 重建后跑一致性校验（向量数/checksum 比对）再接流量。
    - 用 IaC（Terraform/Ansible）+ Operator 实现声明式自愈，异常自动 reconcile；不止重启 Pod，而是数据层自愈+校验达成 L5。

---

> 适用岗位：AI开发负责人（碳管理SaaS方向）
> 背景：积木LCA云平台/碳管家AI助手（Spring Boot 3 + Spring AI + LangChain4j + Milvus RAG系统）
### 21. 什么是 GitOps？它与传统的“推式”CI/CD 有何本质区别？
**重要度**：★★★★


考点：声明式期望状态、Git 作为唯一事实来源（Single Source of Truth）、Argo CD / Flux 的拉式（pull-based）同步机制。

参考答案：GitOps 把集群的期望状态以声明式清单（Kubernetes YAML / Helm / Kustomize）托管在 Git 仓库中，由运行在集群内的 Operator（如 Argo CD、Flux）周期性地拉取（pull）最新配置并与实际状态对账（reconcile），自动纠正漂移。传统推式流水线由 CI 在构建后通过 `kubectl apply` 主动推送到集群，权限外置、难以感知后续漂移。GitOps 的核心价值是“Git 即真相、集群自愈、全量审计（每次变更都有 commit）”。

深度解析：拉式架构将部署凭证保留在集群内部，CI 只需写 Git 而非直连生产，安全性更高；Argo CD 的 `sync` 与 `health` 状态可直观展示 reconcincile 结果。配合 PR 审批 + Image Updater 可实现渐进式发布。

易错点：误以为 GitOps 只是“把 YAML 放 Git”，忽略对账循环与漂移检测；把 Argo CD 当纯部署工具而非状态协调器；混淆 pull（集群主动拉）与 push（CI 主动推）。

#### 追问：
- 追问1：Argo CD 出现配置漂移（drift）时会怎样处理？
  - **答**：默认进入 `OutOfSync` 状态，可设为自动 sync 自动纠正，或 `self-heal` 模式强制拉回期望状态；若设 manual 则需人工 sync。
- 追问2：GitOps 下如何控制发布节奏而非一次性生效？
  - **答**：配合 Argo Rollouts 做金丝雀/蓝绿，或 Flux + Flagger 按指标渐进切流，再回写 Git 完成最终状态固化。

### 22. 蓝绿部署与金丝雀发布如何做流量切分与自动回滚？
**重要度**：★★★★


考点：Blue/Green 全量切换、Canary 按权重渐进切流、基于指标的自动回滚（automated rollback）。

参考答案：蓝绿部署维护两套全等环境，流量经 LB/Ingress 一次性切到 Green，出问题切回 Blue，切换快但资源翻倍、无渐进验证。金丝雀发布先把 1%~5% 流量导到新版本，依据错误率、延迟、业务指标逐步放大至 100%，异常则自动回滚。现代实现多用 Service Mesh（Istio 权重路由）或 Argo Rollouts 的 `setCanaryScale` + Analysis 关联 Prometheus 指标触发 `rollback`。

深度解析：自动回滚依赖客观信号而非人工观察——Prometheus 报警、错误率阈值、p99 延迟。Canary 比蓝绿更省资源且风险可控，但要求服务无状态、可多版本并行。回滚本质是“取消新版本权重”，而非删 Pod。

易错点：数据库 schema 不兼容时切流也无法回滚；蓝绿误删旧环境导致无退路；把“部署成功”等同于“发布成功”，缺少健康检查与指标卡点。

#### 追问：
- 追问1：蓝绿部署能否复用同一数据库？
  - **答**：可共享，但必须保证 schema 向后兼容（新版本读旧结构），否则回滚会损坏数据；建议 DB 变更独立、可向前/向后兼容。
- 追问2：金丝雀发现错误率超标，回滚会丢失已收到请求吗？
  - **答**：正在处理的请求可能中断；用连接 draining + 优雅停机（graceful shutdown）降低影响，回滚仅停止新流量导入。

### 23. 如何设计一条高效的 CI 流水线（阶段划分、并行与缓存、快速失败）？
**重要度**：★★★★


考点：阶段（stage）划分、并行作业、构建缓存、fail-fast 策略。

参考答案：典型 CI 分五阶段：拉取代码→静态检查（lint/格式）→构建与单元测试→集成与端到端测试→制品推送（若把"拉取代码"当前置步骤，则后四段为静态检查、构建单测、集成 E2E、制品推送）。原则：耗时短的卡点靠前（lint、单测）实现 fail-fast；相互独立阶段并行执行；对依赖（`node_modules`、`.m2`、`~/.cache`）做缓存避免重复下载；构建产物在 stage 间传递而非重建。单测失败立即终止，不浪费集成测试算力。

深度解析：用 Docker layer cache 或 remote cache（BuildKit、Gradle `--build-cache`）显著提速；用 matrix 并行多语言/多版本测试；流水线即代码（GitLab CI `.gitlab-ci.yml`、GitHub Actions）保证可复现。缓存键应按 `lockfile` 内容哈希，避免脏缓存。

易错点：缓存键设计不当导致依赖未更新；把所有测试串行跑拖慢反馈；忽略流水线自身耗时监控，CI 成瓶颈；在 CI 内嵌密钥明文。

#### 追问：
- 追问1：单测和集成测试应该都进 CI 吗？
  - **答**：单测必须每次提交跑（快、fail-fast）；集成/端到端可放合并后或定时跑，或仅对主干跑，平衡速度与覆盖。
- 追问2：如何防止缓存污染？
  - **答**：缓存键绑定依赖锁文件哈希，区分分支或设 TTL；构建镜像用内容寻址层，避免相同 tag 覆盖造成的不可复现。

### 24. 制品仓库（Nexus/Harbor）为什么要求“不可变制品”？版本该如何管理？
**重要度**：★★★


考点：不可变制品（immutable artifact）、语义化版本、制品溯源与去重。

参考答案：不可变制品指一旦发布，其内容与 digest（sha256）永久不变，禁止覆盖同名版本。这样可保证“测试通过的包=生产部署的包”，避免依赖漂移与“昨天能跑今天挂”。Nexus 管理 Maven/npm/PyPI 等通用制品，Harbor 专注容器镜像并支持镜像签名与漏洞扫描。版本用 SemVer（major.minor.patch），CI 生成唯一构建号或 commit SHA 作为后缀，禁用 `latest` 作为发布标识。

深度解析：Harbor 可开启“不可变 tag”策略与内容信任（Notary/cosign 签名），配合 OCI 标准确保跨环境一致。制品应关联 SBOM（软件物料清单）实现溯源与合规审计。生产仅允许从仓库拉已扫码通过的版本。

易错点：用 `latest` 标签发布导致环境不一致且无法回滚到确定版本；以为 push 到仓库即可，忽略漏洞扫描与签名验证；制品无唯一 digest 造成“同 tag 不同内容”。

#### 追问：
- 追问1：镜像 tag 用 commit SHA 还是构建号更好？
  - **答**：两者皆唯一，commit SHA 更易溯源代码，构建号利于追踪 CI 运行；推荐 `v1.2.3-<sha>` 组合，人工可读且可定位。
- 追问2：Harbor 如何防篡改？
  - **答**：启用内容信任对镜像签名，拉取侧校验签名；设不可变 tag 规则禁止重写；开启漏洞扫描阻断高危镜像晋级。

### 25. 自动化测试在流水线中应如何分层（单元/集成/端到端）与设置卡点？
**重要度**：★★★★


考点：测试金字塔、各层占比、卡点（quality gate）位置。

参考答案：遵循测试金字塔：单元测试占 70% 以上、运行秒级、每次提交必跑；集成测试约 20%、验证模块协作与依赖（DB/缓存）；端到端约 10%、慢且贵、可仅对主干/PR 跑。卡点设置：单测失败阻断合并；**新增代码行覆盖率 < 60%（核心模块 < 80%）阻断**（口径全章统一，存量代码按基线豁免、只卡增量）；集成测试失败阻断晋级 staging；E2E 失败阻断生产发布。比例失衡（倒金字塔）会让流水线又慢又脆。

深度解析：用 JaCoCo / coverage.py 输出覆盖率报告并接入门禁；契约测试（Pact）可在集成层替代部分 E2E，降低对完整环境的依赖。E2E 建议用容器化环境或预览环境（preview env）按需拉起，跑完即销毁。

易错点：把大量断言塞进 E2E 导致反馈慢、易误报；卡点阈值拍脑袋定，团队抵触；只在 CI 跑测试却不在本地提供同等能力，造成“CI 红本地绿”。

#### 追问：
- 追问1：覆盖率 100% 是否等于质量高？
  - **答**：不等于。覆盖率只衡量代码被执行，不验证断言正确性；应关注分支覆盖与变异测试，更看重有效断言而非数字。
- 追问2：服务多、E2E 太慢怎么办？
  - **答**：用契约测试拆分依赖、并行化用例、按需拉起预览环境，或对核心链路做关键路径 E2E，其余下沉到集成层。

### 26. 基础设施即代码（Terraform/Ansible）如何保证多环境一致性？
**重要度**：★★★★


考点：IaC 声明式/命令式差异、模块复用、状态管理、环境一致性。

参考答案：Terraform 用声明式 HCL 描述云资源，通过 `plan`（预览变更）与 `apply`（执行）保证结果与代码一致，状态文件 `terraform.tfstate` 记录真实资源映射。Ansible 偏命令式配置管理（playbook 幂等）。一致性的关键是：用 module/role 复用、用 `variable` + `tfvars` 区分环境、把状态远端存储（S3+ DynamoDB 锁）避免本地漂移。环境差异只体现在变量，不复制整套代码。

深度解析：Terraform workspace 或目录分离（env/dev、env/prod）管理多环境；state 远端锁防止并发破坏；用 `terraform plan` 做 CI 卡点审核。Ansible 用 inventory 分组区分环境，幂等任务保证重复执行结果相同。

易错点：把 state 文件提交进 Git 或放本地，导致团队冲突与密钥泄露；手动在控制台改资源制造“配置漂移”未被 IaC 收回；环境用 copy-paste 而非变量，差异难控。

#### 追问：
- 追问1：Terraform 状态被手动改了怎么办？
  - **答**：用 `terraform state` 命令修正或 `import` 重新纳入管理；若漂移严重需要重建，用 `terraform apply -replace=alicloud_instance.web[0]`（独立的 `terraform taint` 自 0.15.2 起已废弃，别再教这个用法）。根本解是禁止控制台手动变更。
- 追问2：Terraform 和 Ansible 怎么分工？
  - **答**：Terraform 管“资源存在”（VM、网络、RDS），Ansible 管“资源内部配置”（装软件、改配置），二者常配合：先 TF 建机再 Ansible 配置。

### 27. 流水线质量门禁应包含哪些（覆盖率/代码扫描/安全扫描）？如何避免误伤？
**重要度**：★★★★


考点：质量门禁（quality gate）、SAST/DAST、误报治理、门禁分级。

参考答案：门禁通常包括：单元测试通过率、覆盖率阈值、静态代码扫描（SAST，如 SonarQube、Semgrep）、依赖漏洞扫描（SCA，如 Trivy）、容器镜像扫描、可选 DAST。为避免误伤：分级门禁——硬性阻断（编译失败、严重漏洞、单测挂）必须过；柔性告警（坏味道、低危漏洞）仅评论不阻断；误报加入白名单/抑制规则并留审计记录；按历史基线渐进提升阈值，避免一次性卡死团队。

深度解析：SonarQube Quality Gate 可基于覆盖率新增代码、重复率、漏洞等级设定；Trivy 扫描基础镜像 CVE 并阻断 CRITICAL。门禁应在 PR 阶段就反馈，而非合并后才发现。

易错点：门禁过严（全部阻断）导致开发者绕过或关 CI；门禁只在主干跑，PR 无反馈；把扫描结果当“数字游戏”刷指标不修根因。

#### 追问：
- 追问1：SAST 误报高怎么处理？
  - **答**：用规则调优 + 精准抑制（带理由注释），沉淀团队白名单，定期复盘误报模式，避免“一刀切关规则”削弱防护。
- 追问2：安全扫描该放 CI 还是单独阶段？
  - **答**：轻量 SAST/SCA 进 PR 卡点快速反馈；重镜像/DAST 可放合并后或定时，避免拖慢每次提交。

### 28. 回滚策略如何兼顾数据库变更兼容性？怎样做灰度迁移？
**重要度**：★★★★


考点：向后兼容（backward compatible）schema 变更、expand/contract、灰度迁移。

参考答案：应用回滚简单（切流量/重发旧版本），但数据库若已被新 schema 写入则旧代码可能读失败。做法是“先扩后收”（expand/contract）：第一阶段只加列/加表（expand），新旧版本都能跑；观察稳定后再删旧列（contract）。所有变更必须向后兼容：避免 `NOT NULL` 直接加、避免删被旧版使用的列。灰度迁移用双写或回填脚本，数据迁移与代码发布解耦。

深度解析：采用非破坏式迁移（如添加可空列、默认值的填充列）；用 feature flag 控制新逻辑，出问题仅关 flag 不回滚代码；大表变更用在线 DDL（pt-osc、gh-ost）避免锁表。回滚预案要先验证“旧应用 + 新库”组合可用。

易错点：把 DB 变更和代码同一次发布且不可拆分，导致无法独立回滚；直接在产品库执行 `ALTER` 锁表；假设回滚只是重发旧镜像而忽略数据已不兼容。

#### 追问：
- 追问1：新增字段设为 NOT NULL 会出什么问题？
  - **答**：旧版本插入会失败（无默认值）；应加默认值或先允许 NULL，待新版本全量后再收紧约束。
- 追问2：feature flag 和蓝绿回滚如何配合？
  - **答**：flag 控制新逻辑开关，回滚时只关 flag 即可隐藏新功能，不触发数据/版本回退，风险更低、更快收敛。

### 29. 灰度发布有哪些主流策略？金丝雀发布与蓝绿部署在流量切分和回滚上有什么区别？
**重要度**：★★★★


考点：灰度/金丝雀/蓝绿、流量切分、回滚成本。

参考答案：主流策略：蓝绿（两套全量环境，流量整体切换）、金丝雀（小比例流量先放新版本，逐步放大）、灰度按用户标签/地域分流。金丝雀用网关按权重（如 1%→5%→100%）或按 `userId hash` 切分，异常即把权重回 0，回滚秒级。蓝绿切换是「整流量搬移」，回滚也只切路由，但需双倍资源。

深度解析：金丝雀适合验证新功能正确性，能精准控制爆炸半径；蓝绿适合「必须整体一致」的切换，回滚几乎零停机但资源翻倍。流量切分依赖网关（Nginx/Spring Cloud Gateway/Istio）的路由权重，需保证同一用户落到同一版本（sticky session）避免体验跳变。

易错点：灰度时未做「会话/数据兼容」，老版本读新版本写入的数据结构报错；或回滚只切了应用没回滚 DB  schema，导致旧代码不兼容。

#### 追问：
- 追问1：金丝雀放量的指标怎么定？
  - **答**：看错误率、RT P99、CPU，及业务指标（下单成功率）。设定阈值（如错误率>1%自动回滚），配合监控告警做自动熔断。
- 追问2：蓝绿和金丝雀能否共用？
  - **答**：可组合：先蓝绿切到「绿环境」，再在绿环境内做金丝雀小流量验证，兼顾安全与资源效率。


---
