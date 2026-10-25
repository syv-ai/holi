# Agent sessions

The vault assistant is a coding agent run as it runs itself, in a terminal: Claude Code or Codex
so far, one **provider** each. A session is the agent's own TUI, never a re-drawing of it, so any
agent with a CLI can be one. Holi opens terminals onto sessions, reads what they are doing from
signals rather than from their text, keeps its own git out of their way, shows what each turn
changed, and hands them merge conflicts. Configuration is in [agent-config.md](agent-config.md).

## Providers

A provider (`agent/main/provider.ts`) is everything one agent owns: the command a terminal runs,
its per-vault directory, what it seeds. **Its core is enough to run it in a tab**; the rest are
**capabilities**, and the UI offers a feature only when the session's provider has it:

| Capability   | What it gives                                                                    | Claude Code                | Codex                    |
| ------------ | -------------------------------------------------------------------------------- | -------------------------- | ------------------------ |
| `background` | sessions its own supervisor runs, which outlive a terminal and can run unwatched | `claude --bg`              | no                       |
| `turns`      | hook routes that report a turn's start and end                                   | `UserPromptSubmit`, `Stop` | turn ends, from `notify` |
| `status`     | how full the context is, and the model                                           | the status line            | no                       |

**Two kinds of session, one list.** A background provider's sessions are its supervisor's, keyed
by its job id (the rest of this page). Any other provider's are **sessions Holi runs itself**
(`host/pty-sessions.ts`): the CLI in a PTY in the clone, named by Holi's id (`p` and twelve hex
digits), alive exactly as long as that process. Closing its tab leaves it running and its row
brings it back; Stop ends it. Both kinds are one `sessions` event, each summary carrying its
`provider`, and every `agent.*` verb goes to the kind the id names; one a kind cannot do (Restart
and Duplicate on a session Holi runs) is refused in words.

**A session Holi runs is read off its terminal**, unless its hooks say (`host/pty-signals.ts`):
Enter typed outside a paste begins a turn, five seconds without output ends one (a TUI at work
redraws its spinner every second), and a bell or an OSC 9 / OSC 777 notification during a turn is
a question for the person, which the next keystroke answers. Only those signals are read, never
the text. Coarser than a hook by design: right for a status dot and the sync pause, not for
chaining work on. Its turns go through the same turn bracket as a background session's, so sync
pauses and the turn is recorded.

**Codex**, run as `codex -c notify=[…]`: a command-line override that installs Holi's hook for
that run and writes nothing into `~/.codex`, whose sign-in and config stay the person's. The hook
is one inline shell command, like Claude Code's status line: Codex runs it at each turn's end with
the turn's JSON, and it posts that to the bridge's `/codex/turn-end` with the session's id, which
the PTY's environment carries (`HOLI_AGENT_SESSION`). Holi takes the session's name from its first
ask and its thread id for Resume. Codex reads the vault's `AGENTS.md` itself. Its own hooks
(`UserPromptSubmit` and the rest) would give a turn's start too, but each must first be trusted in
`/hooks`, so Holi does not use them. **Resume a Codex conversation**, in the menu on the
Sessions +, opens `codex resume`, Codex's own picker.

**Which agent a new session runs** is this machine's `agentProvider` (`app.local.yaml`; the
**Agents** card in Settings → General, a row per agent with **Make default**): which agent is installed and signed in is the machine's, not the
vault's. The menu on the Sessions + picks another for one session. **Holis and automations always
run Claude Code**: their runs start with nobody watching, which needs `background`, and
`agent.launch` refuses a provider without it.

## How it works

**Claude Code's sessions are its supervisor's.** Holi never runs a Claude Code conversation in a
PTY of its own. It asks Claude Code for one (`claude --bg [--name] [prompt]`, `--resume <id> --fork-session` for a copy), or the
person starts one in the agent list. A session is keyed by its **job id** everywhere: capabilities, the turn
bracket, turn records. The id survives `/clear`, which changes the conversation's `sessionId`.

