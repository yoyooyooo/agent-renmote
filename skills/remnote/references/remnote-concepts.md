# RemNote Object Model

Load the relevant section when a route depends on the difference between Rem, Page, Daily Note, Reference, Portal, or UI context.

## Rem and remId

A **Rem** is the basic addressable node. It has stable identity, rich-text content, a parent relationship, and sibling order.

A **remId** is the stable address used for precise reads, writes, references, moves, and relations. When the user supplies one, use it directly.

Parent/child structure forms the outline tree. Appending, prepending, replacing children, clearing children, and editing the node's own text are different mutations.

## Page

A Page is also a Rem, presented as a document entry in the UI. Writing “under a page” means targeting that page Rem or a specific descendant.

A title is convenient for humans; a stable ID is the precise execution address. Resolve a title only when an ID/reference is not already available.

## Daily Note

A Daily Note is a date-oriented page. Two addresses are easy to confuse:

- the Daily Document/container;
- the actual dated entry such as `YYYY/MM/DD`.

Use `daily write` when the request targets today's note generally. Resolve the dated Rem only when the request targets a particular section or child position inside it.

## Rich text and Markdown

RemNote stores rich-text/node structure, not a Markdown file. Markdown is an input representation accepted by commands such as `daily write --markdown` and `rem children ... --markdown` and is converted through the supported plugin path.

This distinction matters for structures that Markdown cannot faithfully express. Complex tables, embeds, typed properties, native flashcards, or other rich objects require a supported dedicated operation rather than an assumption that Markdown syntax alone creates them.

## Tree, reference, tag, and portal

These relations solve different problems:

- **parent/child** — where a Rem lives in the outline;
- **reference/backlink** — a semantic link between Rems;
- **tag** — classification/relationship through a tag Rem;
- **portal** — another rendered view of an existing Rem or subtree.

Moving a Rem changes its tree location. Referencing it leaves the source in place. A portal is a view, not a reference token.

## UI context

- **pageRemId** — page open in the current pane;
- **focusedRemId** — Rem containing the cursor;
- **selection** — one or more selected Rems, not necessarily the focused Rem;
- **paneId** — focused pane;
- **focusedPortalId** — view instance in which the focused Rem is being edited.

The best source for live UI context is the plugin push/current-context surface. A stored snapshot may be stale. Database reads can recover content and structure but cannot authoritatively reconstruct the user's current focus.

## Write lifecycle

A normal write travels through queue, optional WS notification, and plugin SDK execution. “Command accepted” and “visible in the UI” are therefore different states. Use a wait only when the user or a dependent action requires terminal confirmation.
