# Several agent sessions per vault, implementation plan

**Goal:** a vault runs any number of `claude` sessions at once, shown as drawer tabs
and sidebar cards, with an ask routed to whichever one you pick.

**Approach:** three slices, each shippable on its own. Slice 1 turns main's single
session into a registry, joins it to Claude Code's own session listing for name and
state, and gives the vault a turn coordinator. Slice 2 is the drawer's tab strip and
the sidebar's Sessions section. Slice 3 replaces the seed-prompt atom with
`sendToAgent` and gives the "Ask agent" popover a target picker.

**Design of record:** [`docs/specs/2026-09-14-agent-sessions-design.md`](../specs/2026-09-14-agent-sessions-design.md)
(D100). It carries the decisions, what is rejected, the failure cases and the live
measurements. This plan does not restate them.

**Stack:** Electron main (plain Node, no `electron` runtime import in `agent/`),
node-pty, tRPC-adjacent `agent-ipc.ts` seam, React 19 + Jotai + xterm 5 in the
renderer, Vitest 4 (`node` and `dom` projects).

---

## Ground rules for every task

- **Format only what you touch:** `pnpm exec prettier --write <paths>`. Never
  `pnpm format`. `decisions.md`, `architecture.md` and `prd/notes-editor.md` are not
  Prettier-clean and must not be reformatted.
- **Run the two Vitest projects one at a time**, never in parallel:
  `pnpm -C apps/desktop exec vitest run --project node` (~4 min), then `--project dom`.
- **A commit per task**, direct to `main`, reasoning in the message. Do not push.
- Main-side code in `src/main/agent/` must stay loadable under plain Node.

---

## Files

### Slice 1, main

| File                                            | Responsibility                                                                                                                                                                                                                                                        |
| ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/main/agent/session-registry.ts` **(new)**  | Read Claude Code's own session listing. Shells out to `claude agents --json` with `CLAUDE_CONFIG_DIR` set, parses the rows, and exposes `rowsByPid()`. Owns the `fs.watch` edge trigger on `<configDir>/sessions/`. Nothing else in the app knows the command exists. |
| `src/main/agent/turn-coordinator.ts` **(new)**  | The vault's working set. Sessions enter on turn start and leave on turn end, a confirmed registry `idle`, exit, or a per-session cap. Owns pause/resume, the settle commit, and `overlapped` marking.                                                                 |
| `src/main/agent/agent-manager.ts`               | Becomes a map of `Session`s. Spawns, kills, routes `write`/`resize`/`attach` by id, holds each session's pid, bearers, mirror, snapshot-free root, `configStale`. Delegates turn bookkeeping to the coordinator and state to the registry.                            |
| `src/main/agent/agent-runtime.ts`               | Add a `pid` getter. Add `name` to `buildAgentArgs`.                                                                                                                                                                                                                   |
| `src/main/agent/hook-server.ts`                 | `tokens` maps to `{ remote, sessionId? }`; turn callbacks take a session id; a standing vault token carries none and its turn signals are dropped.                                                                                                                    |
| `src/main/agent/turn-log.ts`                    | `TurnRecord` gains optional `sessionId` and `overlapped`.                                                                                                                                                                                                             |
| `src/main/agent-ipc.ts`, `src/preload/index.ts` | Every agent channel gains a session id; `agent:status` becomes `agent:sessions`.                                                                                                                                                                                      |
| `src/main/index.ts`                             | Wire the registry and coordinator; move `ContextSnapshot` from the session to the vault; kill every session on vault switch and on quit.                                                                                                                              |

### Slice 2, renderer

| File                                                             | Responsibility                                                                                                                                                                                    |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/renderer/src/state/agent.ts`                                | `agentSessionsAtom` (the pushed list), `activeSessionIdAtom`, `agentPanelOpenAtom`. `agentStatusAtom` and `agentModeAtSpawnAtom` go per session.                                                  |
| `src/renderer/src/features/agent/SessionTerminal.tsx` **(new)**  | One session's xterm: deferred build on first show, refit on show, filtered data/exit subscription, the key handler, the restart and history actions for its own tab. Extracted from `AgentPanel`. |
| `src/renderer/src/features/agent/AgentPanel.tsx`                 | The tab strip, the `+`, close-with-confirm, and N mounted `SessionTerminal`s with only the active one visible.                                                                                    |
| `src/renderer/src/features/agent/SessionsSection.tsx` **(new)**  | The sidebar's Sessions section, modelled on `features/apps/AppsSection.tsx`.                                                                                                                      |
| `src/renderer/src/components/Shell.tsx`                          | Mount `SessionsSection`; the footer door aggregates every session.                                                                                                                                |
| `src/renderer/src/lib/agent-notices.ts`                          | `agentIndicator` takes one session's state; a new `fleetIndicator` reduces the list for the footer.                                                                                               |
| `src/renderer/src/state/turns.ts`, `features/agent/TurnChip.tsx` | Latest turn per session; the chip moves under its own tab's terminal.                                                                                                                             |

