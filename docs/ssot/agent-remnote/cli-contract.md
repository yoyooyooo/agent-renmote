# agent-remnote CLI · 对外契约（SSoT）

本文件定义 agent-remnote 的 CLI 对外契约（A 类不变量）。实现与测试必须以此为准。

command inventory authority：

- 哪些命令属于 RemNote business commands，以及它们的 wave / parity target，
  以 `docs/ssot/agent-remnote/runtime-mode-and-command-parity.md` 为唯一权威源。
- 本文件定义 CLI contract；不单独再维护一份命令分类真相源。

Wave 1 execution authority：

- `packages/agent-remnote/src/lib/business-semantics/commandContracts.ts`
  可以声明 Wave 1 executable contract
- `packages/agent-remnote/src/lib/business-semantics/modeParityRuntime.ts`
  定义的 `ModeParityRuntime` 是 Wave 1 business command 唯一允许切换
  local / remote mode 的层
- Wave 1 business command files 应保持 thin adapter 形态

## 1) 两个 surface，一个核心不变量

- **Machine surface**：当用户传入 `--json` 时，把 CLI 当作“协议/API”消费。
- **Human surface**：默认输出（`--md` / `--ids` / 无 `--json`）用于人类轻量使用。

核心不变量：

- 只要出现 `--json`，CLI 必须保持“严格协议输出”，避免任何环境把 stdout/stderr 合并后污染机器输出。

## 2) `--json`（Machine surface）输出契约

### MUST

- stdout **必须且只能输出一行 JSON**：`JSON.stringify(envelope) + "\n"`（禁止 pretty print）。
- stderr **必须为空**（包括错误、警告、提示、调试、日志）。
- 成功/失败都使用稳定 envelope（允许新增字段；禁止重命名/删除已发布字段）。
- exit code 语义：
  - `0`：成功
  - `2`：参数/用法错误（含 `@effect/cli` ValidationError、严格 argv 预检失败）
  - `1`：其他失败（运行时失败、依赖不可用、未知 defect）

补充约束：

- 对于 Wave 1 parity-mandatory business commands，`--json` 的业务结果应来自同一套
  runtime capability 与 normalizer
- command file 不应因为 `apiBaseUrl` 是否存在而自行切换业务语义

### Envelope shape

与 `packages/agent-remnote/src/services/Errors.ts` 的 `JsonEnvelope` 对齐：

```ts
export type JsonEnvelope =
  | { readonly ok: true; readonly data: unknown }
  | {
      readonly ok: false;
      readonly error: { readonly code: string; readonly message: string; readonly details?: unknown };
      readonly hint?: readonly string[];
    };
```

约束：

- `error.code`：稳定机器码（例如 `INVALID_ARGS` / `INTERNAL` / `DB_UNAVAILABLE`）。
- `error.message`：英文短句（不含堆栈）。
- `error.details`：仅在需要时提供 JSON 可序列化细节（`--debug` 可扩大 details，但仍禁止写 stderr）。
- `hint[]`：可操作的英文建议（每条一句）。

### 禁止组合（为了保持协议纯度）

以下选项会触发 `@effect/cli` 内建的非 JSON 输出（help/version/completions/wizard）。为了保证 `--json` 永远可被机器稳定消费：

- `--json` **不得与** `--help` / `-h` / `--version` / `--completions` / `--wizard` 同时出现。
- 若出现，必须视为参数错误：exit code `2`，stdout 输出失败 envelope，stderr 仍为空。

## 3) Human surface 输出契约

### MUST

- stdout：输出主结果（可多行）。
- stderr：输出所有非结果文本（错误、人类提示、warnings、next actions 等）。
- 错误行必须以 `Error:` 前缀开头（英文），便于 grep/上游统一处理。
- exit code 语义同上（`0/2/1`）。

## 4) 全局 option 的位置约束（与 @effect/cli Subcommands 行为相关）

由于 `Command.withSubcommands` 的解析行为可能吞掉“子命令 token 之间乱塞的 flag/参数”，本 CLI 额外引入严格 argv 预检以保证对外契约一致：

- **global option 必须放在第一个子命令 token 之前**（例如 `agent-remnote --json --repo X search --query "..."`）。
- 在 leaf 子命令尚未选定前，遇到未知 `--xxx` 必须报错（exit code `2`），避免被吞掉。

## 5) 命令归属裁决（实体优先 + plugin 边界）

为降低 Agent “选错入口”的概率，命令树归属做如下裁决：

