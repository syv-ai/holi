# PRD — Notes & Editor

The note-editing surface: a CodeMirror 6 editor with **simple live-preview** (rendered lines un-render to raw markdown when you click into them — no animation), bound to a multiplayer Yjs document with remote presence. Plus the surrounding note primitives: path-based wiki-links, atomic server-side rename, backreferences/delete surfacing, the file tree, and the markdown rendering pipeline.

> **No animation layer — by design.** The reveal-raw-on-caret behaviour is a **plain decoration swap**: the active line's concealing decorations are simply not applied, and a selection move re-decorates in one paint. There is deliberately no animation of the swap, for two reasons: **animating CodeMirror decorations (font-size/width/position) pegs CM's measure loop on the main thread** — a lesson already paid for — and **an animation/morph layer interacts dangerously with remote multiplayer edits**, requiring an origin-sensitive path to guard on every remote transaction. With a plain swap, a remote edit just re-decorates; there is no animation path to protect. **Rejected approaches (do not re-propose):** a View-Transitions source↔rendered morph (`startViewTransition` dispatching), a frozen-caret `StateField`, and gap-marks/`view-transition-name` plumbing — even hardened, that layer re-inherits the fragility and the multiplayer hazard. Also rejected: a fully conventional source↔rendered mode toggle, which loses the reveal-raw-on-caret feel this product keeps.

---

## Summary

Every note is a **Yjs CRDT Doc** (relay is the source of truth — see [`prd/vaults-collaboration.md`](vaults-collaboration.md)) materialized as a `.md` working copy on each client. The editor is the old repo's CodeMirror 6 stack, ported without its animation layer: live-preview decorations, wiki-link chips, `@`-mentions, slash commands, the markdown **table widget** (`codemirror-markdown-tables`), frontmatter hiding, and markdown **formatting hotkeys** — plus two seams the port adds: a **`y-codemirror.next` binding** to the Doc's `Y.Text` and **remote cursors** from the Yjs **awareness** channel.

The feature set, explicitly (per product direction): reveal-raw-on-click live preview, formatting hotkeys (⌘B/⌘I/…), wiki-links + markdown links (chips, hover, click-to-open), `@`-mentions, slash commands, and the table widget + its package. There is **no** View-Transition morph, no `caretTransitionField`, no `gapMarks`, no `viewTransitionNaming` — see the callout above and §Editor architecture.

Because there's no morph, the multiplayer story is simple: decorations rebuild on any `docChanged` (local or remote), the active-line reveal is derived directly from the current selection (which `yCollab` maps correctly), and remote cursors are awareness decorations that never touch the reveal logic.

Wiki-links are **path-based `[[folder/note.md]]`**, parsed by one grammar module in `packages/shared` (port `vaultRefs.ts` from the old repo), with a thin renderer in the editor (chat lives in the raw xterm drawer with native `--resume` history — see [`prd/agent.md`](agent.md) — so there is no Holi chat renderer). **Why path-based:** links stay human-readable in raw markdown, so Claude can follow *and author* them naturally, and they match Obsidian mental models. **Rejected:** stable doc IDs rendered as paths (opaque `[[doc:a1b2]]` in raw md — harder for the agent to read and author) and hybrid id+slug links (uglier markdown, more normalization). **Rename** is a single atomic **`note_rename` MCP op** that the server executes over the affected CRDT docs — the classic rename-conflict problem comes from *distributed* rewriting (many clients racing to rewrite files), not from path-based links themselves; a central server authority removes it. **Backreferences** and **delete-with-references** surfacing are server queries against a `link_index`, not full-disk scans.

Agent-authored apps/widgets (see [`prd/vault-apps.md`](vault-apps.md) — apps stay out of the editor) and PDF/docx preview ([`prd/_phase2-pdf-docx-preview.md`](_phase2-pdf-docx-preview.md)) are **out of scope** here.

---

## Goals / Non-goals

