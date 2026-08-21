# A task's dates are stamps, and you pick them — D79

**Status:** designed 2026-08-21, not built. Agreed with Nicolai in brainstorming.
**Replaces:** the reminder grammar ported from the old Rust `services/reminder.rs`
(`prd/tasks.md` §Recurrence & reminders; the `Nd | Nw | YYYY-MM-DDTHH:MM` rule).
**Touches:** `packages/shared` (`dates`, `reminder`, `recurrence`, `labels`, `task-file`,
new `calendar`), the tasks feature and its state, and the seeded agent skills.

---

## 1. The gap

`reminder` is a free-text field with a grammar behind it. You type `1d`, or `2w`, or
`2026-07-20T09:00`, and a parser decides whether you were right; when you are wrong the error
string is the only documentation there is. Nicolai's verdict was short: *"Reminder is a text
input with rules. Not a good user experience."*

The grammar is not only a typing problem. `1d` means **N days before `due`, at 09:00** — and
nobody chose 09:00. It is `ANCHOR_HOUR`, a constant in `reminder.ts`, invisible in the UI and
unstateable in the file. So the field cannot express "the evening before", which is the thing
people actually want, and its most-used value silently means something the user never agreed to.

`due` has the mirror problem from the other end: it is a date and only a date, so a task that
happens *at* a time cannot say so, and the reminder is left to carry a precision the due date
is not allowed to have.

## 2. What a date is now

**One shape, used by both fields: a local stamp.**

```
YYYY-MM-DD              a day
YYYY-MM-DDTHH:MM        a day and a minute
```

Local-naive, no timezone, exactly as `dates.ts` has always treated datetimes. The time is
**optional on both `due` and `reminder`**, and its absence is meaningful rather than a default:
a task due `2026-08-25` is due that day, not at midnight on it.

**A reminder is absolute.** There is no relative form in the file any more. `1d` and `2w` stop
parsing.

**A timeless reminder fires at 09:00** — that is the whole of what `ANCHOR_HOUR` is left doing.
It stays a fallback rather than becoming the written value, so a stamp is never rewritten behind
the user's back; but every preset that *knows* an hour writes it explicitly (see §5.1), so the
common case ends up saying in the file exactly when it will fire.

### 2.1 Why the relative form goes, given it is the common case

Because it was never the *stored* thing people wanted — it was the only way to say it. Making
the relative form a **preset in the picker** keeps the convenience and drops the cost:

- picking "1 day before" writes `2026-08-24T09:00`, and you can then drag the time to 18:00 —
  which the grammar could not express at all;
- the value in the file says when the notification happens, in words a human reads without a
  parser;
- `resolveReminder` stops needing `due`, so the whole class of "relative reminder with no
  parseable due date is inert" disappears rather than being documented;
- a reminder becomes meaningful on a task with **no due date**, which is why the presets have
  a second vocabulary ("in 1 week" rather than "1 week before"). Under the old grammar that
  case was silently dead.

What is lost: on a **repeating** task, a relative reminder used to re-resolve against each new
due date for free. It still works, by a different mechanism — `shiftReminder` already moves an
absolute reminder by the same delta the due date moved on roll-forward, and that path stays.

### 2.2 Migration

**None in code.** `grep '^reminder:'` across the `privat` vault returns nothing, so there is no
relative value in the wild to preserve; three task files carry `due:`, and those stay valid
because the time is optional. Any that turn up later are migrated by hand. `parseReminder` gets
no legacy branch, and `1d` is rejected with a message naming the new format.

## 3. Overdue honours the time

`virtualLabels(task, now)` — `now` is a full stamp, not a date.

- `due` **with** a time → overdue once that minute has passed.
- `due` **without** a time → overdue once the *date* has passed. An all-day task due today is
  not late at 00:01, which is the boundary the current day-granular rule gets right and must
  keep getting right.

This is the widest change in the design and it is deliberate. Keeping the day-granular compare
would have made the time on `due` decorative — visible in the UI, ignored by the one label that
reads it. `allLabels`, `matchesFilter` and `availableLabels` take `now` for the same reason.

`todayAtom` becomes `nowAtom`, a minute-valued string ticked on a timer, with `todayAtom`
derived from it for the daily-note filename. Minute-valued on purpose: the atom's identity then
changes at most once a minute however often the timer fires, so the board re-renders on the
clock, not on the tick.

## 4. Recurrence keeps the time

`nextDue` and `nextDueCatchup` advance the **date** part and re-attach the original time, so a
task due `2026-08-25T14:00` repeating weekly lands on `2026-09-01T14:00`. `endDate` (`until`)
stays date-only — it is a boundary on the rule, not an appointment, and a rule that ends at
14:00 on a Tuesday means nothing.

## 5. The control

