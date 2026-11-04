# Graph

The vault as a picture: every note a dot, every [wiki-link](wiki-links.md) between two notes a line. Main builds it, and the Graph tab (`holi:graph`, from the command menu) draws it.

## How it works

**Built per ask, in main.** `notes.graph` walks the vault's markdown once (the same walk as the backref scans) and answers with the notes, sorted, and each linked pair once, whichever way it links (`buildLinkGraph`). A link to a note that does not exist, to an asset or to itself draws nothing. Hidden files are in it only while the tree shows them; [memory](agent-memory.md) is always in it, without `.holi/memory/index.md`, which links every memory and would only draw a hub.

**The tab.** Laid out once with d3-force run to rest in a worker, each note's last position seeding the next layout, so a new link moves the picture a little rather than reshuffling it. It asks again a beat after the vault's notes last changed, and an answer that changed no link changes no layout. A note is a dot sized by its links, coloured by kind (a note, a task, a memory) in token classes, with a legend. A dot opens its note beside the graph, in a split; the note open there is drawn in the theme colour, and hovering or focusing a dot lights it and its neighbours. Each dot is a link in the tab order. A scroll pans, a pinch or ⌘-scroll zooms, and a drag on the background pans. While it reads it shows a skeleton, a vault with no notes says how to link two, and a failed read or layout says so with Retry.

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
- `apps/desktop/src/renderer/src/features/graph/graph-view.tsx`: the tab
- `apps/desktop/src/renderer/src/lib/graph-layout.ts`, `graph-layout.worker.ts`: the layout
