# agent-remnote 写入命令语义（SSoT）

> 通过 CLI（agent-remnote）将写入/修改操作入队，由 RemNote 插件通过 WS 拉取并执行。

inventory authority：

- 哪些写入命令属于 parity-mandatory 的 RemNote business commands，以
  `docs/ssot/agent-remnote/runtime-mode-and-command-parity.md` 为唯一权威源。
- 本文件只描述写入语义，不额外维护命令分类真相源。

Wave 1 execution note：

- 对于 Wave 1 parity-mandatory 写命令，代码侧允许有一个 executable registry：
  `packages/agent-remnote/src/lib/business-semantics/commandContracts.ts`
- 该 registry 只描述 Wave 1 写命令如何绑定 runtime capability，不决定命令是否
  属于 Wave 1
- Wave 1 写命令的 mode switch 应收口在 `ModeParityRuntime`

## 术语
- op.type：操作类型。支持“标准类型”（下划线）与“点式别名”（namespace.action）。
- payload：操作参数。可用 camelCase 或 snake_case，服务端会标准化为 snake_case。
- RID：Rem id（大纲节点 id）。
- TagId：Tag 本体也是一个 Rem；`tag add/remove` 操作的是“tag-rem 关系边”，不创建/删除 Tag Rem。
- tableTagId：Table 以 Tag Rem 表示；`table ...` 的 `--table-tag` 就是 tableTagId。
- PoRID/TRID：Portal container / Portal target 的 Rem id（Portal 容器是特殊 RemType，不是富文本 token）。
- Deep link：`remnote://w/<workspaceId>/<remId>` / `https://www.remnote.com/w/<workspaceId>/<remId>`；CLI 对所有 “RemId” 参数只提取 `<remId>`。

## 命令一览
- Agent-primary primitives
- `agent-remnote apply`：统一写入入口；支持 `kind=actions|ops` 的 apply envelope（write-first）。
  - `agent-remnote rem replace`：规范化替换命令族。目标选择器负责表达“替换谁”，`--surface children|self` 负责表达“替换哪一层”。
  - `agent-remnote rem children append/prepend/replace/clear`：围绕单个 Rem 的 direct children 做 Markdown 结构写入（对应 `create_tree_with_markdown` / `replace_children_with_markdown`）。显式目标统一用 `--subject <ref>`；其中 `rem children replace` 保留为兼容性包装器；规范化路径优先用 `rem replace --surface children`。
  - `agent-remnote daily write`：写入 Daily Note（支持 bundle；结构化内容统一使用 `--markdown <input-spec>`；对应 `daily_note_write`）。
  - `agent-remnote rem create/move/set-text/delete`：Rem 结构与文本写入（对应 `create_rem`/`move_rem`/`update_text`/`delete_rem`）。`029` 起，写入面按 `subject / from / to / at / portal` 五轴收口：
    - `rem create` 支持 `--text | --markdown | repeated --from | --from-selection`
    - `rem create` 必须带 `--at <placement-spec>`
    - `rem move` 必须带 `--subject <ref>` 与 `--at <placement-spec>`
    - `portal create` 必须带 `--to <ref>` 与 `--at <placement-spec>`
    - `--portal` 统一承载 portal 策略：`in-place | at:<placement-spec>`
    - `--is-document` 保持显式，默认 `false`
    - `rem move --portal in-place` 支持单 Rem promotion 后原地留 portal
    - `rem create --from-selection --portal in-place` 支持把原 selection range 替换为 portal
    - repeated `--from` 在同 parent 且 contiguous sibling range 下也支持 `--portal in-place`
    - 当 durable target 已成功创建但 portal 失败时，`--wait --json` 必须返回 partial-success receipt，而不是丢失 durable target 诊断
    - 其中 `rem delete` 在插件侧默认走 `safeDeleteSubtree`，会优先直接删除“节点数不超过阈值”的整棵小子树；超过阈值时，再拆成多个阈值内的小子树做前端本地安全删除，以规避宿主的大树删除确认。CLI 可按次通过 `--max-delete-subtree-nodes <n>` 覆盖前端默认阈值。
  - `agent-remnote portal create`：创建真正的 Portal（SDK `createPortal + moveRems + addToPortal`；对应 `create_portal`）。
  - `agent-remnote tag add/remove`：增删 tag-rem 关系边（关系写入；对应 `add_tag`/`remove_tag`）。CLI surface 为 repeated `--tag <ref>` + repeated `--to <ref>`，运行时按笛卡尔积 fan-out。
