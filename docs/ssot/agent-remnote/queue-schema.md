# Store DB（SQLite）· 队列模块 Schema

目标：在不直接改写 RemNote 官方数据库的前提下，在本地 **Store DB**（默认 `~/.agent-remnote/store.sqlite`）里提供一个可靠、可观测、可重试的写入队列，供 CLI/后端派发，RemNote 插件（WebSocket 执行器）消费并通过官方 SDK 完成写入。

## 设计要点
- 原子单元：操作（op）。可选事务（txn）将多 op 打包为一致性单元（聚合状态/共享 meta/便于追踪）；默认允许并发执行。
- 可靠投递：至少一次语义；靠幂等键实现逻辑“恰好一次”。
- 可恢复：断线、崩溃后可凭 `next_attempt_at` 与 `lease` 续约重试。
- 并发与顺序：全局并发受控；**同 txn 内默认按 `op_seq` 串行派发**（前序必须成功才派发后续），跨 txn 允许并发（受执行器并发度与锁影响）；`queue_op_dependencies` 作为额外 gating（表达更复杂依赖）。
- 可观测：入队回执、派发/执行日志、最终结果与错误码完整留痕。
- forward-only migrations：使用 `PRAGMA user_version` 维护 schema 版本；只允许向前迁移，版本不匹配应 fail-fast 并给出可行动提示。

## 建议的 PRAGMA（打开数据库后执行一次）
```sql
PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
```

## 表结构（DDL）

1) 队列元信息（可选）
```sql
CREATE TABLE IF NOT EXISTS queue_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
```

2) 迁移审计（forward-only migrations）

```sql
CREATE TABLE IF NOT EXISTS store_migrations (
  version     INTEGER PRIMARY KEY,
  name        TEXT NOT NULL,
  checksum    TEXT NOT NULL,
  applied_at  INTEGER NOT NULL,
  app_version TEXT NOT NULL DEFAULT 'unknown'
);
```

约束（硬不变量）：

- `store_migrations` 是审计表：记录每个 schema migration 的 `version/name/checksum/applied_at/app_version`。
- 启动时必须校验已应用 migration 的 checksum 与当前代码一致；不一致必须 fail-fast（避免“版本号前进但迁移内容已漂移”的不可诊断状态）。

3) 事务表（打包多操作，控制顺序与最终态）
```sql
CREATE TABLE IF NOT EXISTS queue_txns (
  txn_id           TEXT PRIMARY KEY,
  status           TEXT NOT NULL CHECK (status IN (
                        'pending',      -- 创建中（未提交）
                        'ready',        -- 已提交，待执行
                        'in_progress',  -- 有 op 在执行
                        'succeeded',    -- 所有 op 成功
                        'failed',       -- 有 op 死亡/失败
                        'aborted'       -- 主动放弃
                      )),
  dispatch_mode    TEXT NOT NULL DEFAULT 'serial' CHECK (dispatch_mode IN (
                        'serial',            -- 默认：txn 内强制串行（同一 txn 仅允许 1 条 in_flight；并要求前序 op_seq 全部 succeeded）
                        'conflict_parallel'  -- 激进：txn 内允许并行派发（仍受 conflict keys / queue_id_map gating / queue_op_dependencies 影响）
                      )),
  priority         INTEGER NOT NULL DEFAULT 0,
  idempotency_key  TEXT UNIQUE,
  client_id        TEXT,               -- 可选：调用方标识
  meta_json        TEXT NOT NULL DEFAULT '{}',
  op_count         INTEGER NOT NULL DEFAULT 0,
  next_seq         INTEGER NOT NULL DEFAULT 0, -- 为新增 op 递增
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL,
  committed_at     INTEGER,            -- 进入 ready 的时间
  finished_at      INTEGER             -- 进入终态的时间
);
```

