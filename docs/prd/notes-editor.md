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
9. **Slash commands.** `/` opens the command menu (task creation, `/todo` checkbox, table insert); extensible via the provider registry. **Not "subtask":** this editor only ever opens **notes** — a task's description is a plain textarea, not CodeMirror — so a checkbox here has no parent task to be a subtask *of*. It inserts a markdown checkbox and is named for one. (`/task`, real task creation, remains deferred until the create-from-editor UX is settled.)
10. **Tables.** Keep `codemirror-markdown-tables` (the package) and its nested in-cell editing + paste-table normalization. Verify it composes with `yCollab` transactions.
11. **Rename.** `notes.rename` renames a Doc's path and rewrites every referencing `[[link]]` atomically server-side. It is **docs-only**: task records reference notes by stable ID and need no rewrite. Reachable **from the file tree** (shipped 2026-07-16) and, as the `note_rename` MCP op, from the agent — the same server op either way, which is the point: the agent could do this from the day the drawer shipped while the obvious affordance in the tree did not exist. **Rename is also move** — a new path with a different folder prefix relocates the note, and the server creates the destination folders. No drag-and-drop: rename-to-path covers the semantics.
12. **Backrefs & delete.** Before deleting a note, surface referencing notes + tasks from a server query. **The warning shipped 2026-07-16**: the delete confirm names each linking note and its occurrence count, from `notes.backrefs` (built, and uncalled until then). No cascade, no orphan machinery — the dangling refs survive on purpose (tasks are server records with stable-ID refs — [`prd/tasks.md`](tasks.md)).
    - **The tombstone half is deferred**, and it is not a small addition. Dangling refs are meant to render as `[deleted note]`, but they live in `related[]`, and **`related[]` has no surface in the renderer at all** — `TaskDetail` has no relations row, and the strings `tombstone`/`[deleted note]` do not exist in the codebase. "Render tombstones" is really "build the relations surface", a separate known gap, and it must not be smuggled in behind a delete button. Shipping the warning without it is not half a feature: it is the *preventive* half, and strictly better than a tree that could not delete at all and so warned about nothing.
13. **File tree & folders.** Driven by server metadata (Doc paths), not disk scans. Create/rename/move/delete notes, and rename folders, through server ops — all reachable from the tree as of 2026-07-16.
    - **Folders stay implicit, and there is no create-folder or delete-folder.** You make a folder by naming a path; `ensureAncestorFolders` writes the rows. Explicit folder ops would be a new server surface and are not built.
    - **An empty folder is always vestigial, so the tree hides it.** Deleting the last note in a folder leaves an orphan `folders` row — a problem that could not exist before delete shipped. The tree drops it from the *display* only: deleting the row would silently unfile every task pointing at that folder as its `area` ([`prd/tasks.md`](tasks.md) — `ON DELETE SET NULL`), because a folder with no docs can legitimately still be a board lane full of tasks. Docs and tasks are different populations over the same folders.
    - **The tree is live**: it rides the `docs` frame on the one user-scoped SSE stream main owns, so a note created, renamed or deleted by a teammate, by your agent, or in another window appears without a refetch. (It was refetch-only-on-vault-activation until 2026-07-16 — the tree simply lied until you switched vaults. Closing that is what the user-scoped stream was for; see `architecture.md` §5.)
14. **Note creation.** Create a Doc at a path (validated via `packages/shared/path`); server assigns identity; client materializes a working copy; editor opens it.
15. **Panes & tabs.** The shell holds more than one open doc at a time, VS Code's preview-vs-pinned model — see §Panes & tabs.
16. **Frontmatter reveal control.** Frontmatter is hidden by default (FR-2) with an explicit control to edit it — see §Panes & tabs.

---

## Panes & tabs

**Status: designed here, not built.** The shell today shows **one** doc at a time (`activeDocAtom`) with a `notes ↔ board` toggle. This section is the missing owner for the shell chrome: `architecture.md` already constrains the pane system ("the pane/tab system must not assume tabs are notes"), [`prd/vault-apps.md`](vault-apps.md) §Tabs *depends* on it ("the pane system must accept non-note tab kinds — the one v1 accommodation this PRD asks for"), and [`prd/daily-notes.md`](daily-notes.md) assumes it ("if the panes ever reach zero tabs"). Three docs pointed at a surface no doc specified. This is that doc.

### Tabs — preview vs pinned

Port VS Code's two-state model, which the old repo also used:
- **Preview tab** (italic title): a single-click in the file tree opens the doc **in the existing preview tab, replacing it**. Browsing a vault therefore costs one tab, not twenty.
- **Pinned tab**: a **double-click** in the tree, a **double-click on the tab**, or **editing the doc** promotes the preview tab to pinned — it stops being replaced. Editing promoting a tab is the rule that matters: it means you can never lose your place by clicking away from something you were typing in.
- Tabs are closeable and reorderable; the tab strip lives in the header bar the `notes/board` toggle occupies today.

**The forward constraint (from `architecture.md`, load-bearing):** a tab is **not** a note. Model a tab as a discriminated union (`{kind: 'note'} | {kind: 'board'} | {kind: 'app', …}`) from the first commit. `board` becomes a tab kind rather than a toggle, and post-v1 vault apps slot in as a third kind without reopening the model. A `Map<docId, …>` tab store forecloses both.

**Open questions:** does each pane keep its own preview tab (VS Code) or is there one per window? Do tabs survive a restart (and if so, where is the strip persisted — `user_state`)? Does the board tab pin automatically, being unique?