- `agent-remnote backup list/cleanup`：backup artifact 的治理入口。`list` 只读列出 Store DB registry；`cleanup` 默认 dry-run，只有显式 `--apply` 才入队删除。
  - `backup cleanup` 额外支持 `--backup-rem-id <rem_id>`，用于精确清理单个 backup artifact，避免在多个 retained/orphan backup 共存时误删“最新一条”之外的对象。
  - `backup cleanup` 额外支持 `--max-delete-subtree-nodes <n>`，用于按次覆盖前端安全删除阈值，便于持续试探宿主可接受的单次子树删除上限。
- Structured-data primary write surface
  - `agent-remnote table create`
  - `agent-remnote table record add/update/delete`
  - `agent-remnote table property add/set-type`
  - `agent-remnote table option add/remove`
- Advanced / local-only
  - `agent-remnote replace markdown/literal`：advanced/local-only 的替换入口。`markdown` 用于块级 Markdown 替换，`literal` 用于纯文本查找替换；需要选择/引用/显式 ids。它不属于默认 Agent-first rewrite path，也不应与 `rem replace` 作为并列主路径推广。
- Auxiliary read surfaces
  - `agent-remnote daily rem-id`
  - `agent-remnote powerup list/resolve/schema`
  - `agent-remnote table show`
- Compatibility / non-primary write surfaces
  - `agent-remnote powerup apply/remove/...`
  - `agent-remnote powerup property add/set-type`
  - `agent-remnote powerup option add/remove`
- Ops / lifecycle
  - `agent-remnote queue stats`：查看队列统计（pending/in_flight/dead/ready_txns；可选 `--include-conflicts` 追加冲突摘要）。
  - `agent-remnote queue conflicts`：输出 pending 冲突面报告（用于消费前风险判断与排障）。
  - `agent-remnote queue inspect`：查看指定事务/操作详情。
  - `agent-remnote queue wait`：阻塞等待事务进入终态（succeeded/failed/aborted），用于 write-first 闭环验证。
  - `agent-remnote queue cleanup`：清理 Store DB 中终态 queue txn 历史；默认 dry-run，只预览 `failed/aborted`，显式 `--apply` 才删除。
  - `agent-remnote daemon sync`（或脚本 `ws-trigger-sync.ts`）：通过 WS 通知插件开始同步。

## Agent 工作流（write-first）

- 默认直接执行写入（实体命令的动词子命令 / `apply`），不再单独做“事前检查”；必要的校验与诊断内化在写入命令中。
- 失败时返回稳定的 `error.code` + `hint`（英文），用于指导下一步修复（例如配置/队列 DB/引用解析/缺少 parent 等）。
- 成功时返回 `txn_id/op_ids`，并附带 `nextActions`（英文命令）用于闭环验证（例如 `queue inspect` / `queue progress` / `daemon sync`）。
- 需要“同一次调用闭环确认落库”时，优先使用写入命令自带的 `--wait/--timeout-ms/--poll-ms`；`queue wait` 仅作为诊断工具保留。
- wait-mode 的机器主契约统一为 `id_map`。若 wrapper 额外返回 `rem_id` / `portal_rem_id` 等字段，它们只能视为从 `id_map` 派生出的 convenience sugar。
- promotion wrapper 的稳定补充字段：
  - `durable_target`
  - `portal`
  - `source_context`
  - `warnings`
  - `nextActions`
  - 当 portal 失败但 durable target 已存在时，仍返回成功 envelope，并用 partial-success 语义表达