**Goals**
- The live-preview *feel*: rendered markdown inline; clicking into a line reveals that line's raw source for editing; leaving it re-renders. **Instant swap, no animation.**
- Markdown **formatting hotkeys** — ⌘/Ctrl-B bold, ⌘I italic, and a small standard set — that wrap/unwrap the selection.
- **Wiki-links** and **markdown links** (chips, existing/missing state, hover preview, click-to-open), **`@`-mentions**, **slash commands**, and the **table widget + package**.
- Bind the editor to the Doc's Yjs text so two people editing the same note see each other's changes character-by-character, with **remote cursors/selections**.
- One wiki-link grammar in `packages/shared`; the editor is a thin adapter, the server (rename/link-index) the other consumer.
- Atomic server-side rename + link rewrite; server-backed backrefs and delete surfacing.
- Server-metadata-driven file tree and folder operations.

**Non-goals (v1)**
- A View-Transitions source↔rendered morph and its supporting machinery (frozen-caret `StateField`, gap-marks, `view-transition-name` plumbing) — **rejected**, see the callout at the top.
- Any animation of CodeMirror decorations (font-size/width/position) — banned; it pegs CM's measure loop on the main thread.
- Agent-authored apps / sandboxed `htmlBlock` iframe widgets in notes — apps are their own surface ([`prd/vault-apps.md`](vault-apps.md)); note-embedding stays deferred to keep the editor lean.
- PDF / docx preview — Phase 2 ([`prd/_phase2-pdf-docx-preview.md`](_phase2-pdf-docx-preview.md)).
- A conflict-resolution UI — the CRDT auto-merges; the UI shows only a sync-status indicator (see [`prd/vaults-collaboration.md`](vaults-collaboration.md)).
- Git history / diff view in the editor — there is no git; history is server-side Yjs snapshots ([`prd/server-data.md`](server-data.md)).
- Rich-text WYSIWYG that diverges from markdown-as-source; the source of truth stays markdown text.

---

## User stories

- *As an employee*, I open a note and it renders live — headings, bold, code, checkboxes, links — and clicking into a line reveals that line's raw markdown so I can edit it; moving away re-renders it. The swap is instant.
- *As a writer*, I select a word and press ⌘B and it wraps in `**`; press ⌘B again and it unwraps.
- *As a co-author*, I open a note a teammate is already in; I see their avatar and cursor, and their edits appear as they type without clobbering mine.
- *As a co-author on another line*, when my teammate types three paragraphs above my cursor, my active line doesn't flicker and my caret stays on the same character.
- *As a note-taker*, I type `[[` (or `@`) and get autocomplete over notes, files, and tasks; picking one inserts a path-based link that renders as a chip and opens the target on click, with a hover preview.
- *As someone reorganizing*, I rename a note (or ask the agent to) and every `[[link]]` pointing at it updates atomically — no broken links, no merge conflict, even while others edit those notes.
- *As someone deleting a note*, I'm shown what references it before I confirm.
- *As the agent*, I `Read`/`Edit`/`Write` note working copies with my native tools; my edits merge into the CRDT via the file↔CRDT bridge ([`prd/vaults-collaboration.md`](vaults-collaboration.md)) and reach every co-author.

---

## Functional requirements