- 顶层命令集合固定为：`daemon` / `queue` / `apply` / `plugin` / `search` / `query` / `rem` / `daily` / `todo` / `topic` / `powerup` / `table` / `tag` / `portal` / `replace` / `db` / `config` / `doctor` / `ops`
- `scenario` 可在 031 worktree 内作为 feature-local planned namespace 存在，用于 `scenario schema *`、`scenario builtin list|install` 与 branch-local `scenario run` 试点；在 promotion preconditions 完成前，它不属于 current public stable inventory
- `playbook` 可在 032 worktree 内作为 feature-local planned namespace 存在，用于 `playbook explain|dry-run|run` 的 orchestration 试点；在 promotion preconditions 完成前，它不属于 current public stable inventory
- `plugin/*`：依赖 RemNote UI/插件/WS bridge state 的能力，或直接服务插件运行时工件（例如候选集搜索、selection、ui-context、local static plugin server）
- 其余 **只读** 能力优先直挂顶层实体子命令（例如 `search` / `query` / `db ...` / `powerup list/schema` / `todo list` / `rem outline`）
- 所有 **写入副作用** 必须通过“动词子命令”显式表达（create/move/text/delete/apply/add/remove/record/property/option/replace/...），并最终走 enqueue → WS → plugin SDK
- raw ops 仅允许作为 debug/escape hatch 暴露在 `apply`（结构化批量入口同样统一到 `apply` 的 `kind=actions`）
- `apply kind=actions` 的 atomic vocabulary 必须保持低熵；portal 写入的 canonical action 为 `portal.create`，通过参数与 `@alias` 组合，不再引入 workflow-specific command noun

Wave 1 runtime shape：

- 写路径继续保留 `apply envelope -> WritePlanV1 -> ops`
- 读路径与 UI-context 路径统一消费 runtime capabilities
- command files 负责 argv、help、output
- runtime 负责 mode switch、capability gating、结果归一化

### `rem replace`

- `rem` 下的规范化替换命令族
- 目标选择器：
  - 可重复的 `--subject`
  - `--selection`
- replace surface：
  - `--surface children`
  - `--surface self`
- `--selection` 只作为目标选择器，不进入规范化命令名
- 旧 surface 定位：
  - `rem children replace`：兼容性包装器
  - `replace markdown`：高级 / 仅本地的块替换

### `rem create` / `rem move`

- `rem create` 的 source model 固定为四选一：
  - `--text`
  - `--markdown`
  - repeated `--from`
  - `--from-selection`
- `--from-selection` 只是 `from[]` 的 sugar，不能与 `--text` / `--markdown` / explicit `--from` 混用
- 显式主体统一为 `--subject`
- 关系目标统一为 `--to`
- 内容位置统一为 `--at <placement-spec>`
- portal 策略统一为 `--portal in-place | at:<placement-spec>`
- `--is-document` 始终显式，默认 `false`
- `rem create --markdown` 必须带 `--title`
- repeated `--from` 多个 source 时必须带 `--title`
- 单个 `--from` 与单个 `--from-selection` 允许从 source 标题推断 destination title
- `placement-spec` 固定为：
  - `standalone`
  - `parent:<ref>`
  - `parent[<position>]:<ref>`
  - `before:<ref>`
  - `after:<ref>`
- `rem create --wait --json` 在 durable target 已落地、portal 步骤失败时，必须返回 partial-success receipt，并保留 durable target
- `rem move --wait --json` 在 move 成功但 `--portal in-place` 失败时，必须返回：
  - `durable_target`
  - `portal.requested=true`
  - `portal.created=false`
  - `warnings[]`
  - `nextActions[]`
  - `source_context`

### `tag add` / `tag remove`

- `tag add` / `tag remove` 是 relation write，不属于 single-subject write
- `--tag <ref>` 至少一个，可重复
- `--to <ref>` 至少一个，可重复
- direct CLI surface 必须把 repeated `--tag` 与 repeated `--to` 展开为多条关系边
- 旧的 `--subject` 与 `--rem` 在 `tag add/remove` 上都必须拒绝
- `rem tag add/remove` 只是命令树别名，参数面必须与 `tag add/remove` 完全一致

### `powerup todo` / `todo`

- authoritative inventory 里的 canonical ids 记为 `powerup.todo.*`
- `powerup todo` 是 canonical command family
- 顶层 `todo` 只保留为高频 alias
- `todo` 与 `powerup todo` 的子命令集合必须保持一致：
  - `list`
  - `add`
  - `done`
  - `undone`
  - `remove`
- `todo list` 的长期方向是 `query` preset；在命令面保留 alias 不等于保留第二套查询内核
- 当前分支里的最小兼容桥为：
  - `query --preset todos.list --status <unfinished|finished|all> --sort <dueAsc|dueDesc|updatedAtAsc|updatedAtDesc|createdAtAsc|createdAtDesc> --limit <n> --offset <n>`
  - `todo list` 与这条 preset surface 在本地模式下保持结果等价
  - `query --preset todos.list` 在 `apiBaseUrl` 模式下继续返回稳定拒绝，直到 preset parity promotion 条件满足
