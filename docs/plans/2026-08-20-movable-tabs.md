# Movable tabs Implementation Plan

> **For agentic workers:** Use the executing-plans skill to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A tab can be dragged — reordered inside its own strip, moved onto another pane, and dropped on a pane's edge to split.

**Architecture:** Three layers, and only the bottom two have to be correct. `state/panes.ts` gains two pure moves whose payload is the tab's *identity*, so `findTab` locates it and one function serves both reorder and cross-pane move. `lib/tab-drop.ts` turns pointer coordinates into intent — pure, because jsdom computes no layout and arithmetic outside the component is the only testable form. The components read rectangles and dispatch, native-HTML5 style, exactly as `features/tasks/BoardView.tsx` already does.

**Tech Stack:** TypeScript, React, jotai, native HTML5 drag-and-drop, Vitest (`node` project for pure logic, `dom` for component wiring), Electron + CDP for in-app verification.

**Spec:** `docs/specs/2026-08-20-movable-tabs-design.md` — read it first, especially §3 (every rule and where it comes from). **Decisions:** D78, to be written by Task 8; `docs/decisions.md` says next free is D78, re-check before allocating. **Builds on:** D77 (the pane system, and one-buffer-per-file going workspace-wide).

---

## Scope

**In:** `moveTab` and `moveTabToNewPane`; `lib/tab-drop.ts`; draggable pills with an insertion caret; auto-slide of the clipped strip on edge hover; a pane-body drop overlay with `before`/`into`/`after` zones; Shell wiring; D78 and the `notes-editor.md` §Tabs amendments.

**Out, and deliberately:** dragging a tab out to a new window; dragging between vaults; any vertical split (the pane model has one axis); persisting pane layout or tab order across a restart (still an open product question — `notes-editor.md` §Panes).

## File map

- `apps/desktop/src/renderer/src/state/panes.ts` — add `moveTab`, `moveTabToNewPane`. Nothing existing changes.
- `apps/desktop/src/renderer/src/lib/tab-drop.ts` *(new)* — geometry → intent, and the `DataTransfer` codec. Pure; the `lib/tab-window.ts` sibling in every sense.
- `apps/desktop/src/renderer/src/components/TabStrip.tsx` — draggable pills, caret, drop target, auto-slide.
- `apps/desktop/src/renderer/src/components/PaneView.tsx` — the drop overlay over the content region, and two new props passed through.
- `apps/desktop/src/renderer/src/components/Shell.tsx` — wire `onDropTab` / `onDropEdge`, closing over the pane index `i` as every other pane callback already does.
- Tests: `apps/desktop/test/panes.test.ts` (extend the existing 40), `apps/desktop/test/tab-drop.test.ts` *(new)*, `apps/desktop/src/renderer/src/components/__tests__/TabStrip.test.tsx` *(new)*.
- Docs: `docs/decisions.md`, `docs/prd/notes-editor.md`.

**Note on test placement:** pure renderer libs are tested from `apps/desktop/test/*.test.ts` in the **node** project (`test/tab-window.test.ts` is the precedent), *not* co-located. Only `.test.tsx` under `src/renderer/**` runs in the `dom` project. Grep both trees before assuming a test does not exist.

## Contracts

```ts
// state/panes.ts

/**
 * Move a tab to `dest` — the same function for a reorder and a cross-pane move,
 * because `findTab` already spans the workspace and the caller therefore never
 * has to say where the tab came from.
 *
 * `dest.index` is read against the DESTINATION PANE'S TABS AS THEY ARE NOW —
 * "insert before whatever currently sits at this index"; `tabs.length` appends.
 */
export function moveTab(
  workspace: Workspace,
  tab: Tab,
  dest: { pane: number; index: number },
): Workspace

/** Move a tab into a brand-new pane inserted at `at` (an index into `panes`,
 *  `0..panes.length`), read against the array as it is now. */
export function moveTabToNewPane(workspace: Workspace, tab: Tab, at: number): Workspace
```

