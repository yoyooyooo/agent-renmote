# Basic Write Routes

只在这些情况加载本文件：

- 需要在 `rem children append|prepend|replace|clear`、`daily write`、`rem create`、`rem set-text`、`tag` 之间选命令
- 任务是单步业务写入，不涉及依赖型 `apply`

## Command Selection Ladder

1. 用户在说“整体替换全部子级 / 所有 chunks / 覆盖整个 section”
   - 用 `rem children replace`
2. 用户在说“清空这个 section / 清空子级”
   - 用 `rem children clear`
3. 用户在说“插到最上面 / 置顶插入”
   - 用 `rem children prepend`
4. 用户在说“追加 / 添加子项 / 塞到下面”
   - 用 `rem children append`
5. 用户是在扩写当前 Rem / 选中的 Rem / 某个现有标题，并且目标是“继续往下分层 / 展开讲讲”
   - 用 `rem children replace`
6. 用户只是说“写到今天日记里”
   - 用 `daily write`

补充裁决：

- `rem children replace` 是默认的 canonical 结构重写命令
- 不要把 `replace markdown` 当成并列默认路径
- 若任务目标是“保留一个现有标题/Rem，自身不动，只重写其 children”，优先 `rem children replace`

## Fastest Path Router

### 已知目标 Rem，追加子级

```bash
cat <<'MD' | agent-remnote --json rem children append --subject <parentRemId> --markdown -
- title
  - point
MD
```

### 已知目标 Rem，顶部插入子级

```bash
cat <<'MD' | agent-remnote --json rem children prepend --subject <parentRemId> --markdown -
- title
  - point
MD
```

### 已知目标 Rem，整体替换全部 direct children

```bash
cat <<'MD' | agent-remnote --json rem children replace --subject <parentRemId> --markdown -
- title
  - point
MD
```

补充：

- 默认不要先读旧 children，也不要手工 `delete + append`
- 如果用户说的是“展开当前选中的这个 Rem”或“就地继续往下分层”，优先：

```bash
cat <<'MD' | agent-remnote --json rem children replace --selection --assert preserve-anchor --assert single-root --markdown -
- title
  - point
MD
```

### 已知目标 Rem，清空 direct children

```bash
agent-remnote --json rem children clear --subject <parentRemId>
```

### 改已有 Rem 自己的文本

```bash
agent-remnote --json rem set-text --subject <remId> --text "..."
```

### 短纯文本新增

```bash
agent-remnote --json rem create --at "parent:id:<parentRemId>" --text "..."
agent-remnote --json daily write --text "..."
```

只适用于短纯文本。如果输入看起来像结构化 Markdown，不要走这条路。

### 写 Daily Note

结构化内容：

```bash
cat <<'MD' | agent-remnote --json daily write --markdown -
- journal
  - item
MD
```

短纯文本：

```bash
agent-remnote --json daily write --text "..."
```

裁决：

- 用户只是说“写到今天日记里”，优先 `daily write`
- 用户要写到今天日记里的某个具体小节或具体 Rem 下面，先拿当天条目 Rem ID，再用 `rem children ...`

### Tag 关系写入

```bash
agent-remnote --json tag add --tag <tagRemId> --to <remId>
agent-remnote --json tag remove --tag <tagRemId> --to <remId>
```

批量关系：

```bash
agent-remnote --json tag add --tag <tagA> --tag <tagB> --to <rem1> --to <rem2>
```

规则：

- 实际语义是 `tags × to`
- 不要脑补成一一配对