### Slice 3, sending

| File                                                                                                                                 | Responsibility                                                  |
| ------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------- |
| `src/renderer/src/state/agent.ts`                                                                                                    | `sendToAgent({ text, target })` replaces `agentSeedPromptAtom`. |
| `src/renderer/src/editor/askAgent.ts`                                                                                                | The popover gains a target picker above its textarea.           |
| `src/renderer/src/composites/EditorPane.tsx`, `state/vaults.ts`, `features/tasks/TaskBodyEditor.tsx`, `features/google/MailView.tsx` | The four existing seed-prompt producers move to `sendToAgent`.  |

---

## Slice 1: main becomes a session registry

### Task 1.1: the session-state reader

**Files:** create `src/main/agent/session-registry.ts` · test
`apps/desktop/test/session-registry.test.ts`

**Behaviour:** given a config directory, `readRows()` resolves a map from pid to
`{ name, nameSource, status, waitingFor }`. A row whose `cwd` is not the vault root is
dropped. A missing binary, a non-zero exit, malformed JSON or a timeout all resolve to
an empty map rather than throwing.

**Contract:**

```ts
export interface SessionRow {
  pid: number
  name: string
  /** 'user' when someone named it (`--name`, `/name`); absent/'derived' is Claude
   *  Code's cwd placeholder, which is identical for every session in one vault. */
  nameSource?: string
  status: 'busy' | 'waiting' | 'idle' | 'shell'
  waitingFor?: string
}

export interface SessionRegistry {
  /** pid → row, for sessions whose cwd is `vaultRoot`. Never rejects. */
  readRows(args: { configDir: string; vaultRoot: string }): Promise<Map<number, SessionRow>>
  /** fs.watch on `<configDir>/sessions/`, debounced. Returns an unsubscribe. */
  watch(configDir: string, onChange: () => void): () => void
}
```

**Gotchas**

- The command is `claude agents --json` with `CLAUDE_CONFIG_DIR` in the child env and
  everything else inherited. Resolve the binary with the existing `resolveClaudeBin()`
  from `agent-runtime.ts`; do not re-implement the PATH search.
- **Cap it.** A 3 s timeout, `execFile` not `exec`, and a max buffer. This runs on a
  watcher edge and must never become the thing that blocks a turn.
- **Never read the JSON files.** Anthropic's documentation says they are not a stable
  interface. `sessions/` is the edge trigger only; the command is the reader.
- `fs.watch` on a directory that does not exist yet throws. A vault whose agent has
  never run has no `sessions/`; retry the watch lazily on the first spawn.
- Debounce the watch at ~150 ms: the rows carry heartbeat fields that move without any
  state change.

- [ ] Test: rows are filtered by `cwd`, and a foreign-cwd row is dropped
- [ ] Test: a non-zero exit, malformed JSON and a timeout each give an empty map
- [ ] Test: `CLAUDE_CONFIG_DIR` is set on the child, and the rest of the env is inherited
- [ ] Implement, injecting the exec function so the test never shells out
- [ ] Verify: `pnpm -C apps/desktop exec vitest run --project node session-registry`

