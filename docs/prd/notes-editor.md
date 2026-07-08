# PRD — Notes & Editor

The note-editing surface: a CodeMirror 6 editor with **simple live-preview** (rendered lines un-render to raw markdown when you click into them — no animation), bound to a multiplayer Yjs document with remote presence. Plus the surrounding note primitives: path-based wiki-links, atomic server-side rename, backreferences/delete surfacing, the file tree, and the markdown rendering pipeline. Decisions referenced as **D#**.

> **Editor rollback (D22).** The old editor grew a large, fragile animation layer — the View-Transitions source↔rendered *morph*, the frozen-caret `StateField`, gap-mark naming, and `view-transition-name` plumbing. **All of that is cut.** We keep the *behaviour* (live preview with reveal-raw-on-caret) as a **plain decoration swap** — no animation, no measure-loop risk, and it composes cleanly with Yjs remote edits. This also erases the biggest risk the plan previously carried (morph-vs-remote-edits). See D22 for rationale.

---

## Summary

Every note is a **Yjs CRDT Doc** (D1) materialized as a `.md` working copy on each client. The editor is a **trimmed** port of the old CodeMirror 6 stack: live-preview decorations, wiki-link chips, `@`-mentions, slash commands, the markdown **table widget** (`codemirror-markdown-tables`), frontmatter hiding, and markdown **formatting hotkeys** — with two new seams: a **`y-codemirror.next` binding** to the Doc's `Y.Text` and **remote cursors** from the Yjs **awareness** channel (D20).

What's **kept** (explicit, per product direction): reveal-raw-on-click live preview, formatting hotkeys (⌘B/⌘I/…), wiki-links + markdown links (chips, hover, click-to-open), `@`-mentions, and the table widget + its package. What's **cut** (D22): the View-Transition morph, `caretTransitionField`, `gapMarks`, and `viewTransitionNaming` — the "grown out of shape" animation/custom logic.

Because there's no morph, the multiplayer story is simple: decorations rebuild on any `docChanged` (local or remote), the active-line reveal is derived directly from the current selection (which `yCollab` maps correctly), and remote cursors are awareness decorations that never touch the reveal logic.

Wiki-links stay **path-based `[[folder/note.md]]`** (D12), parsed by one grammar module in `packages/shared` (ports `vaultRefs.ts`), with thin renderers in the editor and chat. **Rename** becomes a single atomic **`note_rename` MCP op** (D10, D12) that the server executes over the affected CRDT docs. **Backreferences** and **delete-with-references** surfacing become server queries against a `link_index`, not full-disk scans.

Agent-authored HTML apps/widgets and PDF/docx preview are **out of scope** (deferred, D17).

---

## Goals / Non-goals

**Goals**
- Preserve the live-preview *feel*: rendered markdown inline; clicking into a line reveals that line's raw source for editing; leaving it re-renders. **Instant swap, no animation** (D22).
- Markdown **formatting hotkeys** — ⌘/Ctrl-B bold, ⌘I italic, and a small standard set — that wrap/unwrap the selection.
- Keep **wiki-links** and **markdown links** (chips, existing/missing state, hover preview, click-to-open), **`@`-mentions**, **slash commands**, and the **table widget + package**.
- Bind the editor to the Doc's Yjs text so two people editing the same note see each other's changes character-by-character, with **remote cursors/selections** (D20).
- One wiki-link grammar in `packages/shared`; editor and chat are thin adapters (D12).
- Atomic server-side rename + link rewrite (D12); server-backed backrefs and delete surfacing.
- Server-metadata-driven file tree and folder operations.

