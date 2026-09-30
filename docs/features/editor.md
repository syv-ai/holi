# Editor

Every note is a `.md` file, edited in CodeMirror 6 with live preview: markdown renders inline, and the element under the caret shows its raw source. The editor writes the file directly, autosaves, and survives the file changing underneath it.

## How it works

**Three stacks.** `baseEditorExtensions` is the notes editor. `mailComposerExtensions` is the same markdown editing with every vault layer removed. `plainTextExtensions` opens other text files with highlighting and validity checks, no markdown layers.

**Live preview.** A `ViewPlugin` decorates the visible ranges and rebuilds on doc, selection or viewport change. The **element** the selection touches renders raw; the rest of its line stays rendered. Touching an edge counts, and when elements nest only the innermost opens. A heading's `#`, a list marker and a quote's `>` reveal with their whole line. The swap is instant, except a heading's `#`, which slides (`heading-slide.ts`).

**Keys and links.** ⌘B, ⌘I, ⌘E, ⌘⇧X and ⌘K wrap or unwrap the selection or word. A wiki-link chip opens on click; a markdown link needs ⌘-click, since a plain click means "edit this text". A bare `github.com`, `www.` or `https://` address in prose opens the same way; `linkify-it` finds them, without emails and without the country domains that are also source-file extensions (`notes.md`, `main.py`). Code, comments and existing links are skipped, and the file is left as written. All three forms look alike: everything inside a link takes the link's colour, since GFM parses `www.` and `https://` addresses as `URL` nodes that the code highlighter would otherwise paint.

**Arrows are rewritten as you type.** `->` becomes `→` in the file once the space after it goes in, and `<-`, `<->` and `=>` become `←`, `↔` and `⇒`. Only with whitespace or the line's start before it, never in code or frontmatter. It is its own undo step, so ⌘Z gives back the typed arrow.

**Lists.** Nesting comes from the tree, never from counting spaces; the typed indentation is concealed and depth alone places a line. An item's wrapped rows and its later lines (a soft break, a lazy continuation) hang under its text. Every marker sits in a box of known width, so no measuring is needed: a bullet, a checkbox, an ordered marker as wide as its list's longest in `ch` with tabular digits, so `9.` and `10.` share a column. The one space after a marker is concealed and the theme's gap stands in for it, since its width is the font's. `a.`, `A.` and `a)` lists are Holi's own, since CommonMark has only decimal ones: a parser extension (`alphaLists` in `lists.ts`) puts them in the tree as an `AlphaList` of ordinary `ListItem`s, so they nest, wrap and continue like any list. One may start inside a list or at the start of a block, never mid-paragraph, so "A. Smith said" stays a sentence. Markdown's own Enter cannot write a letter, and builds its indent only from lists it knows, so Enter in a letter list, or in any list inside one, is Holi's.

**A list's kind is chosen by typing it.** In the empty first item of a list, typing `a.` after the marker makes it a letter list (`1. a.` becomes `a. `), and `1.` makes it decimal again; `A.`, `a)` or any number work too, and set where the list starts. Only the first item chooses, so `2. a.` stays text, and the rest of the list follows it. The switch is its own undo step, so ⌘Z gives back what was typed. Bullets are not offered: an empty `- ` under a line of text is that line's setext underline, so switching would turn it into a heading.

**Ordered numbers are rewritten in the file.** After an edit that reshapes a list (Tab, Shift+Tab, Enter, deleting a marker or a line break, moving a line), a transaction filter renumbers every decimal or letter list it touched from its start. A list keeps its start only if its first item was already one; otherwise it starts at 1. A nested list with no blank line above it always starts at 1, because CommonMark, GitHub included, reads `2.` under an item's text as more of that text. Letters keep the case of the list's first item and stop at `z`. Typing inside an item, a number included, is left alone, as are undo and reloads.

**Tables** (`codemirror-markdown-tables`) sit centred in the column, their cells keeping their own alignment; a table wider than the column scrolls from its left edge. A focused cell is a nested editor given inline live preview under `inlineOnlyFacet`. An unfocused cell is rendered by the package from the root highlighter, so a `HighlightStyle` is the only thing that styles it: it can hide `**`, `*` and `` ` ``, and keeps a link's brackets.

**Images and binaries.** Any file may live in a vault; markdown is what you write. `![](path)` (note-relative) and `[[img.png]]` (vault-relative) render inline via `holi-vault://`. An image opens in its own tab on a light checkerboard plate, a PDF in the viewer ([pdf.md](pdf.md)), other known binaries in a typed placeholder. Binaries stay out of the link graph.

