# Tabs and panes

The main area is one to three panes side by side, each with its own tabs and active tab, as an
editor does it. A tab holds any view: a document, a vault app, the board, a New tab, the Agents
home, an agent session, Mail or Calendar, or Settings. One pane is focused: it is where "open"
lands and what the tab keys act on.

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

**The workspace** (`state/shell-workspace.ts`) is pure functions over `{panes, focused, closed,
seq}`, each pane `{id, tabs, active, share}`. `state/shell-tabs.ts` keeps one per vault, in
memory: switching vaults shows that vault's tabs and coming back finds them. A plugin opens a tab
through `openTabAtom` (`@/plugin-api`) with a descriptor, and `{beside: true}` puts it in the
pane next to the focused one, a new pane while there is room.

**What each tab shows** is one switch, `TabView`, rendered per pane for its active tab: the New
tab's empty view (also an empty pane's), the board, Settings (its nav in the sidebar while it is
the focused tab and the sidebar is open, inline otherwise), a sidebar app's view, the Agents
mode's `main` for a session or the home, the `app` surface for a vault app, and the document
editor for a document. Only the active tab of a pane is mounted.

**Sessions are tabs** ([sidebar](sidebar.md)): the Agents mode's selection opens or focuses a
session tab, and the focused tab writes the selection back. A tab's title, mark and state dot come
from the mode's `tabLook`.

**Apps are tabs.** Mail and Calendar open as tabs and keep their own behaviour: while one is the
focused tab the files sidebar folds to its rail, and leaving it for any other tab gives the
sidebar back as it was.

**Opening.** An opened tab goes after the focused pane's active tab; one already open anywhere is
focused where it is (a tab is open once, in one pane). From a New tab, what is opened takes its
place, as in a browser, and a session started from the Agents home takes the home's place. + opens
a New tab, or the Agents home while the sidebar is on Agents.

**Closing.** Closing the active tab hands focus to the next tab, else the one before. Close
others, Close all (the pane's), and Reopen closed tab (⇧⌘T, the last closed first, skipping New
tabs) work for every kind. A split pane goes with its last tab; the last pane stays, empty, and
shows the New tab's view. Closing a tab of a running session only detaches: the session runs on.

**Panes.** Split right (⌘\\, a pane's ⋯ menu, or a tab's right-click menu) opens a pane after the
focused one with half its width and focuses it. From a tab's menu the tab moves into it, unless it
is its pane's only tab, when the new pane opens on a New tab. A split never copies a tab: two
editors on one document would race two autosaves. A tab's menu moves it to the pane on its left or
right, focusing it there; a pane left empty closes. Focus follows a press or keyboard focus into a
pane, and every tab key acts on the focused pane. Three panes at most.

**The strips.** With one pane its strip rides in the title band, as it always did. With several,
each pane's card carries its own header (below), and the band is left to drag the window: a strip
that jumped into the band whenever its pane took focus would move under the pointer. The focused
pane's active tab has the strip's full weight; an unfocused pane's is lighter. A session tab shows
its state as a dot on its mark: working (pulsing, still under reduced motion), needs you, or done
and not opened yet.