- `query --powerup <name>` 可以存在，但只属于 authoring sugar：
  - 必须先走宿主权威 metadata path
  - 规范化后的 canonical Query V2 只接受 `powerup.by=id|rcrt`
  - 自由文本名字不得进入 canonical body 或 remote parity compare

### `scenario`

- 031 试点内允许的 planned namespace 包含：
  - `scenario schema validate|normalize|explain --spec <spec>`
  - `scenario schema generate --hint <spec>`
  - `scenario builtin list`
  - `scenario builtin install <builtin-id>... | --all [--dir <path>] [--if-missing]`
  - `scenario run <spec> --var key=value`
- user-private scenario store 的默认路径为：
  - `~/.agent-remnote/scenarios/*.json`
- `scenario run <spec>` 在 031 试点内接受：
  - `builtin:<id>`
  - `user:<id>`
  - `@./scenario.json`
  - 非 builtin 的裸 id，会从 `~/.agent-remnote/scenarios/<id>.json` 解析
- `--package <spec>` 继续保留为兼容 alias；若同时提供位置参数与 `--package`，两者必须一致
- builtin scenario 继续以 repo 内 canonical package 为权威源；`scenario builtin install` 只是显式注入 helper，不是新的 canonical source
- `scenario builtin install` 默认不覆盖已存在文件；用户若要保留既有文件，使用 `--if-missing`

### `playbook`

- 032 规划内允许的 planned namespace 候选包含：
  - `playbook explain <spec> [--var key=value]... [--input <spec>]`
  - `playbook dry-run <spec> [--var key=value]... [--input <spec>]`
  - `playbook run <spec> [--var key=value]... [--input <spec>]`
- 第一版 `playbook` 继续保持：
  - dynamic orchestration layer
  - 调用方执行 playbook JS
  - 宿主机承接 capability calls
- `playbook` 不替代：
  - `scenario schema *`
  - `scenario run`
  - `apply`
- `playbook` 进入 current public inventory 前，必须补齐：
  - authoritative inventory
  - `commandInventory` mirror
  - verification-case registry
  - root help/docs drift
  - local / remote parity contract
  - dist smoke / packaging rules

### Promotion receipt

对于 `rem create` / `rem move` 的 promotion flow，`--json` 成功回执至少应稳定暴露：

- `txn_id`
- `op_ids`
- `durable_target`
  - `rem_id`
  - `is_document`
  - `placement_kind`
- `portal`
  - `requested`
  - `created`
  - `placement_kind`
  - `rem_id?`
- `source_context`
  - `source_kind`
  - `source_origin?`
  - `parent_id?`
- `warnings?`
- `nextActions?`

若 portal 阶段失败但 durable target 已存在：

- 仍应返回 `ok=true`
- 允许 `status='partial_success'` 或 `partial_success=true`
- 禁止丢失 durable target 标识

### `plugin serve`

- `plugin serve`：启动本地静态文件服务器，服务 RemNote 插件构建产物
- 默认监听：`127.0.0.1:8080`
- 运行时工件来源优先级：
  - 已发布包内的 `plugin-artifacts/dist`
  - 源码仓库中的 `packages/plugin/dist`
- 该命令用于 RemNote Developer URL 加载场景，不改变 Zip 安装路径契约
- human surface 默认输出类 Vite 的 `Local:` 行；`--debug` 时可额外输出 `Dist:`

### `plugin start|ensure|status|stop|logs|restart`

- 这组命令负责插件静态服务器的后台生命周期治理
- 默认文件：
  - pid：`~/.agent-remnote/plugin-server.pid`
  - log：`~/.agent-remnote/plugin-server.log`
  - state：`~/.agent-remnote/plugin-server.state.json`
- `plugin ensure` / `plugin start` 在 canonical stable owner 下默认目标地址为 `127.0.0.1:8080`
- source worktree 下默认进入 isolated profile，默认 plugin 端口必须是 deterministic isolated port，而不是 canonical `8080`
- 当前已属于 `stack ensure/status/stop` 的默认编排范围

### `stack ensure|status|stop|takeover`

- `stack ensure`：默认收口 `daemon + api + plugin`
- `stack status`：必须暴露
  - `resolved_local`
  - `fixed_owner_claim`
  - `services.daemon`
  - `services.api`
  - `services.plugin`
  - `ownership_conflicts[]`
