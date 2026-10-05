# Agent sessions

The vault assistant is Claude Code, run as Claude Code runs it. Every session is a Claude Code
**background session**: the per-vault supervisor runs it, its short job id names it, and it
outlives any window onto it. Holi opens terminals onto those sessions, reads what they are doing,
keeps its own git out of their way, shows what each turn changed, and hands them merge conflicts.
Configuration is in [agent-config.md](agent-config.md).

## How it works

**Sessions are Claude Code's.** Holi never spawns a conversation in a PTY of its own. It asks Claude
Code for one (`claude --bg [--name] [prompt]`, `--resume <id> --fork-session` for a copy), or the
person starts one in the agent list. A session is keyed by its **job id** everywhere: capabilities, the turn
bracket, turn records. The id survives `/clear`, which changes the conversation's `sessionId`.

**One way to run `claude`.** `claude-cli.ts` runs every command Holi issues for a vault in the vault
clone, on its config directory, with one environment. The supervisor takes its environment from
whichever `claude` process started it and hands it to every session, so every call carrying Holi's
bin directory first on `PATH` is what keeps `holi` resolvable in all of them.

**Terminals are windows, never shown.** A Holi terminal is a PTY running `claude attach <id>`, with
a headless-xterm `TerminalMirror` as its record. The chat types into it and presses keys in it
(below), and shows it only for a dialog the chat cannot draw. Closing one detaches: the session
keeps running. What a terminal shows can change under it, so a terminal is never taken to be a
session, and when its client exits (a detach, `/exit`, its session stopped) it goes. The agent is
the plugin `agent` (`src/plugins/agent/`, on by default), and its renderer side
(`renderer/index.tsx`) holds the session lists and notices, the leave question, and the agent
service every "Ask" goes through (`useAgentService`). With the agent off there is no service, so no
"Ask" is offered. What is drawn of the sessions is a second plugin, `agent-ui`
(`src/plugins/agent-ui/`, on by default, `requires: ['agent']`, so it never runs without the agent):
its renderer registers the page (the surface `agent`, kept mounted, one page, no `tabs`), the nav
item (which runs `agent.show`), the commands (`agent.show` on ⌘J, `agent.new`), the overlay and
turn review, and the palette's session rows. It reads the agent's state by import, the one place a
plugin imports another; turned off, the agent still runs and its sessions are reachable from
`claude` itself. Its main side attaches in `activateVault` and leaves in its disposer. The
renderer reaches it through the `agent.*` capabilities (sessions, terminals, open, start, send,
stop, respawn, duplicate, attach, detach, and the turn review's turns, turnFiles, turnDiff and
revert). Main tells it the session and terminal lists and each terminal's bytes as the events
`sessions`, `terminals`, `pty-data` and `pty-exit`; keystrokes and resizes go back as the events
`pty-write` and `pty-resize`, which keep their order. A terminal's bytes go straight to its xterm
(`renderer/lib/session-terminals.ts`), never through an atom. Its main side is the plugin `agent`
(`src/plugins/agent/main/`), so in a vault with the agent off its capabilities are refused, its
events are not sent and nothing under `.claude/` is seeded.

**Where you meet it.** ⌘J and the nav menu's agent item open the agents page, and the stack of
bubbles floats over the top right of every tab (the plugin's `overlay`, `AgentBubbles`), so any
session is one hover away from a note or a board. The agent item is green while any session is live.
Statuses live only in the bubbles: there are no rows under the file tree, no orbs on the rail and
no header on the page. A live bubble's context menu is **Restart** (`claude respawn`, a fresh
process for the same conversation, which re-reads settings and `AGENTS.md`), **Duplicate** and
**Stop** (`claude stop`; an idle session stops at once, one mid-turn or waiting on you asks first).

