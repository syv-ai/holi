# PRD — Notes & Editor

The note-editing surface: a CodeMirror 6 editor with **simple live-preview** (rendered lines un-render to raw markdown when you click into them — no animation), backed by a plain `.md` file on disk. Plus the surrounding note primitives: path-based wiki-links, rename with link rewriting, backreferences/delete surfacing, the file tree, and the markdown rendering pipeline.

> **No animation layer in the text — by design, with one exception, and a bounded class of exceptions for the OBJECTS in a document (D98).** The app now has one motion vocabulary ([`../architecture.md`](../architecture.md) §9), and the line it draws inside a note is **"is it a thing you can click"**, not "is it in the editor": wiki-link chips, task chips, status orbs, the round checkbox, images, the table widget and the frontmatter rows respond under the pointer, and **prose, headings and code never move**. Everything reaching inside CodeMirror is **paint only** — colour, background, border, shadow, opacity, and transforms that do not change the layout box. Never width, height, font-size, padding or margin, which is what pegs the measure loop. A hover that resized a chip would relayout the line under the pointer, which is the cost this whole section exists to refuse. The heading slide below is now classified as RESPOND and takes `--motion-respond`.
>
> **The reveal-raw swap itself stays instant.** The reveal-raw-on-caret behaviour is a **plain decoration swap**: the concealing decorations on the element the caret is on are simply not applied, and a selection move re-decorates in one paint. There is deliberately no animation of the swap, because **animating CodeMirror decorations (font-size/width/position) pegs CM's measure loop on the main thread** — a lesson already paid for. **Rejected approaches (do not re-propose):** a View-Transitions source↔rendered morph (`startViewTransition` dispatching), a frozen-caret `StateField`, and gap-marks/`view-transition-name` plumbing. Also rejected: a fully conventional source↔rendered mode toggle, which loses the reveal-raw-on-caret feel this product keeps.
>
> **The exception is a heading's `#`, which slides** rather than blinking (2026-09-09). It is the block whose text moves furthest when its marks appear, and it is the only one that animates. What makes it affordable is that it is not a decoration animation at all: the mark is a **`Decoration.mark` that never changes**, so CodeMirror keeps the same DOM element across the swap, and only CSS moves — `width: 0` ↔ `width: auto` under `interpolate-size: allow-keywords`, over `--duration-base`. A `Decoration.replace` takes the text out of the DOM and would leave nothing to transition. **No measurement:** the marks are one to six `#` plus a space in the vault's own face (a width no CSS unit knows, since `ch` is the width of a zero), and `auto` is the browser doing that measurement for free. The mark must be `white-space: pre` — `.cm-line` is `pre-wrap`, and at zero width that wraps the `## ` inside its own clipped box and makes the heading line three lines tall.
>
> **The transition is gated on a caret move** (`.cm-heading-sliding`, put on by `editor/heading-slide.ts` for a moment after any selection change). Declared unconditionally, every heading in a file animated its marks shut the moment the file opened: CodeMirror creates the mark span and settles its style in two steps, so the element's first resolved width is `auto` and the rule closing it reads as a change to transition. `@starting-style` does not help — this is not an insertion. `ViewPlugin.update` runs before the DOM is written, which is what lets the class arrive in time; a mark rendered by a scroll or a file open finds transitions off and simply appears closed.
>
> **The caret needs its own half too** (same file). `drawSelection` draws the caret from coordinates read once per update, so it is placed where the text was when the transition *started* and left there, short by the width of the marks, until the next edit snaps it across. `view.requestMeasure()` does not fix it: the caret is a `layer`, and a layer recomputes only when its own measure request is queued, which happens on a transaction or a doc-view update and on nothing else. Dispatching a transaction per frame would work and would also rebuild every decoration in the viewport fifteen times for one caret move, which is exactly the cost this section refuses. So the plugin does the cheap half itself — one `coordsAtPos` and one `left`, per frame, only while a `transitionrun` on a heading mark is outstanding.
>
> **The frontmatter block opens and closes smoothly** (2026-09-24), the one place in a note where height moves. A toggle replaces the widget rather than changing it, so the press records the old block's height and the new block animates from it to `auto` (`interpolate-size`, the heading slide's device), on `--motion-arrive` opening and `--motion-leave` closing, with the fields fading in. It is affordable because it is one block at the top of the document: the text under it reflows as ordinary DOM, and CodeMirror measures once, when the block lands. The space under the block is `2.5rem`, the same open or closed.

---

## Summary

Every note is a **`.md` file in the vault repo**. The editor is the old repo's CodeMirror 6 stack, ported without its animation layer: live-preview decorations, wiki-link chips, `@`-mentions, slash commands, the markdown **table widget** (`codemirror-markdown-tables`), frontmatter hiding, and markdown **formatting hotkeys**.

The editor **reads and writes the file directly**. There is no CRDT binding, no awareness channel, and no remote cursors — concurrent editing is deferred ([`../vision.md`](../vision.md)). What replaces the multiplayer seam is much smaller: an **autosave** (idle or ⌘S) that writes the buffer and lets the sync engine commit it, and a **3-way reload** for when the file changes underneath you.

Wiki-links are **path-based `[[folder/note.md]]`**, parsed by one grammar module in `packages/shared` (`wiki-links.ts`, ported from the old `vaultRefs.ts`), with a thin renderer in the editor. **Why path-based:** links stay human-readable in raw markdown, so Claude can follow *and author* them naturally, and they match Obsidian mental models. **Rejected:** stable doc IDs rendered as paths (opaque `[[doc:a1b2]]` in raw md — harder for the agent to read and author) and hybrid id+slug links. There is now **only one link grammar** — the `[[task:<id>]]` token is gone with task ids, so a link to a task is a link to a file like any other.

Agent-authored apps/widgets ([`vault-apps.md`](vault-apps.md)) and in-place viewing of binaries Holi cannot render are **out of scope** here — both are in [`../not-built.md`](../not-built.md).

---

## Goals / Non-goals

**Goals**
- The live-preview *feel*: rendered markdown inline; putting the caret on an **element** reveals that element's raw source for editing; leaving it re-renders. **Instant swap, except a heading's `#`, which slides.**
- Markdown **formatting hotkeys** — ⌘/Ctrl-B bold, ⌘I italic, and a small standard set — that wrap/unwrap the selection.
- **Wiki-links** and **markdown links** (chips, existing/missing state, hover preview, click-to-open), **`@`-mentions**, **slash commands**, and the **table widget + package**.
- One wiki-link grammar in `packages/shared`, used by the editor, rename, and backrefs alike.
- Never lose an edit to a write you didn't make — see [External writes](#external-writes).
- Rename + link rewrite in one pass; backrefs and delete surfacing without a server.

**Non-goals (v1)**
- **Multiplayer cursors, presence avatars, and character-level co-editing** — deferred with the collaboration engine, and there is no design, because the engine it would ride on does not exist. This is the largest single subtraction from the previous design, and it is deliberate.
- A View-Transitions source↔rendered morph and its supporting machinery — **rejected**, see the callout at the top.
- Any animation of CodeMirror decorations — banned.
- Agent-authored apps / sandboxed `htmlBlock` iframe widgets in notes.
- **Opening a binary Holi cannot render** — a PDF or `.docx` gets a typed placeholder, not a viewer ([`../not-built.md`](../not-built.md)).
- Rich-text WYSIWYG that diverges from markdown-as-source; the source of truth stays markdown text on disk.

---

## User stories

