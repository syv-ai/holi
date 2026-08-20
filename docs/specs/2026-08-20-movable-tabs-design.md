# Movable tabs — D78

**Status:** designed and **built** 2026-08-20. Plan: `docs/plans/2026-08-20-movable-tabs.md`;
verified by hand in `docs/verification/2026-08-20-movable-tabs.md`. Two clauses changed during the
build and are marked inline: what a same-pane reorder does to the active tab, and how narrow the
sole-tab no-op is. A third — a pane refusing to offer a no-op drop — was added after review.
**Builds on:** D77 (the pane system — `splitPane`, `closePane`, `openInNewPane`, and the
strengthening of one-buffer-per-file to span the whole workspace), and the tab strip's
clipping window (`lib/tab-window.ts`, same day).
**Prior art in this repo:** `features/tasks/BoardView.tsx` — native HTML5 drag with the
dragged identity riding `dataTransfer` and the *decision* factored out as a pure function
(`dropIntent`, `state/tasks.ts`). This follows that shape exactly.

---

## 1. The gap

A tab lands where it was opened and stays there forever. The strip's order is the user's
history of opening files, which is not the order they want to read them in, and a split pane
can only be filled by opening something *into* it — never by moving something you already
have open.

Both halves of that are one gesture in every editor people arrive from, and neither exists.

## 2. What a drag can do

Three things, and no more:

1. **Reorder** — drag a tab within its own strip.
2. **Move** — drag it onto another pane's strip, or onto that pane's body.
3. **Split** — drag it onto the left or right quarter of a pane's body, making a new column
   there with the tab in it.

Explicitly **not** in scope, so that the absence is a decision rather than an oversight:
dragging a tab out to a new window; dragging between vaults; and any vertical split — the
pane model has one axis (`ResizablePanelGroup orientation="horizontal"`) and this does not
add another.

## 3. The rules, and where each one comes from

Almost nothing here is new. The move inherits rules the pane system already enforces:

- **A move is never a copy.** Remove-then-insert, so one-buffer-per-file survives by
  construction. This is why a drag can do what a split deliberately cannot (D77: a split
  makes an *empty* pane rather than duplicating the tab it was invoked on) — the buffer is
  relocated, not cloned.
- **The active tab follows the document, not the index** — `closeTab`'s rule, applied to
  both panes.
- **A reorder rearranges; it does not navigate.** Within one pane the active tab is left on
  whatever document it was on, so tidying a full strip while reading one file cannot drop you
  into whichever tab you happened to drag. A cross-pane move is different in kind: the
  destination shows what you dropped into it and the workspace focuses that pane, because
  that is where you are now looking. *(Discovered while writing the tests — the first draft
  of this spec said the moved tab is active in its destination, full stop, which for a
  reorder is the lose-your-place bug the rule above exists to prevent.)*
- **An emptied source pane goes, unless it is the last one** — `closeTab`'s rule again. This
  is the difference between "I unsplit by dragging my last tab away" and a permanent empty
  column that only a second, separate gesture could remove.
- **A tab that cannot be found leaves the workspace untouched.** The payload is a string
  that crossed a `DataTransfer`; it is validated, never trusted.

Three rules *are* new, and each one was a live question:

- **A drag pins a preview tab.** Dragging is intent, the way editing is (`pinActive`).
  Without this the gesture eats itself: place a preview tab deliberately at position 3, then
  single-click any file in the tree, and `openPreview` replaces it *in place* — the tab you
  just positioned is gone. That is precisely the shuffle-under-the-user failure that
  `openSingleton`'s focus-in-place rule exists to prevent.
- **The singletons are no longer fixed leftmost.** `openSingleton` inserts board/agenda/mail
  at the front and, if already open, focuses them **in place** — so dragging one to position
  4 breaks nothing: re-clicking the nav chip focuses it where it now sits rather than
  yanking it back. What changes is a sentence: *leftmost* becomes where a singleton **opens**,
  not where it lives. An undraggable tab in a strip of draggable ones reads as a bug, and
  the alternative was a rule discoverable only by the gesture failing.
- **A sole tab dropped on its own pane's edge is a no-op** — and only then. Removing the
  column and rebuilding an identical one one position over is a flicker, not a move. The
  narrowness matters: that same sole tab dropped on a *different* pane's edge is a perfectly
  ordinary move, and it does collapse the pane it came from.