**One way to run `claude`.** `claude-cli.ts` runs every command Holi issues for a vault in the vault
clone, on its config directory, with one environment. The supervisor takes its environment from
whichever `claude` process started it and hands it to every session, so every call carrying Holi's
bin directory first on `PATH` is what keeps `holi` resolvable in all of them.

**Hooks need a `node`, and a Dock-launched Holi has none on its `PATH`.** Every seeded hook is
`node "<script>"`, and an app opened from the Dock or Finder has launchd's `PATH`
(`/usr/bin:/bin:/usr/sbin:/sbin`). Left like that every hook exits 127, which Claude Code counts as
non-blocking, so the turn signals, the focus context and the Google send gate quietly stop. The
agent's `PATH` is therefore Holi's bin directory, the inherited `PATH`, the usual tool directories
(`toolPath`: Homebrew's, `~/.local/bin` and so on), and last Holi's own `node` (`bin/fallback/node`,
written at every launch: the app's executable run with `ELECTRON_RUN_AS_NODE`). A `node` the machine
has is always found first. The supervisor keeps the environment of the process that started it, so an
already running one picks this up only after it has exited (it does when idle).

**Terminals are windows.** A Holi terminal is a PTY running `claude agents` (the list) or
`claude attach <id>` (one session), with a headless-xterm `TerminalMirror` as its record. Closing
one detaches: the session keeps running. Its tab is labelled in Holi's names, so tab and row
agree: the live session its terminal title names (Claude Code titles an attached session by its
name), "Agents" for the list, and "New session" for an unnamed session, whose title is generic. What a
terminal shows can change under it (`←` in an attached session goes back to the list, and Enter
there attaches any session), so a terminal is never taken to be a session. When its client exits
(a detach, `/exit`, its session stopped) the tab closes. An agent tab is the surface `agent`, kept mounted,
with the terminal id as its id. The agent is `agent` (`src/plugins/agent/`), a part of Holi
written to the plugin contract and built in, so no vault turns it off
([architecture](../architecture.md), Plugins), and its renderer side (`renderer/index.tsx`) registers its tab (with `tabs`, so the strip,
the palette and the recents read each terminal's label and status dot), its nav item (which runs
`agent.show`), its commands (`agent.show` on ⌘J, `agent.new`), its rows, orbs and turn review, the
palette's session rows, the leave question, and the agent service every "Ask" goes through
(`useAgentService`). Its main side starts with the vault and attaches to it (`activate`), and its disposer stops the vault's sessions and terminals. The
renderer reaches it through the `agent.*` capabilities (sessions, terminals, open, start, send,
message, stop, respawn, duplicate, attach, detach, and the turn review's turns, turnFiles, turnDiff and
revert, which deletes a file the turn created rather than leaving it empty). Main tells it the session and terminal lists and each terminal's bytes as the events
`sessions`, `terminals`, `pty-data` and `pty-exit`; keystrokes and resizes go back as the events
`pty-write` and `pty-resize`, which keep their order. A terminal's bytes go straight to its xterm
(`renderer/lib/session-terminals.ts`), never through an atom. A stale `agent: false` an older Holi
wrote into `plugins.yaml` is ignored, and dropped at the file's next write.

**Other plugins drive the agent through it, never around it.** The agent knows nothing of a
plugin that requires it ([architecture](../architecture.md), Plugins); it offers general
capabilities any such plugin calls, from its renderer or, through `ctx.call`, from its main side:
`agent.launch` (a background session whose first turn is a prompt, with no terminal),
`agent.providers` (the agents a session can run, and which are installed), and the session verbs.
Holis and automations are such callers. The turn bracket's outside driver is the agent's own
sessions Holi runs: the listing never names their ids, so its reconcile forgets only the turns of
its own sessions.

**Where you meet it.** ⌘J and the nav menu's agent item focus a terminal showing the list, or
open one. Which terminal shows it is read from its title, since `←` and Enter move a terminal
between the list and a session. An agent tab's **Open overview** always opens a new one. The agent
item is green while any session is live. The sidebar's **Agents** mode ([sidebar](sidebar.md)) is the agent's. At
the top, **Inbox**: what needs you, the
sessions waiting on a permission prompt or a question and what other plugins add there (a Holi's
report that asked for you); empty, it says what lands there and offers a new session. It is a row
of its own and never the home: a tab with nothing selected says no session is open there, and
offers one.
Under it **History**, then the places plugins add (Automations), then their sections
([Holis](holis.md)), then **Sessions** with its **+** (⌘N).

**Sessions are the open ones, as tabs are open documents; History is every one.** The rows are
the agent's live sessions, of every provider; the background sessions the listing still has but
whose process is gone (`agent.history`, pushed as `history`), idle, which opening brings back with
`claude respawn`; and the rows plugins add through their slot's
`sessions` (each Holi's and each automation's recent runs). A session the person starts is open from the
moment it starts until they close it, with the × that shows on its card's hover or the menu's
**Close session**. Closing stops what it runs, deliberately: through its slot's `close` when a
plugin owns the row, and a live session with Stop. It is not the tab's ×:
closing a tab leaves the session open, and closing the session leaves a tab showing it. A Holi's
or an automation's run is in Sessions only while it needs you, or once opened. Opening any row,
from History, the command menu or the Inbox, puts it back. Which rows are open is this machine's
(`holi.agents.sessions.open`), counted from when it started keeping track, so conversations from
before then wait in History. Sessions has no day groups: what needs you, what is pinned, then the
most recent. **History**, in the main view, has every row by day (Needs you, Pinned, Today,
Yesterday, Earlier) under **Search conversations…** and its filter menu. A plugin's row that is an agent session (its job id)
and the live session with that id are one row: the session gives it its state and model, the
plugin its title and who ran it. A card is two lines: the title, in full on hover, with the age on
the right; then, quieter, a mark (a Holi's face, or an automation's bolt, when one ran it, else the
mark of the agent it runs: Claude's, or OpenAI's for Codex, as on its tab and in the + menu), the
model and where it ran (a Holi's document). The vault is left out, since every card is in
the open one. The title is the card's only line in the foreground, and History's day groups sit
dimmer than its cards. A card selects what it stands for
(`agentsSelectionAtom`) or opens the session it is, brought back first when it has finished.
**+**, ⌘N and the empty state start a session in the default agent at once (New sessions,
below). Any session opened from its card, a
Holi's or an automation's run included, shows in its terminal, where its prompts are answered.
Search reads the title, who ran it, the place and the
model; the filter keeps states, who started it (you, or Holis and automations), and archived rows
on request. Arrow keys, Home and End move between cards; Enter opens one.

**A card's menu**, after MonoCode's, is the same list on right-click and on the ⋯ that shows on
hover and focus, and it offers only what something backs. The row's owner backs **Pin to top** /
**Unpin**, **Rename** (a field in the row: Enter saves, Escape cancels, leaving it saves; F2 opens
it too), **Archive** / **Unarchive** and **Delete…**, through its slot's `pin`, `rename`, `archive`
and `remove`; a Holi's or an automation's run backs none, and nor does a live session the agent
lists itself, so their cards offer none. **Mark as read** / **Mark as unread** is this machine's read state
(`holi.agents.sessions.seen`): an unread mark is done until the row is opened. **Copy session ID**
copies Claude Code's id for it, a conversation's (what `--resume` takes) or a run's job id.
**Open in terminal** opens it in an agent tab of the Documents mode: a live background run with
`claude attach`, or a conversation by its id as a copy (`claude --resume <id> --fork-session`). Sessions empty says **No active sessions** and offers a new
session and History. Any session
offers **Review last turn**, the turn review on what its last turn changed. A live session keeps
**Stop session**, and a background one **Restart** and **Duplicate** too: an agent Holi runs
itself has neither, so its rows don't offer them. An open card's menu
offers **Close session**, in History too. Delete asks first in an
alert naming the session, and says what stays. Pinned rows sit under what needs you, in Sessions
and in History's **Pinned** group above the days.

**Each card's state is said in words and a glyph, never colour alone**, and it takes the age's
place as MonoCode's does:

- **Needs you**: a permission prompt or a question waits (Claude Code's own state, or a
  notification from a session Holi runs), or a Holi's report asked for you. A warning badge
  whose tooltip says what it waits on, a dashed card, and pinned in a **Needs you** group above
  the rest.
- **Working**: a turn is in flight. The house spinner, still under reduced motion, and "Working".
- **Done**: a turn ended after the row was last opened. A check before the age, until the row is
  opened; the open row is never done. A run's end is recorded with it; a live session's is noted when this window sees it stop working (MonoCode's unseen-finished rule).
  When each row was last opened is this machine's (`holi.agents.sessions.seen`), and a turn that
  ended before it began keeping track is not news.

The rest are grouped, after the pinned ones, by the day of their last activity: Today, Yesterday,
Earlier. The model
comes from the session's status line (`model.display_name`), the start time from the listing's
`startedAt`. A session or Holi that needs you is a steady amber dot elsewhere too, never a
breathing one, since waiting is a state and not work. A stopped session that no plugin lists is
not in the view: it is in the agent list, where opening it picks it up again. The mode toggle
counts what needs you and what works, sessions and Holis and what other plugins add, from either
mode.

**The session view.** A session opened in the Agents mode is its terminal, in a window of the
view's own (`agents/AgentsMain.tsx`): a background session's is a `claude attach` that closes
with the view, a session Holi runs is shown in its own terminal, which stays. **The terminal is the
whole view**, with nothing drawn over or beside it: the agent's own TUI is the interface, and its
name, state and model are on the sidebar row and the tab, its Stop, Restart and Review last turn
in the row's menu.
A vault path in the output is a link that opens the file in a
pane, and only a path the vault has is one (`renderer/lib/terminal-links.ts`).

**New sessions start at once, in their terminal.** The Sessions **+**, ⌘N, the tab strip's + and
⌘T on the Agents side and the command menu's **New session** start one in this machine's default
agent, waiting for the first message, and bring its tab forward (the mode's `newSession`). There
is no page in between: the terminal is where the first message goes. Hovering the Sessions + (or
↓ on it) opens a menu of the other ways in (`sessions/NewSessionButton.tsx`): a session in each
agent, one not on this machine listed but off, and **Resume a … conversation** for an agent Holi
runs itself. A start that fails says why in a toast. The command menu's **Ask the agent** and an
app card's **Ask about this app** start a session the same way (the agent's slot `start`), the
ask as its first turn and an app named ahead of it by its folder; with only an app, its line goes
in unsent for the person to finish.

**Stop, restart, duplicate.** A row's **Stop** runs `claude stop <id>`. An idle session stops at
once; one mid-turn or waiting on you asks first. Its context menu adds **Restart** (`claude
respawn`, a fresh process for the same conversation, which re-reads settings and `AGENTS.md`) and
**Duplicate** (a background copy of the conversation, opened in a window of its own). A live
session's own name is Claude Code's: `/rename`, or Ctrl+R in the list. **Start another session** on an agent tab starts
one with no prompt, which waits for yours.

**State is read, not inferred.** Main reads `claude agents --json` for the vault's config directory
and keeps the background rows under the vault root. `needs-you` is `status: waiting`, `working` is
`busy` or `shell`, then the turn bracket; a session started with no prompt reads `state: blocked`
and is idle. The read is triggered by a watch of `<configDir>/sessions/` and `jobs/` (edge triggers,
never parsed), by each turn hook, and by a vault opening. The one timer is a second read about a second
after an `idle` one, because a quiet session makes no watcher edge: a turn ends only when two
consecutive reads say idle. A failed read answers nothing, and the bracket still reports `working`.
A session going into `needs-you` puts one entry in the [agent inbox](agent-inbox.md), and a banner
while Holi is out of sight, which opens it: on the edge into the state, read off this listing.
Banners are at least 30 seconds apart, so several sessions waiting at once show one banner and the
rest only in the inbox.

**Context is the status line's.** `claude agents --json` carries no context figure and `/context`
is interactive, so the reading comes from the documented `statusLine` command: one inline shell
command in the vault's settings, with no script. Claude Code runs it on its own events, a
background session with no client attached included, and hands it JSON on stdin. `jq` (which ships
with macOS) prints the footer, `Opus 5.5 · 42% context`, so it reads the same in any Claude Code.
Inside a Holi background session the command also posts the JSON, detached, to the bridge's
`/statusline` with the vault's token from its `bridge.local.env` and the job id from `$CLAUDE_JOB_DIR`,
answered empty. Main keeps `context_window.used_percentage` per job id on the pushed session list
and drops it when the session stops. A `null` reading (before the first message, after `/clear`)
clears it.

**Asks are pasted, never submitted.** Text from a selection, task, mail thread or PDF comment goes
to a live session the user picks (needs-you sessions are not offered), or to a new one named from
its first line, as a bracketed paste with no Enter into that session's window. A window just opened
holds the paste until its TUI has printed and settled, with a 5 s backstop. **Reconcile, a stuck
push, a scheduled run and a Holi's send are the exception**: their first turn is the command's
prompt. A first turn goes after `--`, so one that starts with a dash is a prompt and not an option.
A scheduled run opens no window at all ([scheduled-agents](scheduled-agents.md)); a Holi's send
opens its agent tab ([holis](holis.md)).

**Messages go through the session's inbox.** Every Claude Code session that is not `--bare` binds
an inbox socket for cross-session messaging and exports its path and a per-session token to its
hooks as `CLAUDE_CODE_MESSAGING_SOCKET` and `CLAUDE_CODE_MESSAGING_TOKEN`, set before
`SessionStart`. `turn-signal.mjs` posts both to the bridge at `SessionStart` (`/session`) and at
each turn's start (`/turn/start`, in the body), and main keeps them per job id, in memory only:
dropped when the session leaves the live listing, when a write to it fails, and when Holi leaves the
vault. Holi never reads Claude Code's own session files for them. `agent.message` (`holi agent
message <session> <text>`) opens the socket, writes the auth line `{"type":"auth","token":…}` and
one user line `{"type":"user","message":{"role":"user","content":…}}`, and closes. An idle session
starts a turn with it; a working one reads it after the tool call in flight, queued behind the turn.
The composer is never touched, so a person typing in a window onto the session keeps their text.
The token makes the message count as the session's own child, so a session that skips permission
prompts delivers it rather than holding it behind a dialog. Claude Code tells the model it came
from another session, not from the person: it approves nothing and changes no configuration. The
write is sent once and never retried. A session with no inbox known, or whose socket is gone, is
refused with the reason. The pre-commit transforms use it: a commit the session made itself tells
it what they rewrote ([vaults-sync](vaults-sync.md)). **The risk**: Claude Code's documentation page describes the socket and
the auth line but not the message line, whose shape comes from Claude Code's own debug log and
was checked live, so a release can change it. The socket answers nothing, so a session whose
`crossSessionInbound` is `refuse` (or `hold`) drops (or sets aside) the message without Holi
knowing. Claude Code rate-limits each sender and queues at most 50 messages. A vault opened
without Holi has no bridge, and the hook does nothing.

**Git coexistence.** The seeded `UserPromptSubmit` and `Stop` hooks run `turn-signal.mjs`, which
reads the vault's `bridge.local.env` ([agent-config](agent-config.md)) for the port and the vault's token, and posts
the job id from `$CLAUDE_JOB_DIR`; at a Stop, also `pending`, how many background tasks and
session crons its input lists, which is what tells a done session from a paused one
([scheduled-agents](scheduled-agents.md)). The vault has one working set: the first turn to start pauses
sync, the last to end resumes it and takes one settle commit. A session also leaves the set when
its process goes, on two consecutive `idle` readings (escaping a permission prompt fires no `Stop`),
or on a 10 minute cap. Sessions keep running while Holi is closed, so the first read after a vault
opens puts any session already busy into the set.

**Turn review.** A turn is a commit range, `base` at start to the settle commit, or, for a turn
that ended while another session's was still running, to a tree object of the working tree as it
ended. Records go to `.holi/state/turns.local.json` (50, newest first), keyed by job id; files and
diffs come from git when shown. A turn that changed nothing is recorded too, since the prompt hook
counts "changed since your last turn" from it ([agent-config.md](agent-config.md)), but only the
session's latest such one is kept, and the chip skips it. A chip under a session's window says
`Claude changed N files` and opens a review with per-hunk accept and reject, saved as one new
commit per file. An overlapped turn says so; an unreachable range says its history is gone.

**Merge resolver.** "Ask Claude to reconcile" re-runs the merge without aborting and starts a
session whose first turn names the conflicted paths. The agent resolves and commits the merge in
view. The sync side is in [vaults-sync.md](vaults-sync.md).

**Leaving a vault stops its sessions.** A vault switch, adding a vault, and quitting Holi each
`claude stop` the vault's live sessions, asking first if one is working or needs you (the agent's
`leaveGuard` and quit guard), then close
every terminal; closing the vault deletes its `bridge.local.env`. The conversations stay in the agent list, except a session
Holi started with no prompt that never had a turn: it is `claude rm`'d, since it would sit there
as a nameless row that resumes blank. That is Holi's own record (a turn hook, or the listing
showing it busy, crosses it off), so a session resumed from the list is never removed.

## Rules

- Never read session state from a terminal's text. A session Holi runs is read from signals only
  (a keystroke's Enter, quiet, a notification), and a terminal's title labels and finds a tab,
  never keys a session.
- Never answer an agent's own prompts or add a prompt system: a session's questions are its
  terminal's.
- Key a session by its job id, never by the conversation's `sessionId`, which changes on `/clear`.
- Run every `claude` for a vault through `claude-cli.ts`, so the supervisor's environment is
  always Holi's.
- Probe a pid before signalling it: signal the group only if it still leads its group. A reaped pid
  may already be a stranger's. Holi only ever signals its own terminal clients.
- Only reconcile, a stuck push, a skills update's conflicts, a scheduled run, a Holi's send and
  Ask the agent submit a turn, each as the first turn of a session of its own.
  Anything else Holi puts in a session is a paste, unsent. Holi cannot see the composer, so
  nothing is ever submitted through a terminal: a message into a running session goes through its
  inbox socket.
- Draw nothing over a session's terminal and add no input of Holi's own: the agent's TUI is the
  session UI.
- Record a turn after the vault resumes, fire-and-forget: a lost record beats a stuck pause.
- A turn revert does not flush open buffers first; a dirty buffer 3-way merges. It is written over
  the text the review showed: a file changed since is merged with what the reviewer kept, and one
  whose change overlaps it is refused with a message in the panel, nothing written.
- Turn-hook and status-line responses are empty: a turn hook's body would be injected into
  Claude's context, and the status line prints its own footer.

## Rejected

- A composer under the terminal that typed into it: it was built and taken out. A second input
  beside the agent's own fought it (two places to type, pastes and Enter landing mid-redraw), and
  the agent's own input already does what it did.
- Holi's own PTY sessions for Claude Code, joined to the listing by pid: a backgrounded
  conversation moves to a process Holi never spawned. A provider without a supervisor is the case
  Holi's own PTY sessions are for.
- A bearer or port in a session's environment: a background session's environment is the
  supervisor's, and the supervisor outlives a Holi restart.
- A conversation UI drawn by Holi, a chat on Claude Code's structured channel: it was built and
  retired. It re-implements each agent's TUI and binds the session UI to one agent's protocol, so
  every other agent would need its own; the terminal is the one surface every agent already has.
- Codex's `hooks` for a turn's start: each must be trusted in its `/hooks` first, a step between
  someone and their first session; `notify` needs none.
- A server-side agent: there is no server.
- A Holi list of past sessions: the agent list is that list.
- A gate before the agent's writes: Claude Code already asks.
- Recording touched paths from `PostToolUse`: misses edits made through `Bash`.
- A worktree per session: edits invisible until merged, `.local.` files absent. Hence the seeded
  `worktree.bgIsolation: "none"`.
- A `Notification` or `PermissionRequest` hook for needs-you: late or partial. The listing's
  `waiting` is what the inbox's needs-you notice reads.
- Reading context use from transcripts or the PTY: Claude Code's files and screen are not an
  interface; its status-line JSON is.
- A three-pane merge editor: resolves positionally, wrong for prose.
- Typing a message into a session's terminal: it lands in the person's input box.
- `claude --bg --resume <id> "prompt"` to add a turn: on a session whose process is alive it forks
  a copy, and only a stopped one continues under its job id.
- Claude Code's channels (an MCP server) for messages: a research preview needing a claude.ai or
  Console login, and not documented for background sessions.

## Code

- `apps/desktop/src/plugins/agent/main/index.ts`: the plugin's main side; `provider.ts`: the line between the host and
  the agents it runs, the core and the capabilities
- `apps/desktop/src/plugins/agent/main/codex/`: Codex as a provider: the command, the `notify` hook and its route
- `apps/desktop/src/plugins/agent/main/host/pty-sessions.ts`, `pty-signals.ts`: the sessions Holi runs itself, and
  their turns read off the terminal
- `apps/desktop/src/plugins/agent/main/claude/`: Claude Code as the provider: `cli.ts` (every `claude` command, one
  environment, the binary), `listing.ts` (the listing, state rules, the watch), `routes.ts` (the
  turn, session and status-line routes), `messaging.ts` (the inbox socket writer)
- `apps/desktop/src/plugins/agent/main/host/terminals.ts`, `pty.ts`, `terminal-mirror.ts`: terminals, the PTY and
  kill path
- `apps/desktop/src/plugins/agent/main/host/sessions.ts`: the vault controller
- `apps/desktop/src/plugins/agent/main/host/capabilities.ts`: the `agent.*` capabilities, each verb sent to the
  kind of session its id names
- `apps/desktop/src/main/plugin-api.ts` (`ctx.call`): one plugin's main side calling another's
  capabilities
- `apps/desktop/src/main/bridge/env-file.ts`, `apps/desktop/src/plugins/agent/main/claude/vault/shipped/.claude/hooks/turn-signal.mjs`,
  `apps/desktop/src/plugins/agent/main/claude/seed.ts` (`STATUS_LINE`): how sessions find Holi
- `apps/desktop/src/plugins/agent/main/host/turn-coordinator.ts`, `turn-log.ts`: working set and turn records
- `apps/desktop/src/plugins/agent/renderer/`: rows, orbs, terminal (`terminal.css`), turn chip and review; `index.tsx`: the
  plugin's renderer side; `service.ts`: the agent service
- `apps/desktop/src/plugins/agent/renderer/agents/AgentsMain.tsx`, `sessions/NewSessionButton.tsx`: the
  session view and the Sessions + with its menu;
  `state/providers.ts`: the agents and the default
- `apps/desktop/src/plugins/agent/renderer/state/sessions.ts`, `send.ts`, `turns.ts`: the lists, what you do, and turn review
- `apps/desktop/src/plugins/agent/renderer/state/session-list.ts`, `sessions/SessionList.tsx`: the one session list, its
  states, filter and groups
