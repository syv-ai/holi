# Scheduled agents

A scheduled agent is a prompt Holi runs as an agent session at set times, on this machine, while the
vault is open: check the inbox every half hour and draft replies, file a task for what needs the
user, start a tilbud from a customer's mail. The definition is a file in the vault; whether it runs
is this machine's choice; each run is an ordinary [agent session](agent-sessions.md).

## How it works

**A schedule is one file**, `.holi/schedules/<name>.md`, or `<name>.local.md` to keep it on this
machine. Its frontmatter says when and with what, and its body is the prompt:

```markdown
---
name: Inbox triage
cron: '*/30 7-18 * * 1-5'
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
`@daily`-style macros); `at` instead names one local minute (`"2026-10-09T15:00"`). `model` is
Claude Code's `--model`. `allow` is Claude Code permission rules the run may use without asking,
passed as `--allowedTools`; every other permission prompt still asks, and an `ask` rule (sending
mail, `curl`) still asks whatever `allow` says. Nothing runs more often than every 5 minutes: a
`* * * * *` typo would otherwise start a session a minute. The grammar and its parser are in
`packages/shared` (`cron.ts`, `schedule.ts`), so the settings tab reads a file the way main runs it.

**Running is approved per machine, and the approval is of the content.** A schedule file syncs, so a
teammate's pull brings it, but it runs only where someone turned it on. Turning it on records a
fingerprint of what it approves: the prompt (in its commit-tidied form), the model and the `allow`
list. A file whose fingerprint no longer matches reads **changed** and does not run until it is
turned on again, so neither a pull nor a run of the schedule itself, which may edit files, can
change the schedule's prompt, model or `allow` without the person's yes. The time is not in the
fingerprint, so moving a run grants nothing; nor is the `name`, which labels the run's session and
the settings row and is never in what the run reads. The approvals and the run log live in
`userData/schedules.json`, keyed by remote and path, not in the clone: the agent can write anything
in the clone, and an approval it could write would be none.

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

**Turn a schedule on in one place.** Every machine that turns a shared schedule on runs it: on at a
laptop and a desktop, it runs twice, two drafts and two tasks for each mail. A schedule only one
person wants belongs in a `.local.md` file, which only their machine has.

**The agent writes schedules; the person turns them on.** The shipped `scheduled-agents` skill
teaches the file, the prompt (self-contained, results left in the vault as tasks, drafts or notes, a
summary at the end) and the CLI. `holi schedules list` is allowed and `holi schedules run`, for a
schedule that is already on, is a seeded `ask` rule. Turning one on is no command at all: the
`schedules.enable` capability opens only the UI door. An `ask` rule matches a command's text, which
a small script gets around, and an approval the agent could give itself would be none. **Settings →
Schedules** lists each schedule with its status (`on`, `off`, `changed`, `invalid` and why), when it
runs and its next run, what it may do without asking, its last run, a link to its file and to its
live run, a **Runs here** switch and **Run now**. While a schedule is off or changed, its row shows
the prompt the switch would approve, so nobody approves text behind a link. The switch approves
exactly that text: it sends back the fingerprint the row showed, and a file that changed since is
refused as "changed since you looked" and shown again.

**One check every half minute**, while the vault is open, plus one five seconds after it opens. A
check runs a schedule when its first moment after the last run (or after it was turned on) has
passed. Missed moments collapse into that one run: a laptop that slept, or a Holi that was closed,
through six half-hours runs once when it is back. A one-off runs once and then has nothing due.
Schedules run only for the open vault: a closed vault's `bridge.local.env` is gone, so a session in
it could not reach `holi`.

**A run is a background session** started with `claude --bg`, no terminal, named `<name> · HH:MM`.
Its first turn is one line Holi adds (the schedule's path, the time, the previous run's time, so a
prompt can say "since the previous run") and then the file's body. It is in the sidebar like any
session, pauses sync through the turn hooks like any session, and asks the person in the usual way
when it needs a tool its schedule does not allow.

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
run's record gets `finishedAt` (and `kept` when left open), which the settings section shows, and
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

**Claude Code's own `schedule` skill is off** in a vault (`skillOverrides`): its routines run in
Anthropic's cloud, away from the vault clone, Holi and the vault's Google account. `loop` stays; it
repeats inside one session.

## Rules

- Never run a schedule this machine has not approved in its current content.
- Keep approvals out of the vault clone, and turning a schedule on out of the agent's reach.
- Only what the approval covers reaches a run: its path and prompt, never its name.
- A run never starts on top of a previous run that is working or needs the person.
- A run closes itself when done, never while it waits on the person or someone has it open.
- Missed moments are one run, never a backlog.
- Holi adds one line to a run's prompt and nothing else; what `holi google` prints of other
  people's words reaches a run fenced, through a command, never in its prompt. Text a person
  already copied into the vault (a task made from a mail or an event, a vault app's records) is
  vault content and reaches a run unfenced.

## Rejected

- **A system scheduler** (`launchd`, `cron`): runs without Holi, so without the bridge, the sync
  pause or the Google tokens, and outlives the vault being removed.
- **Cloud routines**: cannot reach the clone's machine-local files, Holi or the user's mail.
- **Running a committed schedule wherever the vault is open**: a pull would start unattended agent
  runs on a teammate's laptop with their credentials.
- **`--dangerously-skip-permissions` or a permission mode for unattended runs**: `allow` names the
  tools one schedule needs; everything else keeps Claude Code's prompt. Auto mode
  (`--permission-mode auto`) was reconsidered for runs and is still out, for two reasons. It answers
  yes in the person's place to everything outside the approved `allow`, so the approval would no
  longer say what a run may do. And it allows local file operations in the working directory by
  default, which is the whole vault, so the narrow `Edit(tilbud/**)` rules that keep a run off
  `AGENTS.md`, memory and skills would give way to a model's judgement
  ([Claude Code permission modes](https://code.claude.com/docs/en/permission-modes)).
- **`holi schedules enable` behind an `ask` rule**: the rule matches the command's text, so a
  script that calls the bridge gets around it. Turning on is the Settings switch's alone.
- **GitHub Actions**, for runs like these. Every vault is a GitHub repository, so a scheduled
  workflow would run with every laptop shut, exactly once, its history beside the vault. But it runs
  on a fresh checkout on GitHub's machine, away from Holi: no machine-local files, no bridge and so
  no `holi` commands, nobody to answer a permission prompt, and its commits land by push outside
  sync's pause. The Google login and a Claude credential would be repository secrets, which any
  workflow a collaborator with write access pushes can read. It could suit a schedule that needs
  none of that, a weekly digest of the vault itself; mail, the reason schedules exist, needs the
  person's machine.
- **One long-lived session a schedule types into**: Holi cannot submit into a live session, and a
  growing conversation costs more each run. A fresh session per run starts clean.
- **A timer per schedule**: a sleeping laptop wakes to a stale timer; a periodic check reads the
  clock.

## Code

- `packages/shared/src/cron.ts`: the cron grammar, the next moment, the shortest gap, words
- `packages/shared/src/schedule.ts`: the file, its approval text, `dueRun`, `nextRun`
- `apps/desktop/src/plugins/agent/main/schedules/scheduler.ts`: the check, approvals, runs
- `apps/desktop/src/plugins/agent/main/schedules/capabilities.ts`:
  `schedules.list|enable|disable|run`, `enable` at the UI door only
- `apps/desktop/src/plugins/agent/main/claude/cli.ts` (`startBg`'s `model` and `allow`),
  `main/host/sessions.ts` (`launch`, a session with no terminal)
- `apps/desktop/src/plugins/agent/renderer/SchedulesSection.tsx`: the settings section
- `apps/desktop/src/plugins/agent/main/claude/vault/shipped/.claude/skills/scheduled-agents/`
