# Remote Parity

只在这些情况加载本文件：

- 需要在 `apiBaseUrl` 模式下判断 remote vs host-only
- 需要确认某条命令是否支持透明远端执行
- 需要处理 remote parity、host-only、same-support 分类

## Remote Mode

如果 Agent 不在宿主机，不要碰本地 `remnote.db` / `store.sqlite`。

准备动作只在需要时执行：

```bash
agent-remnote stack ensure --wait-worker --worker-timeout-ms 15000
agent-remnote api status --json
```

推荐一次性配置：

```bash
agent-remnote config set --key apiBaseUrl --value http://host.docker.internal:3000
agent-remnote config validate
```

remote mode 下也保持同样原则：

- 优先一步到位业务命令
- 默认不 wait
- 默认不额外验证

## 1. 已经支持透明 remote 执行

- `plugin current --compact`
- `plugin selection current --compact`
- `plugin ui-context describe`
- `search`
- `query`
- `rem outline`
- `daily rem-id`
- `rem children append|prepend|replace|clear`
- `daily write`
- `apply`
- `queue wait`
- `table/powerup option add/remove`

哪些命令属于 parity-mandatory 的 RemNote business commands，以 `docs/ssot/agent-remnote/runtime-mode-and-command-parity.md` 为唯一权威源；本 skill 只负责路由。

## 2. 当前仍然 host-only，但本质上是未实现成 Host API

- `powerup schema`
- `table record add/update/delete`
- `table show`
- `rem page-id`
- `inspect`
- `by-reference`
- `resolve-ref`
- `references`
- `connections`
- `todos list`
- `daily summary`
- `topic summary`

补充：

- `query --preset todos.list` 已作为本地兼容桥存在
- 目前只完成本地兼容，`apiBaseUrl` 模式仍返回稳定拒绝

## 3. 当前宿主能力本身就不支持

- `table property set-type`
- `powerup property set-type`
- typed `table property add --type/--options`
- typed `powerup property add --type/--options`
- raw `apply` 里的 `set_property_type`
- raw `apply` 里的 typed `add_property`

## Authority

涉及 remote parity、host-only、same-support 分类时，以 `docs/ssot/agent-remnote/runtime-mode-and-command-parity.md` 为唯一权威源。