**Non-goals (v1)**
- The View-Transition morph and its supporting machinery — **removed** (D22).
- Any animation of CodeMirror decorations (font-size/width/position) — banned; it pegs CM's measure loop (D22; prior lesson).
- Agent-authored HTML apps / sandboxed `htmlBlock` iframe widgets — deferred (D17).
- PDF / docx preview — deferred to Phase 2 (D17).
- A conflict-resolution UI — CRDT auto-merges; only a sync-status indicator (D21).
- Git history / diff view in the editor — git is dropped (D3); history is server snapshots.
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
- *As the agent*, I `Read`/`Edit`/`Write` note working copies with my native tools; my edits merge into the CRDT via the bridge (D2) and reach every co-author.

---

## Functional requirements

1. **Editor stack (trimmed).** Port `createEditorExtensions` minus the morph layer: base extensions (`drawSelection`, `dropCursor`, `indentOnInput`, `bracketMatching`, `indentUnit('    ')`, search), `frontmatterHideExtension`, the **table widget** (`codemirror-markdown-tables`, with in-cell nested editors), `livePreviewExtension` (simplified, see §Editor architecture), `slashCommandExtension`, `wikiLinkExtension`, markdown/auto link extensions, and the **formatting-hotkeys keymap** (new). **Do not port** `caretTransitionField`, `gapMarks`, `viewTransitionNaming`, or the `CaretLineTransitionPlugin` VT dispatcher (D22).
2. **Live preview (simplified).** Build the decoration set from the syntax tree over visible ranges: ATX headings (line + content mark), strong/emphasis/inline-code (concealed marks + styled content), fenced code, links (bracket hiding + styled `data-href` anchor), images (widget replace), blockquotes, horizontal rules, task-checkbox widgets, bullet widgets, YAML frontmatter hiding (block widget + atomic range). **Reveal rule:** the line(s) containing the primary selection render as **raw** (concealing decorations are not applied there); all other lines render. On selection change, recompute — the newly-active line un-renders, the previously-active re-renders. **No animation.**
3. **Formatting hotkeys (standard set).** A keymap that wraps/unwraps the selection (or word under caret): **⌘/Ctrl-B** → `**bold**`, **⌘I** → `*italic*`, **⌘E** → `` `inline code` ``, **⌘K** → link (`[sel](url)`), **⌘⇧X** → `~~strikethrough~~`. All toggle-aware (unwrap if already wrapped). Implemented as CM commands over the Yjs-bound doc (edits go through the binding like any transaction). Scoped to editor focus so they don't collide with app-level shortcuts.
3b. **Tight vertical rhythm for rendered blocks.** A genuinely useful refinement carried forward from the current editor: rendered block elements — **horizontal rules / dividers**, headings, blockquotes, fenced code, images — must **not** introduce excessive top/bottom padding. In live preview a line's height should stay close to its raw-source height so the document doesn't jump or feel spaced-out as lines render/un-render on caret movement. The HR/divider in particular renders compact (thin rule, minimal margins), not a chunky block. This is a decoration/CSS concern (the widget/line-decoration styles), applied to all block-level rendered decorations.
4. **Multiplayer binding.** Bind the editor to the Doc's `Y.Text` via `y-codemirror.next` (`yCollab`). Local edits produce Yjs updates; remote updates apply as transactions tagged with a remote origin. A `Y.UndoManager` scoped to local origins replaces CM `history` for document edits.
5. **Remote presence.** Render remote cursors/selections from the Yjs awareness channel (D20), labelled/colored per user; publish the local cursor/selection into awareness. Remote cursors are decorations — they never enter the reveal/decoration-rebuild logic as selection changes.
6. **Wiki-links.** Parse `[[folder/note.md]]` (and `[[path|Label]]`) with the shared grammar. Render note chips (exists/missing, click-to-open, `data-wiki-*` for the hover-preview host), task chips, file chips; hover previews; cursor-inside reveals raw source.
7. **Markdown links.** Standard `[text](url)` links render with a styled `data-href` anchor (not a live `href` — the app must not navigate away); click opens externally / resolves internally.
8. **@-mention autocomplete.** Typing `@` opens completion over notes/files/tasks; selecting inserts the corresponding `[[…]]` link. Task mention adds the current note to the task's `related[]` (D4).
9. **Slash commands.** `/` opens the command menu (task creation, subtask checkbox, table insert); extensible via the provider registry.
10. **Tables.** Keep `codemirror-markdown-tables` (the package) and its nested in-cell editing + paste-table normalization. Verify it composes with `yCollab` transactions.
11. **Rename.** `note_rename` MCP op renames a Doc's path and rewrites every referencing `[[link]]` atomically server-side (D12).
12. **Backrefs & delete.** Before deleting a note, surface referencing notes + tasks from a server query. No orphan machinery (D4 killed `source_file`-as-home).
13. **File tree & folders.** Driven by server metadata (Doc paths), not disk scans. Create/rename/move/delete notes and folders through server ops.
14. **Note creation.** Create a Doc at a path (validated via `packages/shared/path`); server assigns identity; client materializes a working copy; editor opens it.