### Split panes

Deferred behind tabs, but do not design them out: the state shape should be `panes[] → tabs[]`, not a flat `tabs[]`, so a split is a second pane rather than a rewrite. vault-apps expects "split-screen with notes".

### Frontmatter reveal control

FR-2 hides frontmatter by default (block widget + atomic range). Hiding it with no way back is not shippable, so it needs an explicit control, and the reveal-on-caret rule the rest of live-preview uses is **not** enough on its own here — frontmatter is a structured header, not prose, and a caret wandering into it is as likely to be an accident as an intent.

**Shape:** a right-aligned **button group** in the header bar holding a **"show frontmatter"** toggle. Toggled on, frontmatter opens in a **separate, simpler editor** above the note body — a plain key/value surface, not the full markdown stack — so editing `type:` or `date:` never involves the live-preview machinery. The body editor keeps frontmatter hidden either way.

**Why a separate editor rather than just un-hiding the range:** frontmatter is YAML, and the note editor is a markdown editor — the live-preview decorations, slash menu, wiki-link chips and formatting hotkeys are all wrong inside it, and an errant `⌘B` writing `**bold**` into a YAML key produces a file the task/daily parsers reject. Separating the surfaces means the markdown stack never has to special-case a region it cannot handle.

**Implementation note (the real cost):** the `EditorView` is currently trapped inside `EditorPane`'s effect closure and is never lifted to a ref or atom, so *nothing outside the pane can command the editor*. A header button that toggles a decoration needs that seam first. That, not the widget, is the work.

### Presence in the file tree

Extends FR-5 (presence avatars in the note header) to the tree: a small round avatar with initials on any doc **open or active for another member**, so you can see where the vault is busy without opening anything. Same awareness channel as the header avatars and the same expiry rule — a heartbeat that stops arriving *is* the release (D36/D37); there is no "closed it" event and there must not be one.

**The blocker to size first:** header avatars come from the **per-doc Yjs awareness channel**, which only exists for a doc you have **open** — a tree showing every doc cannot open a Hocuspocus room per row to find out who's there. So this needs a **vault-scoped** presence source (the SSE `presence` frame the board already rides, D36) carrying doc-level entries, not the per-doc awareness channel. The stream itself is user-scoped now, but `presence` is filtered to the active vault before it reaches the renderer, so the source you want is exactly the frame the board reads. Decide that before building the avatars, or the tree will open N rooms and quietly melt.

### Vault dropdown

The vault `<select>` is a native element and cannot hold the "new vault" `+` button that currently sits beside it, nor the settings gear. Replace with a custom dropdown whose list ends in a **"+ New vault…"** row, folding the header's three controls into one. Grouped here because it is the same header bar the tab strip lands in — design the shell chrome once.

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
Tasks are structured server **records** ([`prd/tasks.md`](tasks.md)); their file projection is a view of the record, and note prose never links to it by path. Note prose carries a stable **`[[task:<id>]]`** textual token — agent-readable and -authorable, resolved against the task collection (no file need exist). It renders as a task chip (status orb + title, click-to-open); the grammar's task-detection helper matches `task:<id>`. This keeps task↔note links visible and editable in the markdown itself (the same readability rationale as path-based wiki-links), *in addition to* the structured `related[]` field. It also applies the system-wide cross-reference principle — **machine references use stable IDs; human prose uses paths** — in prose: the token never encodes a path, so task chips survive any rename untouched.

### Rename — atomic server-side
`note_rename` is an **MCP op** (see [`prd/agent.md`](agent.md)), not a native `mv`, because rename must preserve CRDT Doc identity **and** rewrite links atomically. The **server** (the relay is truth): (a) updates the Doc's `path` (identity/`docs` row stable, only `path` changes); (b) finds affected docs from the `link_index`; (c) applies the `[[link]]` rewrite as **Yjs ops on each affected Doc**, using `parseWikiLinks` to locate exact ranges (never blind substring replace). That is the whole op — `note_rename` is **docs-only**: task `related[]` refs and task `area` store stable IDs and need no rewrite, so no cross-subsystem atomic transaction exists. Merge-safe with concurrent edits to unaffected regions. **Why central:** rename conflicts are a product of *distributed* rewriting — N clients each rewriting every file on disk and racing; one server rewriting only the linked docs' CRDTs atomically excludes that failure mode structurally. **Rejected:** stable-ID links in prose to avoid rewrites entirely (opaque markdown, hostile to the agent); rename detection via bridge content-similarity heuristics (can misfire; kept only as a possible later optimization).

---

## Data & types
- **`packages/shared/wiki-link`** — the grammar (`WikiLinkMatch`, `parseWikiLinks`, `wikiLinkRegex`), imported by the editor and server rename/link-index (no chat consumer).
- **`packages/shared/path`** — path-safety (`VaultPath` / `resolve_relative`, implemented **test-first**; see [`../architecture.md`](../architecture.md) §9). All note/rename/creation paths validate through it. Security-critical.
- **`link_index`** (server; see [`prd/server-data.md`](server-data.md)) — derived `docId → outbound [[targets]]` (+ inverse), maintained on Doc store. Backs rename, backrefs, delete-surfacing without disk scans.
- **Task chip resolution** consumes the task collection (records — [`prd/tasks.md`](tasks.md)), **not the task file projection**; the editor's task index facet is fed from the tasks store. Nothing in the editor parses `tasks/`.

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
