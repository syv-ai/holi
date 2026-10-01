# File tree

The sidebar explorer shows the vault as the folders and files on disk. It reads as a navigation list: root entries are headings, and each open folder's contents hang from a rounded connector. It does what an editor's explorer does: context menu, inline create and rename, multi-select, keyboard navigation, drag to move, cut, copy and paste. Every move keeps `[[links]]` intact, and files dropped in from Finder are copied into the vault.

## How it works

**A projection of the snapshot.** The tree is built from the vault snapshot (a directory walk plus a watcher) and holds no data of its own. A note created by the agent, by a pull or in another window appears without a refetch. Expansion, selection and focus are the component's own state. The rules that do not need the DOM live in `lib/tree-view.ts`: which rows are showing, what a range spans, where typeahead lands, and whether a move may happen.

**Folders are real.** A folder row comes from `snapshot.dirs`, which lists every directory holding a file, so a folder whose contents are all filtered out still shows. New Folder writes a `.gitkeep` so the empty folder persists and syncs; a keep-file is a folder signal and never shown as a leaf. A folder still being named exists only in client state.

**The look.** Root entries are larger and muted unless they are focused or on the open file's path. The focused root is marked by a brand bar at its left, which slides to the next one; there is no line under it. Inside a folder, each row hangs from its parent's chevron by a rounded elbow. The line from the root to the open file is drawn in brand, and so are the chevrons of every folder on it. The open file is bold.

- A folder leads with a chevron only. A file leads with its type glyph in the chevron's column, except a note, which has no glyph and no `.md`: it is the unmarked row. The empty slot keeps names aligned.
- The root's folders and its loose files are two groups with a gap between them.
- A folder opens with the disclose motion (see [ui-system](../ui-system.md)).
- `expansion` is `single` by default: opening a folder closes the other branches, so one path is open. `multi` lets folders stay open. The open file's branch always opens.

**Opening.** A click opens a preview tab, a double click pins it, and ⌘-click opens the file in a new pane (see [tabs and panes](tabs-panes.md)). A click on a folder opens or closes it.

**Selection.** ⌘⇧-click adds or removes one row, ⇧-click selects the range from the last clicked row, ⇧↑/↓ extends it and ⌘A selects every visible row. The row menu, the keys and a drag act on the whole selection when the row is part of it, and on just that row otherwise. A selection shows a fill only once it holds more than one row: a single one is already shown by the open file's weight and the focus ring.

**Keyboard.** The tree is one tab stop. ↑/↓, Home and End move it, and the selection with it. → opens a folder and then steps into it; ← closes it and then steps out to the parent. Enter opens a file or toggles a folder. Letters typed in quick succession jump to the next row whose name begins with them. Escape collapses the selection to the focused row. F2, ⌫ and ⌘X/C/V/D do what the menu says.

**Toolbar.** The tree's top-right holds the [nav menu](nav-menu.md)'s morphing menu, anchored at
that corner and opening downward: icons on the sidebar's own background, so rows scrolled under
them do not show through, while the tree is hovered or the menu has focus, kept
while it is open. **+** unfolds into New Task, New File, New Folder and New App; Collapse All, Show
task files and Show hidden files are shortcuts, the two filters pressed while on. Every item has a
shortcut, so there is no More. In a sidebar too narrow for the open menu, it grows rightward over
the editor rather than past the window's edge.

- **Where a new item goes** is next to the focused row (`newItemPlace`): inside a focused folder as
  its first row, right after a focused file or app in its folder, and at the root when nothing is
  focused. The name field slides in there, making room with the disclose motion.
- **A task** is named by its title; main names the file and it opens pinned, as ⌘⇧T's does, whether
  or not the tree shows task files. **An app** is `holi apps init`'s scaffold (`index.html` and an
  `app.yaml`, never overwriting), and its `index.html` opens, which expands the bundle. A typed
  `.app` is not doubled.

**Row menu.** Open in a New Pane, New File, New Folder, Rename (F2), Edit Icon, Delete (⌫), Cut, Copy, Paste, Duplicate, Copy to Folder, Move to Folder, Convert to PDF (markdown only), Copy Path, Copy Relative Path, Reveal in Finder. An app row leads with Open (or Finish this app), Open in a New Pane, and Show or Hide App Files. A multi-selection gets only the batch actions: delete, clipboard, duplicate and the two out-of-vault ones.

- Rename, cut-and-paste and drag are one batch move: a single-pass link rewrite over the whole `from → to` map, open tabs retargeted, and a commit before and after. A move that would change nothing, or put a folder inside itself, is refused.
- Copy, paste and Duplicate make new files and leave links pointing at the originals. Duplicate appends ` copy`.
- Create, move and copy refuse to overwrite an existing path.
- Delete previews inbound links from outside the deleted set; they are left dangling, not cascaded.
- A deleted folder goes with its documents: its `.gitkeep` and the folders left empty go too.
  A file the preview never listed (a `.local.` file) stays, and so does the folder holding it. A
  folder with no documents left goes without a preview.
- The name field opens in place: a rename in the row, a new file or folder from the row menu as the first row of the folder it lands in. Enter commits; Escape or leaving the field cancels. A note is renamed without its `.md`, which is added back, and New File appends `.md` when no extension is typed.

**Drag and drop.** One mechanism. A row's drag is a native OS drag of the target files, so they can be dropped into other apps. Everything dropped on the tree arrives as files, and the path decides: a source inside this vault is a move through the move path, anything else is copied in. The destination is the folder under the pointer, a file's folder, or the root for empty space. The target folder is tinted while a drag is over it, and a closed folder opens after a short hover. A name clash is refused per file with an exclusive copy, and the skipped names stay listed until dismissed. A cloud placeholder that is not downloaded (`ETIMEDOUT`) is refused by name, and a folder from Finder is refused with a sentence. Dropping a row into Finder does not work, which is why Copy to Folder and Move to Folder exist; both auto-rename at the destination, and a move warns about dangling links and removes only the files whose copy landed.