- `stack stop`：默认停止当前本地 bundle 的 `daemon + api + plugin`
- `stack takeover --channel dev|stable`：
  - `dev`：切换 canonical fixed-owner claim 到 `dev`，并 best-effort 拉起 canonical dev bundle
  - `stable`：切换 claim 到 `stable`，停止当前 dev bundle，并在可用时调用 stable launcher
- direct `daemon/api/plugin start|ensure` 若目标是 canonical ports，也必须 obey fixed-owner claim policy，不能绕过 `stack` 抢占 canonical owner

## 6) `config` 命令组契约

- `config path`：输出当前生效的用户配置文件路径
- `config list`：枚举用户配置文件中的显式配置项，返回 canonical key
- `config get --key <key>`：读取单个配置项；未设置时返回 `exists=false`
- `config set --key <key> --value <value>`：写入单个配置项；支持 `apiBaseUrl`、`apiHost`、`apiPort`、`apiBasePath`
- `config unset --key <key>`：删除单个配置项；若文件清空可直接删除配置文件
- `config validate`：校验用户配置文件的 JSON 结构与已知 key 语义，返回 `valid` 布尔值与 `errors[]`
- `config print`：输出最终解析后的运行时配置，包含默认值、用户配置、环境变量与 CLI 参数覆盖后的结果
  - 必须额外暴露：
    - `runtime_profile`
    - `runtime_port_class`
    - `install_source`
    - `control_plane_root`
    - `runtime_root`
    - `worktree_root`
    - `fixed_owner_claim_file`
    - `fixed_owner_claim`
- 用户配置文件路径优先级：`--config-file` > `REMNOTE_CONFIG_FILE` > `~/.agent-remnote/config.json`
- remote API base URL 优先级：`--api-base-url` > `REMNOTE_API_BASE_URL` > 用户配置文件中的 `apiBaseUrl` > direct mode
- API host 优先级：`--api-host` > `REMNOTE_API_HOST` > 用户配置文件中的 `apiHost` > 默认 `0.0.0.0`
- API port 优先级：`--api-port` > `PORT` / `REMNOTE_API_PORT` > 用户配置文件中的 `apiPort` > 默认 `3000`
- API base path 优先级：`--api-base-path` > `REMNOTE_API_BASE_PATH` > 用户配置文件中的 `apiBasePath` > 默认 `/v1`

## 7) 队列历史治理

`queue cleanup` 是本地 Store DB 队列历史治理命令：

- 默认 dry-run，输出选中的 terminal txns/ops 数量与样本，不修改 DB
- 默认目标状态为 `failed/aborted`；`succeeded` 只有显式 `--status succeeded` 才进入候选
- 只有显式 `--apply` 才删除选中的 `queue_txns`，并依赖 Store DB 外键级联清理关联 ops/results/attempts/dependencies
- 在 remote mode 下必须 fail-fast，因为该命令直接治理调用方本地 Store DB

## 8) 运行版本可观测性

- `daemon status --json` 必须暴露：
  - `runtime`
  - `service.build`
  - `clients[].runtime`
  - `warnings`
- `plugin status --json` 必须暴露：
  - `runtime`
  - `service.build`
  - `plugin_server.build`
  - `warnings`
- `api status --json` 必须暴露：
  - `runtime`
  - `service.build`
  - `api.status.runtime`
  - `api.status.plugin.active_worker.runtime`
  - `warnings`
- 当 current CLI build 与 live daemon / api / plugin build 不一致时，status 输出必须返回稳定 warning，而不是要求用户从日志里猜。

## 9) schema 可观测性

- `doctor --json` 必须暴露 `queue.schema`：
  - `current_user_version`
  - `latest_supported_version`
  - `applied_migrations`
  - `latest_applied_version`
- `doctor --json` 必须暴露：
  - `checks[]`
  - `changed`
  - `fixes[]`
  - `restart_summary`
  - `fixed_owner_claim_file`
  - `fixed_owner_claim`
- `doctor --fix` 是 `doctor` 的安全修复模式：
  - 允许清理 stale daemon/api/plugin pid/state 文件
  - 允许在 canonical fixed-owner claim 缺失时持久化 stable bootstrap claim
  - 允许在 trusted live owner 与 fixed-owner claim 明确冲突时，按 claim 触发 deterministic realignment
  - 允许把支持的用户配置形态重写成 canonical keys
  - 允许汇报 `restart_summary`，但默认不自动重启 runtime 服务
  - 禁止修改 queue 内容、`remnote.db` 与用户内容数据

## 10) packaged runtime guarantees

- installed npm package layout 必须能加载 builtin scenario package，不得依赖 source-tree 路径
- packaged `search --json` 成功路径必须只向 stdout 写一个 JSON envelope
