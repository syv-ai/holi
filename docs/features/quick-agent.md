# Quick agent

A global hotkey, pressed in any other app, opens a small panel at the pointer. Type a task and an
agent starts on it in the open vault, as an ordinary session, and the panel goes out of sight. The
agent lives on as a dot in the dock, a slim pill at the right edge of the screen, lit yellow while
it works, orange when it needs you, green when it is done and red when it failed. Pointing at a
dot brings that agent's panel out beside it: its answer, its question or its light. A second key
opens the dock with the keyboard, to step through the agents and act on them.

## How it works

**The keys.** Two, both global, and both this machine's to choose (Settings, Quick agent): they are
the only keys in Holi a person picks, because each is taken from every other app.

- **The prompt key**, ⌘J by default (the key that opens the agents inside Holi), opens a new
  prompt at the pointer, or the prompt left with a draft if there is one, and nothing else: what
  is already running is the dock's.
- **The dock key**, ⌃⌘J by default, opens the dock with the keyboard on the agent that most needs
  you: the oldest one asking (a question, or Claude Code's own prompt), else the oldest finished,
  else the newest working. An asking agent whose panel the pointer has brought out is the one
  exception: its foot says to press the key to answer it, so the key goes to it. With no quick
  agent at all it opens a prompt, as the prompt key would, so it is never a dead key.

Holi registers them globally only while no window of its own has the keyboard (read again on every
focus change, every window closing and every few seconds, so a missed event never strands one), and
inside its windows each page answers them itself. In the main window the prompt key keeps its
in-app meaning (⌘J opens the agents) and the dock key opens the dock, as from any other app: the
window reads it ahead of its own keys, since the terminal or the editor would take it and an in-app
hotkey reads ⌃ as ⌘, so ⌃⌘J would open the agents. In a quick panel the page answers both (the
prompt key starts another agent; the dock key opens the dock from a prompt and steps out of a
terminal). Both are on by default, behind one switch. They are never one key: Settings refuses a
key that is already the other's, either way round, and if a hand edit makes them the same the
prompt key wins and the dock key takes its default, or ⌘J when the prompt key is ⌃⌘J. Every key
that changes is let go before any is taken, so swapping the two never collides, and a key another
app holds is reported under its row. The settings are this machine's, in
`userData/quick-agent.json`, never in a vault.

**The panel.** A window the agent plugin opens through `AppContext.openPage` and draws as its page
`quick`. It is a macOS panel (`type: 'panel'`), so it takes the keyboard without making Holi the
active app: the main window stays where it is and the app you were in is yours again when the panel
lets go. It floats above everything on every Space, over full-screen apps too, on the HUD material
(`vibrancy: 'hud'`) under a dark tint of its own, since macOS draws that material light while the
system is in light mode. A prompt opens just past the pointer, wholly on that display and never on
top of another panel or the dock; an agent's panel comes out beside the dock (below). Its page
reports its size and main fits the window to it. Holi keeps one panel and the dock loaded and out
of sight, so a press shows a panel, and a sent task its dot, at once rather than after a window and
its page have loaded. Whether a panel has the keyboard is told to its page by main: a panel never
makes Holi the active app, and Chromium does not always hear it give the keyboard back.

**The prompt.** Before the panel takes the keyboard, Holi reads what is selected in the app you
were in: the focused element's `AXSelectedText` through the Accessibility API, and when an app does
not answer, ⌘C with the clipboard put back afterwards. What a file manager copies is files, so a file
selected in Finder comes along as its path, which the agent can read. Both run as `osascript`
JavaScript, so Holi ships no native module. The selection comes along as a chip (⌫ in the empty field drops it), after
the task, fenced and labelled with its app, capped at 20 000 characters. The first press without
the Accessibility permission explains it once, with ⏎ for macOS's own prompt; Settings shows
whether Holi has it. ⏎ starts the agent, ⇧⏎ is a new line, esc closes. The agent runs in the vault
open when the task is sent, which the prompt's header names, even if another was open when the
prompt appeared. Sent, the panel goes out of sight, the keyboard goes back to the app you were in,
and the agent's dot appears in the dock. A prompt left with a draft waits, out of sight, for the
next press of the prompt key, from any app or panel; one nobody wrote in goes when you click into
another app.

**The agent.** `claude --bg` in the open vault, like any session (see
[agent-sessions](agent-sessions.md)), with three flags and nothing written into the vault:

- `--permission-mode auto`: you went back to what you were doing, so Claude Code's classifier
  approves what is safe and still stops for what is not. A vault's committed settings cannot set
  `auto`.
- `--append-system-prompt`: work alone, ask only when blocked on a decision that is yours, always
  with AskUserQuestion and its recommendation first, and be as brief as possible: no preamble or
  narration, and a last message that is the result in a sentence or two, or just the answer.
- `--settings`: one hook, `PreToolUse` on AskUserQuestion.

The session is named from the task's first line and is in the sidebar, the palette and the agent
list like any other; its card shows over its tab in the main window too.

**Questions.** The hook posts the tool call to the bridge's `/ask` with the vault's token and the
job id, and Holi holds the request (the question desk) until the question is answered, in the panel
or over the session's tab. The answer is the hook's output (`permissionDecision: "allow"` with
`updatedInput.answers`), which Claude Code takes as the answer without drawing its own box. Only a
quick agent's question is taken; any other is answered empty, and the hook then prints nothing, so
Claude Code asks the ordinary way. The hook `exec`s into `curl` with the JSON as an argument, so
when Claude Code ends the hook (a stop, a timeout) the request ends and Holi lets go. While Holi
holds a question, Claude Code's listing says `busy`, so the session list reads the desk: such a
session needs you.

**The card.** 1 to 4 answer at once, and the next question comes, or the answers go after the
last. ⏎ takes the highlighted option, which starts on Claude's recommendation; on a multi-select
(marked "pick any") the numbers toggle, a picked option's key fills with the light, and ⏎ sends
what is picked. o writes your own answer, and ← or ⌫ goes back a question. In a quick panel ↑ ↓
are the dock's, so the highlight stays where it starts, since nothing there could move it back: a
pick leaves it, leaving your own answer puts it back, and esc puts the panel away with the question
still waiting. Over the session's tab in the main window ↑ ↓ move the highlight, which follows a
pick.

**The dock.** A second window of the plugin's, drawn as its page `dock`: a slim dark pill against
the right edge of a display's work area (6 px in) and centred top to bottom,
above everything on every Space and kept out of Mission Control. It holds one dot per quick agent,
oldest at the top in the order the tasks were sent, so the order never changes under you, and how
many are working, waiting on you and done reads at a glance, as the menu bar's extras do. It is in
sight exactly while there is a quick agent: it appears on the display the pointer is on, and moves
to the pointer's display whenever the dock key is pressed. It never takes the keyboard
(`focusable: false`): pointing at a dot leaves the keyboard where it was, and a click gives it to
the dot's panel, never to the dock. Its page reports its size and each dot's centre, so main fits
the window to it and sets a panel level with its dot. A dot is its agent's light: working breathes;
needing you, it sends one ring out to the pill's edge and then holds a soft halo; done and failed
are steady. A new dot grows out of its own place, and the dot whose panel is out wears a thin
ring. There are no tooltips: the panel is one.

**Pointing at a dot.** That agent's panel comes out to the left of the dock, 8 px from it, its
header level with the dot and the whole panel kept on the display, without the keyboard, so typing
in another app is never caught by it. Out like that, a light or an answer has no foot of keys, and
a card or Claude Code's prompt says "Press ⌃⌘J to answer" (whatever the dock key is). The panel
goes a quarter of a second after the pointer has left both the dock and the panel, so crossing the
gap onto the panel keeps it (the panel tells main when the pointer comes onto it and leaves), and
a panel with the keyboard stays. With the keyboard already in an agent's panel, pointing at another
dot moves the panel out, and the keyboard with it, to that agent. A click on a dot brings its panel
out with the keyboard.

**The keyboard in the dock.** The dock key or a click gives the panel beside the dock the keyboard,
and its foot names the keys it answers. ↑ ↓ step to the agent above or below, whose panel comes
out beside its dot with the keyboard, stopping at the top and bottom rather than wrapping. esc puts
the panel away and gives the keyboard back to the app you were in; its dot stays. On a finished
agent esc clears it instead, as it cleared a finished panel before there was a dock: there is
nothing left to wait for, and putting it away left a dot that only Holi could clear. The prompt key
opens a new prompt from any of them, or the draft left out of sight. The rest depends on what the
panel shows:

- A card: its own keys (above).
- Claude Code's prompt: the session's terminal, inert until ⏎ (or a click) steps into it, so the
  dock's keys are never typed into Claude Code. Inside, every key is Claude Code's, its arrows
  included, and the dock key steps back out to the agents.
- Working: the dock's keys only.
- Done: ⏎ opens the session in the main window, closing the panel and taking its dot away; c
  copies the answer as Claude wrote it; ⇧↑ ⇧↓ scroll a long one; esc (or ⌫) clears the agent,
  which takes the panel and the dot away and stops its session (its conversation stays in the
  agent list).
- Failed: ⏎ and esc as when done.

Clicking into another app puts the panel away, stepping out of a terminal it had stepped into; the
dock and every dot stay.

**After a task, and after an answer.** Sending a task puts its panel out of sight and its dot in
the dock, which appears if it was not in sight. Answered in the panel, a question sets the agent
working again and the panel, which has the keyboard, stays out showing the working light, for ↑ ↓
to step on from. Answered over its tab in the main window instead, a panel that was out only to be
looked at goes.

**Lights.** The colours are the `--agent-*` tokens (a session's orb in the sidebar uses the same),
and a vault's theme can set them. A panel wears its agent's light in its orb, its state word and
its edge, which breathes only while the agent works. An agent wanting you, with a question or with
Claude Code's own prompt (a permission, or a question that fell through), changes its dot and
nothing else: no panel comes to the pointer, because a panel on screen for every agent, each coming
back as its agent wanted you, cluttered the screen. The dock key goes to it first. When Claude Code
waits on its own prompt, the panel shows that session's terminal, so the prompt is Claude Code's,
keys and all. A green or red dot stays until you clear it or open it in Holi. Leaving the vault
stops its sessions and takes their dots away, a start there that failed included; turning the keys
off closes every panel and the dock.

**Open at login.** Settings, Updates offers it for this machine's app: Holi starts in the menu bar,
its window loaded but out of sight, so the vault opens and both keys work from the start.

## Rules

- A quick window never takes the keyboard on its own: only one of the two keys, or a click, gives a
  panel focus, and the dock never has it.
- Only a prompt opens at the pointer. An agent wanting you changes its dot, and nothing else.
- In a quick panel ↑ ↓ are the dock's: the card's highlight does not move there.
- The prompt key and the dock key are never one key.
- Read the selection before the panel takes the keyboard: a ⌘C posted after it would go to the panel.
- A quick agent's flags are per launch, never seeded or merged into a vault's settings.
- Holi answers only a question it holds for a quick agent it started this run; every other way of
  not answering falls through to Claude Code's own box.
- Permission prompts stay Claude Code's own, shown in its terminal; the card is for AskUserQuestion only.

## Rejected

- Holi's own ask tool over MCP: works, but is not AskUserQuestion, and there is no MCP server.
- The Agent SDK or a headless session: the panel would be a second agent, not the session in the
  sidebar, and the main window's tab is a terminal.
- The hook shipped into the vault or merged into `.claude/settings.json`: a shipped hook reaches an
  existing vault only through `holi skills update`, and a merged one would reach every session.
- Permission prompts as cards: a parallel prompt system, and the `PermissionRequest` hook is late or
  partial (see [agent-sessions](agent-sessions.md)).
- A panel left on screen for each agent, as its light: a few quick agents cluttered the screen. A
  dot says the same in a few pixels, and its panel comes out when pointed at.
- The card, or any panel, coming to the pointer when an agent needs you: the same clutter, arriving
  wherever you were working. The dot turns orange and the dock key goes to it.
- One key for both, going to what needs you before it opened a prompt: the key for a new task then
  did something else whenever an agent was waiting.
- A panel that takes the keyboard when an agent needs you: keys typed in another app would answer it.
- A native module for the selection: `osascript` reads it in about 100 ms.

## Code

- `apps/desktop/src/plugins/agent/main/quick/`: the keys and settings (`index.ts`, `settings.ts`),
  the panels and the dock's dots (`panels.ts`), their windows (`surface.ts`, and the dock's
  `dock.ts`), placement, the selection, the capabilities
- `apps/desktop/src/plugins/agent/main/claude/quick.ts`: the flags, the system prompt and the hook
- `apps/desktop/src/plugins/agent/main/claude/routes.ts` (`/ask`), `main/host/questions.ts` (the
  desk), `main/host/quick-state.ts` (a light from the listing)
- `apps/desktop/src/plugins/agent/shared/`: questions, the panel's and the dock's views and
  requests, the keys
- `apps/desktop/src/plugins/agent/renderer/quick/`: the panel page (`QuickPanel.tsx`), the dock
  page (`QuickDock.tsx`), the lights both wear (`lights.ts`), the card and its keys, the HUD's CSS,
  the settings section, and the dock key in the main window (`keys.ts`)
- `apps/desktop/src/main/page-windows.ts`, `src/renderer/src/components/PageRoot.tsx`: a plugin's own
  windows