### Task 1.2: `AgentRuntime` exposes its pid, and can be named

**Files:** modify `src/main/agent/agent-runtime.ts:219-221` (`buildAgentArgs`),
`:292-322` (`AgentRuntime`) · test `apps/desktop/test/agent-runtime.test.ts`

**Behaviour:** `runtime.pid` is the child's pid while running and `null` otherwise.
`buildAgentArgs({ name })` emits `--name <name>` before `--resume` and the prompt.

**Gotchas**

- The pid is the join key to the registry, so it must be read **after** `start()`
  returns and re-read as `null` on exit; the existing `onExit` already clears `this.pty`
  before emitting, so a getter over `this.pty?.pid` is correct without new state.
- A name with a newline would break the argv; trim and cap it (see Task 3.2).

- [ ] Test: `pid` is the spawned pid, and `null` after exit
- [ ] Test: `buildAgentArgs({ name: 'x', resume: true, prompt: 'p' })` ordering
- [ ] Verify: `pnpm -C apps/desktop exec vitest run --project node agent-runtime`

### Task 1.3: the hook server resolves a token to a session

**Files:** modify `src/main/agent/hook-server.ts:22-37` (deps), `:63-66` (the maps),
`:81-86` (lookup), `:104-111` (turn dispatch), `:134-154` (mint/revoke) · test
`apps/desktop/test/hook-server.test.ts:83, 109-125`

**Behaviour:** `mintSessionToken(remote, sessionId)` records both. `onTurnStart` and
`onTurnEnd` receive the session id. A turn signal arriving on a vault's **standing**
token (the one written into `.git/hooks`) resolves to a vault with no session and is
dropped rather than applied to an arbitrary one. Ops routes keep resolving by vault.

**Contract:**

```ts
onTurnStart(sessionId: string): void
onTurnEnd(sessionId: string): void
mintSessionToken(remote: string, sessionId: string): string
```

**Gotchas**

- `revoke()` currently protects the standing token by comparing
  `vaultTokens.get(tokens.get(token))`. Keep that guard working when the map's value
  becomes an object.

- [ ] Test: a turn on a session token calls back with that session's id
- [ ] Test: a turn on a standing vault token calls back with nothing
- [ ] Test: ops still resolve by remote on both token kinds
- [ ] Verify: `pnpm -C apps/desktop exec vitest run --project node hook-server`

### Task 1.4: the turn coordinator

**Files:** create `src/main/agent/turn-coordinator.ts` · modify
`src/main/agent/turn-log.ts:29-57` · test `apps/desktop/test/turn-coordinator.test.ts`,
`apps/desktop/test/turn-log.test.ts`

**Behaviour:** the vault pauses once when the working set goes from empty to non-empty
and resumes once when it empties. Every turn that ended inside that window shares the
one settle commit. A turn whose span crossed another session's turn records
`overlapped: true`. A record without `sessionId`/`overlapped` still reads.

**Contract:**

```ts
export interface TurnCoordinator {
  begin(sessionId: string): void
  end(sessionId: string): void
  /** The registry says this session is idle. Treated as `end` once confirmed. */
  noteIdle(sessionId: string): void
  /** A session died; it leaves the set at once. */
  forget(sessionId: string): void
  readonly working: ReadonlySet<string>
}
```

`TurnRecord` gains `sessionId?: string` and `overlapped?: boolean`; `isRecord` must not
start requiring them.

**Gotchas**

- **Order on resume is load-bearing.** `commitAll` refuses to run while the vault reads
  as paused, so resume happens before the settle commit, exactly as
  `agent-manager.ts:259-266` does today. Do not reorder it.
- `vault.repo.head()` is async and `begin` is not, so keep the existing
  `turnBasePending` trick per session rather than awaiting in the hook path.
- The turn hook must return immediately with an empty body: a body is injected into
  Claude's context. Everything here is fire-and-forget with rejections swallowed.
