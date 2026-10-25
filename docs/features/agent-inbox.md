# Agent inbox

Quiet by default, loud when it matters. A background session that pings on every step is worse
than one that never runs, so what the agent does goes into the vault and its work log, and the
person hears about it only when their attention is needed: a deliverable to review, a decision, a
blocker, or a session waiting on them. Sessions are in [agent-sessions](agent-sessions.md); the
runs that use this most are [scheduled agents](scheduled-agents.md).

## How it works

**`holi agent notify <title> <line> [--path p] [--session id]`** is how the agent asks for
attention. It adds an entry to the inbox, raises a native notification (the one reminders use) when
no Holi window has focus, and appends a line to the day's work log. `--path` is a vault path the
entry opens, held to what `holi docs open` may show (never `.holi/state/` or a secret file, the
shared `shownPathOrNull`), `--session` a session by job id (eight hex characters; anything else is refused, so
no value can reach `claude attach` as a flag). Run from a background session, the `holi` script
fills `--session` from `$CLAUDE_JOB_DIR` itself, as the status line does, so the agent never
passes its own id; a `--path` is still what the entry opens first. It answers `notified`,
`added to the inbox`, or `already in the inbox, not repeated`. It needs Holi to have the vault
open: the `holi` command finds Holi through the vault's bridge file, which Holi deletes when it
leaves the vault, and a notice for a vault that is not the open one is refused (`UNAVAILABLE: vault-not-open`), so
a run's results have to wait in the vault itself. The seed allows it without a prompt ([agent-config](agent-config.md)):
asking would stop an unattended run at a prompt nobody sees.

**`holi agent log <line>`** appends one line to the day's work log and does nothing else: what is
worth remembering but not an interruption, such as a quiet run's "checked mail, nothing new". Like `notify` it needs Holi to have the vault open, and
the seed allows it too.

**Needs-you notifies.** When a session's listing goes into Claude Code's `waiting` status, the
inbox gets "_name_ needs you" with what it waits for, opening that session. It is an edge per
session: once on the way in, and again only after the session has stopped waiting. A session the
inbox already holds an entry for, of any age, counts as already told when Holi starts watching, so
restarting Holi or reopening the vault does not tell about a session still waiting. Not while the
person is plainly looking, which is a session Holi has a terminal open on with Holi's window
focused.

**Mentions.** A teammate's comment that mentions the person, arriving with a pull, becomes
"_login_ mentioned you" with the passage and the comment, opening the note
([note-comments](note-comments.md)).

**Quiet rules.** A notice equal to an entry the inbox got in the last five minutes (same title,
line, path and session) is a repeat and raises nothing. Banners are at least 30 seconds apart: a
burst lands in the inbox with only its first on screen. A banner never shows over a focused Holi;
the entry is enough there.

**The inbox.** `.holi/state/inbox.local.json`, machine-local, newest first, at most 50 entries:
each has a time, a title, a line, and optionally a path or a session. Main pushes it to the
renderer as the agent's `inbox` event on every change (`state/inbox.ts`), which opens an entry's
note or session: a note as any arrival main asks for does, beside the agent when it has the focus,
and only when it passes the same `shownPathOrNull` check. A banner's click brings Holi forward and
opens the entry the same way. The Inbox at the top of the sidebar's Agents mode
([agent-sessions](agent-sessions.md)) does not list these entries yet ([not-built](../not-built.md)).

**The work log.** `.holi/state/log/<YYYY-MM-DD>.local.md`, one per local day, one line per thing
done (`- 14:05 Offer drafted: Check the prices. [[tilbud/a.md]]`), so "what did you do this week?"
is a grep. Personal and never synced, and kept 30 days ([agent-memory](agent-memory.md)). `holi agent notify` and `holi agent log` write lines there,
and the scheduler writes one when a scheduled run is done or fails to start
([scheduled-agents](scheduled-agents.md)), so a run that notified nobody still shows. A routine's
own results go in the vault, where the person will look.

**The heuristic is a skill.** The shipped `notify` skill tells the agent to notify on finished
deliverables, decisions and blockers, to log the rest with `holi agent log`, to leave needs-you to Holi, and never
to notify twice for the same thing. `scheduled-agents` points a run's prompt at it.

## Rules

- The listing's `waiting` is the needs-you source, never a hook or the terminal.
- One native notifier: plugins reach it as `ctx.notify`, which raises nothing while a Holi window
  has focus.
- The inbox and the log are `.local.`: what ran on this machine is not the vault's content.

## Rejected

- A banner for every notice: a burst of them is noise, and the inbox already holds each one.
- A `Notification` hook for needs-you: late or partial ([agent-sessions](agent-sessions.md)).
- An inbox in the vault's synced content: one person's machine's runs, shown to every teammate.

## Code

- `apps/desktop/src/main/notifications.ts`: the native notifier; `main/index.ts` wires `notify`
  and `focused` into the plugin context
- `apps/desktop/src/plugins/agent/main/inbox/rules.ts`: repeats, banner spacing, the cap, the
  needs-you edge
- `apps/desktop/src/plugins/agent/main/inbox/inbox.ts`, `needs-you.ts`, `work-log.ts`,
  `capabilities.ts`: the inbox, the needs-you watch, the work log, `agent.notify` and the inbox's
  verbs
- `apps/desktop/src/plugins/agent/renderer/state/inbox.ts`: the renderer's copy and opening an entry
- `apps/desktop/src/plugins/agent/main/claude/vault/shipped/.claude/skills/notify/SKILL.md`: the
  heuristic
