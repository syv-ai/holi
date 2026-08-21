# Task dates as stamps Implementation Plan

> **For agentic workers:** Use the executing-plans skill to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `due` and `reminder` become one value type — a local date with an optional time — and the reminder grammar is replaced by a picker used by every date field on a task.

**Architecture:** Bottom-up, and the bottom is pure. `packages/shared` gains a stamp vocabulary (`dates.ts`) and a month grid (`calendar.ts`); `reminder.ts` loses its relative branch entirely; `recurrence.ts` and `labels.ts` learn that a date may carry a time. Only then does a component exist: `composites/DateTimePicker.tsx` holds no date arithmetic at all, which is what lets the hard part be tested in the node project. Tasks 1–6 are shippable on their own and leave the app working; the UI arrives in Task 7.

**Tech Stack:** TypeScript, React, jotai, Radix Popover (via the existing primitive), Vitest (`node` project for pure logic, `dom` for components), Electron + CDP for in-app verification.

**Spec:** `docs/specs/2026-08-21-task-datetime-design.md` — read it first, especially §2 (what a stamp is and why the relative form goes) and §3 (the overdue rule). **Decisions:** D79, already reserved in `docs/decisions.md`; its inbox row is Task 10. **Replaces:** the reminder grammar ported from the old Rust `services/reminder.rs`.

---

## Scope

**In:** the stamp type and its helpers; `monthGrid`; deleting `ReminderSpec`/`parseReminder`; time-preserving recurrence; the time-aware overdue rule and the `nowAtom` it needs; stamp validation in `task-file`; the `DateTimePicker` composite; wiring `due`, `reminder` and `until`; a seeded `using-tasks` skill; the PRD and D79 rows.

**Out, and deliberately:** timezones (stamps stay local-naive); `until` gaining a time; snooze; any change to how notifications are delivered — the sweep keeps its 60s tick and its watermark, and only the predicate it calls changes shape.

## File map

**`packages/shared/src/`**
- `dates.ts` — add the stamp layer. `parseDate`/`parseDateTime` stay: they are the strict halves `parseStamp` is built from, and `formatDateTime` still has callers.
- `calendar.ts` *(new)* — `monthGrid` and nothing else.
- `reminder.ts` — `ReminderSpec`, `parseReminder` and `resolveReminder` are **deleted**. `pendingFireTime` loses its `due` parameter. `shiftForRollover` stays, on stamps. `ANCHOR_HOUR` survives as the fallback hour for a timeless reminder.
- `recurrence.ts` — `nextDue`/`nextDueCatchup` preserve the time part. Signatures unchanged.
- `labels.ts` — `virtualLabels`/`allLabels` take `now` (a timed stamp) instead of `today`.
- `task-file.ts` — `due`'s reader widens to a stamp. **`reminder`'s reader does not change** (see Deviations).
- `index.ts` — export `calendar`.

**`apps/desktop/src/main/`**
- `reminders/sweep.ts` — one call site: `pendingFireTime` drops its `due` argument.
- `router.ts` — the `tasks.complete` roll-forward around line 1018–1028 (`nextDueCatchup`, `shiftForRollover`).
- `agent/skills/using-tasks/SKILL.md` *(new)* + `agent/seed-content.ts` — register it in `MANAGED_FILES`, not the once-files.

**`apps/desktop/src/renderer/src/`**
- `composites/DateTimePicker.tsx` *(new)* + `composites/index.ts`.
- `features/tasks/TaskDetail.tsx` — `due`, `reminder` and `until` become pickers; `DATE_FIELD` and its `::-webkit-datetime-edit` workaround are **deleted** with the native inputs they existed for.
- `features/tasks/CreateTask.tsx` — the draft's `due`/`reminder` fields.
- `features/tasks/BoardView.tsx`, `features/tasks/FilterBar.tsx`, `state/tasks.ts` — `todayAtom` → `nowAtom`, and every `virtualLabels`/`allLabels`/`matchesFilter` call site.

