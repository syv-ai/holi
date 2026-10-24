# Status bar and bottom panel

VS Code's foot of the window, in the fresh shell: a thin status bar under the main column, and
above it a resizable bottom panel holding a Terminal and an Output log of what Holi does in the
background. Both belong to the shell, not to a tab: they stay as they are while tabs and splits
change.

## How it works

**The status bar** is one 24px row (`h-6`, `text-xs`, muted, a `border-t` hairline) at the foot of
the main column, on the chrome's glass (`data-slot="app-chrome"`, as the title band). It spans the
views, every split and the bottom panel, and the right-hand drawers, but not the sidebar: the
sidebar is a full-height column with its own foot (the profile), and the band at the top is the one
row that crosses both. It is drawn on desktop only. Each item is a ghost button (`size="xs"`) with a
tooltip, a Lucide icon at `size-3.5` and its words. Only what is true is drawn:

- **Branch**: the vault's checked-out branch, with `*` while the tree has uncommitted changes.
  Clicking it opens the Output.
- **Sync**: behind and ahead (`2↓ 0↑`) with a sync glyph that turns while pulling or reconciling
  (`animate-spin`, held still under reduced motion). Offline swaps the glyph for a cloud, and a state that
  wants you (a conflict, no access, a blocked pause) for a warning, with the state's words beside
  the counts; the tooltip adds the last failure's first line. Clicking runs a sync now (commit,
  pull, push: `sync.now`) when the state is up to date or offline, and opens the Output when it is
  one to read rather than retry.
- **Synced 2m ago**: when the remote last answered a pull or a push, while the bar is wide enough.
- **Plugins' items** (`statusItems`), then **Terminal** and **Output**, which toggle the panel on
  their tab. Output carries a red dot while an error has been logged since the Output was last on
  screen.

Branch, counts and the last sync come from one query, `sync.info` (a `git status` and the vault's
`syncInfo()`), read again when the sync state, history or the activity log moves, and every 30
seconds. The sync state is the existing push (`vault:sync`).

**The plugin slot.** `RendererPlugin.statusItems` lists `{id, side, order, Component}`; a plugin
draws its item with `StatusBarItem` from `@/plugin-api` and renders nothing when it has nothing to
say. Left items follow the sync items, right items come before Terminal and Output. The agent's
item is its own: `2 working`, `1 needs you` or `3 sessions` from the counts the Agents toggle
reports (`agentsStatusAtom`), hidden with no live session; a click opens Agents.

**The bottom panel** opens between the views and the status bar. Its top edge is the resize
handle, drawn as the split view's: a 1px hairline with a wider hit area, the ring colour on hover,
focus and drag. Arrow keys move it 16px (64 with Shift), Home and End go to the largest and the
smallest, and a double-click returns to 280px. It is held between 120px and 70% of the column, and
the height is this machine's (`localStorage`, `holi.bottom-panel.height`). Open, tab and maximized
last the session. The header is compact line tabs, Terminal and Output, and on the right the tab's
own controls, maximize or restore (the panel fills the column), and close. The panel is mounted
from the shell's first render so its keys are live, drawn once first opened, and after that hidden
rather than unmounted, so a closed panel keeps the shells' scrollback.

**The Terminal** is the person's login shell (`$SHELL -l`, else `/bin/zsh`) in a PTY in main, in
the open vault's clone, with `TERM=xterm-256color` and the `holi` command on `PATH`. It is core's
(`main/terminal/`), not the agent plugin's: a terminal is a terminal whatever the vault runs, and
core may not import a plugin. node-pty is loaded in one place, `main/terminal/pty.ts`, which the
agent's runtime reaches through `plugin-api.ts`. The renderer sees bytes (`terminal:data`,
`terminal:exit` pushes) and sends keystrokes and sizes over tRPC (`terminal.write`, `resize`), each
naming the vault and the terminal; one about any other vault is dropped. **+** starts another
shell, the picker chooses which is in front, and the trash kills the one in front; killing the
last closes the panel. Opening the Terminal tab with none starts one. Closing the panel keeps them;
leaving the vault and quitting stop them (SIGHUP, then SIGKILL, through the same pid probe the
agent's kill uses). An xterm built after its shell printed asks main for what it printed (the last
256 KB) and drops the live pushes until that answer lands; main sends both down the one window
channel in order, so nothing doubles. Colours are the agent terminal's: no ground of its own, in the
view's text colour, read again when light and dark swap. If node-pty will not load, the tab says so
with the rebuild command (`pnpm --filter @holi/desktop run rebuild:natives`) and a Retry.