---

## Editor architecture (preserved vs new vs cut)

### Kept (ports cleanly to TS/React, platform-agnostic)
- **Live-preview decoration builder** — the `ViewPlugin` that walks the syntax tree over visible ranges and emits decorations for headings/emphasis/code/links/images/blockquotes/HR/task-checkboxes/bullets/frontmatter. Trimmed: it no longer emits gap marks or `view-transition-name`s.
- **`widgets/wikiLink.ts`** (chips + hover host hooks), **`commands/mention.ts`**, **`commands/slash.ts`** + registry, the **table** extension/package, frontmatter hiding, paste normalization/clipboard filters.
- **Markdown pipeline** for the chat renderer shares the same wiki-link grammar.

### Cut (D22 — the "grown out of shape" layer)
- **`livePreview.ts`'s `CaretLineTransitionPlugin`** (the `startViewTransition` dispatcher, three-tier trigger, `decorationKey` no-op guard).
- **`caretTransitionField.ts`** — `frozenCaretField`/`frozenCaretEffect`/`refreshVTNamesEffect` and the frozen-line selectors. The active-line reveal is now derived **directly from `state.selection`**, not a frozen caret.
- **`viewTransitionNaming.ts`** (`ViewTransitionNamer`, sticky-chrome visible-top policy) and **`gapMarks.ts`**. No `view-transition-name`s are emitted anywhere.

### The reveal logic, simplified
Without a frozen caret, "which line shows raw" is a pure function of the current selection:

- The live-preview `ViewPlugin` reads `view.state.selection` and **skips concealing decorations on the line(s) the selection touches** (active line renders raw). All other lines render.
- It rebuilds on `docChanged` **and** on `selectionSet`. A selection move re-decorates: previously-active line re-renders, newly-active line reveals. This is a normal decoration recompute — CodeMirror handles it in one paint, no animation, no measure-loop interaction (D22).
- **Performance:** rebuild only over visible ranges (as today) and short-circuit when neither the visible text nor the active-line set changed (a cheap key check — not the old VT `decorationKey`, just a rebuild guard).

