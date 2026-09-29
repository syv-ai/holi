# Agent sessions

The vault assistant is Claude Code, run as Claude Code runs it. Every session is a Claude Code
**background session**: the per-vault supervisor runs it, its short job id names it, and it
outlives any window onto it. Holi opens terminals onto those sessions, reads what they are doing,
keeps its own git out of their way, shows what each turn changed, and hands them merge conflicts.
Configuration is in [agent-config.md](agent-config.md).

## How it works

**Sessions are Claude Code's.** Holi never spawns a conversation in a PTY of its own. It asks Claude
Code for one (`claude --bg [--name] [prompt]`, `--resume <id> --fork-session` for a copy), or the
person starts one in the agent list. A session is keyed by its **job id** everywhere: IPC, the turn
bracket, turn records. The id survives `/clear`, which changes the conversation's `sessionId`.

**One way to run `claude`.** `claude-cli.ts` runs every command Holi issues for a vault in the vault
clone, on its config directory, with one environment. The supervisor takes its environment from
whichever `claude` process started it and hands it to every session, so every call carrying Holi's
bin directory first on `PATH` is what keeps `holi` and `holi-google` resolvable in all of them.

**Terminals are windows.** A Holi terminal is a PTY running `claude agents` (the list) or
`claude attach <id>` (one session), with a headless-xterm `TerminalMirror` as its record. Closing
one detaches: the session keeps running. Its tab is labelled in Holi's names, so tab and row
agree: the live session its terminal title names (Claude Code titles an attached session by its
name), "Agents" for the list, and "New session" for an unnamed session, whose title is generic. What a
terminal shows can change under it (`←` in an attached session goes back to the list, and Enter
there attaches any session), so a terminal is never taken to be a session. When its client exits
(a detach, `/exit`, its session stopped) the tab closes.

**Where you meet it.** ⌘J and the nav menu's agent item focus a terminal showing the list, or
open one. Which terminal shows it is read from its title, since `←` and Enter move a terminal
between the list and a session. An agent tab's **Open overview** always opens a new one. The agent item is green while any session
is live. Under the file tree, one row per **live** session (its process alive): the state orb,
aligned with the nav menu's first icon, the name, and what it waits for when it needs you. At the
right end, where **Stop** shows on hover and keyboard focus, the rest of the time sits how much of
the session's context window is used: muted text below 60%, then text ramping from amber to
full red at 99%, nothing before the first message. A row opens its session in a terminal whose title names it, else the one Holi
opened for it, else a new `claude attach` window. An unnamed session, or a name two sessions
share, matches no title, so it can land in a second window; two windows on one session mirror
each other. With the nav hidden, the rail
shows one orb per live session. A stopped or finished session is not in the sidebar: it is in the
agent list, where opening it picks it up again.

**Stop, restart, duplicate.** A row's **Stop** runs `claude stop <id>`. An idle session stops at
once; one mid-turn or waiting on you asks first. Its context menu adds **Restart** (`claude
respawn`, a fresh process for the same conversation, which re-reads settings and `AGENTS.md`) and
**Duplicate** (a background copy of the conversation, opened in a window of its own). Rename is
Claude Code's: `/rename`, or Ctrl+R in the list. **Start another session** on an agent tab starts
one with no prompt, which waits for yours.

**State is read, not inferred.** Main reads `claude agents --json` for the vault's config directory
and keeps the background rows under the vault root. `needs-you` is `status: waiting`, `working` is
`busy` or `shell`, then the turn bracket; a session started with no prompt reads `state: blocked`
and is idle. The read is triggered by a watch of `<configDir>/sessions/` and `jobs/` (edge triggers,
never parsed), by each turn hook, and by a vault opening. The one timer is a second read about a second
after an `idle` one, because a quiet session makes no watcher edge: a turn ends only when two
consecutive reads say idle. A failed read answers nothing, and the bracket still reports `working`.

**Context is the status line's.** `claude agents --json` carries no context figure and `/context`
is interactive, so the reading comes from the documented `statusLine` command: one inline shell
command in the vault's settings, with no script. Claude Code runs it on its own events, a
background session with no client attached included, and hands it JSON on stdin. `jq` (which ships
with macOS) prints the footer, `Opus 5.5 · 42% context`, so it reads the same in any Claude Code.
Inside a Holi background session the command also posts the JSON, detached, to the hook server's
`/statusline` with the vault's token from `holi.env` and the job id from `$CLAUDE_JOB_DIR`,
answered empty. Main keeps `context_window.used_percentage` per job id on the pushed session list
and drops it when the session stops. A `null` reading (before the first message, after `/clear`)
clears it.