- **A pane never offers a drop that would do nothing**, and *which* drops those are is a
  question about the whole workspace rather than about any one pane. **An edge shared by two
  panes is one gap**: pane 1's left edge and pane 0's right edge are the same place, so a sole
  tab dragged out of pane 0 has **three** inert edges around it, not two. So the UI does not
  restate the rules — `dropZones` asks `moveTab` and `moveTabToNewPane` themselves, both of
  which return the workspace *by reference* when they would change nothing, and it therefore
  cannot drift from what a drop actually does.

  On top of that, one zone is decided rather than derived:
  - The pane a drag came *from* never offers its **middle**, even where a drop there would move
    something (to the end of its own strip). "Into this pane" is what the strip already
    expresses, and every split gesture drags *across* the body on the way to an edge, so a
    full-pane highlight would flash on all of them. The overlay still exists — it has to, to
    notice the pointer arriving at an edge — but the middle draws no band and does not
    `preventDefault`, so the cursor says "not here".

  Every *other* pane keeps all three: dropping into one is the ordinary "put this over there".
- **The edges are drawn before they are aimed at.** Both landing strips appear the moment a tab
  is picked up — on `dragstart`, anywhere, which bubbles to the window — and light up only when
  the pointer is actually inside one. A target that materialises when you reach it teaches
  nobody the gesture: splitting by drag would be a feature you either already knew about or
  never found. The middle has no waiting state, because it is the whole pane and a full-pane
  wash on every drag is what the rule above exists to stop.

## 4. Shape

Three layers. Only the bottom two have to be *correct*; the top one reads rectangles and
dispatches.

### 4.1 `state/panes.ts` — what a move means

```ts
moveTab(workspace, tab: Tab, dest: { pane: number; index: number }): Workspace
moveTabToNewPane(workspace, tab: Tab, at: number): Workspace
```

**The payload carries identity, not location.** `findTab` already searches every pane, so a
single function covers reorder *and* cross-pane move, and a strip never needs to know where a
dropped tab came from — the same trick `BoardView` uses when it puts a task's path on the
drag and looks its lane and status up at the drop.

`dest.index` is read against the **destination pane's tabs as they are now**, meaning "insert
before whatever is currently at this index"; `tabs.length` means append. The same-pane case
therefore decrements when moving rightward, and a drop onto its own position or the one
immediately after it is a no-op. That decrement is the off-by-one this design most expects to
get wrong, so it is tested from both directions.

`moveTabToNewPane`'s `at` is an insertion index into `panes` (`0..panes.length`), also read
against the array as it is now — so when the source pane collapses beneath it, the shift is
the function's job, not the caller's.

### 4.2 `lib/tab-drop.ts` — where the pointer landed

Pure, numbers in and intent out. This is not tidiness: **jsdom computes no layout** — every
`getBoundingClientRect` is `0×0` (`test/setup.dom.ts` says so at length) — so arithmetic
extracted from the component is the only form of this logic that can be tested at all. It is
the same split `tab-window.ts` made: the clip is a stylesheet's job, the decision is not.

```ts
dropIndex(pills: { index: number; left: number; width: number }[], x: number): number
paneDropZone(rect: { left: number; width: number }, x: number): 'before' | 'into' | 'after'
stripEdge(rect: { left: number; width: number }, x: number): 'left' | 'right' | null
parseTabPayload(s: string): Tab | null
```

- `dropIndex` takes the **visible** pills carrying their **absolute** indices, so it maps back
  through the clipping window the way the render already does (`const i = window_.start +
  offset`). Getting this wrong reorders the wrong tab whenever anything is hidden.
  Dropping in the free space right of the last visible pill means "after that one" —
  `lastVisible + 1`, not "the very end", because there may be hidden tabs beyond it and the
  caret is where the caret is.
- `paneDropZone` uses a quarter of the pane's width, **capped at 120px**. Proportional alone
  is wrong at both ends of the range this app actually runs at: at the 179px-per-pane split
  seen in yesterday's verification a quarter is a usable 45px, but at 1200px it would make
  half the window an edge zone.
- `parseTabPayload` validates rather than casts. It is the trust boundary.

### 4.3 The components

**`TabStrip`** puts `draggable` on the outer `<span>` pill — not the Radix `Tooltip` trigger
and not the `Button` primitive, exactly as `BoardView` puts it on the card `div` — and writes
`application/x-holi-tab` in `onDragStart`. That MIME type doubles as the *"a tab is being
dragged"* predicate during `dragover`, where `getData` is unreadable by spec and only
`dataTransfer.types` is exposed.

- **The caret** is an absolutely-positioned line inside the (now `relative`) host. It must
  not be a spacer: the measure effect writes `setWidths` from inside itself and converges only
  because it writes on a change, so a hover state that altered a measured pill width would
  oscillate. Absolute positioning has zero layout impact and cannot.
