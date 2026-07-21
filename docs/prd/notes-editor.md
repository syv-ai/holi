# PRD — Notes & Editor

The note-editing surface: a CodeMirror 6 editor with **simple live-preview** (rendered lines un-render to raw markdown when you click into them — no animation), backed by a plain `.md` file on disk. Plus the surrounding note primitives: path-based wiki-links, rename with link rewriting, backreferences/delete surfacing, the file tree, and the markdown rendering pipeline.

> **No animation layer — by design.** The reveal-raw-on-caret behaviour is a **plain decoration swap**: the active line's concealing decorations are simply not applied, and a selection move re-decorates in one paint. There is deliberately no animation of the swap, because **animating CodeMirror decorations (font-size/width/position) pegs CM's measure loop on the main thread** — a lesson already paid for. **Rejected approaches (do not re-propose):** a View-Transitions source↔rendered morph (`startViewTransition` dispatching), a frozen-caret `StateField`, and gap-marks/`view-transition-name` plumbing. Also rejected: a fully conventional source↔rendered mode toggle, which loses the reveal-raw-on-caret feel this product keeps.

---

## Summary

Every note is a **`.md` file in the vault repo**. The editor is the old repo's CodeMirror 6 stack, ported without its animation layer: live-preview decorations, wiki-link chips, `@`-mentions, slash commands, the markdown **table widget** (`codemirror-markdown-tables`), frontmatter hiding, and markdown **formatting hotkeys**.

The editor **reads and writes the file directly**. There is no CRDT binding, no awareness channel, and no remote cursors — concurrent editing is deferred ([`../vision.md`](../vision.md)). What replaces the multiplayer seam is much smaller: an **autosave** (idle or ⌘S) that writes the buffer and lets the sync engine commit it, and a **3-way reload** for when the file changes underneath you.

Wiki-links are **path-based `[[folder/note.md]]`**, parsed by one grammar module in `packages/shared` (port `vaultRefs.ts` from the old repo), with a thin renderer in the editor. **Why path-based:** links stay human-readable in raw markdown, so Claude can follow *and author* them naturally, and they match Obsidian mental models. **Rejected:** stable doc IDs rendered as paths (opaque `[[doc:a1b2]]` in raw md — harder for the agent to read and author) and hybrid id+slug links. There is now **only one link grammar** — the `[[task:<id>]]` token is gone with task ids, so a link to a task is a link to a file like any other.

Agent-authored apps/widgets ([`vault-apps.md`](vault-apps.md)) and PDF/docx preview ([`_phase2-pdf-docx-preview.md`](_phase2-pdf-docx-preview.md)) are **out of scope** here.

---

## Goals / Non-goals

**Goals**
- The live-preview *feel*: rendered markdown inline; clicking into a line reveals that line's raw source for editing; leaving it re-renders. **Instant swap, no animation.**
- Markdown **formatting hotkeys** — ⌘/Ctrl-B bold, ⌘I italic, and a small standard set — that wrap/unwrap the selection.
- **Wiki-links** and **markdown links** (chips, existing/missing state, hover preview, click-to-open), **`@`-mentions**, **slash commands**, and the **table widget + package**.
- One wiki-link grammar in `packages/shared`, used by the editor, rename, and backrefs alike.
- Never lose an edit to a write you didn't make — see [External writes](#external-writes).
- Rename + link rewrite in one pass; backrefs and delete surfacing without a server.

**Non-goals (v1)**
- **Multiplayer cursors, presence avatars, and character-level co-editing** — deferred with the collaboration engine. This is the largest single subtraction from the previous design, and it is deliberate.
- A View-Transitions source↔rendered morph and its supporting machinery — **rejected**, see the callout at the top.
- Any animation of CodeMirror decorations — banned.
- Agent-authored apps / sandboxed `htmlBlock` iframe widgets in notes.
- PDF / docx preview — Phase 2.
- Rich-text WYSIWYG that diverges from markdown-as-source; the source of truth stays markdown text on disk.

---

