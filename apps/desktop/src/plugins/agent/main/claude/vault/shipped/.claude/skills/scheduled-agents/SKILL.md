---
name: scheduled-agents
description: Create, change, list, run or turn off scheduled agents — a prompt Holi runs on this machine on a cron schedule or once at a set time, as a background session in this vault. Use whenever the user wants something done "every 30 minutes", "each morning", "on weekdays at 9", "tomorrow at 15:00", or wants a recurring check (mail, a feed, the board) that drafts, files tasks or starts work on its own. Use this, not cloud routines, for anything in this vault.
---

# Scheduled agents

A scheduled agent is **one markdown file** in `.holi/schedules/`. Holi reads it,
and at the times it names starts a background Claude Code session in this vault
whose first message is the file's body. The run is an ordinary session: it shows
in the sidebar under the schedule's name, it can be opened, and Claude Code asks
the user about anything the schedule does not allow up front.

Schedules run **on this machine, while Holi has the vault open**. A run missed
while Holi was closed or the laptop slept happens once when it is back, not
once per missed time.

## The file

```markdown
---
name: Inbox triage
cron: "*/30 7-18 * * 1-5"
model: sonnet
allow:
  - Bash(holi google search:*)
  - Bash(holi google read:*)
  - Bash(holi google draft:*)
  - Bash(holi google mark-read:*)
  - Write
  - Edit
---
Look through my unread mail since the previous run (`holi google search
'is:unread in:inbox'`, then `holi google read` the new threads). For each:

- A question I can answer from the vault: draft a reply with `holi google draft`.
  Never send.
- Something I have to do: create a task file (see the using-tasks skill) that
  links the thread's `webUrl`.
- A customer asking for an offer (tilbud): start a draft under `tilbud/` named
  after the customer, from what the mail says, and create a task to review it.
- Newsletters and notifications: leave them.

Finish with a short summary of what you did and what needs me.
```

| field | |
|---|---|
| `name` | What the sidebar and the Schedules settings show. Defaults to the file name. |
| `cron` | Five fields, **this machine's local time**: `minute hour day month weekday`. Quote it. |
| `at` | Instead of `cron`: once, at a quoted local `"YYYY-MM-DDTHH:MM"`. |
| `model` | Optional: `sonnet`, `opus`, `haiku` or a full model id. A frequent check is cheaper on `sonnet` or `haiku`. |
| `allow` | Optional: Claude Code permission rules the run may use **without asking**, the same syntax as `settings.json`. Everything else still asks the user. |

Cron examples (local time, no UTC conversion needed):

| | |
|---|---|
| `*/30 * * * *` | every 30 minutes |
| `*/30 7-18 * * 1-5` | every 30 minutes, 07:00–18:59, weekdays |
| `0 8 * * 1-5` | weekdays at 08:00 |
| `0 9 * * 1` | Mondays at 09:00 |
| `0 7 1 * *` | the 1st of each month at 07:00 |

Nothing runs more often than every 5 minutes; Holi refuses a schedule that would.

Name the file after what it does, in kebab case: `.holi/schedules/inbox-triage.md`.
A file named `*.local.md` stays on this machine and never syncs; use that when the
prompt mentions anything personal, or the user does not want teammates to see it.

## Writing the prompt

**Nobody is watching when it runs.** The prompt is all the run knows: it starts
with no conversation behind it. So:

- Say exactly what to look at and what counts as new. Holi puts one line above the
  prompt with the run's time and the previous run's time, so "since the previous
  run" works.
- Say what to do with each kind of finding, and what to leave alone.
- **Leave results where the user will find them**: a task file, a draft, a note.
  A run that only answers in its own session is easy to miss.
- Prefer reversible actions. Drafting is fine; sending is not something a
  schedule should do: `holi google send` and `reply` always ask, and the run
  will sit waiting until the user answers.
- End with a short summary.

**`allow` is what makes it unattended.** Any tool call not covered stops the run
at a permission prompt until the user answers (the session shows as needing
them). List the narrowest rules the prompt needs (`Bash(holi google search:*)`,
not `Bash`). Writing tasks and drafts in the vault needs `Write` and `Edit`.
Rules that ask (`curl`, sending mail, `holi schedules enable`) keep asking
whatever `allow` says.

## Turning it on

Writing the file does not make it run. Turning it on approves its prompt, model
and `allow` list for this machine:

```sh
holi schedules enable inbox-triage
```

The user is asked to confirm. Show them the file first and say what it allows.
**Any later change to the prompt, model or `allow` turns it back off** ("changed")
until it is enabled again: whoever edits a schedule (a teammate's pull, a run of
the schedule itself) cannot change what runs unattended without the user's yes.
Changing only `cron`, `at` or `name` keeps it on.

A schedule pulled from a teammate is off on this machine until enabled here.

## The other commands

```sh
holi schedules list                 # status, when, next and last run of each
holi schedules run inbox-triage     # one run now (it must be on); asks the user
holi schedules disable inbox-triage # off on this machine; the file stays
```

`list` prints one line per schedule: `on|off|changed|invalid`, the slug, the
name, when it runs (or why the file is invalid), the next and last run.
`--json` gives everything, including each schedule's recent runs.

To delete a schedule, delete its file. To change one, edit the file, then enable
it again if the prompt, model or `allow` changed.

The user can see, turn on and off, and run schedules in **Settings → Schedules**
too.

## Do not

- Do not use Claude Code's `/schedule` cloud routines or `/loop` for this: they
  run away from this vault, Holi and the user's Google account.
- Do not use `cron`, `launchd` or any other system scheduler: Holi is what
  runs schedules, and it pauses sync around each run.
- Do not enable a schedule the user has not seen.