**Split view** (after Arc's). One pane keeps the plain look, its view filling the area. With two or
three, the area becomes the window's ground and each pane a card on it: `rounded-xl`, a hairline
border, 8px around and between the cards, and the focused card ringed (`ring-ring/40`). Clicking
anywhere in a card focuses it. A card that arrives fades in from 0.98 as its panel unfolds
(`duration-200`, the house curve; a fade only under reduced motion). The separators are the gaps:
nothing shows until the pointer or keyboard focus finds one, then a short pill, brighter while
dragging.

**A card's header** (`pane-header.tsx`, 40px) holds, left to right: the pane's own tabs as compact
marks (each named by its title, its tooltip, and its right-click menu; a middle click closes), +
for a New tab, a breadcrumb of where the active tab is (a document's or vault app's folders muted,
past two folded to an ellipsis, then its name; any other tab its title: the session's, Board, the
app's), then ⋯ (Split right, Move tab to the left or right pane, Close other tabs, Reopen closed
tab) and × (Close pane: its tabs close and go to Reopen closed tab, as any closed tab does). The
header carries no actions of the view's own yet: there is no seam for a view to offer them.

**Into split view.** ⌘\ and Split right; a tab's right-click menu's **Open in split view**, which
moves the tab to the pane on its right, else into a new pane there while there is room, else to the
pane on its left (a pane's only tab leaves a New tab behind, so the split has two sides); and
dragging a tab. A tab drags (native drag, its own MIME type `application/x-holi-tab`, so nothing
else takes it) from either strip onto any pane: while it is dragged every pane lays a target over
its view (a view may be an iframe or a terminal, which would swallow the drag), and highlights
where the tab would land. The outer thirds of a pane are its edges, where the tab opens a pane of
its own on that side, taking half that pane's width; the middle third moves it into that pane. On
its own pane each half is an edge, and at three panes every drop moves. A drop that would change
nothing (a pane's only tab beside itself) is refused. The menu items are the keyboard's way to the
same places. Opening a document to the side from the files tree is `openTabAtom` with
`{ beside: true }`; the tree's menu does not offer it yet.

**motion-panels** (MIT, Valerii Strilets; `components/ui/motion-panels.tsx` is its shadcn item)
lays the panes out in `panes-view.tsx`. Its group holds one panel that fills and at most one sized
panel each side of it, so the layout follows the count: one pane fills; two are filling then sized;
three are sized, filling, sized. A sized pane is a percentage of the area and follows a window
resize; drag, the arrow keys (Shift for bigger steps), Home and End resize it, and a double click
resets it. Its separators are the library's, drawn as the gaps between cards (above),
`role="separator"` with `aria-orientation` and a "Resize pane" label.

**A pane's content never remounts when the layout changes.** Each pane renders through a portal
into a host element of its own, and whichever slot holds the pane now adopts the host, so a
composer or a document keeps its state while panes come and go beside it. A move does reset
scroll positions inside it (the DOM node is re-parented).

**Opening and closing fold**, by motion-panels' own collapse: a pane arriving in a sized slot
mounts folded and opens; one leaving a sized slot stays as an empty ghost while it folds. The
filling slot cannot fold, so a pane arriving or leaving there lands at once. The library folds
instantly under reduced motion, inside `MotionConfig reducedMotion="user"`.

**Glass.** One pane paints no ground of its own: it is `main`, tinted by the vault's Transparency
(`--glass-view`). In split view `main` takes the chrome's tint (`--glass-chrome`, the sidebar's
colour), so the ground reads as one surface with the sidebar and the band, and each card the view's
(`index.css`, Glass).

**Persistence.** Tabs and panes live for the app's session, per vault; a restart opens on an empty
pane, as the shell always has. The pane widths a vault last had for two and for three panes are
kept on this machine (`localStorage`, `holi.panes.<remote>.<count>`), so splitting again opens at
them.

**The arcade** (after MonoCode's grid arcade, MIT, see `components/monocode/arcade/LICENSE`). Behind
the fresh shell's empty view (`empty-view.tsx`, a New tab) lies a dot grid where the vault's
Holis play Paper run by themselves: papers (documents and tasks) land on the board, each Holi
picks them up into a stack that trails behind it and files them in the outbox, saying so in a
speech bubble in its own voice, and merge conflicts wander about and scatter a stack they touch.
The cast is the vault's Holis by persona and colour, which the holis plugin contributes through
the `arcadeCast` plugin slot; with none (or the plugin off) a default cast plays. Content wins: idle, the
board melts into the pane (dimmed, slightly blurred, masked away toward the foot and the sides),
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

## Rules

- A tab is open once, in one pane. Every opener focuses it where it is.
- A split never copies the current tab; a move takes it out of its old pane.
- The active tab follows the document, not the index, when a tab closes or moves.
- Every workspace function returns the same workspace for a no-op, so a caller can tell. A drop
  target asks `dropTab` whether a drop would change anything before it takes one.
- A pane's content renders through its own host, never as a child of a layout slot, or a layout
  change remounts it.
- `useSessionTabs` remembers the selection it last wrote, so its own writes never open a tab.

## Rejected

- Duplicating a tab on split (VS Code, Obsidian): breaks one editor per document.
- Every pane's strip in the title band, laid out to the panes' widths: the band would follow every
  frame of a drag and a fold.
- The focused pane's strip in the band and the others in their panes: a strip moving under the
  pointer whenever focus changes.
- Nesting motion-panels groups for any number of panes: closing a middle pane would fold every
  pane after it.
- A card around a single pane: a frame around the only thing on screen says nothing, and costs the
  width of its margin.
- The card's header repeating each tab's title in the strip: the breadcrumb already names the
  active one, and titled tabs would leave it no room in a third of the window.

## Code

- `apps/desktop/src/renderer/src/state/tab-descriptor.ts`, `shell-workspace.ts`, `shell-tabs.ts`
- `apps/desktop/src/renderer/src/components/blocks/app-shell-21/components/app-shell.tsx`,
  `panes-view.tsx`, `pane-header.tsx`, `use-tab-drag.ts`, `tab-view.tsx`, `tab-look.tsx`,
  `site-header.tsx`, `use-session-tabs.ts`
- `apps/desktop/src/renderer/src/components/ui/motion-panels.tsx`
- `apps/desktop/src/main/menu.ts`: ⌘W and ⌘⇧W
- `state/panes.ts` and `state/surfaces.ts` are the earlier shell's workspace; the fresh shell does
  not render them, so their atoms (`openNoteTabAtom`, `openSurfaceAtom`) open nothing on screen.