## User stories

- *As an employee*, I open a note and it renders live — headings, bold, code, checkboxes, links — and clicking into a line reveals that line's raw markdown so I can edit it; moving away re-renders it. The swap is instant.
- *As a writer*, I select a word and press ⌘B and it wraps in `**`; press ⌘B again and it unwraps.
- *As a note-taker*, I type `[[` (or `@`) and get autocomplete over notes and tasks; picking one inserts a path-based link that renders as a chip and opens the target on click, with a hover preview.
- *As someone reorganizing*, I rename a note (or ask the agent to) and every `[[link]]` pointing at it updates.
- *As someone deleting a note*, I'm shown what references it before I confirm.
- *As the agent*, I `Read`/`Edit`/`Write` notes with my native tools — they are just files — and the open editor picks up my changes without losing what the user was typing.
- *As a teammate*, I publish; you pull; my note appears in your tree.

---

## Functional requirements

1. **Editor stack.** Port `createEditorExtensions` from the old repo, minus its animation layer: base extensions (`drawSelection`, `dropCursor`, `indentOnInput`, `bracketMatching`, `indentUnit('    ')`, search), `frontmatterHideExtension`, the **table widget** (`codemirror-markdown-tables`, with in-cell nested editors), `livePreviewExtension` (simplified, see §Editor architecture), `slashCommandExtension`, `wikiLinkExtension`, markdown/auto link extensions, and the **formatting-hotkeys keymap**. **Do not port** `caretTransitionField`, `gapMarks`, `viewTransitionNaming`, or the `CaretLineTransitionPlugin` VT dispatcher.
2. **Live preview (simplified).** Build the decoration set from the syntax tree over visible ranges: ATX headings (line + content mark), strong/emphasis/inline-code (concealed marks + styled content), fenced code, links (bracket hiding + styled `data-href` anchor), images (widget replace), blockquotes, horizontal rules, task-checkbox widgets, bullet widgets, YAML frontmatter hiding (block widget + atomic range). **Reveal rule:** the line(s) containing the primary selection render as **raw**; all other lines render. On selection change, recompute. **No animation.**
3. **Formatting hotkeys (standard set).** A keymap that wraps/unwraps the selection (or word under caret): **⌘/Ctrl-B** → `**bold**`, **⌘I** → `*italic*`, **⌘E** → `` `inline code` ``, **⌘K** → link (`[sel](url)`), **⌘⇧X** → `~~strikethrough~~`. All toggle-aware. Scoped to editor focus so they don't collide with app-level shortcuts.
3b. **Tight vertical rhythm for rendered blocks.** Rendered block elements — **horizontal rules / dividers**, headings, blockquotes, fenced code, images — must **not** introduce excessive top/bottom padding. In live preview a line's height should stay close to its raw-source height so the document doesn't jump as lines render/un-render on caret movement.
4. **Persistence.** The buffer is written to the file on an **idle debounce** and on **⌘S**. The sync engine turns that into an autosave commit ([`../architecture.md`](../architecture.md)); the editor knows nothing about git. `⌘S` is a real save and a real commit point, not a placebo — it exists because writers press it and expect a durable moment.
5. **External writes.** The editor holds the text it last loaded as a **base**. On a filesystem change: a **clean** buffer reloads silently; a **dirty** buffer takes a 3-way merge (base / buffer / disk). An unmergeable overlap surfaces the vault's ordinary reconcile affordance. See [External writes](#external-writes).
6. **Wiki-links.** Parse `[[folder/note.md]]` (and `[[path|Label]]`) with the shared grammar. Render note chips (exists/missing, click-to-open, `data-wiki-*` for the hover-preview host), task chips, file chips; hover previews; cursor-inside reveals raw source.
7. **Markdown links.** Standard `[text](url)` links render with a styled `data-href` anchor (not a live `href` — the app must not navigate away); click opens externally / resolves internally.
8. **@-mention autocomplete.** Typing `@` opens completion over notes and tasks; selecting inserts the corresponding `[[…]]` path link. A task mention is an ordinary wiki-link to the task file — there is no `related[]` field to maintain, and no second author for the edge.
9. **Slash commands.** `/` opens the command menu (`/todo` checkbox, table insert); extensible via the provider registry. **Not "subtask":** it inserts a markdown checkbox and is named for one.
10. **Tables.** Keep `codemirror-markdown-tables` (the package) and its nested in-cell editing + paste-table normalization.
11. **Rename.** Renaming a note moves the file and rewrites every referencing `[[link]]` in one pass. Reachable **from the file tree** and, via a vault skill, from the agent. **Rename is also move** — a new path with a different folder prefix relocates the note, creating destination folders as needed. No drag-and-drop: rename-to-path covers the semantics.
    - **Rename must reject a destination that already exists**, checking *before* moving anything. Renaming a folder onto an existing one silently merges them otherwise, and a contained-file collision surfaces halfway through, leaving a half-moved folder.
