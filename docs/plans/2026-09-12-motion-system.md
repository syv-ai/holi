# Motion system implementation plan

> **For agentic workers:** Use the executing-plans skill to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Holi's accidental motion with one central vocabulary and apply it to the 62 places inventoried in [`../specs/2026-09-12-motion-system-design.md`](../specs/2026-09-12-motion-system-design.md), enforced by the renderer lint gate.

**Architecture:** Four named behaviours (Respond, Arrive, Acknowledge, In flight) defined once in `index.css` as tokens plus Tailwind v4 `@utility` classes. Two pure helpers and two hooks in `lib/`. The gate extends the existing `no-restricted-syntax` selector pattern that already bans colour literals. Everything else is application.

**Tech stack:** Tailwind v4 (`@theme`, `@utility`), CSS custom properties, React 19, Radix (inside `primitives/` only), CodeMirror 6 `baseTheme`, ESLint flat config with AST selectors, Vitest 4 (`node` + `dom` projects).

**Read before starting:** the design spec above; `docs/prd/notes-editor.md`'s top callout; `docs/decisions.md` D92 and D84.

---

## Sequencing, and why it is tiered

The spec left sequencing open. **Tiers, not one sweep.** Three reasons, all mechanical rather than stylistic:

1. Review is human and visual. `jsdom` runs no compositor and a CDP screenshot is one frame, so no automated check can answer "does this feel right". Every motion bug this repo has had (all three of D92's) was found by eye within minutes.
2. **Renderer CSS does not hot-reload into a running window.** Each tier ends in a restart-and-look, so tiers are the natural review unit.
3. Tier 0 is a hard prerequisite: nothing else has utilities to apply until it lands.

Tier 0 must land whole. Tiers 1 to 4 are independent of each other and may be reordered.

## Two rulings this plan adopts

**Reduced motion.** The spec flagged this as unruled. This plan adopts the spec's stated position: under `prefers-reduced-motion: reduce`, **F stops dead, A becomes instant, R and K survive as paint only**. Task 3 and Task 4 implement it. If Nicolai rules otherwise, only those two tasks change.

**The decision number is D97.** `docs/decisions.md`'s header says "Next free is D97"; D96 is the last allocated row.

---

## File structure

| File                                                                      | Status                          | Responsibility                                                                                        |
| ------------------------------------------------------------------------- | ------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `apps/desktop/src/renderer/src/index.css`                                 | modify (§Motion tier, ~305-360) | The whole vocabulary: tokens, `@utility` classes, keyframes, reduced-motion block. The single source. |
| `apps/desktop/src/renderer/src/features/onboarding/onboarding-ritual.css` | modify                          | Receives `--ease-spring`, `@keyframes pop`, `@keyframes wake` on their way out of `index.css`.        |
| `apps/desktop/src/renderer/src/lib/motion.ts`                             | create                          | Pure: `staggerDelay`, `MOTION_STAGGER_CAP`, `prefersReducedMotion`. No React.                         |
| `apps/desktop/src/renderer/src/lib/use-reduced-motion.ts`                 | create                          | The React subscription around the media query.                                                        |
| `apps/desktop/src/renderer/src/lib/use-ack.ts`                            | create                          | The K mechanism: one-shot class, restart-on-retrigger, reduced-motion suppression per variant.        |
| `apps/desktop/eslint.config.mjs`                                          | modify                          | `motionRules`, added to **all four** `no-restricted-syntax` arrays.                                   |
| `apps/desktop/test/fixtures/gate/features/b/motion.tsx`                   | create                          | Deliberate violations, one per selector.                                                              |
| `apps/desktop/test/gate.test.ts`                                          | modify                          | Assert the motion messages fire.                                                                      |
| `apps/desktop/test/motion.test.ts`                                        | create                          | Pure helpers + the two CSS text guards. `node` project.                                               |
| `apps/desktop/src/renderer/src/lib/__tests__/use-ack.test.tsx`            | create                          | `dom` project.                                                                                        |

Everything in tiers 1 to 4 modifies existing components only.

---

# Tier 0 — the vocabulary and the gate

## Task 1: Define the vocabulary in `index.css`

**Files:** modify `apps/desktop/src/renderer/src/index.css`; modify `apps/desktop/src/renderer/src/features/onboarding/onboarding-ritual.css`

- [ ] **Step 1: Move the ritual's motion into the ritual**

`--ease-spring`, `@keyframes pop` and `@keyframes wake` (plus `--animate-wake`) have exactly three consumers, all in `features/onboarding/` (`onboarding-ritual.css:143`, `:591`, `OnboardingRitual.tsx:615`). Move the definitions into `onboarding-ritual.css`.

> **Gotcha.** `onboarding-ritual.css:143` writes `animation: pop 800ms var(--ease-spring)` — it uses the keyframe by name but does not define it. Deleting `@keyframes pop` from `index.css` without moving it breaks the ritual silently: an unknown animation name is not an error, it simply does nothing.

- [ ] **Step 2: Replace the `@theme` Motion tier with the new tokens**

Delete `--duration-micro`, `--duration-base`, `--duration-enter`, `--ease-spring`, and all seven `--animate-*`. Define:

```
--ease-settle: cubic-bezier(0.22, 1, 0.36, 1)   (value unchanged)
--ease-loop:   cubic-bezier(0.45, 0, 0.55, 1)
--motion-respond: 150ms   --motion-arrive: 300ms   --motion-leave: 190ms
--motion-ack: 800ms       --motion-inflight: 2400ms   --motion-stagger: 45ms
```

The token names are the contract; the numbers are the one place they are stated. Re-pacing the app must be an edit to this block and nothing else.

- [ ] **Step 3: Define the `@utility` classes**

| Behaviour | Utilities                                                          | Shape                                                                                                                                                                                                                                                            |
| --------- | ------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R         | `motion-respond`                                                   | A **transition**, never an animation. Property list is paint plus `transform`: `color, background-color, border-color, box-shadow, opacity, transform, fill, stroke, text-decoration-color, outline-color`. Duration `--motion-respond`, easing `--ease-settle`. |
| A in      | `motion-in-right`, `-left`, `-top`, `-bottom`, `-origin`, `-fade`  | **Animations** at `--motion-arrive`. Directional ones are opacity plus a short translate from that edge. `-origin` is opacity plus `scale(0.96) → 1` from `transform-origin`, for menus.                                                                         |
| A out     | `motion-out-right`, `-left`, `-top`, `-bottom`, `-origin`, `-fade` | The inverse, at `--motion-leave`.                                                                                                                                                                                                                                |
| K         | `motion-ack-bloom`, `-tick`, `-flash`, `-nudge`                    | One-shot animations at `--motion-ack`. bloom = an expanding `box-shadow` ring that fades; tick = opacity plus `scale(0.72) → 1`; flash = a background tint decaying to transparent; nudge = a damped horizontal shake.                                           |
| F         | `motion-pulse`, `motion-shimmer`, `motion-orbit`                   | `infinite` animations at `--motion-inflight` (shimmer and orbit may use a stated multiple of it), easing `--ease-loop`.                                                                                                                                          |

> **Decisions worth not re-litigating.** `motion-respond` transitions `transform`, **not** `padding`/`margin`, so a row that steps aside on hover does it on the compositor. Scale in `-origin` goes 0.96 → 1 and **never above 1**: undershoot is allowed, overshoot is the thing that was ruled out. The A utilities are **animations rather than transitions on purpose** — see the Radix gotcha in Task 8.

- [ ] **Step 4: Add the reduced-motion block, beside the tokens**

Under `@media (prefers-reduced-motion: reduce)`: `motion-pulse` / `motion-shimmer` / `motion-orbit` get `animation: none`; every `motion-in-*` / `motion-out-*` gets `animation-duration: 1ms`; `motion-ack-tick` and `motion-ack-nudge` get `animation: none` (they move); `motion-ack-bloom` and `-flash` survive (they paint); `motion-respond` survives.

Keep it physically adjacent to the definitions. Split apart, it will drift.

- [ ] **Step 5: Verify the build compiles the CSS**

Run: `pnpm --filter @holi/desktop build`
Expected: success. Tailwind v4 fails loudly on a malformed `@utility`, so this is a real check, not a formality.

- [ ] **Step 6: Commit**

`style(motion): one vocabulary of two curves, five durations and a stagger step`

---

## Task 2: The pure helpers

**Files:** create `apps/desktop/src/renderer/src/lib/motion.ts`; create `apps/desktop/test/motion.test.ts`

- [ ] **Step 1: Write the failing tests**

`apps/desktop/test/motion.test.ts` runs in the **`node`** project (matched by `test/**/*.test.ts`), which is where this repo's pure logic lives — see `test/tab-reorder.test.ts`, the pattern this copies.

Test intent for `staggerDelay(index, opts?)`:

- index `0` → `'0ms'`
- index `3` → a `calc()` string multiplying `var(--motion-stagger)` by `3`
- index `40` with the default cap → multiplies by `8`, not 40
- `{ reduced: true }` → `'0ms'` at any index
- a negative index → `'0ms'`

Plus two text guards over `index.css` (cheap, and they catch the classic failures):

- no occurrence of `--duration-micro`, `--duration-base` or `--duration-enter`
- every `animation:` name used inside a `@utility motion-*` block has a matching `@keyframes`

- [ ] **Step 2: Run the tests and watch them fail**

Run: `pnpm -C apps/desktop exec vitest run --project node motion`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement `lib/motion.ts`**

Exports: `MOTION_STAGGER_CAP = 8`, `staggerDelay(index, opts?): string`, `prefersReducedMotion(): boolean`.

> **Contract: `staggerDelay` returns a CSS `calc()` string, not a number of milliseconds.** That keeps the step inside the token, so re-pacing stays a one-line edit, and it means the value a component passes to `animationDelay` is a function call rather than a literal, which is exactly what the Task 5 lint rule permits.

> `prefersReducedMotion` guards `window.matchMedia?.` — it is called from non-React code (`editor/askAgent.ts`) and must return `false` rather than throw where `matchMedia` is absent.

- [ ] **Step 4: Run the tests**

Run: `pnpm -C apps/desktop exec vitest run --project node motion`
Expected: PASS.

- [ ] **Step 5: Commit**

`feat(motion): staggerDelay caps the ramp and keeps the step in the token`

---

## Task 3: The reduced-motion hook, replacing the two special cases

**Files:** create `apps/desktop/src/renderer/src/lib/use-reduced-motion.ts`; create `apps/desktop/src/renderer/src/lib/__tests__/use-reduced-motion.test.tsx`; modify `apps/desktop/src/renderer/src/editor/askAgent.ts:70`

- [ ] **Step 1: Write the failing test** (`dom` project, matched by `src/renderer/**/*.test.tsx`)

Test intent: returns `false` when the query does not match; returns `true` when it does; **re-renders when the media query changes** (add a listener, fire a change, assert the new value); removes its listener on unmount.

> **Gotcha.** jsdom does not implement `matchMedia`. The test must install a stub on `window` and the hook must tolerate its absence, or every other `dom` test that mounts a component using it starts throwing.

- [ ] **Step 2: Run it and watch it fail.** `pnpm -C apps/desktop exec vitest run --project dom use-reduced-motion`

- [ ] **Step 3: Implement the hook**, built on `useSyncExternalStore` over the `MediaQueryList` change event.

- [ ] **Step 4: Point `editor/askAgent.ts:70` at `prefersReducedMotion()`** from `lib/motion.ts`, deleting its inline `window.matchMedia?.(...)` check. `editor/theme.ts:184` keeps its CSS media query; it is already the right mechanism.

- [ ] **Step 5: Run the dom project.** Expected: PASS, and no new failures elsewhere.

- [ ] **Step 6: Commit.** `feat(motion): one reduced-motion source instead of two special cases`

---

## Task 4: The acknowledge mechanism

**Files:** create `apps/desktop/src/renderer/src/lib/use-ack.ts`; create `apps/desktop/src/renderer/src/lib/__tests__/use-ack.test.tsx`

K is the only behaviour that needs runtime help: it is a one-shot animation fired by an event, and firing it twice in a row must replay rather than do nothing.

- [ ] **Step 1: Write the failing test**

Contract: `useAck<T extends HTMLElement>() => { ref, ack(variant) }`, `variant` one of `'bloom' | 'tick' | 'flash' | 'nudge'`.

Test intent:

- `ack('bloom')` puts `motion-ack-bloom` on the element
- the class is removed on `animationend`
- **calling `ack` twice in succession replays**: the class is present again after the second call
- under reduced motion, `ack('nudge')` and `ack('tick')` are no-ops while `ack('bloom')` and `ack('flash')` still apply
- unmounting mid-animation does not throw

- [ ] **Step 2: Run it and watch it fail.**

- [ ] **Step 3: Implement.**

> **Gotcha, and the single most likely thing to be got wrong here.** Removing and re-adding a class in the same tick does **not** restart a CSS animation: the browser coalesces it and nothing plays. The restart must remove the class, force a reflow by reading a layout property on the node (`void node.offsetWidth`), then re-add. Do not replace this with a `setTimeout`.

> **Gotcha.** Variants split by what they animate, and reduced motion only suppresses the ones that move: `bloom` (box-shadow) and `flash` (background) are paint and survive; `tick` (scale) and `nudge` (translate) are travel and are suppressed. Encode that as data on the variant, not as an `if` at each call site.

> `ack()` must never await anything or block. A K animation is decorative feedback on an act that has already happened.

- [ ] **Step 4: Run the dom project.** Expected: PASS.

- [ ] **Step 5: Commit.** `feat(motion): a one-shot ack that replays on retrigger`

---

## Task 5: The lint gate

**Files:** modify `apps/desktop/eslint.config.mjs`; create `apps/desktop/test/fixtures/gate/features/b/motion.tsx`; modify `apps/desktop/test/gate.test.ts`

- [ ] **Step 1: Write the fixture**

One deliberate violation per selector, in the style of the existing gate fixtures. Cover: `duration-[220ms]`, `ease-[cubic-bezier(0.1,0,0.2,1)]`, `delay-[60ms]`, `animate-[spin_2s_linear_infinite]`, `transition-all`, a literal `style={{ transition: '...' }}`, and a literal `style={{ animationDelay: '90ms' }}`.

- [ ] **Step 2: Extend `gate.test.ts` and watch it fail**

Assert a motion message is reported for the fixture, the way the existing test asserts on `/native title=/`.

Run: `pnpm -C apps/desktop exec vitest run --project node gate`
Expected: FAIL — the violations are not yet reported.

- [ ] **Step 3: Add `motionRules` to `eslint.config.mjs`**

Follow the `colourRules` shape exactly: a `Literal[value=/…/]` selector and a `TemplateElement[value.raw=/…/]` selector over the class-name body, plus one selector for inline style objects.

Body regex covers: `(duration|ease|delay)-\[`, `animate-\[`, and the bare word `transition-all`.

The inline-style selector matches a `style` JSX attribute's `transition`, `transitionDuration`, `transitionTimingFunction`, `animation`, `animationDuration`, `animationTimingFunction` or `animationDelay` property **whose value is a `Literal`**.

> **Contract, and the reason for `> Literal`.** A computed value such as `animationDelay: staggerDelay(i)` is a `CallExpression` and must pass. The rule bans _stating a number_, not touching the property. Get this wrong and Task 9's stagger cannot be written at all.

> **Gotcha, and the highest-risk step in this task.** `eslint.config.mjs` re-states the `no-restricted-syntax` rule array in **four** separate blocks: the base `LINTED` block, the `primitives/**` block, the `MIGRATED_NO_NATIVE` block, and the fixtures block. A rule added to only one of them is silently half-enforced, and `primitives/` — where most of Tier 1 lands — is one of the blocks that would miss it. Add `...motionRules` to all four.

> **Exemption:** add a trailing config block for `src/renderer/src/features/onboarding/**` that drops the motion rules. The ritual owns its own ceremony CSS and its own spring.

- [ ] **Step 4: Run the gate test.** Expected: PASS.

- [ ] **Step 5: Run the gate over the real tree**

Run: `pnpm lint`
Expected: **errors**, in the files the vocabulary has not reached yet — `features/explorer/icons.tsx:15` has a literal inline `transition: 'transform 120ms'`, and `primitives/Button.tsx:8` carries `transition-all`. That is the gate working. Tasks 6 to 14 clear them.

> **Do not** silence these with `eslint-disable`. If a tier cannot land immediately, the honest holding move is to keep the motion rules at `warn` in the base block until Tier 4 is done, then promote to `error` in Task 15. Record which you chose in the commit message.

- [ ] **Step 6: Commit.** `feat(lint): motion numbers come from tokens or not at all`

---

## Task 6: Migrate the three existing token consumers

**Files:** modify `apps/desktop/src/renderer/src/components/TabStrip.tsx` (the comment at `:99`, the JS read at `:107`, and `:201`, `:675-680`, `:706`); modify `apps/desktop/src/renderer/src/editor/theme.ts:176`

- [ ] **Step 1: Rename in `TabStrip`.** `--duration-micro` → `--motion-respond`, in the class names _and_ in the `getPropertyValue` call.

> **Gotcha.** `TabStrip.tsx:107` reads the token **by name in JavaScript** and parses it with `Number.parseFloat`. Renaming the token in CSS without renaming this read yields `NaN`, and the FLIP silently stops settling. The explanatory comment at `:99` names the old token too and must be updated, or the next reader is misled.

- [ ] **Step 2: Reclassify the heading slide.** `editor/theme.ts:176` uses `var(--duration-base, 240ms)` twice; it becomes `var(--motion-respond, 150ms)`.

> **Why this is a change and not a rename.** D92 chose `--duration-base` before a vocabulary existed. The slide is gated on a caret move and reverses, so it is R, and R is 150ms. The app gets faster here.

> **Gotcha.** Check `editor/heading-slide.ts`'s frame cap before changing the duration. If the cap on a lost `transitionend` is expressed in frames it is fine; if it is a millisecond number derived from 240, it must follow the new duration or the caret-follow loop's window no longer matches the transition it is tracking.

- [ ] **Step 3: Run the affected suites**

Run: `pnpm -C apps/desktop exec vitest run --project node tab-reorder` and `pnpm -C apps/desktop exec vitest run --project dom heading`
Expected: PASS.

- [ ] **Step 4: Verify in the running app**

Reorder tabs by dragging; put the caret on a heading. **A CodeMirror theme change needs the file closed and reopened** — the open editor keeps the extension set it was created with.

- [ ] **Step 5: Commit.** `refactor(motion): the tab FLIP and the heading slide are Respond`

---

# Tier 1 — primitives

Most of the 62 rows reach the app through here, because the `primitives/` → `composites/` → `features/` rule already forces features through these components.

## Task 7: Respond in the form primitives

**Files:** modify `primitives/{Button,Input,Textarea,Select,Checkbox,ChipInput,ColorSwatch}.tsx`

- [ ] **Step 1:** Replace each ad-hoc transition with `motion-respond`. Specifically: `Button.tsx:8`'s `transition-all` (the marker of an unconsidered choice, and a lint error after Task 5), `Input.tsx:9` and `Select.tsx:9`'s `transition-[color,box-shadow]`, `Checkbox.tsx:15`'s `transition-shadow`.

- [ ] **Step 2:** Give `Button` a press depth: a small `active:` scale, which `motion-respond` already transitions.

> **Gotcha (D96, found twice in one hour).** A primitive's own variant classes beat an unprefixed override on the same element: `Input`'s base carries `md:text-sm` and `dark:bg-input/30`. When adding a class here, check it is not being silently lost to a more specific variant already in the same string.

- [ ] **Step 3:** Run `pnpm -C apps/desktop exec vitest run --project dom` and `pnpm lint`. Expected: PASS, and the Button/Input/Select/Checkbox motion errors gone.

- [ ] **Step 4: Commit.** `feat(motion): the form primitives respond`

## Task 8: Arrive in the overlay primitives

**Files:** modify `primitives/{Dialog,Popover,DropdownMenu,ContextMenu,Tooltip,Select}.tsx`

- [ ] **Step 1:** Replace the Radix/tailwindcss-animate utilities (`animate-in`, `animate-out`, `fade-*`, `zoom-*`, `slide-*`, and the current `animate-scale-in`/`animate-fade-in`) with `motion-in-origin` / `motion-out-origin` on content, and `motion-in-fade` / `motion-out-fade` on the dialog scrim.

Keep the existing `origin-(--radix-*-content-transform-origin)` classes. They are what makes "arrives from its trigger" true rather than decorative, and Radix computes them for free.

> **Gotcha, and the reason the A utilities are animations rather than transitions.** Radix's `Presence` keeps an exiting node mounted by waiting for `animationend`. A **transition** on `data-[state=closed]` does not keep it mounted: the node unmounts immediately and the exit is never seen. `motion-out-*` must be an `animation`.

> **Gotcha.** Scale goes 0.96 → 1. Undershoot is fine; going above 1 is the overshoot that was explicitly ruled out.

- [ ] **Step 2:** Check `Tooltip` keeps its existing open delay. The delay is Radix's, not motion, and must not be folded into the duration.

- [ ] **Step 3:** Verify in the running app that a dialog **accepts typing while it is still arriving**. This is the "motion never delays input" rule and it is the one a 300ms arrival is most likely to break.

- [ ] **Step 4:** Run the dom project and `pnpm lint`.

- [ ] **Step 5: Commit.** `feat(motion): overlays arrive from their trigger and leave faster`

---

# Tier 2 — shell chrome

## Task 9: Explorer

**Files:** modify `features/explorer/{FileTree,ExplorerHeader,EditIcon,icons}.tsx`

- [ ] **Step 1:** Tree rows (`FileTree.tsx:734`) get `motion-respond` in place of `transition-colors`, plus the hover treatment: background, name colour, and the `···` affordance fading in. Step-aside uses `transform`, never `padding`.

- [ ] **Step 2:** The chevron at `icons.tsx:15` currently carries a literal inline `transition: 'transform 120ms'`. Move it to `motion-respond`. (It is a Task 5 lint error until this lands.)

- [ ] **Step 3:** Expanding a folder staggers its children in with `motion-in-top` plus `animationDelay: staggerDelay(i)`.

> **Gotcha, and this is D92's bug in a new costume.** An arrive animation on a list replays whenever the list re-renders. D92's heading marks animated shut on _file open_ for exactly this reason. The stagger must be gated on the expand event, not declared unconditionally on the children, or every unrelated tree re-render replays it. The tree is **not** windowed, so scrolling is not a trigger here, but re-render is.

- [ ] **Step 4:** `ExplorerHeader.tsx:58`'s hand-rolled `transition-opacity duration-150` becomes `motion-respond`. The inline create input arrives with `motion-in-top`.

- [ ] **Step 5:** Verify in the running app: hover rows, expand a deep folder, create a file, drag a file over a folder (the **target** warms; the dragged thing stays direct).

- [ ] **Step 6: Commit.** `feat(motion): the tree responds and its children arrive`

## Task 10: Tabs, panes and the shell panels

**Files:** modify `components/{TabStrip,PaneView,Shell}.tsx`; `composites/SidePanel.tsx`

- [ ] **Step 1:** TabStrip hover, close button, active indicator and overflow fade → `motion-respond` (the FLIP already moved in Task 6). A tab opening arrives with `motion-in-right`; closing leaves with `motion-out-right`.

- [ ] **Step 2:** History, turn-review and agent panels arrive from their own edge; a pane split arrives from the split.

> **Gotcha.** These are `ResizablePanel` children of a `ResizablePanelGroup`. Animating the **panel** fights the group's sizing maths and will fight the persisted layout (`usePanelLayout`). Animate the panel's **content** instead, inside the panel that the group has already sized.

- [ ] **Step 3:** Verify in the running app: open and close each panel, split a pane, open and close tabs. Watch that the sidebar drag stays 1:1 and is never eased.

- [ ] **Step 4: Commit.** `feat(motion): panels arrive from the edge they belong to`

---

# Tier 3 — features

## Task 11: Agent

**Files:** modify `features/agent/{AgentPanel,TurnChip,TurnReview}.tsx`; `lib/agent-notices.ts`

- [ ] **Step 1:** "Claude is working" gets `motion-pulse`, bound to the existing `agentStatusAtom`.

> **Gotcha.** Bind to the hook-driven status atom. Do **not** infer working/idle by reading the PTY stream: that is a known dead end in this repo, and the `UserPromptSubmit`/`Stop` hooks are the supported signal.

> This is the canonical F case and the rule it must honour: when the state ends, the animation ends. Nothing loops decoratively.

- [ ] **Step 2:** A turn finishing fires `ack('bloom')` on the turn chip. The drawer and `TurnChip` arrive; turn-review rows respond; accept/reject fires `ack('flash')`.

- [ ] **Step 3:** Verify in the running app with a real short turn.

- [ ] **Step 4: Commit.** `feat(motion): the agent breathes only while it is working`

## Task 12: Tasks and the board

**Files:** modify `features/tasks/{BoardView,CreateTask,FilterBar}.tsx`

- [ ] **Step 1:** Card hover responds. The drag itself stays direct; the **drop** settles with `motion-in-*` and the neighbours that shift move at A, following D84's FLIP pattern (`lib/tab-reorder.ts` is the shape to copy: positions computed in a tested pure module, the component only applies them).

- [ ] **Step 2:** Completing a task is the best K in the app: `ack('tick')` on the checkbox, the strike-through, then the card leaving for Done.

> **Gotcha.** A card leaving is an unmount, and React unmounts immediately, so `motion-out-*` never plays. Either hold the card in a small exit set for `--motion-leave` before dropping it, or accept an instant removal. Decide explicitly and say which in the commit message; do not leave a leave-animation that silently never runs.

- [ ] **Step 3:** The column `+` input arrives. A filter change animates the set in and out, with survivors moving at A.

- [ ] **Step 4:** Verify in the running app. **Use a scratch vault, not `~/Holi/nthomsencph/privat`** — Holi autosaves and pushes, so exercising the board writes real commits.

- [ ] **Step 5: Commit.** `feat(motion): a completed task acknowledges before it leaves`

## Task 13: Mail, calendar, history and settings

**Files:** modify `features/google/{MailView,AgendaView,SelectionBar,MailboxPicker}.tsx`; `features/history/{HistoryPanel,HistoryView}.tsx`; `features/settings/{SettingsRail,SettingsView,SettingRow}.tsx`; `composites/Churn.tsx`

- [ ] **Step 1:** Thread rows, commit rows, agenda events and settings rail items get `motion-respond`. `SettingsRail.tsx:72`'s bare `transition-transform` goes with them.

- [ ] **Step 2:** `MailView.tsx:1696`'s `animate-spin` becomes `motion-orbit`. Opening a thread, swapping a settings section and the compose dialog arrive. The selection bar arrives from the bottom.

- [ ] **Step 3:** Send, reply, restore and revert fire `ack('bloom')`. **A setting written to disk fires `ack('flash')`** — it is a file write and the spec gives it a beat.

- [ ] **Step 4:** Churn bars stagger **on first paint only**, never on a re-render. Same gate as Task 9 step 3.

- [ ] **Step 5:** Verify in the running app.

- [ ] **Step 6: Commit.** `feat(motion): the daily feature surfaces respond and acknowledge`

---

# Tier 4 — inside a document

## Task 14: The clickable objects in the editor

**Files:** modify `apps/desktop/src/renderer/src/editor/theme.ts`; `editor/{wikiLinkChips,imageWidget}.ts`; `composites/FrontmatterFields.tsx`

> **Found during Task 3, recorded so it is not lost.** `editor/askAgent.ts` carries `const EXIT_MS = 220`, a duration it sets as a custom property for its stylesheet to read. It is a motion number outside the vocabulary, and the lint rule cannot see it: it is a plain JS const, not a class name or a style literal. The ask-agent popover leaving is A, so it should read `--motion-leave`. Fold it into this task.

The line is **"is it a thing you can click"**, not "is it in the editor". Prose, headings and code never move.

- [ ] **Step 1:** Wiki-link chips, task status orbs, note checkboxes and table cells respond on hover. A chip going from missing to existing, and a status change, fire K.

- [ ] **Step 2:** An image fades in on load with its box reserved, so nothing reflows.

- [ ] **Step 3:** Frontmatter field rows respond; a field written fires `ack('flash')`. Slash and mention autocomplete popups arrive with `motion-in-origin` — they are popups over the editor, not decorations.

> **The constraint that governs this whole task: paint only.** Allowed: `color`, `background-color`, `border-color`, `box-shadow`, `opacity`, `fill`, `stroke`, and transforms that do not change the layout box. **Banned: `width`, `height`, `font-size`, `margin`, `padding`** — changing those inside CodeMirror pegs its measure loop, which is the lesson `docs/prd/notes-editor.md` already paid for. The heading slide is the single exception and it earns it the way D92 records.

> **Gotcha.** `editor/theme.ts` is a CM `baseTheme`: one mode-independent palette. Any token it reaches must be defined outside the per-theme scopes, or it resolves to nothing in one mode. This is the same trap D93 hit with the table-cell highlight style.

> **Gotcha.** An open editor keeps the extension set it was created with. Verifying a change here means **closing and reopening the file**, not just saving.

- [ ] **Step 4:** Run `pnpm -C apps/desktop exec vitest run --project dom` (this is where the editor suites live).

- [ ] **Step 5:** Verify in the running app, **in a scratch vault**. Do not drive the editor with synthetic input events; mount an `EditorView` in a dom test if behaviour needs exercising.

- [ ] **Step 6: Commit.** `feat(motion): the objects in a document respond, the prose does not`

---

# Tier 5 — close it out

## Task 15: Promote the gate, then the docs

**Files:** modify `apps/desktop/eslint.config.mjs`; `docs/decisions.md`; `docs/prd/notes-editor.md`; `docs/architecture.md`; `docs/upcoming.md`

- [ ] **Step 1:** If Task 5 step 5 left the motion rules at `warn`, promote them to `error` now and confirm a clean tree.

Run: `pnpm lint`
Expected: 0 errors (4 pre-existing warnings are the known baseline).

- [ ] **Step 2: Add the D97 row to `docs/decisions.md`** and update the header's "Next free is D97" to D98.

The row carries: the four behaviours and the name-one-or-do-not-animate rule; weight without overshoot, and the spring's quarantine in the ritual; 300ms chosen against 160 and 220 in a browser; purpose-named tokens replacing size-named ones, and why (`--duration-micro` tells a reader nothing about when to use it, which is how the pile happened); the "is it a thing you can click" line inside a document; the lint rule as part of the design rather than a follow-up; and the reduced-motion tier.

- [ ] **Step 3: Update `docs/prd/notes-editor.md`'s top callout.** It currently reads as "no animation layer, with one exception". That is no longer true: there is now a **bounded exception class** (clickable objects, paint only) plus the heading slide. Rewrite it to say so, and keep the rejected-approaches list intact.

- [ ] **Step 4: Add a short motion section to `docs/architecture.md`**, since this is an app-wide contract: the four behaviours, where the vocabulary lives, and that the gate enforces it.

- [ ] **Step 5: Tick item 7 in `docs/upcoming.md`**, with a line pointing at D97 and the spec.

- [ ] **Step 6: Run every gate**

```sh
pnpm -C packages/shared test                          # 552
pnpm -C apps/desktop exec vitest run --project node   # ~2032, ~4 min
pnpm -C apps/desktop exec vitest run --project dom    # ~769
pnpm typecheck
pnpm lint
pnpm exec prettier --check <files touched>
```

> The `dom` project runs in parallel and flakes under load. Judge a failure only after re-running that file alone. Do **not** parallelise the `node` project or widen its waits.

- [ ] **Step 7: Commit.** `docs(motion): record D97 and the bounded editor exception`

---

## Self-review notes

**Spec coverage.** Vocabulary → Task 1. Stagger cap → Task 2. Reduced motion → Tasks 1, 3, 4. Old-token migration (all three consumers) → Tasks 1 and 6. Lint enforcement → Tasks 5 and 15. The 62 inventory rows → Tasks 7 to 14, grouped by the spec's own section headings. Stays-still list → enforced as gotchas in Tasks 8 (input latency), 10 (resize drag), 14 (paint only). Testing section → Tasks 2 to 5, and every tier ends in a running-app check.

**One spec clause deliberately not implemented as written.** The spec asks the lint rule to reject `@keyframes` outside `index.css`. ESLint does not lint CSS, so Task 2 covers it as a text guard over `index.css` instead. The onboarding ritual's own CSS is the intended exception either way.

**Open for Nicolai.** The reduced-motion tier is adopted from the spec rather than ruled on, and Task 5 step 5 leaves a genuine choice (hold the gate at `warn` through tiers 1 to 4, or clear every error in the same landing).
