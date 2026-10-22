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

**A start that fails says so.** `claude --bg` refuses a directory its config directory has not
trusted ("Workspace not trusted"), which is the state of every vault on a Holi profile that has not
run the agent before. Its own advice (run `claude` there) would trust the directory for `~/.claude`
and change nothing, so `explainStartFailure` swaps it for the command that does: `claude` run in the
vault with `CLAUDE_CONFIG_DIR` set to the vault's agent config directory, once, to accept the prompt
and sign in. The agents page prints whatever message a failed start returns (`startErrorAtom`); the
bubble stack's "New session" brings that page forward to show it.

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

**Terminals are windows, never shown.** A Holi terminal is a PTY running `claude attach <id>`, with
a headless-xterm `TerminalMirror` as its record. The chat types into it and presses keys in it
(below), and shows it only for a dialog the chat cannot draw. Closing one detaches: the session
keeps running. What a terminal shows can change under it, so a terminal is never taken to be a
session, and when its client exits (a detach, `/exit`, its session stopped) it goes. **A terminal
is not someone looking.** The renderer tells main whose chat is showing (`agent.watching`: the
agents page on a live session's chat, or its smaller chat open), and that alone makes a session
`watched`, which keeps a needs-you banner away while Holi has the focus and leaves a finished
scheduled run open. The chat that is left lets go of the terminal it typed into, and so does a
message or a key sent to a session nobody is looking at: main closes it once what it holds has
gone in and a few seconds have passed (`terminals.release`), and the next message opens another.
The agent is the plugin `agent` (`src/plugins/agent/`, on by default), and its renderer side
(`renderer/index.tsx`) holds the session lists and notices, the leave question and the schedules
section in settings. The agent service every "Ask" goes through (`useAgentService`) is
`agent-ui`'s, because an ask lands as a draft in a chat that only it can show: with either plugin
off there is no service, so no "Ask" is offered, and what would land on the agents page (opening a
session from the inbox, the quick panel's "open in Holi") is refused with the reason rather than
starting anything (`agentPageAtom`, set while `agent-ui` runs). Its main side starts with the vault and
attaches to it (`activate`), and its disposer stops the vault's sessions and terminals. What is
drawn of the sessions is a second plugin, `agent-ui` (`src/plugins/agent-ui/`, on by default,
`requires: ['agent']`, so it never runs without the agent): its renderer registers the page (the
surface `agent`, kept mounted, one page, no `tabs`), the nav item (which runs `agent.show`), the
commands (`agent.show` on ⌘J, `agent.new`), the floating stack (`floating`), the turn review (one of its `overlays`), the agent service, and the palette's session
rows. It has no main side of its own beyond its name. It reads the agent's state by import, the one
place a plugin imports another; turned off, the agent still runs and its sessions are reachable
from `claude` itself. The
renderer reaches it through the `agent.*` capabilities (sessions, terminals, open, start, send,
say, press, watching, message, stop, respawn, duplicate, attach, detach, and the turn review's turns, turnFiles, turnDiff and
revert). Main tells it the session and terminal lists and each terminal's bytes as the events
`sessions`, `terminals`, `pty-data` and `pty-exit`; keystrokes and resizes go back as the events
`pty-write` and `pty-resize`, which keep their order. A terminal's bytes go straight to its xterm
(`renderer/lib/session-terminals.ts`), never through an atom. Its main side is the plugin `agent`
(`src/plugins/agent/main/`), so in a vault with the agent off its capabilities are refused, its
events are not sent and nothing under `.claude/` is seeded.

**Where you meet it.** ⌘J and the nav menu's agent item open the agents page, and the stack of
bubbles floats over the top right of every tab (the plugin's `floating`, `AgentBubbles`), so any
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
where the resting bubble is, so the pointer that opened the fan is already on a face (the bubble and the button are siblings, never a button in a button). The last row is "New session", with the **History** button (a pill with
the clock icon and the count) at its left where the other rows have their archive button, so the fan
takes no line of its own for it. The row is two pills, History and the new session's, each lit
alone under the pointer. A bubble,
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
(`agent.archived`, `agent.archive`). The last row of the fan carries a small **History · N** link, which opens the
history on the agents page: the archived chats, searchable by name, each of which can be read (a
chat like any other, with Pick up, which un-archives it), **brought back** into the stack, or
**deleted for good** (`agent.remove`, `claude rm`: the conversation goes, what it wrote in the vault
stays), one by one or all shown at once, after asking. A running session cannot be deleted. With
every chat archived the stack remains as the "New session" bubble.

**The chat.** A session is shown as a chat, not as its terminal (`chat/ChatView`). What
was said and done is read from Claude Code's transcript,
`<configDir>/projects/<cwd>/<sessionId>.jsonl`, by `agent.transcript` (`main/claude/transcript/`):
from a byte offset, whole lines only, at most the last 768 KB when first opened (`agent.transcriptEarlier`
reads the part before, on request), about once a second while a turn runs and every 2.5 s otherwise.
A person's message is a bubble (one typed while the agent was busy is marked queued), Claude's text
is rendered markdown (`marked`, sanitised with DOMPurify, links opened in the browser, a copy button
on each code block), its visible reasoning is a collapsed "Thought", and each tool call is one row
with its result folded in, drawn by what the tool is (below). Slash commands, `!` commands, the
person's interrupts, compactions (a divider, the summary behind it), turn durations, API errors,
refusals and background-task reports are rows of their own; injected reminders and bookkeeping are
not shown. A sub-agent's conversation (its own file, `<sessionId>/subagents/agent-<id>.jsonl`) is read
when its card is opened (`agent.subagent`), never merged into the timeline. A `/clear` is a new
conversation id, and the chat starts over. The list shows the last 150 rows, "Show earlier"
reveals more and reads further back, and it follows the end only while the person is at it.

**The chat never drops what it cannot place.** The transcript is not a documented interface, so one
module (`transcript/classify.ts`, with its tables in `known.ts`) knows its shapes and turns each
line into Holi's own entries (`transcript/entries.ts`); everything after it depends on those. Every
line is drawn, hidden for a named reason, or kept as an `unknown` entry that shows its signature and
raw JSON; a line of a type the reader has never seen is hidden but counted, and the chat says how many
parts it did not recognise, with a button that copies their signatures (never their content). A tool
is drawn through a registry by name (`rows/tool-registry.ts`: Bash, Read, Edit/Write as a diff, search, web,
sub-agents, task lists, answered questions, plans, MCP, and a generic card for every other name,
which also catches a renderer that returns nothing or throws); every row sits in an error boundary,
so a row that fails to draw is one line with its raw JSON, never a blank chat. Results are joined to
calls by id, in any order, since Claude Code writes one line per block and interleaves parallel calls;
file order is the order, never timestamps. **Keeping up** is a check, not a promise:
`scripts/chat-drift.ts` (`pnpm --filter @holi/desktop run chat:drift`) replays a machine's real
transcripts through the reader and lists every shape it has no rule for, with the Claude Code versions
seen against `VERIFIED_CLAUDE_VERSIONS`; the scrubbed fixtures in `agent/test/fixtures/transcripts/`
(structure kept, content gone; `chat:fixtures` regenerates them) are replayed by a test that fails on
any unknown shape and on any private-looking string.

**Writing goes through the session's terminal**, which
Holi opens when it is first needed and does not show: `agent.say` pastes the message and then
presses Enter (`terminals.paste(id, text, true)`), and an ask lands in the composer as a draft
(`chatDraftsAtom`) rather than in the terminal's box. While a turn runs the composer's button
stops it (Escape). **While the session waits on you** the composer is off and a card says what for
(`chat/QuickAsk`, shared with the smaller chat): a permission prompt is answered there, Allow
pressing Enter on the dialog's highlighted Yes and Deny pressing Escape. **Allow and Deny are
offered only when Holi can tell which call the prompt is about**: the turn has exactly one tool call
without a result (`openCalls`, `agent/shared/open-calls.ts`). With none, or several running at once
(Claude Code runs calls in parallel and only one of them is asking), the card names no call and
offers the terminal alone, because Enter would approve whichever prompt is on screen. The keys carry
that call's id (`expect`), and main reads the transcript again before pressing them: the session
still needs you and the call is still the only one open, or the press is refused with the reason.
Nothing else says which prompt a dialog is for: the question desk holds only a quick agent's
`AskUserQuestion`, never a permission prompt. A question (the
`AskUserQuestion` call, read whole from the transcript, `lib/ask.ts`) shows its options, single or
multiple choice, one question at a time, with "Write another answer" for the person's own words.
The answers go in as the keys that answer the dialog: arrows down from the first option and Enter,
Space to toggle each choice of a multiple-choice, the last row ("Other") for typed words, and one
more Enter to confirm when there were several questions. They go to main as one press
(`agent.press`, a list of key runs), which opens a terminal on the session when there is none,
holds the keys until its TUI reads input, as a paste is held, and writes the runs a step apart, so
the dialog redraws between them; a session that has ended or a terminal that has closed is a
refusal the card says. A question Holi **holds** (a [quick agent](quick-agent.md)'s, whose hook
keeps Claude Code from drawing its own box) has no dialog to press keys into: the chat and the
smaller chat show the quick panel's own card in the question's place, and over the terminal when
that is showing, and the answer goes back through the question desk (`agent.answer`). A question not yet in the transcript is
waited for, and where the transcript does not have it (Claude Code can hold a question in the
job's `state.json`, `block.questions`, alone) main reads it from there (`agent.question`,
`claude/blocked.ts`). A question that stays unreadable for a few seconds offers the terminal, and
every question and waiting card has Cancel, which sends Escape. Only a dialog the chat cannot read at all (approving a plan, which the chat draws but does not
answer, or another dialog) offers the terminal, and the chat's corner button shows it in the chat's place. The composer,
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
does, with no trip to the page, and under the same rule: only when one call is open, which the
press names. Otherwise the card says **Answer**. A question or dialog of any other kind says **Answer**, which
opens the chat, where the terminal can be shown for it.

**Idle is said as what it is.** A live session that is doing nothing reads `done` when Claude
Code's listing says its last turn finished (`state: done`), `failed` when it ended badly, and
`ready` before its first message (`SessionSummary.phase`), on its bubble. Claude Code reads
`state: blocked` both for a session never given a prompt and for one whose answer handed back to
you, so Holi keeps its own record of the sessions it has seen have a turn (started with a prompt,
said something to, or seen busy or waiting; `session-state.ts`), and for those `blocked` is `done`.
The record is in memory: after a restart such a session reads `ready` until its next turn. It is
never called running: its process being alive says nothing about a turn.

**Stop, restart, duplicate.** A bubble's context menu has **Stop**, which runs `claude stop <id>`:
an idle session stops at once, one mid-turn or waiting on you asks first. It adds **Restart** (`claude
respawn`, a fresh process for the same conversation, which re-reads settings and `AGENTS.md`) and
**Duplicate** (a background copy of the conversation, opened in a window of its own). Rename is
Claude Code's: `/rename`, or Ctrl+R in the list. **Start another session** on an agent tab starts
one with no prompt, which waits for yours.

**State is read, not inferred.** `session-state.ts` does the reading, and nothing outside it knows how the listing, the hooks and the status line combine. Main reads `claude agents --json` for the vault's config directory
and keeps the background rows under the vault root. `needs-you` is `status: waiting`, or a question
Holi holds for a [quick agent](quick-agent.md) (its hook keeps the listing at `busy`), `working` is
`busy` or `shell`, then the turn bracket; a session started with no prompt reads `state: blocked`
and is idle. The read is triggered by a watch of `<configDir>/sessions/` and `jobs/` (edge triggers,
never parsed), by each turn hook, and by a vault opening. The one timer is a second read about a second
after an `idle` one, because a quiet session makes no watcher edge: a turn ends only when two
consecutive reads say idle. A failed read (no output, a timeout, output that is not a listing) is not an empty listing: the last one stands, so a turn keeps its sync hold and the stack keeps its bubbles until a read lands. Only a listing that was read and no longer has a session lets it go.
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
its first line, as a draft in that session's chat, never sent for you. **Reconcile, a stuck
push, a scheduled run and a quick agent are the exceptions**: their first turn is the command's
prompt, or the task typed into the quick panel. A first turn goes after `--`, so one that starts with
a dash is a prompt and not an option. A scheduled run opens no terminal at all
([scheduled-agents](scheduled-agents.md)).

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
from another session, not from the person: it approves nothing and changes no configuration. That
is why the chat's own messages do not go this way: what the person writes in the chat is typed
into the session's terminal, as the person's. The
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

- Never infer session state from PTY output. A terminal's title labels and finds a tab, never
  keys a session.
- Key a session by its job id, never by the conversation's `sessionId`, which changes on `/clear`.
- Run every `claude` for a vault through `claude-cli.ts`, so the supervisor's environment is
  always Holi's.
- Probe a pid before signalling it: signal the group only if it still leads its group. A reaped pid
  may already be a stranger's. Holi only ever signals its own terminal clients.
- Only reconcile, a stuck push, a skills update's conflicts, a scheduled run and a quick agent's task
  submit a turn, each as the first turn of a session of its own. Holi cannot see the composer, so
  nothing is ever submitted through a terminal: a message into a running session goes through its
  inbox socket.
- Record a turn after the vault resumes, fire-and-forget: a lost record beats a stuck pause.
- A turn revert does not flush open buffers first; a dirty buffer 3-way merges. It is written over
  the text the review showed: a file changed since is merged with what the reviewer kept, and one
  whose change overlaps it is refused with a message in the panel, nothing written.
- Turn-hook and status-line responses are empty: a turn hook's body would be injected into
  Claude's context, and the status line prints its own footer. A quick agent's question hook is the
  one route with a body: a `PreToolUse` hook's JSON is its decision.

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
- A `Notification` or `PermissionRequest` hook for needs-you: late or partial. The listing's
  `waiting` is what the inbox's needs-you notice reads.
- Reading context use from transcripts or the PTY: Claude Code's files and screen are not an
  interface; its status-line JSON is. The chat does read the transcript, for the messages nothing
  else carries, and takes a format change as one unrecognised row (see the drift check) with the terminal one button away.
- A three-pane merge editor: resolves positionally, wrong for prose.
- Typing a message into a session's terminal: it lands in the person's input box.
- `claude --bg --resume <id> "prompt"` to add a turn: on a session whose process is alive it forks
  a copy, and only a stopped one continues under its job id.
- Claude Code's channels (an MCP server) for messages: a research preview needing a claude.ai or
  Console login, and not documented for background sessions.

## Code

- `apps/desktop/src/plugins/agent/main/index.ts`: the plugin's main side; `provider.ts`: the line between the host and
  the agent it runs
- `apps/desktop/src/plugins/agent/main/claude/`: Claude Code as the provider: `cli.ts` (every `claude` command, one
  environment, the binary), `listing.ts` (the listing, state rules, the watch), `routes.ts` (the
  turn, session and status-line routes), `messaging.ts` (the inbox socket writer)
- `apps/desktop/src/plugins/agent/main/host/terminals.ts`, `pty.ts`, `terminal-mirror.ts`: terminals, the PTY and
  kill path
- `apps/desktop/src/plugins/agent/main/host/sessions.ts`: the vault controller
- `apps/desktop/src/plugins/agent/main/host/session-state.ts`: what the sessions are doing (the listing, the hooks and the status line combined, behind one interface)
- `apps/desktop/src/plugins/agent/main/host/capabilities.ts`: the `agent.*` capabilities
- `apps/desktop/src/main/bridge/env-file.ts`, `apps/desktop/src/plugins/agent/main/claude/vault/shipped/.claude/hooks/turn-signal.mjs`,
  `apps/desktop/src/plugins/agent/main/claude/seed.ts` (`STATUS_LINE`): how sessions find Holi
- `apps/desktop/src/plugins/agent/main/host/turn-coordinator.ts`, `turn-log.ts`: working set and turn records
- `apps/desktop/src/plugins/agent-ui/renderer/AgentOverview.tsx`, `BubbleStack.tsx`, `AgentFace.tsx`, `overview.css`: the agents page and its stack of bubbles
- `apps/desktop/src/plugins/agent-ui/renderer/chat/`: the chat (`ChatView`, `Composer`, `ChatMarkdown`);
  `apps/desktop/src/plugins/agent/renderer/chat/use-transcript.ts`: reading it;
  `apps/desktop/src/plugins/agent/main/claude/transcript/`: the transcript reader (`classify.ts`, `known.ts`,
  `sanitise.ts`, `entries.ts`); `agent/renderer/chat/fold.ts`: results joined to calls;
  `agent-ui/renderer/chat/rows/`: the rows and `tools/`, the tool registry; `apps/desktop/scripts/chat-drift.ts`,
  `scrub-transcript.ts`: the drift check and the fixture scrubber
- `apps/desktop/src/plugins/agent-ui/renderer/`: `BubbleStack.tsx`/`AgentBubbles.tsx`, `QuickChat.tsx`, terminal (`terminal.css`), turn chip and review; `index.tsx`: the
  interface's renderer side
- `apps/desktop/src/plugins/agent/renderer/`: `index.tsx`: the agent's renderer side; `service.ts`: the agent service
- `apps/desktop/src/plugins/agent/renderer/state/sessions.ts`, `send.ts`, `turns.ts`: the lists, what you do, and turn review
