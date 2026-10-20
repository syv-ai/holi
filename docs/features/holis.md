# Holis

A Holi is an agent that belongs to the vault, with a name and a face, that a person sends work to.
Proposal turns a customer note into a PDF proposal laid out as the vault's template; Meeting files a
task for each action item in a meeting note. Open the document, pick the Holi from the menu beside
the **Agent** button, and an agent tab opens with Claude Code working on that document under the
Holi's instructions, the person there to answer its prompts. The name and the idea of a face come
from MonoCode's Monos ([NOTICE](../../apps/desktop/src/plugins/agent/NOTICE.md)).

## Why triggered, and why not on a clock

Work a person sends is personal and attended: it runs with their credentials, on their machine, and
they answer Claude Code's prompts as it goes, so it needs no list of everything it may do up front.
Work that runs on a clock is unattended. On a member's machine that is a
[scheduled agent](scheduled-agents.md), which stays as it is, its own approval switch and rules
unchanged. Shared work on a clock that should run once for everyone, with every laptop shut, belongs
in the cloud: a **scheduled Holi**, below. A Holi never runs on a clock on someone's machine.

## How it works

**A Holi is one YAML file**, `.holi/holis/<id>.yaml`, or `<id>.local.yaml` to keep it on this
machine:

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
  Templates/proposal.typ, and export it as a PDF to tilbud/.
