# Table And Property Boundaries

只在这些情况加载本文件：

- 需要处理 table / property 边界
- 用户要改类型、建 typed property、加删 option

## Boundaries

- 如果用户要“把某列改成单选/多选/日期/数字”
  - 不要调用 `table property set-type`
  - 不要调用 `powerup property set-type`
  - 直接说明当前宿主未暴露 property type mutation 能力
- 如果用户要“创建一个带类型的列”
  - 不要用 `table property add --type ...`
  - 不要用 `powerup property add --type ...`
  - 当前只能创建 plain property
- 如果用户要“给列加 option / 删 option”
  - 先假定目标 property 必须已经是 UI 中存在的 `single_select` / `multi_select`
  - remote `apiBaseUrl` 模式下这类命令可以直接走 Host API