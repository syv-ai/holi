# Tabs and split view

One tab strip, in the title band, holds every tab, after Arc's. A tab holds any view: a document,
a vault app, the board, a New tab, the Agents home, an agent session, Mail or Calendar, or
Settings. A **split view** is one entry of that strip holding two to four views side by side:
selecting it shows them together, selecting any other tab shows that one alone at full width, the
split staying in the strip as its own entry.

## How it works

**A tab is a typed descriptor** (`state/tab-descriptor.ts`): `doc {path}`, `vault-app {path}`,
`board`, `new {n}`, `agents-home`, `session {owner, id}`, `app {id}` or `settings`. The shell
keeps it as one stable string key, so tab lists are plain arrays and a key can sit in a DOM
attribute. A document's key is its vault path as it is, so a path is its own tab id across the
tree, the shell and an open request; a vault app is its bundle's path (the `.app` suffix says
which). Every other view is `holi:<kind>` with its parts: `holi:board`, `holi:new:3`,
`holi:agents`, `holi:settings`, `holi:app:mail`, `holi:session:<owner>:<id>` (the id may hold
colons). A document whose path would read as one of those (it starts with `holi:`, or ends in
`.app`) is `holi:doc:<path>`, so every descriptor survives the trip. Settings is one tab, ever: its
section is the nav's own state (`settingsSectionAtom`).

**The workspace** (`state/shell-workspace.ts`) is pure functions over `{entries, active, closed,
seq}`. An entry is a single view (its tab key) or a split `{id, views, shares, focused}`: two or
three keys, each member's share of the width, and the focused member. A split's id is
`holi:split:<n>`, a `holi:` key no tab kind parses, so it never meets a tab key; `active` is a
tab's key or a split's id. `state/shell-tabs.ts` keeps one workspace per vault, in memory:
switching vaults shows that vault's tabs and coming back finds them. A plugin opens a tab through
`openTabAtom` (`@/plugin-api`) with a descriptor, and `{beside: true}` makes a split of the active
tab and it, or adds it to the active split.

**The view in front** is the active tab, or the active split's focused member. It is what the
sidebar marks, what Settings' nav and an app's folded sidebar follow, what `useSessionTabs` writes
back as the Agents selection, and what ⌘W closes.

**What each tab shows** is one switch, `TabView`: the New tab's empty view (also an empty strip's),
the board, Settings (its nav in the sidebar while it is the view in front and the sidebar is open,
inline otherwise), a sidebar app's view, the Agents mode's `main` for a session or the home, the
`app` surface for a vault app, and the document editor for a document. Only the active entry's
views are mounted.

**Sessions are tabs** ([sidebar](sidebar.md)): the Agents mode's selection opens or selects a
session tab, and the view in front writes the selection back, so inside a split the selection
follows the focused member. A tab's title, mark and state dot come from the mode's `tabLook`.

**Apps are tabs.** Mail and Calendar open as tabs and keep their own behaviour: while one is the
view in front the files sidebar folds to its rail, and leaving it gives the sidebar back as it was.
`foldSidebarForApps` (Settings, Appearance; on, machine-local) turns the fold off.

## The strip

The strip (`features/shell/tab-strip.tsx`) rides in the title band always, split or not. A tab is a 224px
pill: its mark, its title, × on hover. A split is one wider pill holding each member's mark and
title side by side, a hairline between them, truncating evenly; with the split active the focused
member's title has the full weight and the others are muted. Clicking the pill selects the split;
clicking a member inside it selects the split focused on that member. + opens a New tab (⌘T), or
while the sidebar is on Agents starts a session in the default agent, in a tab of its own.

**A tab says its state** in a badge at its end, which gives way to × on hover: a session's
Working (a spinner, still under reduced motion), Needs you, or Done (not opened yet), and a
document's **Updated** when its text changed while another tab was in front, until it is looked
at (`state/doc-changes.ts`). The file's time is only the cue to read it: leaving a document
writes its pending edits and the commit's tidy rewrites it seconds later, so the text is compared,
both sides tidied, against what the view last showed. A tab not shown since it opened compares
against the file as first read. A split's members have no room for a badge, so each shows its
state as a dot on its mark.

Entries drag along the strip to reorder (a hairline marks where it would land). A tab's
right-click menu: **Open in split view**, Close, Close others, Close tabs to the right, Reopen
closed tab. A split's: **Separate**, then the same closes. The strip's ⋯ holds Split view,
Separate (with a split active), Reopen closed tab and Close all tabs.