### New: the Yjs binding
- **Binding:** `yCollab(ytext, awareness, { undoManager })`. Local CM transactions → Yjs ops; remote Yjs updates → CM transactions with a remote origin; remote cursors from awareness.
- **Undo:** a `Y.UndoManager` scoped to local origins replaces CM `history` for doc edits (undo unwinds *your* edits, not a co-author's).
- **No `onContentChange` seam.** Persistence is CRDT sync (relay is truth, D1) + the file↔CRDT bridge re-materializing the working copy (D2). The editor never writes files directly.
- **Load/teardown:** opening a note attaches the editor to the already-synced `Y.Doc`; closing detaches the binding + awareness field.

### Multiplayer + live-preview (now trivial, D22)
Because the morph is gone, there is **no origin-sensitive animation path to guard**. The only interactions:
- A remote `docChanged` re-decorates the new text (desired — remote text renders live). It does **not** move the caret or trigger any animation; `yCollab` maps the local selection through the change, so the active-line reveal follows the caret's mapped position.
- Remote cursors/selections are awareness **decorations**, not CM selection changes, so they never affect the local reveal.
- **Acceptance:** with a scripted remote-edit stream (inserts on other lines, inserts before the caret, deletes), the local editor shows no flicker, keeps its active-line reveal stable, keeps the caret on the same logical character, and renders remote text live. (Far simpler than the old morph regression suite — no VT assertions.)

---

## Wiki-links & rename

### Grammar (one module, `packages/shared`)
Port `vaultRefs.ts` as the **single source of truth** for the `[[…]]` grammar: `wikiLinkRegex()` (fresh `RegExp` per call), `parseWikiLinks(text): WikiLinkMatch[]` → `{ raw, target, start, end }`. Framework-free (no React/Jotai/CodeMirror), importable by `apps/desktop` (editor + chat) and `apps/server` (rename, link index). **Drop** the `html-widget` fence grammar from v1 (HTML widgets deferred, D17).

### Renderers (thin adapters)
- **Editor chip widget** — `parseWikiLinks` → chip decorations; cursor-inside reveals raw source (same reveal rule as §Editor architecture).
- **Chat renderer** — same `parseWikiLinks`, same chip styling, read-only. One parser, two renderers — the old greedy-vs-lazy drift can't recur.

### Task links under the new model
Old task chips encoded `[[.holi/tasks/<uuid>.md]]` because tasks were files. Tasks are now **records** (D4). **Decided:** keep a stable **`[[task:<id>]]`** textual token in note prose — agent-readable and -authorable, resolved against the task collection (no file need exist). It renders as a task chip (status orb + title, click-to-open) exactly like today; the grammar's task-detection helper matches `task:<id>` instead of the old `.holi/tasks/<uuid>.md` path. This keeps task↔note links visible and editable in the markdown itself (consistent with D12's readability rationale), *in addition to* the structured `related[]` field.

### Rename — atomic server-side (D12)
`note_rename` is an **MCP op** (D10), not a native `mv`, because rename must preserve CRDT Doc identity **and** rewrite links atomically. The **server** (relay = truth, D1): (a) updates the Doc's `path` (identity/`docs` row stable, only `path` changes); (b) finds affected docs from the `link_index`; (c) applies the `[[link]]` rewrite as **Yjs ops on each affected Doc**, using `parseWikiLinks` to locate exact ranges (never blind substring replace); (d) task `related[]` refs update as a structured `tasks` mutation. Merge-safe with concurrent edits to unaffected regions. **Old = N clients rewrite every file on disk and race; new = one server rewrites only linked docs' CRDTs, atomically.**

---

## Data & types
- **`packages/shared/wiki-link`** — ported grammar (`WikiLinkMatch`, `parseWikiLinks`, `wikiLinkRegex`), imported by editor, chat, server rename/link-index.
- **`packages/shared/path`** — path-safety (`VaultPath` / `resolve_relative` reimplemented **test-first**, architecture §9). All note/rename/creation paths validate through it. Security-critical.
- **`link_index`** (server; see [`prd/server-data.md`](server-data.md)) — derived `docId → outbound [[targets]]` (+ inverse), maintained on Doc store. Backs rename, backrefs, delete-surfacing without disk scans.
- **Task chip resolution** consumes the task collection (records, D4), not a file index; the editor's task index facet is fed from the tasks store.

---