- 对写入类命令，建议为每次“逻辑写入”提供稳定的 `--idempotency-key`（例如 URL / 文件 hash / 业务 key）。当 key 已存在时，CLI 会复用既有 txn（`deduped=true`），避免重复入队与重复写入。

协议补充（与 `docs/ssot/agent-remnote/cli-contract.md` 对齐）：

- `--json`：stdout 单行 JSON envelope，stderr 必须为空；写入类命令成功时 `data.nextActions` 必须可执行且为英文命令。
- `--ids`：仅在成功时输出 ids（逐行），stderr 必须为空；用于上游脚本/Agent 做最短链路的后续拼装。

## apply（统一写入入口）
- 入参：`agent-remnote apply --payload <json|@file|->`
- payload 顶层 envelope：
  - `{"version":1,"kind":"actions","actions":[...]}`
  - `{"version":1,"kind":"ops","ops":[...]}`
- envelope 内所有 `markdown` 字段都支持与 `--markdown <input-spec>` 相同的 input-spec 语义：
  - inline：`"- root\n  - child"`
  - file：`"@/absolute/or/relative/path.md"`
  - stdin：`"-"`（仅当当前进程 stdin 仍可用于 markdown 内容时）
  - literal leading `@`：`"@@/tmp/demo.md"` 会保留为字面文本 `@/tmp/demo.md`
- 默认行为：入队后触发一次同步（notify=true，ensure-daemon=true）；可用 `--no-notify` / `--no-ensure-daemon` 关闭。
- `actions` 适用于 agent 友好的结构化写入；`ops` 适用于 advanced/debug。
- Wave 1 runtime spine 必须保留这条统一写入链路：
  `apply envelope -> actions -> WritePlanV1 -> ops -> enqueue`
- `portal.create` 是 canonical portal atomic action；`input.parent_id` 与 `input.target_rem_id` 都允许引用 earlier `@alias`。
- 标准类型（部分示例）
  - rem 基础：`create_rem`/`create_portal`/`create_single_rem_with_markdown`/`create_tree_with_markdown`/`replace_selection_with_markdown`/`create_link_rem`/`update_text`/`move_rem`/`delete_rem`
    - 其中 `replace_selection_with_markdown` 主要服务 advanced/local-only 的块级替换语义；默认业务重写路径优先用 `rem.children.replace` action。
  - 日常笔记：`daily_note_write`
  - 标签/属性：`add_tag`/`remove_tag`/`set_attribute`
  - 表/属性：`create_table`/`add_property`/`set_property_type`/`set_table_filter`/`add_option`/`remove_option`
  - 表行/单元格：`table_add_row`/`table_remove_row`/`set_cell_select`/`set_cell_checkbox`/`set_cell_number`/`set_cell_date`/`table_cell_write`
  - 其他：`add_source`/`remove_source`/`set_todo_status`