- **The idle release needs confirmation, not a single read.** Require the registry to
  report `idle` on two consecutive reads (or once ~1 s after the previous read) before
  treating it as an end. Measured: `status` is `busy` throughout tool execution and
  `waiting` during a prompt, so `idle` really does mean no turn, but a confirmation
  window costs nothing and removes the whole class of flap.
- The per-session cap stays at 600 s and is now a backstop: `Stop` or a confirmed idle
  should always beat it.

- [ ] Test: two overlapping turns pause once and resume only after both end
- [ ] Test: both records carry the same `end` sha and `overlapped: true`
- [ ] Test: two sequential turns are not marked overlapped
- [ ] Test: a session released by the cap does not resume the vault under another
- [ ] Test: a confirmed registry `idle` releases a session whose `Stop` never arrived
- [ ] Test: a record with neither field reads as no session and not overlapped
- [ ] Verify: `pnpm -C apps/desktop exec vitest run --project node turn-coordinator turn-log`

### Task 1.5: `AgentManager` becomes a map

**Files:** modify `src/main/agent/agent-manager.ts` throughout · test
`apps/desktop/test/agent-manager.test.ts`, `apps/desktop/test/agent-turn-record.test.ts`

**Behaviour:** `start` adds a session instead of tearing down. `write`, `resize`,
`kill`, `attach` take a session id. `sessions()` returns the joined list, registry state
first and the hook bracket as the floor. Pushed events carry a session id.

**Contract:**

```ts
export type SessionState = 'needs-you' | 'working' | 'idle'

export interface SessionSummary {
  id: string
  /** The registry's name when someone set one, else 'New session'. */
  name: string
  state: SessionState
  /** Present only for 'needs-you': the registry's reason, e.g. 'permission prompt'. */
  waitingFor?: string
  configStale: boolean
  exited: boolean
}

start(args: { vaultId; name?; resume?; cols?; rows?; prompt? }): Promise<{ ok: true; id: string }>
write(id: string, data: string): void
resize(id: string, cols: number, rows: number): void
kill(id: string): Promise<{ ok: true }>
attach(id: string): Promise<string>
sessions(): SessionSummary[]
```

**Derivation, in this order:** `waitingFor` present → `needs-you`; registry `busy` or
the hook bracket open → `working`; else `idle`. The hook bracket is the floor so a
missing or failing `claude agents --json` still reports working.

**Gotchas**

- **Spawns must be serialised.** `ensureAgentConfigDir` does an unlocked
  read-modify-write of `settings.json` (`agent-config-dir.ts:143-146`) and
  `takeFirstSpawn` is stat-then-write (`:172-177`). Two concurrent spawns race both and
  print the sign-in notice twice. One promise chain around the whole of `start`.
- `attached` becomes per session. The mirror is the record and the renderer is a view;
  keep that.
- `configBaseline` and `configStale` are per session and `notifyVaultChanged` must
  re-fingerprint each live session against its own `root`, which is already what
  `:462` does for the one.
- The `SIGN_IN_NOTICE` is written into the mirror before the PTY writes a byte. With
  serialised spawns only the first session in a fresh config dir sees it, which is
  correct.
- Push `agent:sessions` only when the derived list actually changes; the registry rows
  move on heartbeats.

- [ ] Test: two sessions run at once and `kill` ends only the named one
- [ ] Test: `write`/`resize` reach only the named session's runtime
- [ ] Test: data and exit events carry the session id
- [ ] Test: `sessions()` takes the name from a `nameSource: 'user'` row and shows
      'New session' for a derived one
- [ ] Test: a `waiting` row outranks an open hook bracket
- [ ] Test: with the registry returning nothing, an open bracket still reports working
- [ ] Test: two concurrent `start` calls do not overlap inside `resolveConfigDir`
- [ ] Verify: `pnpm -C apps/desktop exec vitest run --project node agent-manager agent-turn-record`

### Task 1.6: the wire, the focus writer, and the vault switch

