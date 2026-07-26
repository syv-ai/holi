# Vault agent — Slice 2 (git coexistence) Implementation Plan

> **For agentic workers:** Use the executing-plans skill to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** While the agent is mid-turn, Holi suspends its own sync loop so the two git actors never contend on `.git/index.lock`; it resumes when the turn goes idle. And the seeded `AGENTS.md` stops forbidding git and instead tells the agent git is theirs.

**Architecture:** The agent manager derives a **working/idle** signal from **PTY activity** (any output ⇒ mid-turn; a quiet stream for a settle window ⇒ idle) and toggles the active vault's existing `pause(reason)` / `resume()` — the same "stops both loops" primitive the reconcile flow (slice 3) will hold longer. No turn-bracketing hooks: the PRD keys this off PTY activity, and the seeded `settings.json` deliberately has no `Stop`/`PreToolUse` hook. The `working` flag (hardcoded `false` in slice 1) becomes real and drives both the sync pause and the drawer's amber pulse.

**Tech Stack:** Electron main (`node-pty` PTY already streaming to the manager), the vault sync engine (`active-vault.ts` `pause`/`resume`/`manualPause`), Vitest 4 (node env). Live behaviour is CDP/manual per repo norm.

**PRD:** `docs/prd/agent.md` §"Git coexistence — Holi pauses while the agent works", build order slice 2. Governing principle (auto-memory `holi-agent-pure-claude-code`): build only what Claude Code doesn't already do.

---

## Design decisions (settled, do not re-litigate)

- **PTY activity is the signal, not hooks.** The PRD says Holi "keys this off the working/idle status … from PTY activity," and the seeded `.claude/settings.json` comment explicitly notes there is "no turn to bracket" — so we do **not** reintroduce a `Stop`/`PreToolUse` hook. Working = the PTY produced output recently; idle = the stream has been quiet for a settle window (`idleMs`).
- **Reuse `pause`/`resume`, don't invent a new gate.** `ActiveVault.pause(reason)` already suspends the commit + pull + push loop (`manualPause` gates every loop in `active-vault.ts`), and the PRD says coexistence and reconcile share "the same suspend." So the manager calls `host.active()?.pause('…')` on working, `.resume()` on idle. `resume()` also kicks a catch-up commit + pull, which is exactly what should happen after a turn.
- **The manager owns the coordination.** It already depends on `VaultHost` and owns the PTY stream, so "agent working ⇒ pause sync" lives there rather than being threaded through `index.ts`.
- **Scoped to turns, not the session.** Editor autosave must keep working while the drawer is open but the agent idle (PRD), so the pause is per-turn, never for the whole session.

## Known limitations (state them, don't hide them)

