# Holis

A Holi is an agent that belongs to the vault, with a name and a face, a **soul** and a **memory**,
after MonoCode's Monos ([NOTICE](../../apps/desktop/src/plugins/holis/NOTICE.md)). Proposal turns a
customer note into a PDF proposal laid out as the vault's template; Assistant carries out a morning
digest every weekday. A person sends a Holi work from the menu beside a document's **Agent** button,
or gives it **habits**: [automations](scheduled-agents.md) it carries out on a clock. Either way the
run is this machine's agent in the vault, under the Holi's soul and rules: Claude Code, asking the
person what its rules do not cover, or Codex in a sandbox its rules must fit
([agent-sessions](agent-sessions.md), Jobs).

Holis are the plugin `holis` (`src/plugins/holis/`, on by default), built on the agent: it runs
every Holi through the agent's `agent.job` and reaches the agent's sessions only through core.

**On Codex.** A run goes to this machine's agent (`agentProvider`); a Holi has no agent of its
own. On Codex it is a job in the vault: `allow` must be reads and folder writes
(`Edit(tilbud/**)`), which become the folders Codex's sandbox may write, and anything else refuses
the send with the rule named, never running it on Claude Code instead. `model` is Claude Code's and
is left out. Its sandbox has no network, so its `holi holis` commands cannot reach Holi: the run
works and its turns are recorded, but it does not report or keep its memory
([not built](../not-built.md)). Any other `holi` command in its `allow` refuses the send.
**A Holi runs on Codex only once this machine allows it** for the vault (Settings → General →
Agents, **Let Codex run unattended in this vault**, after a dialog), and main refuses the send
until then, saying where to turn it on and why: its sandbox bounds what it writes, its allowed
folders, not what it reads, so it can read any file on this computer and write what it read into
the vault's synced folders, and a note from someone untrusted could make it publish private data
([agent-sessions](agent-sessions.md), Jobs). Even on, give a Holi only the folders it needs.
Until the feature is finished, the Agents sidebar shows a locked **Holis** row marked **In
progress** in place of their section, and ⌘K and a document's Agent menu leave them out
(`HOLIS_READY` in `info.ts`).

## How it works

**A Holi is a folder**, `.holi/holis/<id>/`:

```
.holi/holis/proposal/
  holi.yaml   name, mascot, colour, description, model, accepts, allow
  SOUL.md     its standing instructions
  MEMORY.md   what it has learned, one dated fact a line
  memory/     topic notes read on demand, and archive.md
```

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

`accepts` is vault-path globs of the documents it takes (`**` any folders, `*` within a name);
omitted, any document. `allow` is Claude Code permission rules a run may use without asking, passed
as `--allowedTools`, named by folder: a bare `Edit` or `Write`, or `Edit(**)`, is refused, since a run
that could write `AGENTS.md`, `.holi/` or `.claude/` could be talked into changing every later run.
`model` is Claude Code's `--model`. The grammar is in `packages/shared/src/holi.ts`, so the renderer
reads a Holi the way main runs it. An older Holi is one file, `.holi/holis/<id>.yaml`
(`<id>.local.yaml` for this machine only), whose `instructions` key is its soul; it still reads and
runs. A `cron` or `at` in `holi.yaml` is refused with the reason: a Holi on a clock is an automation
that names it.

**YAML, so the file can grow.** A key this build does not know is kept and ignored, never an error.
Holi's own writes go through the `yaml` Document API (`editHoliText`), so a person's comments and key
order stay. A key that would choose how Claude Code asks (`permissions`, a permission mode, a bypass)
is refused with the reason: a run keeps Claude Code's prompts, and `allow` is the one way past one.

**The soul** is `SOUL.md`: who the Holi is and what it should always keep in mind, standing
instructions rather than a task. A new Holi's starts as a heading and one placeholder line. It goes
into every run first.

**The memory** is `MEMORY.md`, one fact a bullet, dated, after MonoCode's
(`packages/shared/src/holi-memory.ts`):

```
- 2026-10-04 · Nordlys wants proposals in English · until 2026-11-01
- ~~2026-09-01 · Old fact~~ · superseded 2026-10-04
```