**Opening.** A view already open is selected where it is: its tab, or its split with it focused.
Otherwise:

- from a New tab it takes that tab's place, as in a browser, whether the New tab is a tab or a
  split's focused member (so ⌘\ on a split, then a click in the sidebar, makes a third side), and
  a session started from the Agents home takes the home's place;
- else it opens as a tab after the active entry. A plain open never changes a split: a click in
  the sidebar while one is up opening into it swapped out half of what you were looking at.
  Joining a split is its own gesture: ⌥-click, Open in split view (a tab's menu, or a file
  row's in the tree), ⌘\, or a drop on a member's edge.

**Closing.** Closing the active tab hands over to the entry after it, else the one before. Closing
a split member takes it out of the split, and a 2-split turns back into a tab of the one left.
Closing a split's pill closes all its members; Reopen closed tab (⇧⌘T, the last closed first,
skipping New tabs) brings a closed split back as the split it was, with its widths, less any view
open elsewhere by then. Closing a tab of a running session only detaches: the session runs on.

## Split view

**Making one.** ⌥-click (or ⌥↩) anything that opens a tab, a document in the files tree, a
session in the Agents sidebar, a search result, a link, and it opens beside what is in front
instead of in its place (`state/alt-open.ts`: a capture listener notes whether ⌥ was held, and
the open asks within the same moment). ⌘\ on a tab makes a split of that tab and a New tab on its right, focused (on a
split with room, a New tab joins it). A tab's **Open in split view** makes a split of the active
tab and that tab, whose own entry goes. Dragging a strip tab, or a row of the sidebar, onto the content
opens a gap where it would land and drops it there (Drag targets, below); dropping it in a member's
middle replaces that member, which gets a tab of its own. The tab in front dropped on its own left or right half splits
there with its neighbour in the strip (the one before it, else after it), or with a New tab when it
is the only tab. Inside one split, a member dragged from the pill onto another swaps the two, or on
an edge reorders them. A split holds four views at most: at four, the edges replace instead of
splitting. A view is open once: putting it into a split takes it out of its tab
or its other split, as two editors on one document would race two autosaves.

