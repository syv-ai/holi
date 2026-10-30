# Automations

An automation (a scheduled agent) is a prompt Holi runs as an agent session at set times or when
something happens, on this machine, while the vault is open: check the inbox every half hour and
draft replies, file a task for what needs the user, start a tilbud from a customer's mail, read a
file dropped in `inbox/`. The definition is a file in the vault; whether it runs is this machine's
choice; each run is an ordinary [agent session](agent-sessions.md), carried out by this machine's
agent as it is or by one of the vault's [Holis](holis.md), with its soul and memory. Automations
are the plugin `automations` (`src/plugins/automations/`, on by default), built on the agent: it
starts each run through `agent.job` and hears the agent's session list and turn ends through the
main-side plugin channel (`ctx.hear`). Until the feature is finished, the renderer shows
Automations as a locked **In progress** row and keeps them out of ⌘K (`AUTOMATIONS_READY` in
`info.ts`); automations already switched on still run.

## How it works

**A schedule is one local file**, `.holi/schedules/<name>.local.md`. It is one person's: it reads
their mail with their Google account and writes in their name, so it never syncs, nobody else sees
it in their Automations view, and nobody else can edit or break it. A committed `.holi/schedules/<name>.md` is not
a schedule and never runs: the Automations view lists it as invalid with the rename that makes it one. Its frontmatter says when and with what, and its body is the prompt:

```markdown
---
name: Inbox triage
cron: '*/30 7-18 * * 1-5'
holi: assistant
model: sonnet
allow:
  - Bash(holi google search:*)
  - Bash(holi google read:*)
  - Bash(holi google draft:*)
  - Edit(**/task.*.md)
  - Edit(tilbud/**)
---

Look through my unread mail since the previous run…
```

`cron` is five fields in **this machine's local time**, the clock its person reads (with the usual
`@daily`-style macros); `at` instead names one local minute (`"2026-10-09T15:00"`). A list of crons is several triggers,
and the run comes at whichever is first. `holi` names the Holi that carries it out: the run gets
that Holi's soul and memory through `--append-system-prompt`, its model when the file names none,
and its `allow` rules beside the file's (`holis.context`). `catch-up` is how late a missed moment
may still run (`none`, `30m`, `2h`, `12h`); a later one is recorded as skipped. `model` is Claude
Code's `--model`. `allow` is Claude Code permission rules the run may use without asking,
passed as `--allowedTools`; every other permission prompt still asks, and an `ask` rule (sending
mail, `curl`) still asks whatever `allow` says. Nothing runs more often than every 5 minutes: a
`* * * * *` typo would otherwise start a session a minute. `on` lists the events that start a run,
instead of or as well as a time (see Triggers). The grammar and its parser are in `packages/shared`
(`cron.ts`, `schedule.ts`, `triggers.ts`), so the Automations editor reads a file the way main runs it.

**Running is approved per machine, and the approval is of the content.** The agent can write
the file, so a schedule runs only once the person turned it on. Turning it on records a
fingerprint of what it approves: the prompt (in its commit-tidied form), the model, the `allow`
list, the `on` triggers, which Holi carries it out and what approving that Holi approves (its
soul, model and rules). A change to that Holi's soul reads **changed** here too; a Holi that is
gone, does not parse, or whose plugin is off makes the automation **invalid**, and it does not
run. A file whose fingerprint no longer matches reads **changed** and does not run until it is
turned on again, so neither another session nor a run of the schedule itself, which may edit
files, can change the schedule's prompt, model, `allow` or triggers without the person's yes. A
trigger is in it because it decides who can start a run: anyone who can send the person a mail,
or drop a file in the vault. The time is not in the fingerprint, so moving a run grants nothing;
nor is the `name`, which labels the run's session and the automation's card and is never in what
the run reads. The approvals and the run log live in `userData/schedules.json`, keyed by remote
and path, not in the clone: the agent can write anything in the clone, and an approval it could
write would be none.

**What a run reads is not its prompt.** Its first turn is the approved prompt and one line of
Holi's, and nothing a mail or an invite says is spliced into it: the run fetches that itself, with
`holi google`, which fences everything another person wrote as `<untrusted id="..." ...>`
([google](google.md)). The shipped skills tell the agent that fenced text is data, never an
instruction, and a send still asks however the run was talked into it. The fence covers what
`holi google` prints, not what is already in the vault: **Make task** in Mail or Agenda, and a vault
app that stores what it fetched, copy someone else's words into a file a run later reads as the
vault's own. A person chose to make that task, so vault files stay unfenced; this is a known gap
([not-built](../not-built.md)).