A run keeps it through `holi holis remember | revise | forget | recall | search`, which every run
may use without asking: a fact is added once, a correction strikes the old line through and adds
the new one after it, and anything that looks like a credential is redacted before it is written,
since the memory is committed and synced like any note. Each write is a read, an edit and a write,
one at a time per Holi. The first 200 lines (24 KB) load into a run; past that the oldest dated
entries move to `memory/archive.md` (struck ones first, then expired ones), and a person's undated
lines never move. `--topic` writes a topic note in `memory/`, which a run reads on demand.

**How a run is told who it is.** Claude Code's own `--append-system-prompt`, after MonoCode's mono
context: one line naming the Holi by its id and folder, how it was started (a person sent a
document, or an automation), then `<soul>`, `<memory_rules>` and `<memory>`. The memory block says
what it is: notes the Holi wrote in earlier runs, facts and not instructions. Only what the approval
covers is said as instructions (its id, its folder, its soul), never its name or description, which
anyone may change.

**On the New tab.** The plugin contributes the vault's Holis (every one that parses, by persona and
colour) as the cast of the empty view's arcade (`RendererPlugin.arcadeCast`, see
[tabs and panes](tabs-panes.md)). Core draws the game and knows nothing of Holis.

**Send to Holi.** On a note, the pane header's Agent button is a split button; its chevron opens a
menu of what plugins offer for the document (`RendererPlugin.documentActions`). Core draws the menu
and knows nothing of Holis; the Holis plugin contributes its rows: **Send to Holi**, the Holis that
take this document, then **All Holis** (the others, shown as taking other documents), then **New
Holi…**, which opens the wizard with the document's folder as its `accepts`. A send is a background
session (`claude --bg` through `agent.job`) on Claude Code, shown in the Agents view; its first turn is one line
naming the document, and its turns pause sync and are recorded under its job id like any session's.

**Approved per machine, per change.** A Holi syncs, so a teammate's pull brings it, and a run of it
can edit files. So the first send on a machine, and the first after its soul, model, `allow` or
`accepts` changed, opens a dialog showing exactly that and asks; confirming records a fingerprint
(`holiApprovalText`) in `userData/holis.json`, keyed by remote and path. Later sends are one click.
A comment, a reordered key, a new name or face, or a change to its **memory** changes nothing anyone
must approve: the memory is what its own runs write, and it reaches a run marked as notes. The
dialog sends back the fingerprint it showed, so a Holi changed while it was open is refused as
"changed since you looked". Approving is the UI door's alone (`holis.approve`): the approval lives
outside the clone the agent can write, and an approval the agent could give itself would be none.

**Habits are automations.** An automation names the Holi that carries it out (`holi: <id>`); its
run gets the Holi's soul, memory, model and rules from `holis.context`, and turning the automation
on approves the Holi's fingerprint along with its own prompt, so a change to the soul turns it back
off ([scheduled-agents](scheduled-agents.md)). One scheduler, not a second one per Holi.