**One page, chats only.** The agent surface is one page with no tab per terminal (`AgentOverview`):
one session's chat, and beside it every session the vault has had as a **stack of bubbles**
(`BubbleStack`), the most recent on top. A bubble is the session's face (`AgentFace`, a round head
in a colour its job id picks, with the state dot of its row; the eyes blink slowly at rest, quickly
and glancing while it works, and are held wide while it waits on you). Resting, the stack is its top
three overlapped, with a `+N` for the rest (ringed when a hidden one needs you). With the pointer on
it, or the keyboard in it, it fans into a column of every session, a name and a line (its state, or
how it ended, and when it began) beside each bubble, then "New session"; Escape or leaving folds it.
Pressing a bubble opens that chat, one at a time; the page opens on the most recent. The stack keeps
its margin from the window's edges and never clips a bubble, its ring or its dot; each row of the fan
has its own room: an **archive button** at the left, the name and line, and the face at the right,
where the resting bubble is, so the pointer that opened the fan is already on a face (the bubble and the button are siblings, never a button in a button), and "History" is pinned
at its foot while the rows scroll. A bubble,
the palette and a new session all land there (`land` sets `overviewSelectionAtom` and opens
the surface), and ⌘J and the agent item open the page as it was left. Order is `startedAt`, newest
first (one without a start time is oldest), and the open chat's bubble is ringed.

**History.** The stack's finished sessions are Claude Code's own: `claude agents --json --all`
(`--all` adds the completed ones; an older Claude Code that rejects it is asked again without, and
has no history). Main keeps the rows whose process has gone as `PastSession` and tells the renderer as
the `history` event (and `agent.history`) when it differs. A finished session's chat is read from its
transcript like any other, with a **Pick up** button where the composer would be: it opens a terminal
on it (`claude attach`), which Claude Code resumes it for, and the same chat carries on as a live one.
Nothing in the page is a terminal. The one place one still shows is the chat's corner button and the
needs-you card, for the dialogs the chat cannot draw.

**Archive.** A bubble's context menu has **Archive** (any chat) beside Restart, Duplicate and Stop
(a running one). It takes the chat out of the stack and into the history, and archiving a running
session **stops it first** (asking first when that cuts a turn short), so nothing runs out of sight.
The archive is Holi's own record, the job ids in `.holi/state/archive.local.json` (a `.local.` file:
Claude Code has no archived session), told to the renderer as the `archive` event
(`agent.archived`, `agent.archive`). The fan ends in a small **History · N** link, which opens the
history on the agents page: the archived chats, searchable by name, each of which can be read (a
chat like any other, with Pick up, which un-archives it), **brought back** into the stack, or
**deleted for good** (`agent.remove`, `claude rm`: the conversation goes, what it wrote in the vault
stays), one by one or all shown at once, after asking. A running session cannot be deleted. With
every chat archived the stack remains as the "New session" bubble.

**The chat.** A session is shown as a chat, not as its terminal (`chat/ChatView`). What
was said and done is read from Claude Code's transcript,
`<configDir>/projects/<cwd>/<sessionId>.jsonl`, by `agent.transcript` (`main/claude/transcript.ts`):
from a byte offset, whole lines only, at most the last 768 KB when first opened, about once a
second while a turn runs and every 2.5 s otherwise. A person's message is a bubble, Claude's text
is rendered markdown (`marked`, sanitised with DOMPurify, links opened in the browser), and each
tool call is one row with its result folded in, opening to its input and output. Subagent
conversations, injected reminders and slash commands are left out. A `/clear` is a new
conversation id, and the chat starts over. **Writing goes through the session's terminal**, which
Holi opens when it is first needed and does not show: `agent.say` pastes the message and then
presses Enter (`terminals.paste(id, text, true)`), and an ask lands in the composer as a draft
(`chatDraftsAtom`) rather than in the terminal's box. While a turn runs the composer's button
stops it (Escape). **While the session waits on you** the composer is off and a card says what for
(`chat/QuickAsk`, shared with the smaller chat): a permission prompt is answered there, Allow
pressing Enter on the dialog's highlighted Yes and Deny pressing Escape; a question (the
`AskUserQuestion` call, read whole from the transcript, `lib/ask.ts`) shows its options, single or
multiple choice, one question at a time, with "Write another answer" for the person's own words.
The answers go in as the keys that answer the dialog: arrows down from the first option and Enter,
Space to toggle each choice of a multiple-choice, the last row ("Other") for typed words, and one
more Enter to confirm when there were several questions. A question not yet in the transcript is
waited for, and where the transcript does not have it (Claude Code can hold a question in the
job's `state.json`, `block.questions`, alone) main reads it from there (`agent.question`,
`claude/blocked.ts`). A question that stays unreadable for a few seconds offers the terminal, and
every question and waiting card has Cancel, which sends Escape. Only a dialog the chat cannot read at all (a plan, another dialog) offers the
terminal, and the chat's corner button shows it in the chat's place. The composer,
the tool rows and the card follow Fisher UI's agent components (jakobfisker.dk/en/ui), built on
Holi's primitives.

