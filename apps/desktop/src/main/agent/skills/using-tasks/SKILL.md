---
name: using-tasks
description: Read and write this vault's tasks — the frontmatter a task file holds, due dates and reminders, recurrence, and where a task lives. Use when asked to add, find, change, schedule, remind about, or complete a task, or when writing a task file by hand.
---

# Tasks in this vault

**A task is a file.** There is no database and no task id: `task.<slug>.md`, ordinary
markdown with frontmatter, living anywhere in the vault. Create one by writing the
file; change one by editing it. The board reads the files.

## The file

```markdown
---
title: Book the rehearsal room
status: todo
due: 2026-08-25
priority: high
tags: [music, admin]
reminder: 2026-08-24T18:00
recurrence:
  frequency: weekly
  interval: 1
  weekdays: [mon, thu]
  endDate: 2026-12-31
---

Anything below the frontmatter is the task's body. It is ordinary markdown, so
[[wiki-links]] work — that is how a task links to a note, a person, or another task.
```

Every field except `title` and `status` is optional. A field you leave out is simply
absent — do not write `due:` with nothing after it and do not write `null`.

| field | what it holds |
|-------|---------------|
| `title` | the task, in words. Falls back to the filename if missing |
| `status` | `todo`, `doing` or `done` — nothing else |
| `due` | when it is due, as a **stamp** (below) |
| `priority` | `high`, `medium` or `low` |
| `tags` | a list of strings, your own vocabulary |
| `reminder` | when to notify, as a **stamp** — a moment, not an offset |
| `recurrence` | a map, see below |

Anything else you put in the frontmatter is **carried through untouched**. Holi does
not understand it and does not delete it.

## Stamps: `due` and `reminder`

Both hold the same shape — a local date, and optionally a time:

```
2026-08-25          a day
2026-08-25T18:00    a day and a minute
```

No timezone, ever. It is wall-clock time on the machine.

**The time is optional and its absence means something.** A task due `2026-08-25` is
due *that day* — it does not go overdue until the day has passed. A task due
`2026-08-25T14:00` goes overdue at 14:01.

**A reminder is an absolute moment.** It is not "two days before the due date". If
you want to remind someone two days before something due on the 25th, work out the
date and write it:

```yaml
due: 2026-08-25
reminder: 2026-08-23T09:00
```

A reminder with no time fires at **09:00**. A reminder that is not a stamp — `1d`,
`2w`, `next tuesday` — is **inert**: the file stays valid, the value is preserved,
and nothing ever fires. That is deliberate, so a typo costs a notification rather
than a task; but it means a reminder you invent the format for silently does
nothing. Write a stamp.

A `due` that is not a stamp is a different matter: it is an **error**, and the task
shows up in the board's "could not be read" strip until you fix it.

## Recurrence

A map, not a string — there is no text grammar for it:

```yaml
recurrence:
  frequency: daily | weekly | monthly | yearly
  interval: 1          # every N of those
  weekdays: [mon, wed] # weekly only; omit for "same weekday as due"
  endDate: 2026-12-31  # optional, a date — never a datetime
```

**Roll-forward happens when the task is completed**, not on a schedule. Completing a
recurring task advances `due` by the rule, moves `reminder` by the same number of
days (keeping its own time of day), and sets `status` back to `todo`. A recurring
task with no `due` never rolls — there is nothing to advance from.

Complete a recurring task by setting `status: done` **through the app or by asking
for it to be completed**, not by writing `done` into the file: writing it by hand
records the task as finished instead of rolling it forward.

## Where a task lives

**The folder is the lane.** A task in `music/` shows in the `music` swim lane; one at
the vault root shows under `(vault root)`. To move a task between lanes, move the
file — but a plain `mv` leaves every `[[wiki-link]]` pointing at it dangling. Ask for
the move, or use the file tree's rename, both of which rewrite the inbound links in
the same pass.

## Tips

- **Finding tasks is a grep.** They are files: `task.*.md` with `status: todo` in the
  frontmatter. There is no index to query and no API to call.
- Writing a whole task file at once is fine and is the fastest way to create one.
  Use the title's slug for the filename — lowercase, dashes, no punctuation.
- After changing a `due` or `reminder`, check the value you wrote is a stamp. It is
  the one field where a wrong format fails quietly.