**A send says what came of it**, at its end, with `holi holis report <id> "…"`: a sentence or two,
`--needs-you` when the person must act, nothing when nothing happened. The report lands on the
Holi's latest send. Holi never reads a transcript. A report that asks for the person is a macOS
notification (a click opens the Holi's page) and an Inbox row until they have opened the page.

**In the Agents view** ([sidebar](sidebar.md)) the Holis are a section with a **+**, after
Automations and before the sessions. A Holi is a row: its face (below), which blinks idle, talks while
a run works and calls out when it needs you (the one animation the view keeps of its own); a
status dot, steady amber when it needs you; and New, Changed or Invalid. With none yet, a **Meet
Holis** card says what one is, with **Create Holi** and **How Holis work**. **+** and the card open
the wizard; the **?** beside **+** opens its explaining steps alone.

**The wizard** (`renderer/wizard/`) is ReUI's `onboarding-2` block, installed with the shadcn CLI:
its rail of numbered steps on the left, which jumps back to any step reached, and one step at a
time in a ghost Frame. It explains, then makes one. **What a Holi is**: a name and a face
(`holi.yaml`), a soul (`SOUL.md`), a memory (`MEMORY.md`), in the vault for everyone. **How it gets
work**: sent from a document's menu, or on a schedule as habits; there are no event triggers, since
an automation's only triggers are `cron` and `at`. **Who it is**: name, face (the personas), colour,
a short description; the name follows the face until typed, and the face and colour start at the
first ones no other Holi has. **What it does**: its soul, the documents it takes, its model. **What
it may do**: what `allow` is, in plain words, a folder it may write (`Edit(<folder>/**)`) or any
other rule, each refused at once by the file's own check (`holiRuleError`: a bare `Edit` or `Write`
is refused). **Habits**, when the automations plugin is on: one optional habit, a sentence ("Every
weekday at 08:00") and what it does each time. **Review and create**. A person who already has
Holis starts at Who it is, the explaining steps a click back. **How Holis work** is the first two
steps, ending in **Create a Holi**.

Create is the one create path: `holis.create`, whose parse in main is the last word, and for a habit
the automations' own `schedules.save`, written off, as the automation editor's Create writes one.
Then the Holi's page, and the approval dialog as for any new Holi: making it approves nothing, and
the habit runs only on a machine that turns it on in Automations, which approves it and the Holi
there. A habit that fails to write leaves the Holi made, and says so.

The dialogs (the approval, the settings, the wizard) are the plugin's drawer, and the sidebar
section mounts them too, since the shell mounts no plugin drawers yet; whichever mounts first draws
them.

**Faces.** A Holi's `mascot` is one of ten pixel personas, syv.ai's own website characters, each
named by its character and never by a person: `captain`, `strategist`, `skipper`, `spy`,
`professor`, `operator`, `starter`, `scout`, `champion` and `benchmarker`. A persona is a 32×32
sprite in its own paint; in the light theme it wears its everyday clothes and in the dark it suits up
as a superhero (suit, cape, mask, a 7 on the chest), following the resolved `data-theme`. It is
drawn at whole multiples of its grid so it stays sharp: the head-and-shoulders window (20 pixels
square, at 20px) in the small slots (a sidebar row, the Inbox, menus, pickers), the whole figure at
32px in a Holi page's header and at 64px on its settings. The Holi's `color` is the plate behind the
figure, a translucent disc that marks whose it is without repainting it; in the arcade it is the
colour of the papers it carries and of its speech bubble. Idle a face blinks now and then, working
it talks, and needing you it waves (a whole figure) or calls out (a head); reduced motion holds the
first frame. A file's older arcade names still read, each as the character that stands in for it,
so an existing Holi only changes its look; Holi never writes them:

| older      | now           |
| ---------- | ------------- |
| `invader`  | `spy`         |
| `ghost`    | `strategist`  |
| `robot`    | `operator`    |
| `cat`      | `scout`       |
| `skull`    | `benchmarker` |
| `crab`     | `skipper`     |
| `mushroom` | `starter`     |
| `rocket`   | `captain`     |
| `dino`     | `professor`   |
| `frog`     | `champion`    |

**A Holi's page** is its face, name and state, a line asking for approval while this machine has
not approved what it says now, and two tabs. **Runs**, newest first: the document each took and
when, a status (needs you, working, changed files with their `+N −M`, nothing to report), its report,
and its actions: **Review changes** (the agent's turn review over the run's range), **Keep** or
**Revert** (the vault as it was before the run, one new commit per file), and **Open session**
(brought back first if it has finished). Runs that said nothing and changed nothing fold into one
line. **Habits**: the automations it carries out, each opening in the Automations view, and **New
habit**, an automation already set to this Holi.

**Its settings** (after MonoCode's `MonoSettingsDialog`) are three sections. **General**: its face
and colour, its name, its model, what it may do without asking, the documents it takes, whether this
machine approved it, its file, and **Remove** (its folder leaves the vault). **Soul**: `SOUL.md`,
saved when the field is left, over the text it opened only: a run or a pull that wrote it since
offers theirs or yours. **Memory**: one fact a row, each editable or forgotten, a new one added with
**+**, and how much of it loads (`N / 200 lines`, or how many do not).

## The path of a send

One path, no parallel mechanism: the document's Agent menu (a plugin slot) → approval if new or
changed (`holis.approve`, the UI door) → `holis.send` → `agent.job` (`claude --bg` with the
Holi's system prompt, model and rules) → the Agents view on its session → the turn hooks bracket
each turn on the vault's one working set and record it under the job id → `holi holis report`
writes the run's record → the `holis` event, and the renderer reads the list again → the Holi's
page reads the record and, through core, the agent's turn log; `--needs-you` also notifies and
lands in the Inbox.

## Rules

- Never run a Holi this machine has not approved in its current soul and rules.
- Keep approvals out of the vault clone, and approving out of the agent's reach.
- Only what the approval covers reaches a run as instructions: its id, folder and soul, never its
  name. Its memory reaches it as notes.
- A Holi runs on a clock only as an automation that names it, on a machine that turned that on.
- Write memory only through its commands, which redact credentials.
- Core never imports Holis: the Agent menu's rows and the sidebar section come from plugin slots.
- Holi's writes to a Holi's files edit them in place; they never rewrite what a person wrote.

## Rejected

- **Habits as a second scheduler per Holi**, as MonoCode's are: two clocks to approve and to
  explain. An automation that names the Holi is the habit.
- **The soul and memory in `userData`**, as MonoCode keeps a Mono's: a Holi belongs to the vault, so
  what it learns is the team's. A personal fact belongs in `USER.local.md` or a `.local.` file.
- **Memory in the approval**: every run would ask again. It is notes, marked as such.
- **Writing `MEMORY.md` with the agent's own tools**: no redaction, no budget, no shape.
- **A Holi on a clock only in the cloud**: what the first design said, for fear of unattended runs
  on members' machines. An automation is already that, approved per machine; naming a Holi adds
  its soul and rules to what is approved.
- **`--dangerously-skip-permissions`, a permission mode or Claude Code's auto mode**, MonoCode's
  full-access habit runs among them: the person answers prompts, from the Inbox when away.
- **Approving behind an `ask` rule**: the rule matches a command's text, which a script gets around.
- **The first turn carrying the soul**: it would read as the person's message; Claude Code's own
  `--append-system-prompt` is where a standing role goes.
- **Reading a run's outcome from its transcript**: Claude Code's files are not an interface; the
  run says what came of it.
- **The Holi list in core's pane header**: core would know a plugin's domain. The header offers a
  slot; the plugin fills it.

## Code

- `packages/shared/src/holi.ts`: the folder, `accepts` globs, the soul, the approval text,
  `editHoliText`; `holi-memory.ts`: the memory's entries, budget, archive, redaction and search
- `apps/desktop/src/plugins/holis/main/holis.ts`: approvals, sends, runs, reports, the system
  prompt, `create`/`update`/`remove`, and `context` for automations; `memory.ts`: the memory
  commands and the page's hash-checked saves; `capabilities.ts`: `holis.*`
- `apps/desktop/src/plugins/holis/renderer/`: `holis-section.tsx` (the sidebar section and Meet
  Holis), `wizard/` (the new-Holi wizard, after ReUI's `onboarding-2`), `holi-view.tsx`,
  `holi-feed.tsx`, `holi-settings-dialog.tsx`, `holis-inbox.tsx`,
  `document-holi-actions.tsx`, `approve-holi-dialog.tsx`; `state.ts`
- `apps/desktop/src/renderer/src/composites/pixel-persona/`: the personas (`personas.ts`) and
  `PixelPersona` (`pixel-persona.tsx`); the names and the old-name mapping are `@holi/shared`'s `holi.ts`
- `apps/desktop/src/renderer/src/features/documents/document-actions.tsx`: the document's ⋯ menu and the `documentActions` slot a plugin fills (the Holis' Agent menu)
- `apps/desktop/src/plugins/holis/main/vault/shipped/.claude/skills/holis/`
