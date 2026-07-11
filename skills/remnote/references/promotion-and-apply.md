# Promotion And Apply

只在这些情况加载本文件：

- 需要处理 promotion 路由
- 需要判断是否必须用 `apply --payload`
- 任务存在“后一步依赖前一步新建节点”

## Promotion 路由

当用户意图是“把内容沉淀成独立 destination，并且可选留 portal”时，优先走：

```bash
agent-remnote --json rem create --at standalone --title "..." --markdown @./note.md
agent-remnote --json rem create --at standalone --title "..." --from "id:<remId>"
agent-remnote --json rem create --from-selection --at standalone --title "..." --portal in-place
agent-remnote --json rem move --subject "id:<remId>" --at standalone --portal in-place
```

路由规则：

- 不要再默认走“先写 DN，再手工 portal create，再手工 move”的旧多步路径
- `--is-document` 是显式 opt-in，默认不要自动加
- `--from-selection` 只是 `from[]` 的 sugar
- 单个 `--from` 可推断标题；多个 `--from` 必须显式 `--title`

## 多步依赖写入

只有在以下情况才用 `apply --payload`：

- 后一步依赖前一步新创建的 Rem
- 需要同一个 envelope 里表达多个动作
- 需要 `kind:"ops"` 做 advanced/debug
- 用户下一步还要继续引用这次新建出来的节点

结构化 actions 示例：

```bash
agent-remnote --json apply --payload @plan.json
```

不要把单步写入也升级成 `apply`。