- 入队语义：CLI 在入队前会 canonicalize `op.type`（别名统一转为标准类型）；后续冲突键/ID 字段提取/依赖替换均基于标准类型。
- 点式别名（可直接使用；会自动映射为标准类型）
  - `rem.create` → `create_rem`
  - `portal.create` / `rem.createPortal` → `create_portal`
  - `rem.updateText` → `update_text`
  - `table.addRow` → `table_add_row`
  - 其余常见别名已覆盖。
  - payload 键（自动规范化）
  - 示例：`parentId`/`parentID` → `parent_id`，`clientTempId` → `client_temp_id`，`clientTempIds` → `client_temp_ids`，`isDocument` → `is_document`，`addTitle` → `add_title` 等。
  - `create_portal`（创建 Portal：在 parent 下插入“传送门”投影到目标 Rem）
    - `parentId`/`parent_id`（必填）：Portal 容器插入位置（父 Rem id）
    - `targetRemId`/`target_rem_id`（必填）：被投影的目标 Rem id
    - `position`（可选，0-based）：插入到父级 children 的位置；缺省时追加到尾部
    - 语义：插件侧以 `plugin.rem.createPortal()` 创建 portal 容器 → `moveRems` 定位 → `targetRem.addToPortal(portalId)` 绑定目标
  - `create_tree_with_markdown`（Markdown 导入树）
    - `markdown`（必填）：Markdown 字符串
    - `parentId`/`parent_id`（必填）：父 Rem id
    - `indentMode`/`indent_mode`（可选，默认 true）：是否启用“按缩进建树”的自研导入器；传 `false` 则强制走 RemNote 原生 `createTreeWithMarkdown`
      - indent 模式为“行级导入”：每行优先用 `createSingleRemWithMarkdown` 解析为富文本（失败降级为纯文本 setText），再按缩进关系挂到对应 parent 下；不会像原生导入那样按 Markdown 块结构（段落/列表/标题）整体建树。
      - todo：`- [ ]` / `- [x]` 会被转换为 RemNote todo（文本会去掉 `[ ]`/`[x]` 前缀）。
      - id 引用：`((<remId>))` 与 `{ref:<remId>}` 都会在导入后尝试修正为“按 RemId 的引用”（仅当该 id 可解析），避免意外创建“名字=remId”的 Rem。
    - `staged`/`staging.enabled`（可选，默认 false）：视觉增强导入（staged import）
      - 语义：先在父级下创建临时容器 Rem，并在其下完成导入，最后一次性 `moveRems` 把根节点移动到 `parentId`（减少“逐层出现”的 UI 抖动）。
      - 失败语义：若最终 move 失败，会 best-effort 自动回滚（删除 staging 容器及其子树，并清理可能已移动的根节点），避免留下过渡项/孤儿 Rem；成功时会删除临时容器。
    - `indentSize`/`indent_size`（可选，默认 2）：indent 模式下每级缩进空格数
    - `parseMode`/`parse_mode`（可选）：`raw`/`ast`/`prepared`
      - `raw`：强制走 RemNote 原生导入（等价于 `indent_mode:false`）
      - `ast`：插件用 remark 解析 Markdown，按标题分段导入（标题用 `createSingleRemWithMarkdown`，正文用 `createTreeWithMarkdown`）
      - `prepared`：同 `ast`，但使用 `prepared.items`（适合上游先做分段）
    - `prepared`（可选）：`{ preface?: string; items: { heading: string; body: string }[] }`（仅 `parse_mode:"prepared"` 使用）
    - `position`（可选，0-based）：控制插入到父级 children 的位置。实现为“原生 `createTreeWithMarkdown` 导入 → 只移动根节点（`parent==parentId`）到指定位置（保序）”，避免把子节点抬平导致结构/顺序错乱。注意 `position` 依赖执行时的 sibling index，页面并发编辑会导致插入点漂移；位置敏感场景优先用 `replace_selection_with_markdown(target.mode='expected')`。
    - `bundle`（可选）：`{ enabled: boolean; title: string }`
      - 用途：避免把大量导入内容“直接插入到现有页面根下”。当 `bundle` 存在时，插件会先创建一个“容器 Rem”，并把 Markdown 导入到该容器之下；**容器 Rem 的文本即 bundle title**（若缺字段则自动降级）。
      - 语义：`position`（如提供）用于定位“容器 Rem”的插入位置；容器内部的导入不再二次应用 `position`。
      - 回执：result 会包含 `bundle.rem_id`（容器 Rem），并把顶层 `created_ids` 收敛为 `[bundle.rem_id]` 以便上游快速定位/回滚。
  - `replace_children_with_markdown`（替换某个 Rem 的 direct children；canonical expand-in-place / section rewrite primitive）
    - `parent_id`（必填）：目标 Rem id
    - `markdown`（必填，可为空字符串）：新 children 内容；空字符串表示清空 direct children
    - `backup`（可选）：`none` / `visible`
      - `none`：默认值；成功路径不保留可见 backup Rem
      - `visible`：显式保留 backup Rem，供 `backup list/cleanup` 治理
      - 大子树场景下，runtime 允许把 `none` 降级为“隐藏 backup + registry.pending”，以规避前端删除确认阻断；此时它不应继续出现在默认可见结果里，并应由后续 cleanup 收尾
    - `assertions`（可选）：固定集合，第一版仅允许
      - `single-root`
      - `preserve-anchor`
      - `no-literal-bullet`
  - `rem.replace`（规范化动作包装器）
    - `surface`（必填）：`children` / `self`
    - `rem_ids`（必填）：目标 Rem 集合
    - `markdown`（必填）：替换内容
    - `assertions`（可选）：结构断言；其中 `preserve-anchor` 仅适用于 `surface:"children"`
    - 语义：
      - `surface:"children"`：编译到 `replace_children_with_markdown`
      - `surface:"self"`：编译到 `replace_selection_with_markdown(target.mode="explicit")`
  - `daily_note_write`（写入 Daily Note；由插件侧定位当天 daily doc）
    - `markdown` / `text`：二选一（内容）
    - `date` / `offset_days`：二选一（目标日期）
    - `prepend`（可选）：true 则插入到 daily doc 顶部
    - `bundle`（可选，同上）：当内容很大时建议启用；写入会先创建容器 Rem（容器文本为 bundle title），再把内容导入到容器下。
      - 例外：若 `daily write --markdown` 的 auto 路径输入本身已经是单一顶层根节点的大纲，CLI 默认不再自动叠加 bundle。
    - `--text` 仅用于纯文本；若输入看起来像结构化 Markdown，CLI 必须 fail-fast 并提示改用 `--markdown`
    - `--force-text` 允许显式保留字面 Markdown 文本
  - `replace_selection_with_markdown`（advanced/local-only 的块级替换 primitive；规范化的 `rem replace --surface self` 会把显式目标集编译到这里）
    - `markdown`：新内容
    - `assertions`（可选）：当前仅允许
      - `single-root`
      - `no-literal-bullet`
      - `preserve-anchor` 不适用于这条 primitive
    - `target.mode`：`expected`（默认，更安全）/ `current` / `explicit`
    - `target.remIds`：`expected`/`explicit` 必填；`expected` 用于执行时校验 selection 未变化，`explicit` 直接按 remIds 执行（不依赖 UI selection）
    - `requireSameParent`/`requireContiguous`：默认 true；用于保证“原地替换”语义明确
    - 替换语义（SSoT 裁决：可补偿步骤）
      - 目标：在**同一位置**把一段 Rem（可能 1 个或多个）替换为新的 Markdown 树，同时确保失败不丢数据。
      - 定位：这是 selection/block-range rewrite，不是默认的 anchor-preserving children rewrite 路径。
      - 原则：**move 优先、delete 最后**。在新内容稳定就位前，禁止对旧内容做不可逆删除；任何中间状态必须可通过 move 回滚或保留备份。
      - 推荐执行流程（插件侧单 op 内部实现）
        1. 读取目标 Rems 的 `parentId` 与最小 `position`
        2. 创建新 Markdown 树并 move 到 `position`（确保新内容已就位）
        3. 将旧 Rems move 到临时备份容器（可逆；失败则回滚新内容并终止）
        4. 最后尝试 delete 备份容器（等价于删除旧内容子树；若删除失败则回滚：删除新内容、把旧内容 move 回原位，并 best-effort 清理备份容器；仍失败时返回 `backup_rem_id` 供手动处理）
      - 说明：队列 txn 只能保证 **op 顺序**，不能保证跨 op 的 all-or-nothing；要做到“失败可回滚”，必须把替换封装为插件侧的单 op（或等价的可补偿 saga）。
