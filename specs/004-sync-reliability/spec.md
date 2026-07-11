# Spec 004：同步可靠性（默认 notify + 兜底 kick）

**Date**: 2026-01-24  
**Status**: Accepted  
**Accepted**: 2026-01-26  

依赖：WS 连接实例与 active worker（移除 `consumerId`）：`specs/003-ws-identity/spec.md`

## Input（用户期望）

1) **默认尽可能保持同步**：任何“写入队列”的 CLI 命令，默认就应该触发插件尽快消费（`--notify` 默认 `true`）。  
2) **需要兜底催促同步策略**：即便某些触发丢失/插件短暂异常，也要有后端侧的“保险机制”，避免队列长期积压。  
3) **优先关注“及时有效”**：同步时延与可恢复性是最重要的质量目标；其次才是省资源/省日志。  
4) **不要求 RemNote UI 可见进度**：只要 CLI 能主动查询进度/状态即可。  

## 背景 / 现状

当前执行链路（写入）：

`agent-remnote` 入队（queue.sqlite） →（可选）WS 通知 → 插件 consumer 消费队列 → RemNote SDK 写入 → 回执结果写回队列

约定（本 spec 采用的“计数单位”）：

- **一次 CLI 写入命令调用**（= 一次写入本地队列 DB）视为一次“操作/请求”。  
- 一次调用通常对应队列中的一个事务 `txn_id`（便于追踪、查询进度与诊断）。  

当前消费节奏（简化）：

- 插件在收到一次 “StartSync” 触发后，执行一次 **drain loop**：持续拉取并执行直到 `NoWork`。
- 后端（bridge/daemon）**有定期 kick** 的保险机制；若触发丢失/瞬断/插件错过 StartSync，队列可在 kick 周期内恢复消费（且插件默认 silent，避免 UI 噪音）。

## 目标（Goals）

- G1：在“daemon 在线 + 插件 consumer 在线”时，**默认写入能在短时间内开始被消费**（无需用户记 flags）。  
- G2：在触发丢失/瞬断等常见异常下，**积压可在有限时间内自动恢复**（无需手工 `daemon sync`）。  
- G3：避免“兜底机制”对用户造成骚扰（例如频繁 toast/刷屏）。  
- G4：提供一个明确的**进度/状态查询**入口，便于 Agent 在批量写入时观测同步进展。  

## 非目标（Non-goals）

- 不保证插件离线时也能立即写入（离线只能积压，待插件恢复）。  
- 不追求“每个 op 都严格实时、严格顺序”——队列本身允许一定并发，可靠性优先。  
- 不追求在 RemNote UI 上展示进度（本 spec 以 CLI 可查询为准）。  

## 方案概览（推荐：三层保险）

### Layer 1（默认实时）：CLI 写入默认 notify + ensure-daemon

把“写入类命令”的默认行为改为：

- `notify` 默认 **true**：写入后立即触发一次同步（通过 WS 广播 StartSync）。
- `ensure-daemon` 默认 **true**：若 daemon 未运行则自动拉起（Supervisor 模式幂等）。

并提供显式关闭开关：

- `--no-notify`：只入队，不主动触发同步（保留给调试/极端场景；非主路径）
- `--no-ensure-daemon`：不拉起 daemon（仅入队 + 提示/告警；保留给调试/极端场景）

> 结果：默认情况下，“每次服务端写入都会催一遍前端去消费”。

### Layer 2（长尾兜底）：bridge/daemon 低频 kick（节流 + 无进展升级）

在 WS bridge（服务端）增加一个低频定时器（kick loop）：

- 条件：存在已连接 consumer，且队列存在“可执行的 pending ops”（或等价信号）时才 kick
- 动作：向 consumer 发送一次 StartSync（可定向或广播）
- 约束：需要**节流/退避**，避免在无工作/无 consumer 时产生无意义噪音
- 可配置：允许在本地/生产通过 env 或配置关闭或调整间隔（例如 interval=0 关闭）

本 spec 的默认决策：

- kick interval：**30s**
- “无进展”升级阈值：**30s**（重 kick / 重新选择目标连接）与 **90s**（兜底 broadcast/接管）

> 结果：即便 notify 丢了/插件错过了 StartSync，只要 consumer 在线，积压会在 kick 周期内被唤醒消费。

### Layer 3（降噪）：插件对 StartSync 默认 silent（手动命令可保留 toast）

为避免 kick 带来 UI 噪音：

- 插件收到 StartSync 时，默认以 **silent** 方式运行一次 drain（不 toast / 最少提示）
- 插件的“手动命令 Start sync”仍可保留显式 toast（因为是用户主动点的）

可选增强（后续讨论）：

- 为单轮 sync / 单 op 执行增加超时与自恢复（避免 `syncing=true` 卡死）

## 关键行为定义（需要讨论并固化）

### 1) “写入类命令”范围

待确认：哪些命令算“写入队列”，默认 `notify=true`？

建议包含：

- `apply`
- `write *`
- `write daily`
- `write wechat outline`（其本质也是写入）

