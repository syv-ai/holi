# A vault runs several agent sessions

**Date** 2026-09-14, revised 2026-09-19 · **Decision** D100 · **Status** agreed, not built

> We need to be able to support multiple sessions. From the slash command, the
> user needs to be able to choose between each active session or a new session,
> where to send the request.

This came out of `docs/upcoming.md` item 11 (per-vault slash commands, D81). D81's
first open question asked whether an inline agent query is the command's own call or
the drawer's seeded prompt, and the answer was neither: an ask goes to a session the
user picks, live or new. That needs more than one session, so item 11 waits on this
for its agent query and the rest of item 11 is unaffected.

**The 2026-09-19 revision is one finding and its consequences:** Claude Code already
publishes the session state this design was going to derive from hooks, through a
documented command. Everything about what a session _is_ survived. Most of what main
was going to _maintain_ did not. The measurements are in §Verified live.

## What is there today

`prd/agent.md` §Runtime: **"One live session per vault. Starting a new one kills the
prior child."** The code agrees everywhere:

- `main/agent/agent-manager.ts` holds one `session`, and beside it one `working`,
  one `turnBase`, one `safetyTimer`, one `configStale`. `start` tears down first.
  `write`, `resize`, `kill`, `attach` carry no id; neither do the pushed events
  `agent-pty:data`, `agent-pty:exit`, `agent:status`.
- `main/agent/hook-server.ts` maps a token to a **vault**. The turn hooks post no
  body, and `onTurnStart`/`onTurnEnd` take no arguments.
- `main/vault/active-vault.ts` pauses on one `manualPause` string, not a count. The
  manager is its only caller in main, so the pause needs no refcount against anyone
  else.
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

**And Claude Code already tracks every live session on the machine**, including the
ones Holi spawns: a row per session under `$CLAUDE_CONFIG_DIR/sessions/`, read out by
`claude agents --json`. Because D86 gave each vault its own config directory, that
listing is already scoped to one vault. See §Verified live for what it carries.

## What is wanted

Three uses, all inside one vault:

- **Parallel work.** Two sessions working at the same moment on different things.
- **Parked conversations.** Several kept alive to switch between.
- **Fire-and-forget asks.** A selection (and later a slash command) sent to a session
  without ending the one you are talking to.

**Nothing crosses vaults.**

## Decisions

### State is Claude Code's, and Holi reads it

Whether a session is working, waiting for you, or idle, and what it is called, are
facts Claude Code maintains and publishes. Holi asks; it does not derive.

```
CLAUDE_CONFIG_DIR=<the vault's config dir> claude agents --json
[{ pid, cwd, kind, startedAt, sessionId, name, status, waitingFor?, state? }]
```

`status` is `busy | waiting | idle | shell`. `waitingFor` is `permission prompt |
input needed | sandbox request`. That is working, needs-you and idle, exactly the three
states a tab and a card show, with no hook and no latency.

**The command, never the files.** Anthropic's own documentation says the files behind
this are not a stable interface and that `claude agents --json` is. So the directory is
used as an **edge trigger only**: `fs.watch` on `sessions/` says _something moved_, and
the command says _what_. Holi never parses a format it was told not to depend on.

Rejected: a `Notification` hook keyed on `notification_type: permission_prompt`, which
was this spec's first answer. It is real and its matcher works, but it fires **six
seconds** after the prompt appears and not at all if you answer inside six seconds
(measured; the delay is a constant in the CLI). Also rejected: a `PermissionRequest`
hook, which does fire at the instant of the prompt and only on the ask path. Both are
Holi rebuilding a fact it can read.

**Names come from the same place, with one thing Holi has to know itself.** Holi passes
`-n, --name` at spawn when it has something to call the session, and `/name` inside the
session does the same job. A session spawned with no name carries a cwd-derived
placeholder, which is the same string for every session in one vault and so is not a
label.

The listing does not say which of the two a name is. The underlying file carries
`nameSource`; the supported command does not (verified, 2.1.278). So Holi answers it
from what it already knows rather than from the file: **a name is real if Holi passed
`--name` at spawn, or if the row's name has changed since the first read after that
spawn** (which is what a `/name` looks like from outside). Otherwise the tab says
**"New session"**.