1. **Editor stack.** Port `createEditorExtensions` from the old repo, minus its animation layer: base extensions (`drawSelection`, `dropCursor`, `indentOnInput`, `bracketMatching`, `indentUnit('    ')`, search), `frontmatterHideExtension`, the **table widget** (`codemirror-markdown-tables`, with in-cell nested editors), `livePreviewExtension` (simplified, see §Editor architecture), `slashCommandExtension`, `wikiLinkExtension`, markdown/auto link extensions, and the **formatting-hotkeys keymap**. **Do not port** `caretTransitionField`, `gapMarks`, `viewTransitionNaming`, or the `CaretLineTransitionPlugin` VT dispatcher.
2. **Live preview (simplified).** Build the decoration set from the syntax tree over visible ranges: ATX headings (line + content mark), strong/emphasis/inline-code (concealed marks + styled content), fenced code, links (bracket hiding + styled `data-href` anchor), images (widget replace), blockquotes, horizontal rules, task-checkbox widgets, bullet widgets, YAML frontmatter hiding (block widget + atomic range). **Reveal rule:** the line(s) containing the primary selection render as **raw** (concealing decorations are not applied there); all other lines render. On selection change, recompute — the newly-active line un-renders, the previously-active re-renders. **No animation.**
3. **Formatting hotkeys (standard set).** A keymap that wraps/unwraps the selection (or word under caret): **⌘/Ctrl-B** → `**bold**`, **⌘I** → `*italic*`, **⌘E** → `` `inline code` ``, **⌘K** → link (`[sel](url)`), **⌘⇧X** → `~~strikethrough~~`. All toggle-aware (unwrap if already wrapped). Implemented as CM commands over the Yjs-bound doc (edits go through the binding like any transaction). Scoped to editor focus so they don't collide with app-level shortcuts.
3b. **Tight vertical rhythm for rendered blocks.** Rendered block elements — **horizontal rules / dividers**, headings, blockquotes, fenced code, images — must **not** introduce excessive top/bottom padding. In live preview a line's height should stay close to its raw-source height so the document doesn't jump or feel spaced-out as lines render/un-render on caret movement. The HR/divider in particular renders compact (thin rule, minimal margins), not a chunky block. This is a decoration/CSS concern (the widget/line-decoration styles), applied to all block-level rendered decorations.
4. **Multiplayer binding.** Bind the editor to the Doc's `Y.Text` via `y-codemirror.next` (`yCollab`). Local edits produce Yjs updates; remote updates apply as transactions tagged with a remote origin. A `Y.UndoManager` scoped to local origins replaces CM `history` for document edits.
5. **Remote presence.** Render remote cursors/selections from the Yjs awareness channel (the standard Hocuspocus awareness channel — see [`prd/vaults-collaboration.md`](vaults-collaboration.md)), labelled/colored per user; publish the local cursor/selection into awareness. Doc-viewer **avatars** ("who's here") render in the note header from the same channel. Remote cursors are decorations — they never enter the reveal/decoration-rebuild logic as selection changes.
6. **Wiki-links.** Parse `[[folder/note.md]]` (and `[[path|Label]]`) with the shared grammar. Render note chips (exists/missing, click-to-open, `data-wiki-*` for the hover-preview host), task chips, file chips; hover previews; cursor-inside reveals raw source.
7. **Markdown links.** Standard `[text](url)` links render with a styled `data-href` anchor (not a live `href` — the app must not navigate away); click opens externally / resolves internally.
8. **@-mention autocomplete.** Typing `@` opens completion over notes/files/tasks; selecting inserts the corresponding `[[…]]` link. Task mention adds the current note to the task's `related[]` ([`prd/tasks.md`](tasks.md)).
9. **Slash commands.** `/` opens the command menu (task creation, subtask checkbox, table insert); extensible via the provider registry.
10. **Tables.** Keep `codemirror-markdown-tables` (the package) and its nested in-cell editing + paste-table normalization. Verify it composes with `yCollab` transactions.
11. **Rename.** `note_rename` MCP op renames a Doc's path and rewrites every referencing `[[link]]` atomically server-side. It is **docs-only**: task records reference notes by stable ID and need no rewrite.
12. **Backrefs & delete.** Before deleting a note, surface referencing notes + tasks from a server query. After delete, dangling refs render as tombstones ("[deleted note]") — no cascade, no orphan machinery (tasks are server records with stable-ID refs — [`prd/tasks.md`](tasks.md)).
13. **File tree & folders.** Driven by server metadata (Doc paths), not disk scans. Create/rename/move/delete notes and folders through server ops.
14. **Note creation.** Create a Doc at a path (validated via `packages/shared/path`); server assigns identity; client materializes a working copy; editor opens it.

---

## Editor architecture