```

`accepts` is vault-path globs of the documents it takes (`**` any folders, `*` within a name);
omitted, any document. `allow` is Claude Code permission rules a run may use without asking, passed
as `--allowedTools`, named by folder: a bare `Edit` or `Write`, or `Edit(**)`, is refused, since a run
that could write `AGENTS.md`, `.holi/` or `.claude/` could be talked into changing every later run.
`model` is Claude Code's `--model`. The grammar is in `packages/shared/src/holi.ts`, so the renderer
reads a file the way main runs it.

**YAML, so the file can grow.** A key this build does not know is kept and ignored, shown on the
Holi's page, never an error. Holi's own writes go through the `yaml` Document API (`editHoliText`),
so a person's comments and key order stay. A key that would choose how Claude Code asks
(`permissions`, a permission mode, a bypass) is refused with the reason: a run keeps Claude Code's
prompts, and `allow` is the one way past one.

**Send to Holi.** On a note, the pane header's Agent button is a split button: the button does what
it always did, and its chevron opens a menu of what plugins offer for the document
(`RendererPlugin.documentActions`). Core draws the menu and knows nothing of Holis; the agent plugin
contributes its rows: **Send to Holi**, the Holis that take this document, then **All Holis** (the
others, shown as taking other documents), then **New Holi…**, which starts from the document's folder
as its `accepts`.

**A send opens an agent tab.** It is a background session (`claude --bg`), attached in the agent's
terminal tab beside the documents, in the vault clone. Who the Holi is and its instructions go in
through Claude Code's own `--append-system-prompt`, with `--model` and `--allowedTools` from the file;
its first turn is one line naming the document. Only what the approval covers reaches it: its id,
its file's path and its instructions, never its name or description, which anyone may change. The
person answers its permission prompts in the tab, as in any session; there is no permission mode and
no bypass. Its turns pause sync and are recorded under its job id like any session's.

**Approved per machine, per change.** A Holi file syncs, so a teammate's pull brings it, and a run of
it can edit files. So the first send on a machine, and the first after its instructions, model,
`allow` or `accepts` changed, opens a dialog showing exactly that and asks; confirming records a
fingerprint (`holiApprovalText`) in `userData/holis.json`, keyed by remote and path, and sends. Later
sends are one click. A comment, a reordered key or a new name or face changes nothing anyone must
approve. The dialog sends back the fingerprint it showed, so a file changed while it was open is
refused as "changed since you looked". Approving is the UI door's alone (`holis.approve`), as turning
a scheduled agent on is: the approval lives outside the clone the agent can write, and an approval
the agent could give itself would be none.

**A run says what came of it**, at its end, with `holi holis report <id> "…"`: a sentence or two,
`--needs-you` when the person must act, nothing when nothing happened. The report rule is added to
every run's `allow`, and the report lands on the Holi's latest run. Holi never reads a transcript. A
report that asks for the person is a macOS notification (a click opens Agents mode on the Holi) and
counts on the mode toggle until they have opened the Holi's page.

**In the Agents view** ([sidebar](sidebar.md)) the scheduled Holis come first, then the Holis, then
the live sessions. A Holi is a row: its pixel mascot (after MonoCode's), which bobs idle, hops while
a run works and gets an idea when it needs you (the one animation the view keeps of its own); a
status dot, steady amber when it needs you; and New, Changed or its run count. A
Holi's sessions are its own: they show on its page, not again among the live sessions. **+** makes
one. **A Holi's page** is its runs, newest first: the document each took and when, a status (needs
you, working, changed files with their `+N −M`, nothing to report), its report, and its actions:
**Review changes** (the turn review drawer over the run's range, its first turn's base to its last
turn's end, from the turn log by job id), **Keep** or **Revert** (the vault as it was before the run:
a file the run created is deleted, every other file gets its old text back, one new commit each),
and **Open tab** (the run's session, respawned first if it has finished). Runs that said nothing and
changed nothing fold into one line. Beside it the details: whether this machine approved it, the
documents it takes, its instructions, what it may do without asking, its model, any unknown keys,
and its file.

## Scheduled Holis

A Holi file with a `cron` or `at` (and no `accepts`) is a **scheduled Holi**: shared work on the vault
alone, a housekeeping agent that tidies stray notes each night. It is meant for Claude Code's
scheduled cloud runs against the vault's GitHub repository: running once per moment for everyone,
with every laptop shut, its outcome read from its commit (the message its report, the diff its
review). A cloud run has no machine, so no `holi` commands (mail, agenda) and no `.local.` files: a
scheduled Holi whose instructions or `allow` name either is refused at parse, pointing to scheduled
agents. **Holi cannot set these up in the cloud yet**: Claude Code drives its cloud runs from its
`/schedule` skill against claude.ai, which Holi has no interface to. So the Agents view lists them in
their own section, above the Holis, with their time and "Not set up in the cloud", and nothing runs
them ([not-built](../not-built.md)). They cannot be approved or sent work.

## The path of a send

One path, no parallel mechanism: the document's Agent menu (a plugin slot) → approval if new or
changed (`holis.approve`, the UI door) → `holis.send` → `sessions.start` (`claude --bg` with the
Holi's system prompt, model and rules) and an agent tab on it → the turn hooks bracket each turn on
the vault's one working set and record it under the job id → `holi holis report` writes the run's
record → the `holis` event, and the renderer reads the list again → the Holi's page reads the record
and the turn log; the mode toggle counts it; `--needs-you` also notifies.

## Rules

- Never run a Holi this machine has not approved in its current content.
- Keep approvals out of the vault clone, and approving out of the agent's reach.
- Only what the approval covers reaches a run: its id, path and instructions, never its name.
- A Holi runs only when a person sends it work; a schedule on a machine is a scheduled agent.
- Core never imports Holis: the Agent menu's rows come from the plugin's slot.
- Holi's writes to a Holi file edit it in place; they never rewrite what a person wrote.

## Rejected

- **Holis on a schedule on members' machines**: unattended runs with one person's credentials, and
  in a shared vault every machine that turned one on would run it again. Scheduled agents cover the
  personal case, the cloud the shared one.
- **`--dangerously-skip-permissions`, a permission mode or Claude Code's auto mode**: the person is
  there; `allow` names what one Holi may do without asking.
- **Approving behind an `ask` rule**: the rule matches a command's text, which a script gets around.
- **The first turn carrying the instructions**: they would read as the person's message; Claude
  Code's own `--append-system-prompt` is where a standing role goes.
- **Reading a run's outcome from its transcript**: Claude Code's files are not an interface; the
  run says what came of it.
- **The Holi list in core's pane header**: core would know a plugin's domain. The header offers a
  slot; the agent fills it.

## Code

- `packages/shared/src/holi.ts`: the file, `accepts` globs, the approval text, `editHoliText`
- `apps/desktop/src/plugins/agent/main/holis/holis.ts`: approvals, sends, runs, reports
- `apps/desktop/src/plugins/agent/main/holis/capabilities.ts`: `holis.list|approve|send|create` (all
  but `list` at the UI door only) and `holis.report` (the CLI)
- `apps/desktop/src/plugins/agent/main/host/sessions.ts` (`start` with a model, rules and system
  prompt), `main/claude/cli.ts` (`startBg`'s `--append-system-prompt`)
- `apps/desktop/src/renderer/src/components/PaneHeader.tsx`: the Agent split button and its slot
  (`RendererPlugin.documentActions`)
- `apps/desktop/src/plugins/agent/renderer/agents/`: `DocumentHoliActions.tsx`,
  `ApproveHoliDialog.tsx`, `NewHoliDialog.tsx`, `HoliDialogs.tsx`, `AgentsSidebar.tsx`,
  `AgentsMain.tsx`, `HoliFeed.tsx`, `HoliDetails.tsx`, `PixelMascot.tsx`; `state/holis.ts`,
  `state/runs.ts`, `state/agents-status.ts`
- `apps/desktop/src/plugins/agent/main/claude/vault/shipped/.claude/skills/holis/`