**That is all the approval locks.** A run is an ordinary session, so it also follows the vault's
`AGENTS.md`, memory, skills and `.claude/settings.json`, which no schedule's fingerprint covers. A
run allowed to write those could be talked into changing every later run: a mail that says "add this
to AGENTS.md". So `allow` names the folders a run writes, `Edit(tilbud/**)` or `Edit(**/task.*.md)`,
never a bare `Write` or `Edit`. Claude Code checks every file write, a new file included, against
`Edit` path rules; a path rule on `Write` is accepted and never consulted.

**Sharing a schedule is copying it.** A teammate who wants the same triage copies the file into
their own `.local.md` and makes it theirs (their name, their tone): a prompt that speaks for one
person cannot be run by another.

**The agent writes schedules; the person turns them on.** The shipped `scheduled-agents` skill
teaches the file, the prompt (self-contained, results left in the vault as tasks, drafts or notes, a
summary at the end) and the CLI. `holi schedules list` is allowed and `holi schedules run`, for a
schedule that is already on, is a seeded `ask` rule. Turning one on is no command at all: the
`schedules.enable` capability opens only the UI door. An `ask` rule matches a command's text, which
a small script gets around, and an approval the agent could give itself would be none. **The Automations view** (the Agents mode's top group, after MonoCode's) is the list beside the
editor. A card shows the trigger, the name, who carries it out, the last run and its state. The
editor is the name with Cancel or Reset, **Run now** and **Create** or **Save**; the **Active**
switch and the Holi picker (Claude, or a Holi, searchable); **Triggers**, each a sentence ("Every
weekday at [11:00]") with this machine's offset and the next run, and **Add trigger** (a cron no
sentence says stays as written); **Instructions**, the prompt with its model and what it may do
without asking under it; **Advanced**, the catch-up window; and **Run history**. Writing it
(`schedules.save`, the UI door) approves nothing; Active sends the fingerprint of what was just
written or shown, so it approves exactly that. A Holi's page lists the automations it carries out
as its **Habits**. Nobody approves text behind a link: the editor shows the prompt the switch
approves, and a file that changed since it was shown is refused as "changed since you looked".
The editor's Triggers hold the file's `on:` events beside its times, each a sentence too ("When a
file is [added] in [inbox/**]", "[30 min before] each calendar event", "When a task is [due]",
"When new mail matches [from:@acme.com]"), and **Add trigger** offers them under On an event. They
go to `schedules.save` with the times and are read there the way the file is (`triggerYaml`, then
`parseTriggers`), so the editor refuses what main would, such as a glob outside the vault, before
it saves. A run events started reads **Event** in Run history, with what started it.

**One check every half minute**, while the vault is open, plus one five seconds after it opens. A
check runs a schedule when its first moment after the last run (or after it was turned on) has
passed. Missed moments collapse into that one run: a laptop that slept, or a Holi that was closed,
through six half-hours runs once when it is back, unless the latest of them is older than its
`catch-up` window, when it is recorded as skipped and nothing runs. A one-off runs once and then has nothing due.
Schedules run only for the open vault: a closed vault's `bridge.local.env` is gone, so a session in
it could not reach `holi`.

**On Codex** (this machine's `agentProvider`), a run is a job in the vault instead
([agent-sessions](agent-sessions.md), Jobs): `codex exec` in a sandbox with no network whose
writable folders are the schedule's `allow` write rules (`Edit(inbox/**)`), refused with the rule
named when one is anything else, a command (a `holi` one too, such as `Bash(holi google read:*)`:
the sandbox has no network to reach Holi) or a web tool, rather than run on Claude Code. It never
asks anyone: a step outside its sandbox fails. Its turn ends when Codex says `turn.completed` or
fails, and closes the run as a `Stop` does below; a turn that failed records the run as failed,
with Codex's reason, in Run history and the work log. A `model` is Claude Code's and is left out.
The rest of this section is Claude Code's.

**An automation runs on Codex only once this machine allows it** for the vault (Settings →
General → Agents, **Let Codex run unattended in this vault**, after a dialog); until then main
refuses the run, which is recorded as failed with the reason and where to turn it on. Its sandbox
bounds what it writes, the schedule's folders, not what it reads: it can read any file on this
computer and write what it read into the vault's synced folders, so a note from someone untrusted
could make it publish private data ([agent-sessions](agent-sessions.md), Jobs). Even on, give it
only the folders it needs.

**A run is a background session** started with `claude --bg`, no terminal, named `<name> · HH:MM`.
Its first turn is one line Holi adds (the schedule's path, the time, the previous run's time, so a
prompt can say "since the previous run", and for a run events started, what they were) and then the
file's body. It is in the sidebar like any session, pauses sync through the turn hooks like any
session, and asks the person in the usual way when it needs a tool its schedule does not allow.

**A run closes when it is done.** Its turn ending is Claude Code's `Stop` hook, which already
drives the turn bracket (`turn-signal.mjs`, the turn coordinator's `onTurnEnd`; a confirmed idle and
the safety cap count too, a session that died does not). "Done" is what Claude Code's hooks
reference says tells it from "paused": the Stop input's `background_tasks` (shells, subagents,
monitors still in flight) and `session_crons` (`/loop` and the like still scheduled), both empty.
The hook sends their count as `pending`; a run whose Stop names any is paused, and the work that
wakes it ends in another Stop, which asks again. Then Holi waits for the listing to read the
session idle, looking every 2 s for 30 s, since the hook fires a moment before Claude Code's state
settles, and stops it (`claude stop`): it leaves the sidebar and its conversation stays in the
agents list. A run waiting on the person (a permission prompt) is not done either. A run someone
has a window on was taken over: it is left open, recorded as such, and not asked about again. The
run's record gets `finishedAt` (and `kept` when left open), which the Run history shows, and
the day's work log gets a line naming the schedule and how it ended, as it does for a run that
fails to start ([agent-inbox](agent-inbox.md)), so a run that notified nobody still shows. A
vault whose `turn-signal.mjs` predates `pending` (it reaches a vault through Update skills) sends
none, and the listing's idle is the whole test, as it is for a confirmed idle.

A Stop Holi never heard (the run finished while Holi was closed or restarting, so the hook found
no bridge) is caught by the half-minute check: an open run at least a minute old (a session just
started can read idle before its first turn) that reads idle, and whose last heard Stop did not
say it was paused, is closed the same way; one whose process has gone is only marked done.

Not the signal: `SessionEnd` fires when a session ends, which is what Holi is doing here; the
`idle_prompt` notification waits about a minute and does not cover background shells;
`agent_completed` fires only while an agent view is open in a terminal; `TaskCompleted` is about
Claude Code's task list.

A run does not start while the previous one is working or waiting on the person (recorded as
skipped). An idle previous run left open with nobody's window on it is stopped first, so a schedule
holds at most one live session. Each schedule keeps its last 20 runs: started (with the job id and,
once done, when), skipped or failed.

## Triggers

```yaml
on:
  - file: inbox/** # a file added under inbox/
  - file: clients/*/brief.md
    changed: true # added or changed
  - task: overdue # an open task's due moment has passed
  - task: due
    before: 60 # an hour before an open task is due
  - calendar: 30 # 30 minutes before each timed event
  - mail: 'from:@acme.com' # a new mail, not yours, in a thread the query finds
```

**Each source is a plugin's, and they meet in the automations plugin's trigger router.** The plugins started in
the vault tell each other `VaultEvent`s over `ctx.events`
([architecture](../architecture.md#plugins)); none imports another. At every check the scheduler
says what the approved schedules listen for (`interest`), and a source does only that work:

- **`file`** is the automations plugin's own, read off the vault's scans (`ctx.onSnapshot`): a note or
  file whose path is new is added, one whose mtime moved is changed. Files under `.holi/` and
  `.claude/` are never file events: a run writes there (memory, settings, its own schedule) as a
  matter of course. Nor are `.local.` files and secret files such as `.env`, which are this
  machine's and never named in a run's line, nor a vault app's records and log, which an app
  rewrites as it runs. While a schedule's run works, its file events are set aside rather than
  heard. When the run is done, Holi weighs them against the span the run could have written in:
  from its start to the end of its last turn, as the turn log records it (written after that
  turn's settle commit and the pre-commit transforms, so a transform's rewrite of the run's file
  falls inside). A file whose newest change lies outside that span is someone else's, and becomes
  the cause of one follow-up run, batched, spaced and coalesced like any other events: a file
  changed after the run's last turn ended, or one moved in from another folder, which keeps its
  older mtime. A file changed inside the span is dropped, as before: a turn's settle commit holds
  every change made while it ran, the person's and a teammate's as much as the run's, and so do
  the gaps between a paused run's turns, where its own background work writes, so neither the
  range nor the clock can tell them apart. With no recorded turn (the run closed without one, or
  its record is not in within four checks), everything set aside is dropped. `changed` is opt-in, because a run that edits the files it watches would
  otherwise start the next run. `added` still loops when a run creates a file under its glob after
  it has finished, or when two schedules each write under the other's glob: keep a run's output out
  of what it watches. The first scan after a start is the baseline; what changed while Holi was
  closed is no event. Files a plugin claims (task files) are not files here; they have their own
  source.
- **`task`** is the tasks plugin's: each open task's due moments, told again with every scan. Due at
  a time, it is due and overdue then. Due on a day, it is due at 09:00 that day (the hour a timeless
  reminder fires) and overdue at 09:00 the next: not late until its day is over, and never a
  midnight run. Only open tasks are in the list, so a task finished before its moment, including
  while Holi was closed, never fires. With the tasks plugin off nothing tells task moments (its
  list is withdrawn as it stops), so a `task` trigger hears nothing, and a task file is an
  ordinary note that a `file` trigger's glob can match.
- **`calendar`** is Google's: the timed events from an hour ago to a day ahead on the vault's
  calendars, all-day events left out, read every 5 minutes. With no account the list is empty.
- **`mail`** is Google's too: each query, every 5 minutes, through the mail cache's `history.list`
  delta (one request when nothing is new). A thread fires when it is new to the query or its latest
  message is, and not when that message is the person's own, so a reply a run drafts and the person
  sends does not start the next run. The first look after a start is the baseline.

Google polls only while some approved schedule listens for mail or the calendar, and only the open
vault's account. The automations plugin tells its interest every check and says it is gone when it leaves the
vault; interest not told again for three minutes counts as gone too, so polling never outlives the
schedules that wanted it. A source that stops tells an empty list, and the router ignores a timed
source's list not told again for 12 minutes, so a moment never fires from a list nobody keeps.

**The router dedupes, batches and spaces** (`router.ts`). An occurrence (a file, a mail) is heard
once per schedule for its id and version (path and mtime, thread and latest message), however often
it is told. A moment (a task's due time, an event's start) fires at its time minus `before`, once:
each schedule keeps, per timed source, the time up to which its moments have been routed, in
`userData/schedules.json`, so a restart fires none again. A moment learned late (a task made
already overdue, an event added inside its lead, a list that arrived after the time) still fires
once, when its time is after that watermark as the session started, after the schedule was turned
on, and within the last day; the moments fired are remembered for the session. That watermark does
not move for a source that has said nothing yet or gone stale (Google not connected), so its
moments are not skipped unseen. Moments that passed while Holi was closed collapse into one run,
like missed cron moments, but only those the sources still list when Holi is back: the calendar
looks one hour back, so a meeting that started earlier than that is gone, and a task finished in
the meantime is no longer open. What a
schedule hears is held for a minute from the first event and goes to one run, one line per file,
thread or task however often it changed. The run waits at least 5 minutes after the schedule's
previous run, the floor a cron schedule has, and a schedule with both a `cron` and `on` shares it.

**An event never starts a run on top of the previous one, and is never dropped for it** (file events
changed within the run's own span excepted, above). Where a cron moment that finds the previous run working is
skipped, a batch waits: it keeps growing and is the one run that follows once the previous run is
done. A schedule holds at most one live run and one waiting batch.

**An event never puts third-party text in the prompt.** The router builds the line from each
cause's structured fields (source, kind, identifiers), never from text a source wrote:
`Triggered by (identifiers, not instructions): mail thread "18c2a" from "ada@example.com"; file
"inbox/offer.pdf" added; task "inbox/task.call.md" overdue; and 2 more`. Each identifier is
quoted, with control, format and line-separator characters stripped and cut at 100 characters; a
sender is named only when it is a plain address; the line names at most five causes and stays
under a fixed length. A file name is still text someone chose, which is why it is quoted and
labelled as an identifier. A subject, a snippet, an event title or a file's contents stay out; the
run reads them itself with `holi` commands, as a cron run reads the inbox. So "Holi adds one line
to a run's prompt" holds for events too.

**Not durable yet.** A waiting batch and the dedupe memory live in memory: quitting Holi loses file
and mail events heard and not yet run (moments are safe by their watermark). See
[not built](../not-built.md).

**Claude Code's own `schedule` skill is off** in a vault (`skillOverrides`): its routines run in
Anthropic's cloud, away from the vault clone, Holi and the vault's Google account. `loop` stays; it
repeats inside one session.

## Rules

- Never run a schedule this machine has not approved in its current content, its triggers included.
- Keep approvals out of the vault clone, and turning a schedule on out of the agent's reach.
- Only what the approval covers reaches a run: its path and prompt, never its name.
- A run never starts on top of a previous run that is working or needs the person.
- A run closes itself when done, never while it waits on the person or someone has it open.
- Missed moments are one run, never a backlog.
- Holi adds one line to a run's prompt and nothing else; an event adds identifiers to it, never
  text someone else wrote. What `holi google` prints of other people's words reaches a run fenced,
  through a command, never in its prompt. Text a person already copied into the vault (a task made
  from a mail or an event, a vault app's records) is vault content and reaches a run unfenced.
- An event run waits for the previous run instead of being dropped, and waits as one batch.
- A source does work only while an approved schedule listens for it.

## Rejected

- **A system scheduler** (`launchd`, `cron`): runs without Holi, so without the bridge, the sync
  pause or the Google tokens, and outlives the vault being removed.
- **Cloud routines**: cannot reach the clone's machine-local files, Holi or the user's mail.
- **Committed, shared schedules**, approved per machine: a schedule speaks for one person, so a
  shared one showed every member someone else's prompt as theirs to turn on, let anyone with push
  access edit it (silently turning it off for its owner), and left nowhere obvious for one's own.
- **`--dangerously-skip-permissions` or a permission mode for unattended runs**: `allow` names the
  tools one schedule needs; everything else keeps Claude Code's prompt. Auto mode
  (`--permission-mode auto`) was reconsidered for runs and is still out, for two reasons. It answers
  yes in the person's place to everything outside the approved `allow`, so the approval would no
  longer say what a run may do. And it allows local file operations in the working directory by
  default, which is the whole vault, so the narrow `Edit(tilbud/**)` rules that keep a run off
  `AGENTS.md`, memory and skills would give way to a model's judgement
  ([Claude Code permission modes](https://code.claude.com/docs/en/permission-modes)).
- **`holi schedules enable` behind an `ask` rule**: the rule matches the command's text, so a
  script that calls the bridge gets around it. Turning on is the editor's Active switch's alone.
- **GitHub Actions**, for runs like these. Every vault is a GitHub repository, so a scheduled
  workflow would run with every laptop shut, exactly once, its history beside the vault. But it runs
  on a fresh checkout on GitHub's machine, away from Holi: no machine-local files, no bridge and so
  no `holi` commands, nobody to answer a permission prompt, and its commits land by push outside
  sync's pause. The Google login and a Claude credential would be repository secrets, which any
  workflow a collaborator with write access pushes can read. It could suit a schedule that needs
  none of that, a weekly digest of the vault itself; mail, the reason schedules exist, needs the
  person's machine.
- **One long-lived session a schedule's runs go into**: Holi can add a message to a running
  session ([agent-sessions](agent-sessions.md)), but a growing conversation costs more each run,
  and a session that stopped has nowhere to take one. A fresh session per run starts clean, so
  triggers start runs.
- **A timer per schedule**: a sleeping laptop wakes to a stale timer; a periodic check reads the
  clock.
- **Event text in the prompt** ("3 new mails from X: <subjects>"): a mail's subject is written by
  whoever sends it, and a prompt is where an injection lands. Identifiers only; the run fetches.
- **Leads in the sources** (tasks announcing "due in an hour"): the lead belongs to the trigger, and
  two schedules may want two. A source publishes its moments; the router times them.
- **A path and kind on the vault watcher's events**: it is a hint that drops events on macOS, and
  the scan is the truth. File events come from comparing scans.
- **Dropping an event while the previous run works**, as a cron moment is: a mail heard once is not
  heard again, so a skipped one is lost.

## Code

- `packages/shared/src/cron.ts`: the cron grammar, the next moment, the shortest gap, words
- `packages/shared/src/schedule.ts`: the file, its triggers, its approval text, `dueRun`,
  `nextRun`, the editor's trigger sentences and `scheduleFileText`
- `packages/shared/src/triggers.ts`: `on:`, `VaultEvent`, what a trigger hears
- `apps/desktop/src/plugins/automations/main/scheduler.ts`: the check, approvals, the Holi, runs,
  `save` and `remove`; `router.ts`: dedupe, batches, moments, file events; `capabilities.ts`:
  `schedules.list|save|remove|enable|disable|run`, all but `list`, `disable` and `run` at the UI
  door only; `index.ts`: the agent through `ctx.call` and `ctx.hear`, the file source through
  `ctx.onSnapshot`
- `apps/desktop/src/plugins/tasks/main/triggers.ts`, `apps/desktop/src/plugins/google/main/triggers.ts`:
  the task, calendar and mail sources
- `apps/desktop/src/plugins/agent/main/host/capabilities.ts` (`agent.job`, `agent.watched`),
  `main/host/sessions.ts` (`launch`, a session with no terminal, and what it publishes)
- `apps/desktop/src/plugins/automations/renderer/`: `automations-view.tsx`, `automation-editor.tsx`,
  `holi-picker.tsx`, `automations-section.tsx`
- `apps/desktop/src/plugins/automations/main/vault/shipped/.claude/skills/scheduled-agents/`
