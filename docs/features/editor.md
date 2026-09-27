# Editor

Every note is a `.md` file, edited in CodeMirror 6 with live preview: markdown renders inline, and the element under the caret shows its raw source. The editor writes the file directly, autosaves, and survives the file changing underneath it.

## How it works

**Three stacks.** `baseEditorExtensions` is the notes editor. `mailComposerExtensions` is the same markdown editing with every vault layer removed. `plainTextExtensions` opens other text files with highlighting and validity checks, no markdown layers.

**Live preview.** A `ViewPlugin` decorates the visible ranges and rebuilds on doc, selection or viewport change. The **element** the selection touches renders raw; the rest of its line stays rendered. Touching an edge counts, and when elements nest only the innermost opens. A heading's `#` and a list marker reveal with their whole line. The swap is instant, except a heading's `#`, which slides (`heading-slide.ts`).

**Keys and links.** ⌘B, ⌘I, ⌘E, ⌘⇧X and ⌘K wrap or unwrap the selection or word. A wiki-link chip opens on click; a markdown link needs ⌘-click, since a plain click means "edit this text".

**Tables** (`codemirror-markdown-tables`). A focused cell is a nested editor given inline live preview under `inlineOnlyFacet`. An unfocused cell is rendered by the package from the root highlighter, so a `HighlightStyle` is the only thing that styles it: it can hide `**`, `*` and `` ` ``, and keeps a link's brackets.

**Images and binaries.** Any file may live in a vault; markdown is what you write. `![](path)` (note-relative) and `[[img.png]]` (vault-relative) render inline via `holi-vault://`. An image opens in its own tab on a light checkerboard plate, a PDF in the viewer ([pdf.md](pdf.md)), other known binaries in a typed placeholder. Binaries stay out of the link graph.

**Mermaid.** A mermaid fence draws as a diagram and shows source when touched. Mermaid loads on first use, a broken diagram shows its source, and the palette follows light/dark at render time.

**Completion.** Every popup in the app comes from `holiCompletion`. `@` lists notes, then open tasks, and inserts a `[[path]]`. `/todo` inserts a checkbox; `/table` reopens on sizes (columns by body rows).

**Ask the agent.** A selection shows a button that opens a field and a session picker. The message is your instruction, then `[From <path>, lines 12-18]` and the passage quoted with `> `; line numbers come from CodeMirror's range, so they are exact.

**Saving.** Written after 600 ms of quiet and on blur, flushed on tab close, vault switch and quit. ⌘S saves every buffer, commits and pushes. Invalid frontmatter YAML holds the save; a flush writes anyway.

**External writes.** `base` is the text last loaded or saved. `decideReload`: disk equal to base is nothing; a clean buffer reloads; a dirty one takes `merge3`; an overlap raises the conflict banner (Keep mine, Use the file on disk, Dismiss). Disk equal to `normalizeText(base)` is the pre-commit tidy: base catches up, the buffer is kept. A reload is a minimal diff with `addToHistory: false`, so the caret stays and ⌘Z unwinds only your keystrokes.

**The column** is left-anchored at 48rem, centred only when one markdown tab is alone in one pane (`isSoloNote`).

## Rules

- Advance `base` before the write lands. Content comparison, not path/mtime or pausing the watcher, is what stops a save echoing back as a foreign edit.
- Only normalization counts as our own write. It is idempotent; a `relink` rewrite carries real content and must merge.
- `merge3` reports an overlap, never picks a side. The report is what routes to the banner.
- A reload is never an undo step, or ⌘Z restores stale text and autosave clobbers the other writer.
- Block decorations come from a `StateField`, never a `ViewPlugin`: CodeMirror throws in `new EditorView` and the note opens blank.
- Motion inside CodeMirror is paint only. Animating width, height, font-size or padding pegs the measure loop ([ui-system.md](../ui-system.md)).
- The heading mark is `white-space: pre`, and transitions only under `.cm-heading-sliding`, or `## ` wraps three lines tall and headings animate shut on open.
- `requestMeasure()` does not move the caret layer. The slide does one `coordsAtPos` per frame, never a transaction per frame.
- A widget's `eq` compares only what it renders from; live preview rebuilds on every arrow key.
- The wiki grammar owns its range, or the parser's phantom inner link shadows the chip.
- Block widgets apply `--editor-inset` themselves.
- The ask button uses `mousedown` + `preventDefault`, and is absent on read-only files and outside the notes stack.
- Completion chrome is scoped by the `cm-holi-completion` class to outrank CodeMirror, holds no hex, and keeps `icons` on (the table menu styles off it).

## Rejected

- Animating the source/rendered swap (View Transitions, frozen caret, gap marks): pegs the measure loop.
- A source/rendered mode toggle: loses reveal-on-caret.
- Revealing the whole line: one typo collapsed every chip on it.
- Rendering every binary in place, or converting PDFs to markdown on entry: the agent cannot read them.
- Our own completion engine or a React overlay: Radix menus take focus the editor must keep.

## Code

- `apps/desktop/src/renderer/src/editor/`: `extensions.ts` (stacks), `livePreview.ts` (`revealedSpans`), `heading-slide.ts`, `mermaid.ts`, `completion.ts`, `slash.ts`, `mentions.ts`, `askAgent.ts`, `theme.ts`
- `apps/desktop/src/renderer/src/features/editor/EditorPane.tsx`: load, save, flush, reload
- `apps/desktop/src/renderer/src/lib/editor-reload.ts`, `apply-reload.ts`
- `packages/shared/src/merge3.ts`, `normalize-md.ts`, `file-kind.ts`, `image-ref.ts`
- `apps/desktop/src/renderer/src/features/files/ImageViewer.tsx`, `FilePlaceholder.tsx`
