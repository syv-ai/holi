# Wiki-links

Notes link to each other with path-based `[[folder/note.md]]` links. They render as chips in the editor, survive renames and moves because the links are rewritten, show both ways in a drawer beside the note, and tell you what will dangle before a delete.

## How it works

**Grammar.** `packages/shared/src/wiki-links.ts` is the only parser: `[[path]]` or `[[path|Label]]`, where the path is vault-relative and `/`-separated. `parseWikiLinks(text)` returns each match with `target`, `label` and exact `start`/`end` offsets. `wikiLinkRegex()` returns a fresh `RegExp` per call. `formatWikiLink`, `rewriteWikiLinks`, `rewriteWikiLinksMulti` and `wikiLinksToText` (for PDF export) are built on the same parser. There is one link grammar: a link to a task is a link to its `task.<name>.md` file.

**Rendering.** Live preview replaces each link with a `WikiLinkChip` unless the selection touches it. A target that resolves to a task draws a status orb and the task's title (struck through when done). A note chip shows its label, or its path without a trailing `.md` (`wikiLinkChipText`), tinted when the file does not exist. An image target (`[[logo.png]]`) renders the image inline instead. A chip opens its target on mousedown. Hovering shows a preview card: a task's orb, title and due, a note's title and first lines (read fresh on each hover), or "doesn't exist yet".

**Authoring.** Typing `@` completes over notes and open tasks and inserts a `[[path]]` link (see [editor.md](editor.md)). The agent writes the same syntax with its native tools.

**Rename and move.** `notes.rename` rejects a destination that already exists, then rewrites every inbound link, then moves the file. A rename to a different folder prefix is a move and creates the folders. Dragging in the tree runs the batch move (`moveNotes`), which rewrites all inbound links in one pass over the original move map, so `a→b, b→c` never chains. Open tabs follow the file. A file moved outside Holi (a terminal `git mv`, the agent's `mv`) is caught by the `relink` pre-commit transform ([vaults-sync.md](vaults-sync.md)).

**Backrefs and delete.** `scanBackrefs` greps the vault's markdown for links to a path, excluding the file itself. The delete confirm names each linking file and its count; a folder or multi-select delete ignores links internal to the set. There is no cascade: dangling links stay and render as missing chips.

**The links drawer.** A right-hand drawer, opened by the links button beside history in the active pane's tab strip, following the same focused markdown tab. The right edge holds one of core's drawers at a time, History, Links or [Comments](note-comments.md) (`state/right-drawer.ts`): opening one replaces whichever was open, so there is no hidden drawer to come back to. The agent's turn review is the agent plugin's own and not one of them. "Links to" lists each note the file links to once, by its label or name with its folder beneath; a link to a note that does not exist is listed dimmed with "doesn't exist yet" and opens nothing, like its chip. "Linked from" lists each file that links here, with every linking line as a snippet (links read as their text). A row opens its note as a preview tab, as a chip does. One main call, `notes.links` (`scanLinks`), answers both directions in the same walk the backref scans make. The drawer asks again 800ms after the vault's notes last changed (`useVaultScan`, keyed on `linkFingerprintAtom`: each note's path and mtime, the claimed files, the other files' paths), so an edit shows once autosave has written it, and a snapshot push that changed nothing asks nothing. One scan runs at a time. A failed scan says so rather than showing empty lists. Links to images, PDFs and office documents are not listed: they are not links between notes. Any other target is, `[[note]]` without an extension included, and is dimmed when no such file exists. Its header opens the [graph](graph.md).

## Rules

- One parser for editor, rename, backrefs, the links drawer and export. Two parsers drift on greedy vs lazy matching.
- Rewrite by exact parsed ranges, never by substring replace.
- Check the destination before moving anything. Renaming onto an existing folder merges silently, and a mid-move collision leaves a half-moved folder.
- Rewrite links before moving the file, so a crash leaves links pointing at a file that still exists.
- There is no transaction and cannot be one. Every step is a file write in a git repo, so the commit before the rename is the restore point and a half-done rename shows in `git status`.
- No link index. A local vault greps in milliseconds, and an index is a second copy of the truth that goes stale.
- Only markdown is in the link graph. Images and other binaries are assets referenced by path; rename, backrefs and move rewriting are markdown-only.
- "Exists" is a real filesystem check against the snapshot.
- A task link survives a rename only because the rewrite reaches it; a missed rewrite is possible and is the accepted cost of one grammar.

## Rejected

- Stable document IDs (`[[doc:a1b2]]`) or id+slug hybrids: opaque in raw markdown, and harder for the agent to read and write.
- A separate `[[task:<id>]]` token: tasks have no ids; a task is a file, so it takes the same grammar.

## Code

- `packages/shared/src/wiki-links.ts`: the grammar and rewrites
- `apps/desktop/src/renderer/src/editor/wikiLinkChips.ts`, `wikiHover.ts`, `livePreview.ts`, `links.ts`
- `apps/desktop/src/main/vault/rename.ts`, `move.ts`, `backrefs.ts`, `hooks/relink.ts`
- `apps/desktop/src/renderer/src/composites/DeleteConfirm.tsx`
- `apps/desktop/src/renderer/src/features/links/LinksPanel.tsx`: the links drawer
- `apps/desktop/src/renderer/src/lib/use-vault-scan.ts`, `state/links.ts`: when the drawer and the graph ask again