There is no Rename in Holi: the name is Claude Code's, set at spawn or with `/name`.

**2026-09-20, two corrections to the paragraphs above**, from Claude Code's own docs and
a listing read out of a real vault. This is a dated record, so the prose above stands as
what was believed; these are what is true.

1. **The slash command is `/rename`, not `/name`.** Also `Ctrl+R` in the session picker.
2. **The placeholder is not one string per vault.** An unnamed session gets a *default
   display name* — the working directory's name plus a two-character suffix, `privat-d9`
   — which is unique per session. The inference above is unaffected (a name that has
   changed since the first sighting is still a real one), but the reason for hiding it is
   not that it collides: it is that it describes nothing, and Claude Code does not accept
   it as a resume handle either. A third source of a real name turns up in the same
   place: **accepting a plan** gives the session a generated title, and that one *does*
   replace the default in `claude agents --json`.
3. **Claude Code already names sessions with a small model.** An unnamed session gets a
   generated title summarising its first prompt, "written by a background request to the
   small/fast model, normally a Haiku-class model". It reaches the session picker and the
   statusline's `session_name` field, but *not* the listing this design reads, which is
   why D101 takes it from the statusline instead.

### A session is a terminal, and the join key is its pid

Main keys a session by an id Holi mints for its own wire, and joins it to the registry
row on **pid**, which node-pty hands back at spawn and which is stable for the life of
the terminal.

Rejected: keying on the registry's `sessionId`. Claude Code's id changes inside one
terminal on `/clear` and on a `--resume` picked inside it, so it would move while the
tab the user sees stays put. The pid does not, and the tab is the thing with an
identity on screen. `sessionId` is allowed to drift underneath; nothing keys on it.

### The turn hooks stay, and they are the only hooks this adds to

The sync pause has a deadline the registry cannot meet: it has to land **before** the
agent's first write, or Holi's committer and the agent contend on `.git/index.lock`.
A hook is synchronous and blocks the turn until it returns; a watch is after the fact.

So `UserPromptSubmit` to pause and `Stop` to resume are unchanged, and so is the commit
range they bracket (D88). What each gains is a session: the hook token identifies which.

**The registry closes the interrupt hole they have always had.** `Stop` is not
guaranteed: escaping a permission prompt ends the turn with no `Stop` at all (measured,
and the existing code already says so). Today a 10-minute safety cap is the only thing
that ever releases that turn. Now a session whose registry status reads `idle` while
Holi still has it in the working set has demonstrably finished, so the coordinator
releases it there and the cap goes back to being a backstop.

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
`claude --resume`. If any session is working, the switch asks first.

This is not only a way of avoiding the cross-vault bugs above, it is the only honest
answer available: `VaultHost` holds exactly one `ActiveVault` and `open()` closes the
current one first, so a session left running in vault A has no repo, no watcher and no
sync loop behind it. Keying three more paths to the session's vault would not fix that;
it would mean keeping a second `ActiveVault` alive.

**The cost, stated:** today a session does survive a switch, badly. After this you
cannot leave a long task running in vault A and go and work in vault B.

### An ask is pasted, never submitted

Text sent to a session, live **or new**, lands in its input box as a bracketed paste
with no Enter, and the drawer focuses that tab. One rule everywhere, and it cannot
append a submit to a half-typed draft.

A session whose status is `waiting` is **not offered** as a target: it is blocked on a
dialog, so the text would sit unread behind it at best.

**Reconcile is the exception and stays as it is:** a new session with the merge
instruction submitted as turn one.

## Main process

- **`AgentManager` becomes a registry** of `Session`s. Each owns its runtime, mirror,
  hook token, bearer, pid, `configStale`, safety timer, turn base, and `working` (a turn
  is open, from the hook bracket). It does **not** own a name or a needs-you flag; those
  are read. `start` no longer tears down. `write`, `resize`, `kill`, `attach` take a
  session id, and every pushed event carries one.