**Files:** modify `src/main/agent-ipc.ts`, `src/preload/index.ts:49-54, 109-122`,
`src/main/index.ts:275, 379, 500-501, 581-592, 740` · modify
`src/main/agent/context-snapshot.ts` construction site · test
`apps/desktop/test/context-snapshot.test.ts`

**Behaviour:** every agent channel carries a session id; `agent:status` becomes
`agent:sessions`. One `ContextSnapshot` per vault rather than per session. Opening a
different vault kills every session first.

**Gotchas**

- **Run the full desktop suite after touching preload.** `typecheck` does not cover the
  fake preload in tests (`installFakeHoli` is not typed against `window.holi`), so a
  gap there only shows up at runtime.
- `index.ts:379`'s comment says "one live claude per user"; the PRD says per vault, and
  after this it is several per vault. Fix the comment.
- The focus writer moves to the vault, so `setFocus` no longer needs a session. Its
  no-op-before-a-session behaviour becomes no-op-before-a-vault.
- The vault switch goes through `VaultHost.open()`, which closes the current vault
  first. Kill the sessions **before** that, while their vault is still the active one,
  or the coordinator's resume lands on the wrong vault, which is the bug this removes.

- [ ] Test: the snapshot writes once per vault however many sessions are running
- [ ] Verify: `pnpm -C apps/desktop exec vitest run --project node` (whole project)
- [ ] Verify: `pnpm typecheck && pnpm --filter @holi/desktop build`

---

## Slice 2: tabs and cards

### Task 2.1: extract `SessionTerminal`

**Files:** create `src/renderer/src/features/agent/SessionTerminal.tsx` · modify
`src/renderer/src/features/agent/AgentPanel.tsx`

**Behaviour:** one component owns one session's xterm. It builds on its **first show**,
refits on every show, subscribes to data and exit filtered by its own session id, and
carries its own restart and history actions.

**Gotchas, all of them already learned in `AgentPanel`**

- `term.open()` against a `display:none` host leaves xterm unmeasured and every later
  write silently fails to paint (`AgentPanel.tsx:103-114`). Build on first show, never
  on mount.
- A hidden host measures 0×0 and `FitAddon` clamps that to 2×1 rather than bailing, so
  it would SIGWINCH the PTY into a two-column sliver. Keep the `MIN_FITTABLE_PX` guard
  (`:29-33`) and refit on becoming visible.
- Hide with `hidden`/`display:none` on the tab's own wrapper, keeping the component
  mounted, so scrollback and scroll position survive a tab switch with no replay.
- Keep `HIDE_CURSOR` and `DISABLE_FOCUS_REPORTING`, and the `attachCustomKeyEventHandler`
  `preventDefault()` (`:137-169`), verbatim. They are each fixing a real bug.
- `attach()` is per session and opens the data tap for that session only.

- [ ] Verify by hand later in Task 2.4; no new test here, the extraction is covered by
      the existing panel tests once they are rewritten

### Task 2.2: the tab strip

**Files:** modify `src/renderer/src/features/agent/AgentPanel.tsx`,
`src/renderer/src/state/agent.ts` · test
`src/renderer/src/features/agent/__tests__/AgentPanel.test.tsx` **(new)**

**Behaviour:** one tab per session showing its name and a state glyph, a `+` that starts
one, and a close that ends that session and asks first if it is working. Opening the
drawer with no sessions starts one; closing the last tab does not immediately start
another. An exited session's tab stays until closed.

**Gotchas**

- The drawer-open auto-start (`AgentPanel.tsx:248-277`) must be keyed to the drawer
  **opening**, not to "the list is empty while open", or closing the last tab respawns
  instantly.
- A session spawned for a tab that has never been shown has no geometry; spawn it at the
  visible tab's `cols`/`rows`.
- **No tinted chip on its own hue.** Working and needs-you are a glyph plus coloured
  text, never coloured text on a tinted background of the same colour.

- [ ] Test: tabs follow the pushed session list
- [ ] Test: closing a working tab asks first
- [ ] Test: an exited session keeps its tab and shows the exit
- [ ] Verify: `pnpm -C apps/desktop exec vitest run --project dom AgentPanel`

