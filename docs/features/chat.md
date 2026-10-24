# Chat

Chat (`src/plugins/chat/`, built in, requires the agent) shows Claude Code in the
vault as a conversation in the Agents mode instead of a terminal: each step as a line (the one in
flight beside a spinner, its words still), its permission prompts as cards, and under a finished
turn what it changed. It is the same Claude
Code, in the same clone, with the same settings, skills, hooks and memory as a background session
([agent-sessions](agent-sessions.md)).

## Why it exists, and why it is built in

Claude Code in a terminal is the vault's assistant as Claude Code draws it, and Holi adds no layer
to it ([architecture](../architecture.md), §2). A conversation drawn by Holi needs each step, each
question and each turn's end as data, which a terminal's screen is not, so a chat runs Claude Code
on its documented structured channel instead.

**It is the Agents mode's session UI**, and part of Holi: the person prefers the conversation to
the TUI, so the mode opens on the new-session page whenever nothing is selected, and a session is a
conversation. No vault setting, `plugins.yaml` entry or settings switch turns it off
(`PluginInfo.builtIn`, [architecture](../architecture.md), Plugins): an older Holi wrote
`chat: false` into some vaults' committed `plugins.yaml`, and that left the mode on the Inbox with
no composer, so such a pin is ignored and dropped at the file's next write. No terminal is drawn
in the mode for now (a background session a Holi or an automation started shows what it is and
where it stands, not its screen); a terminal view may come back later. The agent's PTY host stays,
since Holis and automations still start their sessions through `agent.launch`. Chat is still an
adapter, so it is written to the plugin contract rather than into core: it reaches core only
through the plugin API, and the agent only through its capabilities.

## How it works