12. **Backrefs & delete.** Before deleting a note, surface referencing notes and tasks. The delete confirm names each linking file and its occurrence count. **No cascade**: dangling refs survive on purpose and render as tombstones (`[deleted note]`) wherever they appear.
13. **File tree & folders.** Driven by the **filesystem** — the tree is a directory walk plus a watcher. Create/rename/move/delete through ordinary file operations.
    - **Folders are real directories.** They exist because a file is in them, and git does not track empty ones, so an empty folder is a transient local state rather than a row that outlives its contents. The old "vestigial empty folder" problem and its display-level workaround both disappear: there is no row to orphan.
    - **The tree is live** via the filesystem watcher, so a note created by your agent, by a pull, or in another window appears without a refetch.
14. **Note creation.** Create a file at a path (validated via `packages/shared/path-safety`), open it in the editor.
15. **Panes & tabs.** The shell holds more than one open doc at a time, VS Code's preview-vs-pinned model — see §Panes & tabs.
16. **Frontmatter reveal control.** Frontmatter is hidden by default (FR-2) with an explicit control to edit it — see §Panes & tabs.

---

## External writes

The file under the editor can change for three reasons: **the agent wrote it**, **a pull landed it**, or **another window/editor touched it**. All three are the same event, and the editor treats them identically.

- **Clean buffer → reload.** No unsaved edits, so there is nothing to lose. This is the overwhelmingly common case, because autosave fires on idle.
- **Dirty buffer → 3-way merge.** `base` is the text last loaded or saved, `mine` is the buffer, `theirs` is what is now on disk. **This must be built.** The old `agent-merge` module is not a reusable merger: it forked a shadow `Y.Doc` from the base, replayed a diff onto it, and let Yjs reconcile positionally — the merge *was* the CRDT. What survives is the 2-way diff (`fast-diff` with semantic cleanup, which coalesces fragmented ops so a rewrite stays contiguous) and the shape of the idea. A diff3 that **reports conflicts rather than resolving them** is the piece to write; the report is what routes the case to reconcile, so a merger that silently picks a side would remove the feature.
- **Unmergeable overlap → reconcile.** Both sides changed the same region. The editor stops autosaving that file and surfaces the vault's reconcile affordance — the same banner and the same **Ask Claude to reconcile** path a git conflict uses. One conflict story, whatever produced it.

**Why this is not the old bridge.** The bridge existed to translate a file diff into *positioned CRDT operations* against a live multiplayer document, with a soft lock and a frozen base per agent turn. None of that survives: there is one writer target (the file), no remote co-author whose concurrent edits could be reverted by a blind write, and no turn protocol. What is left is the plain 3-way merge that sat at the bridge's center — roughly a tenth of the machinery, and the only tenth that was ever load-bearing here.

**Staleness is still Claude Code's job.** `Edit`/`Write` require a prior `Read` and fail if the file changed since — so the agent's own writes are guarded by CC natively, exactly as before.

---

## Panes & tabs