- *As an employee*, I open a note and it renders live — headings, bold, code, checkboxes, links — and clicking into a line reveals that line's raw markdown so I can edit it; moving away re-renders it. The swap is instant.
- *As a writer*, I select a word and press ⌘B and it wraps in `**`; press ⌘B again and it unwraps.
- *As a note-taker*, I type `[[` (or `@`) and get autocomplete over notes and tasks; picking one inserts a path-based link that renders as a chip and opens the target on click, with a hover preview.
- *As someone reorganizing*, I rename a note (or ask the agent to) and every `[[link]]` pointing at it updates.
- *As someone deleting a note*, I'm shown what references it before I confirm.
- *As the agent*, I `Read`/`Edit`/`Write` notes with my native tools — they are just files — and the open editor picks up my changes without losing what the user was typing.
- *As a teammate*, I edit a note; it pushes on its own; you pull; my note appears in your tree.

---

## Functional requirements

1. **Editor stack.** `editor/extensions.ts` — `baseEditorExtensions` — ported from the old repo's `createEditorExtensions` minus its animation layer: base extensions (`drawSelection`, `dropCursor`, `indentOnInput`, `bracketMatching`, `indentUnit('    ')`, search), `frontmatterExtension`, the **table widget** (`codemirror-markdown-tables`, with in-cell nested editors), `livePreview` (simplified, see §Editor architecture), `slashCommands`, the wiki-link chips and hover preview, markdown/auto link extensions, and the **formatting-hotkeys keymap**. Two narrower builds sit beside it — `mailComposerExtensions` and `plainTextExtensions` — over the same base. **Not ported:** `caretTransitionField`, `gapMarks`, `viewTransitionNaming`, and the `CaretLineTransitionPlugin` VT dispatcher.

   Every completion popup in the app — this stack's, the mail composer's, and the settings files' — is built by `holiCompletion` in `editor/completion.ts`, which is the renderer's only caller of CodeMirror's autocompletion extension. Its chrome is `completionChrome` in `editor/theme.ts`, on semantic tokens, and every selector there is written to outrank CodeMirror's own (D99).
