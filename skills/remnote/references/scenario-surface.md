# Scenario Surface

只在下面这些情况加载本文件：

- 用户提到 `scenario schema *`、`scenario builtin *`、`scenario run`
- 用户提到 builtin scenario id、`~/.agent-remnote/scenarios`
- 用户问 `source_scope`、`target_ref`、`scope` 怎么传
- 用户提到“最近几天”“过去几天”“dry-run 看 lowering”

普通 `rem ...`、`daily write`、`tag ...`、`portal ...` 路由不需要读本文件。

## Status

- `scenario schema validate|normalize|explain|generate` 已可作为本地 authoring/tooling 使用。
- 即使配置了 `apiBaseUrl`，`scenario schema *` 仍然本地执行，不转发到 Host API。
- `scenario run` 当前只属于 planned / experimental namespace，不要把它当 current public stable surface 对外承诺。
- 等 `scenario` promotion 完成后，再把 `scenario run <spec> --var key=value` 当成常规路由。

## User Store

- 用户自定义 scenario 文件默认放在 `~/.agent-remnote/scenarios/*.json`。
- builtin package 可先注入到用户目录：
  - `agent-remnote --json scenario builtin list`
  - `agent-remnote --json scenario builtin install <builtin-id>`
  - `agent-remnote --json scenario builtin install --all --if-missing`

## Help-First Flow

`scenario` 最容易写错的是：

- 先脑补 builtin id
- 先脑补 `--var` key
- 把 `scope` 当成自由文本

遇到 scenario 请求时，按这个顺序：

1. 先看命令 help
   - `agent-remnote scenario run --help`
   - `agent-remnote scenario schema explain --help`
2. 再确认 package 自己暴露了哪些 vars
   - builtin：`agent-remnote --json scenario builtin list`
   - file/user package：`agent-remnote --json scenario schema explain --spec <spec>`
3. 只在确认过 var 名和默认值后，才拼 `--var key=value`
4. 只要这次调用会写入，且你对 lowering 结果没有把握，先跑 `--dry-run`

强规则：

- 不要脑补未声明的 `--var` key。
- `type=scope` / `type=ref` 当前不是自描述 enum；如果值不确定，先查 help、`scenario schema explain` 或 package JSON。
- 不要把旧 token 当兼容别名继续传。
- 默认不要把内部 `SKILL.md` / `references/*.md` / builtin JSON 路径直接暴露给用户；正常回答里直接给结论、步骤和命令。
- 给用户举 file spec 例子时，优先 `@$HOME/...` 或规范化后的绝对路径，不要示范成容易歧义的 `@~...`。

## Common Authoring Commands

- `agent-remnote --json scenario schema validate --spec @./scenario.json`
- `agent-remnote --json scenario schema normalize --spec @./scenario.json`
- `agent-remnote --json scenario schema explain --spec @./scenario.json --var target_ref=daily:today`
- `agent-remnote --json scenario schema generate --hint @./hint.json`

`scenario run <spec>` 是当前更短的执行入口，`--package <spec>` 继续保留为兼容 alias。

`scenario run <spec>` 当前可接受：

- `builtin:<id>`
- `user:<id>`
- `@./scenario.json`
- 非 builtin 的裸 id，会从 `~/.agent-remnote/scenarios/<id>.json` 解析

## Scope Literals

当前常用 `source_scope` 字面量：

- `daily:last-Nd`
  - 含今天
- `daily:past-Nd`
  - 不含今天
- `all`

当前不要使用：

- `daily:previous-Nd`
  - 已退役，不兼容

## Builtin Pattern

如果用户意图是“把过去几天 DN 里的 todo 汇总到今天”，优先这样收敛：

1. 先确认 builtin id 或安装 builtin package
   - `agent-remnote --json scenario builtin list`
   - `agent-remnote --json scenario builtin install <builtin-id>`
2. 再 dry-run 看 lowering
   - `agent-remnote --json scenario run <spec> --dry-run --var source_scope=daily:past-7d --var target_ref=daily:today`
3. 只有 dry-run 的 `plan.compiled_execution` 符合预期，才去掉 `--dry-run`

## Routing Notes

- 参数不确定时，优先 `scenario schema explain`，不要直接 `scenario run`
- 写入型 scenario 默认先 `--dry-run`
- `scenario` 的职责是复用高频工作流，不是发明第二套写入命令体系