**Status: designed here, not built.** The shell today shows **one** doc at a time with a `notes ↔ board` toggle. This section is the missing owner for the shell chrome: [`../architecture.md`](../architecture.md) constrains the pane system ("the pane/tab system must not assume tabs are notes"), [`vault-apps.md`](vault-apps.md) §Tabs depends on it, and [`daily-notes.md`](daily-notes.md) assumes it.

### Tabs — preview vs pinned

Port VS Code's two-state model, which the old repo also used:
- **Preview tab** (italic title): a single-click in the file tree opens the doc **in the existing preview tab, replacing it**. Browsing a vault therefore costs one tab, not twenty.
- **Pinned tab**: a **double-click** in the tree, a **double-click on the tab**, or **editing the doc** promotes the preview tab to pinned. Editing promoting a tab is the rule that matters: you can never lose your place by clicking away from something you were typing in.
- Tabs are closeable and reorderable; the tab strip lives in the header bar the `notes/board` toggle occupies today.

**The forward constraint (load-bearing):** a tab is **not** a note. Model a tab as a discriminated union (`{kind: 'note'} | {kind: 'board'} | {kind: 'app', …}`) from the first commit. A `Map<path, …>` tab store forecloses it.

**Open questions:** does each pane keep its own preview tab (VS Code) or is there one per window? Do tabs survive a restart, and where is the strip persisted (`.holi/settings.local.json`)? Does the board tab pin automatically, being unique?

### Split panes

Deferred behind tabs, but do not design them out: the state shape should be `panes[] → tabs[]`, not a flat `tabs[]`, so a split is a second pane rather than a rewrite.

### Frontmatter reveal control

FR-2 hides frontmatter by default. Hiding it with no way back is not shippable, so it needs an explicit control, and the reveal-on-caret rule is **not** enough on its own — frontmatter is a structured header, not prose, and a caret wandering into it is as likely to be an accident as an intent.

**Shape:** a right-aligned **button group** in the header bar holding a **"show frontmatter"** toggle. Toggled on, frontmatter opens in a **separate, simpler editor** above the note body — a plain key/value surface, not the full markdown stack.

**Why a separate editor rather than just un-hiding the range:** frontmatter is YAML, and the note editor is a markdown editor — the live-preview decorations, slash menu, wiki-link chips and formatting hotkeys are all wrong inside it, and an errant `⌘B` writing `**bold**` into a YAML key produces a file the task and daily-note parsers reject. **This matters more now than it did:** a task *is* its frontmatter, and the task detail view and this editor are two surfaces onto the same bytes.

**Implementation note (the real cost):** the `EditorView` is currently trapped inside `EditorPane`'s effect closure and is never lifted to a ref or atom, so *nothing outside the pane can command the editor*. A header button that toggles a decoration needs that seam first. That, not the widget, is the work.

### Vault dropdown

The vault `<select>` is a native element and cannot hold the "new vault" `+` button beside it, nor the settings gear. Replace with a custom dropdown whose list ends in a **"+ New vault…"** row, folding the header's three controls into one. It now also carries the per-vault **sync state** — pulled/ahead-by-N/reconciling — because that is where you look to know which vault you are in.

---

## Editor architecture

### Ported from the old repo
- **Live-preview decoration builder** — the `ViewPlugin` that walks the syntax tree over visible ranges and emits decorations for headings/emphasis/code/links/images/blockquotes/HR/task-checkboxes/bullets/frontmatter. Trimmed in the port: no gap marks, no `view-transition-name`s.
- **`widgets/wikiLink.ts`** (chips + hover host hooks), **`commands/mention.ts`**, **`commands/slash.ts`** + registry, the **table** extension/package, frontmatter hiding, paste normalization/clipboard filters.

### Not present, by decision: the animation layer
These modules exist in the old repo and are **deliberately not ported** — rejected, not deferred:
- **`livePreview.ts`'s `CaretLineTransitionPlugin`** (the `startViewTransition` dispatcher, three-tier trigger, `decorationKey` no-op guard).
- **`caretTransitionField.ts`** — the active-line reveal is derived **directly from `state.selection`**, not a frozen caret.
- **`viewTransitionNaming.ts`** and **`gapMarks.ts`**.