2. **Live preview (simplified).** Build the decoration set from the syntax tree over visible ranges: ATX headings (line + content mark), strong/emphasis/inline-code (concealed marks + styled content), fenced code, links (bracket hiding + styled `data-href` anchor), images (widget replace), blockquotes, horizontal rules, task-checkbox widgets, bullet widgets, YAML frontmatter hiding (block widget + atomic range). **Reveal rule:** the **element** the primary selection touches renders as **raw**; everything else renders, including the rest of that element's own line. Touching an **edge counts**, so marks you have just typed do not close under your fingers, and when elements nest only the **innermost** one opens. On selection change, recompute. **No animation** apart from the heading `#` above.
3. **Formatting hotkeys (standard set).** A keymap that wraps/unwraps the selection (or word under caret): **⌘/Ctrl-B** → `**bold**`, **⌘I** → `*italic*`, **⌘E** → `` `inline code` ``, **⌘K** → link (`[sel](url)`), **⌘⇧X** → `~~strikethrough~~`. All toggle-aware. Scoped to editor focus so they don't collide with app-level shortcuts.
3b. **Tight vertical rhythm for rendered blocks.** Rendered block elements — **horizontal rules / dividers**, headings, blockquotes, fenced code, images — must **not** introduce excessive top/bottom padding. In live preview a line's height should stay close to its raw-source height so the document doesn't jump as lines render/un-render on caret movement.
4. **Persistence.** The buffer is written to the file on an **idle debounce** and on **⌘S**. The sync engine turns that into an autosave commit ([`../architecture.md`](../architecture.md)); the editor knows nothing about git. `⌘S` is a real save and a real commit point, not a placebo — it exists because writers press it and expect a durable moment.
5. **External writes.** The editor holds the text it last loaded as a **base**. On a filesystem change: a **clean** buffer reloads silently; a **dirty** buffer takes a 3-way merge (base / buffer / disk). An unmergeable overlap surfaces the vault's ordinary reconcile affordance. See [External writes](#external-writes).
6. **Wiki-links.** Parse `[[folder/note.md]]` (and `[[path|Label]]`) with the shared grammar. Render note chips (exists/missing, click-to-open, `data-wiki-*` for the hover-preview host), task chips, file chips; hover previews; cursor-inside reveals raw source.
7. **Markdown links.** Standard `[text](url)` links render with a styled `data-href` anchor (not a live `href` — the app must not navigate away); click opens externally / resolves internally.
8. **@-mention autocomplete.** Typing `@` opens completion over notes and tasks; selecting inserts the corresponding `[[…]]` path link. A task mention is an ordinary wiki-link to the task file — there is no `related[]` field to maintain, and no second author for the edge. The list is **grouped**: Notes above Tasks, under headers. A task's row carries the explorer's own status glyph rather than repeating the status as text, and a due date rides as a trailing pill; a note wears its vault emoji when `icons.yaml` gives it one.
9. **Slash commands.** `/` opens the command menu (`/todo` checkbox, `/table`). **A command may take an argument**, and `/table` does: picking it does not insert a table, it types `/table ` and re-opens the same panel on the sizes, with a trail line saying where you are and backspace as the way back (it needs no back-navigation code — the text matches the command source again). Sizes are columns × body rows, the header row implied, because there is no GFM table without one. **Not "subtask":** it inserts a markdown checkbox and is named for one.
10. **Tables.** Keep `codemirror-markdown-tables` (the package) and its nested in-cell editing + paste-table normalization. **A cell renders markdown two different ways, and it has to.** A cell you have clicked into is a real nested `EditorView` and is given the inline half of this stack — `livePreview` under `inlineOnlyFacet`, plus the three facets it reads — so editing a cell behaves like editing anywhere else. A cell you have *not* clicked into is not an editor at all: the package renders it itself, as a `contenteditable` whose spans it classes from `highlightingFor(rootState, tags)`. A **HighlightStyle is therefore the only thing that reaches an unfocused cell**, which is why `markdownHighlightStyle` exists and why a cell can be *styled* (bold reads bold, code reads code, a link is coloured) but cannot properly *conceal*: concealing is a decoration and there are none there. What it does instead is hide the delimiters that a mark inherits a class from — `**`, `*` and `` ` `` — and keep a link's brackets, because markdown parses the inner pair of `[[…]]` as a shortcut link and hiding one pair of two reads as a broken link. **`inlineOnlyFacet` is mostly belt and braces**: the package already removes every block construct from a cell's grammar. What it genuinely covers is the alphabetic-list scan, which is a regex over lines rather than a parser rule, and the image widget, which markdown counts as inline and this editor draws as a picture.
11. **Rename.** Renaming a note moves the file and rewrites every referencing `[[link]]` in one pass. Reachable **from the file tree** and, via a vault skill, from the agent. **Rename is also move** — a new path with a different folder prefix relocates the note, creating destination folders as needed. **Dragging in the tree is the same operation by another gesture**: a drop runs the batch move (`moveNotesAtom`), so the link rewrite, the tab retarget and the commit pair are shared with rename rather than reimplemented. The drop is refused where the move would be a no-op or a folder into its own descendant, which is the one thing rename-to-path cannot get wrong by construction.
    - **Rename must reject a destination that already exists**, checking *before* moving anything. Renaming a folder onto an existing one silently merges them otherwise, and a contained-file collision surfaces halfway through, leaving a half-moved folder.
12. **Backrefs & delete.** Before deleting a note, surface referencing notes and tasks. The delete confirm names each linking file and its occurrence count. **No cascade**: dangling refs survive on purpose and render as tombstones (`[deleted note]`) wherever they appear.
13. **File tree & folders.** Driven by the **filesystem** — the tree is a directory walk plus a watcher. Create/rename/move/delete through ordinary file operations.
    - **Folders are real directories.** They exist because a file is in them, and git does not track empty ones, so an empty folder is a transient local state rather than a row that outlives its contents. The old "vestigial empty folder" problem and its display-level workaround both disappear: there is no row to orphan.
    - **The tree is live** via the filesystem watcher, so a note created by your agent, by a pull, or in another window appears without a refetch.
    - **Files drop in from outside.** Dragging from Finder onto a folder copies the files in; onto a file, into the folder it lives in; onto empty space, into the vault root. It is guarded on the drag carrying `Files`, so it never competes with the tree's own drag — an in-vault move carries no files, and without the guard both would claim every drop. **Bytes, not text:** this is the door images and PDFs come through, and `copyNotes` reads utf8 because everything *it* moves is already vault content. **A colliding name is refused, per file rather than per drop** — the source name comes from whatever folder the file was in, so a clash is the common case, and a six-file drop with one clash lands five. The refusal is `COPYFILE_EXCL` rather than a check followed by a write, so nothing can land in the gap between them, and the skipped names are shown until dismissed: a file that silently did not arrive is the worst outcome an import has. **A source that is not on the machine is refused by name.** Dragging from a Google Drive or iCloud mirror that holds a placeholder rather than the bytes answers `ETIMEDOUT` — a local copy cannot time out, so the errno is the giveaway that the filesystem went to fetch it and gave up. Holi does not wait for the download: it says the file is not downloaded yet, which is something the person can fix in Finder, where the copy cannot. **A drop on a row and a drop on empty space take different routes to the same place.** headless-tree calls `stopPropagation()` before deciding anything, so the container never sees a drop that landed on a row; a row is served through the library's foreign-drag hooks (`canDropForeignDragObject` / `onDropForeignDragObject`) instead, and both routes call one function. This is not a detail: left unconfigured, those hooks default to refusing every foreign drop, and the library refuses by returning *without* `preventDefault()` — which makes an unclaimed file drop a navigation, and Electron answers a navigation by opening a window. The tree accepted the drag on hover and opened the file in a blank window on release.
    - **A row's drag is a native drag, and that is how the in-tree move works.** A web drag never tells the operating system a file is involved, so a row hands the gesture to `startDrag`, which **replaces** the web drag rather than joining it. Dropped back on the window it arrives as an ordinary file drop, and a source inside this vault is treated as a **move** — through the move path, so links are rewritten and open tabs follow, rather than a copy that would leave a duplicate and a pile of links pointing at the original. A drop on a *row* is served by headless-tree's foreign-drag hooks rather than the container's handler; see the bullet above for why that distinction is load-bearing. **Folders keep the web drag**: there is no single file to hand over, and their move already worked. A folder dragged in *from* Finder is refused with a sentence rather than an errno — recursing into one is a feature, saying so is the minimum.
    - **Dropping a row into Finder does not work**, and the way out of the vault is **Copy to Folder…** / **Move to Folder…** in the row menu. Both act on a whole selection and on folders, and both **auto-rename** rather than overwriting what is already at the destination: the refuse-rather-than-overwrite rule protects the *vault*, and the destination here is the user's own disk, where a second copy is the useful answer and a silent replacement is the one thing git could not undo. A **move** shows the same dangling-links warning a delete does — to the vault it *is* a delete — and it removes only the files whose copy actually landed, because a file that could not be written is still the only copy there is. The destination is chosen before the warning, so cancelling leaves nothing behind.
    - **Any row may be given an emoji as its icon**, in place of the type glyph. Icons live in **`.holi/settings/icons.yaml`** — a map from vault-relative path to a single emoji — and that map is the only place they live. Set one with **"Edit Icon…"** in the row menu, which works the same on a note, a folder and a PDF; an empty field clears the entry rather than writing an empty one. Layering is the theme's (D64): `.holi/settings/icons.yaml` is committed and shared with everyone who clones the vault, and a gitignored `.holi/settings/icons.local.yaml` overrides it **per key**, so a one-line personal file changes one entry and inherits the rest. Keys are normalized like every other vault path (`Clients/` and `Clients` are one folder) and a key reaching outside the vault is dropped rather than resolved; the file is written back with keys **sorted**, so committing an icon does not churn the diff with the order things happened to be iconed in. The value must be **exactly one emoji**, and anything else is ignored rather than truncated, since it lands in a fixed-size row. **Both variation-selector spellings are accepted**, because emoji split in two and `RGI_Emoji` holds only one form of each: a character that is emoji-presentation by default (⭐, ✅) is in the set bare and *not* with a selector, while one that is text-presentation by default (❤️, ▶️) is in the set only *with* it — and the macOS picker emits the selector for both. Testing the literal value alone therefore refused what the palette produced, so the value is also tried with its selectors stripped; that cannot loosen anything, since what remains still has to match RGI on its own. A lone **pictograph written without its selector** (`❤`, `⚙`) is accepted too, on the same reasoning — `Extended_Pictographic` holds no letter, digit or punctuation, so an arrow, a circled digit and a CJK character all stay refused. The emoji is stored exactly as written and never re-normalized. A note's **tab pill** reads the same map, so a file that has an icon wears it in the tree and in the strip alike; the singleton tabs (board, agenda, mail) are not files and keep their own glyph.
    - **A note's own frontmatter is deliberately NOT a second source.** `icon: 🎯` in the note was built first and dropped, and the reason is worth keeping: it travels with the file, which is genuinely better for a note — an agent's `mv` cannot detach it — but it can only serve things that *have* frontmatter. Not a folder. Not a PDF or an image. Not `CLAUDE.md`/`AGENTS.md`, which are read verbatim as the agent's instructions, so frontmatter there becomes prompt text. Not local-only markdown like `USER.local.md`, which the scan files under `files` rather than `docs`, where no `DocMeta` exists to carry a field. A map was needed for all of those anyway, and two mechanisms with a precedence rule between them cost more to explain than the travelling property was worth. **The name is not the carrier either**: a leading emoji in the *filename* was the first reading of the request and the cheapest build — pure projection, folders included — but it puts the emoji in the path, and then a wiki-link can only be written by someone who remembers which icon a note wears.
    - **A path-keyed map can rot**, and that cost is accepted rather than answered: a file moved by an agent or a terminal leaves its entry behind. It degrades to *no icon*, never to lost content, and refusing to let anyone icon a folder to avoid a cosmetic staleness is the worse trade.
    - **Task files are hidden by default, behind a per-vault toggle.** They are ordinary markdown and would otherwise appear in the tree, which is honest and also noisy — the board owns them. So the tree offers "show task files" (off unless a vault opts in, alongside the show-hidden toggle), and when it is on a task leaf carries a **status glyph** and a done task's name is struck through. Both readings were defensible, so neither is imposed; this closes the question [`tasks.md`](tasks.md) shares.
14. **Note creation.** Create a file at a path (validated via `packages/shared/path-safety`), open it in the editor.
    - **The name input opens where the file will land** — as a child of the folder the command was invoked on, at the indent its contents will have. It used to open at the top of the tree whatever you had clicked, while the file was still created inside the folder you picked, so the tree disagreed with what the command was about to do. The toolbar's **New File** adds to the vault root and therefore still opens at the top, which is why the old behaviour looked right for as long as it did. A target whose row is not on screen (a collapsed ancestor, a filter) falls back to the top rather than opening an input nobody can see.
15. **Panes & tabs.** The shell holds more than one open doc at a time, VS Code's preview-vs-pinned model — see §Panes & tabs.
16. **Frontmatter reveal control.** Frontmatter is hidden by default (FR-2) with an explicit control to edit it — see §Panes & tabs.

---

## External writes

The file under the editor can change for three reasons: **the agent wrote it**, **a pull landed it**, or **another window/editor touched it**. All three are the same event, and the editor treats them identically.

- **The editor's own save needs no attribution.** `base` is the text the editor last loaded *or saved*, and a save advances it before the watcher can report the write — so by the time the change comes back around, `disk === base` and the decision is "nothing happened here" (`lib/editor-reload.ts`). Nothing has to ask *was that me?*, which matters because the snapshot push carries no path and could not answer that question anyway. The three alternatives all race: **path + mtime bookkeeping** cannot separate two writes inside one mtime tick, and a coalesced watcher event covers both; **pausing the watcher across the write** treats a slow filesystem's late event as foreign. **Content comparison holds no timing assumption at all**, which is the whole reason it wins.
- **Clean buffer → reload.** No unsaved edits, so there is nothing to lose. This is the overwhelmingly common case, because autosave fires on idle.
- **Holi's own commit-time tidy is not an external write.** A commit transform runs in the pre-commit hook, so it rewrites the file *after* the save that triggered it — the one write the `base` invariant above cannot see coming, because `base` was advanced before the hook ever ran. Left unrecognised it reads as a foreign edit, and since it lands on whatever line was just typed, as an **unmergeable** one: typing `icon: ` in frontmatter and pausing long enough to open the emoji picker was enough to raise a conflict nobody else caused, because `normalize-md` stripped the trailing space between the save and the watcher event. So `decideReload` compares `disk` against what **normalization** would make of `base`, and on a match treats it as its own write: `base` catches up to disk and **the buffer is deliberately left alone**, so the keystrokes that arrived while the hook ran survive. The pending save writes them and the next commit re-applies the tidy. This is safe **only because normalization is idempotent and re-derivable** — nothing is lost by preferring the buffer, since the rule simply runs again. It is therefore scoped to normalization alone: `relink` rewrites carry real content (a link target that moved because a file was renamed), so they still go through the merge, and treating one as ours would silently undo the rename. `normalizeText` lives in `packages/shared` for exactly this reason — the hook applies the rule and the editor has to recognise it, so neither may own it.
- **Dirty buffer → 3-way merge.** `base` is the text last loaded or saved, `mine` is the buffer, `theirs` is what is now on disk. This is `merge3` (`packages/shared/src/merge3.ts`), called from `lib/editor-reload.ts`, and it was **written rather than salvaged**: the old `agent-merge` module was not a reusable merger — it forked a shadow `Y.Doc` from the base, replayed a diff onto it, and let Yjs reconcile positionally, so the merge *was* the CRDT. What survived it is the 2-way diff (`fast-diff` with semantic cleanup, which coalesces fragmented ops so a rewrite stays contiguous) and the shape of the idea. The load-bearing property is that `merge3` **reports an overlap rather than resolving it**: that report is what routes the case to reconcile, so a merger that silently picked a side would delete the feature.
- **Unmergeable overlap → reconcile.** Both sides changed the same region. The editor stops autosaving that file and surfaces the vault's reconcile affordance — the same banner and the same **Ask Claude to reconcile** path a git conflict uses. One conflict story, whatever produced it. **The banner offers both ways out** (`composites/ConflictBanner`): *Keep mine* writes the buffer over the file, *Use the file on disk* drops the buffer and takes what is there, and *Dismiss* resolves nothing — naming the problem and offering no gesture for either version is what it used to do, and it left the user stuck. Neither choice is styled as the default, because both destroy something. The two resolvers are **closures the editor hands up with the conflict**, not a path: only the editor still holds both texts that disagreed, since the buffer lives in its `EditorView` and the buffer registry is anonymous. Its colours come from `destructive` rather than a fixed palette, so a vault theme reaches it like every other surface (D64).

**Why this is not the old bridge.** The bridge existed to translate a file diff into *positioned CRDT operations* against a live multiplayer document, with a soft lock and a frozen base per agent turn. None of that survives: there is one writer target (the file), no remote co-author whose concurrent edits could be reverted by a blind write, and no turn protocol. What is left is the plain 3-way merge that sat at the bridge's center — roughly a tenth of the machinery, and the only tenth that was ever load-bearing here.

**Staleness is still Claude Code's job.** `Edit`/`Write` require a prior `Read` and fail if the file changed since — so the agent's own writes are guarded by CC natively, exactly as before.

---

## Panes & tabs

**Status: built.** The shell is a tab strip over a pane, and a tab is a discriminated union — `state/panes.ts` is the owner. This section described itself as unbuilt for three weeks after it shipped, including the "forward constraint" below, which the implementation honoured on its first commit.

The section still matters because two other PRDs depend on it by name: [`vault-apps.md`](vault-apps.md) §Tabs needs non-note tab kinds, and [`../architecture.md`](../architecture.md) states the constraint.

### A lone note centres

**The column is anchored left, except when a note is alone in the window** ([`#13`](https://github.com/syv-ai/holi/issues/13), 2026-09-24). Left is the rule because a centred column moves whenever its pane changes width, so a panel appearing beside the text would slide the words under the caret; `editor/theme.ts` has the history. Alone is `isSoloNote` in `state/panes.ts`: one pane, and the tab it shows a markdown file, so a note or a task file (D96), preview or pinned. Only a split ends it. Other tabs in the pane do not, of any kind, since they sit behind the one showing and take no width from it; nor do the explorer and the sidebars, whose width only changes because the user dragged it, and the column stays centred through that drag with no easing. The frontmatter widget moves with the column and is middle-aligned in it in every layout, centred or not. It takes one width open or closed (`min(24rem, …)`), so opening it never makes it wider; the collapsed summary centres in that width and the fields fill it. The measure stays 48rem; only the position changes.