**Tests**
- `packages/shared/test/` — `dates.test.ts` (extend), `calendar.test.ts` *(new)*, `reminder.test.ts`, `recurrence.test.ts`, `labels.test.ts`, `task-file.test.ts`.
- `apps/desktop/src/renderer/src/composites/__tests__/DateTimePicker.test.tsx` *(new)* — the **dom** project.

**Test placement:** pure logic in `packages/shared` is tested from `packages/shared/test/` and runs under `pnpm --filter @holi/shared exec vitest run`. Desktop pure logic lives in `apps/desktop/test/*.test.ts` (**node** project); only `.test.tsx` under `src/renderer/**` runs in **dom**. Grep all three trees before assuming a test does not exist.

## Contracts

```ts
// packages/shared/src/dates.ts — the stamp layer

/** A local-naive stamp: `YYYY-MM-DD`, or `YYYY-MM-DDTHH:MM[:SS]`. */
export interface ParsedStamp {
  /** UTC epoch ms. Midnight when the stamp carries no time. */
  epoch: number
  /** Whether the stamp actually named a time. This is the whole point of the type. */
  timed: boolean
}

export function parseStamp(s: string): ParsedStamp | null
/** Epoch, substituting `defaultHour` when the stamp is timeless. Null if unparseable. */
export function stampEpoch(s: string, defaultHour: number): number | null
/** `YYYY-MM-DD`, or `YYYY-MM-DDTHH:MM` when `timed`. */
export function formatStamp(epoch: number, timed: boolean): string
/** The date half, always `YYYY-MM-DD`. Null if unparseable. */
export function stampDate(s: string): string | null
/** The time half as `HH:MM`, or null when timeless or unparseable. */
export function stampTime(s: string): string | null
/** Same date, new time — `null` removes it. The one mutation the picker performs. */
export function withTime(s: string, time: string | null): string | null
```

```ts
// packages/shared/src/calendar.ts

export interface GridDay {
  /** `YYYY-MM-DD`. */
  date: string
  /** False for the leading/trailing days borrowed from the neighbouring months. */
  inMonth: boolean
}

/**
 * Six weeks of seven days covering `month` (1-12) of `year`, Monday-first.
 *
 * **Always six rows**, even when five would cover the month: the popover must
 * not change height when you page between months. Monday-first to match
 * `WEEKDAYS` in TaskDetail, which is already `['mon', …]`.
 */
export function monthGrid(year: number, month: number): GridDay[][]
```

```ts
// packages/shared/src/reminder.ts — after the deletions

/** The hour a TIMELESS reminder fires at. All that is left of the old anchor. */
export const ANCHOR_HOUR = 9

/**
 * When this reminder fires, or null. No `due` argument: a reminder is an
 * absolute moment now, so nothing about it depends on the task's due date.
 */
export function pendingFireTime(
  status: TaskStatus,
  reminder: string | undefined,
  remindedAtLocal: string | undefined,
): string | null

/** Move a reminder by the same delta the due date moved, preserving its own
 *  time-of-day AND its timed-ness. Null leaves the stored string alone. */
export function shiftForRollover(reminder: string, oldDue: string, newDue: string): string | null
```

```ts
// packages/shared/src/labels.ts — `now` is a TIMED stamp, e.g. '2026-08-21T14:03'

export function virtualLabels(task: Pick<Task, 'due'|'priority'|'status'>, now: string): VirtualLabel[]
export function allLabels(task: Pick<Task, 'due'|'priority'|'status'|'tags'>, now: string): string[]
```

The overdue rule, which is the only interesting line in the file:

- `due` **timed** → overdue when `stampEpoch(due, 0) < stampEpoch(now, 0)`.
- `due` **timeless** → overdue when `stampDate(due) < stampDate(now)`.
- `status === 'done'` → never overdue, in both shapes. Unchanged.

