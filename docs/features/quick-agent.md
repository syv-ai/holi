# Quick agent

A global hotkey, pressed in any other app, opens a small panel at the pointer. Type a task and an
agent starts on it in the open vault, as an ordinary session, and the panel goes out of sight. The
agent lives on as a dot in the dock, a slim pill at the right edge of the screen: yellow while it
works, orange when it needs you, green when it is done, red when it failed. Pointing at a dot
brings the panel out beside it showing that agent; a second key opens the dock with the keyboard.

## How it works

**Off until turned on.** Settings, Quick agent, which is this machine's (`userData/quick-agent.json`,
never a vault). Off, nothing is loaded and no key is taken from the other apps. On, it works only in
a vault with the agent plugin: opening one without it lets the keys go and closes the windows.

**The keys.** The prompt key (⌘J) opens a new prompt at the pointer, or the one left with a draft.
The dock key (⌃⌘J) opens the dock with the keyboard on the agent that most needs you: the oldest
asking, else the oldest finished, else the newest working; an asking agent the pointer brought out
goes first, since its foot names the key; with no agent it opens a prompt. Holi registers them only
while none of its windows has the keyboard (read again on every focus change and every few seconds),
and inside its windows each page answers them: in the main window ⌘J keeps its meaning (the agents)
and the dock key opens the dock; in the panel ⌘J is another agent. Both are chosen in Settings by
pressing them, are never one key (a hand edit that makes them one gives the dock key its default),
and a key another app holds is reported under its row.

**The panel.** One window for every prompt and agent, the agent plugin's page `quick`
(`AppContext.openPage`): a macOS panel (`type: 'panel'`), so it takes the keyboard without making
Holi the active app, floating above everything on every Space, on the HUD material. The agents are
records in main and the panel shows whichever one is picked; its page holds a prompt's draft by the
prompt's id, so the draft outlasts the panel showing an agent. Its page reports its size and main
fits the window: a prompt just past the pointer, wholly on that display; an agent to the left of the
dock, its header level with its dot. Main tells the page whether it has the keyboard, since a panel
never makes Holi active and Chromium does not always hear it give the keyboard back.

**The prompt.** Before the panel takes the keyboard Holi reads the frontmost app's selection, its
focused element's `AXSelectedText`, through `osascript` JavaScript. An app that does not expose it
sends nothing. The selection goes after the task, fenced and labelled with its app, capped at
20 000 characters; the first press without the Accessibility permission explains it once. The prompt
is one line: the field, a tag naming the selection's app (⌫ in the empty field drops it) and the
vault. ⏎ sends, ⇧⏎ is a new line, esc closes. The agent runs in the vault open when it is sent.
Sent, the panel goes out of sight and the agent's dot appears. A prompt with a draft waits for the
next press; one nobody wrote in goes when you click away.

**The agent.** `claude --bg`, started through the same `startBg` as every background session (see
[agent-sessions](agent-sessions.md)), with options on its own launch and nothing written into the
vault:

- `--settings` with two hooks, always. `PreToolUse` on AskUserQuestion posts the question to the
  bridge's `/ask`. `Stop` posts the turn's last message to `/quick-result`, which the panel shows
  as the answer.
- `--permission-mode auto` only when the person turned on **Approve safe actions**. Otherwise the
  session follows the vault's own mode, and a permission prompt is Claude Code's, in its terminal.
- `--append-system-prompt` only when the person turned on **Panel instructions**: work alone, ask
  only through AskUserQuestion with the recommendation first, and keep the last message to the
  result.

The session is named from the task's first line and is in the sidebar and the agent list like any
other; its card shows over its tab in the main window too.

**Questions.** Holi holds the `/ask` request (the question desk) until the question is answered, in
the panel or over the session's tab, and answers with the hook's output (`permissionDecision:
"allow"` with `updatedInput.answers`), which Claude Code takes without drawing its own box. Only a
question from an agent the panel has is taken; anything else is answered empty, the hook prints
nothing, and Claude Code asks the ordinary way. The hook `exec`s into `curl`, so when Claude Code
ends it (a stop, a timeout) the request ends and Holi lets go. The listing says `busy` while Holi
holds a question, so the session list reads the desk: such a session needs you.