**The Output** shows the activity log (`main/activity/log.ts`): a ring of the last 2000 lines of
`{at, channel, level, message, detail?}` on the channels `git`, `sync`, `agent`, `plugins` and `app`.
Main keeps it from launch and pushes each line (`activity:entry`); the shell loads it once
(`activity.entries`) and follows it, so it collects while the panel is closed. Each row is the time
(`HH:MM:SS`), a channel badge (`info-light` for git and sync, `warning-light` and
`destructive-light` for warnings and errors), the message, and a detail that expands (a git error's
text, the paths a commit or a conflict named). It follows the foot as lines arrive until the person
scrolls up, then offers Jump to latest. The header filters by channel, copies what is shown, and
clears; Clear clears main's ring too, so a reload does not bring the lines back.

**What is logged.** The sync engine (see [vaults and sync](vaults-sync.md)): every autosave commit
with its short sha and message, a pull that merged, a merge conflict with its paths, a push and
how many commits it took, a push that was refused or failed with git's own words, a reconcile and
an abandoned merge, and each change of the sync state where it settles; plus a vault opening and
closing. The agent: a session starting and ending, and a turn ending. Plugins: one that would not
start, and whatever a plugin writes with `ctx.log`. The app: Holi starting, and an update found,
ready or failing. Every line is scrubbed of anything shaped like a credential before it is kept.

## Keys

⌃\` toggles the panel on Terminal and ⇧⌘U on Output, as in VS Code (Ctrl+\` and Ctrl+Shift+U
elsewhere): a key opens the panel on its tab, switches to it when the other tab shows, and closes
the panel when its tab already shows. ⌃\` is the one Control key the table fires inside a terminal
(`inTerminal`), so the panel closes from inside the shell it shows; the panel's xterm hands both
keys back rather than typing them. See [keyboard shortcuts](keyboard-shortcuts.md).

## Rules

- State changes, not ticks. A pull that found nothing, the `pulling` state that comes and goes every
  three minutes, and a failure repeated in the same words are not lines. A laptop on a plane fails
  every interval, and that is one line.
- Never a credential: the token never reaches a URL or an argument (`GIT_ASKPASS`), and the log
  scrubs URL userinfo, GitHub token shapes, `Bearer` values and `*TOKEN=` pairs anyway.
- The renderer gets bytes and lines, never a process or a path outside the vault. A shell starts
  only in the open vault's clone.
- Nothing fake in the bar: an item with nothing true to say is not drawn.

## Rejected

- The bar under the sidebar too, as in VS Code: the sidebar is a full-height column with its own
  foot, and the person asked for the bar in the main view.
- Reusing the agent's terminal host for the panel: its PTYs are Claude Code clients with a mirror
  and turn hooks, and it is a plugin core cannot import. The PTY primitive moved to core instead.
- Logging every git command: the loop runs `git status` every few seconds, and a log of that is
  noise that buries the commit someone is looking for.
- Persisting the log to disk: it is a window onto now; git keeps the history that matters.

## Code

- `apps/desktop/src/main/activity/log.ts`: the ring, scrubbing
- `apps/desktop/src/main/vault/active-vault.ts`: where sync and git write to it, `syncInfo`,
  `syncNow`
- `apps/desktop/src/main/terminal/`: the PTY and the panel's shells
- `apps/desktop/src/main/router.ts` (`sync.info`, `sync.now`, `activity`, `terminal`),
  `src/preload/index.ts` (`activity`, `terminal` pushes)
- `apps/desktop/src/plugins/agent/main/host/session-log.ts`: the agent's lines
- `apps/desktop/src/renderer/src/components/blocks/app-shell-21/components/status-bar.tsx`,
  `bottom-panel.tsx`, `panel-terminal.tsx`, `panel-output.tsx`
- `apps/desktop/src/renderer/src/state/activity.ts`, `bottom-panel.ts`, `panel-terminals.ts`
- `apps/desktop/src/plugins/agent/renderer/sessions/AgentStatusItem.tsx`
