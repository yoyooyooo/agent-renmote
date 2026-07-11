# Structured Payload Handoff

Load this file when the input is structured Markdown or a plan produced by `remnote-best-practice`.

## Consumer contract

A complete handoff normally carries:

- **destination** — Daily Note, an existing Rem/page, a new standalone page, or a deck root;
- **anchor** — explicit ID/reference/selection, or an identified unresolved address;
- **mutation** — append, prepend, replace children, clear, create, move/promote, tag, reference, or portal;
- **body** — text or Markdown whose semantic organization is already decided;
- **relations** — link, tag, or portal actions that must be preserved;
- **completion requirement** — queued submission or confirmed completion.

Treat these fields as intent, then map them to the narrowest supported command. Resolve only missing operational addresses. Do not reopen the upstream knowledge-architecture decision unless the plan is internally contradictory.

## Payload preservation

When the body has already been designed upstream:

- preserve its root count, order, wording, hierarchy, references, and source labels;
- use `--markdown -` for structured trees and multiline content;
- use `--text` only for a short literal Rem whose text should not be parsed as structure;
- retain the existing anchor Rem when the mutation is `replace-children`;
- keep links and portals as separate relation intents when the plan distinguishes them.

A transport adjustment may escape shell characters or normalize input encoding; it should not silently rewrite the meaning.

## Address-to-command mapping

| Handoff intent | Primary route |
|---|---|
| Daily Note root append | `daily write` |
| Append under known Rem | `rem children append` |
| Insert first under known Rem | `rem children prepend` |
| Preserve anchor, rewrite its direct children | `rem children replace` |
| Remove direct children, preserve anchor | `rem children clear` |
| Change the anchor's own text | `rem set-text` |
| Create one short literal child | `rem create --text` |
| Create/promote a standalone destination | `rem create --at standalone` or `rem move --at standalone` |
| Multiple actions with created-ID dependencies | `apply --payload` |

Read [`write-basic.md`](write-basic.md) and [`promotion-and-apply.md`](promotion-and-apply.md) for command examples.

## Daily Note addressing

“Write to today's Daily Note” maps directly to `daily write`.

“Write below a specific section inside today's Daily Note” requires the date entry or section address, followed by the appropriate `rem children ...` command. Distinguish the Daily Document container from the dated entry.

## References and portals

A reference creates a semantic link; a portal creates another view of a Rem/subtree. Preserve the upstream distinction.

Stable internal references prefer explicit IDs such as `((RID))` or the supported ID reference form. A portal operation uses the portal business command, for example:

```bash
agent-remnote --json portal create --to "id:<targetRemId>" --at "parent:id:<parentRemId>"
```

## Minimal-read exception

A single lightweight `rem outline` is justified when the requested mutation depends on current direct-child structure or when the target parent is genuinely uncertain. A complete upstream handoff with a known ID normally needs no pre-read.