- **A session-state reader** joins Holi's sessions to `claude agents --json` on pid and
  pushes the result as `agent:sessions`, a list of
  `{ id, name, state, configStale, exited }` where `state` is
  `needs-you | working | idle` derived `waitingFor`-first, then `busy`, then the hook
  bracket, else idle.
  - Triggered by `fs.watch` on `<configDir>/sessions/` (debounced), by every turn hook,
    and on drawer open. No timer poll.
  - Pushed only when the joined list actually changes; the rows carry heartbeats.
  - **It degrades honestly.** If the command is missing, slow or fails, a session still
    reports `working` from the hook bracket and simply never reports needs-you. The
    turn bracket is the floor, the registry is the enrichment.
- **The hook server resolves token → session**, so `onTurnStart`/`onTurnEnd` name one.
  A vault's _standing_ token (the one in `.git/hooks`) maps to a vault and no session,
  and a turn signal arriving on it is ignored rather than applied to an arbitrary one.
- **A vault turn coordinator** owns the working set for the active vault.
  - The set going from empty to non-empty pauses sync; emptying resumes it. There is
    still **one git actor**: while any session works, nothing commits or pulls.
  - The settle commit is taken when the set empties, so every turn that ended inside
    that window shares one end commit.
  - Each turn records its session id, and `overlapped: true` when its span crossed
    another session's turn. Records without these fields (every existing one) read as
    no session and not overlapped.
  - A session leaves the set on `Stop`, on a confirmed `idle` from the registry, on
    exit, or on the per-session safety cap, whichever comes first. The cap is per
    session so one stuck session cannot hold the vault paused for another.
- **Spawns are serialised** through a queue. `ensureAgentConfigDir` rewrites the config
  directory's `settings.json` without a lock and `takeFirstSpawn` is check-then-write,
  so two spawns at once would race both, and print the sign-in notice twice.
- **One focus writer per vault, not per session.** `ContextSnapshot` is constructed per
  session today; N sessions in one vault would be N debounced writers rewriting one
  identical file. It moves up to the vault, which is what "the focus file stays one per
  vault" (`.holi/state/context.local.json`) already implied.
- **Quit kills every session**, as dispose does for the one today.

**No new hook and no new hook script.** `settingsWithRequired` is untouched by this
work, which also means nothing here has to reach vaults seeded before it.

## Renderer

### Drawer

- A **tab strip**: each tab is the session's name and a state glyph; a `+` starts a new
  session. Opening the drawer with no sessions starts one, as today, and closing the
  last tab does not immediately start another.
- **History opens `--resume` in a new tab** and kills nothing. Restart acts on its own
  tab only.
- **Closing a tab ends that session**, and asks first if it is working.
- **One xterm per tab, built on that tab's first show and then kept mounted**, hidden
  when inactive. Deferred, not eager: `term.open()` against a `display:none` host leaves
  xterm unmeasured and everything written afterwards silently fails to paint, and a
  hidden host measures 0×0, which `FitAddon` clamps to 2×1 and SIGWINCHes the PTY into a
  sliver (`AgentPanel.tsx:29-33, 103-114`). Refit on every show before streaming. Main's
  per-session mirror is what makes deferring safe. The terminal uses xterm's DOM
  renderer (there is no WebGL addon), so there is no context limit to hit, and switching
  tabs keeps scroll position with no replay.
- A session spawned for a tab that has never been shown takes the **visible tab's**
  geometry, since it has none of its own.
- **The turn chip sits under each tab's terminal** and shows that session's latest
  turn, with "overlapped another session" beside the count when it did. The footer no
  longer carries it.
- **An exited session's tab stays** and shows the exit until closed, the way a deleted
  app leaves a tombstone: a tab that vanishes reads as a crash.

### Sidebar