**The card.** 1 to 4 answer at once and the next question comes, or the answers go after the last.
⏎ takes the highlighted option, which starts on Claude's recommendation; on a multi-select the
numbers toggle and ⏎ sends. o writes your own answer; ← or ⌫ goes back a question. In the panel
↑ ↓ are the dock's, so the highlight stays put; over the session's tab they move it.

**The dock.** A second window, the page `dock`, against the right edge of the display's work area,
in sight exactly while there is a quick agent. One dot per agent, oldest at the top, so the order
never changes under you. It never takes the keyboard. Pointing at a dot brings the panel out with
that agent, without the keyboard; it goes a quarter of a second after the pointer leaves both, and
a prompt that is out stays where it is. A click, or the dock key, brings the panel out with the
keyboard: ↑ ↓ step to the agent above or below, esc puts the panel away (and clears a finished
agent, stopping its session), and ⏎ opens a finished one in the main window. On a finished answer
c copies it and ⇧↑ ⇧↓ scroll it. On Claude Code's own prompt the terminal is inert until ⏎ steps
into it, and the dock key steps back out. Clicking into another app puts the panel away; the dots
stay. An agent wanting you changes its dot and nothing else: no panel comes to the pointer.

**The look.** The panel is macOS's HUD glass under a dark tint, always in the dark scheme with the
vault's dark colours. An agent's light is its `--agent-*` token (a vault's theme can set them, as a
session's orb uses them): it colours the orb, the state word, a glow pooling at the top of the glass,
which breathes while the agent works, and the text of the key that does the main thing. State shows
by background colour only: the option ⏎ would take is a grey fill, a picked option's key is filled
with the light, and a terminal stepped into is a darker fill. There are no borders, rings or corner
marks. The dock is a pill in the same dark; a working dot breathes, one that needs you swells once
and keeps a stronger glow, and the agent whose panel is out sits on a soft disc. The dock has no
tooltips: the panel is one.

## Rules

- Off until a person turns it on, and only in a vault with the agent.
- Auto mode and the panel's instructions are each person's choice, off until chosen.
- A quick window never takes the keyboard on its own, and only a prompt opens at the pointer.
- The prompt key and the dock key are never one key.
- A quick agent's options are per launch, never seeded or merged into a vault's settings.
- Holi answers only a question from an agent the panel has; every other way of not answering falls
  through to Claude Code's own box. Permission prompts stay Claude Code's own.

## Rejected

- A window per agent: ten agents were ten copies of the app loaded, for one panel ever in sight.
- Auto mode and the instructions for every quick agent: a default chosen for everyone, for an agent
  working on text Holi did not write, in a vault it can change and push.
- ⌘C, with the clipboard put back, for an app that does not expose its selection: a clipboard
  manager keeps what it copied.
- Holi's own ask tool over MCP, or the Agent SDK: not AskUserQuestion, and not the session in the
  sidebar.
- The hooks shipped into the vault or merged into `.claude/settings.json`: a shipped hook reaches an
  existing vault only through `holi skills update`, and a merged one would reach every session.
- Permission prompts as cards: a parallel prompt system (see [agent-sessions](agent-sessions.md)).
- A panel, or the card, coming to the pointer when an agent needs you: it lands wherever you were
  working, and keys typed there would answer it.

## Code

- `apps/desktop/src/plugins/agent/main/quick/`: the keys and settings (`index.ts`, `settings.ts`),
  the panel and the dock's dots (`panels.ts`), their windows (`surface.ts`, `dock.ts`), placement,
  the selection, the capabilities
- `apps/desktop/src/plugins/agent/main/claude/quick.ts`: the launch options, the hooks and the
  instructions; `main/claude/routes.ts` (`/ask`, `/quick-result`), `main/host/questions.ts` (the
  desk), `main/host/quick-state.ts` (a light from the listing)
- `apps/desktop/src/plugins/agent/shared/`: questions, the panel's and the dock's views and
  requests, the keys
- `apps/desktop/src/plugins/agent/renderer/quick/`: the panel and dock pages, the card, the HUD's
  CSS, the settings section, and the dock key in the main window (`keys.ts`)
- `apps/desktop/src/main/page-windows.ts`, `main/renderer-window.ts`,
  `src/renderer/src/components/PageRoot.tsx`: a plugin's own windows
