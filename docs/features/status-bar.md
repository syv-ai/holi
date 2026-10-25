# Status bar and bottom panel

VS Code's foot of the window, in the fresh shell: a thin status bar under the main column, and
above it a resizable bottom panel holding a Terminal, an Output log of what Holi does in the
background, and the raw application Logs. Both belong to the shell, not to a tab: they stay as they are while tabs and splits
change.

## How it works

**The status bar** is one 24px row (`h-6`, `text-xs`, muted, a `border-t` hairline) at the foot of
the main column, on the chrome's glass (`data-slot="app-chrome"`, as the title band). It spans the
views, every split and the bottom panel, and the right-hand drawers, but not the sidebar: the
sidebar is a full-height column with its own foot (the profile), and the band at the top is the one
row that crosses both. It is drawn on desktop only. Each item is a ghost button (`size="xs"`) with a
tooltip, a Lucide icon at `size-3.5` and its words. Only what is true is drawn:

- **Branch**: the vault's checked-out branch, with `*` while the tree has uncommitted changes.
  Clicking it opens the branch picker (below); the Output has its own toggle on the right.
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

**The branch picker** is VS Code's, built as shadcn's combobox: a Popover holding a Command. From
the top: a search, **Create branch…**, the local branches (most recently committed first, the
current one checked, `not published` on one with no upstream yet), then the branches on `origin`
that have no local branch. It reads the list at once from the clone (`sync.branches`,
`for-each-ref`) and fetches as it opens (`sync.fetchBranches`; main skips it when it fetched in the
last 15 seconds or a pull is already fetching), then reads again. Choosing a local branch switches
to it; choosing a remote one makes a local branch tracking it (`switch --track`). **Create
branch…** swaps the list for a name field, prefilled with the search, checked as you type against
git's own rule in main (`sync.branchNameValid`, `check-ref-format --branch`, the answer equal to the
name) and against the local names; Enter or **Create branch** makes it at HEAD (`switch -c`), with
no upstream until its first push. Loading shows skeleton rows, a list that fails shows an inline
error with Retry, and a switch main refuses shows its words at the top of the picker, which stays
open. A switch writes the open buffers to disk, then `sync.switchBranch` settles the tree and
switches (see [vaults and sync](vaults-sync.md), Branches); the snapshot is read again and the
open editors reload from the new tree as after a pull.

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
last the session. The header is compact line tabs, Terminal, Output and Logs, and on the right the tab's
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
channel in order, so nothing doubles. If node-pty will not load, the tab says so with the rebuild
command (`pnpm --filter @holi/desktop run rebuild:natives`) and a Retry.

**Context chips**, as Warp draws them above its prompt: a row of small outlined monospace chips
over the shell in front. The cwd with home as `~` (a long one loses its middle; the tooltip has the
whole path, and a click or Enter copies it), the git branch when the cwd is in a work tree, and the
changes as `16 • +1435 −3`: changed files (untracked ones included), lines added in the success
colour and removed in the destructive one, each part drawn only when it is not zero. A skeleton
holds the row until main first reads it. The picker names each terminal by its cwd's folder
(`holi`), adding the shell's name when two share one (`holi · zsh 2`).