- **A silent stretch mid-turn can look idle.** If Claude's TUI goes quiet during a permission prompt or a long gap between tool calls, the idle timer may fire and resume sync before the turn is truly over. Mitigations: Holi's sync commit is **edit-triggered** (nothing is pending to commit during a wait, so there's little to contend on), `git` retries its own lock, and `idleMs` is tuned long enough to outlast the animated "thinking" spinner's gaps. This is the accepted cost of the PTY-activity heuristic (the PRD chose it over a hook); `idleMs` is tunable and verified live.
- **The footer shows `paused` during a turn.** `pause()` pushes a `paused` sync-state to the renderer, so the footer reads the pause reason while the agent works and flips back when it resumes. That is honest and intended; for a multi-second turn it's informative, and the drawer's amber "working…" pulse corroborates it.
- **`resume()` also clears `conflictPaths`.** Benign in slice 2 (no conflict flow yet). **Slice 3 must ensure the per-turn resume cannot stomp a reconcile hold** — noted there, out of scope here.
- **The `AGENTS.md` text change only reaches new vaults.** `SEED_FILES` is written only when absent, so existing clones keep the old prohibition text. The *functional* coexistence (pause/resume) works on every vault regardless; the text is documentation for the agent and is verified by the seed test, not by re-seeding live vaults.

---

## Conventions (read once)

- **Tooling:** bare `node`/`npx` are broken — always `pnpm exec`. Desktop commands from `apps/desktop/`; shared from `packages/shared/`. Absolute paths in Bash — the tool's cwd drifts between calls.
- **Typecheck gate:** from `apps/desktop`, `pnpm exec node node_modules/typescript/bin/tsc --noEmit 2>&1 | grep -c "error TS"`. Baseline **6** (all pre-existing `state/history.ts`, unrelated — leave them). Must not rise. Grep `"error TS"`, not `error`.
- **Test baselines:** desktop **611** (`cd apps/desktop && pnpm exec vitest run`; node env, ~85s — exceeds the 120s Bash timeout and finishes in the background, fine). Shared **179** — untouched. Expected desktop after this slice: **615** (+3 manager working tests, +1 seed test).
- **Build:** `cd apps/desktop && pnpm exec electron-vite build` (electron-vite lives in `apps/desktop`).
- **Live app:** dev on CDP 9333. Renderer edits hot-reload; **main edits (agent-manager, seed-content) need a relaunch** — ask the user. Scoped teardown only: `pkill -f "better-holi-final/node_modules/.pnpm/electron@"`.
- **Commit trailer:** end every commit message with `Claude goes brr.. via Dash`.

## File Structure

- **Modify** `apps/desktop/src/main/agent/agent-manager.ts` — a PTY-activity working detector that pauses/resumes the active vault; `status().working` becomes real; `idleMs` dep; teardown resumes.
- **Modify** `apps/desktop/test/agent-manager.test.ts` — the fake host records `pause`/`resume`; three working-detection tests; `idleMs` in the rig.
- **Modify** `apps/desktop/src/main/agent/seed-content.ts` — rewrite `AGENTS.md`'s git section from prohibition to "Git is yours."
- **Modify** `apps/desktop/test/seed-content.test.ts` — assert the new grant, forbid the old prohibition.

---

## Task 1: Detect "working" from PTY activity and pause/resume sync

**Files:**
- Modify: `apps/desktop/src/main/agent/agent-manager.ts`
- Modify: `apps/desktop/test/agent-manager.test.ts`

- [ ] **Step 1: Teach the test rig's fake host to record pause/resume + accept `idleMs`**

In `apps/desktop/test/agent-manager.test.ts`, replace the fake `host` block in `rig()` with one that records the calls:

```ts
  const paused: string[] = []
  let resumes = 0
  let activeRemote: string | null = opts.active === undefined ? VAULT : opts.active
  const host = {
    active: (): ActiveVault | null =>
      activeRemote === null
        ? null
        : ({
            remote: activeRemote,
            root: workRoot,
            pause: (reason: string) => paused.push(reason),
            resume: () => {
              resumes += 1
            },
          } as unknown as ActiveVault),
    open: async () => {
      throw new Error('not used in these tests')
    },
    close: async () => {},
    setActive: (v: string | null) => (activeRemote = v),
  } as unknown as VaultHost & { setActive(v: string | null): void }
```

Pass `idleMs` through to the manager (add to the `createAgentManager({…})` call, after `killGraceMs: 20,`):

```ts
    idleMs: opts.idleMs,
```

Widen the `rig` options and the `Rig` interface, and return the new handles. Change the `rig` signature:

```ts
async function rig(opts: { bin?: string | null; active?: string | null; idleMs?: number } = {}): Promise<Rig> {
```

Add to the `Rig` interface (beside `pty(): FakePty`):

```ts
  paused: string[]
  resumes(): number
```

And to the returned object (beside `pty: () => ptys.at(-1)!`):

```ts
    paused,
    resumes: () => resumes,
```

- [ ] **Step 2: Write the failing tests**

Append these three tests inside `describe('AgentManager', …)`:

```ts
  it('pauses the vault sync while the agent works, and resumes when the turn goes idle', async () => {
    const r = await rig({ idleMs: 40 })
    await r.manager.start({ vaultId: VAULT })

    r.pty().emit('…thinking…')
    expect(r.manager.status().working).toBe(true)
    expect(r.paused.length).toBeGreaterThan(0)
    expect(r.sent.filter((s) => s.channel === 'agent:status').at(-1)!.payload.working).toBe(true)

    await new Promise((res) => setTimeout(res, 80)) // outlast the idle window
    expect(r.manager.status().working).toBe(false)
    expect(r.resumes()).toBeGreaterThan(0)
  })

  it('stays working across a burst — each chunk resets the idle window', async () => {
    const r = await rig({ idleMs: 40 })
    await r.manager.start({ vaultId: VAULT })

    r.pty().emit('a')
    await new Promise((res) => setTimeout(res, 25))
    r.pty().emit('b') // resets the window before the 40ms elapses
    await new Promise((res) => setTimeout(res, 25))
    expect(r.manager.status().working).toBe(true) // 50ms elapsed, but never a 40ms gap
  })

  it('resumes the vault if the session dies mid-turn — never strand a paused vault', async () => {
    const r = await rig({ idleMs: 10_000 }) // long window: it stays "working" until it exits
    await r.manager.start({ vaultId: VAULT })
    r.pty().emit('working…')
    expect(r.manager.status().working).toBe(true)
    const before = r.resumes()

    r.pty().exit(0) // claude quits mid-turn
    await new Promise((res) => setTimeout(res, 30))
    expect(r.manager.status().working).toBe(false)
    expect(r.resumes()).toBe(before + 1)
  })
```

- [ ] **Step 3: Run them, verify they fail**

Run: `cd apps/desktop && pnpm exec vitest run test/agent-manager.test.ts`
Expected: FAIL — `status().working` is hardcoded `false`, and `paused`/`resumes` are never called (the manager doesn't touch the vault yet).

- [ ] **Step 4: Implement the working detector in the manager**

In `apps/desktop/src/main/agent/agent-manager.ts`:

Add `idleMs` to `AgentManagerDeps` (after `killGraceMs?: number`):

```ts
  /** How long the PTY stream must be quiet before a turn counts as idle (the
   *  PRD's "short settle"). Default 1500ms; tune live. */
  idleMs?: number
```

Inside `createAgentManager`, add the state beside `let attached = false`:

```ts
  const idleMs = deps.idleMs ?? 1500
  let working = false
  let idleTimer: ReturnType<typeof setTimeout> | null = null
```

Make `status().working` real — replace `working: false,` with `working,`:

```ts
  const status = (): AgentStatus => ({
    running: session !== null,
    working,
    configStale: false,
    authenticated: isClaudeAuthenticated(),
  })
```

Add the detector functions (after `pushStatus`):

```ts
  /**
   * PTY output means the agent is mid-turn. Each chunk resets an idle timer;
   * when it fires — the stream has been quiet for `idleMs` — the turn is over.
   * This is the PTY-activity signal the PRD keys git coexistence off (no turn
   * hooks). See the plan's "known limitations": a silent permission-wait can
   * look idle, which is acceptable because sync commits are edit-triggered.
   */
  function noteActivity(): void {
    if (idleTimer) clearTimeout(idleTimer)
    idleTimer = setTimeout(() => {
      idleTimer = null
      setWorking(false)
    }, idleMs)
    if (!working) setWorking(true)
  }

  /**
   * While the agent works, suspend the vault's sync loop so the two git actors
   * never contend on `.git/index.lock`; resume (which catches up commits + pulls)
   * when the turn goes idle. The same pause/resume the reconcile flow will hold.
   */
  function setWorking(next: boolean): void {
    if (next === working) return
    working = next
    if (next) deps.host.active()?.pause('the assistant is working')
    else deps.host.active()?.resume()
    pushStatus()
  }
```

Wire it into the PTY stream — add `noteActivity()` at the top of the `runtime.onData` handler:

```ts
    runtime.onData((data) => {
      noteActivity() // PTY output = the agent is mid-turn (git-coexistence signal)
      terminal.write(data) // the mirror is the record; the renderer is a view
      if (attached) send('agent-pty:data', data)
    })
```

Make `teardown` clear the timer and resume, so a session that dies mid-turn never strands a paused vault — replace the body:

```ts
  async function teardown(): Promise<void> {
    const current = session
    if (!current) return
    session = null // guard the double-stop: the PTY exit path tears down too
    attached = false
    if (idleTimer) {
      clearTimeout(idleTimer)
      idleTimer = null
    }
    if (working) {
      working = false
      deps.host.active()?.resume() // don't leave the vault paused behind a dead session
    }
    current.snapshot.stop()
    await current.runtime.kill()
    current.mirror.dispose()
  }
```

(No `pushStatus()` inside `teardown` — every caller — `kill`, the `onExit` handler, `start`'s restart — already pushes after it, and `dispose` runs at app shutdown.)

- [ ] **Step 5: Run the tests, verify they pass**

Run: `cd apps/desktop && pnpm exec vitest run test/agent-manager.test.ts test/agent-runtime.test.ts`
Expected: PASS — 14 (manager: 11 + 3) + 18 (runtime) = **32 tests**. The slice-1 tests that emit data still pass: the fake host now has `pause`/`resume`, and none of them assert on `working`.

- [ ] **Step 6: Typecheck**

Run: `cd apps/desktop && pnpm exec node node_modules/typescript/bin/tsc --noEmit 2>&1 | grep -c "error TS"`
Expected: **6** (pre-existing `state/history.ts` only).

- [ ] **Step 7: Commit**

```bash
cd /Users/nicolaibthomsen/repos/syv/better-holi-final
git add apps/desktop/src/main/agent/agent-manager.ts apps/desktop/test/agent-manager.test.ts
git commit -m "feat(agent): pause vault sync while the agent works (git coexistence)

Derive working/idle from PTY activity and toggle the active vault's pause/resume
so the two git actors never contend on .git/index.lock. working (hardcoded false
in slice 1) is now real and also drives the drawer's amber pulse. A dead session
resumes the vault so it is never stranded paused.

Claude goes brr.. via Dash"
```

---

## Task 2: `AGENTS.md` — git is yours, not forbidden

The seeded `AGENTS.md` currently tells the agent **"Do not run `git commit`, `git push`, `git pull`, or switch branches."** Coexistence supersedes that: the agent may run git freely, because Holi steps out of the way while it works.

**Files:**
- Modify: `apps/desktop/src/main/agent/seed-content.ts`
- Modify: `apps/desktop/test/seed-content.test.ts`

- [ ] **Step 1: Rewrite the git section**

In `apps/desktop/src/main/agent/seed-content.ts`, inside the `AGENTS_MD` template, replace the "How your edits reach other people" section (the paragraph plus the "Do not run …" bullet list) with:

```
## How your edits reach other people

Edits are committed automatically, a few seconds after they stop, and those
commits push to GitHub on their own — there is no Publish step. Sync is
automatic in both directions.

## Git is yours

You may run git freely — \`commit\`, \`push\`, \`pull\`, resolve a merge. While you
are working, Holi suspends its own auto-commit/pull loop and resumes it when your
turn goes idle, so there is only ever one git actor and you never contend on
\`.git/index.lock\`.

- **Switching branches pauses Holi's sync until you switch back.** If you check
  out another branch or leave a rebase in progress, Holi's loop stays paused
  until the working tree returns to the default branch — so undo it when you're
  done, or say so.
- \`git log\` and \`git diff\` are always safe to run.
```

(Leave every other section of `AGENTS_MD` — Notes, Images, Tasks, Memory — unchanged.)

- [ ] **Step 2: Lock the change with a seed test**

In `apps/desktop/test/seed-content.test.ts`, add (near the `'CLAUDE.md is exactly the AGENTS.md import shim'` test):

```ts
  it('AGENTS.md grants the agent git (coexistence), not the old prohibition', () => {
    const agents = SEED_FILES['AGENTS.md']!
    expect(agents).toContain('Git is yours')
    expect(agents).not.toContain('Do not run') // the pre-coexistence prohibition
  })
```

- [ ] **Step 3: Run the seed suite**

Run: `cd apps/desktop && pnpm exec vitest run test/seed-content.test.ts 2>&1 | tail -6`
Expected: PASS (18 tests — was 17). The pinned key-list, the CLAUDE.md shim, and the "a member's AGENTS.md edit survives re-seed" tests are unaffected (none pin the body text).

- [ ] **Step 4: Commit**

```bash
cd /Users/nicolaibthomsen/repos/syv/better-holi-final
git add apps/desktop/src/main/agent/seed-content.ts apps/desktop/test/seed-content.test.ts
git commit -m "feat(agent): AGENTS.md grants git to the agent (coexistence supersedes the ban)

Holi pauses its own sync while the agent works, so the old 'do not run git'
prohibition is replaced by 'git is yours', keeping only the branch-switch caveat.

Claude goes brr.. via Dash"
```

---

## Task 3: Full gates + live verification (and tune `idleMs`)

**Files:** none (verification only).

- [ ] **Step 1: Typecheck**

Run: `cd apps/desktop && pnpm exec node node_modules/typescript/bin/tsc --noEmit 2>&1 | grep -c "error TS"`
Expected: **6**.

- [ ] **Step 2: Desktop suite**

Run: `cd apps/desktop && pnpm exec vitest run 2>&1 | tail -6`
Expected: **615** (611 + 3 manager + 1 seed). Confirm no unexpected failures.

- [ ] **Step 3: Shared suite (untouched — confirm no drift)**

Run: `cd packages/shared && pnpm exec vitest run 2>&1 | tail -3`
Expected: **179**.

- [ ] **Step 4: Build**

Run: `cd apps/desktop && pnpm exec electron-vite build 2>&1 | tail -3`
Expected: clean.

- [ ] **Step 5: Live (ask the user to relaunch — main changed)**

`agent-manager.ts` and `seed-content.ts` are main edits, so the dev app needs a relaunch. With a vault open and the drawer up (⌘J):

1. **Working pauses sync.** Send the agent a prompt that takes a few seconds (e.g. "read AGENTS.md and summarise it"). While it runs: the drawer dot pulses **amber** ("working…"), and the footer sync state reads **paused** (`the assistant is working`). When it finishes, within ~`idleMs` the dot goes green and the footer returns to up-to-date/pulling.
2. **Idle really goes quiet (the load-bearing check).** After the turn ends, confirm the footer *stays* resumed (does not immediately flip back to paused). If it flips back — the TUI is emitting output at idle (e.g. a periodic redraw) — `idleMs` is not the fix; capture what's emitting and stop before tuning. If it just resumes a touch slowly, raise/lower `idleMs` in `index.ts`'s `createAgentManager({…})` call (add `idleMs: <ms>`), relaunch, re-check.
3. **A turn is not falsely cut short.** During a longer turn with tool use, confirm the footer stays paused for the whole turn (the animated spinner should keep the stream active). If it resumes mid-turn during a permission prompt, note it — that's the documented heuristic limit; only raise `idleMs` if it causes a real contention error.
4. **Editor autosave still runs when the agent is idle.** With the drawer open but the agent idle, edit a note; it autosaves/commits normally (the pause is per-turn, not per-session).
5. **The agent can run git.** Ask the agent to `git log --oneline -3`; it runs without Holi's loop colliding. (On this vault the *old* `AGENTS.md` text may still be present — that's the seed-only-when-absent behaviour; the pause/resume works regardless.)

Report what actually happened, especially #2 (does idle stay quiet?) and the chosen `idleMs`.

- [ ] **Step 6 (optional): pin `idleMs` if the default needed changing**

If live testing settled on a non-default `idleMs`, set it in `apps/desktop/src/main/index.ts` where the manager is created:

```ts
  const agent = createAgentManager({ host, getWindow: () => mainWindow, idleMs: <tuned> })
```

Then relaunch, confirm, and commit:

```bash
cd /Users/nicolaibthomsen/repos/syv/better-holi-final
git add apps/desktop/src/main/index.ts
git commit -m "chore(agent): tune the git-coexistence idle window to <tuned>ms

Claude goes brr.. via Dash"
```

---

## Final verification

- [ ] Typecheck **6**: `cd apps/desktop && pnpm exec node node_modules/typescript/bin/tsc --noEmit 2>&1 | grep -c "error TS"`
- [ ] Desktop **615**: `cd apps/desktop && pnpm exec vitest run 2>&1 | tail -3`
- [ ] Shared **179**: `cd packages/shared && pnpm exec vitest run 2>&1 | tail -3`
- [ ] Build: `cd apps/desktop && pnpm exec electron-vite build 2>&1 | tail -3`
- [ ] Live (after relaunch): a running turn pauses sync (amber dot + paused footer) and resumes on idle; idle stays quiet; editor autosave runs while the agent is idle; the agent can run git.

---

## Self-review (spec coverage)

- **Holi suspends its sync loop while the agent works** (PRD §Git coexistence: "while the agent is *working* (mid-turn), Holi suspends its sync loop; it resumes after the turn goes idle (with a short settle)") → Task 1: PTY-activity `noteActivity` → `setWorking` → `host.active().pause/resume`, `idleMs` settle.
- **Keyed off PTY activity, single git actor** (PRD) → Task 1: the manager is the only thing toggling the vault pause while a session runs; `pause` gates the vault's whole loop via `manualPause`.
- **`working` flag becomes real** (deferred from slice 1) → Task 1: `status().working` returns the tracked flag; it also lights the drawer's existing amber pulse (no renderer change needed).
- **Never strand a paused vault** (edge case: session dies mid-turn) → Task 1: `teardown` clears the idle timer and resumes.
- **`AGENTS.md` states git is yours, superseding the ban** (PRD: "This supersedes the old AGENTS.md prohibition on the agent running git") → Task 2, keeping the branch-switch caveat (PRD edge case: "a branch switch pauses sync until undone").
- **Editor autosave keeps running while the agent is idle** (PRD) → inherent (the pause is per-turn) + verified in Task 3 step 4.
- **Deferred to later slices (correctly absent):** conflict detection → "Ask Claude to reconcile" → the reconcile *hold* of pause/resume and its coordination with this per-turn resume (slice 3); `$TYPST_BIN` + `md-to-pdf` skill (slice 4).
- **Stated limitations, not hidden:** the PTY-activity heuristic can read a silent permission-wait as idle (accepted; sync commits are edit-triggered); the footer shows `paused` per turn (intended); `resume()` clears `conflictPaths` (benign now, flagged for slice 3).
```