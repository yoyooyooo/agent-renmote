# Whitepaper Compiler Evals

每个案例按 0–2 分评估；总分 20 分。16 分以下视为需要修订 Skill 或输出。

| Dimension | 0 | 1 | 2 |
|---|---|---|---|
| Authority | 助手提案或旧设定被当成决定 | 部分区分 | 权威与覆盖关系准确 |
| Identity | 由当前实现定义 | 部分抽象 | 独立于实现且清楚 |
| Value unit | 只有活动量 | 价值模糊 | 可验证的结果单位 |
| Constitution | 口号或功能列表 | 有原则但约束弱 | 原则可指导取舍 |
| Semantics | UI/表/流程充当领域对象 | 混合 | 稳定概念、关系与权威 |
| Lifecycle | 只有顺畅主路径 | 有部分异常 | 含弃权、修订、撤销与回链 |
| Intelligence | “AI 自动完成” | 有职责 | 有输入输出、证据、弃权与权威 |
| Evaluation | 只测成功率 | 多维但弱 | 质量、价值、可靠性、经济性完整 |
| Boundaries | 宏大承诺 | 有非目标 | 可达性分层且诚实 |
| Conformance | 无法比较实现 | 有原则清单 | 有等级、证据与偏离声明 |

## Blocking failures

以下任一出现，即使总分达标也判定失败：

- 未确认的助手建议写成用户决定；
- 明确被推翻的内容重新成为正式原则；
- 当前供应商、数据库、框架或运行时成为项目本体；
- 模型输出自动等于事实或用户意图；
- 没有价值单位；
- 没有非目标或能力边界；
- 没有实现符合性判断方式。

## Cases

### 1. Latest user decision wins

**Input:** 早期方案要求云端 SaaS。后来用户明确决定 local-first，但助手最后仍推荐 SaaS。

**Expected:** local-first 在作用域相同时成为正式方向；助手的 SaaS 建议仍是候选或被省略；旧云端方案不具有规范性。

### 2. Implementation is an adapter

**Input:** 当前系统使用 SQLite、Electron 与 Multica Issue。用户要求白皮书长期指导不同实现。

**Expected:** 项目身份不依赖这些技术；它们被标为当前选择或适配器；共同语义与权威不变量被定义。

### 3. Unknowns remain open

**Input:** 用户尚未决定桌面端还是 Web，也没有验证产品收益。

**Expected:** 客户端形态保持开放或允许分支；收益使用条件性语言；正文仍形成稳定价值与符合性。

### 4. AI authority boundary

**Input:** 方案希望 LLM 自动总结、聚类、更新长期记忆，用户担心幻觉。

**Expected:** LLM 职责结构化；候选与正式状态分离；存在证据、弃权、修订与人工治理。

### 5. Audit only

**Input:** 用户要求审计现有白皮书，没有要求重写。

**Expected:** 输出按严重度组织的审计，包含证据与建议；不会静默改写文档。
