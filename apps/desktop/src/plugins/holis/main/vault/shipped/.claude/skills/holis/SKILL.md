---
name: holis
description: Create or change Holis, agents of this vault with a soul and a memory (a "Proposal" Holi that turns a customer note into a PDF, an "Assistant" that carries out a morning digest), keep a Holi's memory, and say what came of a Holi's run. Use when the user wants a reusable agent, mentions a Holi, or when you are running as a Holi. For work on a schedule, write an automation (the scheduled-agents skill) and name the Holi that carries it out.
---

# Holis

A Holi is **a folder** in `.holi/holis/`: an agent with a name and a face, a
soul and a memory. The user sends it a document from the menu beside a
document's **Agent** button, or gives it an automation to carry out on a
schedule. Either way it runs as Claude Code in this vault, with the user there
to answer your permission prompts.

```
.holi/holis/proposal/
  holi.yaml   who it is and what it may do
  SOUL.md     its standing instructions
  MEMORY.md   what it has learned, one dated fact a line
  memory/     topic notes read on demand, and archive.md
```

## holi.yaml

```yaml
name: Proposal
mascot: captain
description: Turns a customer note into a PDF proposal
model: sonnet
accepts:
  - kunder/**/*.md
allow:
  - Edit(tilbud/**)
```

| key           |                                                                                                                                          |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `name`        | What Holi shows. Defaults to the folder name.                                                                                            |
| `mascot`      | Optional: its face, `captain`, `strategist`, `skipper`, `spy`, `professor`, `operator`, `starter`, `scout`, `champion` or `benchmarker`. |
| `color`       | Optional: a quoted `'#rrggbb'`.                                                                                                          |
| `description` | Optional: one line on what it is for.                                                                                                    |
| `model`       | Optional: `sonnet`, `opus`, `haiku` or a full model id.                                                                                  |
| `accepts`     | Optional: vault paths it can be sent, as globs (`kunder/**/*.md`). Omitted: any document.                                                |
| `allow`       | Optional: Claude Code permission rules a run may use **without asking**. Everything else asks the user.                                  |

There is no key for a permission mode or a schedule: a run always keeps Claude
Code's prompts, and a Holi on a clock is an automation that names it. Any key
Holi does not know is kept and ignored.

**Allow writing only where it writes.** Name each folder as an `Edit` rule:
`Edit(tilbud/**)`, `Edit(**/task.*.md)`. Never a bare `Write` or `Edit`, or
`Edit(**)`: Holi refuses those, because a run that could write `AGENTS.md`,
`.holi/`, `.claude/` or a skill could be talked into changing every later run.

## SOUL.md

Who it is, in plain markdown: its role, how it works, what it must never do.
It goes into every run first. Write it as standing instructions, not as a task:
the task is the document it is sent, or the automation's prompt.

```markdown
# Soul

## Standing instructions

- Write proposals in Danish, laid out as Templates/proposal.typ.
- Prices come from Prices.md; never invent one.
```

**The user approves it, per machine.** The first time a Holi runs on their
machine, and again after its soul, `model`, `allow` or `accepts` change, Holi
shows them exactly that and asks. You cannot approve one. After writing or
changing a Holi, tell the user, and say what it may do without asking.

## Memory

`MEMORY.md` is notes the Holi keeps across runs, loaded into each one (up to
200 lines). It is not approved, and not instructions. When you run as a Holi,
keep it with its commands only, never by editing the file:

```sh
holi holis remember proposal "Nordlys wants proposals in English"
holi holis remember proposal "Q4 prices apply" --until 2026-12-31
holi holis remember proposal "Nordlys: contact is Ada, 30 days net" --topic customers
holi holis revise proposal "in English" "Nordlys wants proposals in Danish again"
holi holis forget proposal "Q4 prices"
holi holis recall proposal customers
holi holis search proposal "payment terms" --since 30d
```

Remember what will matter next time (a preference, a decision, where something
lives), not a log of what the run did. Never a secret, a password or a token:
memory is committed and synced like any note.

## When you are a Holi's run

You were started with the Holi's soul and memory, and a first message: the
document you were sent, or an automation's prompt. Do the work, asking the user
when you need to. When a person sent you a document, end by saying what came
of it in a sentence or two:

```sh
holi holis report proposal "Wrote tilbud/nordlys.pdf; the discount needs your yes."
holi holis report proposal --needs-you "Prices.md has no price for support hours."
```

`--needs-you` notifies the user and puts it in their Inbox. If nothing came of
it, report nothing. `holi holis list` lists the vault's Holis.

An older Holi is one file, `.holi/holis/<id>.yaml`, whose `instructions` key is
its soul. It still runs; a folder is how a new one is made.
