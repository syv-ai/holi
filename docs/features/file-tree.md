# File tree

The sidebar explorer shows the vault as the folders and files on disk. It reads as a plain list: each row is a chevron, an icon and a name, indented a step per level. It does what an editor's explorer does: context menu, inline create and rename, multi-select, keyboard navigation, drag to move, cut, copy and paste. Every move keeps `[[links]]` intact, and files dropped in from Finder are copied into the vault.

## How it works

**A projection of the snapshot.** The tree is built from the vault snapshot (a directory walk plus a watcher) and holds no data of its own. A note created by the agent, by a pull or in another window appears without a refetch. Expansion, selection and focus are the component's own state. The rules that do not need the DOM live in `lib/tree-view.ts`: whether a move may happen.

**Folders are real.** A folder row comes from `snapshot.dirs`, which lists every directory holding a file, so a folder whose contents are all filtered out still shows. New Folder writes a `.gitkeep` so the empty folder persists and syncs; a keep-file is a folder signal and never shown as a leaf. A folder still being named exists only in client state.

**The look.** The app's one tree (`components/ui/tree.tsx`, ReUI's `tree`, here driven by headless-tree in `features/sidebar/files-section.tsx`; see [ui-system](../ui-system.md#page-baseline)). Every row is the same size at every level: a folder's chevron, an icon and the name, with a flat indent per level and nothing drawn between levels. The open file is bold. Nothing moves except a row's hover fill: a folder opens and closes at once, the chevron turns without a transition, and rows that appear (a pull, a new file) are simply there. It replaced a tree with connector rails, a brand-lit path to the open file, a brand bar sliding between roots, folders sliding open and rows fading in, which was too much motion for the thing you look at most.

- A folder leads with its chevron and a folder glyph (open or closed). A file has no chevron, and its icon sits in the folder glyph's column, so a root file lines up with the root folders: its type glyph, a note's included (no `.md` in its name), a task's status, or the vault icon map's emoji, which also replaces a folder's glyph.
- `expansion` is `single` by default: opening a folder closes the other branches, so one path is open. `multi` lets folders stay open. The open file's branch always opens.
- A `@headless-tree/react` instance turns the tree data and the open set into the flat, indented rows and their `aria` tree semantics. It is fed controlled state and nothing else: the clicks, keys, drag and drop, menus and name fields below are the explorer's own handlers on the rows.

**Opening.** A click opens a preview tab, a double click pins it, and ⌘-click opens the file in a new pane (see [tabs and panes](tabs-panes.md)). A click on a folder opens or closes it.

**Selection.** ⌘⇧-click adds or removes one row, ⇧-click selects the range from the last clicked row, ⇧↑/↓ extends it and ⌘A selects every visible row. The row menu, the keys and a drag act on the whole selection when the row is part of it, and on just that row otherwise. A selection shows a fill only once it holds more than one row: a single one is already shown by the open file's weight and the focus ring. Clicking blank space in the explorer clears the selection and row focus; clicks on rows, menus and name fields keep their own behavior.

**Keyboard.** The tree is one tab stop. ↑/↓, Home and End move it, and the selection with it. → opens a folder and then steps into it; ← closes it and then steps out to the parent. Enter opens a file or toggles a folder. Letters typed in quick succession jump to the next row whose name begins with them. Escape collapses the selection to the focused row. F2, ⌫ and ⌘X/C/V/D do what the menu says.

**Toolbar.** The tree's top-right holds the [nav menu](nav-menu.md)'s morphing menu, anchored at
that corner and opening downward: icons on the sidebar's own background, so rows scrolled under
them do not show through, while the tree is hovered or the menu has focus, kept
while it is open. **+** unfolds into New File, New Folder and what enabled claims make (`create`: New Task, New Link, New App); Collapse All, Show hidden files
and each hideable claim's filter (Show task files) are shortcuts, the filters pressed while on. Every item has a
shortcut, so there is no More. In a sidebar too narrow for the open menu, it grows rightward over
the editor rather than past the window's edge.

- **Where a new item goes** is next to the focused row (`newItemPlace`): inside a focused folder as
  its first row, right after a focused file or app in its folder, and at the root when nothing is
  focused. The name field appears there as a row at that level.
- **A task** is named by its title; the tasks plugin names the file, and it opens pinned, as ⌘⇧T's does, whether
  or not the tree shows task files. **An app** is `holi apps init`'s scaffold (`index.html` and an
  `app.yaml`, never overwriting), and its `index.html` opens, which expands the bundle. A typed
  `.app` is not doubled.