```ts
// composites/DateTimePicker.tsx

export interface DatePreset {
  /** What the rail shows, e.g. '1 day before'. */
  label: string
  /** The stamp it writes, already resolved. Computed by the CALLER, because
   *  '1 day before' means nothing without the due date the caller owns. */
  value: string
}

export function DateTimePicker(props: {
  /** A stamp, or null for empty. */
  value: string | null
  onChange: (next: string | null) => void
  /** Rail entries, in order. Empty renders no rail and a narrower popover. */
  presets?: DatePreset[]
  /** Hides the time row entirely — `until` is a date and only a date. */
  dateOnly?: boolean
  placeholder?: string
  /** Forwarded to the trigger, so the field keeps its `data-detail-*` hook. */
  'data-testid'?: string
}): React.JSX.Element
```

**Presets are computed by the caller, not the component.** A preset is a label and a finished stamp; the component never learns what a due date is. That is what keeps a domain-free composite domain-free, and it is why the has-due and no-due vocabularies (spec §5.1) can live in the tasks feature where `task.due` is in scope.

## Deviations from the spec, and why

Two things the spec did not know. Both are recorded here **and patched into the spec** by Task 10.

1. **`reminder` is not validated on write.** Spec §6 says `parseTaskPatch` rejects a non-stamp reminder. It cannot: `PATCH_READERS` is deliberately shared with `parseTaskFile` ("an edit and a hand-written file are held to the same vocabulary, so the board cannot write a file it would then refuse"), so a strict reader would make `reminder: 1d` in a hand-written file break the whole task into `BrokenStrip`. That contradicts the older and better rule this repo already holds: *an unparseable reminder is inert, never an error*. So the reader stays `typeof v === 'string'`, the **picker** is what stops a bad value being written, and a legacy `1d` shows as raw text and quietly never fires — which is also what makes §2.2's "no migration code" true rather than merely convenient. `due` stays strict, as it is today, widened from a date to a stamp.

2. **`nextDueCatchup` compares a timed stamp against a date-only `today`.** `'2026-08-25T14:00' >= '2026-08-25'` is true lexicographically, which is the answer we want — a task due later today has caught up. Leave the comparison alone and say so in a comment, or the next reader will "fix" it.

## Gotchas that will bite

- **`pnpm exec` always** — bare `node`/`npx` are broken here. The shell's cwd drifts between tool calls: use absolute paths, and `--project dom` / `--project node` resolve only from `apps/desktop`.
- **Never `pnpm run format` or `prettier --write`** — it corrupts this repo, and `prettier --check` flags files nobody has touched. `printWidth` is 100; wrap by hand. `awk 'length>100'` counts **bytes**, so every line with an em-dash is over-reported — use Python (`len(line.rstrip())`).
- **eslint must finish with 0 errors and exactly 2 known warnings** (`EditorPane.tsx:240`, `TaskDetail.tsx:~399`). A third is yours — most likely `react-hooks/exhaustive-deps` on the `nowAtom` timer.
- **`virtualLabels` is exported from `@holi/shared` and called in three places.** Changing its parameter is mechanical but it will not typecheck until every caller moves; do Task 5 in one commit rather than trying to land it incrementally.
- **Renderer HMR resets the workspace and the tree's expansion state**; main-process edits (`sweep.ts`, `router.ts`, `seed-content.ts`) **do not restart the dev app at all** — you must kill and relaunch to exercise them.
- **A seeded skill does not reach an existing vault by itself.** `ensureSeeded` refreshes a managed file only while its hash still matches what was recorded; a vault whose copy was reformatted counts as edited and is skipped. Force it through the running app's hook endpoint (port + token in `<vault>/.holi/hook-endpoint.local.txt`): `POST /seed/refresh?t=<token>` with `path=` and `force=true`.
- **CDP reads the pre-render DOM** if you query straight after `dispatchEvent` — React batches from native listeners into a microtask. `await` first. It looks exactly like Fast Refresh having failed; it has not.
- Write commit messages to a file and use `git commit -F` — backticks in a `-m` heredoc get eaten.

---

## Task 1: The stamp vocabulary

**Files:** Modify `packages/shared/src/dates.ts` · Test `packages/shared/test/dates.test.ts`

- [ ] **Step 1: Write the failing tests**

Add a `describe('stamps')`. Cover, one `it` each:

- `parseStamp` on `2026-08-25` → `timed: false`, epoch at UTC midnight.
- `parseStamp` on `2026-08-25T14:30` → `timed: true`, epoch at 14:30.
- `parseStamp` on `2026-08-25T14:30:05` → `timed: true` (seconds are accepted, as `parseDateTime` already accepts them).
- `parseStamp` rejects `1d`, `2w`, `2026-8-5`, `2026-02-30`, `''` — null, never a throw.
- `stampEpoch('2026-08-25', 9)` is nine hours past `stampEpoch('2026-08-25', 0)`; with a timed stamp the `defaultHour` is **ignored**.
- `formatStamp(epoch, false)` drops the time; `formatStamp(epoch, true)` keeps it to the minute. Round-trip both through `parseStamp`.
- `stampDate`/`stampTime` on both shapes, and null for both on rubbish.
- `withTime` adds, replaces and removes a time; removing from an already-timeless stamp is a no-op that returns an equal string; `withTime` on rubbish is null.

- [ ] **Step 2: Run them and watch them fail**

```bash
cd /Users/nicolaibthomsen/repos/syv/better-holi-final
pnpm --filter @holi/shared exec vitest run test/dates.test.ts
```
Expected: fails to import — `parseStamp` is not exported.

- [ ] **Step 3: Implement**

Contracts above. Build every one of them on the existing `DATE_RE`/`DATETIME_RE` and `parseDate`/`parseDateTime` rather than writing a third regex — the validity rules (`isRealDate`, hour/minute bounds) already live there and must not be duplicated. Keep the module's existing doc-comment framing: local-naive, arithmetic on UTC epochs, no timezone logic.

- [ ] **Step 4: Run them and watch them pass**

Same command. Expected: PASS, 248-suite total grows.

- [ ] **Step 5: Commit**

Message: `feat(shared): a date and a datetime are one type with a flag` — the body should say why `timed` is carried rather than inferred at each call site (the absence of a time is meaningful data, not a formatting choice) and that the strict parsers stay as the layer underneath.

---

## Task 2: The month grid

**Files:** Create `packages/shared/src/calendar.ts` · Modify `packages/shared/src/index.ts` · Test `packages/shared/test/calendar.test.ts` *(new)*

- [ ] **Step 1: Write the failing tests**

- A month starting on a Monday (June 2026 — check it) has no leading borrowed days.
- A month starting on a Sunday borrows six leading days, because the grid is Monday-first.
- February 2028 (leap) contains `2028-02-29` with `inMonth: true`.
- Every result is **exactly 6 rows of 7**, for a five-week month and a six-week one alike.
- Consecutive days: flattening the grid yields dates one day apart throughout, including across the month boundaries.
- `monthGrid(2026, 13)` and `monthGrid(2026, 0)` — decide and assert: out-of-range month returns the grid for the normalised month or throws. Pick one; do not leave it undefined.

- [ ] **Step 2: Run them and watch them fail**

```bash
cd /Users/nicolaibthomsen/repos/syv/better-holi-final
pnpm --filter @holi/shared exec vitest run test/calendar.test.ts
```
Expected: cannot resolve `../src/calendar`.

- [ ] **Step 3: Implement**

Pure arithmetic on `Date.UTC` and the `DAY_MS`/`formatDate` helpers already in `dates.ts`. Monday-first means `(getUTCDay() + 6) % 7`. Export from `index.ts` alongside the others.

- [ ] **Step 4: Run them and watch them pass**

- [ ] **Step 5: Commit**

Message: `feat(shared): a month is six rows of seven, always` — the body should say why the row count is fixed (a popover that changes height as you page between months is a worse bug than a wasted row) and why the grid lives in shared rather than in the component.

---

## Task 3: A reminder is a moment

**Files:** Modify `packages/shared/src/reminder.ts`, `apps/desktop/src/main/reminders/sweep.ts` · Test `packages/shared/test/reminder.test.ts`

- [ ] **Step 1: Rewrite the tests first**

The existing file tests a grammar that is being deleted; expect to remove most of it. What replaces it:

- `pendingFireTime` on a timed reminder returns it verbatim.
- `pendingFireTime` on a **timeless** reminder returns that date at `ANCHOR_HOUR`.
- A `done` task is never pending, in both shapes.
- A watermark at or after the fire time suppresses it; one before it does not. Keep whatever boundary case the current suite has — it is the one that matters.
- `1d`, `2w` and rubbish are **inert** (null), not throws. This is the rule that survives the deletion and it needs a test that names it.
- `shiftForRollover` moves a timed reminder by the due delta and keeps its clock time across the move.
- `shiftForRollover` moves a **timeless** reminder and it stays timeless.
- `shiftForRollover` where the due dates themselves carry times — the delta is whole days, so assert the reminder does not drift by hours.

- [ ] **Step 2: Run them and watch them fail**

```bash
cd /Users/nicolaibthomsen/repos/syv/better-holi-final
pnpm --filter @holi/shared exec vitest run test/reminder.test.ts
```

- [ ] **Step 3: Implement**

Delete `ReminderSpec`, `parseReminder`, `resolveReminder`. Rewrite the module doc comment — it currently documents the relative form as the headline and must not survive as a lie. `pendingFireTime` drops its `due` parameter; update the one call in `sweep.ts` (~line 52). Nothing else in main reads these.

- [ ] **Step 4: Run them and watch them pass**, then `pnpm typecheck` from the repo root to catch any caller the grep missed.

- [ ] **Step 5: Commit**

Message: `feat(shared): a reminder is a moment, not an offset` — the body should carry the reasoning from spec §2.1: the relative form was never the stored thing anyone wanted, it hid a 09:00 nobody chose, and as a preset it gains a time it could never express.

---

## Task 4: Recurrence keeps the time

**Files:** Modify `packages/shared/src/recurrence.ts` · Test `packages/shared/test/recurrence.test.ts`

- [ ] **Step 1: Write the failing tests**

- `nextDue('2026-08-25T14:00', weekly)` → `2026-09-01T14:00`. The time survives.
- `nextDue('2026-08-25', weekly)` → `2026-09-01`, still timeless. The absence survives too.
- Monthly day-clamping (whatever case the suite already has for the 31st) keeps the time.
- `endDate` is compared on the **date half**, so a timed due on the end date is still allowed.
- `nextDueCatchup` across several steps preserves the time, and a timed due on `today` counts as caught up.

- [ ] **Step 2: Run them and watch them fail**

```bash
cd /Users/nicolaibthomsen/repos/syv/better-holi-final
pnpm --filter @holi/shared exec vitest run test/recurrence.test.ts
```

- [ ] **Step 3: Implement**

Split the stamp on the way in, do the existing arithmetic on the date half untouched, re-attach on the way out. `parseDate` calls become `stampDate` + `parseDate`. Do **not** move the arithmetic onto epochs-with-time: the month/year helpers clamp on calendar days and a time component would only be along for the ride. Add the comment Deviations §2 asks for on the `next >= today` compare.

- [ ] **Step 4: Run them and watch them pass**

- [ ] **Step 5: Commit**

Message: `fix(shared): a repeating task keeps the hour it was due at`.

---

## Task 5: Overdue honours the time

**Files:** Modify `packages/shared/src/labels.ts`, `apps/desktop/src/renderer/src/state/tasks.ts`, `features/tasks/BoardView.tsx`, `features/tasks/FilterBar.tsx` · Test `packages/shared/test/labels.test.ts`

One commit, because the signature change does not typecheck until every caller has moved.

- [ ] **Step 1: Write the failing tests**

- Timed due, `now` one minute before → not overdue; one minute after → overdue.
- Timeless due, `now` late on the same day → **not** overdue; `now` any time the next day → overdue. This is the boundary the day-granular rule gets right and must keep getting right.
- `done` is never overdue in either shape.
- Priority labels are unaffected by the parameter change (guards against a copy-paste that drops them).
- An unparseable `due` produces no `overdue` label rather than throwing.

- [ ] **Step 2: Run them and watch them fail**