**Attachments are chips in the text.** The composer takes any file: paste (a screenshot is a file
named `image.png`; so is a file copied in Finder), drop, or the paperclip. Attaching inserts a
marker at the cursor, `[Image 1]` for a picture (numbered past every one attached or typed) and
`[name]` for any other file, so the words around it are its comment, several can be pasted, and
**deleting the marker removes the file**. In the box the marker is drawn as an inline icon chip (a picture or a file icon and its name; `chat/RichInput.tsx`, a `contenteditable` that speaks the same plain string with the markers in it), which the caret steps over and one Backspace deletes. Nothing is drawn above the text. On send, only the files
whose marker is still in the text are written into the vault by `agent.upload`
(`main/host/uploads.ts`, up to 50 MB each, under `.holi/state/chat.local.uploads/`, a `.local.`
folder so it is never committed), and each marker is replaced by `@<path>` where it stood (quoted
when the path has a space), which is how Claude Code is given a file, so the agent reads each in
the place its comment is. Up to 8 a message. Rich text that carries a picture of itself (a
spreadsheet's cells) is a text paste, left alone, and a picture the browser gives no bytes for says
so. In the conversation a picture is drawn as itself (`AttachedImage`, read back from the vault through
`holi-vault://`, its name when it cannot be read), and any other file reads as a chip with its name, in
its place among the words. The smaller chat takes a pasted or dropped file the same way: it waits above
the box as a small picture (✕ takes it back), and a picture alone is a message.

**From any other page.** The bubbles float over every tab, so the agents are one press away from a
note. Where the agents page is **not** the page showing, pressing the **face** of a live session's bubble opens
a **smaller chat** (`QuickChat`) beside the stack, in the top right: a short summary of the agent's
last answer (a few plain lines, never its tool rows) and a box. While a turn runs it says only
"Working…". Writing and sending sends the message and **closes it**; ✕ and Escape close it sending
nothing; the **face** is the way to the full page. **A session that needs you takes no message
there; the same card as the full chat is drawn instead** (a permission prompt with Allow and Deny,
a question with its options, single or multiple choice, or the person's own words), so nothing
sends you to the terminal or the full page unless you press the face. A dialog it cannot read at
all offers "Open the full chat". A finished one has only its
full page (where it is picked up). On the agents page a bubble
picks the chat shown, as before. **The words of a row** (name and state, in the open fan) always open the full chat and go to the agents page, from any tab.

**Notifications.** In the same corner, **notifications** (`AgentNotices`) say when an agent has
an answer (**Answer ready**, with its first words, which goes by itself after 15 s unless the
pointer is on it) or needs you (**Approval required** / **Needs you**, which stays until answered
or dismissed). They are read off the session list's own edges (`state/notices.ts`): working to idle
is a turn that ended, anything to needs-you is a question; the transcript's tail supplies the
words and the call it asks to run (`lib/preview.ts`). What was running when the vault opened is not
news, and nothing is said of the chat you are reading in full or have the smaller chat open on.
Pressing a notification opens the full chat; ✕ dismisses it. **A permission prompt is answered on
its card**: Allow presses Enter and Deny Escape in the session's terminal, as the chat's own card
does, with no trip to the page. A question or dialog of any other kind says **Answer**, which
opens the chat, where the terminal can be shown for it.

**Idle is said as what it is.** A live session that is doing nothing reads `done` when Claude
Code's listing says its last turn finished (`state: done`), `failed` when it ended badly, and
`ready` before its first message (`SessionSummary.phase`), on its bubble. It is
never called running: its process being alive says nothing about a turn.

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
Inside a Holi background session the command also posts the JSON, detached, to the bridge's
`/statusline` with the vault's token from its `bridge.local.env` and the job id from `$CLAUDE_JOB_DIR`,
answered empty. Main keeps `context_window.used_percentage` per job id on the pushed session list
and drops it when the session stops. A `null` reading (before the first message, after `/clear`)
clears it.

**Asks are pasted, never submitted.** Text from a selection, task, mail thread or PDF comment goes
to a live session the user picks (needs-you sessions are not offered), or to a new one named from
its first line, as a draft in that session's chat, never sent for you. **Reconcile and a stuck
push are the exception**: their first turn is the command's prompt.

**Git coexistence.** The seeded `UserPromptSubmit` and `Stop` hooks run `turn-signal.mjs`, which
reads the vault's `bridge.local.env` ([agent-config](agent-config.md)) for the port and the vault's token, and posts
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
`claude stop` the vault's live sessions, asking first if one is working or needs you (the agent's
`leaveGuard` and quit guard), then close
every terminal; closing the vault deletes its `bridge.local.env`. The conversations stay in the agent list, except a session
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
- A headless chat panel or a server-side agent: re-implements the TUI. The chat is not
  one: Claude Code still runs the session and its terminal still takes the input; the chat only
  reads the transcript and types.
- A Holi list of past sessions: Claude Code's listing (`--all`) is that list; the stack only shows it.
- A gate before the agent's writes: Claude Code already asks.
- Recording touched paths from `PostToolUse`: misses edits made through `Bash`.
- A worktree per session: edits invisible until merged, `.local.` files absent. Hence the seeded
  `worktree.bgIsolation: "none"`.
- A `Notification` or `PermissionRequest` hook for needs-you: late or partial.
- Reading context use from transcripts or the PTY: Claude Code's files and screen are not an
  interface; its status-line JSON is. The chat does read the transcript, for the messages nothing
  else carries, and takes a format change as an empty chat with the terminal one button away.
- A three-pane merge editor: resolves positionally, wrong for prose.

## Code

- `apps/desktop/src/plugins/agent/main/index.ts`: the plugin's main side; `provider.ts`: the line between the host and
  the agent it runs
- `apps/desktop/src/plugins/agent/main/claude/`: Claude Code as the provider: `cli.ts` (every `claude` command, one
  environment, the binary), `listing.ts` (the listing, state rules, the watch), `routes.ts` (the
  turn and status-line routes)
- `apps/desktop/src/plugins/agent/main/host/terminals.ts`, `pty.ts`, `terminal-mirror.ts`: terminals, the PTY and
  kill path
- `apps/desktop/src/plugins/agent/main/host/sessions.ts`: the vault controller
- `apps/desktop/src/plugins/agent/main/host/capabilities.ts`: the `agent.*` capabilities
- `apps/desktop/src/main/bridge/env-file.ts`, `apps/desktop/src/plugins/agent/main/claude/vault/shipped/.claude/hooks/turn-signal.mjs`,
  `apps/desktop/src/plugins/agent/main/claude/seed.ts` (`STATUS_LINE`): how sessions find Holi
- `apps/desktop/src/plugins/agent/main/host/turn-coordinator.ts`, `turn-log.ts`: working set and turn records
- `apps/desktop/src/plugins/agent-ui/renderer/AgentOverview.tsx`, `BubbleStack.tsx`, `AgentFace.tsx`, `overview.css`: the agents page and its stack of bubbles
- `apps/desktop/src/plugins/agent-ui/renderer/chat/`: the chat (`ChatView`, `Composer`, `ChatMarkdown`);
  `apps/desktop/src/plugins/agent/renderer/chat/use-transcript.ts`: reading it;
  `apps/desktop/src/plugins/agent/main/claude/transcript.ts`: the transcript reader
- `apps/desktop/src/plugins/agent-ui/renderer/`: `BubbleStack.tsx`/`AgentBubbles.tsx`, `QuickChat.tsx`, terminal (`terminal.css`), turn chip and review; `index.tsx`: the
  interface's renderer side
- `apps/desktop/src/plugins/agent/renderer/`: `index.tsx`: the agent's renderer side; `service.ts`: the agent service
- `apps/desktop/src/plugins/agent/renderer/state/sessions.ts`, `send.ts`, `turns.ts`: the lists, what you do, and turn review