- 入队后默认会通过 WS 主动通知插件开始同步（`notify` 默认 true，可传 `notify=false` 禁用）。

## 当前宿主边界

- RemNote 当前公开插件 API 暴露了 `getPropertyType()`、`setTagPropertyValue()`、`setIsProperty()`，没有暴露 `setPropertyType()`。
- 进一步验证宿主端内部 plugin router 后，`rem.setPropertyType` 与 `rem.setSlotType` 这两个 endpoint 也都不存在；直接调用会得到 `Invalid endpoint`。
- 因此，generic property 的“写类型”当前无法通过 CLI/插件执行器完成。
- 受影响命令：
  - `table property set-type`
  - `powerup property set-type`
  - `table property add --type ...`
  - `table property add --options ...`
  - `powerup property add --type ...`
  - `powerup property add --options ...`
- 当前可用面：
  - plain property create 仍支持
  - `table/powerup option add/remove` 仍支持，但目标 property 必须已经是 UI 中存在的 select/multi_select 列，并且本地 DB 中 `ft` 已落为 `single_select` 或 `multi_select`
  - 若需要带 schema 的 typed property，当前只能走 plugin-owned powerup schema registration，而不是 generic property mutation
- 这同样适用于 raw `apply`/op 入口：
  - 通过 `apply` 发送 `set_property_type` 会稳定失败
  - 通过 `apply` 发送 typed `add_property` 也会稳定失败
  - 这些 raw 形式与 `rem.setPropertyType` / `rem.setSlotType` 缺失是同一条宿主边界，不是子命令特例

