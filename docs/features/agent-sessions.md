# Agent sessions

The vault assistant is a real interactive `claude` in a PTY, shown in an ordinary tab. A vault runs
any number of sessions. Holi runs them, keeps its own git out of their way, shows what each turn
changed, and hands them merge conflicts. Configuration is in [agent-config.md](agent-config.md).

## How it works

**Spawn.** Main finds `claude` (`$HOLI_CLAUDE_BIN`, `PATH`, then common install dirs) and spawns it
in node-pty with the vault clone as cwd. The env strips parent-session variables (`CLAUDECODE`,
`CLAUDE_CODE_ENTRYPOINT` and kin) and forces `CLAUDE_CODE_NO_FLICKER=1`. Argv is only `--name`, bare
`--resume`, `--resume <id> --fork-session`, or a positional first prompt. Spawns are serialised.

**Main owns the record.** Each session has its runtime, a headless-xterm `TerminalMirror`, pid,
hook bearer and config staleness. Every IPC route names a session, except `agent:focus`: the focused
file is the vault's.

**Tabs.** A session tab can sit beside the note it is about. It stays mounted while hidden, builds
its xterm on first show, and never fits at 0x0. Closing a tab does not end the session. The
sidebar's **chats** section is always present and is where sessions are started, resumed, renamed,
duplicated, restarted and ended; with the nav hidden, the rail shows one orb per live session. ⌘J
goes to the current session or starts one.

**State is read, not inferred.** Main runs `claude agents --json` against the vault's config
directory, joins rows by pid, and derives `needs-you | working | idle` from `waitingFor`, then
`busy`, then the turn bracket. It re-reads on a watch of `<configDir>/sessions/` (an edge trigger,
never parsed), on each turn hook and when a tab opens. No timer. If the CLI fails, the bracket still
reports `working`.

**Names are Claude Code's**: `--name`, `/rename`, an accepted plan, or the title its small model
writes. That title arrives through the status line: the config dir points `statusLine` at a
generated `holi-statusline` that posts Claude Code's JSON to the hook server and prints Holi's answer
(`<model> · 42% context`). Otherwise the tab says "New session". The cost: Claude Code then drops
most footer key hints.

**Actions.** Rename pastes `/rename ` and brings the tab forward. Duplicate forks by the id read
from the listing at that moment, and refuses a session with no turn yet. Restart starts a new
process under the same real name. Resume opens bare `--resume` in a new tab; escaping that picker
before any turn drops the session. An exited session stays listed until closed.

**Asks are pasted, never submitted.** Text from a selection, task, mail thread or PDF comment goes
to a session the user picks (needs-you sessions are not offered) as a bracketed paste with no Enter.
A new session's paste waits until the listing sights it, with a 5 s backstop. **Reconcile is the
exception**: its first turn is submitted.

**Git coexistence.** Seeded `UserPromptSubmit` and `Stop` hooks POST to a loopback hook server with
a per-session token. The vault has one working set: the first turn to start pauses sync, the last to
end resumes it and takes one settle commit. A session also leaves the set on exit, on two
consecutive `idle` readings (escaping a permission prompt fires no `Stop`), or on a 10 minute cap.

**Turn review.** A turn is a commit range, `base` at start to the settle commit. Records go to
`.holi/state/turns.local.json` (50, newest first); files and diffs come from git when shown. A chip
under the terminal says `Claude changed N files` and opens a review with per-hunk accept and reject,
saved as one new commit per file. An overlapped turn says so; an unreachable range says its history
is gone.

**Merge resolver.** "Ask Claude to reconcile" re-runs the merge without aborting and starts a
session whose first turn names the conflicted paths. The agent resolves and commits the merge in
view. The sync side is in [vaults-sync.md](vaults-sync.md).

**A vault switch ends every session**, asking first if one is working or needs you; adding a vault
asks at the start. The conversations stay reachable through `--resume`.

## Rules

- Never infer session state from PTY output.
- Key a session by its terminal, never by Claude Code's session id, which changes on `/clear`.
- Probe a pid before signalling it: signal the group only if it still leads its group. A reaped pid
  may already be a stranger's.
- Kill is SIGTERM to the group, then SIGKILL, awaited. Bare `pty.kill()` sends SIGHUP and loses
  Claude Code's session tail.
- Only reconcile appends Enter. Holi cannot see the composer.
- Record a turn after the vault resumes, fire-and-forget: a lost record beats a stuck pause.
- A turn revert does not flush open buffers first; a dirty buffer 3-way merges.
- Turn-hook responses are empty: a body would be injected into Claude's context.

## Rejected

- A headless chat panel or a server-side agent: re-implements the TUI.
- `--resume <id>` shortcuts or a Holi list of past sessions: a second index over Claude's store.
- A gate before the agent's writes: Claude Code already asks.
- Recording touched paths from `PostToolUse`: misses edits made through `Bash`.
- A worktree per session: edits invisible until merged, `.local.` files absent.
- A `Notification` or `PermissionRequest` hook for needs-you: late or partial.
- Pasting through Claude Code's peer socket: undocumented.
- Adopting sessions Holi did not spawn: their turns are invisible to the pause.
- A three-pane merge editor: resolves positionally, wrong for prose.

## Code

- `apps/desktop/src/main/agent/agent-runtime.ts`: env, argv, PTY, kill path
- `apps/desktop/src/main/agent/agent-manager.ts`: session registry, pastes, actions, status line
- `apps/desktop/src/main/agent/session-registry.ts`: the `claude agents --json` reader
- `apps/desktop/src/main/agent/turn-coordinator.ts`, `turn-log.ts`: working set and turn records
- `apps/desktop/src/renderer/src/features/agent/`: session tab, chats, orbs, turn chip and review
- `apps/desktop/src/renderer/src/state/agent-send.ts`: starting sessions and sending asks