### Task 2.3: the Sessions section and the footer

**Files:** create `src/renderer/src/features/agent/SessionsSection.tsx` · modify
`src/renderer/src/components/Shell.tsx:206-218, 531`,
`src/renderer/src/lib/agent-notices.ts` · test
`src/renderer/src/features/agent/__tests__/SessionsSection.test.tsx` **(new)**,
`apps/desktop/test/agent-notices.test.ts`

**Behaviour:** a Sessions section in the sidebar, one card per session, shown even for a
single session and hidden when there are none. A card is name and state; clicking one
opens the drawer on that tab; the menu is End session. The footer door reflects every
session, needs-you outranking working.

**Contract:**

```ts
/** One session, for a tab or a card. */
export function agentIndicator(args: {
  state: SessionState
  waitingFor?: string
  configStale: boolean
  themeNote: string | null
}): AgentIndicator

/** Every session, for the footer door. Needs-you outranks working outranks idle. */
export function fleetIndicator(sessions: SessionSummary[]): AgentIndicator
```

**Gotchas**

- Follow `features/apps/AppsSection.tsx` for the hidden-when-empty rule and the
  tree-row metrics; a section that styles itself as chips reads as a fourth chip row.
- There is **no Rename**. The name is Claude Code's, set with `--name` at spawn or
  `/name` in the session.
- Use the shared semantic tokens. The renderer ESLint gate rejects arbitrary colour
  literals and native `title=` tooltips.

- [ ] Test: hidden with no sessions, shown with one
- [ ] Test: a card shows the registry name, or 'New session' for a derived one
- [ ] Test: `fleetIndicator` puts needs-you above working
- [ ] Verify: `pnpm -C apps/desktop exec vitest run --project dom SessionsSection agent-notices`

### Task 2.4: the turn chip moves under its tab

**Files:** modify `src/renderer/src/state/turns.ts:55-58, 112`,
`src/renderer/src/features/agent/TurnChip.tsx:61-68`,
`src/renderer/src/features/agent/SessionTerminal.tsx` · test
`src/renderer/src/state/__tests__/turns.test.tsx`,
`src/renderer/src/features/agent/__tests__/TurnChip.test.tsx`

**Behaviour:** `latestTurnAtom` becomes per session. The chip renders under its own
tab's terminal and says "overlapped another session" beside the count when the record
says so. The footer no longer carries it. The vault-switch reset stays.

- [ ] Test: each tab's chip shows its own session's latest turn
- [ ] Test: an `overlapped` record says so; an old record without the field does not
- [ ] Verify: `pnpm -C apps/desktop exec vitest run --project dom turns TurnChip TurnReview`

---

## Slice 3: sending an ask

### Task 3.1: `sendToAgent`

**Files:** modify `src/renderer/src/state/agent.ts` and the four producers:
`state/vaults.ts:258-261`, `composites/EditorPane.tsx:98-106, 193`,
`features/tasks/TaskBodyEditor.tsx:77`, `features/google/MailView.tsx:265`

**Behaviour:** `sendToAgent({ text, target })` replaces `agentSeedPromptAtom`. A live
target gets a bracketed paste with **no Enter** and the drawer focuses that tab. `'new'`
spawns a session and pastes once its `SessionStart` hook has fired. A target that ended
between picking and sending refuses the send with a message and leaves the text where
it was.

**Contract:**

```ts
type AgentTarget = string | 'new'
sendToAgent(args: { text: string; target: AgentTarget }): Promise<{ ok: boolean; message?: string }>
```

**Gotchas**

- The paste is `\x1b[200~` + text + `\x1b[201~` and nothing else. Measured: it lands in
  the composer whether the session is idle or mid-turn, and survives a permission prompt
  appearing over it.
- **Reconcile is the exception** and keeps its submitted first turn through the existing
  `prompt` on `start`. It is the only submitted send; do not fold it into the paste path.
- All four producers open the drawer already; keep that and add the focus of the target
  tab.

