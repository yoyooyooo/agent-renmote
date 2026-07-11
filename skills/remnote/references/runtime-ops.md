# Runtime, Reads, and Operations

Load this file to decide whether to read, wait, use help-first discovery, or enter remote/failure-recovery branches.

## Completion policy

Submit asynchronously by default. Add `--wait` or a separate `queue wait` when one of these conditions holds:

- the user explicitly requests confirmation;
- the next action depends on terminal completion or a newly created real Rem ID;
- a previous transaction returned `sent=0`, `TXN_TIMEOUT`, or `TXN_FAILED`;
- a command family requires a deliberate preview boundary, such as uncertain scenario lowering.

Prefer a business command's own `--wait`; use `queue wait` when a `txn_id` already exists.

## Minimal read ladder

Use the narrowest read that resolves the route:

1. `agent-remnote --json plugin current --compact`
2. `agent-remnote --json plugin selection current --compact`
3. `agent-remnote --json plugin ui-context describe`
4. `agent-remnote rem outline --id <remId> --depth 3 --format md`
5. `agent-remnote --json search --query "<keyword>" --limit 10`

A lightweight outline is appropriate when current child structure affects a replacement/move or when parent placement is uncertain. A supplied stable ID plus a complete payload normally goes straight to the business command.

## Help-first branches

Use help/schema discovery before composing a command when:

- the surface is planned or experimental, especially `scenario`;
- the command family is low-frequency and several flags must align;
- a generic `scope` or `ref` value must match exact supported literals.

High-frequency direct commands do not need ritual preflight help.

## Plugin lifecycle

For local plugin URL, static server, or connection issues, use the closest lifecycle checks:

```bash
agent-remnote plugin ensure
agent-remnote plugin status
agent-remnote plugin logs --lines 50
agent-remnote plugin stop
```

## Remote parity

Read [`remote-parity.md`](remote-parity.md) whenever `apiBaseUrl`, containers, host-only commands, or parity classification matters.

## Failure recovery

Read [`failure-recovery.md`](failure-recovery.md) after a concrete `sent=0`, timeout, wrong-parent, typed-property, plugin, or daemon symptom appears.