**Why:** animating CM decorations pegs CodeMirror's measure loop on the main thread. **Rejected:** keeping the morph "hardened"; a conventional source↔rendered toggle (loses the reveal-raw-on-caret feel).

### The reveal logic
"Which line shows raw" is a pure function of the current selection — no frozen-caret state:

- The live-preview `ViewPlugin` reads `view.state.selection` and **skips concealing decorations on the line(s) the selection touches**.
- It rebuilds on `docChanged` **and** on `selectionSet`. CodeMirror handles it in one paint.
- **Performance:** rebuild only over visible ranges and short-circuit when neither the visible text nor the active-line set changed.

### The file seam
- **Load:** read the file, seed the buffer, record it as the merge **base**.
- **Save:** idle debounce or ⌘S writes the buffer and advances the base. A write the editor makes must be distinguishable from a foreign one, so the watcher doesn't treat the editor's own save as an external change and reload on top of it — an echo loop that produces a caret jump per keystroke pause.
- **Undo:** plain CodeMirror `history`. The `Y.UndoManager` — which existed so undo unwound *your* edits and not a co-author's — is gone with the co-author.
- **Teardown:** flush a dirty buffer on close, tab switch, vault switch, and app quit. An unflushed buffer is the one way this design can lose data that the CRDT design could not.

---

## Wiki-links & rename

### Grammar (one module, `packages/shared`)
Port `vaultRefs.ts` from the old repo as the **single source of truth** for the `[[…]]` grammar: `wikiLinkRegex()` (fresh `RegExp` per call), `parseWikiLinks(text): WikiLinkMatch[]` → `{ raw, target, start, end }`. Framework-free, importable anywhere. **Do not port** the `html-widget` fence grammar.

### Renderers (thin adapters)
- **Editor chip widget** — `parseWikiLinks` → chip decorations; cursor-inside reveals raw source.
- **Rename and backrefs** — the same `parseWikiLinks` for exact-range rewrites and link extraction. One parser, thin consumers — greedy-vs-lazy drift between parsers cannot occur.

### Task links
A task is a file, so a link to a task is `[[projects/q2/task.fix-login.md]]` — the same grammar, the same chip machinery, resolved the same way. The `[[task:<id>]]` token is **deleted**: it existed because a task was a record with no path, and prose needed a stable handle for it. The chip still renders a status orb and the task's title (read from the file's frontmatter) so it reads as a task rather than as a note.

**The cost, stated plainly:** a task link no longer survives a rename for free. It is rewritten by the same pass that rewrites note links, which is the machinery notes need regardless — but a missed rewrite is now possible where before it was structurally impossible.

### Rename — one local pass
Renaming: (a) collect referencing files (see below); (b) rewrite each `[[link]]` using `parseWikiLinks` to locate exact ranges — **never a blind substring replace**; (c) move the file. Done in that order, so a crash leaves links pointing at a file that still exists rather than the reverse.

**There is no transaction, and there cannot be a perfect one** — this is a multi-file edit on a filesystem. What makes it acceptable is that every step is an ordinary file write inside a git repo: the autosave commit before the rename is a complete, restorable state, and a half-finished rename is visible in `git status` rather than hidden in a database.

**Why the old design put this on the server:** rename conflicts are a product of *distributed* rewriting — N clients each rewriting every file on disk and racing. That failure mode is excluded here for a different reason: only one machine ever performs a given rename, and the result reaches everyone else as a normal commit.

### Backrefs
A grep over the vault for `[[<path>` — no index, no `link_index` table, no maintenance-on-write. **Why no index:** the index existed to avoid a full-disk scan on a server holding many vaults; a local vault of a few thousand files greps in milliseconds, and an index would be a second copy of the truth that can go stale.

---

