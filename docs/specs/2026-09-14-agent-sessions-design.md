# A vault runs several agent sessions

**Date** 2026-09-14 · **Decision** D100 · **Status** agreed, not built

> We need to be able to support multiple sessions. From the slash command, the
> user needs to be able to choose between each active session or a new session,
> where to send the request.

This came out of `docs/upcoming.md` item 11 (per-vault slash commands, D81). D81's
first open question asked whether an inline agent query is the command's own call or
the drawer's seeded prompt, and the answer was neither: an ask goes to a session the
user picks, live or new. That needs more than one session, so item 11 waits on this
for its agent query and the rest of item 11 is unaffected.

## What is there today

`prd/agent.md` §Runtime: **"One live session per vault. Starting a new one kills the
prior child."** The code agrees everywhere:

- `main/agent/agent-manager.ts` holds one `session`, and beside it one `working`,
  one `turnBase`, one `safetyTimer`, one `configStale`. `start` tears down first.
  `write`, `resize`, `kill`, `attach` carry no id; neither do the pushed events
  `agent-pty:data`, `agent-pty:exit`, `agent:status`.
- `main/agent/hook-server.ts` maps a token to a **vault**. The turn hooks post no
  body, and `onTurnStart`/`onTurnEnd` take no arguments.
- `main/vault/active-vault.ts` pauses on one `manualPause` string, not a count.
- `turn-log.ts` records `{base, end, at}` with no session.
- `AgentPanel.tsx` has one xterm and one set of refs. A seed prompt **kills the running
  session** to start a new one (`AgentPanel.tsx:283-294`), so "Ask agent" on a
  selection today ends the conversation you were having.

Overlapping turns would break it in a specific way: the second session's
`UserPromptSubmit` is swallowed by the idempotence guard, the first session's `Stop`
resumes sync while the second is still editing, and the second overwrites `turnBase`.

A session also outlives a vault switch today, and that is already buggy: the turn
pause and resume read `host.active()`, so a background session in vault A pauses and
resumes vault B, and `setFocus` writes B's paths into A's clone.

**Already multiple:** `AgentRuntime`, `TerminalMirror` and `ContextSnapshot` are
ordinary instances; the ops bearer is minted per session and revoked with it (D87);
the `Session` struct already bundles runtime, mirror, tokens and root; Claude Code
keys transcripts by cwd, so `--resume` lists every session in the vault.

## What is wanted

Three uses, all inside one vault:

- **Parallel work.** Two sessions working at the same moment on different things.
- **Parked conversations.** Several kept alive to switch between.
- **Fire-and-forget asks.** A selection (and later a slash command) sent to a session
  without ending the one you are talking to.

**Nothing crosses vaults.**

## Decisions

### A session is a terminal, not a Claude Code session id

Main keys a session by an id Holi mints, and each spawn gets **its own hook token** in
its environment. A hook call identifies its session by that token alone.

Rejected: spawning with `--session-id <uuid>` and having hooks send the payload's
`session_id`. Claude Code's id changes inside one terminal on `/clear` (SessionStart
fires with source `clear`) and on a `--resume` picked inside it, so the id would move
while the tab the user sees stays put. The tab is the thing with an identity on screen.

### One shared working tree

Every session edits the vault clone directly, as today, so the editor shows edits live.