**Inline code** is the prose's size, in mono scaled to the prose face's x-height (`font-size-adjust: from-font`), with no fill: the `--code` theme token colours it.

**Quotes** are a flat translucent surface, centred and narrower than the column, holding what the quote holds (lists hang inside it as outside). The `> ` shows only on the caret's line.

**Comments.** An HTML comment on lines of its own draws as a small floating banner, centred, in the `--comment` and `--comment-background` tokens, and shows its source when touched. One inside a paragraph stays text in the comment colour. The banner is exactly as tall as its source, whose first and last lines take the banner's padding while they show, so opening a comment does not move the note.

**Fenced code** hides its backticks while the caret is outside the block, leaving the language as a small label. The fence lines stay, so the block keeps its height when the caret enters and the fences show.

**Mermaid.** A mermaid fence draws as a diagram and shows source when touched. Mermaid loads on first use, a broken diagram shows its source, and the palette follows light/dark at render time.

**Completion.** Every popup in the app comes from `holiCompletion`. `@` lists notes, then open tasks, and inserts a `[[path]]`. `/todo` inserts a checkbox; `/table` reopens on sizes (columns by body rows).

**Ask the agent.** A selection shows a button that opens a field and a session picker. The message is your instruction, then `[From <path>, lines 12-18]` and the passage quoted with `> `; line numbers come from CodeMirror's range, so they are exact.

**Saving.** Written after 600 ms of quiet and on blur, flushed on tab close, vault switch and quit. ⌘S saves every buffer, commits and pushes. Invalid frontmatter YAML holds the save; a flush writes anyway.

**External writes.** `base` is the text last loaded or saved. `decideReload`: disk equal to base is nothing; a clean buffer reloads; a dirty one takes `merge3`; an overlap raises the conflict banner (Keep mine, Use the file on disk, Dismiss). Disk equal to `normalizeText(base)` is the pre-commit tidy: base catches up and the buffer is kept, clean or not. The commit lands seconds after autosave, while someone who stopped to think is still looking at the line, so taking the tidied bytes would pull a just-typed space out from under the caret. A markdown buffer that differs from base only by the tidy has nothing new, so it is not written back (`hasNewText`). The tidy itself keeps the one space after a bare list marker or `#`, since without it the line would stop being an item or a heading. A reload is a minimal diff with `addToHistory: false`, so the caret stays and ⌘Z unwinds only your keystrokes.

**The column** is at most 48rem, centred in whatever pane it is in; a task file's is 24rem, as wide as its properties widget.

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
- A widget standing in for source keeps the source's height (the comment banner, the divider). A block element inside a line gets an empty line box on either side from CodeMirror's cursor anchors, so a line's widget is inline.
- The ask button uses `mousedown` + `preventDefault`, and is absent on read-only files and outside the notes stack.
- Completion chrome is scoped by the `cm-holi-completion` class to outrank CodeMirror, holds no hex, and keeps `icons` on (the table menu styles off it).

## Rejected

- Animating the source/rendered swap (View Transitions, frozen caret, gap marks): pegs the measure loop.
- A source/rendered mode toggle: loses reveal-on-caret.
- Revealing the whole line: one typo collapsed every chip on it.
- Rendering every binary in place, or converting PDFs to markdown on entry: the agent cannot read them.
- Our own completion engine or a React overlay: Radix menus take focus the editor must keep.

## Code

- `apps/desktop/src/renderer/src/editor/`: `extensions.ts` (stacks), `livePreview.ts` (`revealedSpans`), `heading-slide.ts`, `mermaid.ts`, `comments.ts`, `arrows.ts`, `bare-links.ts`, `completion.ts`, `slash.ts`, `mentions.ts`, `askAgent.ts`, `theme.ts`
- `apps/desktop/src/renderer/src/features/editor/EditorPane.tsx`: load, save, flush, reload
- `apps/desktop/src/renderer/src/lib/editor-reload.ts`, `apply-reload.ts`
- `packages/shared/src/merge3.ts`, `normalize-md.ts`, `file-kind.ts`, `image-ref.ts`
- `apps/desktop/src/renderer/src/features/files/ImageViewer.tsx`, `FilePlaceholder.tsx`
