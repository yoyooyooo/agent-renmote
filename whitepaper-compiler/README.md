# Whitepaper Compiler Skill

把已经讨论充分的会话、附件、旧方案与真实产物，编译成架构中立、可长期治理不同实现分支的产品与技术白皮书。

## Installation

将整个 `whitepaper-compiler` 目录复制到支持 `SKILL.md` 的 Skills 目录。

默认是 **model-invoked**：当用户要求创建、修订或审计产品与技术白皮书时可自动触发。需要只允许手动调用时，在 `SKILL.md` frontmatter 中增加：

```yaml
disable-model-invocation: true
```

## Example invocations

```text
把当前会话和附件编译成一份产品与技术白皮书。
```

```text
用 whitepaper-compiler 修订现有白皮书：以我刚才的新决定覆盖旧方向。
```

```text
审计这份白皮书，重点检查架构偷渡、助手提案冒充用户决定、价值指标和符合性。
```

## Package map

```text
whitepaper-compiler/
├── SKILL.md          # 运行步骤与完成标准
├── REFERENCE.md      # 来源权威、白皮书契约、叙事架构、质量门禁
├── TEMPLATE.md       # 新建白皮书的自适应骨架
├── CONFORMANCE.md    # 实现分支符合性声明模板
├── EVALS.md          # Skill 与输出的评测规约
└── README.md
```

`SKILL.md` 保持短而可执行；长篇规范通过上下文指针按需读取。每个意思只有一个权威归宿。

## Design notes

本 Skill 以 **编译** 为 leading word：把会话中的决定、期待、候选、实现事实与开放问题，转换成长期身份、价值、不变量、能力、边界与符合性，而不是生成一份更漂亮的会话摘要。