- A **Sessions** section, one card per session, **shown even for a single session**,
  hidden when there are none (the Apps section's rule).
- A card is **name and state**. Working and needs-you are a glyph with coloured text and
  no tinted background; idle is plain. Needs-you may say what it is waiting for, since
  the registry gives the reason.
- Clicking a card opens the drawer on that tab. The card menu is **End session**.

### Footer door

Reflects every session at once. **Needs-you outranks working**: with several sessions
running, the footer is how a waiting one gets noticed.

### Sending an ask

- `agentSeedPromptAtom` is replaced by **`sendToAgent({ text, target })`**, `target`
  being a session id or `'new'`. Reconcile keeps its submitted first turn through the
  existing `prompt` on start.
- A **new** session spawned for an ask is spawned with `--name` taken from the ask's
  first line, so its tab is named from the moment it exists.
- The **"Ask agent" popover gains a target picker**: live sessions, then New session.
  It defaults to the drawer's active tab. Sessions whose state is needs-you are left out.
- Delivery to a live session is a bracketed paste into its PTY, which works whether the
  session is idle or mid-turn (measured). Delivery to a new one spawns it and pastes
  once its `SessionStart` hook has fired, which is also measured as sufficient.
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
- **Adopting sessions Holi did not spawn.** The registry would list a session started
  from inside Claude Code's own agent view, but it has no `$HOLI_HOOK_PORT`, so its
  turns are invisible to the sync pause. Showing it would be showing a second git actor
  Holi cannot coordinate with. The same gap already exists for a bare `claude` in a
  terminal and is accepted there as the exception it is.
- **Speaking Claude Code's peer socket** (`messagingSocketPath` plus a per-session
  token) instead of pasting into a PTY. It is how sessions message each other natively,
  and it is undocumented framing. A paste is the documented surface.
- **Sessions as pane tabs**, side by side with notes. Considered, and the drawer was
  chosen. Nothing here prevents it later.

## Verified live

Against real Claude Code **2.1.278**, headless, in a throwaway directory, 2026-09-19.

**The session registry.** `claude agents --json` prints active sessions, interactive and
background, needs no TTY, takes ~0.2 s, and respects `CLAUDE_CONFIG_DIR`. Driving one
session through a permission prompt:

```
 0.77s  status=idle
 3.13s  status=busy                                       0.1 s after the prompt was submitted
 5.45s  status=waiting  waitingFor="permission prompt"     at the instant the prompt appeared
28.13s  status=busy                                       0.04 s after it was answered
30.54s  status=idle
```

`claude --name "Fix the broken CSV import"` reached the row as
`nameSource: "user"` within 0.7 s. A row for a killed process lingers on disk, so
liveness is pid-based, which the command already does.

**Bracketed paste.** `SessionStart` fired 0.94 s after spawn, and a paste written at
that instant sat unsent in the composer. A paste written mid-turn also landed and
survived a permission prompt appearing over it.

**Turn hooks.** `UserPromptSubmit` carries `prompt` and `source`
(`user | sdk | system | loop_wakeup | ...`). Escaping a permission prompt produced **no
`Stop` hook** in the following 166 s, which is the interrupt hole the registry now
closes.

**The rejected signals, for the record.** `Notification` carries
`{message, title?, notification_type}`, its matcher does filter on `notification_type`,
and `permission_prompt` fires on a 6000 ms timer that is cancelled if the prompt is
answered first. `PermissionRequest` fires immediately and only on the ask path: a turn
running `Read`, `ToolSearch` and `Bash` without prompting produced three `PostToolUse`
calls and no `PermissionRequest`.

## Testing

- **Node:** two sessions with overlapping brackets pause the vault once and resume only
  after both end; `overlapped` and the session id are recorded; old turn records still
  read; the per-session cap releases one session without resuming under another; a
  registry `idle` releases a session whose `Stop` never arrived; token → session in the
  hook server, and a standing vault token moves nothing; the state reader joins on pid,
  drops rows it did not spawn, and falls back to the hook bracket when the command
  fails; spawns run in order; a vault switch ends every session.
  The single-session tests in `agent-manager.test.ts`, `agent-turn-record.test.ts`,
  `hook-server.test.ts` and `agent-notices.test.ts` are rewritten, not deleted.
- **DOM:** tabs and sidebar cards follow the session list; a derived name shows as
  "New session"; the picker omits needs-you sessions; the turn chip follows the session
  in its own tab; closing a working tab asks.

## Docs this changes

- `prd/agent.md`: §Runtime's one-live-session rule, the wire table, §Sync's single git
  actor (still true, now over a set), §Reviewing a turn, and the stale
  `.holi/turns.local.json` path (it is `.holi/state/turns.local.json`).
- `architecture.md`: line 115's single spawned `claude`, and the Config layering bullet
  that still says `userData/agent-config/` is "shared by every vault", which D86 already
  made false and which this design now depends on being per vault.
- `glossary.md`: the agent session entry.
- `decisions.md`: D100.