- [ ] Test: a live target receives exactly one bracketed paste with no `\r`
- [ ] Test: `'new'` spawns, waits for ready, then pastes
- [ ] Test: a dead target refuses and returns a message
- [ ] Verify: `pnpm -C apps/desktop exec vitest run --project dom sendToAgent`

### Task 3.2: the target picker

**Files:** modify `src/renderer/src/editor/askAgent.ts:102-254` (the popover),
`src/main/agent/agent-manager.ts` (`--name` at spawn) · test
`src/renderer/src/editor/__tests__/askAgent.test.tsx`

**Behaviour:** the popover gains a target list above its textarea: live sessions, then
New session, defaulting to the drawer's active tab. A session whose state is needs-you
is left out. A new session spawned for an ask is spawned with `--name` taken from the
ask's first line, so its tab is named from the moment it exists.

**Gotchas**

- The name is argv: take the first line, trim it, collapse whitespace, cap it at ~60
  characters, and drop it entirely if what is left is empty.
- The popover currently has no control but the textarea, deliberately
  (`askAgent.ts:78-81`). The picker is the second thing in it, so it has to earn its
  place: a compact row, not a second field. `⌘↵ to send` stays the only instruction.
- Nothing in that file may collapse the selection by accident; `preventDefault` on
  `mousedown` is what keeps the highlight (`:89-93`).
- The tooltip is rebuilt on every selection change, so the picker's state cannot live
  outside it.

- [ ] Test: needs-you sessions are absent from the list
- [ ] Test: the default target is the drawer's active tab
- [ ] Test: the name derived from a multi-line ask is the first line, capped
- [ ] Verify: `pnpm -C apps/desktop exec vitest run --project dom askAgent`

### Task 3.3: the documentation

**Files:** modify `docs/prd/agent.md:76-84, 88, 237, 247`, `docs/architecture.md:115`
and its Config layering bullet, `docs/glossary.md:72`, `docs/decisions.md` (D100)

**Behaviour:** the living docs describe several sessions per vault. Specifically:
§Runtime's one-live-session rule goes; the wire table gains session ids; §Sync's single
git actor is still true but now over a set; §Reviewing a turn mentions overlap; the
stale `.holi/turns.local.json` path becomes `.holi/state/turns.local.json`;
`architecture.md`'s Config layering stops saying `userData/agent-config/` is shared by
every vault, which D86 already made false and which this design depends on.

- [ ] Verify: `pnpm exec prettier --check docs/prd/agent.md docs/glossary.md`
      (leave `architecture.md` and `decisions.md` unformatted)

---

## End-to-end verification

Gates, in this order, all from the repository root:

```sh
pnpm -C packages/shared test                          # 552
pnpm -C apps/desktop exec vitest run --project node   # ~4 min, do not parallelise
pnpm -C apps/desktop exec vitest run --project dom
pnpm typecheck
pnpm lint                                             # 0 errors (4 pre-existing warnings)
pnpm --filter @holi/desktop build
```

Then in the live app, against a **scratch vault**, never a real one:

1. Open the drawer. One tab starts. Ask it something long; the tab glyph goes to
   working and the sidebar card agrees.
2. Press `+`. A second tab starts and the first keeps running. Both cards are listed.
3. Get the second session to ask for a permission it does not have. Within a second its
   tab and card read needs-you with the reason, and the footer door shows needs-you even
   while the first is still working.
4. Answer it. Both settle. `git log` in the clone shows **one** settle commit covering
   both turns, and each turn's chip says it overlapped another session.
5. Select a passage in a note, press Ask agent, pick the first session, send. The text
   appears in that session's composer **unsent**, and the drawer focuses that tab.
6. Send another ask to New session. A third tab appears already named after the ask.
7. Escape a permission prompt in one session. It leaves the working set within a second
   or two, without waiting out the safety cap, and the vault resumes syncing.
8. Switch vaults with a session working. Holi asks first; on confirm every session ends
   and the new vault opens clean.

A renderer change needs the app restarting, which is yours to do. Read-only CDP and
screenshots against the running app; never dispatch synthetic input into it.