**Asks are pasted, never submitted.** Text from a selection, task, mail thread or PDF comment goes
to a live session the user picks (needs-you sessions are not offered), or to a new one named from
its first line, as a bracketed paste with no Enter into that session's window. A window just opened
holds the paste until its TUI has printed and settled, with a 5 s backstop. **Reconcile and a stuck
push are the exception**: their first turn is the command's prompt.

**Git coexistence.** The seeded `UserPromptSubmit` and `Stop` hooks run `turn-signal.mjs`, which
reads `holi.env` in the session's config directory for the port and the vault's token, and posts
the job id from `$CLAUDE_JOB_DIR`. The vault has one working set: the first turn to start pauses
sync, the last to end resumes it and takes one settle commit. A session also leaves the set when
its process goes, on two consecutive `idle` readings (escaping a permission prompt fires no `Stop`),
or on a 10 minute cap. Sessions keep running while Holi is closed, so the first read after a vault
opens puts any session already busy into the set.

**Turn review.** A turn is a commit range, `base` at start to the settle commit. Records go to
`.holi/state/turns.local.json` (50, newest first), keyed by job id; files and diffs come from git
when shown. A chip under a session's window says `Claude changed N files` and opens a review with
per-hunk accept and reject, saved as one new commit per file. An overlapped turn says so; an
unreachable range says its history is gone.

**Merge resolver.** "Ask Claude to reconcile" re-runs the merge without aborting and starts a
session whose first turn names the conflicted paths. The agent resolves and commits the merge in
view. The sync side is in [vaults-sync.md](vaults-sync.md).

**Leaving a vault stops its sessions.** A vault switch, adding a vault, and quitting Holi each
`claude stop` the vault's live sessions, asking first if one is working or needs you, then close
every terminal and delete `holi.env`. The conversations stay in the agent list, except a session
Holi started with no prompt that never had a turn: it is `claude rm`'d, since it would sit there
as a nameless row that resumes blank. That is Holi's own record (a turn hook, or the listing
showing it busy, crosses it off), so a session resumed from the list is never removed.

## Rules

- Never infer session state from PTY output. A terminal's title labels and finds a tab, never
  keys a session.
- Key a session by its job id, never by the conversation's `sessionId`, which changes on `/clear`.
- Run every `claude` for a vault through `claude-cli.ts`, so the supervisor's environment is
  always Holi's.
- Probe a pid before signalling it: signal the group only if it still leads its group. A reaped pid
  may already be a stranger's. Holi only ever signals its own terminal clients.
- Only reconcile, a stuck push and a skills update's conflicts submit a turn. Holi cannot see the
  composer.
- Record a turn after the vault resumes, fire-and-forget: a lost record beats a stuck pause.
- A turn revert does not flush open buffers first; a dirty buffer 3-way merges.
- Turn-hook and status-line responses are empty: a turn hook's body would be injected into
  Claude's context, and the status line prints its own footer.

## Rejected

- Holi's own PTY sessions joined to the listing by pid: a backgrounded conversation moves to a
  process Holi never spawned.
- A bearer or port in a session's environment: a background session's environment is the
  supervisor's, and the supervisor outlives a Holi restart.
- A headless chat panel or a server-side agent: re-implements the TUI.
- A Holi list of past sessions: the agent list is that list.
- A gate before the agent's writes: Claude Code already asks.
- Recording touched paths from `PostToolUse`: misses edits made through `Bash`.
- A worktree per session: edits invisible until merged, `.local.` files absent. Hence the seeded
  `worktree.bgIsolation: "none"`.
- A `Notification` or `PermissionRequest` hook for needs-you: late or partial.
- Reading context use from transcripts or the PTY: Claude Code's files and screen are not an
  interface; its status-line JSON is.
- A three-pane merge editor: resolves positionally, wrong for prose.

## Code

- `apps/desktop/src/main/agent/claude-cli.ts`: every `claude` command, one environment
- `apps/desktop/src/main/agent/claude-sessions.ts`: the listing, state rules, the watch
- `apps/desktop/src/main/agent/agent-terminals.ts`, `agent-runtime.ts`, `terminal-mirror.ts`:
  terminals, the PTY and kill path
- `apps/desktop/src/main/agent/agent-sessions.ts`: the vault controller
- `apps/desktop/src/main/agent/endpoint-file.ts`, `hooks/turn-signal.mjs`, `seed-content.ts`
  (`STATUS_LINE`): how sessions find Holi
- `apps/desktop/src/main/agent/turn-coordinator.ts`, `turn-log.ts`: working set and turn records
- `apps/desktop/src/renderer/src/features/agent/`: rows, orbs, terminal, turn chip and review
- `apps/desktop/src/renderer/src/state/agent.ts`, `agent-send.ts`: the lists, and what you do
