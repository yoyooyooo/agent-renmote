# Failure Recovery

只在这些情况加载本文件：

- 需要处理 `sent=0`
- 需要处理 `TXN_TIMEOUT`、错误 parent、typed property 失败
- 需要决定 queue / daemon / plugin 的最短排障路径

## 1. `sent=0`

默认处理：

```bash
agent-remnote --json daemon status
agent-remnote plugin ensure
agent-remnote plugin status
agent-remnote plugin logs --lines 50
```

只有在用户要求确认时，再继续：

```bash
agent-remnote daemon sync
agent-remnote --json queue wait --txn "<txn_id>"
```

## 2. 写到了错误 parent

先修 parent，再重写。不要在错误位置上继续 append。

## 3. `daily write --text` 把 Markdown 当字面文本写进去了

删除错误条目，然后改走 `daily write --markdown` 或 `rem children append`。

## 4. `table/powerup option add/remove` 被拒绝

优先判断三件事：

1. 目标 property 是否已经在 UI 中配置成 `single_select` / `multi_select`
2. 宿主机本地 DB 里的 `ft` 是否已经落出来
3. 当前 remote mode 是否真的打到了正确的宿主机 workspace / DB

## 5. 用户要求“程序化创建 typed property”

直接说明当前宿主边界：

- generic property 没有公开的 type mutation endpoint
- 当前只能创建 plain property
- typed schema 需要 UI 配置，或改走 plugin-owned powerup schema