4) 操作表（最小执行单元）
```sql
CREATE TABLE IF NOT EXISTS queue_ops (
  op_id            TEXT PRIMARY KEY,
  txn_id           TEXT NOT NULL,
  op_seq           INTEGER NOT NULL,             -- txn 内顺序
  type             TEXT NOT NULL,                -- 例如 create_rem / update_text 等
  payload_json     TEXT NOT NULL,                -- 操作参数
  status           TEXT NOT NULL CHECK (status IN (
                        'pending',    -- 可被调度（到期）
                        'in_flight',  -- 已派发，持有租约
                        'succeeded',  -- 执行成功
                        'failed',     -- 可重试失败（未超限）
                        'dead'        -- 达到最大重试或不可重试
                      )),
  idempotency_key  TEXT,                          -- 去重键（同语义重复）
  op_hash          TEXT NOT NULL,                 -- payload 归一化哈希（便于观测/去重）
  attempt_id       TEXT,                          -- 派发尝试标识（claim 时生成；OpAck 必须携带并做 CAS 校验）
  attempt_count    INTEGER NOT NULL DEFAULT 0,
  max_attempts     INTEGER NOT NULL DEFAULT 10,
  deliver_after    INTEGER NOT NULL DEFAULT 0,    -- 最早派发时间（ms since epoch）
  next_attempt_at  INTEGER NOT NULL,              -- 下一次尝试时间（ms since epoch）
  locked_by        TEXT,                          -- 连接实例 ID（WS connId）
  locked_at        INTEGER,                       -- 加锁时间
  lease_expires_at INTEGER,                       -- 租约到期时间
  dead_reason      TEXT,                          -- 进入 dead 的原因
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL,
  CONSTRAINT fk_ops_txn FOREIGN KEY (txn_id) REFERENCES queue_txns(txn_id) ON DELETE CASCADE,
  CONSTRAINT uq_txn_seq UNIQUE (txn_id, op_seq)
);

-- 常用索引
CREATE INDEX IF NOT EXISTS idx_ops_status_next ON queue_ops(status, next_attempt_at);
CREATE INDEX IF NOT EXISTS idx_ops_locked_by ON queue_ops(locked_by);
CREATE INDEX IF NOT EXISTS idx_ops_hash ON queue_ops(op_hash);
CREATE UNIQUE INDEX IF NOT EXISTS uq_ops_idem ON queue_ops(idempotency_key) WHERE idempotency_key IS NOT NULL;
```

5) 依赖表（用于表达必须串行的依赖；同 txn/跨 txn 都可用）
```sql
CREATE TABLE IF NOT EXISTS queue_op_dependencies (
  op_id             TEXT NOT NULL,
  depends_on_op_id  TEXT NOT NULL,
  PRIMARY KEY (op_id, depends_on_op_id),
  FOREIGN KEY (op_id) REFERENCES queue_ops(op_id) ON DELETE CASCADE,
  FOREIGN KEY (depends_on_op_id) REFERENCES queue_ops(op_id) ON DELETE CASCADE
);
```

6) 结果与错误（便于审计/回读）
```sql
CREATE TABLE IF NOT EXISTS queue_op_results (
  op_id         TEXT PRIMARY KEY,
  result_json   TEXT,               -- 成功结果（如 remote_id 映射、版本信息）
  error_code    TEXT,
  error_message TEXT,
  finished_at   INTEGER,
  FOREIGN KEY (op_id) REFERENCES queue_ops(op_id) ON DELETE CASCADE
);
```

7) 派发尝试历史（用于多客户端排障与审计）
```sql
CREATE TABLE IF NOT EXISTS queue_op_attempts (
  op_id       TEXT NOT NULL,
  attempt_id  TEXT NOT NULL,
  conn_id     TEXT,
  status      TEXT NOT NULL,
  detail_json TEXT NOT NULL DEFAULT '{}',
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  PRIMARY KEY (op_id, attempt_id),
  FOREIGN KEY (op_id) REFERENCES queue_ops(op_id) ON DELETE CASCADE
);
```

8) 临时 ID 映射（本地 -> 远端正式 ID）

约束（硬不变量）：

- `queue_id_map` 是事实表：同一个 `client_temp_id` 一旦映射到某个 `remote_id`，后续不得覆盖为不同值（不可漂移）。
- 重复写入 **同一个** `remote_id` 视为幂等 no-op（允许补齐 `remote_type/source_txn` 为空的字段）。
- 若检测到漂移（同 `client_temp_id` 对应不同 `remote_id`），系统必须 fail-fast 并产出可诊断错误（例如 `ID_MAP_CONFLICT`），且不得覆盖已有映射。

