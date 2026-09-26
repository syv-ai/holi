# File tree

The sidebar explorer shows the vault as the folders and files on disk and behaves like VS Code's: context menu, inline create and rename, multi-select, drag to move, cut, copy, paste and keyboard navigation. Every move keeps `[[links]]` intact, and files dropped in from Finder are copied into the vault.

## How it works

**A projection of the snapshot.** The tree is built from the vault snapshot (a directory walk plus a watcher) and holds no data of its own. `@headless-tree/react` owns only selection, focus, expansion, keyboard, typeahead and drag; Holi owns the DOM and every mutation. A note created by the agent, by a pull or in another window appears without a refetch.

**Folders are real.** A folder row comes from `snapshot.dirs`, which lists every directory holding a file, so a folder whose contents are all filtered out still shows. New Folder writes a `.gitkeep` so the empty folder persists and syncs; a keep-file is a folder signal and never shown as a leaf. A folder still being named exists only in client state.

**Opening.** A single click opens a preview tab; a double click pins it (see [tabs and panes](tabs-panes.md)). The open file is tinted apart from the selection.

**Row menu.** Open in a New Pane, New File, New Folder, Rename (F2), Edit Icon, Delete (⌫), Cut, Copy, Paste, Duplicate, Copy to Folder, Move to Folder, Convert to PDF (markdown only), Copy Path, Copy Relative Path, Reveal in Finder. Cut, copy, delete and the two out-of-vault actions work on a whole selection and on folders.

- Rename, cut-and-paste and drag are one batch move: a single-pass link rewrite over the whole `from → to` map, open tabs retargeted, and a commit before and after. A drop that would be a no-op or put a folder inside itself is refused.
- Copy, paste and Duplicate make new files and leave links pointing at the originals. Duplicate appends ` copy`.
- Create, move and copy refuse to overwrite an existing path.
- Delete previews inbound links from outside the deleted set; they are left dangling, not cascaded.
- The name input opens where the file will land, at that folder's indent. New File auto-appends `.md` when no extension is typed.

**Drag and drop.** Dragging from Finder copies bytes into the folder under the pointer (onto a file: its folder; onto empty space: the root). A name clash is refused per file with an exclusive copy, and the skipped names stay listed until dismissed. A cloud placeholder that is not downloaded (`ETIMEDOUT`) is refused by name, and a folder from Finder is refused with a sentence. A file row's drag is a native OS drag; dropped back on the window with a source inside this vault, it is a move through the move path. Folder rows keep the web drag. Dropping a row into Finder does not work, which is why Copy to Folder and Move to Folder exist; both auto-rename at the destination, and a move warns about dangling links and removes only the files whose copy landed.

**Hidden files.** A per-vault toggle in the header shows or hides entries with any dot-prefixed segment (`.holi/…`, `.claude/…`) and machine-local files (any `.local.` in the name, such as `USER.local.md`). Hidden by default and remembered per vault. It only filters the view; a path revealed by a command shows even while hidden. `AGENTS.md`, `CLAUDE.md` and `MEMORY.md` are never hidden.

**Local and ignored files.** Machine-local files reach the snapshot and appear under show-hidden, but never sync. Local markdown is listed as a file, outside the note link graph. The watcher ignores them, so they refresh on the 30 s heal. Anything git ignores is dimmed, from `git check-ignore` carried on the snapshot. `.git`, `node_modules`, temp write files and OS junk are never content.

**Task files.** Hidden by default behind a second per-vault toggle, because the board owns them. When shown, a task leaf carries a status glyph and a done task is struck through.

**Icons.** A leaf gets a type glyph coloured by extension. Any row (note, folder, binary) can instead carry one emoji from the vault's icon map: `.holi/settings/icons.yaml`, committed, under a per-key `.holi/settings/icons.local.yaml`. Set it with Edit Icon; an empty field removes the entry. Keys are normalized vault paths, written back sorted; a key outside the vault is dropped. The value must be exactly one emoji (either variation-selector spelling, or a lone pictograph) and anything else is ignored. The note's tab shows the same icon. The Icons settings section lists every entry and marks those whose path is gone.

## Rules

- The tree is a view of the snapshot. It never caches vault data.
- Every tree write keeps the flush, commit, operation, commit order.
- Local-ness is the `.local.` marker and nothing else. Git keeps local files out of commits.
- The icon map is the only place icons live, and an entry left behind by a move degrades to no icon.
- Links inside fenced code are rewritten on a move like any other link, so a move in Holi and one in a terminal produce the same files.

## Rejected

- An icon in the note's frontmatter: it cannot serve folders, binaries, agent instructions or local markdown, and two sources need a precedence rule.
- An emoji in the filename: a wiki-link would need the icon to be written.
- Fixed hidden roots for `AGENTS.md` and friends: the agent's instructions should always be visible.
- OS-trash delete: git history is the recovery path, and the link preview is the safeguard.
- Waiting for a cloud file to download on drop: the fix belongs in Finder.

## Code

- `apps/desktop/src/renderer/src/features/explorer/FileTree.tsx`: the tree, menu, drops, filters
- `apps/desktop/src/renderer/src/features/explorer/ExplorerHeader.tsx`: New File, New Folder, Collapse All, the two toggles
- `apps/desktop/src/renderer/src/features/explorer/useExplorerActions.ts`, `lib/tree-actions.ts`: clipboard, delete preview, planned moves
- `apps/desktop/src/renderer/src/lib/tree-data.ts`: snapshot to tree data
- `apps/desktop/src/renderer/src/composites/file-icons.tsx`, `features/explorer/EditIcon.tsx`: glyphs and the icon dialog
- `packages/shared/src/path-safety.ts`: `isHiddenPath`, `isLocalOnlyPath`, `isKeepFile`
- `packages/shared/src/icon-map.ts`: icon map parsing and validation
- `apps/desktop/src/main/vault/vault-store.ts`, `vault-files.ts`, `git-ignored.ts`: scan, non-content rules, ignored paths
- `apps/desktop/src/main/vault/move.ts`, `copy.ts`, `import-files.ts`, `export-files.ts`: move with link rewrite, copy, import, copy and move out
