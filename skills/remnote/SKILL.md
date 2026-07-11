---
name: remnote
description: >-
  RemNote execution router for agent-remnote. Use when the user wants to read, write, move,
  replace, clear, tag, portal, query, or troubleshoot RemNote; when a remId, parentRemId,
  current page, focus, selection, or Daily Note must be resolved; when apiBaseUrl, queue,
  plugin, daemon, scenario, table, or property behavior matters; or when a prepared RemNote
  asset plan must be executed. Own addressing, the shortest correct supported command,
  submission, wait/verification, and recovery. Use remnote-best-practice first for semantic
  placement and note shape, and srs-card-engineering first for SRS card design.
---

# RemNote — Execution Router

Use a **tight route**: express the user's RemNote intent with the shortest correct supported business command, read only what the route needs, and report the actual completion state honestly.

## Responsibility boundary

This skill owns:

- locating the target Rem, page, Daily Note, selection, table, tag, or portal;
- choosing and issuing `agent-remnote` commands;
- deciding whether a read, wait, dry-run, or recovery step is operationally necessary;
- handling local versus `apiBaseUrl` execution and queue/plugin/daemon failures.

This skill consumes content; it does not decide what knowledge deserves a page, how research should be organized, or what makes a good SRS card.

Use this collaboration chain when a request spans layers:

1. `semantic-decompression`, when the source still lacks a learnable explanation;
2. `srs-card-engineering`, when repeated recall practice is the goal;
3. `remnote-best-practice`, when destination, page boundaries, links, or Rem tree shape must be designed;
4. `remnote`, to resolve addresses and execute the resulting write/read plan.

Invoke this skill directly for purely operational requests such as “replace these children,” “what is the current focus,” “move this Rem,” or “why is the queue stuck.”

## Tight-route procedure

### 1. Classify the operation

Choose one primary branch:

- read/context discovery;
- single-step write or structural edit;
- promotion/move/portal;
- dependent multi-step transaction;
- tag, table, or property operation;
- scenario authoring or execution;
- runtime, remote-mode, or failure recovery.

**Completion criterion:** the task has one primary operational intent; content-design questions have already been handed to the appropriate upstream skill.

### 2. Resolve only the address the command requires

Prefer, in order:

1. an explicit `remId`, `parentRemId`, or supplied reference;
2. the current selection/focus/page when the user clearly refers to it;
3. a lightweight outline or targeted lookup when structure is genuinely needed;
4. broader search only when no narrower address exists.

Treat an explicit stable ID as the address. Do not spend a read merely to rediscover it.

**Completion criterion:** every mutating command has an unambiguous subject/parent/target, or the response clearly identifies the single unresolved address.

### 3. Select the shortest supported business command

Use one command when one command expresses the intent. Use `apply --payload` only when later actions depend on objects created earlier in the same envelope or the operation is inherently multi-action.

Read [`references/write-routes.md`](references/write-routes.md) for write selection and [`references/payload-handoff.md`](references/payload-handoff.md) when consuming structured Markdown or a plan from `remnote-best-practice`.

**Completion criterion:** no extra pre-read, delete/recreate sequence, manual move, or generic `apply` remains when a direct business command exists.

### 4. Submit with truthful completion semantics

The default successful outcome is **accepted/queued**, not necessarily already rendered in the RemNote UI.

Wait only when:

- the user explicitly asks for confirmed completion;
- the next action requires the created Rem's real ID or terminal result;
- an earlier response was `sent=0`, `TXN_TIMEOUT`, or `TXN_FAILED`;
- a dry-run/verification boundary is intrinsic to the command family, such as uncertain scenario lowering.

Read [`references/runtime-ops.md`](references/runtime-ops.md) for the exact policy.

**Completion criterion:** the response distinguishes submitted, delivered, completed, failed, and unknown outcomes instead of collapsing them into “done.”

### 5. Recover along the shortest evidence path

On failure, inspect the nearest relevant layer first: command result → queue transaction → daemon/plugin connection → host/remote parity. Preserve idempotency where retry could duplicate a write.

Read [`references/failure-recovery.md`](references/failure-recovery.md) only after a concrete failure signal appears.

**Completion criterion:** the recovery step tests a specific failure hypothesis and does not expand into an unrelated full-system audit.

## Operational invariants

- Every write travels through the supported `queue -> WS -> plugin SDK` path.
- The official RemNote database is never mutated directly.
- Structured data writes use the supported `table ...` surface.
- A known stable ID is used directly.
- Remote execution targets the configured host API rather than a container-local RemNote database.
- Signals such as “queued” or “sent” are reported at their real semantic level.
- Current support and remote parity are taken from the project SSOT, not guessed from command names.

## Progressive disclosure

Load only the branch needed for the current task.

### RemNote object model

Read [`references/remnote-concepts.md`](references/remnote-concepts.md) when Rem, Page, Daily Note, Reference, Portal, selection, focus, or UI context could be confused.

### Basic writes, promotion, and dependent actions

Read [`references/write-routes.md`](references/write-routes.md) to choose among:

- `rem children append|prepend|replace|clear`;
- `daily write`, `rem create`, `rem set-text`, `rem move`;
- tags, portals, tables, properties;
- direct business commands versus `apply --payload`.

### Structured payload handoff

Read [`references/payload-handoff.md`](references/payload-handoff.md) when content arrives as Markdown or as a destination/mutation/body/link plan from `remnote-best-practice`.

### Runtime, remote mode, and failure recovery

Read [`references/runtime-ops.md`](references/runtime-ops.md) to decide reads, waits, plugin lifecycle, remote parity, and the next recovery step.

### Scenario surface

`scenario schema validate`, `scenario schema normalize`, `scenario schema explain`, and `scenario schema generate` form the local authoring/tooling surface. Use `scenario builtin install` for builtin packages; user packages live under `~/.agent-remnote/scenarios`. `scenario run` remains planned/experimental until its promotion preconditions are complete.

Read [`references/scenario-surface.md`](references/scenario-surface.md) whenever the user mentions `scenario schema`, `scenario builtin`, `scenario run`, `source_scope`, `target_ref`, or dry-run lowering.

## Final route check

Before answering or executing, verify all of the following:

- the command family matches the user's verb;
- the address is explicit or minimally resolved;
- one-step intent stays one step;
- waiting and verification match the user's dependency, not a blanket safety ritual;
- the response states what is known to have completed;
- content design and SRS cognition remain owned by their upstream skills.