- **Auto-slide.** A drop position that is currently clipped is otherwise unreachable, which
  is exactly when rearranging matters most. One local `dragFocus` index is fed to `tabWindow`
  in place of `active`, stepped by one on a ~350ms timer while `stripEdge` reports an edge.
  No new windowing logic is needed: `tabWindow`'s third rule is already *"this index must
  stay visible"*, and `active` is merely its usual caller. `dragFocus` must join the measure
  effect's dependency list, or pills revealed by the slide stay measured at zero and the
  window miscounts from then on.

**`PaneView`** renders a drop overlay **over the content region only, never over the strip**,
and only while a drag is in flight. It is a single event target — the highlight bands inside
it are `pointer-events-none`, so crossing one fires no `dragleave`, which is the papercut that
makes hand-rolled HTML5 drop zones flicker. `into` moves the tab to the end of that pane's
strip; `before` and `after` split.

It learns that a drag started in *its own* strip from a `onDragBegin` callback on `TabStrip`,
which is what the narrowing rule above needs. A callback rather than a second MIME type
carrying the source pane's index: the pane already knows how many tabs it has, so "did this
start here" is the only fact it is missing, and `dragend` on `window` clears it.

**`Shell`** keeps closing over the pane index `i`, so `PaneView` stays as dumb as D77 left it:

```ts
onDropTab={(tab, index) => setWorkspace((w) => moveTab(w, tab, { pane: i, index }))}
onDropEdge={(tab, side) =>
  setWorkspace((w) => moveTabToNewPane(w, tab, side === 'before' ? i : i + 1))
}
```

## 5. Why native HTML5 drag

It is the one DnD precedent in the repo, it needs no companion state to keep in sync, and the
ghost image and escape-to-cancel come free. The two costs are known and handled above: the
unreadable `getData` during `dragover` (solved by the custom MIME type) and the requirement
that every valid target call `preventDefault()` on `dragover` or no drop ever fires.

A custom pointer-event drag would buy smooth auto-slide, live insertion animation and easier
CDP driving (`Input.dispatchMouseEvent` over synthetic `DragEvent`s) — at roughly three times
the code, and it would fight `PaneView`'s `onPointerDownCapture={onFocus}`. Rejected.

A jotai drag-state atom alongside the native events was also rejected: two sources of truth
for one drag, and a `dragend` that fails to fire leaves it stale.

## 6. Testing

**`test/panes.test.ts`** (node project, beside the existing 40). `moveTab`: same-pane
leftward and rightward; drop-onto-self and drop-onto-self+1 as no-ops; cross-pane; active
following the document in the source when a tab left of it left, and in the destination;
source pane emptied → removed, with a destination index above it shifting down; the last pane
never removed even when emptied; a preview note landing pinned; an unknown tab leaving the
workspace identical; and one test asserting the moved tab appears **exactly once** across all
panes — one-buffer-per-file stated as an assertion rather than trusted. `moveTabToNewPane`:
inserting before and after the named pane; the sole-tab-on-its-own-edge no-op; a sole tab
dropped on *another* pane's edge, which collapses the source and therefore shifts `at` down
by one; and focus landing on the new pane.

**`test/tab-drop.test.ts`** (node project — the `test/tab-window.test.ts` pattern; pure
renderer libs are tested there, not co-located). Caret index at each pill's midpoint and
either side of it; the free-space-to-the-right case landing on `lastVisible + 1` while tabs
are hidden beyond; zone boundaries at 179px and at 1200px where the cap bites;
`parseTabPayload` against junk, against valid JSON of the wrong shape, and against each of
the three tab kinds.

**One dom test for `TabStrip`**, with a minimal `DataTransfer` stub — jsdom has neither
`DragEvent` nor layout. It asserts three honest things: the pill is `draggable`, `dragstart`
writes the payload under the right MIME type, and a `drop` dispatches `onDropTab` with the
parsed tab. It does not assert geometry; §4.2 exists so that it does not have to.

**In the running app.** Native drags need real input, so verification goes through synthetic
`DragEvent`s constructed with a real `DataTransfer` over CDP, which exercises the actual
handlers. `Input.dispatchDragEvent` gets wrapped in `apps/desktop/cdp.mjs` only if that falls
short. The dev window reports `visibilityState: 'hidden'` while occluded, which pauses
`requestAnimationFrame` entirely — if that blocks the check the way it blocked yesterday's, it
is recorded as unverified rather than claimed.

## 7. Doc changes this lands

- `docs/decisions.md` — **D78**: a tab moves, a drag pins it, an edge-drop splits, and the
  singletons stop being fixed.
- `docs/prd/notes-editor.md` §Tabs — *"opens as a **leftmost** tab with a fixed home"* becomes
  *opens leftmost*; the one-buffer bullet gains a sentence saying a move is safe where a copy
  is not; and a new §Moving a tab records the caret rule, the auto-slide, the edge-drop, and
  the emptied-source-pane rule.
