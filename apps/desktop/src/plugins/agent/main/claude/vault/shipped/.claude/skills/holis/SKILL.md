---
name: holis
description: Create or change Holis, agents that belong to this vault which the user sends a document to (a "Proposal" Holi that turns a customer note into a PDF, a "Meeting" Holi that files tasks from notes), and say what came of a Holi's run. Use when the user wants a reusable agent for a kind of document, mentions a Holi, or when you are running as a Holi and are done. For something that should run on a schedule on this machine, use the scheduled-agents skill instead.
---

# Holis

A Holi is **one YAML file** in `.holi/holis/`: an agent with a name and a face
that the user sends work to. In Holi, the menu beside a document's **Agent**
button lists the Holis that take that document; picking one opens an agent tab
running Claude Code on the document, with the Holi's instructions, and the user
there to answer your permission prompts. Nothing runs on its own.

## The file

```yaml
name: Proposal
mascot: rocket
description: Turns a customer note into a PDF proposal
model: sonnet
accepts:
  - kunder/**/*.md
allow:
  - Edit(tilbud/**)
instructions: |
  Write a proposal for the customer in the note you are sent, laid out as
  Templates/proposal.typ, and export it as a PDF to tilbud/ named after the
  customer. Prices come from Prices.md; never invent one.
```

| key | |
|---|---|
| `name` | What Holi shows. Defaults to the file name. |
| `mascot` | Optional: `invader`, `ghost`, `robot`, `cat`, `skull`, `crab`, `mushroom`, `rocket`, `dino` or `frog`. |
| `color` | Optional: a quoted `'#rrggbb'`. |
| `description` | Optional: one line on what it is for. |
| `model` | Optional: `sonnet`, `opus`, `haiku` or a full model id. |
| `accepts` | Optional: vault paths it takes, as globs (`kunder/**/*.md`). Omitted: any document. |
| `allow` | Optional: Claude Code permission rules a run may use **without asking**. Everything else asks the user. |
| `instructions` | What it does with the document. Use `\|` and indent it. |

Name the file after what it does, in kebab case: `.holi/holis/proposal.yaml`.
A `*.local.yaml` file stays on this machine and never syncs.

There is no key for a permission mode: a run always keeps Claude Code's
prompts, and Holi refuses a file that tries to turn them off. Any key Holi does
not know is kept and ignored.

**Allow writing only where it writes.** Name each folder as an `Edit` rule:
`Edit(tilbud/**)`, `Edit(**/task.*.md)`. Never a bare `Write` or `Edit`, or
`Edit(**)`: Holi refuses those, because a run that could write `AGENTS.md`,
`.holi/`, `.claude/` or a skill could be talked into changing every later run.

**The user approves it, per machine.** The first time they send a Holi work on
their machine, and again after its `instructions`, `model`, `allow` or
`accepts` change, Holi shows them exactly what it does and asks. You cannot
approve one. After writing a Holi, tell the user it is there, what it may do
without asking, and how to send it a document.

A file with a `cron` or `at` instead of `accepts` is a **scheduled Holi**:
shared work on the vault alone, for Claude Code's cloud. Holi cannot set those
up yet, so they run nowhere. For anything on a schedule on this machine, write
a scheduled agent (the scheduled-agents skill).

## When you are a Holi's run

You were started with the Holi's instructions and a first message naming the
document. Do the work, asking the user when you need to. At the end, say what
came of it in a sentence or two:

```sh
holi holis report proposal "Wrote tilbud/nordlys.pdf; the discount needs your yes."
holi holis report proposal --needs-you "Prices.md has no price for support hours."
```

`--needs-you` notifies the user. If nothing came of it, report nothing. The
report is always allowed. `holi holis list` lists the vault's Holis.