## UX / flows
- **Open a note.** File-tree click → open synced Doc → mount editor bound to its `Y.Text` → render live preview + any remote cursors/avatars.
- **Type / format.** Local edits render live; the active line shows raw; ⌘B/⌘I/… wrap the selection; edits propagate to co-authors.
- **Co-editing.** Remote avatars in the header ("who's here", D20); remote cursors inline; remote edits live, no flicker.
- **Insert a link.** `@` or `[[` → autocomplete → insert `[[path]]` → chip → hover preview → click opens target.
- **Rename.** File-tree or agent `note_rename` → links update atomically → open editors reflect new link text live.
- **Delete.** File-tree delete → dialog lists referencing notes + tasks (server query) → confirm.
- **New note / folder.** Create at a validated path → server assigns Doc identity → working copy materialized → editor opens.
- **Sync status.** One indicator (synced / offline / syncing) — never a conflict dialog (D21).

---

## Edge cases & risks
- **Remote insertion at/before the caret.** `yCollab` maps the local selection through the changeset; the reveal follows the mapped caret. No frozen-caret bookkeeping to get wrong (D22 simplified this away).
- **Selection spanning multiple lines.** Define the reveal set as every line the selection touches (all show raw while selected); re-render on collapse.
- **Rename touching a doc a viewer has open read-only.** Server Yjs ops fan out; the read-only client re-renders, never writes. Role gating is on the *op*, not the fan-out.
- **Bridge vs editor double-apply.** Both the editor (`yCollab`) and the file↔CRDT bridge (D2, on agent writes) mutate the same `Y.Text` — both go through Yjs ops (bridge diffs, never blind-replaces, architecture §2); the editor never writes the working copy directly. Convergence is the CRDT's job.
- **Missing-link chips.** "Exists" checks the server Doc set, not local disk — a link can be valid server-side before the working copy materializes. Resolve existence from server metadata.
- **Table widget under CRDT.** The nested in-cell editors mutate the same doc; verify `codemirror-markdown-tables` transactions compose with `yCollab` (no bypassing the binding).
- **Frontmatter hiding** ports unchanged; lighter now that tasks aren't in note frontmatter (D4).
- **Formatting-hotkey conflicts.** Ensure ⌘B/⌘I/⌘K don't collide with app-level shortcuts; scope to editor focus.

---

## Dependencies
- **vaults-collaboration** (D1/D2/D20) — owns the `Y.Doc` store, the `y-codemirror.next` binding contract, awareness, the file↔CRDT bridge, offline cache, sync-status. This PRD consumes the Doc's `Y.Text` + awareness.
- **server-data** ([`prd/server-data.md`](server-data.md)) — owns `docs` (path/identity), `link_index` (backrefs/rename/delete), Doc snapshots/history.
- **agent** (D5/D10) — `note_rename` MCP op; native `Read/Edit/Write` drive the bridge; chat shares the wiki-link grammar.
- **tasks** (D4/D4a) — task chips, `@`-mention task insertion, `related[]` maintenance; task `area` uses the same folder hierarchy the file tree exposes.

---

## Open questions
1. **Rename rewrite granularity.** Confirm the server computes exact `parseWikiLinks` ranges from the current CRDT snapshot and applies relative-position-safe deltas. (Shared with vaults-collaboration.)
2. **`link_index` freshness during rename.** Confirm the re-parse-on-store ordering guarantees a link added microseconds before a rename isn't missed.
3. **Undo semantics.** Confirm `Y.UndoManager` behaves for the formatting hotkeys (a wrap should be one undo step) and that undo of a remote-mapped local edit is sane.

*Resolved:* task references in prose → keep `[[task:<id>]]` textual token (see §Wiki-links). Formatting hotkey set → standard B/I/E/K/strikethrough, toggle-aware (§Functional requirements).

---

## Out of scope / deferred
- **The View-Transition morph and its machinery** — **removed** (D22), not deferred. If a subtle transition is ever wanted, it must not animate CM decorations.
- **Agent-authored HTML apps / widgets** (`htmlBlock` sandboxed iframes, `html-widget` fences) — deferred (D17); its own PRD when revived.
- **PDF / docx preview** — deferred to Phase 2 (D17).
- **Typst export** (Phase 2, D17) — separate surface, not the editor.