Main works them out (`main/terminal/terminal-context.ts`) and pushes each change
(`terminal:context`, naming the vault and the terminal like the bytes; `terminal.list` carries the
last one for a reload). **Where the shell is** comes from shell integration
(`shell-integration.ts`): a prompt hook that prints OSC 7 (`file://host/path`). zsh starts with
`ZDOTDIR` at a Holi-written directory (a fresh `mkdtemp` per run) whose `.zshenv`, `.zprofile`,
`.zshrc` and `.zlogin` each source the person's own file of that name from their real `ZDOTDIR` or
`$HOME`, with `ZDOTDIR` set back to theirs while it runs; the hook goes in after their `.zshrc`, the
last file restores `ZDOTDIR` for good, and a `HISTFILE` that macOS's `/etc/zshrc` pointed at Holi's
directory is put back. bash starts with `--init-file`, a script that reads what a login bash would
(`/etc/profile`, then the first of `~/.bash_profile`, `~/.bash_login`, `~/.profile`) and appends the
hook to `PROMPT_COMMAND`, after theirs so it still sees the command's status. Main reads the OSC 7
off the PTY's bytes (one split across chunks is held until it ends), and takes it only as a local
`file:` URL naming a directory that exists. A shell that has never printed one (fish, or an rc that
drops the hook) is asked of the OS instead: `lsof -a -p PID -d cwd -Fn` once output has been quiet a
moment, at most every two seconds. **The git work** is `rev-parse --abbrev-ref HEAD`,
`status --porcelain=v2 -z --untracked-files=all` and `diff --numstat -z HEAD` (the empty tree before
a first commit), with `GIT_OPTIONAL_LOCKS=0` so a read never takes the index lock from the sync
engine; it is read at the start, then 150ms after every prompt, since every prompt prints an OSC 7,
so an edit shows at the next prompt. The cwd may be outside the vault: it is the person's own shell.

**The look.** The xterm's colours come from the app's tokens (`lib/terminal-theme.ts`): no ground
of its own, so it is exactly the panel's (on macOS, the window's glass); the view's text colour; the
16 ANSI colours from `--terminal-*` in `index.css`, tuned for each mode (on white the normal ones
hold 4.5:1 and the bright ones are a step darker; on the dark ground all but black clear 4:1); a
selection from `--terminal-selection`. All are read again when light and dark swap. The app's mono
font (`--font-mono`, Geist Mono) at 12px and a 1.3 line height, a blinking bar cursor and a 12px
gutter; the first build waits for the font so cells are measured in it. WebGL draws it and a lost
context falls back to the DOM renderer; URLs are links that open through `openExternal`.