```ts
// lib/tab-drop.ts

/** The custom MIME type. It is also the "a tab is being dragged" predicate:
 *  `getData` is unreadable during `dragover` by spec, and `types` is not. */
export const TAB_MIME = 'application/x-holi-tab'

export interface PillBox { index: number; left: number; width: number }

/** Absolute insertion index for a pointer at `x`. `pills` are the VISIBLE pills
 *  carrying their ABSOLUTE indices — the strip renders a window, and a caret
 *  computed against rendered offsets reorders the wrong tab. */
export function dropIndex(pills: PillBox[], x: number): number

export type PaneDropZone = 'before' | 'into' | 'after'
export function paneDropZone(rect: { left: number; width: number }, x: number): PaneDropZone

/** Which end of the strip a drag is hovering, for auto-slide. `null` in the middle. */
export function stripEdge(rect: { left: number; width: number }, x: number): 'left' | 'right' | null

export function tabPayload(tab: Tab): string
/** Validates; never casts. This is the trust boundary — the string crossed a DataTransfer. */
export function parseTabPayload(text: string): Tab | null
```

Constants, with the reasoning that fixes each number:

- `EDGE_FRACTION = 0.25`, `EDGE_MAX_PX = 120` — proportional alone is wrong at both ends of the range this app runs at. At the 179px-per-pane split in yesterday's verification a quarter is a usable 45px; at 1200px it would make half the window an edge zone.
- `SLIDE_BAND_PX = 28` — the hover band at each end of the strip that arms auto-slide.
- `SLIDE_MS = 350` — one index per tick. Fast enough to cross a full strip, slow enough to stop on the one you want.

## Gotchas that will bite

- **`pnpm exec` always** — bare `node`/`npx` are broken here. The shell's cwd drifts between tool calls: use absolute paths, and `--project dom` / `--project node` resolve only from `apps/desktop`.
- **Never `pnpm run format` or `prettier --write`** — it corrupts this repo. `printWidth` is 100; wrap by hand.
- **Renderer HMR resets the workspace** (tabs and panes are not persisted) *and* the file tree's expansion state. Re-open what you were looking at after every edit. Main-process edits do not restart the dev app at all.
- **eslint must finish with 0 errors and exactly 2 warnings** (`EditorPane.tsx:240`, `TaskDetail.tsx:348`). A third is yours — most likely `react-hooks/exhaustive-deps` from Task 5's interval.
- Write commit messages to a file and use `git commit -F` — backticks in a `-m` heredoc get eaten.

---

## Task 1: `moveTab`

**Files:** Modify `apps/desktop/src/renderer/src/state/panes.ts` · Test `apps/desktop/test/panes.test.ts`

- [ ] **Step 1: Write the failing tests**

Extend the existing file with a `describe('moveTab')`. The existing `paths()` helper only reads `panes[0]`; you will want a per-pane variant. Cover, one `it` each:

- Same pane, leftward: index 3 → 1 lands before the old 1.
- Same pane, rightward: index 1 → 3 lands **before the old 3**, i.e. at index 2 after removal. This is the off-by-one the whole task turns on — assert the resulting order explicitly, not just the length.
- `dest.index === from` and `dest.index === from + 1` both return the workspace **unchanged** (assert `toBe`, not `toEqual` — referential identity is what lets React bail).
- Cross-pane: the tab leaves pane 0 and appears in pane 1 at the named index.
- The moved tab appears **exactly once across every pane**. This is one-buffer-per-file stated as an assertion rather than trusted.
- Source-pane active follows the *document*: with pane 0 active on index 2, moving index 0 away leaves it still on the same tab (now index 1).
- Moving the tab that was active in the source falls back to its left-hand neighbour (`max(0, from - 1)`).
- The destination's `active` is the moved tab, and `workspace.active` is the destination pane.
- A preview note lands **pinned** — the resulting tab has no `preview` flag.
- Source pane emptied by a cross-pane move → that pane is removed, and a destination index above it shifts down so focus still lands on the right pane.
- The **last** pane is never removed, even when a move empties it (single-pane workspaces can't reach this, so build the case that can).
- A tab that is in no pane leaves the workspace unchanged (`toBe`).

- [ ] **Step 2: Run them and watch them fail**

```bash
cd /Users/nicolaibthomsen/repos/syv/better-holi-final/apps/desktop
pnpm exec vitest run --project node test/panes.test.ts
```
Expected: fails to import — `moveTab` is not exported.

- [ ] **Step 3: Implement `moveTab`**

Contract above. The order of operations that makes the bookkeeping tractable:

1. `const found = findTab(workspace, tab)` — bail (`return workspace`) on `null`, or if `dest.pane` is out of range.
2. **Pin from the stored tab, not the argument.** The payload carries identity only, so read the real tab out of the workspace: a `{kind:'note', preview:true}` becomes `{ kind: 'note', path }` — drop the key rather than setting it false, matching what `pinTabIn` writes.
3. Same-pane no-op check (`found.pane === dest.pane && (dest.index === found.tab || dest.index === found.tab + 1)`) → `return workspace` **by reference**.
4. Capture the source pane's currently-active tab *object* before touching anything; after the removal, re-find it with `indexOf`. That is how "active follows the document" is expressed without index arithmetic. If the active tab *was* the moved one, use `Math.max(0, found.tab - 1)`.
5. Remove, then insert. Same pane: the insertion index decrements when `dest.index > found.tab`. Different panes: no adjustment.
6. If the source pane is now empty and it is not the only pane, drop it — then `dest.pane > source ? dest.pane - 1 : dest.pane` is where focus goes. **Do not route this through `closePane`**: it picks a neighbour to focus, and you know exactly where focus belongs.

- [ ] **Step 4: Run them and watch them pass**

```bash
cd /Users/nicolaibthomsen/repos/syv/better-holi-final/apps/desktop
pnpm exec vitest run --project node test/panes.test.ts
```
Expected: PASS, 40 existing + the new ones.

- [ ] **Step 5: Commit**

Message: `feat(tabs): a tab can be moved, and the move is one function because a tab is one buffer` — the body should say why identity beats location as a payload (`findTab` spans the workspace, so a strip never learns where a tab came from) and why remove-then-insert makes the one-buffer rule structural rather than enforced.

---

## Task 2: `moveTabToNewPane`

**Files:** Modify `apps/desktop/src/renderer/src/state/panes.ts` · Test `apps/desktop/test/panes.test.ts`

- [ ] **Step 1: Write the failing tests**

A `describe('moveTabToNewPane')`. Cover:

- Inserts a new pane at `at` holding just that tab, active, with `workspace.active === at`; once for `at = i` and once for `at = i + 1`.
- **The sole-tab-on-its-own-edge no-op:** a pane with exactly one tab, dropped at `at === src` or `at === src + 1`, returns the workspace **unchanged** (`toBe`).
- **The narrowness of that guard:** the same sole tab dropped on a *different* pane's edge is an ordinary move — the source pane collapses, so the pane count stays the same and `at` shifts down by one when `src < at`. Assert which pane holds what afterwards, and that `workspace.active` points at the new pane.
- A pane with two tabs edge-dropped: source keeps one, pane count goes up by one.
- An unknown tab returns the workspace unchanged (`toBe`).

- [ ] **Step 2: Run them and watch them fail**

```bash
cd /Users/nicolaibthomsen/repos/syv/better-holi-final/apps/desktop
pnpm exec vitest run --project node test/panes.test.ts -t moveTabToNewPane
```
Expected: fails — not exported.

- [ ] **Step 3: Implement it**

1. `findTab`; bail on `null`.
2. `const sole = workspace.panes[src].tabs.length === 1`. If `sole && (at === src || at === src + 1)` → `return workspace` by reference. That is the whole flicker guard, and it must be exactly this narrow.
3. Pin a preview the same way Task 1 does (factor the one-liner out; both functions want it).
4. Remove the tab from `src`. If that emptied `src`, remove the pane **unconditionally** — unlike `closeTab`, a pane is being inserted in the same operation, so the "last pane never goes" rule would leave an empty column beside the new one rather than protect anything. Then `if (at > src) at -= 1`.
5. Insert `{ tabs: [moved], active: 0 }` at `at`; `active: at`.

- [ ] **Step 4: Run and watch pass**

```bash
cd /Users/nicolaibthomsen/repos/syv/better-holi-final/apps/desktop
pnpm exec vitest run --project node test/panes.test.ts
```

- [ ] **Step 5: Commit**

Message: `feat(panes): a drag can make a pane, and only one drop is a no-op`. The body earns its keep by explaining the narrow guard — a sole tab on *another* pane's edge is a real move that collapses its source, and only the same-position rebuild is the flicker.

---

## Task 3: `lib/tab-drop.ts`

**Files:** Create `apps/desktop/src/renderer/src/lib/tab-drop.ts` · Test `apps/desktop/test/tab-drop.test.ts`

- [ ] **Step 1: Write the failing tests**

Follow `test/tab-window.test.ts` — it imports across the tree (`../src/renderer/src/lib/…`) and tests on numbers, which is exactly the shape here. Cover:

- `dropIndex`: pointer left of a pill's midpoint returns that pill's index, right of it returns the next; three pills at absolute indices 4/5/6 (i.e. a window that does not start at 0) return **absolute** indices, which is the bug this function exists to prevent.
- `dropIndex` in the free space right of the last pill returns `lastVisible.index + 1` — assert this with tabs hidden beyond, so the distinction from "the very end" is the thing being tested.
- `dropIndex` on an empty pill list returns 0.
- `paneDropZone` at a 179px-wide pane: boundaries land at 25%. At 1200px: the 120px cap bites, so the boundary is at 120px and not at 300px. Test both, and the exact boundary pixel in each direction.
- `stripEdge`: within 28px of either end, and `null` between.
- `parseTabPayload`: round-trips each of the three tab kinds through `tabPayload`; returns `null` for junk, for valid JSON that is not an object, for an object with an unknown `kind`, for `{kind:'note'}` with no path, and for `{kind:'app'}` with no `appId`.
- `parseTabPayload` on a preview note returns identity **without** a `preview` flag — the payload carries what a tab *is*, never what state it is in.

- [ ] **Step 2: Run and watch fail**

```bash
cd /Users/nicolaibthomsen/repos/syv/better-holi-final/apps/desktop
pnpm exec vitest run --project node test/tab-drop.test.ts
```
Expected: module not found.

- [ ] **Step 3: Implement**

Contracts and constants are in the Contracts section above. Give the module a header comment in this repo's register: say that jsdom computes no layout, so arithmetic lifted out of the component is the only form of this that can be tested, and point at `tab-window.ts` as the same split made once already.

Two details worth being deliberate about: `paneDropZone`'s edge width is `Math.min(width * EDGE_FRACTION, EDGE_MAX_PX)`; and `parseTabPayload` should build a fresh narrow object per kind rather than returning the parsed one, so no unexpected key rides in from the string.

- [ ] **Step 4: Run and watch pass**

```bash
cd /Users/nicolaibthomsen/repos/syv/better-holi-final/apps/desktop
pnpm exec vitest run --project node test/tab-drop.test.ts
```

- [ ] **Step 5: Commit**

Message: `feat(tabs): where a drop lands is arithmetic, so it can be tested`.

---

## Task 4: Draggable pills, caret, and the drop

**Files:** Modify `apps/desktop/src/renderer/src/components/TabStrip.tsx` · Create `apps/desktop/src/renderer/src/components/__tests__/TabStrip.test.tsx`

- [ ] **Step 1: Write the failing dom test**

jsdom has neither `DragEvent` nor layout, so this test is honest about covering **wiring, not geometry**. Say so in the file header, and point at `test/tab-drop.test.ts` for the half it cannot reach.

Build a minimal `DataTransfer` stub — an object with a `Map`, `setData`/`getData`, a `types` getter, plus `dropEffect`/`effectAllowed` — and pass it through `fireEvent.dragStart(pill, { dataTransfer })`. Assert:

- The pill (the outer `<span>`) has `draggable`.
- `dragStart` stores a payload under `TAB_MIME` that `parseTabPayload` reads back as the right tab.
- A `drop` on the strip host calls `onDropTab` with the parsed tab.

- [ ] **Step 2: Run and watch fail**

```bash
cd /Users/nicolaibthomsen/repos/syv/better-holi-final/apps/desktop
pnpm exec vitest run --project dom src/renderer/src/components/__tests__/TabStrip.test.tsx
```

- [ ] **Step 3: Implement**

Add an optional `onDropTab?: (tab: Tab, index: number) => void` prop. Then:

- `draggable` and `onDragStart` go on the **outer `<span>`** — not on the Radix `Tooltip` trigger and not on the `Button` primitive. `BoardView` puts it on the card `div` for the same reason.
- `onDragStart`: `e.dataTransfer.setData(TAB_MIME, tabPayload(t))` and `e.dataTransfer.effectAllowed = 'move'`.
- `onDragOver` on the host div: return early unless `e.dataTransfer.types.includes(TAB_MIME)`; then `e.preventDefault()` (**without this the drop never fires** — the single most common HTML5-DnD dead end), set `dropEffect = 'move'`, and compute the caret with `dropIndex` over the visible pills' rects. Build the `PillBox[]` from `shown` using `window_.start + offset` for the absolute index and `pillRefs.current.get(key)` for the rect; skip any key with no live ref.
- `onDrop`: parse, clear the caret, call `onDropTab(tab, caretIndex)`.
- `onDragLeave`: clear the caret only when actually leaving the host — guard with `!e.currentTarget.contains(e.relatedTarget as Node | null)`, or crossing a pill will flicker it off.
- **The caret must not change any measured width.** Give the host `relative` and render the caret as an `absolute` 2px line positioned from the pill rect. A real spacer element would make the measure effect oscillate: it calls `setWidths` from inside itself and converges only because it writes on a change.

- [ ] **Step 4: Run and watch pass**

```bash
cd /Users/nicolaibthomsen/repos/syv/better-holi-final/apps/desktop
pnpm exec vitest run --project dom src/renderer/src/components/__tests__/TabStrip.test.tsx
```

- [ ] **Step 5: Commit**

Message: `feat(tabs): a pill can be picked up, and the caret says where it will land`.

---

## Task 5: Auto-slide the clipped strip

**Files:** Modify `apps/desktop/src/renderer/src/components/TabStrip.tsx`

No new test — the behaviour is a timer over `tabWindow`, which is already tested on numbers, and jsdom's zero-size rects cannot arm it. Task 7 verifies it in the running app; say so in the commit body rather than leaving the gap silent.

- [ ] **Step 1: Implement**

- Local `const [dragFocus, setDragFocus] = useState<number | null>(null)` and an interval ref.
- Feed it to the window: `tabWindow({ …, active: dragFocus ?? active })`. **No new windowing logic is needed** — `tabWindow`'s third rule is already "this index must stay visible", and `active` is merely its usual caller.
- In `onDragOver`, ask `stripEdge(hostRect, e.clientX)`. On `'left'`, start an interval stepping `dragFocus` down from `window_.start`; on `'right'`, up from `window_.end - 1`; clamp to `[0, tabs.length - 1]`. On `null`, clear the interval and leave `dragFocus` where it is.
- Clear the interval **and** `dragFocus` on `drop`, on the real `dragLeave`, and on `dragEnd`, and in an unmount cleanup. A leaked interval keeps sliding a strip nobody is dragging over.
- **Add `dragFocus` to the measure effect's dependency array.** Its current deps are `[tabs, widths, available, active]`, none of which change when only `dragFocus` does — so pills revealed by the slide would stay measured at 0 and the window would miscount from then on.

- [ ] **Step 2: Check the lint budget**

```bash
cd /Users/nicolaibthomsen/repos/syv/better-holi-final/apps/desktop
pnpm exec eslint src
```
Expected: 0 errors, exactly 2 warnings (`EditorPane.tsx:240`, `TaskDetail.tsx:348`). If the interval produced an `exhaustive-deps` warning, fix the hook rather than adding a disable.

- [ ] **Step 3: Run the dom project**

```bash
cd /Users/nicolaibthomsen/repos/syv/better-holi-final/apps/desktop
pnpm exec vitest run --project dom
```
Expected: 463 existing + Task 4's.

- [ ] **Step 4: Commit**

Message: `feat(tabs): a clipped position is reachable, because the strip slides under the drag`.

---

## Task 6: The pane drop overlay, and Shell

**Files:** Modify `apps/desktop/src/renderer/src/components/PaneView.tsx`, `apps/desktop/src/renderer/src/components/Shell.tsx`

- [ ] **Step 1: Implement `PaneView`**

Two new props, both optional and both passed straight through the way every other pane callback is:

```ts
onDropTab?: (tab: Tab, index: number) => void
onDropEdge?: (tab: Tab, side: 'before' | 'after') => void
```

`onDropTab` also goes to `TabStrip`. Then wrap the content region — **not the strip** — in a `relative` div and render a drop overlay inside it, only while a drag is in flight:

- Local `dragging` state, set on `onDragEnter` when `e.dataTransfer.types.includes(TAB_MIME)`.
- The overlay is `absolute inset-0` and a **single childless leaf**. That is not styling: `dragleave` fires whenever the pointer crosses into a child, so an overlay with children flickers, and handlers attached to the content itself flicker worse.
- Its `onDragOver` calls `paneDropZone(rect, e.clientX)` and `preventDefault()`; the zone drives a `pointer-events-none` highlight band.
- `onDrop`: `into` → `onDropTab(tab, pane.tabs.length)`; `before`/`after` → `onDropEdge(tab, side)`.
- Clear `dragging` on `drop`, `dragLeave` and `dragEnd`.

`onPointerDownCapture={onFocus}` on `<main>` is untouched — drag events are not pointer events, so the two do not collide.

- [ ] **Step 2: Wire `Shell`**

Inside the existing `workspace.panes.map((p, i) => …)`, beside `onPin` / `onCloseTab`:

```tsx
onDropTab={(tab, index) => setWorkspace((w) => moveTab(w, tab, { pane: i, index }))}
onDropEdge={(tab, side) =>
  setWorkspace((w) => moveTabToNewPane(w, tab, side === 'before' ? i : i + 1))
}
```

Import both from `../state/panes`. `PaneView` stays as dumb as D77 left it — the pane index lives in the closure, never in the component.

- [ ] **Step 3: Typecheck and lint**

```bash
cd /Users/nicolaibthomsen/repos/syv/better-holi-final/apps/desktop
pnpm typecheck && pnpm exec eslint src
```
Expected: clean; 0 errors and the same 2 warnings.

- [ ] **Step 4: Commit**

Message: `feat(panes): a pane's body takes a drop, and its edges split`.

---

## Task 7: Verify it in the running app

**Files:** Create `docs/verification/2026-08-20-movable-tabs.md`

- [ ] **Step 1: Launch and drive**

Native drags need real input, so drive synthetic events from JS over CDP: `new DragEvent('dragstart', { dataTransfer: new DataTransfer(), bubbles: true })` works in Chromium and exercises the real handlers. `apps/desktop/cdp.mjs` already wraps `Runtime.evaluate` and can take a screenshot; wrap `Input.dispatchDragEvent` only if the synthetic route falls short.

- [ ] **Step 2: Walk the six things that only the app can show**

Reorder within a strip; a cross-pane move; a move that empties its source pane (the pane should go); the auto-slide reaching a clipped position; an edge-drop splitting; and a sole tab dropped on its own edge doing nothing at all.

- [ ] **Step 3: Write it down honestly**

Follow `docs/verification/2026-08-20-editor-and-panes.md`, which records what was checked *and* what the environment made unverifiable. The dev window reports `visibilityState: 'hidden'` while occluded, which pauses `requestAnimationFrame` entirely — if that blocks a check, record it as unverified. Do not report a pass you did not see.

- [ ] **Step 4: Commit**

Message: `docs: what a drag actually does, checked by hand`.

---

## Task 8: D78 and the PRD

**Files:** Modify `docs/decisions.md`, `docs/prd/notes-editor.md`

- [ ] **Step 1: Allocate the number**

Re-read the `## Number allocation — next free is D##` header before writing; it said D78 when this plan was written. Bump it.

- [ ] **Step 2: Write D78**

Context / decision / why / rejected alternatives, in the file's existing register. The four things that were genuinely open: a drag pins a preview tab; an edge-drop splits; the singletons stop being fixed leftmost; a clipped drop position is reachable via auto-slide. Rejected: a custom pointer-event drag (three times the code, fights `onPointerDownCapture`), and a jotai drag-state atom (two sources of truth for one drag, stale on a missed `dragend`).

- [ ] **Step 3: Amend `notes-editor.md`**

- §Tabs line 109: *"each opens as a **leftmost** tab with a fixed home"* → leftmost is where a singleton **opens**, not where it lives. `openSingleton` already focuses in place, so the code is unchanged; only this sentence was ever the rule.
- §Tabs line 112, the one-buffer bullet: add that a *move* is safe where a copy is not, which is why a drag may relocate the tab a split may not duplicate.
- New §Moving a tab after §Split panes: the three gestures, the caret rule, the auto-slide, preview-pins-on-drag, the emptied-source-pane rule, and the sole-tab-on-its-own-edge no-op. Consolidate D78 into it — `decisions.md` is a staging ledger and the PRD is the truth.

- [ ] **Step 4: Purge the inbox row**

Once consolidated, remove D78's row from `decisions.md` per the file's own cycle, leaving the inbox empty.

- [ ] **Step 5: Commit**

Message: `docs: a tab moves, and the PRD stops saying the apps live on the left`.

---

## Final gates

Run all of these before calling the work done. From `apps/desktop` unless stated.

```bash
cd /Users/nicolaibthomsen/repos/syv/better-holi-final/apps/desktop
pnpm exec vitest run --project node      # 1533 + new; ~2.2 min
pnpm exec vitest run --project dom       # 463 + new
pnpm typecheck
pnpm exec eslint src                     # 0 errors, exactly 2 known warnings

cd /Users/nicolaibthomsen/repos/syv/better-holi-final
pnpm --filter @holi/shared exec vitest run   # 248
```

Commit straight to `main`, trailer `Claude goes brr.. via Dash`. **Ask Nicolai before pushing** — he approves every push.