```bash
cd /Users/nicolaibthomsen/repos/syv/better-holi-final
pnpm --filter @holi/shared exec vitest run test/labels.test.ts
```

- [ ] **Step 3: Implement**

`labels.ts` per the contract. Then the renderer:

- `todayAtom` becomes `nowAtom`, holding `YYYY-MM-DDTHH:MM` — **minute-valued, so its identity changes at most once a minute** however often the timer fires, and the board re-renders on the clock rather than on the tick. Drive it from a 30s `setInterval` in a small effect mounted once (Shell is the natural home; a module-level interval would survive HMR and multiply).
- `todayAtom` stays, derived: `stampDate(get(nowAtom))`. `todayLinkCountAtom` and the daily-note callers keep working untouched — check them rather than assuming.
- `matchesFilter(task, filter, now)` and `availableLabels(tasks, now)` take `now`; update `BoardView` (two sites) and `FilterBar` (one).

- [ ] **Step 4: Run the whole shared suite and the dom suite**

```bash
cd /Users/nicolaibthomsen/repos/syv/better-holi-final && pnpm --filter @holi/shared exec vitest run
cd /Users/nicolaibthomsen/repos/syv/better-holi-final/apps/desktop && pnpm exec vitest run --project dom
pnpm typecheck
```

- [ ] **Step 5: Commit**

Message: `feat(tasks): a task due at 14:00 is late at 14:01` — the body should say why the day-granular compare could not stay (it would leave the time on `due` decorative, visible in the UI and ignored by the one label that reads it) and why `nowAtom` is minute-valued.

---

## Task 6: `due` accepts a time

**Files:** Modify `packages/shared/src/task-file.ts` · Test `packages/shared/test/task-file.test.ts`

- [ ] **Step 1: Write the failing tests**

- A file with `due: 2026-08-25T14:00` parses, and `writeTaskFile` round-trips it unchanged.
- A file with `due: 2026-08-25` still parses and still round-trips timeless.
- `due: 1d` and `due: nonsense` still throw, with a message naming **both** accepted shapes.
- `parseTaskPatch({ due: '2026-08-25T14:00' })` is accepted; `parseTaskPatch({ due: null })` still clears.
- `reminder: 1d` still parses **without throwing** and lands on the task verbatim — the inert rule, asserted (see Deviations §1).

- [ ] **Step 2: Run them and watch them fail**

```bash
cd /Users/nicolaibthomsen/repos/syv/better-holi-final
pnpm --filter @holi/shared exec vitest run test/task-file.test.ts
```

- [ ] **Step 3: Implement**

Widen the `due` reader in `PATCH_READERS` to accept either shape (reuse `parseStamp`; do not add a fourth regex) and update its error string. Touch nothing else in the table. Update the `Task.due` / `Task.reminder` doc comments in `types.ts` — they currently say `YYYY-MM-DD` and `Nd | Nw | YYYY-MM-DDTHH:MM`, and both are now wrong.

- [ ] **Step 4: Run them and watch them pass**

- [ ] **Step 5: Commit**

Message: `feat(shared): a due date may name an hour`.

---

## Task 7: The picker

**Files:** Create `apps/desktop/src/renderer/src/composites/DateTimePicker.tsx` · Modify `composites/index.ts` · Test `apps/desktop/src/renderer/src/composites/__tests__/DateTimePicker.test.tsx` *(new)*

- [ ] **Step 1: Write the failing tests** (dom project)

- Clicking a preset calls `onChange` with **that preset's `value`, verbatim** — the component resolves nothing.
- Clicking a day in the grid keeps the current time (`2026-08-25T14:00` + click the 27th → `2026-08-27T14:00`).
- Clicking a day when the value is timeless produces a timeless stamp.
- Clicking a day when the value is `null` produces a **timeless** stamp — a date you picked is a day until you say otherwise.
- `+ add a time` appears only for a timeless value; using it produces a timed stamp (assert the default hour it seeds).
- Clearing the time returns a timeless stamp; clearing the value returns `null`.
- A timeless value renders in the trigger **without** a time; a timed one renders with it.
- `dateOnly` renders no time row at all.
- An unparseable value (`'1d'`) renders in the trigger verbatim rather than crashing or showing "Invalid Date".

