# Verification — task dates as stamps (D79)

Checked by hand in the running app on 2026-08-21, against
`docs/plans/2026-08-21-task-datetime.md` Task 9. Driven over CDP
(`apps/desktop/cdp.mjs`, port 9333) against the `privat` vault, in a 1200×768 window.

The app was **relaunched** for this rather than reloaded: Task 3 changed `sweep.ts`, and
main-process edits do not restart the dev app.

---

## What was checked, and what it showed

**1 — The popover fits.** Opened on `reminder` in the 320px detail panel: 422×291 at x=778 in a
1200px window, so its right edge lands exactly on the window's. It does not clip. It is wider
than the ~360px the spec guessed at, because the rail has to hold a label *and* the date it
resolves to; at the spec's width the hints overflowed into the calendar and the two columns
overlapped visibly. Caught by screenshot, not by a test — no assertion in the suite would have
noticed. Radix shifts the popover when it does not fit, so a narrower window degrades rather
than breaks; that was **not** exercised.

**2 — A preset writes the file, not just the field.** Clicked "tomorrow" on a task with no due
date. The trigger read `22 Aug 2026, 09:00` and the file on disk read:

```
reminder: 2026-08-22T09:00
```

This is the point of the whole change: the file says the moment, in a form a person reads
without a parser.

**3 — Removing the time removes the `T`.** Same task, "remove the time" → trigger `22 Aug 2026`,
file `reminder: 2026-08-22`. The two shapes round-trip through the picker without the value
being rewritten behind you.

**4 — Adding a time adds the anchor hour.** Set `due` to 3 August by paging back a month and
clicking the day, then `+ add a time` → file `due: 2026-08-03T09:00`. Picking a day on an empty
field wrote a bare `2026-08-03` first, which is the rule: a task is due on a day until you say
otherwise.

**5 — Overdue honours the time, end to end.** With `due: 2026-08-03T09:00` in the past, the card
showed the `overdue` chip. This is the only place Task 5's rule is exercised through the real
clock rather than an injected `now`.

**6 — The two reminder vocabularies switch on the due date.** Same task, before and after:

| no due date | with `due: 2026-08-03T09:00` |
|---|---|
| in an hour · 21 Aug, 11:36 | on the day · 3 Aug, 09:00 |
| this evening · 21 Aug, 18:00 | **1 hour before · 3 Aug, 08:00** |
| tomorrow · 22 Aug, 09:00 | 1 day before · 2 Aug, 09:00 |
| in 2 days · 23 Aug, 09:00 | 2 days before · 1 Aug, 09:00 |
| … | … |

"1 hour before" appears only in the right-hand column, because only there does the due date name
an hour. The hints resolve against the real clock — 11:36 was the actual time of the check.

**7 — The card humanises the stamp.** `due 2026-08-03T09:00` on a card was a stamp, not a date.
Fixed during verification (`shortStamp` on the card) → `due 3 Aug, 09:00`. This was a real
regression introduced by the change and invisible to the test suite, which asserts on values
rather than on rendering.

---

## What was NOT checked

- **A reminder actually firing.** The sweep's predicate changed shape (`pendingFireTime` lost its
  `due` argument) and is covered by unit tests, but no notification was raised in this session.
  macOS will not deliver notifications from the electron-vite dev binary anyway — that needs a
  packaged build, and the fire-on-disk watermark is the only observable in dev.
- **Recurrence roll-forward with a timed due**, through the real `tasks.complete` path. The math
  is tested in `packages/shared/test/recurrence.test.ts`; the round trip through the router is
  not.
- **A narrow window.** Everything here was 1200px wide. The popover's fallback placement when
  the panel is against the screen edge is Radix's, and untested by us.
- **Keyboard navigation of the grid.** The cells are `Button`s so they are tabbable and
  activatable, but no arrow-key handling was written, and none was checked.

## Test data

`task.find-dag-til-galopbanen-med-mads-co.md` in `privat` was used as the subject and **restored
to its original frontmatter** afterwards (title + status, no due, no reminder). The intermediate
states are in the vault's git history as ordinary `Update …` commits, which is what autosave
does with any edit.

## Environment notes, for whoever drives this next

- **A Radix `PopoverTrigger` does not open on a bare `.click()` over CDP.** It needs the pointer
  sequence — `pointerdown` and `pointerup` dispatched on the trigger first, then `click()`.
  Without them the evaluation returns "no popover" and looks like the component failing to mount.
- **The popover stays open after you pick a day**, deliberately, so you can add a time to what
  you just chose. A probe that "opens" it again therefore *closes* it, and the next query
  throws on a null. Only presets are a complete choice; they close it.
- **`cdp.mjs` resolves only from `apps/desktop`.** The shell's cwd drifts between tool calls and
  the failure is a `MODULE_NOT_FOUND` that reads like a missing file.
- **One flake, not ours:** `editor/__tests__/fence-languages.test.tsx > highlights the language
  the bug was reported against` failed once in a full `--project dom` run, then passed in
  isolation and in two consecutive full runs. Unrelated to this work; noted so the next person
  does not go looking for it in the date code.