**Apps.** A vault app's bundle (a `<name>.app` folder) is a folder that behaves as a file. It shows as one row with an app glyph and its name without `.app`, sorts with the files, and opens the app with a note's gestures. →, Show App Files, or the chevron that hover or focus reveals at the row's right end expands it so its files can be edited, and only then does it lead with a chevron; ←, Hide App Files or that chevron closes it. A drop on it lands beside it, and New File or Paste on it land beside it too. It moves, renames, copies and deletes as a folder. It needs its `index.html` to be an app; before that, or for a macOS app copied in, it is a folder. Without its `app.yaml` it is dimmed, a click shows its files instead of opening it, and its menu offers Finish this app instead of Open. See [vault apps](vault-apps.md).

**Reveal.** A command elsewhere (Edit Source on a vault app) can ask the tree to show a path. The tree opens down to it, selects it and scrolls it into view, even while it is hidden. A request made while a name is being typed is dropped.

**Hidden files.** A per-vault toggle in the header shows or hides entries with any dot-prefixed segment (`.holi/…`, `.claude/…`) and machine-local files (any `.local.` in the name or in a folder above it, such as `USER.local.md` or a personal `Home.local.app`). Hidden by default and remembered per vault. It only filters the view; a revealed path shows even while hidden. `AGENTS.md`, `CLAUDE.md` and `MEMORY.md` are never hidden.

**Local and ignored files.** Machine-local files reach the snapshot and appear under show-hidden, but never sync. Local markdown is listed as a file, outside the note link graph. The watcher ignores them, so they refresh on the 30 s heal, except the personal theme, the personal settings and a personal app, which reload live. Anything git ignores is dimmed, from `git check-ignore` carried on the snapshot. The dim is on the row's contents, not the row, so a selection behind it stays solid. `.git`, `node_modules`, temp write files and OS junk are never content.

**Task files.** Hidden by default behind a second per-vault toggle, because the board owns them. When shown, a task leaf carries its status glyph and a done task is struck through. Today's daily note is marked `today`, with its link count, in brand text at the row's right end, centred on the name's x-height like the name itself.

**Icons.** A file's type glyph is coloured by extension; git's own files show the Git mark. Any row (note, folder, binary) can instead carry one emoji from the vault's icon map: `.holi/settings/icons.yaml`, committed, under a per-key `.holi/settings/icons.local.yaml`. Set it with Edit Icon; an empty field removes the entry. Keys are normalized vault paths, written back sorted; a key outside the vault is dropped. The value must be exactly one emoji (either variation-selector spelling, or a lone pictograph) and anything else is ignored. The note's tab shows the same icon. The Icons settings section lists every entry and marks those whose path is gone.

## Rules

- The tree is a view of the snapshot. It never caches vault data.
- Every tree write keeps the flush, commit, operation, commit order.
- Local-ness is the `.local.` marker and nothing else. Git keeps local files out of commits.
- The icon map is the only place icons live, and an entry left behind by a move degrades to no icon.
- Links inside fenced code are rewritten on a move like any other link, so a move in Holi and one in a terminal produce the same files.
- A rule that does not need the DOM goes in `lib/tree-view.ts`, with a test.

## Rejected

- A tree library (headless-tree, used before): it captured handlers once, so every action read state through refs; its click handling had to be overridden for the modifier clicks; and its drop and focus handling needed workarounds to stop a refused drop opening a window and a first drop throwing. The rules it provided fit in one small module.
- Two drag mechanisms (native for files, the web drag for folders): two drop paths for one move.
- ⌘-click as the selection toggle: ⌘-click already opens a file in a new pane, as it does on a link in the editor.
- An icon in the note's frontmatter: it cannot serve folders, binaries, agent instructions or local markdown, and two sources need a precedence rule.
- An emoji in the filename: a wiki-link would need the icon to be written.
- Fixed hidden roots for `AGENTS.md` and friends: the agent's instructions should always be visible.
- OS-trash delete: git history is the recovery path, and the link preview is the safeguard.
- Waiting for a cloud file to download on drop: the fix belongs in Finder.

## Code

- `apps/desktop/src/renderer/src/features/explorer/FileTree.tsx`: the tree, its state, keys and drops
- `apps/desktop/src/renderer/src/lib/tree-view.ts`: visible rows, ranges, typeahead, move validity, where a new item goes
- `apps/desktop/src/renderer/src/features/explorer/RowMenu.tsx`, `ExplorerHeader.tsx`: the row menu; the toolbar
- `apps/desktop/src/renderer/src/features/explorer/useTreeProjection.ts`, `lib/tree-data.ts`: snapshot to tree data, filters
- `apps/desktop/src/renderer/src/features/explorer/useExplorerActions.ts`, `lib/tree-actions.ts`: clipboard, delete preview, planned moves
- `apps/desktop/src/renderer/src/composites/file-icons.tsx`, `features/explorer/EditIcon.tsx`: glyphs and the icon dialog
- `packages/shared/src/path-safety.ts`: `isHiddenPath`, `isLocalOnlyPath`, `isKeepFile`
- `packages/shared/src/icon-map.ts`: icon map parsing and validation
- `apps/desktop/src/main/vault/vault-store.ts`, `vault-files.ts`, `git-ignored.ts`: scan, non-content rules, ignored paths
- `apps/desktop/src/main/vault/move.ts`, `copy.ts`, `import-files.ts`, `export-files.ts`: move with link rewrite, copy, import, copy and move out