- [ ] **Step 2: Run them and watch them fail**

```bash
cd /Users/nicolaibthomsen/repos/syv/better-holi-final/apps/desktop
pnpm exec vitest run --project dom src/renderer/src/composites/__tests__/DateTimePicker.test.tsx
```

- [ ] **Step 3: Implement**

Contract above. Shape per spec §5: trigger styled as the field (right-aligned humanised value + a `lucide-react` `Calendar` icon, muted placeholder when empty), `PopoverContent` at `w-90`-ish overriding the primitive's `w-72`, two columns — preset rail left, grid right, time row under the grid.

Decisions worth not re-deriving:

- **All date arithmetic comes from `@holi/shared`.** `monthGrid` for the grid, `withTime`/`stampTime`/`stampDate` for every edit, `parseStamp` for the trigger's label. If you find yourself writing `new Date(...)` in this file, the helper you want is missing from Task 1.
- The visible month is local state seeded from the value (or today when null), not derived on each render — paging must survive a re-render.
- Selected day, today, and out-of-month days are three distinct treatments; out-of-month days are still clickable and page the view.
- Use `Button` for every clickable cell rather than a bare element — the eslint gate bans native `<button>` outside primitives.
- The trigger takes the field styling the sidebar rows now use, so it lines up with the `Select` triggers beside it.

- [ ] **Step 4: Run them and watch them pass**

- [ ] **Step 5: Commit**

Message: `feat(ui): one control for a date, an optional time, and the shortcuts to both` — the body should say why the presets are the caller's (a composite that knew what a due date was would not be a composite) and why the grid math lives in shared.

---

## Task 8: Wire the fields

**Files:** Modify `features/tasks/TaskDetail.tsx`, `features/tasks/CreateTask.tsx`

- [ ] **Step 1: Build the preset lists**

A module-local helper in `TaskDetail.tsx` — `reminderPresets(due, now)` and `duePresets(now)` — returning `DatePreset[]` per spec §5.1, each label carrying the resolved date so the rail shows what it will write. It is pure and it takes `now`, so if it grows past a few lines it belongs in `apps/desktop/test/` as node-tested logic; start it here and move it if it does.

Rules that are easy to get wrong: "1 hour before" appears **only** when `due` is timed; the no-due vocabulary is "in 1 week", not "1 week before"; "on the day" writes `due`'s date at 09:00, not a timeless stamp.

- [ ] **Step 2: Replace the three fields**

`due` and `reminder` become `DateTimePicker`s; `until` becomes one with `dateOnly` and no presets. Keep the existing `data-detail-due` / `data-detail-reminder` / `data-detail-recurrence-end` hooks on the triggers — the verification step and any future probe find the fields by them.

**Delete `DATE_FIELD`** and its `::-webkit-datetime-edit` comment. It exists only to right-align a native date input, and there are no native date inputs left.

- [ ] **Step 3: `CreateTask`**

Same two pickers for the draft's `due`/`reminder`. The draft holds strings already, so this is a control swap; `RecurrenceRows` is shared and comes along for free.

- [ ] **Step 4: Gates**

```bash
cd /Users/nicolaibthomsen/repos/syv/better-holi-final/apps/desktop
pnpm exec vitest run --project dom
pnpm typecheck
pnpm exec eslint src
```

- [ ] **Step 5: Commit**

Message: `feat(tasks): pick a date instead of typing a rule`.

---

## Task 9: Verify it in the running app

Nothing here is provable in jsdom: popover placement, whether the rail fits, and whether a real click writes a real file.

- [ ] **Step 1: Relaunch**

Main-process changes landed in Tasks 3 and 10, so a relaunch is mandatory rather than optional.

```bash
cd /Users/nicolaibthomsen/repos/syv/better-holi-final/apps/desktop
pnpm exec electron-vite dev -- --remote-debugging-port=9333
```
Drive it with `apps/desktop/cdp.mjs` (`pnpm exec node cdp.mjs '<expr>'`, `--shot <file>`).

