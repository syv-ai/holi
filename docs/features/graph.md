# Graph

The vault as a picture: every note a dot, every [wiki-link](wiki-links.md) between two notes a line. It is a tab, opened from the nav menu, the command palette, or the links drawer's header.

## How it works

**Built per ask, in main.** `notes.graph` walks the vault's markdown once (the same walk as the backref scans) and answers with the notes, sorted, and each linked pair once, whichever way it links (`buildLinkGraph`). A link to a note that does not exist, to an asset or to itself draws nothing. Hidden files are in it only while the tree shows them; [memory](agent-memory.md) is always in it, without `.holi/memory/index.md`, which links every memory and would only draw a hub.

**Laid out once, still.** The tab lays the graph out with d3-force run to rest in one go, in a worker (`lib/graph-layout.ts`, `graph-layout.worker.ts`), so nothing settles on screen and the window never freezes while it runs. Each note's last position seeds the next layout, so a new note or link moves the picture a little rather than reshuffling it. The view fits the graph on first draw; after that it is the reader's: a scroll pans, a pinch or ⌘-scroll zooms round the pointer, a drag on the background pans.

**Following the vault.** While the tab is showing it asks again 800ms after the last snapshot push, so a burst of autosaves is one rebuild, and a push that changed no link changes no layout.

**Reading it.** A note is a dot sized by its links, coloured as a note, a task or a memory (`fill-*` token classes, so the theme and light or dark mode apply). The note being read (the focused pane's, else the one open beside the graph) is drawn larger in the theme colour. Hovering a dot lights it, its neighbours and their lines, and names them; zoomed in far enough, every note is named. A dot opens its note beside the graph, as a board card does.

## Rules

- No link index, here as everywhere: the graph is held by the tab that asked for it and nobody else.
- At most 1,500 notes are drawn (`GRAPH_NODE_CAP`). Past that the best-linked are kept, since an orphan says the least, and the corner says how many of how many.
- The layout runs in a worker: at the cap it takes over a second, which on the page would freeze the window. The previous picture stays up until the new one is ready. Nothing animates: a graph settling on screen is none of the four motions the [UI system](../ui-system.md) allows.

## Rejected

- A heavy graph framework (Cytoscape, sigma, react-force-graph): `d3-force` is the layout alone, small and dependency-light, and the drawing is plain SVG with token classes.
- Canvas: its colours would have to be read out of the CSS and redrawn on a theme change, where SVG takes `fill-primary` as it is. At the cap, SVG is fast enough.
- A persisted graph or link index: a second copy of the truth that goes stale.
- A live, settling simulation: motion without a purpose, and a picture that will not hold still.

## Code

- `apps/desktop/src/main/vault/backrefs.ts`: `buildLinkGraph`, `GRAPH_NODE_CAP`
- `apps/desktop/src/main/router.ts`: `notes.graph`
- `apps/desktop/src/renderer/src/lib/graph-layout.ts`, `graph-layout.worker.ts`: the layout
- `apps/desktop/src/renderer/src/features/graph/GraphView.tsx`: the tab
- `apps/desktop/src/renderer/src/components/core-surfaces.tsx`: the `graph` surface and its nav item