**The Output** shows the activity log (`main/activity/log.ts`): a ring of the last 2000 lines of
`{at, channel, level, message, detail?}` on the channels `git`, `sync`, `agent`, `plugins` and `app`.
Main keeps it from launch and pushes each line (`activity:entry`); the shell loads it once
(`activity.entries`) and follows it, so it collects while the panel is closed. It is drawn as the
events grid of ReUI's `solution-dev-ops-2` audit log (`log-table.tsx`, shared with Logs): a dense,
virtualised data grid with no header
fill, newest first, sortable by time, channel, level and vault. A row is the time, the channel's
mark and name (the Git logo, GitHub's for sync, Claude's for the agent, a puzzle piece for plugins,
Holi's for the app), the level as a badge (`info-light`, `warning-light`, `destructive-light`), the
message and the vault. A row opens under itself, as in ReUI's `c-data-grid-8` expandable rows: its
fields, the detail (a git error's text, the paths a commit or a conflict named), the line as JSON,
and Copy line. The opened panel measures itself, and the virtualizer adds that height to the row's
own, so scrolling past an opened line does not jump. A click anywhere on a row opens it, the
channel included; the channel's context menu shows only that channel or hides it, either replacing
any channel rule already set.

The search lives in the panel header, the Agents sidebar's search field with the filters inside it:
it searches message, detail, channel and vault, and its filter button opens ReUI's Filters builder
inline (channel, level, vault, message), each rule a row. Once a rule is set, a count and a
clear-all sit beside the filter button. The header also copies what is shown and clears; Clear
clears main's ring too, so a reload does not bring the lines back.

The builder sits in a Radix popover inside the search field and stops clicks at its edge. React
bubbles a click through the portal to the field's addon, which focuses the search input on any
click; Radix would read that focus as leaving the popover and close the builder as soon as an
attribute is picked, before its condition is set.

**The Logs** stream everything Holi prints (`main/logs/app-log.ts`): main's `console`, captured from
the first line main prints, and the window's console messages (`console-message`), each kept with
its level, its process (Main or Window) and the `[scope]` it opened with, its first line as the
message and the rest (a stack, git's text) as the detail. It is a ring of 5000 lines in memory,
never on disk, scrubbed of credentials as the activity log is, pushed a line at a time
(`logs:entry`) and read once by the panel (`logs.entries`). The console still prints as before: the
capture listens rather than takes over, and does not log what the log's own push prints. Logs use
the Output's grid with their own columns (time, level, process, scope, message), the same opened
row and the same header search, with Filters over level, process, scope and message.

**What is logged.** The sync engine (see [vaults and sync](vaults-sync.md)): every autosave commit
with its short sha and message, a pull that merged, a merge conflict with its paths, a push and
how many commits it took, a push that was refused or failed with git's own words, a reconcile and
an abandoned merge, and each change of the sync state where it settles; plus a vault opening and
closing; and each branch switch and creation (`Switched to branch topic`, `Created branch
feat/notes`), with the push naming its branch (`Pushed 1 commit to origin/feat/notes`). The agent: a session starting and ending, and a turn ending. Plugins: one that would not
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
- The renderer gets bytes and lines, never a process. A shell starts only in the open vault's
  clone; the one path it reports, its cwd, is validated in main and may be anywhere the person
  `cd`s.
- The person's shell setup runs as it would in their own terminal: Holi only adds a prompt hook,
  after their files.
- Nothing fake in the bar: an item with nothing true to say is not drawn.

## Rejected

- The bar under the sidebar too, as in VS Code: the sidebar is a full-height column with its own
  foot, and the person asked for the bar in the main view.
- Reusing the agent's terminal host for the panel: its PTYs are Claude Code clients with a mirror
  and turn hooks, and it is a plugin core cannot import. The PTY primitive moved to core instead.
- Logging every git command: the loop runs `git status` every few seconds, and a log of that is
  noise that buries the commit someone is looking for.
- Parsing OSC 7 in the renderer's xterm (`registerOscHandler`): main has to validate the path and
  run git there anyway, it sees the bytes of a terminal whose xterm is not built yet, and the
  renderer would otherwise hand main a path to act on.
- Persisting the log to disk: it is a window onto now; git keeps the history that matters.

## Code

- `apps/desktop/src/main/activity/log.ts`: the ring, scrubbing
- `apps/desktop/src/main/logs/app-log.ts`: the application log, the console capture
- `apps/desktop/src/main/vault/active-vault.ts`: where sync and git write to it, `syncInfo`,
  `syncNow`
- `apps/desktop/src/main/terminal/`: the PTY and the panel's shells; `shell-integration.ts` (the
  zsh and bash shims), `terminal-context.ts` (OSC 7, lsof, the git summary)
- `apps/desktop/src/main/router.ts` (`sync.info`, `sync.now`, `sync.branches`,
  `sync.fetchBranches`, `sync.branchNameValid`, `sync.switchBranch`, `activity`, `terminal`),
  `src/preload/index.ts` (`activity`, `terminal` pushes)
- `apps/desktop/src/plugins/agent/main/host/session-log.ts`: the agent's lines
- `apps/desktop/src/renderer/src/components/blocks/app-shell-21/components/status-bar.tsx`,
  `branch-picker.tsx`, `bottom-panel.tsx`, `panel-terminal.tsx`, `terminal-context-chips.tsx`,
  `log-table.tsx`, `log-detail.tsx`, `log-search.tsx`, `panel-output.tsx`, `output-search.tsx`,
  `output-columns.tsx`, `output-filters.tsx`, `panel-logs.tsx`, `logs-columns.tsx`,
  `channel-mark.tsx`
- `apps/desktop/src/renderer/src/lib/terminal-theme.ts`
- `apps/desktop/src/renderer/src/state/activity.ts`, `app-logs.ts`, `bottom-panel.ts`,
  `panel-terminals.ts`
- `apps/desktop/src/plugins/agent/renderer/sessions/AgentStatusItem.tsx`