### Ported from the old repo (platform-agnostic, ports cleanly to TS/React)
- **Live-preview decoration builder** — the `ViewPlugin` that walks the syntax tree over visible ranges and emits decorations for headings/emphasis/code/links/images/blockquotes/HR/task-checkboxes/bullets/frontmatter. Trimmed in the port: it emits no gap marks and no `view-transition-name`s.
- **`widgets/wikiLink.ts`** (chips + hover host hooks), **`commands/mention.ts`**, **`commands/slash.ts`** + registry, the **table** extension/package, frontmatter hiding, paste normalization/clipboard filters.
- *(Not ported: the chat-renderer markdown pipeline — chat is the terminal and history is Claude Code's native `--resume`; there is no Holi chat surface to render markdown for. See [`prd/agent.md`](agent.md).)*

### Not present, by decision: the animation layer
These modules exist in the old repo and are **deliberately not ported** — the approach is rejected, not deferred:
- **`livePreview.ts`'s `CaretLineTransitionPlugin`** (the `startViewTransition` dispatcher, three-tier trigger, `decorationKey` no-op guard).
- **`caretTransitionField.ts`** — `frozenCaretField`/`frozenCaretEffect`/`refreshVTNamesEffect` and the frozen-line selectors. The active-line reveal is derived **directly from `state.selection`**, not a frozen caret.
- **`viewTransitionNaming.ts`** (`ViewTransitionNamer`, sticky-chrome visible-top policy) and **`gapMarks.ts`**. No `view-transition-name`s are emitted anywhere.

**Why:** animating CM decorations pegs CodeMirror's measure loop on the main thread, and a morph layer requires guarding an origin-sensitive animation path against every remote multiplayer edit — a standing hazard that simply doesn't exist with a plain decoration swap. **Rejected:** keeping the morph "hardened" (re-inherits exactly this fragility); a conventional source↔rendered toggle (loses the reveal-raw-on-caret feel).

### The reveal logic
"Which line shows raw" is a pure function of the current selection — no frozen-caret state:

- The live-preview `ViewPlugin` reads `view.state.selection` and **skips concealing decorations on the line(s) the selection touches** (active line renders raw). All other lines render.
- It rebuilds on `docChanged` **and** on `selectionSet`. A selection move re-decorates: previously-active line re-renders, newly-active line reveals. This is a normal decoration recompute — CodeMirror handles it in one paint, no animation, no measure-loop interaction.
- **Performance:** rebuild only over visible ranges and short-circuit when neither the visible text nor the active-line set changed (a cheap rebuild-guard key check).

### The Yjs binding
- **Binding:** `yCollab(ytext, awareness, { undoManager })`. Local CM transactions → Yjs ops; remote Yjs updates → CM transactions with a remote origin; remote cursors from awareness.
- **Undo:** a `Y.UndoManager` scoped to local origins replaces CM `history` for doc edits (undo unwinds *your* edits, not a co-author's).
- **No `onContentChange` seam.** Persistence is CRDT sync (the relay is truth) + the file↔CRDT bridge re-materializing the working copy ([`prd/vaults-collaboration.md`](vaults-collaboration.md)). The editor never writes files directly.
- **Load/teardown:** opening a note attaches the editor to the already-synced `Y.Doc`; closing detaches the binding + awareness field.

### Multiplayer + live-preview (trivial by construction)
Because there is no morph, there is **no origin-sensitive animation path to guard**. The only interactions:
- A remote `docChanged` re-decorates the new text (desired — remote text renders live). It does **not** move the caret or trigger any animation; `yCollab` maps the local selection through the change, so the active-line reveal follows the caret's mapped position.
- Remote cursors/selections are awareness **decorations**, not CM selection changes, so they never affect the local reveal.
- **Acceptance:** with a scripted remote-edit stream (inserts on other lines, inserts before the caret, deletes), the local editor shows no flicker, keeps its active-line reveal stable, keeps the caret on the same logical character, and renders remote text live.

---

## Wiki-links & rename

### Grammar (one module, `packages/shared`)
Port `vaultRefs.ts` from the old repo as the **single source of truth** for the `[[…]]` grammar: `wikiLinkRegex()` (fresh `RegExp` per call), `parseWikiLinks(text): WikiLinkMatch[]` → `{ raw, target, start, end }`. Framework-free (no React/Jotai/CodeMirror), importable by `apps/desktop` and `apps/server` (rename, link index). **Do not port** the `html-widget` fence grammar (note-embedded widgets stay out of the editor; apps are their own surface — [`prd/vault-apps.md`](vault-apps.md)).

### Renderers (thin adapters)
- **Editor chip widget** — `parseWikiLinks` → chip decorations; cursor-inside reveals raw source (same reveal rule as §Editor architecture).
- **Server** (rename, `link_index`) — same `parseWikiLinks` for exact-range rewrites and link extraction. One parser, thin consumers — greedy-vs-lazy drift between parsers cannot occur. (No chat renderer: chat is the raw terminal, history via native `--resume`.)

### Task links
Tasks are structured server **records**, not files ([`prd/tasks.md`](tasks.md)). Note prose carries a stable **`[[task:<id>]]`** textual token — agent-readable and -authorable, resolved against the task collection (no file need exist). It renders as a task chip (status orb + title, click-to-open); the grammar's task-detection helper matches `task:<id>`. This keeps task↔note links visible and editable in the markdown itself (the same readability rationale as path-based wiki-links), *in addition to* the structured `related[]` field. It also applies the system-wide cross-reference principle — **machine references use stable IDs; human prose uses paths** — in prose: the token never encodes a path, so task chips survive any rename untouched.

### Rename — atomic server-side
`note_rename` is an **MCP op** (see [`prd/agent.md`](agent.md)), not a native `mv`, because rename must preserve CRDT Doc identity **and** rewrite links atomically. The **server** (the relay is truth): (a) updates the Doc's `path` (identity/`docs` row stable, only `path` changes); (b) finds affected docs from the `link_index`; (c) applies the `[[link]]` rewrite as **Yjs ops on each affected Doc**, using `parseWikiLinks` to locate exact ranges (never blind substring replace). That is the whole op — `note_rename` is **docs-only**: task `related[]` refs and task `area` store stable IDs and need no rewrite, so no cross-subsystem atomic transaction exists. Merge-safe with concurrent edits to unaffected regions. **Why central:** rename conflicts are a product of *distributed* rewriting — N clients each rewriting every file on disk and racing; one server rewriting only the linked docs' CRDTs atomically excludes that failure mode structurally. **Rejected:** stable-ID links in prose to avoid rewrites entirely (opaque markdown, hostile to the agent); rename detection via bridge content-similarity heuristics (can misfire; kept only as a possible later optimization).

---

## Data & types
- **`packages/shared/wiki-link`** — the grammar (`WikiLinkMatch`, `parseWikiLinks`, `wikiLinkRegex`), imported by the editor and server rename/link-index (no chat consumer).
- **`packages/shared/path`** — path-safety (`VaultPath` / `resolve_relative`, implemented **test-first**; see [`../architecture.md`](../architecture.md) §9). All note/rename/creation paths validate through it. Security-critical.
- **`link_index`** (server; see [`prd/server-data.md`](server-data.md)) — derived `docId → outbound [[targets]]` (+ inverse), maintained on Doc store. Backs rename, backrefs, delete-surfacing without disk scans.
- **Task chip resolution** consumes the task collection (records — [`prd/tasks.md`](tasks.md)), not a file index; the editor's task index facet is fed from the tasks store.

---

## UX / flows
- **Open a note.** File-tree click → open synced Doc → mount editor bound to its `Y.Text` → render live preview + any remote cursors/avatars.
- **Type / format.** Local edits render live; the active line shows raw; ⌘B/⌘I/… wrap the selection; edits propagate to co-authors.
- **Co-editing.** Remote avatars in the header ("who's here"); remote cursors inline; remote edits live, no flicker.
- **Insert a link.** `@` or `[[` → autocomplete → insert `[[path]]` → chip → hover preview → click opens target.
- **Rename.** File-tree or agent `note_rename` → links update atomically → open editors reflect new link text live.
- **Delete.** File-tree delete → dialog lists referencing notes + tasks (server query) → confirm.
- **New note / folder.** Create at a validated path → server assigns Doc identity → working copy materialized → editor opens.
- **Sync status.** One indicator (synced / offline / syncing) — never a conflict dialog (offline edits CRDT-auto-merge; see [`prd/vaults-collaboration.md`](vaults-collaboration.md)).

---

## Edge cases & risks
- **Remote insertion at/before the caret.** `yCollab` maps the local selection through the changeset; the reveal follows the mapped caret. There is no frozen-caret bookkeeping to get wrong — the reveal is a pure function of the mapped selection.
- **Selection spanning multiple lines.** Define the reveal set as every line the selection touches (all show raw while selected); re-render on collapse.
- **Rename touching a doc a co-author has open.** Server Yjs ops fan out and merge with the co-author's concurrent edits to unaffected regions; only the `[[link]]` text changes on their screen. No conflict, no interruption.
- **Bridge vs editor double-apply.** Both the editor (`yCollab`) and the file↔CRDT bridge (on agent writes) mutate the same `Y.Text` — but under the bridge's turn protocol (soft lock + frozen base; see [`prd/vaults-collaboration.md`](vaults-collaboration.md)) an agent turn diffs against a frozen base and applies the patch as positioned Yjs ops (never blind-replaces); the editor's `yCollab` path is untouched by all this and never writes the working copy directly. Convergence is the CRDT's job.
- **Missing-link chips.** "Exists" checks the server Doc set, not local disk — a link can be valid server-side before the working copy materializes. Resolve existence from server metadata.
- **Table widget under CRDT.** The nested in-cell editors mutate the same doc; verify `codemirror-markdown-tables` transactions compose with `yCollab` (no bypassing the binding).
- **Frontmatter hiding** ports unchanged; light, because tasks aren't in note frontmatter (they are server records — [`prd/tasks.md`](tasks.md)).
- **Formatting-hotkey conflicts.** Ensure ⌘B/⌘I/⌘K don't collide with app-level shortcuts; scope to editor focus.

---

## Dependencies
- **vaults-collaboration** ([`prd/vaults-collaboration.md`](vaults-collaboration.md)) — owns the `Y.Doc` store, the `y-codemirror.next` binding contract, awareness, the file↔CRDT bridge + turn protocol, offline cache, sync-status. This PRD consumes the Doc's `Y.Text` + awareness.
- **server-data** ([`prd/server-data.md`](server-data.md)) — owns `docs` (path/identity), `link_index` (backrefs/rename/delete), Doc snapshots/history.
- **agent** ([`prd/agent.md`](agent.md)) — `note_rename` MCP op; native `Read/Edit/Write` drive the bridge. (Chat/history is the terminal via native `--resume` — no rendered chat surface depends on this PRD.)
- **tasks** ([`prd/tasks.md`](tasks.md)) — task chips, `@`-mention task insertion, `related[]` maintenance; task `area` uses the same folder hierarchy the file tree exposes.

---

## Open questions
1. **Rename rewrite granularity.** Confirm the server computes exact `parseWikiLinks` ranges from the current CRDT snapshot and applies relative-position-safe deltas. (Shared with vaults-collaboration.)
2. **`link_index` freshness during rename.** Confirm the re-parse-on-store ordering guarantees a link added microseconds before a rename isn't missed.
3. **Undo semantics.** Confirm `Y.UndoManager` behaves for the formatting hotkeys (a wrap should be one undo step) and that undo of a remote-mapped local edit is sane.

*Resolved:* task references in prose → keep `[[task:<id>]]` textual token (see §Wiki-links). Formatting hotkey set → standard B/I/E/K/strikethrough, toggle-aware (§Functional requirements).

---

## Out of scope / deferred
- **A View-Transitions morph and its machinery** — **rejected**, not deferred (see the callout at the top). If a subtle transition is ever wanted, it must not animate CM decorations.
- **Agent-authored apps / note-embedded widgets** (`htmlBlock` sandboxed iframes, `html-widget` fences) — apps are a separate surface ([`prd/vault-apps.md`](vault-apps.md)); note-embedding stays deferred to keep the editor lean.
- **PDF / docx preview** — Phase 2 ([`prd/_phase2-pdf-docx-preview.md`](_phase2-pdf-docx-preview.md)).
- **Typst export** — Phase 2 ([`prd/_phase2-typst-export.md`](_phase2-typst-export.md)); separate surface, not the editor.