```sql
CREATE TABLE IF NOT EXISTS queue_id_map (
  client_temp_id  TEXT PRIMARY KEY,
  remote_id       TEXT,
  remote_type     TEXT,           -- rem / tag / table / row 等
  source_txn      TEXT,
  updated_at      INTEGER
);
```

9) 消费者心跳（可选）

```sql
CREATE TABLE IF NOT EXISTS queue_consumers (
  consumer_id   TEXT PRIMARY KEY,
  last_seen_at  INTEGER NOT NULL,
  meta_json     TEXT NOT NULL DEFAULT '{}'
);
```

10) Workspace 绑定（长期事实源）

```sql
CREATE TABLE IF NOT EXISTS workspace_bindings (
  workspace_id       TEXT PRIMARY KEY,
  kb_name            TEXT,
  db_path            TEXT NOT NULL,
  source             TEXT NOT NULL CHECK (source IN (
                        'explicit',
                        'live_ui_context',
                        'single_candidate_auto',
                        'deep_link'
                      )),
  is_current         INTEGER NOT NULL DEFAULT 0 CHECK (is_current IN (0, 1)),
  first_seen_at      INTEGER NOT NULL,
  last_verified_at   INTEGER NOT NULL,
  last_ui_context_at INTEGER,
  updated_at         INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_workspace_bindings_current
  ON workspace_bindings(is_current)
  WHERE is_current = 1;
```

约束（硬不变量）：

- `workspace_bindings` 是宿主机侧 `workspaceId -> dbPath` 的长期事实源。
- 任一时刻最多只有一个 `is_current = 1`，作为默认 workspace 指针。
- 多候选目录扫描只负责枚举和单候选自动采用，不得把“最新 DB”写成长期默认值。
- 当 live `uiContext.kbId` 可解析到 `~/remnote/remnote-<workspaceId>/remnote.db` 时，必须刷新或创建对应 binding，并把它设为 current。

## 推荐状态流转
- 入队：queue_ops.status = 'pending'，next_attempt_at = now
- 派发：queue_txns 成为 ready 后，从 queue_ops 选取 `status='pending' AND next_attempt_at<=now` 的最小 `(priority, created_at, op_seq)`；同一 txn 内要求“无 in_flight 且前序 op 全部 succeeded”；加锁并置 `in_flight`，设置 `locked_by(connId)/lease_expires_at`
- 执行成功：置 `succeeded`，写入 `queue_op_results`，更新 `queue_id_map`（若返回新 ID）
- 可重试失败：`ackRetry` 先递增 `attempt_count`；仅当递增后 `attempt_count < max_attempts` 时，才按指数退避更新 `next_attempt_at` 并回到 `pending`
- 死亡：当 `ackRetry` 递增后 `attempt_count >= max_attempts`（或明确不可重试）时，直接置 `dead`（不再回到 `pending`），并写入 `queue_op_results` 与 `dead_reason`
- 事务聚合：当 txn 的所有 op 均 `succeeded` → txn.status='succeeded'；若有 `dead` → 'failed'，并把同 txn 尚未派发的 `pending` op 收敛为 `dead`（`dead_reason=txn_failed:<op_id>`），避免失败事务残留不可派发 pending
- 统计口径：`queue stats` 的 `pending` 仅统计 `txn.status in (ready,in_progress)` 的 pending op，避免把 `failed/aborted` 事务计入可派发积压
- 历史治理：`queue cleanup` 默认只 dry-run 预览 `failed/aborted` 终态 txn；只有 `--apply` 才删除选中的 txn，并依赖 Store DB 外键级联清理其 ops/results/attempts/dependencies

## Lease 策略（SSoT）

- lease 是 server-side 强制：派发时计算 `lease_expires_at = now + leaseMsEffective`（对请求 `leaseMs` 做 clamp）。
- 动态 lease：服务端可基于 `op_type` 与 payload 规模上调 lease（仍受 max clamp），减少 UI/SDK 忙碌时的误回收。
- 续租（LeaseExtend）：执行器可在执行中发送 `LeaseExtend(op_id, attempt_id, extendMs)`；服务端仅在命中当前 attempt 时延长：
  - 条件：`queue_ops.status='in_flight' AND queue_ops.locked_by=<connId> AND queue_ops.attempt_id=<attempt_id>`
  - 更新：`lease_expires_at = max(lease_expires_at, now + extendMsEffective)`（extendMs 也做 clamp）