**One process per live chat**: `claude -p --input-format stream-json --output-format stream-json
--include-partial-messages --permission-prompt-tool stdio --permission-mode <mode>`, started in the
vault clone with the environment the agent gives every session (`agent.target`: the vault's config
directory, Holi's commands first on `PATH`). It stays up between turns and is let go after 15
minutes idle; the next message resumes the conversation (`--resume`), which is Claude Code's. Holi
names a new chat with a UUID it gives Claude Code as `--session-id`, so it is known before the first
line comes back. A change of model or mode starts a new process on the same conversation.

**Permissions are Claude Code's.** `--permission-prompt-tool stdio` sends the prompt Claude Code
would draw in its TUI to Holi as a `control_request` of subtype `can_use_tool`, and only after
Claude Code's own deny and allow rules, its hooks (the mail send gate among them) and its mode have
decided to **ask**. Holi shows it as a card (Allow once, Always allow, Deny) and sends the person's
answer back as Claude Code's `control_response`. **Always allow** returns Claude Code's own
`permission_suggestions` as `updatedPermissions`, so Claude Code writes the rule where it said it
would. Nothing is allowed that Claude Code would have asked about: there is no rule of Holi's in
between, and the mode picker offers only `default` (Ask first), `acceptEdits` and `plan`, each of
which still asks. An `AskUserQuestion` arrives the same way and is answered in a card of options.

**Turns share the vault's bracket.** A turn begins when Holi writes the message and ends at Claude
Code's `result`. Both edges go to the agent's turn coordinator through `agent.turn`, by the chat's
id: sync pauses, one settle commit, and the turn is recorded as a commit range like a session's. A
process that dies mid-turn is forgotten with nothing recorded, and its transcript says it stopped.
The row and the review card under a finished turn show what it changed (`+135 −21`); **Keep** takes
it out of Ready for review, **Revert** puts the vault back as it was before the turn (a file the
turn created is deleted, every other file gets its old text back), one new commit per file.

**What is kept is this machine's**: an index and each transcript, as Holi drew it, under
`userData/agent-chats/<vault>/`. Like Claude Code's own transcripts, a conversation is one person's,
so it is never in the clone.

**In the Agents mode** chat fills the slot the agent's view offers
([sidebar](sidebar.md)): its chats as rows of the sidebar's one session list (the slot's
`sessions`, [agent-sessions](agent-sessions.md): working, needs you, done until opened, and its
menu's Pin, Rename, Archive and Delete), its main view (one conversation) and the mode's **home** (`AgentsSlot.home`), the
new-session page the mode opens on and the list's **+** (its `create`) goes to. Selecting a chat sets `agentsSelectionAtom` to `{owner: 'chat', id}` (`new` for the
page); nothing selected is the home. What its chats wait on is added to the count on the mode
toggle. **Sign in** runs Claude Code's `/login` for the vault (`agent.open` with `login`), since a
chat has no TUI to type it in. Quitting while a chat works or waits on the person asks first (the
plugin's own quit guard). Rename and Pin are Holi's title and pin in the index (`chats.update`). **Delete** (`chats.delete`)
stops the chat's process and forgets it on this machine, its index entry and Holi's transcript;
Claude Code's own transcript, under the vault's config directory, is Claude Code's and stays, so
the conversation can still be resumed from a terminal by its id. The capability that opens a copy of a conversation in a terminal
(`chats.terminal`) stays, but nothing in the mode offers it while no terminal is drawn there.

**The new-session page** is MonoCode's: "What should we work on in <vault>?" over a large composer,
on the Holis' arcade board faded in as on the New tab, its take-control pill under the column.
Nothing starts until the first message is sent.

**The composer** says where Claude Code works (the vault, and the clone's branch from
`chats.where`), takes the text, and under it the model and its effort (`--model`, `--effort`; an
alias such as `opus` reads as the model the last turn ran on, "Opus 5.5"), the permission mode,
and send, which stops a running turn. **`+`** attaches: a vault document as an `@path` reference,
or images and files from disk; an image can be pasted or dropped on the composer too. Images go to
Claude Code as image blocks, PDFs as document blocks and text files as their text in a named
`<file>` block, all in the stream-json user message (at most 10 files of 10 MB); the message's
bubble names them. Other binaries are refused with a reason. **`/`**
lists what Claude Code runs as a command in the vault (`chats.commands`): the `slash_commands` the
vault's last session reported in its `init`, less the TUI-only ones, merged with what the vault's
and its config directory's `.claude/commands/**.md` and `.claude/skills/*/SKILL.md` say about
themselves, so a row has a description and a vault with no session yet still lists its own (with
a short list of built-ins that work in a chat standing in for Claude Code's). A list that cannot
be read (a main process older than the renderer, say) is no failure the person has to deal with:
the menu lists those built-ins and says quietly at its foot that the vault's commands did not
load, with Retry, only while the menu is open. The branch chip is left out the same way when
`chats.where` does not answer. **`@`** lists the
vault's documents from the vault snapshot, most recently changed first, and inserts `@path`
(quoted when the path has a space), which Claude Code reads as a file reference. After the
documents it lists the vault's apps (the registry's `app` surface's instances); picking one
makes it a chip instead of text.

**An app as context** is a chip above the text, with the app's icon and name and its own Remove,
kept per composer like the draft. It is not sent as its files: the message opens with one line
per app naming its bundle as an `@` reference ("This is about the vault app “Budget”, the
folder @Finance/Budget.app (its page is index.html, its manifest app.yaml)."), then a blank line
and the text, so Claude Code reads the app itself, in the clone, under its own permissions, as
it does a document (`renderer/context.tsx`). A card's **Ask about this app**
([vault apps](vault-apps.md)) goes through `AgentsSlot.start`, which this plugin provides, with
no text, the app as `context` and `beside`: nothing starts, and the new-session page opens in
split view beside the Apps page with the chip in its composer, for the person to ask. With text,
`start` starts the chat at once with the context ahead of the text, as the command menu's Ask
the agent does without it. Arrow keys and
Enter or Tab pick, Escape closes; otherwise Enter sends and Shift+Enter is a new line.

**A turn** is drawn under a line naming the model that answered and how long it worked ("Opus 5.5
worked for 6s"), from the `result`'s `modelUsage`; under a finished turn, copy the reply, save it
as a vault document, and a usage icon whose tooltip reads the `result`'s tokens ("Cache hit 39% ·
Output 4 tok/s", "2 input · 22 output · 12.7k cached"), then when it ended.

## What the transcript draws

Everything is folded by the reducer (`shared/chat.ts`, `shared/tool-views.ts`) from Claude Code's
stream-json into typed transcript items, which the renderer only draws. Saved transcripts without
the newer fields still load: every new field is optional.

- **Tool steps** read as a sentence, present tense while running ("Reading", "Running the tests")
  and past once done ("Read `notes.md`"); every tool has its pair, MCP tools read "Used get forecast
  from `weather`". A step opens (collapsed by default; failed or refused ones open) into its
  result, mounted only when opened: a command with its output, errors and exit status; a read's
  lines, numbered; a search's matches as vault paths that open as tabs; a fetch's URL, status and
  answer, a web search's query and links; an MCP tool's server, tool, input and pretty-printed
  JSON result; anything else its raw input and output. Results come from Claude Code's
  `tool_use_result`, capped in the transcript (output 20k characters, 400 lines).
- **Edits** (Edit, MultiEdit, Write, NotebookEdit) show their diff under the step, not folded:
  old and new line numbers from Claude Code's `structuredPatch`, a line diff of the input while it
  waits for approval, a new file as all additions; the first 12 lines, then Show all. Plan mode's
  own copy of the plan (`~/.claude/plans/`) folds, since the plan card shows it. The turn's review
  card stays the summary.
- **Refusals**: a call Claude Code's rules, a hook or the person refused is marked "not allowed"
  with the reason (`tool_result_meta`'s `reject`). An answered prompt is said on its step
  ("allowed once", "always allowed") instead of as a line of its own.
- **The todo list** (TodoWrite) is one card per turn, redrawn in place: waiting, in progress
  (spinner) and done (checked, struck through), its count on the turn's header ("2/3 done").
- **Plan mode**: entering and leaving are status lines, from the `permissionMode` Claude Code
  reports in its `status` records, and the composer's mode picker follows the same report.
  ExitPlanMode is a **Plan** card of markdown; its approval is Claude Code's own `can_use_tool`
  prompt, answered from the card: **Approve**, **Approve and accept edits** only when Claude Code
  offers a `setMode` suggestion (2.1.310 offers none for ExitPlanMode, so the button does not show),
  and **Keep planning**, a deny with an optional note sent back as its message.
- **Subagents** (`Agent`/`Task`): a group under its description with its type and step count; its
  own steps (records with `parent_tool_use_id`) hang under it on a rail, open while it works and
  folded once done, with its answer. Its prose is not drawn as the agent's.
- **Thinking**: "Thinking…" while it streams, then "Thought for 4s", which opens for the text when
  Claude Code sends any. 2.1.310 sends thinking empty (signature only), so such a block is only a
  timed line, and only from 2 s.
- **Other events**: "Context compacted" with its token counts (`compact_boundary`), retries
  (`api_retry`), the usage limit (`rate_limit_event` when not plainly allowed), a hook's message
  (`informational`) or failure (`hook_response` with a non-zero exit), "Stopped" for a turn the
  person stopped (the `result` after Holi's interrupt is not a failure), and a slash command's
  output (`<local-command-stdout>`).
- **Session info**: the header's info button lists the `init`'s version, model, MCP servers and
  their status, and tools.
- **Images in replies** (`![alt](src)`) load from the vault through `holi-vault://` when the path
  is vault-relative, or from an `https:` URL; any other source is its alt text. Raw HTML stays
  text, never parsed.

## Background runs

A background session (a Holi's, an automation's) is not a chat's process, but Claude Code says its
conversation id in its listing (`sessionId`), and writes the conversation to
`<config dir>/projects/<cwd slug>/<id>.jsonl`, with each subagent's steps in
`<id>/subagents/agent-<agent id>.jsonl`. `chats.conversation` reads those files and folds them with
the same reader and reducer (`main/conversation.ts`), and the agent's session view draws the
result through its slot's `conversation`, read only: its cards say what they asked and offer
nothing, and it is read again every 2 s while the run works.

## Rules

- Answer a permission only with the person's choice, through Claude Code's `control_response`.
- Never launch a mode that skips Claude Code's prompts.
- Reach the agent only through its capabilities; the agent knows nothing of chat.
- Keep transcripts under `userData`, never in the clone.

## Rejected

- **Chat in core's own folders**: it would make core know Claude Code's structured channel. It is
  built in, written to the plugin contract.
- **Chat as an optional plugin**: a vault that turned it off had an Agents mode with no composer,
  which is not a Holi anyone meant to have.
- **A conversation that re-implements the TUI** ([agent-sessions](agent-sessions.md), Rejected).
- **Reading a background session's steps off its terminal**: a TUI is not an interface.
- **Other harnesses** (Pi and the like): a harness with no permission system runs its tools
  without asking, which a vault's assistant may not.
- **Holi's own permission prompts, or approving calls from a hook**: a second permission system
  beside Claude Code's.

## Code

- `apps/desktop/src/plugins/chat/main/index.ts`: the plugin's main side, its calls into the agent
- `apps/desktop/src/plugins/chat/main/chats.ts`: processes, records, transcripts, the turn edges
- `apps/desktop/src/plugins/chat/main/claude-stream.ts`: `stream-json` and `can_use_tool`
- `apps/desktop/src/plugins/chat/main/capabilities.ts`: `chats.*`
- `apps/desktop/src/plugins/chat/main/commands.ts`: what the `/` menu lists
- `apps/desktop/src/plugins/chat/main/conversation.ts`: a background run's transcript, folded
- `apps/desktop/src/plugins/chat/shared/tool-views.ts`: what each tool step opens into, and diffs
- `apps/desktop/src/plugins/chat/test/fixtures/`: captured stream-json runs (see `replay.ts`)
- `apps/desktop/src/plugins/chat/shared/chat.ts`: transcript items, tool phrasing, the reducer
- `apps/desktop/src/plugins/chat/renderer/`: `ChatMain.tsx` (the new-session
  page and a conversation), `Transcript.tsx`, `Composer.tsx`, `ComposerMenus.tsx` and
  `composer-tokens.ts` (`/` and `@`), `attachments.tsx`, `ReviewCard.tsx`, `SessionInfo.tsx`,
  `ConversationView.tsx`, `steps/` (the step rows, bodies, diff, todo and plan cards);
  `state/chats.ts`, `state/review.ts`
- `apps/desktop/src/plugins/chat/NOTICE.md`: MonoCode's licence for the parts after it