**The change is instant**, on purpose. It happens only on a split or an unsplit, a layout event big enough to carry it, and a slide would have to move the text inside CodeMirror, where only paint may move: it was built once, and took hidden caret layers, a forced redraw and a position tracker to keep CodeMirror's picture of the text honest, which is the wrong side of that trade. A split changes the editor's width, and that alone makes CodeMirror re-measure and redraw the caret where the text now is.

### Tabs — preview vs pinned

VS Code's two-state model, ported:
- **Preview tab** (italic title): a single-click in the file tree opens the doc **in the existing preview tab, replacing it**. Browsing a vault costs one tab, not twenty.
- **Pinned tab**: a **double-click** in the tree, a **double-click on the tab**, or **editing the doc** promotes the preview tab to pinned. Editing promoting a tab is the rule that matters — you can never lose your place by clicking away from something you were typing in. `pinActive` is that rule, fired once per edit rather than once per keystroke.
- Tabs are closeable; the strip lives in the header bar.

**A tab is not a note — and this is what that bought.** The union is `{ kind: 'note'; path; preview? } | { kind: 'board' } | { kind: 'agenda' } | { kind: 'mail' }`. Mail and the agenda arrived (D67) as *new kinds*, not as a rewrite — which is the entire return on modelling this as a union rather than the `Map<path, …>` that would have foreclosed it.

**The non-note surfaces are singletons**, and they behave differently from notes on purpose: there is only ever one board, one agenda, one mailbox, so each **opens leftmost** rather than landing wherever it was invoked. If it is already open it is focused **in place** — moving it would shuffle the strip under a user who clicked the same button twice. They are pinned by construction, having no preview state to be in, and they are account-wide rather than vault-scoped.

Leftmost is where a singleton *opens*, not where it lives: since tabs became draggable it can be moved anywhere in the strip, and re-clicking its nav chip focuses it where it now sits rather than yanking it back. An undraggable tab in a strip of draggable ones would read as a bug, and the alternative was a rule discoverable only by the gesture failing.