- [ ] **Step 2: Check, in the app, and write down what you saw**

- Open the board, select a task, open the `due` picker: the popover fits on screen beside a 320px panel and does not clip at the window edge.
- Pick a preset; confirm the **file on disk** now holds the stamp you expect (`grep '^due:' <task file>`), not just that the UI changed.
- Give it a time, then clear the time; confirm the file loses the `T` and keeps the date.
- Set a due date in the past with a time, and confirm the `overdue` chip appears — this is the only place Task 5's rule is exercised end to end.
- Open `reminder` on a task **with** a due date and on one **without**, and confirm the rail's vocabulary changes between them.
- Screenshot both popovers.

- [ ] **Step 3: Write `docs/verification/2026-08-21-task-datetime.md`**

What was checked by hand, what could not be, and any environment note the next agent needs. Commit it.

---

## Task 10: The skill, and the docs

**Files:** Create `apps/desktop/src/main/agent/skills/using-tasks/SKILL.md` · Modify `agent/seed-content.ts`, `docs/prd/tasks.md`, `docs/decisions.md`, `docs/specs/2026-08-21-task-datetime-design.md`

- [ ] **Step 1: Write the skill**

Frontmatter `name: using-tasks` and a `description` that fires on "task", "due date", "reminder", "recurring". Content: the task-file shape, the frontmatter vocabulary, **the two stamp shapes and that a reminder is an absolute moment**, that a timeless reminder fires at 09:00, how completion rolls a recurring task forward, and that a task's lane is its folder. Follow the seeded `theme` skill's register — short, tabular where it can be, with the "check your work" closing note.

- [ ] **Step 2: Register it as MANAGED**

In `seed-content.ts`, add `.claude/skills/using-tasks/SKILL.md` to `MANAGED_FILES` (the `?raw` import + the map entry), **not** to the once-files. Managed means a later edit of ours reaches vaults that already exist.

- [ ] **Step 3: Test the seed**

`apps/desktop/test/seed-content.test.ts` already asserts over the seed maps — extend it so the new path is covered, and check whether any existing test asserts an exact file count.

- [ ] **Step 4: Deliver it to `privat` and read it back**

The app must be running (Task 9). Port and token from `~/Holi/nthomsencph/privat/.holi/hook-endpoint.local.txt`:

```bash
curl -sS --fail-with-body -X POST "http://127.0.0.1:$PORT/seed/refresh?t=$TOKEN" \
  --data-urlencode "force=true" --data-urlencode "path=.claude/skills/using-tasks/SKILL.md"
```
Then `cat` the vault's copy and confirm it is the new content.

- [ ] **Step 5: Docs**

- `docs/prd/tasks.md` — the `reminder?: string` comment, the frontmatter example, §Recurrence & reminders' grammar clause, and the "I set a reminder '1d'" story, which is now a story about picking "1 day before".
- `docs/decisions.md` — the D79 inbox row, and flip the header line from "designed, not built".
- The spec — fold in both Deviations, so it stays true rather than becoming a record of what we intended.

- [ ] **Step 6: Commit**

Message: `docs: a task's dates are stamps you pick — D79` , plus a separate `feat(agent): a skill that says what a task file holds` if the skill lands on its own.

---

## Final gates

Run all of these before calling the work done.

```bash
cd /Users/nicolaibthomsen/repos/syv/better-holi-final/apps/desktop
pnpm exec vitest run --project node      # 1574 + new; ~2.5 min
pnpm exec vitest run --project dom       # 478 + new
pnpm typecheck
pnpm exec eslint src                     # 0 errors, exactly 2 known warnings

cd /Users/nicolaibthomsen/repos/syv/better-holi-final
pnpm --filter @holi/shared exec vitest run   # 248 + new
```

Mutation-check every test written **after** its implementation: break the code on purpose and confirm the test goes red. Two vacuous tests shipped in the movable-tabs work and both looked fine on the page.

Commit straight to `main`, trailer `Claude goes brr.. via Dash`. **Ask Nicolai before pushing** — he approves every push.
