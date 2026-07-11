# Write Routes

Load this file when choosing among direct Rem/Daily Note commands, promotion, tags, tables/properties, or dependent `apply` actions.

## Route by operational intent

### One direct mutation

Read [`write-basic.md`](write-basic.md) for:

- `rem children append|prepend|replace|clear`;
- `daily write`;
- `rem create --text` and `rem set-text`;
- tag add/remove.

### Standalone destination, move, or portal-preserving promotion

Read [`promotion-and-apply.md`](promotion-and-apply.md) for:

- `rem create --at standalone`;
- `rem move --at standalone`;
- `--from`, `--from-selection`, and `--portal in-place`;
- the boundary between direct promotion and dependent actions.

### Table and property operations

Read [`table-property-boundaries.md`](table-property-boundaries.md) before changing property types, creating typed properties, or adding/removing select options.

### Structured upstream plan

Read [`payload-handoff.md`](payload-handoff.md) when `remnote-best-practice` already supplied destination, mutation, body, links, or portal intent.

## Tight-route rule

A direct business command is the default whenever it fully represents the user's intent. `apply --payload` earns its use only when actions are dependent or must share one action envelope. A known target ID goes straight to that route.