**Two rules that read as tidiness and are not:**
- **One buffer per file, across every pane.** Opening a note that is already open *focuses* it instead of appending — and since 2026-08-20 that lookup spans the whole workspace, not just the active pane (`findTab`). Two tabs over one path means two buffers each with their own `base` and their own autosave debounce, each seeing the other's write as an external change to reconcile; that is a data-loss-shaped bug and it does not care which pane the second buffer is in. It is also why a split cannot duplicate the tab it was invoked on — and why a **drag can move that tab anywhere**: a move is safe exactly where a copy is not, because remove-then-insert leaves one buffer where there was one buffer.
- **The active tab follows the document, not the index.** Closing a tab left of the active one shifts every later index, so keeping the number would silently move the user to a different file. In a UI that autosaves, that is a data-loss-shaped bug.

**A rename retargets open tabs** rather than closing them (`retargetTab`/`retargetTabs`), and deleting a file closes its tab — so the strip cannot hold a path that no longer exists.

**Not persisted.** Whether tabs survive a restart is still open; `.holi/settings/app.local.yaml` is where the answer would go. Deliberately unanswered rather than guessed at.

**What fills the first pane is answered** (D85). A vault's `landing` key says what it opens on: today's daily (the default), a note, a vault app, or the board, agenda or mail. It resolves against the snapshot first, so a target naming a note that has been deleted, or an app a collaborator removed, degrades to the daily rather than to an error. The two questions stay separate on purpose: `landing` is what a vault opens on **every** time, and persistence would be about what *you* left open last time.

**What fills the first pane is answered** (D85). A vault's `landing` key says what it opens on: today's daily (the default), a note, a vault app, or the board, agenda or mail. It resolves against the snapshot first, so a target naming a note that has been deleted, or an app a collaborator removed, degrades to the daily rather than to an error. The two questions stay separate on purpose: `landing` is what a vault opens on **every** time, and persistence would be about what *you* left open last time.

### Split panes

**Status: built.** `Shell.tsx` renders every element of `panes[]` in a nested resizable group;
`components/PaneView.tsx` is one pane, and each draws **its own strip** over its own tabs. The array
shape was paid for on the first commit precisely so this would be an addition rather than a rewrite,
and it was.

**⌘\ opens an empty pane, not a copy of the current tab.** VS Code and Obsidian both copy. They can:
their editors tolerate two views of one buffer, and Holi's does not — see the one-buffer rule below,
which a second pane turned from a per-pane rule into a hole. So a split makes room and the next
thing you open fills it, and the gesture people actually reach for is **Open in a New Pane**, on a
file-tree row and on an app row.

**Closing the last tab of a split takes the pane with it.** That is how you unsplit; anything else
leaves a permanent empty column that only a second, separate gesture could remove. **The last pane
never goes** — an empty pane is the empty-editor state, and a workspace with no panes has nothing to
render into. A pane holding ten tabs closes in one gesture, from a control in its own strip.

**⌘W closes the focused pane's active tab**, through the same rules: a split it empties goes with
it, a single pane stays open and empty, and with nothing open the key does nothing. The window closes
on ⌘⇧W (VS Code's convention) or its traffic light, never on ⌘W. The key is the application menu's
*File → Close Tab* accelerator rather than a renderer keydown, because a menu accelerator fires
before the page sees the key; main sends the command id, and the `tab.close` row of the command table
([`command-palette.md`](command-palette.md)) decides which tab it means. Closing a session tab does
not end the session (D101).

**The focused pane is the one "open" means**, and it follows both the pointer and the keyboard
(`onPointerDownCapture` + `onFocusCapture`, so putting a caret in an editor moves it too). The
unfocused pane's active pill keeps its shape and loses its weight, which is the whole of the cue.

**The pane group's layout is deliberately not persisted.** A stored layout is an array of weights
keyed to a panel count, and a pane is the thing that comes and goes; restoring a two-pane split into
a three-pane group is worse than starting even. The vault's other groups (the shell row, the
sidebar's vertical split) still persist, because their panel count is fixed.

### Moving a tab

**Status: built** (2026-08-20). A tab is dragged: reordered inside its own strip, moved onto another
pane, or dropped on a pane's left or right quarter to **split**. Native HTML5 drag, the way
`features/tasks/BoardView.tsx` already does it — the dragged tab's identity rides `dataTransfer`, so
there is no companion state to keep in sync and nothing to go stale if a `dragend` is missed.

**The payload is identity, never location.** `findTab` already spans the workspace, so one function
(`moveTab`) serves a reorder *and* a cross-pane move, and a strip never learns where a dropped tab
came from. A pair of indices would have gone stale between the `dragstart` and the `drop`.

Almost every rule it obeys was already written down. It is a **move, not a copy**, so one buffer per
file survives by construction. The **active tab follows the document** in both panes. An **emptied
source pane goes** unless it is the last one — dragging your last tab away is how you unsplit.

Three rules are its own:

- **A reorder rearranges; it does not navigate.** Within one pane the active tab stays on whatever
  document it was on, so tidying a full strip while reading one file cannot drop you into whichever
  tab you happened to drag. A cross-pane move is different in kind: the destination shows what you
  dropped into it and the workspace focuses that pane, because that is where you are now looking.
- **A drag pins a preview tab.** Dragging is intent, the way editing is. Without it the gesture eats
  itself — place a preview tab deliberately, single-click anything in the tree, and `openPreview`
  replaces it *in place*, destroying the tab you just positioned.
- **A pane never offers a drop that would do nothing** — and an **edge shared by two panes is one
  gap**, so that is a question about the whole workspace rather than about any one pane. A sole tab
  dragged out of its column has *three* inert edges around it: its own two, and the facing edge of
  the pane next door, which describes the very place it came from. `dropZones` works this out by
  asking `moveTab` and `moveTabToNewPane` whether they would change anything, so the highlight
  cannot promise what the move will not do.
- **The pane a drag came from never offers its middle**, even where a drop there would move
  something. "Into this pane" is a move to the end of its own strip, which the strip already
  expresses, and every split gesture crosses the body on the way to an edge — so a full-pane
  highlight would flash on all of them. Every *other* pane keeps all three zones.
- **A drop target is visible before it is aimed at — but not before the drag leaves the strip.**
  Both landing strips are drawn dim as soon as the pointer is off the tab strip, and light under
  the pointer. An edge that materialises when you reach it teaches nobody that a drag can split
  the view. Drawing them from the moment a tab is *picked up* was the original rule and it was
  amended on 2026-08-22: the commonest drag by far is a reorder, which never leaves the strip, and
  two bands flashing under every nudge is noise. Leaving the strip is the earliest moment a drag
  can be heading for a pane, so nothing is learned any later than before.

**A reorder is shown, not described.** Pick up a pill and the ones between its slot and the pointer
slide aside, opening the hole it would drop into; the pill you are holding dims to 40% — the reading
the tree already gives a cut row — and travels with them, so the strip is a live preview of the
order you would get. The caret line survives for exactly one case: a tab arriving from **another**
pane, which has no slot here to move out of and no width this strip could know. Gap for a reorder,
caret for an insert.

The offsets are `lib/tab-reorder.ts` — pure, on numbers, and the same `to` index that `dropIndex`
gives the drop, so the preview and the drop cannot disagree. Three things make it safe:

- **Transforms, never layout.** A `translateX` moves nothing else, so the strip is never wider
  mid-drag than at rest and no preview can push a pill out of the viewport.
- **Hit-testing reads resting positions** (`offsetLeft`, not `getBoundingClientRect`, which
  includes the transform). Otherwise the preview moves the midpoints that decided it, and the hole
  chases the pointer that opened it.
- **A drop takes the transform away together with its transition.** The pills' real positions
  become exactly what the preview was showing, so there is nothing left to animate — the move has
  already happened on screen. A drag that ends *without* a drop gets zeros instead, which keeps the
  transition and lets the pills glide home.

**Every other change of position glides too.** A tab closed, opened, or taken by another pane
animates from where it was to where it is now (FLIP: record, invert with a transform, animate to
zero). Layout is never animated, so the settle cannot change what a drop hit-tests against. It is
measured in the **viewport** frame — `offsetLeft - scrollLeft` — because closing a tab while the
strip is scrolled shrinks the content *and* the scroll with it: every remaining pill keeps its place
on screen while its `offsetLeft` moves by a whole tab width, and a settle measured in content
coordinates flings pills across a strip where nothing visibly happened. It runs only when the tab
list itself changed, which is what keeps a scroll from animating anything, and it sits out the
commit a drop lands on. Duration and easing are read from `--duration-micro` / `--ease-settle` at
the moment of use — a keyframe cannot carry a `var()`, and the motion tier is meant to be one
vocabulary rather than a number restated per surface.

**An off-screen drop position is still reachable.** The wheel is not available while a drag is in
flight, so "move this to position 9 of 12" would otherwise be inexpressible. Hovering a drag within
28px of either end auto-scrolls the strip that way — 12px every 16ms, about a second to cross a full
strip, and it stops the moment the pointer leaves the band or the drag ends.

**Where a drop lands is arithmetic**, in `lib/tab-drop.ts`, for the same reason `lib/tab-overflow.ts` is:
jsdom computes no layout, so logic that hit-tests inside a component cannot be tested at all. It
also owns the `DataTransfer` codec — a **custom MIME type**, because `getData` is unreadable during
`dragover` by spec and the type name is therefore the only question a target may ask mid-drag; and a
validator, because that string is a trust boundary.

**A sole tab dropped on its own pane's edge is a no-op** — and only then. Rebuilding an identical
column one position over is a flicker, not a move; that same tab on a *different* pane's edge is an
ordinary move that does collapse the pane it came from.

**Not built:** dragging a tab out to a new window, dragging between vaults, and any vertical split —
the pane model has one axis and this did not add another.

### The strip scrolls, and says what is off each edge

The strip was a bare flex row until 2026-08-20, and flex items do not shrink below their content —
so opening more tabs than fit between the sidebars grew the row, and the row grew the editor pane
past the window, indefinitely, with nothing on screen to say a tab had gone anywhere.

The first fix was a **window**: render only the pills that fit, hide the rest behind one `+N`
(`lib/tab-window.ts`). It clipped correctly and read wrongly. A single count cannot say *which way*
your tab went, no gesture scrolled the strip, and "the window slides for the active tab" is a rule
you have to know before the strip makes sense. It was replaced on 2026-08-22 and the module deleted.

**The strip is now a scroll container.** Every pill is laid out inside an `overflow-x-auto` viewport
(`min-w-0` is still load-bearing: without it the flex child refuses to shrink and grows the pane
instead of scrolling). A **vertical wheel scrolls it sideways**, because a mouse without a
horizontal wheel would otherwise have no gesture at all and there is nothing to scroll vertically in
a one-line row; a trackpad's horizontal delta is left to the browser. The scrollbar is hidden — the
strip is 44px tall and a permanent bar would eat a third of a pill.

**What is out of reach is counted per side.** `lib/tab-overflow.ts` — pure, tested on numbers, since
jsdom computes no layout — answers *which tabs are off which edge* at the current scroll position,
and each side draws its own control: a chevron pointing that way and a count. Clicking one opens a
menu of exactly that side's tabs, and picking one selects it **and** scrolls it into view (selecting
alone moves nothing when the tab you scrolled away from is already the active one). Three rules
worth stating:

1. **Partly visible counts as offscreen.** The count answers "is there more that way, and how
   much"; half a filename answers neither.
2. **An unmeasured strip announces nothing.** Before the first `ResizeObserver` callback the
   viewport is 0 and every pill would score as missing — a count that flashes on mount.
3. **The active tab is scrolled into view when it changes**, keyed on the tab's identity rather
   than its index, so a reorder does not yank the scroll back just as you dropped something
   somewhere else.

**The counts float over the strip's edges, and both are always mounted.** Two halves of one fix:
in the flex row, a count that emptied at the end of a scroll gave ~24px back to the viewport and
re-laid every pill out mid-gesture; and unmounting it made it blink out on a single frame. Out of
the layout it can shift nothing, and always mounted it can fade (160ms, `--ease-settle`) — showing
its **last non-empty number** while it goes, because a blank pill fading away reads as the same
glitch. While invisible it is `aria-hidden` and out of the tab order. A gradient in `--background`
sits under each one so a pill scrolling beneath stays legible instead of colliding with the number.

### Frontmatter reveal control

FR-2 hides frontmatter by default. Hiding it with no way back is not shippable, so it has an
explicit control, and the reveal-on-caret rule is **not** enough on its own — frontmatter is a
structured header, not prose, and a caret wandering into it is as likely to be an accident as an
intent.

**"By default" is per-file, not global** (`frontmatterStartsRevealed`). FR-2's reason is about
*notes*: there, frontmatter is metadata over prose someone came to read. Under `.claude/` and in a
`task.*.md` it is the opposite — a skill's `name` and `description` are what the agent matches on when it decides whether
to load the thing at all, an agent definition is little else, and the body is the elaboration.
Opening `.claude/skills/theme/SKILL.md` used to show `▸ 5051 chars · Last updated 20/08/26` and then
the prose: the half of the file you came to edit was behind a chevron, and the pill summarised the
*body*, so nothing on screen even said there was frontmatter to find. Those files now open revealed.
A **task** joins them for the same reason read the other way round: its `status` and `due` are not
metadata over the file, they are half of what the file is, and collapsing them behind
"0 chars · Last updated" hides the task. Nothing else moves — same widget, same chevron, and the
chevron still collapses a revealed file.