- **Reveal in Files**, from outside the tree (an app's card on the Apps page), brings the
  Vault sidebar forward and open, expands the row's folders, then selects, focuses and
  scrolls to the row (`state/reveal-in-files.ts`, a numbered request the shell and the tree
  both hear; the tree keeps the last one it answered, since it may mount after the ask).

**Row menu.** Open in a New Pane, New File, New Folder, Rename (F2), Edit Icon, Delete (⌫), Cut, Copy, Paste, Duplicate, Copy to Folder, Move to Folder, Convert to PDF (markdown only), Copy Path, Copy Relative Path, Reveal in Finder. A folder document's row leads with Open and Open in a New Pane (not while it is a draft), and Show or Hide App Files, named by its surface. A claim adds its own items, each shown when its `when` holds (Finish this app on an unfinished app). A multi-selection gets only the batch actions: delete, clipboard, duplicate and the two out-of-vault ones.

- Rename, cut-and-paste and drag are one batch move: a single-pass link rewrite over the whole `from → to` map, open tabs retargeted, and a commit before and after. A move that would change nothing, or put a folder inside itself, is refused.
- Copy, paste and Duplicate make new files and leave links pointing at the originals. Duplicate appends ` copy`.
- Create, move and copy refuse to overwrite an existing path.
- Delete previews inbound links from outside the deleted set; they are left dangling, not cascaded.
- A deleted folder goes with its documents: its `.gitkeep` and the folders left empty go too.
  A file the preview never listed (a `.local.` file) stays, and so does the folder holding it. A
  folder with no documents left goes without a preview.
- The name field opens in place: a rename in the row, and a new folder, or a file a New item made as Untitled, in its own row as soon as the vault has it, selected and scrolled into view, so typing names it. Enter commits; Escape or leaving the field cancels. A note is renamed without its `.md`, which is added back, and New File appends `.md` when no extension is typed.

**Drag and drop.** One mechanism. A row's drag is a native OS drag of the target files, so they can be dropped into other apps. Everything dropped on the tree arrives as files, except a web address dragged from a browser, which a claim that takes one saves (New Link: [links](links.md)); for files the path decides: a source inside this vault is a move through the move path, anything else is copied in. The destination is the folder under the pointer, a file's folder, or the root for empty space. The target folder is tinted while a drag is over it, and a closed folder opens after a short hover. A name clash is refused per file with an exclusive copy, and the skipped names stay listed until dismissed. A cloud placeholder that is not downloaded (`ETIMEDOUT`) is refused by name, and a folder from Finder is refused with a sentence. Dropping a row into Finder does not work, which is why Copy to Folder and Move to Folder exist; both auto-rename at the destination, and a move warns about dangling links and removes only the files whose copy landed.

**Your own order.** The tree sorts folders first, then by name, until you arrange it. A drag onto a
row's top or bottom edge (the tree's drag line, a rule with a ring at its start, shows where) drops beside that row: into its folder if it came from
elsewhere, and at that place in the folder's order, which the tree then keeps
(`lib/tree-order.ts`, `state/tree-order.ts`). The middle of a closed folder still drops into it; an
open folder's lower part does too, since its contents show under it. The order is per vault and
machine-local, like pins: how one person arranges the tree is not a decision about the vault, and a
kept order never conflicts with a teammate's. Placed children come first in their order; anything
never placed (new, or pulled in) follows in name order. A placed path that has gone is ignored rather
than removed, so an undone rename finds its place again.

**Folder documents.** A claim's `folder` (`{surface, entry, ready?}`) makes a matched directory that holds its entry file one document, and its `decorate` (`{icon, name, suffix}`) names and marks the row; a rename keeps the suffix. Vault apps are the one such claim, from the apps plugin. A vault app's bundle (a `<name>.app` folder) is a folder that behaves as a file. It shows as one row with an app glyph and its name without `.app`, sorts with the files, and opens the app with a note's gestures. →, Show App Files, or its chevron expands it so its files can be edited; the chevron sits where a folder's does, shown on hover or focus and while the files are open. ←, Hide App Files or that chevron closes it. A drop on it lands beside it, and New File or Paste on it land beside it too. It moves, renames, copies and deletes as a folder. It needs its `index.html` to be an app; before that, or for a macOS app copied in, it is a folder. Without its `app.yaml` it is dimmed, a click shows its files instead of opening it, and its menu offers Finish this app instead of Open. See [vault apps](vault-apps.md). A plugin's folder document (a community plugin's deck, `<name>.deck`) opens as its surface from a press on its row, and its chevron alone expands it to show the files inside, which open as files; its glyph is the presentation one, in colour.

**Reveal.** A command elsewhere (Edit Source on a vault app) can ask the tree to show a path. The tree opens down to it, selects it and scrolls it into view, even while it is hidden. A request made while a name is being typed is dropped.

**Hidden files.** A per-vault toggle in the header shows or hides entries with any dot-prefixed segment (`.holi/…`, `.claude/…`). Machine-local files are not hidden: `.local.` means the file does not sync, not that it is out of sight, so a personal `Home.local.app` shows like any app. Hidden by default and remembered per vault. It only filters the view; a revealed path shows even while hidden. `AGENTS.md`, `CLAUDE.md` and `MEMORY.md` are never hidden.

**Local and ignored files.** Machine-local files reach the snapshot and show in the tree, dimmed because git ignores them, but never sync. Local markdown is listed as a file, outside the note link graph. The watcher ignores them, so they refresh on the 30 s heal, except the personal theme, the personal settings and a personal app, which reload live. Anything git ignores is dimmed, from `git check-ignore` carried on the snapshot. The dim is on the row's contents, not the row, so a selection behind it stays solid. `.git`, `node_modules`, temp write files and OS junk (`.DS_Store`, `Thumbs.db`) are never content, and the seeded `.gitignore` keeps the junk out of a commit.