## Data & types
- **`packages/shared/wiki-links`** — the grammar (`WikiLinkMatch`, `parseWikiLinks`, `wikiLinkRegex`), imported by the editor, rename, and backrefs.
- **`packages/shared/path-safety`** — path containment (`resolve_relative` / `VaultPath`, implemented **test-first**). All note/rename/creation paths validate through it. Security-critical, and *more* load-bearing than before: it is now the only thing standing between a path and the user's filesystem, where the server's authorization checks used to be a second line.
- **`packages/shared/agent-merge`** — the 3-way text merge behind [External writes](#external-writes).
- **Task chip resolution** reads task files' frontmatter, cached by the board's task store.

---

## UX / flows
- **Open a note.** File-tree click → read file → mount editor → render live preview.
- **Type / format.** Local edits render live; the active line shows raw; ⌘B/⌘I/… wrap the selection; autosave writes on idle.
- **Insert a link.** `@` or `[[` → autocomplete → insert `[[path]]` → chip → hover preview → click opens target.
- **Rename.** File-tree rename or agent → links rewritten → open editors reload the changed text.
- **Delete.** File-tree delete → dialog lists referencing files → confirm.
- **New note / folder.** Create at a validated path → editor opens.
- **Sync status.** One indicator per vault (up to date / N to publish / pulling / reconciling). Never a conflict dialog — a conflict is a banner and an offer of help, not a modal demanding a choice.

---

## Edge cases & risks
- **The watcher echoing the editor's own save** — the most likely bug in this PRD. A write must be attributable, or every autosave triggers a reload of the text just written.
- **Selection spanning multiple lines.** Define the reveal set as every line the selection touches; re-render on collapse.
- **A pull landing on the open note while you type.** The 3-way merge case, and the one worth writing a test against first: it is rare enough to go unnoticed and expensive enough to matter.
- **Rename touching a note you have open.** The file moves under an open editor; the tab must follow the file rather than showing a phantom of a path that no longer exists.
- **Missing-link chips.** "Exists" is now a real filesystem check — simpler and more honest than the old server-metadata check, which could report a doc as existing before its working copy materialized.
- **Table widget.** The nested in-cell editors mutate the same buffer; verify they compose with the autosave debounce.
- **Frontmatter hiding** ports unchanged, and now matters for tasks too, whose frontmatter *is* the record.
- **Formatting-hotkey conflicts.** Ensure ⌘B/⌘I/⌘K don't collide with app-level shortcuts; scope to editor focus. **⌘S is now taken** by the editor and must not also trigger a global action.

---

## Dependencies
- **[`../architecture.md`](../architecture.md)** — the sync engine: autosave commits, auto-pull, publish, and the reconcile path this PRD hands unmergeable overlaps to.
- **[`agent.md`](agent.md)** — the agent writes notes with native tools; its writes arrive here as ordinary external writes.
- **[`tasks.md`](tasks.md)** — task files are markdown in the same tree; task chips read their frontmatter.

---

## Open questions
1. **Do task files appear in the notes tree?** Shared with [`tasks.md`](tasks.md). They are markdown files, so by default they do.
2. **Attributing a write.** Is the editor's own save distinguished by path+mtime bookkeeping, by pausing the watcher across the write, or by content comparison? The cheapest correct answer wins; content comparison is the only one that cannot race.
3. **Undo across an external reload.** After a 3-way merge lands foreign text in the buffer, what does ⌘Z mean? Leaning: the merge is a single undoable transaction, so ⌘Z reverts to your text and re-flags the conflict.

*Resolved:* task references in prose → ordinary path wiki-links (§Task links). Formatting hotkey set → standard B/I/E/K/strikethrough, toggle-aware.

---

## Out of scope / deferred
- **Multiplayer cursors, presence, and character-level co-editing** — deferred with the collaboration engine.
- **A View-Transitions morph and its machinery** — **rejected**, not deferred.
- **Agent-authored apps / note-embedded widgets** — apps are a separate surface ([`vault-apps.md`](vault-apps.md)).
- **PDF / docx preview** — Phase 2.
- **Typst export** — Phase 2.