**Leaving one.** Right-clicking a member's part of the split's pill offers **Move out of split**
(it becomes its own tab, after the split), **Replace with New tab** (a New tab in its place, the
old view keeping a tab) and Close. Dragging a member's part of the pill along the strip moves it
out there. **Separate** (⇧⌘\, or the
pill's menu) turns every member back into its own tab, in place.

**The look.** No cards and no ground change: the members sit edge to edge, square, on `main`'s own
background and glass tint, exactly as a single tab. Between two members is a 1px `bg-border` line,
full height, which is the resize handle: it reaches 4px either side for the pointer, shows a
`col-resize` cursor, and turns `bg-ring` on hover, keyboard focus and while dragging
(`transition-colors`). **A member has no header of its own**: a document's, a session's or the
board's own top row is its header, and a second bar above it read as two headers that disagreed.
The pill in the strip names the members, and its menu moves and closes them. **The focused member**
(where an open lands) has a 1px `bg-ring` line along its top edge, and its part of the pill is at
the foreground's full weight, the others' muted. Clicking or focusing anywhere in a member focuses
it.

**Keys.** ⌘\ split view, ⇧⌘\ separate, ⌃⌥→ / ⌃⌥← focus the next or previous member, ⌘W closes the
focused member inside a split and the tab otherwise ([keyboard shortcuts](keyboard-shortcuts.md)).
Next/previous tab and ⌘1–9 go over strip entries, a split counting as one.

**motion-panels** (MIT, Valerii Strilets; `components/ui/motion-panels.tsx` is its shadcn item)
lays the views out in `features/shell/split-view.tsx`. Its group holds one panel that fills and sized panels around
it, so the layout follows the count: one view fills; two are filling then sized;
three are sized, filling, sized; four are sized, filling, sized, sized. A sized member is a percentage of the area and follows a
window resize; drag, the arrow keys (Shift for bigger steps), Home and End resize it, and a double
click resets it. The separator is the library's, `role="separator"` with `aria-orientation` and a
"Resize view" label.

**A view never remounts when the layout changes.** Each view renders through a portal into a host
element of its own, keyed on its tab key, and whichever slot holds it adopts the host: a tab made
into a split, or a split closed back into a tab, keeps its composer or its document. A move does
reset scroll positions inside it (the DOM node is re-parented).

**Opening and closing fold**, within one split, by motion-panels' own collapse: a member arriving
in a sized slot mounts folded and opens; one leaving a sized slot stays as an empty ghost while it
folds. The filling slot cannot fold, so a member arriving or leaving there lands at once. Selecting
another entry is not a fold: its views just land. The library folds instantly under reduced motion,
inside `MotionConfig reducedMotion="user"`.

**Drag targets: the views make room.** A strip tab, a member's part of a pill, or a sidebar row
drags (native drag, its own MIME type `application/x-holi-tab`, so nothing else takes it). While
one is dragged, one transparent catcher lies over the whole content (a view may be an iframe or a
terminal, which would swallow the drag), and the views shrink to open a gap where the dragged
view would land, its mark and title in it on `bg-muted/40` inside a dashed hairline. Where the
pointer is decides (`slotAt` in `use-tab-drag.ts`), against the members' edges as the drag found
them, so the zones never move under the pointer while the views resize:

- **one view**: its left half opens the gap on the left, its right half on the right; there is no
  middle, as a single view's middle would take nothing;
- **two or three**: each member's outer thirds open the gap at that edge (the gap between two
  members is both neighbours' facing thirds), its middle third **replaces** it: the member is
  covered by the dragged view's label, lit by a ring, and nothing slides;
- **four** (full): every member is a replace target, whole; nothing slides.

The gap is the share the newcomer gets, `1 / (count + 1)`, at the place the drop puts it
(`insertIntoActive`); every member shrinks to `count / (count + 1)` of its width, into exactly the
span the drop gives it, so nothing leaves the screen and nothing jumps on drop. It is a real resize
(`left` and `width`, the house curve, 200ms; the panels let their members out for the drag, as the
library clips): a view reflows, which is what shows where it will sit. A view is laid out again
only when the slot under the pointer changes, as dragover sets state only then. Moving across moves
the gap there; leaving the content or cancelling gives every view its width back. The drop lands the layout at once, on a panel group
mounted afresh (the views keep their hosts), and the widths it placed are not reseeded from the
remembered ones. Under reduced motion the gap simply appears.

The tab in front dragged onto its own view opens the gap on that side and shows its strip
neighbour filling the rest, which is where it splits. A member dragged inside its own split moves:
a line marks where it would go, its own place dimmed, and its middle third swaps it with another.
A view dragged from the sidebar (a document, a vault app or the Board from the files sidebar, a
session or a Holi from the Agents sidebar) opens in that place, or moves there when it is open
already; dropped on the strip it opens as a tab at that place. A file row keeps its own drag into
folders: the tab's type joins the tree's data in the same dragstart. A drop that would change
nothing is refused. The menus and ⌥-click are the keyboard's way to the same places.

**Persistence.** Tabs and splits live for the app's session, per vault; a restart opens on an
empty strip, as the shell always has. The widths a vault last had for a two-, three- and four-member
split are kept on this machine (`localStorage`, `holi.panes.<remote>.<count>`), and a new split
opens at them.

## The arcade

After MonoCode's grid arcade (MIT, see `composites/arcade/LICENSE`). Behind
the fresh shell's empty view (`features/shell/new-tab-view.tsx`, a New tab) lies a dot grid where the vault's
Holis play Paper run by themselves: papers (documents and tasks) land on the board, each Holi
picks them up into a stack that trails behind it and files them in the outbox, saying so in a
speech bubble in its own voice, and merge conflicts wander about and scatter a stack they touch.
The cast is the vault's Holis by persona and colour, which the holis plugin contributes through
the `arcadeCast` plugin slot; with none (or the plugin off) a default cast plays. Content wins: idle, the
board melts into the pane (dimmed, slightly blurred, holding only the pane's top two-fifths and
fading out at their foot as the files sidebar's rows do, so the content below is never on the game,
and masked away at the sides),
takes no pointer, dims to a whisper under the logo (anything marked `data-arcade-keepout`) and puts
nothing there, and is gone below a 48rem pane, before the logo goes. MonoCode's take-control pill
(`Take control · Paper run`) sits in the band under the content, never over a row, and shows
while the pointer is on the board's free ground or on keyboard focus. Taking control hands the
first Holi to the arrow keys or WASD, and the board covers the pane (the sidebar and title stay)
at full brightness, with a thin HUD along its top: the score, the speed and Release (Esc); the
content goes `inert`. A bigger stack filed at once scores more (1 + 2 + … + n). Only Escape or
Release ends a game, and focus goes back to the pill. It never moves on its own under reduced
motion, and its loop parks while the view is hidden or off screen. `gridArcade` (Settings,
Appearance; machine-local, on by default) turns it off.

**The scoreboard.** A run that ends on a new personal best at its speed is committed to
`.holi/arcade/scores/<login>.json`, so the team plays against each other. Each player has a file of
their own, written only by their machines, so two records set at once never conflict and never
pause sync; an ordinary run writes nothing. A run counts at the slowest speed it was played at, so
switching to Fast for the finish is no Fast run. While playing, the board beside the game shows the
top five at that speed, the player's own row marked and their place under the cut, with the run in
play ranked live. Sign-in and adding a vault run the same board as background only
(`ScreenArcade`): no vault, no scoreboard.

## Rules

- A view is open once: as a tab, or as one member of one split. Every opener selects it where it
  is; putting it into a split takes it out of where it was.
- A split is one strip entry. Selecting any other entry shows that view alone; the split stays.
- A plain open beside an active split is a new tab after it; only a New tab member is filled.
- Every workspace function returns the same workspace for a no-op, so a caller can tell. A drop
  target asks `dropTab` (or the strip `dropOnStrip`) whether a drop would change anything before
  it takes one.
- A view's content renders through its own host, never as a child of a layout slot, or a layout
  change remounts it.
- `useSessionTabs` remembers the selection it last wrote, so its own writes never open a tab.
- Only the active entry's views are mounted, so a document or code file switched back to opens
  where it was left: its caret and scroll are kept per vault and path as they move
  (`state/view-memory.ts`), for the app's lifetime and never on disk. A Holi link to a heading
  lands on the heading instead.

## Rejected

- Each pane owning its own tab list (the earlier shell): splitting made the window panes, and every
  other tab disappeared into one of them.
- Duplicating a tab on split (VS Code, Obsidian): breaks one editor per document.
- Opening from the tree as a new entry while a split is active: Arc keeps a link followed in a
  split member in that member, and a new entry would hide the split the user is working in.
- Sliding the views apart with transforms for the preview: a single view slid half off the screen
  before the drop shrank it; the views resize instead.
- Cards on a darker ground for the members: the platform is square and flat, and a hairline parts
  two views well enough.
- A ring around the focused member: without cards it reads as a selection box; a hairline on
  its top edge says it quietly.
- A header bar on each member (breadcrumb, ⋯, ×): it stacked on the view's own header, two rows
  saying the same thing in different type.
- A placeholder panel in the motion-panels group while dragging, so the views resize for real:
  the panels are keyed by role, so a count change moves views between panels, re-parenting an
  editor or a terminal on every change of slot, and the library animates every size change.
  Transforms on the members open the same gap without laying anything out.
- Nesting motion-panels groups for any number of members: closing a middle one would fold every
  member after it.

## Code

- `apps/desktop/src/renderer/src/state/tab-descriptor.ts`, `shell-workspace.ts`, `shell-tabs.ts`,
  `alt-open.ts`
- `apps/desktop/src/renderer/src/features/shell/`: `app-shell.tsx` (ReUI's `app-shell-21`),
  `tab-strip.tsx`, `split-view.tsx`, `use-tab-drag.ts`, `tab-view.tsx`, `tab-look.tsx`,
  `use-shell-shortcuts.ts`, `new-tab-view.tsx`; `hooks/use-session-tabs.ts`
- `apps/desktop/src/renderer/src/components/ui/motion-panels.tsx`
- `apps/desktop/src/main/menu.ts`: ⌘W and ⌘⇧W
- `state/panes.ts` and `state/surfaces.ts` are the earlier shell's workspace and are only half retired: the fresh shell does not render `state/panes.ts`, so `openNoteTabAtom` (re-exported by `@/plugin-api`) and the plugin-facing `surfaceTabIdsAtom` open or list nothing on screen, while `state/surfaces.ts` now also calls `openTabAtom`. Which of them a plugin may rely on is a product question in [findings](../refactor/findings.md).