### 写后双链校验（推荐）

- 场景：把字符串写入某个 Rem 且内容包含 `((RID))` / `{ref:RID}`，希望“写完立即确认是真双链而不是字面文本”。
- 推荐脚本：`scripts/remnote-set-text-verify-ref.mjs`
  - 步骤：`rem set-text --wait` → `rem inspect --expand-references` → 校验 `summary.references` 覆盖目标 RID
  - 失败即非 0 退出，适合给 agent/自动化作为硬门禁。

示例：

```bash
node scripts/remnote-set-text-verify-ref.mjs \
  --subject "<remId>" \
  --text "see also {ref:<targetRemId>}" \
  --timeout-ms 60000 \
  --poll-ms 1000
```

## apply（actions：多步依赖写入）

目标：让 Agent 用一次 `apply --payload` 表达多步依赖写入；通过 `as/@alias` 避免手工传递真实 RemId，并由 daemon 在派发前用 `queue_id_map` 完成 temp id → remote id 替换。

- 入参：`agent-remnote apply --payload <json|@file|->`
- actions envelope 示例：
  - `{"version":1,"kind":"actions","actions":[...]}`
- 输出：
  - enqueue-only 成功：`txn_id`、`op_ids[]`、`alias_map`（alias→`tmp:*`），并包含可执行英文 `nextActions[]`
  - `--ids`：逐行输出 ids（txn_id + op_ids），stderr 为空
- 幂等（强烈建议）：
  - 提供 `--idempotency-key` 时，若命中既有 txn，将复用 txn（`deduped=true`）
  - `alias_map` 会写入 txn meta（`write_plan.alias_map`）并在 dedupe 时回显，保证“重试返回稳定 alias_map”
- 规范化：计划编译出的 ops 在 enqueue 前同样执行 `op.type` canonicalize（与 `apply` 完全一致）。
- silent coalescing：
  - `kind=actions` 允许在 host runtime 中把连续、同质、可证明等价的 scalar action 静默收口为 internal bulk op family
  - 当前已覆盖的典型路径包括：`rem.move`、`portal.create`、`tag.add/remove`、`todo.setStatus`、`source.add/remove`
  - 该优化不要求 caller 改写 command surface，也不承诺 `ops.length === actions.length`