**A markdown file with NO frontmatter still gets the bar** (2026-09-09, [`#17`](https://github.com/syv-ai/holi/issues/17)). "N chars · Last updated DD/MM/YY, Name" is a fact about a markdown file, not a fact about having metadata, and it used to disappear when a file had none purely as a side effect of there being nothing to collapse: the summary was only ever built to label a collapsed block. The widget is now inserted **above the first line** rather than replacing a region — `Decoration.widget` with `side: -1`, so a caret at position 0 is in the body and not against the bar — and it carries no chevron, because there is no block to open. It offers no way to add one either: the pre-commit scaffold does that on the next commit, and two ways to write the same four lines is one too many. Nothing else changes: the char count already came from `doc.slice(bodyStart(doc))` and `bodyStart` is 0 with no block, so the number was correct before it had anywhere to appear. It reaches markdown only, and by construction rather than by a check — a non-markdown text file opens in the plain stack, which has no frontmatter extension in it.

**The summary line reads "1.8K chars · Last updated DD/MM/YY, name"** (2026-09-25). Counts from a thousand are in K (and M), one decimal rounded down so a note never claims more than it has. The name is the git author name and links to `github.com/<name>`, used as the GitHub username with no lookup; it sits beside the collapse button rather than in it, and opens through the editor's `openExternal` seam (`linkNavFacet`). The line never wraps: in a narrow pane the text truncates with an ellipsis and the name stays whole.

**Revealed, a file with a schema shows typed rows rather than YAML.** `frontmatterSchema` (in
`packages/shared`) says what a key *is* — a task's `status` is one of three words, its `due` is a
moment, its `tags` a list — and the block draws the matching control per row: a `Select`, the
`DateTimePicker`, a chip field. Every key the schema names is drawn whether the file carries it or
not, so a field can be set without knowing its name, and **nothing is written until a value is
given**. A key the schema has never heard of is still drawn, still editable, and written back
verbatim; `order` is the one key hidden, being a sort rank that means nothing to a human.

The rows are the widget's own DOM, like the table widget it is modelled on, with the value area left
empty and filled by the app's **single React root through a portal**
(`editor/frontmatter-portals.ts` plus `FrontmatterFieldsHost`). That is what lets a row use the real
primitives instead of a second date picker built inside the editor layer. Writes go back through
`editYamlMapping`, which preserves comments, key order and any nested structure this app does not
understand.

**Any key can be added** (2026-09-25). The last row is a quiet "add field" line that opens into a name input and a value input in the same two columns as the rows above, so the pair appears where it will then live. The value is free text; the schema's own keys are refused there because each already has its typed row, and so is a hidden key (`order`), which would otherwise be a back door to editing it. A name YAML would read as syntax (a colon, a leading `#`, `-`, `?` or quote) is refused where it is typed. A value is required: a bare key is a `null` in the file, which no row would draw as anything but an empty box.

**The rows carry no edges, and tint under the pointer** (2026-09-25). The app keeps a dimmed `--divider` edge on form fields; the frontmatter rows are the one deliberate exception, because they are the note's metadata on the note's page and a stack of outlined boxes made the top of every note a form. `FIELD_CONTROL` goes borderless only inside `[data-frontmatter-fields]`, so the create-task dialog, which shares the date picker and recurrence field, keeps its edges. What says a value can be pressed is a neutral background tint on the whole row (`motion-respond`, `bg-muted/40`); read-only rows do not tint, since nothing there can be pressed.

**Under the fields, read-only facts that are not in the file** (2026-09-25): *updated* and *created*, each a date and the git author (linked to their GitHub profile like the summary's name), *revisions*, *chars* and *links* (`N in · M out`). None of them is written into the file, because each has an authority a copy could only drift from: `created` is the file's **first commit**, following renames, and is no longer a frontmatter field (the scaffold stopped writing it; an older note's `created:` line is just an unknown key now). History comes from one `git log --follow` per file (`notes.fileHistory`); links from `notes.links`, where *in* is the number of files linking here, the same full scan the delete preview uses, and *out* the distinct targets the file on disk links to. Both are asked for when the block opens, never for a collapsed one, and the rows are drawn empty from the first frame so the block does not grow when the answer lands. *chars* is the buffer's count at the moment the block opened. They show with the typed rows only; the raw-YAML fallback has none.

**The nested plain-YAML editor is the fallback, not a separate feature.** A file with **no schema**
gets it — `.claude/` and the agent surface carry a contract of their own, and this app drawing rows
for it would be inventing their shape — and so does any file whose frontmatter **will not parse as a
mapping**, because a document with no rows to draw has exactly one honest surface and it is the text.

**What it is: one in-editor widget with three states** (`editor/frontmatter.ts`), plus that fourth bare one. The region is
*always* replaced by an atomic block decoration — collapsed, it is a **pill** carrying a summary and
a validity dot; revealed, it is either the typed rows above or a **nested `EditorView`** — no markdown stack, no live preview, no formatting
keymap, but the **YAML grammar and the same highlighting a `.yaml` file opens with**. Plain does not
mean colourless: this is the only editor in the app whose language is settled before the document is
read, and a key that looks like its value is what made a task's whole record read as one grey block. Both the pill
and a header chevron dispatch the same `toggleFrontmatter` effect. The nested editor's writes are
dispatched back to the root over the region's range under a marker annotation, so the widget does
not rebuild — and lose its caret — on its own write. Because the write-back reconstructs the `---`
fences every time, breaking the YAML never dissolves the block: it turns the dot red and, via
`frontmatterValid`, holds off the save.

**Why a separate editor rather than just un-hiding the range:** frontmatter is YAML, and the note
editor is a markdown editor — the live-preview decorations, slash menu, wiki-link chips and
formatting hotkeys are all wrong inside it, and an errant `⌘B` writing `**bold**` into a YAML key
produces a file the task and daily-note parsers reject. **This matters more than it looks:** a task
*is* its frontmatter, and the task detail view and this editor are two surfaces onto the same bytes.

**The cost that was predicted and then avoided.** This section long carried an implementation note
saying the real work was a seam: the `EditorView` is trapped inside `EditorPane`'s effect closure and
never lifted to a ref or atom, so nothing outside the pane can command the editor, and a header
button toggling a decoration would need that lift first. **The widget owning its own nested view
made the seam unnecessary** — the toggle is a `StateEffect` dispatched from inside the editor, so
nothing outside it ever has to reach in. The model is the table widget
(`codemirror-markdown-tables`), which had solved this shape already.

### Vault dropdown

The vault `<select>` was a native element, which cannot hold an action row —
`features/vault/VaultPicker.tsx` replaced it with a Radix dropdown: a trigger naming the current
vault, the vaults, and **"Add vault…"** pinned to the bottom. **The action belongs *in* the list
rather than as a `+` beside it**, because switching and adding are one gesture: open the list, pick
where to go. Radix supplies open/close, outside-click, Escape and focus management.

**It does not carry the sync state, and the settings gear is still its own control.** Folding all
three of the header's controls into the dropdown was the original design; what shipped folded one.
The gear sits beside the board and today chips, and the sync state sits **bottom-left in the window
footer**, where it doubles as the entry to the whole-vault commit history — a better home than the
dropdown, because "where am I, and is my work elsewhere" is one glance and the footer is also where a
conflict's quiet reconcile affordance belongs.

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
- **Save:** idle debounce or ⌘S writes the buffer and advances the base — **in that order**, which is what stops the watcher treating the editor's own save as an external change and reloading on top of it. The echo loop that ordering forecloses produces a caret jump per keystroke pause.
- **Undo:** plain CodeMirror `history`. The `Y.UndoManager` — which existed so undo unwound *your* edits and not a co-author's — is gone with the co-author. **A foreign reload is not an undo step**, and that property is what the `UndoManager` used to provide: a reload is dispatched with `addToHistory:false`, via a minimal prefix/suffix diff that preserves the caret, so ⌘Z unwinds your keystrokes rather than backing out someone else's text. The tentative earlier answer — apply the reload as one undoable transaction — was rejected for contradicting exactly that. Design: [`../specs/2026-08-03-undo-external-reload-design.md`](../specs/2026-08-03-undo-external-reload-design.md).
- **Teardown:** flush a dirty buffer on close, tab switch, vault switch, and app quit. An unflushed buffer is the one way this design can lose data that the CRDT design could not.

---

## Ask Claude about a selection

Select a passage, press one button, and the session you pick has it already, knowing which note and which lines you meant ([`#5`](https://github.com/syv-ai/holi/issues/5), 2026-09-09). The prompt reads `[From projects/roadmap.md, lines 12-18]` followed by the passage quoted with `> `, and a single-line selection says `line 12` rather than `lines 12-12`.

**The line numbers are exact, and that is the point.** The affordance is adopted from ailex's `handleChatAboutSelection`, which recovers them by searching the markdown source for the selected substring — approximate by construction, and wrong outright when the passage appears twice. CodeMirror already holds the range, so the prompt quotes a location rather than guessing at one.

**A CodeMirror tooltip over the selection**, provided by a `StateField` through `showTooltip`, recomputed on a selection or document change and on nothing else. The button takes `mousedown` with `preventDefault` rather than `click`: the tooltip is outside the content, so a plain click moves focus and collapses the very selection it is about to send.

**Which stacks get it, and why the others must not.** The seam is `askAgent` on `EditorDeps`, so only `baseEditorExtensions` can have it — the mail composer is a separate stack precisely because it knows nothing about a vault, and a seeded vault prompt is exactly the kind of thing it must not grow; `plainTextExtensions` takes a path and a read-only flag, and a `.json` is not a note. A task's description **does** get it, being prose in the notes stack. **A locked file shows no button**: a reconcile is resolving it ([`vaults-sync.md`](vaults-sync.md) FR-19), and handing that to a second conversation mid-merge is the one case this must not offer.

**No new transport.** `sendToAgent` is the whole wire, and every other ask in the app goes down it ([`agent.md`](agent.md) §Several sessions per vault). What the popover adds on top of it is the **target row**: live sessions, then New session, defaulting to the session you are on. It is the second thing in a popover that was deliberately one field, and it earns that because an ask now goes to one of several conversations and the alternative is finding out where it went afterwards. A send that is refused — the session ended while the popover was open — keeps the text and says why.

## Images and other binaries

**The vault is text-first *by authorship*, not by content** (D62). Any file lives in a vault as an ordinary committed file; what makes the vault text-first is that markdown is the thing you *write*, and a PDF is something it **emits** ([`pdf-export.md`](pdf-export.md)) rather than something it imports. That resolved a real contradiction: an earlier design had incoming PDFs converted to markdown on entry with the original archived to object storage, which is machinery serving a direction the work does not flow in — at Syv, rich documents are produced by the vault, not imported into it.

- **Images render inline in the editor**, as a live-preview decoration like every other rendered element.
- **A ```mermaid fence draws as a diagram**, and shows its source when the caret is in it ([`#6`](https://github.com/syv-ai/holi/issues/6), 2026-09-09). It is a **`StateField`, not a case in the live-preview builder** — CodeMirror refuses block decorations from a `ViewPlugin` and refuses them by aborting `EditorView` construction, so a note with a diagram would have opened blank rather than opened wrong. `frontmatter.ts` learned that first and the table widget already provides its blocks the same way; this is the third instance of one rule. Nothing about the reveal rule is reimplemented: a fence holds no inline elements, so "the selection is on this element" is exactly D91's `touches`. Mermaid itself is **dynamically imported once** on first use, because it pulls d3 and a parser per diagram type and a vault that draws none should not pay for it; the widget's `eq` compares the fence source **and nothing else**, since live preview rebuilds on every arrow key and a looser one would re-run mermaid on each. **A broken diagram is not an error state**: `toDOM` puts the source up immediately and only replaces it when a render resolves, so an invalid diagram is the source you are still writing, the way a broken image is its alt text. It is also the **third block widget to need the column inset by hand** (`--editor-inset`), having arrived flush against the page edge exactly as the frontmatter widget and the table did. **The palette comes from the app's own mode**, read off the `data-theme` stamp (D85) the way the mail frame reads it, and mermaid is re-initialized when that has changed since the last render — otherwise a vault in light mode draws black-on-black. What it does not do is repaint the diagrams already on screen: their DOM is reused, which is what `eq` is for, and nothing recomputes a decoration on a theme flip, so they come right when the fence is next edited or the note reopened. Closing that properly means a `StateEffect` on the theme, which the case has not yet earned. **The PDF does not draw it** — see [`not-built.md`](../not-built.md) §PDF export.
- **A standalone image viewer** opens an image as its own tab, and **a PDF opens in a tab too** (D103, 2026-09-21): embedpdf's ready-made viewer over its own PDFium wasm, offline, themed through the vault's tokens, with search, selection and highlights that are saved into the file itself. The viewer is [`pdf-export.md`](pdf-export.md) §Viewing a PDF's, because its subjects are that document's outputs. Other binaries (`.docx`) still get a typed placeholder naming what they are, because a file the tree shows and the editor cannot open is a dead end.
- **The viewer paints the image on a checkerboard plate**, not on the app background. An alpha channel is otherwise invisible: a black-ink logo on transparency, painted onto a near-black dark-first surface, is a pane showing a filename with nothing above it — and every visible symptom of that says "the image did not open". The plate is light in **both** themes on purpose (it is paper, not chrome; a dark plate would hide exactly the dark ink it exists to reveal), and it is applied to the `<img>` itself, so it covers precisely the image's own footprint and an opaque photo hides it completely.
- **Non-markdown files stay out of the link graph.** They are not in `docs`, so the link-aware operations — rename, backrefs, move — remain markdown-only. An image is an asset referenced by path, not a wiki-linkable note.
- **Assets are committed straight to git.** Vault-size management via blob storage or reference files (Git LFS, or a reference that renders a blob from object storage) is the deferred answer to "where binaries live at scale", revisited when vault bloat is a **measured** problem rather than an anticipated one. There is no object storage, so it is a decision as much as a build.

**Rejected.** *Rendering every binary in place and retiring text-first* — makes the agent blind, since a PDF it cannot read is a document it cannot help with, and puts binary bloat in git with no authoring story. *Converting incoming PDFs/`.docx` to markdown and archiving the original* — an import pipeline and an object-storage dependency for a flow that runs the other way, and it archives away originals users may need intact. *Two co-equal representations of one document* — raises "which is truth" on every edit and every sync; markdown-as-source with PDF-as-output keeps one.

## Wiki-links & rename

### Grammar (one module, `packages/shared`)
`packages/shared/src/wiki-links.ts`, ported from the old `vaultRefs.ts`, is the **single source of truth** for the `[[…]]` grammar: `wikiLinkRegex()` (fresh `RegExp` per call), `parseWikiLinks(text): WikiLinkMatch[]` → `{ raw, target, start, end }`. Framework-free, importable anywhere. **Do not port** the `html-widget` fence grammar.

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
- **Sync status.** One indicator per vault (up to date / pulling / offline — N waiting / no write access / conflict / reconciling / paused). Never a conflict dialog — a conflict is a banner and an offer of help, not a modal demanding a choice.

---

## Edge cases & risks
- **The watcher echoing the editor's own save** — named here as the most likely bug in this PRD, and closed by the base-advance-before-write ordering in [External writes](#external-writes) rather than by attributing writes.
- **Selection spanning multiple lines.** Define the reveal set as every line the selection touches; re-render on collapse.
- **A pull landing on the open note while you type.** The 3-way merge case, and the one worth writing a test against first: it is rare enough to go unnoticed and expensive enough to matter.
- **Rename touching a note you have open.** The file moves under an open editor; the tab must follow the file rather than showing a phantom of a path that no longer exists.
- **Missing-link chips.** "Exists" is now a real filesystem check — simpler and more honest than the old server-metadata check, which could report a doc as existing before its working copy materialized.
- **Table widget.** The nested in-cell editors mutate the same buffer; verify they compose with the autosave debounce.
- **Frontmatter hiding** ports unchanged, and now matters for tasks too, whose frontmatter *is* the record.
- **Formatting-hotkey conflicts.** Ensure ⌘B/⌘I/⌘K don't collide with app-level shortcuts; scope to editor focus. **⌘S is now taken** by the editor and must not also trigger a global action.

---

## Dependencies
- **[`../architecture.md`](../architecture.md)** — the sync engine: autosave commits, auto-push, auto-pull, and the reconcile path this PRD hands unmergeable overlaps to.
- **[`agent.md`](agent.md)** — the agent writes notes with native tools; its writes arrive here as ordinary external writes.
- **[`tasks.md`](tasks.md)** — task files are markdown in the same tree; task chips read their frontmatter.