建议不默认包含（但可手动 `--notify`）：

- `queue enqueue`（偏底层/批量；有些场景就是想先堆积再统一同步）

### 2) kick 的触发条件（避免空转）

建议以队列统计作为信号（示例信号，不限定实现）：

- `pending > 0`（且 pending 表示“已到 next_attempt_at 的可执行 pending”）
- 或 “本 tick 回收了过期 lease” 之后发现 pending>0

### 3) kick 的目标（定向 vs 广播）

- 定向：只给 **active worker** 连接发 StartSync（更可控；active worker 由 `uiContext/selection` 活跃度选举）
- 广播：给所有连接发 StartSync（更保险但更嘈杂；在“非 active worker 不允许 RequestOp”的前提下通常没必要）

建议：优先“选一个目标连接”（例如 `uiContext.updatedAt` 最新的连接）进行定向 kick；若 30s 无进展则升级；90s 仍无进展再兜底 broadcast。

### 4) 兜底机制的“降噪”

需要保证：

- kick 触发的 StartSync 不会导致 RemNote UI 频繁 toast（默认 silent）
- 当确实连续失败/崩溃循环时，仍要有可诊断信号（例如日志、status 输出里可见）

### 5) “worker_busy” 可靠性修复（避免单连接卡死导致长期不消费）

现状：需要保证“最近会话唯一消费”。若 active worker 连接“仍在线但不再拉取”（例如插件卡死/逻辑挂起），其它窗口/设备应能接管，否则队列可能长期不被消费。

建议（最小修复方向）：

- 为 active worker 引入**活性租约/TTL**：若在 TTL 内没有 `RequestOp` 活动，则允许其它连接接管。
- 接管择优：优先选择 `uiContext.updatedAt`/`lastSeenAt` 更新更近的连接。

## Scenarios & Testing（SC）

- **SC-001**：默认同步：用户不带任何 flags 执行一次写入（例如 `write bullet`），在 daemon+插件在线时，能在可接受时延内被消费（默认目标：秒级）。  
- **SC-002**：触发丢失可恢复：模拟“notify 未触发/StartSync 丢失”的场景，队列在 kick 周期内开始被消费。  
- **SC-003**：无噪音：开启 kick 后，不会出现高频 toast；日志与 status 能解释“为什么没同步/是否在尝试”。  
- **SC-004**：可查询进度：对一次写入命令生成的 `txn_id`，可通过 CLI 查询其执行进度（含 score/终态/失败原因）。  

## 已决策（本次讨论结论）

1) kick interval：**30s**  
2) 无进展升级阈值：**30s / 90s**  
3) StartSync：**默认 silent**（不要求 RemNote UI 展示进度）  
4) 计数单位：**按一次 CLI 写入命令调用（一次入队/一次 txn）**  

## 已实现（与当前实现对齐）

1) 进度查询：提供 `agent-remnote queue progress --txn <id>`（面向 Agent 的稳定、轻量入口）。  
2) score 语义：以 txn 中 ops 的终态聚合；`dead` 计入“完成”但标记失败（用于把“已终止/不可重试”与“仍在进行”区分开）。  
3) 失败收敛：txn 内任一 op 进入不可重试 dead 后，同 txn 尚未派发的 pending op 必须被收敛为 dead，避免失败事务长期保留不可派发 pending。

## Functional Requirements

- **FR-001**：写入类命令 MUST 默认 `notify=true` + `ensure-daemon=true`，并提供 `--no-notify/--no-ensure-daemon` 关闭。  
- **FR-002**：当 notify 返回 `sent=0` 时，命令 MUST 仍视为“入队成功”（exit code=0），并返回建议型 warnings/nextActions（B 输出：stderr；`--json`：data.warnings）。  
- **FR-003**：WS bridge MUST 提供默认开启的 kick loop（默认 interval=30s），并支持通过 env 调整/关闭。  
- **FR-004**：kick loop MUST 仅在“队列存在待处理 work 且存在 active worker”时触发（避免空转/噪音）。  
- **FR-005**：无进展升级 MUST 通过 quarantine/接管实现，且不得打断 in-flight op（由 lease 回收兜底）；新请求应尽早路由到新的 active worker。  
- **FR-006**：插件收到 StartSync（notify/kick）时 MUST 默认 silent drain（不 toast），避免 UI 噪音。  
- **FR-007**：插件 MUST 提供 watchdog，避免 `syncing=true` 永久卡死（超时自恢复 + 诊断字段）。  
- **FR-008**：CLI MUST 提供 `queue progress --txn <id>`，并输出稳定字段（score/is_done/is_success/nextActions）。  

## Non-Functional Requirements

- **NFR-001**：输出 MUST 面向 Agent 友好（B 风格）：stdout 尽量只输出结果；warnings/nextActions 走 stderr；`--json` 输出稳定 envelope。  
- **NFR-002**：兜底机制 MUST 降噪：不产生频繁 toast；kick 必须节流且可关闭。  
