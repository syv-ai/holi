# Tabs and panes

The workspace is one or more side-by-side panes, each with its own tab strip. Tabs follow VS Code's preview-vs-pinned model, can be dragged between strips and panes, and a document lives in exactly one tab.

## How it works

**A tab is a union**, not a path: `note` (any file, by path), `app` (a vault app, by its bundle path), `session` (an agent session), or one of the singletons `home`, `board`, `agenda`, `mail`, `settings`, `history`. `state/panes.ts` owns it as pure functions over a `Workspace { panes, active }`.

**Preview and pinned.** A single click in the tree opens a file in the pane's preview tab (italic), replacing whatever was previewed. A double click in the tree, a double click on the tab, editing the document, or dragging the tab pins it. Singletons open leftmost and are pinned by construction; if already open they are focused where they sit. Apps and sessions are appended. Closing a session tab does not end the session.

**A tab names a file as the tree does**, by the same `pathLabel`/`pathGlyph`: a note without `.md` and with no glyph, an app without `.app` and with the app glyph, a task with its status, any other file with its extension and type glyph, and an icon-map emoji over all of them. See [file tree](file-tree.md).

**Rename and delete** retarget open tabs (`retargetTab`/`retargetTabs`) and close deleted ones, so the strip never holds a path that is gone.

**Panes.** ⌘\ opens an empty pane beside the focused one; Open in a New Pane (tree row, app row) fills one. The focused pane is the one "open" means, and it follows both pointer and keyboard focus. The unfocused pane's active pill loses its weight. Closing a split's last tab removes the pane; the last pane never goes. ⌘W is the menu's Close Tab and runs the `tab.close` command; ⌘⇧W closes the window. A board card opens its task file beside the board (`openBeside`), reusing the pane to the right.

**Moving a tab.** Native HTML5 drag. Drop in a strip to reorder, on another pane to move there, or on a pane's left/right quarter (capped at 120px) to split. The payload is the tab's identity under the `application/x-holi-tab` MIME type; `findTab` finds it anywhere, so one `moveTab` serves reorder and move. Landing strips appear dim once the pointer leaves the strip, and light under it. While dragging, the pills between the slot and the pointer slide aside and the held pill dims to 40%; a tab arriving from another pane gets a caret line instead. Holding within 28px of a strip end auto-scrolls it.

**The strip scrolls.** Pills sit in an `overflow-x-auto` viewport with a hidden scrollbar; a vertical wheel scrolls it sideways. Each side floats a chevron and a count of tabs off that edge, and opens a menu of them; picking one selects and scrolls it into view. The active tab is scrolled into view when it changes. Other position changes glide (FLIP).

**Vault dropdown.** `VaultPicker` is a Radix dropdown naming the current vault, listing the others, with "Add vault…" at the bottom. Sync state lives in the nav menu's sync item, not here.

## Rules

- One buffer per file across the whole workspace. Every opener goes through `findTab`; two editors on one path race two autosaves, each reading the other's write as foreign.
- A split never copies the current tab. A drag may move it, because remove-then-insert keeps one buffer.
- The active tab follows the document, not the index, in both panes of a move. Keeping the index would silently put you in another file.
- A reorder does not change the active tab; a cross-pane move focuses the destination.
- A drag pins a preview tab, or the next single click in the tree replaces the tab you just placed.
- A pane never offers a drop that would do nothing. `dropZones` asks `moveTab`/`moveTabToNewPane` (they return the same workspace for a no-op); a shared edge between two panes is one gap, and the source pane never offers its middle.
- A sole tab dropped on its own pane's edge is a no-op; on another pane's edge it moves and collapses its source.
- Drag previews use transforms, never layout, and hit-test against `offsetLeft`, not `getBoundingClientRect`. Otherwise the preview moves the midpoints that chose it.
- A drop clears the transform and its transition; a cancelled drag clears to zeros so pills glide home.
- FLIP measures in the viewport frame (`offsetLeft - scrollLeft`) and only when the tab list changed, or a scroll or close-while-scrolled flings pills.
- `min-w-0` on the strip viewport is load-bearing: without it the pane grows instead of scrolling.
- A partly visible pill counts as offscreen; an unmeasured strip reports nothing; scroll-into-view keys on identity, not index.
- The edge counts float and stay mounted, fading while showing their last non-empty number, so the strip never re-lays out mid-scroll.
- Drop and overflow arithmetic lives in pure modules because jsdom computes no layout.
- The `DataTransfer` payload is validated (`parseTabPayload`); it is a trust boundary.
- Tabs and the pane layout are not persisted. A stored layout is keyed to a panel count, and panes come and go. What a vault opens on is the `landing` setting ([settings.md](settings.md)).

## Rejected

- ⌘\ duplicating the tab (VS Code, Obsidian): breaks one buffer per file.
- A custom pointer-event drag: three times the code, and fights the pane's focus capture.
- A drag-state atom beside the native events: two sources of truth, stale on a missed `dragend`.
- A clipping window with one `+N`: cannot say which way a tab went, and nothing scrolled.
- Showing landing strips on pickup: a reorder never leaves the strip, so every nudge flashed them.
- Undraggable singletons: an undraggable tab among draggable ones reads as a bug.

## Code

- `apps/desktop/src/renderer/src/state/panes.ts`: workspace, tabs, moves, `dropZones`
- `apps/desktop/src/renderer/src/components/TabStrip.tsx`, `PaneView.tsx`, `Shell.tsx`
- `apps/desktop/src/renderer/src/lib/tab-drop.ts`, `tab-reorder.ts`, `tab-overflow.ts`
- `apps/desktop/src/renderer/src/features/vault/VaultPicker.tsx`
- `apps/desktop/src/main/menu.ts`: ⌘W and ⌘⇧W