Rejected: a worktree per session (Claude Code's native `--worktree`). Attribution
would be exact, but edits stay invisible in the editor until a merge, sessions can
conflict at merge time, and `.local.` files (personal memory, `USER.local.md`) are not
in a worktree. Also rejected: many sessions with one turn at a time, which keeps
attribution exact and is not parallel work.

**The cost, stated:** turn review is a commit range (D88), and a range taken across two
overlapping turns contains both sessions' edits. It is not split. A turn that overlapped
another says so instead of claiming everything as its own.

### A vault switch ends every session

Switching kills the vault's sessions; the conversations stay reachable through
`claude --resume`. If any session is working, the switch asks first. This removes the
cross-vault bugs above by construction rather than by keying three more paths to the
session's vault.

### An ask is pasted, never submitted

Text sent to a session, live **or new**, lands in its input box as a bracketed paste
with no Enter, and the drawer focuses that tab. One rule everywhere, and it cannot
append a submit to a half-typed draft.

A session showing a permission prompt is **not offered** as a target: a paste into it
would answer the prompt.

**Reconcile is the exception and stays as it is:** a new session with the merge
instruction submitted as turn one.

## Main process

- **`AgentManager` becomes a registry** of `Session`s. Each owns its runtime, mirror,
  hook token, bearer, name, `configStale`, safety timer, turn base, and two facts:
  `working` (a turn is open) and `needsYou` (a permission prompt is showing). What a
  card and a tab show is derived, `needsYou` first, then `working`, else idle, so a
  prompt answered mid-turn falls back to working with nothing to restore.
  `start` no longer tears down.
  `write`, `resize`, `kill`, `attach` take a session id, and every pushed event
  carries one. `AgentStatus` becomes a list of session summaries
  (`{ id, name, state, configStale, exited }`).
- **The hook server resolves token → session.** The turn hooks stay body-less.
  - `UserPromptSubmit` → `working`, and clears `needs-you`. The **first** one names the
    session from the prompt in its payload (first line, trimmed and capped). Until
    then a session is "New session". A rename from the UI wins over it and is never
    overwritten.
  - `Stop` → `idle`, and clears `needs-you`.
  - `Notification` → `needs-you`, **only** for `notification_type: permission_prompt`.
    The same hook fires after 60 seconds of idle input, which must not read as needing
    you, so the hook script filters before it posts.
  - `PostToolUse` → clears `needs-you` (a prompt was answered and the tool ran).
    A hook on every tool call has a latency cost; the plan measures it before shipping.
  - `SessionStart` → marks the session ready, which is what a pending paste waits for.
  - These are seeded through `settingsWithRequired`, the path that reaches existing
    vaults.
- **A vault turn coordinator** owns the working set for the active vault.
  - The set going from empty to non-empty pauses sync; emptying resumes it. There is
    still **one git actor**: while any session works, nothing commits or pulls.
  - The settle commit is taken when the set empties, so every turn that ended inside
    that window shares one end commit.
  - Each turn records its session id, and `overlapped: true` when its span crossed
    another session's turn. Records without these fields (every existing one) read as
    no session and not overlapped.
  - The safety cap is **per session**: a session whose `Stop` never arrives leaves the
    set after the cap, so one stuck session cannot hold the vault paused for another.
  - A session that exits mid-turn leaves the set at once.
- **Spawns are serialised** through a queue. `ensureAgentConfigDir` rewrites the config
  directory's `settings.json` without a lock and `takeFirstSpawn` is check-then-write,
  so two spawns at once would race both, and print the sign-in notice twice.
- **The focus file stays one per vault** (`.holi/state/context.local.json`). That is
  correct now: every session belongs to the vault on screen.
- **Quit kills every session**, as dispose does for the one today.

## Renderer

### Drawer

- A **tab strip**: each tab is the session's name and a state glyph; a `+` starts a new
  session. Opening the drawer with no sessions starts one, as today.
- **History opens `--resume` in a new tab** and kills nothing. Restart acts on its own
  tab only.
- **Closing a tab ends that session**, and asks first if it is working.
- **One xterm per tab, kept mounted, hidden when inactive.** The terminal uses xterm's
  DOM renderer (there is no WebGL addon), so there is no context limit to hit, and
  switching tabs keeps scroll position with no replay. The main-side mirror still
  replays after a renderer reload, per session.
- **The turn chip sits under each tab's terminal** and shows that session's latest
  turn, with "overlapped another session" beside the count when it did. The footer no
  longer carries it.
- **An exited session's tab stays** and shows the exit until closed, the way a deleted
  app leaves a tombstone: a tab that vanishes reads as a crash.

### Sidebar

- A **Sessions** section, one card per session, **shown even for a single session**,
  hidden when there are none (the Apps section's rule).
- A card is **name and state**. Working and needs-you are a glyph with coloured text and
  no tinted background; idle is plain.
- Clicking a card opens the drawer on that tab. The card menu is **Rename** and
  **End session**.

### Footer door

Reflects every session at once. **Needs-you outranks working**: with several sessions
running, the footer is how a waiting one gets noticed.

### Sending an ask

- `agentSeedPromptAtom` is replaced by **`sendToAgent({ text, target })`**, `target`
  being a session id or `'new'`. Reconcile keeps its submitted first turn through the
  existing `prompt` on start.
- The **"Ask agent" popover gains a target picker**: live sessions, then New session.
  It defaults to the drawer's active tab. Needs-you sessions are left out.
- Delivery to a live session is a bracketed paste into its PTY. Delivery to a new one
  spawns it and pastes after its `SessionStart` hook.
- A target that ended between picking and sending **refuses the send** with a message,
  and the text stays in the popover.
- Item 11's agent query uses the same targets later, as a second completion level the
  way `/table` asks for a size.

## Not decided here, deliberately

- **A cap on concurrent sessions.** Each is a real `claude` process; a limit would guess
  at a problem nobody has hit.
- **Splitting an overlapped turn's changes by session.** Git cannot say which session
  wrote a line, and a tool-level record misses edits made through `Bash`, which is why
  D88 chose the commit range in the first place.
- **Sessions as pane tabs**, side by side with notes. Considered, and the drawer was
  chosen. Nothing here prevents it later.

## Verify first, live and headless

Two answers only a real Claude Code (2.1.270) gives, checked in a scratch directory
before the code that depends on them:

1. **Does a bracketed paste written after `SessionStart` land in the input box?** The
   hook may fire before the TUI reads stdin. If it does, the paste needs a later
   signal.
2. **What does the `Notification` payload carry**, and is `notification_type`
   `permission_prompt` for a tool permission and something else for idle?

## Testing

- **Node:** two sessions with overlapping brackets pause the vault once and resume only
  after both end; `overlapped` and the session id are recorded; old turn records still
  read; the per-session cap releases one session without resuming under another; token
  → session in the hook server; spawns run in order; a vault switch ends every session.
  The single-session tests in `agent-manager.test.ts`, `agent-turn-record.test.ts`,
  `hook-server.test.ts` and `agent-notices.test.ts` are rewritten, not deleted.
- **DOM:** tabs and sidebar cards follow the session list; the picker omits needs-you
  sessions; the turn chip follows the session in its own tab; closing a working tab
  asks.

## Docs this changes

- `prd/agent.md`: §Runtime's one-live-session rule, the wire table, §Sync's single git
  actor (still true, now over a set), §Reviewing a turn, and the stale
  `.holi/turns.local.json` path (it is `.holi/state/turns.local.json`).
- `architecture.md`: line 115's single spawned `claude`, and line 121, which still says
  one config directory is shared by every vault.
- `glossary.md`: the agent session entry.
- `decisions.md`: D100.
