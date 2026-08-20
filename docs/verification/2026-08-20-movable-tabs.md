# Movable tabs — D78

Verified **2026-08-20**, in the running dev app (`electron-vite dev --remote-debugging-port=9333`)
against the real `nthomsencph/privat` vault, driven over CDP.

**Legend:** `[x]` verified in-app · `[~]` verified another way, named below · `[ ]` not verified.

The plan expected this to be the hard one — "drag-and-drop is close to unverifiable over CDP as
currently tooled". It turned out not to be. Synthetic `DragEvent`s carrying a real `DataTransfer`
reach the actual handlers, and every rule the feature invented was observable in the running window.
What is *not* covered is the OS drag loop itself; see §Not verified.

## What was driven

Synthetic events only — `new DragEvent(type, { dataTransfer: new DataTransfer(), … })` dispatched at
real coordinates read from live `getBoundingClientRect`s. `Input.dispatchDragEvent` was never needed
and `cdp.mjs` is unchanged.

## 1. The payload is real

- [x] `dragstart` on a pill left `application/x-holi-tab` on the `DataTransfer`, holding
      `{"kind":"note","path":".gitignore"}` — the real handler, the real MIME type, identity only.

## 2. Reorder within a strip

- [x] Two tabs, `[20-08-2026.md, AGENTS.md]` with **AGENTS.md active**. Dragged the *inactive* one
      onto the right half of the other; `dragover` reported `defaultPrevented: true` and exactly one
      caret element was drawn. After the drop: `[AGENTS.md, 20-08-2026.md]`.
- [x] **AGENTS.md was still active.** This is the rule the tests changed the spec over — a reorder
      rearranges, it does not navigate — and it holds in the app.

## 3. Auto-slide reaches a clipped position

The most valuable check here, because it is the one the plan doubted.

- [x] Five tabs in a **344px** strip: one pill visible, `+4` hidden, the window anchored on the
      active tab at index 4. Held a drag in the left-hand band (`strip.left + 5`):
      after 1200ms the window showed index 2, after 2400ms index 0. It walked the whole strip one
      tab at a time and **clamped at 0** rather than running off the end.
- [x] Timer throttling is visible in those numbers — an occluded window throttles `setInterval`, so
      the real cadence was slower than `SLIDE_MS`. It still arrives, and the first step is immediate
      by design, which is what keeps it feeling responsive when it matters.

## 4. Edge-drop splits

- [x] Dragging over the middle of a pane body lit the `into` band (`inset-0`); moving to the right
      quarter switched it to `right-0`.
- [x] **The cap is doing its job:** on a **658px** pane the edge band measured **120px**, not the
      164px a bare 25% would give. That is `paneDropZone`'s ceiling, drawn and measured.
- [x] The drop produced two panes: `[[AGENTS.md], [20-08-2026.md]]`.

## 5. A move that empties its source takes the pane with it

- [x] Dragged the second pane's only tab onto the first pane's strip. Result: **one** pane holding
      `[20-08-2026.md, AGENTS.md]`, and the moved tab active in its destination. The source column
      is gone — this is how you unsplit by dragging.

## 6. The sole-tab no-op, and only it

- [x] The same sole tab dropped on **its own pane's** right edge changed nothing: two panes before,
      the identical two after. Compare §5, where that same tab dropped on a *different* pane's strip
      moved for real. The guard is as narrow as it was meant to be.

## 7. A drag pins a preview tab

- [x] Single-clicked `CLAUDE.md` in the tree — opened italic, i.e. preview. Dragged it to position
      0. It landed **non-italic**: pinned. Without this the next single-click in the tree would have
      replaced it in place and destroyed the tab just positioned.

## 8. A stranded drag does not strand the strip

Found while verifying, and worth its own entry because it is the bug Task 6 fixed.

- [x] After holding a drag at the clipped edge and then *never* dropping it, the strip stayed slid —
      correct, the drag was still live. Dispatching `dragend` on `window` snapped it straight back
      to the active tab. That is the listener that catches escape-cancels and drops in other panes,
      where `dragend` fires on the source pill in a pane that is not this one.

## 9. A pane offers only drops that would do something

Added after review — the overlay was lighting up where nothing could happen.

- [x] **One tab, one pane.** Dragging the only tab showed **no overlay at all** — middle, left
      edge and right edge alike. Every zone would have been a no-op.
- [x] **Four tabs, dragging from this pane.** The middle gave `band=NONE, accepted=false` — the
      overlay is present (it has to be, to notice the pointer reaching an edge) but draws nothing
      and refuses the drop, so the cursor reads "not here". Both edges gave their band and
      `accepted=true`. No more full-pane flash on the way to a split.
- [x] **The other pane still offers everything.** With two panes open and a drag started in pane 0,
      pane 1's middle gave `band=inset-0, accepted=true`. "Put this over there" is exactly what a
      middle drop means when it is not your own pane.

## Not verified, and why

- [ ] **The OS drag loop.** Synthetic events exercise the handlers, not Chromium's native drag: the
      ghost image, escape-to-cancel, and the cursor's `dropEffect` feedback are untested. Real
      pointer input is the only way, and this window cannot receive it (below).
- [~] **`effectAllowed = 'move'`.** The handler sets it; a synthetic `DataTransfer` is in protected
      mode and reads back `'none'` regardless, so it cannot be observed this way. Covered instead by
      the dom test in `src/renderer/src/components/__tests__/TabStrip.test.tsx`, where the stub
      records it.
- [ ] **A split at a comfortable width.** Verified at 658px per pane after widening; the inherited
      179px-per-pane case is still unexercised.

## Environment notes, for whoever drives this next

- **`visibilityState` stays `'hidden'`** while the window is occluded, and `Page.bringToFront` does
  **not** clear it — measured again today. `requestAnimationFrame` is therefore paused, which is why
  clicking "Hide agent panel" did nothing: the collapse never ran.
- **The workaround is the resize handle.** Dispatching `pointerdown` on a
  `[data-slot=resizable-handle]` and then `pointermove`/`pointerup` on `document` resizes for real
  and does not depend on rAF. That took the editor pane from 360px to 614px and made the whole strip
  observable. `react-resizable-panels` hit-tests the *document*, so the moves must go to `document`,
  not to the handle.
- **`setInterval` is throttled** in the occluded window. Anything timer-driven needs generous waits.
- The tab overflow dropdown and the file tree's context menus are both mounted, so
  `[role=menuitem]` returns all of them at once. The tab entries are the ones with no shortcut.
- **`cdp.mjs` returns `null` if the expression dispatches `dragend` on `window` after a
  `dragenter`/`dragover` in the same evaluation.** Every piece works alone; the combination
  swallows the result. Not chased — the fix is to end the drag in a *separate* call, and to stash
  the `DataTransfer` on `window` when a check needs to span calls, which it survives.
