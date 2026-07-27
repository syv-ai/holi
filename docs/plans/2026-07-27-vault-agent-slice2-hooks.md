# Vault agent — Slice 2 (git coexistence, hook-driven) Implementation Plan

> **For agentic workers:** Use the executing-plans skill to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** While the agent is mid-turn, Holi suspends its own sync loop so the two git actors never contend on `.git/index.lock`, resuming when the turn ends — and the working/idle signal comes from **Claude Code's own hooks**, not from parsing PTY output.

**Architecture:** A tiny localhost HTTP server in the main process (`hook-server.ts`) listens on an ephemeral `127.0.0.1` port. The seeded `.claude/settings.json` wires two `curl` hooks — `UserPromptSubmit` → `POST /turn/start`, `Stop` → `POST /turn/end` — guarded so they no-op outside Holi. Each POST toggles `AgentManager.setTurnActive(...)`, which drives the active vault's existing `pause('…')`/`resume()` and the drawer's amber `working` dot. This **replaces** the reverted PTY-activity detector (commit `e89805a`, reverted in `060a723`) — see the [[holi-no-custom-cc-state-monitoring]] rule and `~/repos/syv/dash` (the reference: main-process HTTP server + `curl` hooks + `$DASH_HOOK_PORT` env guard).

**Tech Stack:** Electron main, Node `http` + `crypto` (stdlib, no deps), the vault sync engine (`active-vault.ts` `pause`/`resume`), `node-pty` env injection, Vitest 4 (node env). Live behaviour is CDP/manual per repo norm.

---

## Design decisions (settled, do not re-litigate)