`composites/DateTimePicker.tsx`. Domain-agnostic (a stamp in, a stamp out), so it sits in
composites, not in the tasks feature — `due`, `reminder` and `until` are three callers of one
control, and that is what makes them read as one system.

**Trigger.** Styled as the field it replaces: right-aligned humanised value plus a calendar
icon, a placeholder when empty. It matches the row treatment the sidebar already uses.

**Popover.** Radix, via the existing `Popover` primitive, ~360px, two columns — the preset rail
on the left, the month grid on the right, and a time row beneath the grid. This is the shape
that shows everything at once; it overhangs the 197px field, which is the price, and it was
chosen over a narrower stacked variant and a two-step menu because nothing about the value is
hidden behind a second click.

**The time row** is where "optional" lives. Timeless shows `+ add a time`; timed shows an
`HH:MM` field and a control to clear it back to timeless. No checkbox, no sentinel hour.

**The month grid holds no date arithmetic.** `packages/shared/src/calendar.ts` exports
`monthGrid(year, month)` returning weeks of `{date, inMonth}`, pure and tested in the node
project alongside the rest of the date math. Hand-rolled rather than `react-day-picker`: the
repo has no date library at all, the grid is a small amount of arithmetic on helpers that
already exist, and the alternative brings a second class-name API to theme. The cost we accept
is writing the keyboard and focus behaviour ourselves.

### 5.1 Presets

Every preset renders the date it resolves to, so choosing one is never a guess.

**Reminder, when `due` is set** — relative to due:
on the day · 1 hour before *(only when `due` carries a time)* · 1 day before · 2 days before ·
3 days before · 1 week before · 2 weeks before.

**Reminder, when `due` is not set** — relative to now:
in 1 hour · later today (18:00) · tomorrow 09:00 · in 2 days · in 3 days · in 1 week ·
in 2 weeks.

**Due:** today · tomorrow · in 2 days · in 3 days · next Monday · in 1 week · in 2 weeks.

A preset that resolves to a timeless day writes a timeless stamp; one that names an hour writes
the hour. "On the day" writes `due`'s date at 09:00, because a reminder with no time is a
notification with no moment.

## 6. The agent

`parseTaskPatch` accepts both stamp shapes for `due` and `reminder` and rejects anything else
with a message that names the format — the same "the error is the doc" rule the old grammar
followed, applied to a smaller grammar.

A new seeded skill, `.claude/skills/using-tasks/SKILL.md`, **managed** under D75 so it reaches
existing vaults: the task frontmatter vocabulary, the two stamp shapes, that a reminder is an
absolute moment and not an offset, how roll-forward moves both fields, and the task-relevant
`holi` CLI. This is the counterweight to deleting a grammar the agent could write from memory —
the format is simpler, and now it is written down where the agent will find it.

## 7. Testing

**Node project** (`apps/desktop/test/`, `packages/shared/test/`):

- `dates` — `parseStamp` on both shapes and on rubbish; `stampEpoch` with and without a default
  hour; `formatStamp` round-trips.
- `calendar` — `monthGrid` for a month starting on a Sunday, a Monday, a leap February, and a
  31-day month that needs six rows.
- `reminder` — resolve (timeless → 09:00), the pending rule, `shiftReminder` preserving the
  reminder's own time across a due move.
- `recurrence` — `nextDue` preserves the time part; `nextDueCatchup` preserves it across
  several steps; a date-only due stays date-only.
- `labels` — overdue with a timed due either side of the minute; overdue with a timeless due
  either side of midnight; a done task is never overdue in either shape.
- `task-file` — both shapes round-trip through parse → write unchanged.

**DOM project** (`src/renderer/**/*.test.tsx`):

- a preset click writes the expected stamp for the has-due and no-due cases;
- a calendar click changes the date and keeps the time;
- `+ add a time` and clearing it move between the two shapes;
- a timeless value renders without a time in the trigger.

Tests written after their implementation get mutation-checked — break the code, confirm the
test goes red — because two vacuous tests shipped in the movable-tabs work and both looked fine.

## 8. Doc changes this lands

- `prd/tasks.md` — the `reminder?: string` comment, the frontmatter example, §Recurrence &
  reminders' grammar clause, and the "I set a reminder '1d'" story.
- `docs/decisions.md` — the D79 row.
- `docs/architecture.md` §Tasks, if the stamp type is worth naming there.
- The seeded `using-tasks` skill (new), and whatever in the existing skills references the old
  reminder grammar.

## 9. Deferred

- **Timezones.** Stamps stay local-naive. A vault synced between machines in different zones
  already had this question and already answers it the same way.
- **`until` gaining a time.** Nothing wants it.
- **A "remind me again" / snooze.** The delivered-watermark makes it possible; nothing asks
  for it yet.
