# Chat

The optional `chat` plugin (`src/plugins/chat/`, off by default, requires `agent`) shows Claude
Code in the vault as a conversation in the Agents mode instead of a terminal: each step as a line
(the one in flight beside the house loader, `motion-orbit`, its words still), its permission
prompts as cards, and under a finished turn what it changed. It is the same Claude
Code, in the same clone, with the same settings, skills, hooks and memory as a background session
([agent-sessions](agent-sessions.md)).

## Why it exists, and why it is not the default

Claude Code in a terminal is the vault's assistant as Claude Code draws it, and Holi adds no layer
to it ([architecture](../architecture.md), §2). Some people would rather not read a TUI. A
conversation drawn by Holi needs each step, each question and each turn's end as data, which a
terminal's screen is not, so a chat runs Claude Code on its documented structured channel instead.
That is an adapter, so it is a plugin a vault turns on, never core: turned off, the Agents mode is
Holis and background sessions in terminals, and nothing of chat remains but its records on this
machine.

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

**In the Agents mode** the chat plugin fills the slot the agent's view offers
([sidebar](sidebar.md)): a **Chats** section in its sidebar (New chat, the chats with their state in
words, Archived folded) and its main view (the composer, or one conversation). What its chats wait
on is added to the count on the mode toggle. **Open a copy in a terminal** opens
`claude --resume <id> --fork-session` in an agent tab (`agent.open` with `fork`), the raw view that
never fights the chat's own process for the conversation; **Sign in** runs Claude Code's `/login`
for the vault (`agent.open` with `login`), since a chat has no TUI to type it in. Quitting while a
chat works or waits on the person asks first (the plugin's own quit guard).

## Rules

- Answer a permission only with the person's choice, through Claude Code's `control_response`.
- Never launch a mode that skips Claude Code's prompts.
- Reach the agent only through its capabilities; the agent knows nothing of chat.
- Keep transcripts under `userData`, never in the clone.

## Rejected

- **Chat in core, or as the agent's default**: re-implements the TUI ([agent-sessions](agent-sessions.md),
  Rejected).
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
- `apps/desktop/src/plugins/chat/shared/chat.ts`: transcript items, tool phrasing, the reducer
- `apps/desktop/src/plugins/chat/renderer/`: `ChatSidebar.tsx`, `ChatMain.tsx`, `Transcript.tsx`,
  `Composer.tsx`, `ReviewCard.tsx`; `state/chats.ts`, `state/review.ts`
- `apps/desktop/src/plugins/chat/NOTICE.md`: MonoCode's licence for the parts after it