- 回收：daemon heartbeat 周期调用 `recoverExpiredLeases`，将过期 in-flight op 退回 `pending`（CAS 命中 attempt_id + locked_by），并写 `queue_op_attempts.status='lease_expired'` 作为审计证据。

## 幂等与去重
- 入队时生成 `idempotency_key`（如 `${type}:${stableHash(payload)}` 或由上游传入）；对该键建唯一索引避免重复。
- 插件执行器也按 `idempotency_key` 做幂等检查（同一 key 的第二次调用直接返回已执行结果）。

## 常见操作类型（示例）
```json
// create_rem
{
  "type": "create_rem",
  "payload": { "parent_id": "...或 client_temp_id", "text": ["..."], "properties": { /*...*/ } },
  "idempotency_key": "create_rem:..."
}
// update_text
{
  "type": "update_text",
  "payload": { "rem_id": "...或 client_temp_id", "text": ["..."], "expected_version": 12 }
}
// move_rem / add_tag / remove_tag / set_attribute / table_cell_write ...
```

## 典型调度流程（默认：txn 内串行 / txn 间可并发）
1. 入队：创建 `txn`（pending）→ 逐条插入 `queue_ops(op_seq=1..n)` → 提交 `txn.status=ready`
2. 派发：选择任意 `pending & next_attempt_at<=now` 的 op（`txn.status in ready/in_progress`），要求同 txn 内“无 in_flight 且前序全部 succeeded”；若 `queue_op_dependencies` 未满足则跳过；加锁并下发
3. 确认：
   - 成功：`queue_ops.status=succeeded`，写 `queue_op_results`，更新 `queue_id_map`
   - 失败可重试：`queue_ops.status=pending`，`attempt_count+=1`，设退避后的 `next_attempt_at`
   - 死亡：`queue_ops.status=dead`，`dead_reason` 填写；同 txn 尚未派发的 `pending` op 进入 `dead`
4. 归集：若 txn 全部 `succeeded` → 标记 txn 完成；若任一 `dead` → 标记 txn 失败；终态历史可用 `queue cleanup` dry-run/`--apply` 治理

## dispatch_mode 语义（v4）

- `serial`（默认）：保持最强安全/可预期的顺序语义；适合“必须严格按 op_seq 执行”的写入批次。
- `conflict_parallel`：允许同一 txn 内多条 op 并行派发/执行，用于提升吞吐（例如一次性生成/更新大量互不冲突的 Rem）。安全边界由以下机制共同保证：
  - conflict keys：同一批/跨批的冲突操作不会并行派发
  - queue_id_map gating：当 op 引用了未解析的 `tmp:*`（依赖尚未落库的 remote_id）时，调度器会暂缓派发该 op
  - `queue_op_dependencies`：可表达更复杂的依赖关系（跨 txn 也可），未满足则不派发

## 索引与性能建议
- 索引：`(status, next_attempt_at)`、`(txn_id, op_seq)`、`idempotency_key`、`op_hash`
- 读取热路径：调度器查询 `pending & next_attempt_at<=now`，按 `priority, created_at, op_seq` 排序（并对 txn 做串行 gating），限流批量
- 写入模式：尽量批量入队/确认，减少事务开销

## 演进策略（forward-only）
- 使用 `PRAGMA user_version` 维护迁移版本；仅支持向前迁移（不支持降级）；优先增量添加列，避免破坏性迁移
- 如需为 `payload_json` 引入 schema version，仅用于 **fail-fast + 诊断**：版本不匹配直接拒绝执行并返回可行动提示（不提供旧 payload 的兼容层）

---

实现落点（代码锚点）：

- 队列实现：`packages/agent-remnote/src/internal/queue/`（better-sqlite3）
- 关键 API：`enqueueTxn`、`claimNextOp`、`ackSuccess/Retry/Dead`、`recoverExpiredLeases`
- 端到端派发/确认：由 WS bridge 按协议执行（见 `docs/ssot/agent-remnote/ws-bridge-protocol.md`）