- 引用解析：
  - `@alias` 仅允许出现在 ID 语义字段（action-specific allowlist）；其它字段出现必须 fail-fast
  - daemon 在 dispatch 前对 ID 语义字段做替换：若字段值为 `tmp:*` 且 `queue_id_map` 已有映射，则替换为 remote id（见 013/012 的一致性语义）

- 示例
```
{
  "version": 1,
  "kind": "actions",
  "actions": [
    {
      "as": "idea",
      "action": "write.bullet",
      "input": { "parent_id": "id:<parentRemId>", "text": "First bullet" }
    },
    {
      "action": "tag.add",
      "input": { "rem_id": "@idea", "tag_id": "id:<tagId>" }
    }
  ]
}
```

## 同步触发与执行
- 插件默认“自动连接控制通道 + 连接后自动同步”为开；若关闭控制通道，可通过 `agent-remnote daemon sync` 或 `scripts/ws-trigger-sync.ts` 主动触发。
- 执行器默认会对队列做**受控并发**以提升吞吐（可在插件 Settings 里调 `Sync concurrency`）；但对“同一 Rem 内容修改”“同一父级 children 顺序/结构变更”等风险点会自动串行（锁）。
- 默认调度语义：**同一 txn 内按 `op_seq` 串行派发**（前序必须 `succeeded` 才会派发后续 op）；跨 txn 允许并发（受执行器并发度与锁影响）。如需更复杂的依赖关系，可使用 `queue_op_dependencies`（后续再引入高层入口）。
- 插件收到未知类型会标记致命失败（不重试），便于排错；队列/脚本可用 `scripts/queue-inspect.ts` 查看结果。
  - 建议直接用 `agent-remnote queue inspect` 查看事务/操作详情。

### 回执一致性（attempt_id / CAS ack）

- daemon 派发 `OpDispatch` 时会为本次派发生成 `attempt_id`；插件回 `OpAck` 时必须携带同一个 `attempt_id`。
- 插件可以把同一连接上的多条 `OpAck` 合并为 `OpAckBatch` 发送；daemon 仍按逐项 CAS 语义处理并返回逐项 `AckOk/AckRejected`。
- 当一次 `OpAckBatch` 覆盖多条回执时，daemon 可以再把逐项结果合并为 `AckBatch` 回给插件；插件必须按 item 逐项匹配 waiter。
- daemon 落库回执使用 CAS：只允许命中“当前 in_flight attempt”（`status=in_flight AND locked_by=connId AND attempt_id`）的回执修改 queue_ops/queue_op_results/queue_id_map。
- 若回执过期/乱序（例如多客户端切换、lease 回收后迟到），daemon 会返回 `AckRejected`（见 `docs/ssot/agent-remnote/ws-bridge-protocol.md`），并且不会回滚终态。
- `queue_id_map` 是事实表：同 `client_temp_id` 不得漂移；若回执携带的映射与已有映射冲突，daemon 必须拒绝覆盖并产出可诊断错误（例如 `ID_MAP_CONFLICT`）。

### ack 重试与 dedup（避免映射缺失）

- 插件会在未收到 `AckOk` 前重试发送同一个 `OpAck`（attempt_id 不变），用于降低“执行成功但 AckOk 丢失导致重放”的概率。
- 当存在多条待确认回执时，插件可优先发送 `OpAckBatch`；若超时仍未收到逐项 `AckOk/AckRejected`，再进入重试调度。
- 若收到 `AckBatch`，插件必须把其中每个 item 视为独立确认结果；`AckBatch` 只减少消息数，不改变逐项重试与失败处理语义。
- 若执行器因 `idempotency_key` 触发 dedup，必须返回与第一次执行一致的 result（至少保证 `created/id_map` 等关键映射不缺失）；当前实现为 **进程内缓存**（不跨重启持久化）。

## 故障排查
- 看 `~/.agent-remnote/ws-debug.log`（服务端）与 RemNote DevTools（插件端）消息。
- 若热更新报端口占用，已加入全局守卫与退出清理；少数情况下提示 1 次后即恢复。