- **Hooks, never PTY parsing.** [[holi-no-custom-cc-state-monitoring]]: inferring turn state from `runtime.onData` is a rabbit hole (it left the dot stuck on "working"). Claude Code's `UserPromptSubmit`/`Stop` bracket a turn deterministically. A probe confirmed the idle TUI *does* go quiet, but "quiet == contract" is exactly the fragile assumption we are dropping.
- **Localhost HTTP transport (mirror dash), a scoped exception to D60.** D60 removed the *MCP* endpoint + bearer; this is a one-bit turn signal, not an agent surface. Nicolai chose HTTP over a marker file to mirror dash's proven pattern. The child reaches it via a reserved `HOLI_HOOK_PORT` env var read live in the hook command; a per-session `HOLI_HOOK_TOKEN` (query `?t=`) rejects any other local process (403).
- **The `curl` guard makes committed hooks safe.** `[ -n "$HOLI_HOOK_PORT" ] || exit 0` means the seeded (shared, committed) hook is a silent no-op for a bare `claude` opened in the same vault outside Holi — no ECONNREFUSED, no stray pause. This is why the command can live in the committed `settings.json` rather than a per-session `settings.local.json` (dash rewrites the local file per session because it also injects other state; Holi needs only the live-read port, so one seeded command suffices).
- **Holi needs one bit, not dash's activity model.** dash tracks `busy|idle|waiting|error` per PTY with `ptyId` correlation, tool tracking, and an MCP bridge because it manages a fleet. Holi has exactly one live session and needs only *mid-turn?* → `UserPromptSubmit` pause / `Stop` resume. No `ptyId`, no `PreToolUse`/`PostToolUse` (the `UserPromptSubmit`→`Stop` bracket already spans all tool use and permission waits).
- **Safety valve = a per-turn timeout, not output monitoring.** `Stop` is not guaranteed to fire (interrupt/crash). dash pairs `Stop` with a timeout keyed off PTY output; Holi drops the output half (the very thing we're banning) and keeps a plain `turnSafetyMs` cap that force-resumes. Session death already resumes via `teardown`. The residual risk — a genuinely long, silent, non-git turn hitting the cap and resuming early — is benign: sync commits are edit-triggered and git retries the lock.
- **Reuse `pause`/`resume`, don't invent a gate.** `ActiveVault.pause(reason)` gates the whole loop via `manualPause`; `resume()` clears it and kicks a catch-up commit + pull — exactly right after a turn.
- **The manager owns the coordination.** It owns the session and env; `setTurnActive` lives there. The HTTP server is thin transport wired in `index.ts` and calls back into the manager.

## Known limitations (state them, don't hide them)

- **Seeded `settings.json` reaches new vaults only.** `SEED_FILES` is create-if-missing, so existing clones keep the old (Stop-less) settings — the hook won't fire there until re-seeded. The pause/resume plumbing is correct regardless; live-verify on a fresh vault or hand-add the Stop hook. (Same caveat the AGENTS.md text change carried.)
- **The footer shows `paused` during a turn.** `pause()` pushes a `paused` sync-state; the footer reads the reason while the agent works and flips back on resume. Honest and intended; the amber dot corroborates.
- **`resume()` also clears `conflictPaths`.** Benign now (no conflict flow). **Slice 3's reconcile hold must not be stomped by the per-turn resume _or_ the safety-timer resume** — carry into the Slice 3 plan. See `active-vault.ts:591`.
- **A permission wait keeps the vault paused for the whole wait.** Correct (the turn isn't over; `Stop` hasn't fired) and strictly better than the reverted heuristic, which read a silent wait as idle. Only the `turnSafetyMs` cap ends it.

---

## Conventions (read once)

- **Tooling:** bare `node`/`npx` broken — always `pnpm exec`. Desktop commands from `apps/desktop/`; shared from `packages/shared/`. Absolute paths in Bash — cwd drifts between calls.
- **Typecheck gate:** from `apps/desktop`, `pnpm exec node node_modules/typescript/bin/tsc --noEmit 2>&1 | grep -c "error TS"`. Baseline **6** (pre-existing `state/history.ts`; leave them). Must not rise.
- **Test baselines:** desktop **612** (`cd apps/desktop && pnpm exec vitest run`; node env, ~85s — exceeds the 120s Bash timeout, finishes in the background, fine). Shared **179** — untouched. Confirm 612 at the start (611 original + the 1 surviving AGENTS.md seed test from `65482ef`; the PTY-detector's 3 tests were reverted).
- **Build:** `cd apps/desktop && pnpm exec electron-vite build`.
- **Live app:** dev on CDP 9333. Renderer hot-reloads; **main edits (hook-server, agent-manager, index, seed-content) need a relaunch** — ask Nicolai. Scoped teardown only: `pkill -f "better-holi-final/node_modules/.pnpm/electron@"`.
- **Commit trailer:** end every commit message with `Claude goes brr.. via Dash`.

## File Structure

- **Create** `apps/desktop/src/main/agent/hook-server.ts` — `createHookServer({onTurnStart,onTurnEnd})`: 127.0.0.1:0 HTTP, token-guarded `POST /turn/start|/turn/end`, empty responses.
- **Create** `apps/desktop/test/hook-server.test.ts` — real localhost round-trips.
- **Modify** `apps/desktop/src/main/agent/agent-runtime.ts` — `buildAgentEnv(base, opts?)` injects/strips `HOLI_HOOK_PORT`/`HOLI_HOOK_TOKEN`.
- **Modify** `apps/desktop/test/agent-runtime.test.ts` — env-injection cases.
- **Modify** `apps/desktop/src/main/agent/agent-manager.ts` — `setTurnActive`, real `status().working`, `turnSafetyMs` cap, teardown resume, env wiring, new deps.
- **Modify** `apps/desktop/test/agent-manager.test.ts` — turn-state tests; fake host records pause/resume; port/token providers in the rig.
- **Modify** `apps/desktop/src/main/index.ts` — create/start/stop the hook server; feed port/token providers + `setTurnActive` callbacks to the manager.
- **Modify** `apps/desktop/src/main/agent/seed-content.ts` — add the two `curl` hooks to `SETTINGS_JSON`; refresh the stale "no turn to bracket" comment.
- **Modify** `apps/desktop/test/seed-content.test.ts` — assert the Stop/UserPromptSubmit turn hooks; update the pinned `Object.keys(hooks)`.

### Shared contracts (define once, referenced by every task)

```ts
// hook-server.ts
export interface HookServerDeps {
  onTurnStart(): void
  onTurnEnd(): void
  log?: (msg: string) => void
}
export interface HookServer {
  start(): Promise<void>       // binds 127.0.0.1:0
  stop(): Promise<void>
  port(): number | null        // null until started
  token(): string              // per-instance hex, minted at construction
}
export function createHookServer(deps: HookServerDeps): HookServer
```

```ts
// agent-runtime.ts
export interface AgentEnvOpts { hookPort?: number | null; hookToken?: string | null }
export function buildAgentEnv(base: NodeJS.ProcessEnv, opts?: AgentEnvOpts): Record<string, string>
```

```ts
// agent-manager.ts — AgentManagerDeps additions
  hookPort?: () => number | null
  hookToken?: () => string | null
  /** Force-resume if a turn never ends (Stop is not guaranteed on interrupt).
   *  Default 600000 (10 min). */
  turnSafetyMs?: number
// AgentManager interface addition
  /** Turn bracket from the hook server: true on UserPromptSubmit, false on Stop.
   *  Drives the vault pause/resume and status().working. No-op when no session. */
  setTurnActive(active: boolean): void
```

**Reserved env keys** (both stripped from `base` before injecting, so vault/user env can't override): `HOLI_HOOK_PORT`, `HOLI_HOOK_TOKEN`.
**Endpoints:** `POST /turn/start`, `POST /turn/end`. **Token:** query `?t=<token>`; mismatch/absent → `403`, no callback. Unknown path → `404`. Success → `204`, empty body (a non-empty body would be injected into Claude's context — dash HookServer.ts:188).

---

## Task 1: The hook server

**Files:** Create `apps/desktop/src/main/agent/hook-server.ts`, `apps/desktop/test/hook-server.test.ts`.

- [ ] **Step 1: Write failing tests** (`test/hook-server.test.ts`, node env). Test-intent:
  - `start()` then `port()` is a number > 0; `token()` is a non-empty hex string, stable across calls.
  - `POST http://127.0.0.1:<port>/turn/start?t=<token>` → `onTurnStart` fired once, response status `204`, body empty.
  - `POST /turn/end?t=<token>` → `onTurnEnd` fired.
  - Wrong `?t=` and missing `?t=` → `403`, **no** callback.
  - `POST /nope?t=<token>` → `404`, no callback.
  - `stop()` closes (a follow-up request fails to connect).
  - Drive requests with Node stdlib `http.request` (or `fetch`); `afterEach` calls `stop()`.
- [ ] **Step 2: Run, verify they fail** — `cd apps/desktop && pnpm exec vitest run test/hook-server.test.ts` → FAIL (module/exports missing).
- [ ] **Step 3: Implement `createHookServer`.** Contract:
  - `token` minted at construction: `randomBytes(16).toString('hex')` (`node:crypto`).
  - `start()`: `http.createServer(handler).listen(0, '127.0.0.1')`, resolve on `listening`; capture `address().port`.
  - Handler: read+discard the body with a 64KB cap (drain; never parse). Reject non-`POST` → `405`. Parse `new URL(req.url, 'http://127.0.0.1')`; if `searchParams.get('t') !== token` → `403`. Switch `pathname`: `/turn/start` → `deps.onTurnStart()`, `/turn/end` → `deps.onTurnEnd()`, else `404`. Success → `res.writeHead(204).end()`.
  - `stop()`: `server.close()` wrapped in a Promise; null the port.
  - No runtime `electron` import (loads under vitest).
- [ ] **Step 4: Run, verify pass.**
- [ ] **Step 5: Typecheck** → 6.
- [ ] **Step 6: Commit** — `feat(agent): localhost hook server for turn-state signals`.

---

## Task 2: Inject the hook port/token into the child env

**Files:** Modify `agent-runtime.ts`, `test/agent-runtime.test.ts`.

- [ ] **Step 1: Add failing env tests.** Test-intent (extend existing `buildAgentEnv` describe):
  - `buildAgentEnv(base, { hookPort: 5000, hookToken: 'abc' })` → `HOLI_HOOK_PORT === '5000'`, `HOLI_HOOK_TOKEN === 'abc'`.
  - No opts (or nulls) → neither key present.
  - `base` carrying `HOLI_HOOK_PORT`/`HOLI_HOOK_TOKEN` with **no** opts → both **stripped** (reserved keys; a vault can't spoof them).
  - Regression: still deletes `CLAUDECODE`/`CLAUDE_CODE_ENTRYPOINT`, still sets `CLAUDE_CODE_NO_FLICKER='1'`, `TERM='xterm-256color'`.
- [ ] **Step 2: Run, verify fail.**
- [ ] **Step 3: Implement.** Change signature to `buildAgentEnv(base, opts: AgentEnvOpts = {})`. After the existing body: `delete env.HOLI_HOOK_PORT; delete env.HOLI_HOOK_TOKEN;` then `if (opts.hookPort != null) env.HOLI_HOOK_PORT = String(opts.hookPort); if (opts.hookToken) env.HOLI_HOOK_TOKEN = opts.hookToken`.
- [ ] **Step 4: Run, verify pass.**
- [ ] **Step 5: Typecheck** → 6 (the manager's existing `buildAgentEnv(process.env)` call still compiles — `opts` defaults; it gets its real args in Task 3).
- [ ] **Step 6: Commit** — `feat(agent): buildAgentEnv injects the reserved hook port/token`.

---

## Task 3: Turn state in the manager (pause/resume + safety + teardown)

**Files:** Modify `agent-manager.ts`, `test/agent-manager.test.ts`.

- [ ] **Step 1: Teach the rig's fake host to record pause/resume; add port/token providers.** In `rig()`: give the `active()` object `pause: (reason) => paused.push(reason)` and `resume: () => { resumes += 1 }`; expose `paused: string[]` and `resumes(): number` on `Rig`. Pass `hookPort: () => 4242`, `hookToken: () => 'tkn'`, and `turnSafetyMs: opts.turnSafetyMs` into `createAgentManager`. Widen `rig` opts with `turnSafetyMs?: number`.
- [ ] **Step 2: Write failing turn-state tests.** Test-intent (append inside `describe('AgentManager', …)`):
  - **pauses on turn start, resumes on turn end:** `start()`; `setTurnActive(true)` → `status().working === true`, `paused.length > 0`, last `agent:status` payload `.working === true`. `setTurnActive(false)` → `working === false`, `resumes() > 0`.
  - **idempotent:** two `setTurnActive(true)` in a row → only one `pause` (guard on unchanged state).
  - **safety cap force-resumes:** `rig({ turnSafetyMs: 30 })`; `start()`; `setTurnActive(true)`; wait ~60ms → `working === false`, `resumes() > 0` (never strand behind a missing `Stop`).
  - **no session ⇒ no-op:** on a fresh rig (no `start()`), `setTurnActive(true)` → `paused` empty, `working === false` (a late/stray hook can't pause a vault with no agent).
  - **teardown resumes a mid-turn session:** `start()`; `setTurnActive(true)`; `kill()` → `resumes()` incremented, `working === false` (session death never strands the vault).
  - **spawn env carries the port/token:** after `start()`, the recorded spawn's `opts.env.HOLI_HOOK_PORT === '4242'` and `HOLI_HOOK_TOKEN === 'tkn'`. *(Requires the fake spawn to capture `env` — it already does via `spawns`.)*
- [ ] **Step 3: Run, verify fail.**
- [ ] **Step 4: Implement.** In `createAgentManager`:
  - State beside `attached`: `const turnSafetyMs = deps.turnSafetyMs ?? 600_000; let working = false; let safetyTimer: ReturnType<typeof setTimeout> | null = null`.
  - `status().working` returns `working` (drop the hardcoded `false`); refresh the `AgentStatus.working` doc comment (hook-derived, not "false for now").
  - `setTurnActive(active)`: `if (session === null) return` (guard); `if (active === working) return`; `working = active`; if `active`: `deps.host.active()?.pause('the assistant is working')` and arm `safetyTimer = setTimeout(() => setTurnActive(false), turnSafetyMs)`; else: clear `safetyTimer`, `deps.host.active()?.resume()`; then `pushStatus()`.
  - `start()`: before wiring, reset `working = false` and clear `safetyTimer` (a fresh session is idle).
  - Env line: `env: buildAgentEnv(process.env, { hookPort: deps.hookPort?.() ?? null, hookToken: deps.hookToken?.() ?? null })`.
  - `teardown()`: after nulling `session`, clear `safetyTimer`; `if (working) { working = false; deps.host.active()?.resume() }`. (No `pushStatus` inside teardown — every caller pushes after, as today.)
  - Add `setTurnActive` to the returned object and the `AgentManager` interface.
- [ ] **Step 5: Run manager + runtime suites** — `pnpm exec vitest run test/agent-manager.test.ts test/agent-runtime.test.ts` → PASS.
- [ ] **Step 6: Typecheck** → 6.
- [ ] **Step 7: Commit** — `feat(agent): hook-driven turn state pauses/resumes vault sync`.

---

## Task 4: Wire the hook server in main

**Files:** Modify `index.ts` (around `:149`, the `createAgentManager` call, and the `before-quit` block `:174`).

- [ ] **Step 1: Create + start the server, feed the manager.** Replace the single `createAgentManager({ host, getWindow })` line with a forward-referenced wiring:

```ts
  let agent: AgentManager
  const hookServer = createHookServer({
    onTurnStart: () => agent.setTurnActive(true),
    onTurnEnd: () => agent.setTurnActive(false),
  })
  await hookServer.start()
  agent = createAgentManager({
    host,
    getWindow: () => mainWindow,
    hookPort: () => hookServer.port(),
    hookToken: () => hookServer.token(),
  })
```

Add the imports (`createHookServer` from `./agent/hook-server`, and `type AgentManager` from `./agent/agent-manager`). The closures fire only at runtime, after `agent` is assigned — safe.

- [ ] **Step 2: Stop the server on quit.** In the `before-quit` async block, after `await agent.dispose()…`, add `await hookServer.stop().catch((err) => console.error('[quit] hook server stop failed:', err))`.
- [ ] **Step 3: Typecheck** → 6. (No unit test — `index.ts` is the composition root, exercised live in Task 6. The seam under test is `setTurnActive`, already covered in Task 3.)
- [ ] **Step 4: Commit** — `feat(agent): wire the hook server to the agent manager in main`.

---

## Task 5: Seed the `curl` turn hooks

**Files:** Modify `seed-content.ts`, `test/seed-content.test.ts`.

- [ ] **Step 1: Add the hook command + wire the events.** In `seed-content.ts`, add a helper beside `hookCommand`:

```ts
/** A turn-bracket hook: POST to Holi's local hook server. Guarded so it is a
 *  silent no-op for a bare `claude` opened outside Holi (no $HOLI_HOOK_PORT). */
const turnHook = (endpoint: 'start' | 'end') =>
  `[ -n "$HOLI_HOOK_PORT" ] || exit 0; curl -s --max-time 2 -X POST "http://127.0.0.1:$HOLI_HOOK_PORT/turn/${endpoint}?t=$HOLI_HOOK_TOKEN" >/dev/null 2>&1`
```

In `SETTINGS_JSON.hooks`: append `{ type: 'command', command: turnHook('start') }` as a **second** command in the existing `UserPromptSubmit` entry's `hooks` array (keep the `user-prompt-submit.mjs` command first), and add a new event `Stop: [{ hooks: [{ type: 'command', command: turnHook('end') }] }]`. Refresh the stale comment ("there is no turn to bracket…") to state that `Stop`/`UserPromptSubmit` now bracket a turn for git coexistence (hook-server signal), while `PreToolUse` stays absent (the bracket already spans tool use).

- [ ] **Step 2: Update + add seed tests.** In `test/seed-content.test.ts`:
  - Change the pinned `expect(Object.keys(settings.hooks)).toEqual(['UserPromptSubmit'])` (line ~82) to `toEqual(['UserPromptSubmit', 'Stop'])`.
  - New test-intent: `settings.hooks.Stop[0].hooks[0].command` contains `/turn/end` **and** `[ -n "$HOLI_HOOK_PORT" ]` (the guard). The `UserPromptSubmit` commands include one containing `/turn/start` and still one containing `user-prompt-submit.mjs`.
- [ ] **Step 3: Run seed suite** — `pnpm exec vitest run test/seed-content.test.ts` → PASS.
- [ ] **Step 4: Typecheck** → 6.
- [ ] **Step 5: Commit** — `feat(agent): seed UserPromptSubmit/Stop curl hooks for turn signals`.

---

## Task 6: Full gates + live verification

**Files:** none (verification only).

- [ ] **Step 1: Typecheck** → 6.
- [ ] **Step 2: Desktop suite** — `pnpm exec vitest run 2>&1 | tail -6`. Expected **≈620** (612 baseline + ~6 hook-server + ~4 manager turn-state + ~2 env + ~1 seed; confirm the exact number, no unexpected failures).
- [ ] **Step 3: Shared suite** — `cd packages/shared && pnpm exec vitest run 2>&1 | tail -3` → **179**.
- [ ] **Step 4: Build** — `cd apps/desktop && pnpm exec electron-vite build 2>&1 | tail -3` → clean.
- [ ] **Step 5: Live (ask Nicolai to relaunch — main changed; needs CDP 9333).** On a **fresh** vault (seed reaches new vaults only) with the drawer up (⌘J):
  1. **Turn pauses sync.** Send a multi-second prompt. While it runs: drawer dot pulses **amber**, footer reads **paused** (`the assistant is working`). On completion (`Stop` fires) the dot goes green and the footer resumes — should be crisp, not `idleMs`-laggy, because it's an event, not a timeout.
  2. **Idle stays idle.** After the turn, the footer *stays* resumed (no flip-flop) — the failure mode the PTY heuristic had.
  3. **Whole turn stays paused, incl. a permission prompt.** During tool use + an approval prompt, the footer stays paused for the entire turn (no mid-turn resume).
  4. **Interrupt doesn't strand.** Start a turn, hit Esc to interrupt. If `Stop` fires, sync resumes at once; if not, it resumes at the `turnSafetyMs` cap. Confirm it does resume. If interrupts routinely strand until the cap, note it — consider also wiring the `Notification` `idle_prompt` hook to `/turn/end` in a follow-up.
  5. **Autosave while idle.** Drawer open, agent idle: edit a note → autosaves/commits (pause is per-turn).
  6. **Guard holds outside Holi.** In a plain terminal, `cd` into the vault clone and run `claude` (no `$HOLI_HOOK_PORT`); confirm no errors from the hooks and Holi's sync is unaffected.
  - Report what actually happened, especially #2 and #4.
- [ ] **Step 6 (if needed): tune `turnSafetyMs`.** Only if #4 shows the default 10 min is wrong for real use. Set in `index.ts`'s `createAgentManager({…})` (add `turnSafetyMs: <ms>`), relaunch, commit `chore(agent): tune the turn safety cap to <ms>`.

---

## Final verification

- [ ] Typecheck **6**.
- [ ] Desktop suite green (confirm the new count).
- [ ] Shared **179**.
- [ ] Build clean.
- [ ] Live: a running turn pauses sync (amber + paused footer) and resumes crisply on `Stop`; idle stays idle; a permission wait stays paused; an interrupt resumes (at worst by the safety cap); autosave runs while idle; a bare `claude` in the vault no-ops the hooks.

## Self-review (spec coverage)

- **Holi suspends sync while the agent works, resumes after** → Task 3 (`setTurnActive` → `pause`/`resume`) driven by Task 1 server + Task 5 hooks.
- **Keyed off hooks, not PTY** ([[holi-no-custom-cc-state-monitoring]]) → Tasks 1 + 5; the manager has zero `runtime.onData` turn logic.
- **Single git actor** → `pause` gates the whole vault loop via `manualPause`.
- **`working` flag real; drives the amber dot** → Task 3 (`status().working`); renderer already reads it (no renderer change; the status *text* was dropped earlier in `7cc13f0` and stays dropped — optional to restore once trusted).
- **Never strand a paused vault** → Task 3 teardown resume + `turnSafetyMs` cap.
- **`AGENTS.md` says git is yours** → already shipped (`65482ef`, not reverted).
- **Safe outside Holi** → the `curl` guard (Task 5) + live check #6.
- **Deferred to later slices (correctly absent):** conflict → reconcile hold and its coordination with the per-turn/safety resume (Slice 3 — note `resume()` clears `conflictPaths`); `$TYPST_BIN` + `md-to-pdf` (Slice 4).