**Claimed files.** A claim may hide its files until shown (`hideable`): task files are hidden by default behind Show task files, a per-vault toggle on this machine, because the board owns them. The tree lists claimed files from `snapshot.claimed`, a file that would not parse included; a claim that does not hide its files shows them always. A plugin marks paths (`pathMarks`): a task leaf carries its status glyph and a done task is struck through. Today's daily note is marked `today`, with the tasks plugin's count of open tasks linking to it, in brand text at the row's right end.

**Icons.** A file's type glyph is coloured by extension; git's own files show the Git mark. Any row (note, folder, binary) can instead carry one emoji from the vault's icon map: `.holi/settings/icons.yaml`, committed, under a per-key `.holi/settings/icons.local.yaml`. Set it with Edit Icon; an empty field removes the entry. Keys are normalized vault paths, written back sorted; a key outside the vault is dropped. The value must be exactly one emoji (either variation-selector spelling, or a lone pictograph) and anything else is ignored. The note's tab shows the same icon. The Icons settings section lists every entry and marks those whose path is gone.

**Not built:** the icon map is not applied in the fresh sidebar (no Edit Icon, no emoji on a row or a tab) and folders take no colour; the Icons paragraph above and the Colours paragraph below describe the design ([not-built](../not-built.md)).

**Colours and counts.** A folder can be given a colour from its row menu (Colour, eight categorical hues and No colour). Its glyph takes the hue with a light fill of it, so a person finds their folders at a glance, as a knowledge base's coloured folders do. Colours are per vault and machine-local (local storage, keyed by remote), as pins are: how one person marks their folders is not a decision about the vault. A colour names a path, so a renamed folder loses it until it is coloured again, and an undone rename brings it back. An emoji from the icon map still wins over the glyph. Every folder also shows, at its row's end, how many files it holds at any depth, of those the tree shows.

## Rules

- The tree is a view of the snapshot. It never caches vault data.
- Every tree write keeps the flush, commit, operation, commit order.
- Local-ness is the `.local.` marker and nothing else. Git keeps local files out of commits.
- The icon map is the only place icons live, and an entry left behind by a move degrades to no icon.
- Links inside fenced code are rewritten on a move like any other link, so a move in Holi and one in a terminal produce the same files.
- A rule that does not need the DOM goes in `lib/tree-view.ts`, with a test.

## Rejected

- Letting headless-tree run the tree (as an earlier version did): it captured handlers once, so every action read state through refs; its click handling had to be overridden for the modifier clicks; and its drop and focus handling needed workarounds to stop a refused drop opening a window and a first drop throwing. It is back only to flatten and indent for ReUI's component, with its state controlled and none of its selection, hotkey or drag-and-drop features; the rules stay in `lib/tree-view.ts`.
- Connector rails, a brand-lit path, a sliding root bar, a disclose slide and row arrivals: each was a motion or a line to read past on the surface looked at most. The tree is calm now and is the ReUI component the rest of the app's design system already uses.
- Two drag mechanisms (native for files, the web drag for folders): two drop paths for one move.
- ⌘-click as the selection toggle: ⌘-click already opens a file in a new pane, as it does on a link in the editor.
- An icon in the note's frontmatter: it cannot serve folders, binaries, agent instructions or local markdown, and two sources need a precedence rule.
- An emoji in the filename: a wiki-link would need the icon to be written.
- Folder colours in the committed icon map: a colour is how one person finds their own folders, and a committed one would repaint everyone's tree.
- Fixed hidden roots for `AGENTS.md` and friends: the agent's instructions should always be visible.
- OS-trash delete: git history is the recovery path, and the link preview is the safeguard.
- Waiting for a cloud file to download on drop: the fix belongs in Finder.

## Code

- `apps/desktop/src/renderer/src/features/sidebar/files-section.tsx` and `documents-nav.tsx`: the tree, its state, keys, row menu and drops
- `apps/desktop/src/renderer/src/components/ui/tree.tsx`: the tree's look (ReUI `tree`), shared with the settings rail and History
- `apps/desktop/src/renderer/src/lib/tree-view.ts`: move validity
- `apps/desktop/src/renderer/src/lib/tree-data.ts`, `tree-actions.ts`, `tree-order.ts`, `tree-paths.ts` and `state/tree-order.ts`: snapshot to tree data, clipboard, delete preview, planned moves, your own order
- `apps/desktop/src/renderer/src/state/reveal-in-files.ts`: asking the tree to show a path
- `packages/shared/src/path-safety.ts`: `isHiddenPath`, `isLocalOnlyPath`, `isKeepFile`
- `packages/shared/src/icon-map.ts`: icon map parsing and validation
- `apps/desktop/src/main/vault/vault-store.ts`, `vault-files.ts`, `git-ignored.ts`: scan, non-content rules, ignored paths
- `apps/desktop/src/main/vault/move.ts`, `copy.ts`, `import-files.ts`, `export-files.ts`: move with link rewrite, copy, import, copy and move out
