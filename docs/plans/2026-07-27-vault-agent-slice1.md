# Vault agent — Slice 1 (tracer bullet) Implementation Plan

> **For agentic workers:** Use the executing-plans skill to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A live Claude Code session in a right-hand drawer (⌘J) that runs in the open vault's clone and edits its files with native tools — pure Claude Code, no built system prompt, no MCP, the only per-turn injection the focused note.

**Architecture:** Electron main spawns one `claude` per user in a `node-pty` PTY, cwd = the active vault's clone dir, bytes mirrored to a headless xterm (the record) and streamed to the renderer's xterm (the view) over an `agent-pty:*` / `agent:*` IPC seam. `createAgentManager` owns the single session and ties it to `VaultHost.active()`. The agent gets **no** `--append-system-prompt` content; conventions live in `AGENTS.md` (CC reads it natively) and the only per-turn injection is the focused-note line, written by a focus writer to `.holi/context.local.json` and read by the `UserPromptSubmit` hook.

**Tech Stack:** Electron (main `node-pty`, `ipcMain`, `contextBridge`), React 18 + jotai, `@xterm/xterm` (view) + `@xterm/headless` + `@xterm/addon-serialize` (mirror), Vitest 4 (node env). Live wiring is CDP/manual per repo norm.

**PRD:** `docs/prd/agent.md` — build order §"Wiring state & build order" (slice 1), decisions in §"Per-turn context & system prompt" and §"Runtime". Governing principle (auto-memory `holi-agent-pure-claude-code`): **build only what Claude Code doesn't already do.**

---

## ⚠️ Scope note — the handoff under-described this slice

The 2026-07-27 handoff framed slice 1 as "delete the `server-client` dep and those two calls." The code reality is larger and this plan reflects it:

- `agent-manager.ts` imports an **entire deleted vault abstraction** — `ServerClient`, `VaultManager` (`activeVaultId`/`activeMirror`/`workRootFor`), `VaultObserver`, and `VaultMirror` turn-protocol bridges (`signalTurnOpen`/`endOpenTurns`/`docIdForPath`). None of those files exist post-D60. The manager is **rewritten**, not trimmed, against the current `VaultHost`/`ActiveVault` (`src/main/vault/active-vault.ts`), which already exposes `active()`, `.remote`, `.root`, `pause()`, `resume()`.
- `system-prompt.ts` **and** `test/system-prompt.test.ts` are deleted (13 tests go).
- `test/agent-manager.test.ts` is itself pre-D60 (injects the deleted fakes, asserts prompt content and turn activity) — **rewritten** alongside the manager.
- The `working` flag (amber pulse) and `configStale` (config-drift banner) had their sources deleted under D60. Slice 1 keeps both fields in `AgentStatus` but wires them to `false`: `working` comes from PTY activity in **slice 2** (git coexistence); config-drift detection is a PRD open question. This is a deliberate, stated simplification, not an omission.

This does not require a new decision — the PRD already dictates "delete the turn-protocol/observer machinery; it is deleted, not ported." It only makes the slice bigger than one line.

**Found during execution (not in the original task list):** two more test files exercised deleted behavior and were rewritten in place — (a) two behavioral tests in `test/seed-content.test.ts` that *run* the hook and asserted its old memory/tasks/backrefs output (now assert the focused-note line only), folded into Task 8; and (b) `test/context-snapshot.test.ts` (5 tests) which drove the old server-backed related-tasks/backref fetch (now asserts focused/open paths only), rewritten as a Task-9 fix. Net test-count effect: zero (both rewritten in place), so the **610** target held.

---

## Conventions (read once)

- **Tooling:** bare `node`/`npx` are broken — always `pnpm exec`. Desktop commands run from `apps/desktop/`; shared from `packages/shared/`. Absolute paths in Bash — the tool's cwd drifts between calls.
- **Typecheck gate:** from `apps/desktop`, `pnpm exec node node_modules/typescript/bin/tsc --noEmit 2>&1 | grep -c "error TS"`. Baseline **36** today. Slice 1 clears every agent-related error; the residual is **6** — all in `src/renderer/src/state/history.ts` (pre-existing, unrelated to the agent, **leave them**). Do NOT use bare `pnpm exec tsc`; grep `"error TS"`, not `error`.
- **Test baselines:** desktop **626** (`cd apps/desktop && pnpm exec vitest run`; node env, ~110s — it exceeds the 120s Bash timeout and finishes in the background, that's fine). Shared **179** (`cd packages/shared && pnpm exec vitest run`) — untouched by this slice. **First move (Step 0 below): capture the actual current count**, because slice 1 changes it deterministically.
  - Expected desktop delta: **−13** (delete `system-prompt.test.ts`) **−15** (old `agent-manager.test.ts`) **+11** (new `agent-manager.test.ts`) **+1** (new `buildAgentArgs` empty-prompt case) = **610** if the baseline is exactly 626.
- **Build:** `cd apps/desktop && pnpm exec electron-vite build` (electron-vite lives in `apps/desktop`; running it elsewhere fails "command not found"). This is the true check that main's import graph resolves — `tsc` typechecks but electron-vite is what actually bundles the main process.
- **node-pty is a native module** (Electron ABI). Faked under vitest via `SpawnPty` injection; live it needs the real build. If a live session fails to spawn with a node-pty load error, run `cd apps/desktop && pnpm run rebuild:natives`.
- **Claude CLI on PATH** is required for a live session (`resolveClaudeBin` honors `HOLI_CLAUDE_BIN`). GUI-launched Electron ships a stripped PATH; `buildAgentEnv` preserves PATH/HOME.
- **Live app:** dev instance on CDP 9333, driver `/tmp/holi-drive.mjs`. **Renderer edits hot-reload; main edits (agent-manager, agent-ipc, index, preload, new modules) need a relaunch** — ask the user to relaunch (it pops a window) or to run it via `! <cmd>`. Confirm whether the dev app is running before assuming.
- **Scoped teardown only:** `pkill -f "better-holi-final/node_modules/.pnpm/electron@"` — never bare `pkill electron` (this agent's own host is Electron).
- **Commit trailer:** end every commit message with `Claude goes brr.. via Dash`.

## File Structure

- **Modify** `apps/desktop/src/main/agent/agent-runtime.ts` — make `buildAgentArgs`' system prompt optional; omit the flag when empty.
- **Modify** `apps/desktop/test/agent-runtime.test.ts` — add the empty-prompt case.
- **Rewrite** `apps/desktop/src/main/agent/context-snapshot.ts` — shrink to a focus writer (focused/open paths only).
- **Rewrite** `apps/desktop/src/main/agent/agent-manager.ts` — against `VaultHost`; drop the observer / turn protocol / system prompt.
- **Rewrite** `apps/desktop/test/agent-manager.test.ts` — fake `VaultHost`, new expectations.
- **Delete** `apps/desktop/src/main/agent/system-prompt.ts` and `apps/desktop/test/system-prompt.test.ts`.
- **Create** `apps/desktop/src/main/agent-ipc.ts` — `registerAgentIpc({ agent })`: the `agent-pty:*` / `agent:*` channels.
- **Modify** `apps/desktop/src/main/index.ts` — instantiate `createAgentManager` + `registerAgentIpc`; dispose on quit; update the stale "agent is not wired up" comment.
- **Modify** `apps/desktop/src/preload/index.ts` — add the `window.holi.agent` surface.
- **Modify** `apps/desktop/src/renderer/src/global.d.ts` — type `window.holi.agent`; update the "`agent.*` is gone" comment.
- **Modify** `apps/desktop/src/renderer/src/components/AgentPanel.tsx` — `activeVaultIdAtom` → `activeRemoteAtom`.
- **Modify** `apps/desktop/src/renderer/src/components/Shell.tsx` — mount `<AgentPanel/>`, ⌘J toggle, the focus-push effect; update the "no ⌘J" comment.
- **Modify** `apps/desktop/src/main/agent/hooks/user-prompt-submit.mjs` — trim to the focused-note line only.

---

## Task 0: Baseline

Establish the real numbers before touching anything, so every later gate is a comparison, not a guess.

- [ ] **Step 1: Capture the counts**

```bash
cd /Users/nicolaibthomsen/repos/syv/better-holi-final/apps/desktop
pnpm exec node node_modules/typescript/bin/tsc --noEmit 2>&1 | grep -c "error TS"   # expect 36
pnpm exec vitest run 2>&1 | tail -3                                                  # note the desktop total (expected 626)
```

Record the desktop total. Every "expected" test count below assumes 626; if the real baseline differs, apply the same **−13 −15 +11 +1** delta.

---

## Task 1: `buildAgentArgs` — bare, no system prompt

This is an **interactive terminal** Claude Code session, not a headless/`--print` run, and Holi builds no prompt content — so it passes **no** `--append-system-prompt` at all. `systemPrompt` is dropped from `buildAgentArgs` entirely (not just emptied): nothing injects a system prompt, and slice 3's reconcile flow seeds a first *user* message via a PTY write, not a system prompt. `buildAgentArgs` reduces to the `resume` flag.

> **Done as implemented** (commit `3562efa`): the version that kept an optional `systemPrompt` was cut after review — an optional prompt param on an interactive session is dead code and misleadingly implies Holi injects prompts.

**Files:**
- Modify: `apps/desktop/src/main/agent/agent-runtime.ts:59-74`
- Test: `apps/desktop/test/agent-runtime.test.ts:105`

- [ ] **Step 1: Rewrite the `buildAgentArgs` test block**

In `apps/desktop/test/agent-runtime.test.ts`, replace the whole `describe('buildAgentArgs', …)` block with (drops the prompt-appending cases; asserts the bare shape):

```ts
describe('buildAgentArgs', () => {
  it('is bare by default — no prompt, no flags (interactive Claude Code)', () => {
    expect(buildAgentArgs()).toEqual([])
  })

  it('never passes --append-system-prompt (Holi builds no prompt content)', () => {
    expect(buildAgentArgs()).not.toContain('--append-system-prompt')
    expect(buildAgentArgs({ resume: true })).not.toContain('--append-system-prompt')
  })

  it('declares no MCP config, and does not suppress the vault own (D60)', () => {
    const args = buildAgentArgs({ resume: true })
    expect(args).not.toContain('--mcp-config')
    // --strict-mcp-config would also disable MCP servers the VAULT configures
    // natively in .claude/, which it is entitled to do.
    expect(args).not.toContain('--strict-mcp-config')
  })

  it('adds a bare --resume when asked (the CLI shows its native picker)', () => {
    expect(buildAgentArgs({ resume: true })).toEqual(['--resume'])
  })

  it('never passes --dangerously-skip-permissions', () => {
    for (const resume of [true, false]) {
      expect(buildAgentArgs({ resume })).not.toContain('--dangerously-skip-permissions')
    }
  })
})
```

- [ ] **Step 2: Run it, verify it fails**

Run: `cd apps/desktop && pnpm exec vitest run test/agent-runtime.test.ts`
Expected: FAIL — today `buildAgentArgs()` throws (destructures a required arg).

- [ ] **Step 3: Implement**

In `apps/desktop/src/main/agent/agent-runtime.ts`, replace the `AgentArgs` interface and `buildAgentArgs` (lines 59-74) with:

```ts
export interface AgentArgs {
  /** Bare `--resume` — the CLI shows its own session picker in the terminal. */
  resume?: boolean
}

/**
 * The interactive `claude` invocation — deliberately bare. This is a normal
 * terminal session, not a headless/`--print` run. Holi builds no prompt content,
 * so there is NO `--append-system-prompt`: vault conventions live in `AGENTS.md`,
 * which Claude Code reads natively from the cwd (prd/agent.md §Per-turn). And no
 * `--mcp-config`/`--strict-mcp-config` — Holi declares no MCP servers, and
 * `--strict-mcp-config` would additionally suppress any the *vault* configures
 * natively in `.claude/`, which it is entitled to do.
 */
export function buildAgentArgs({ resume }: AgentArgs = {}): string[] {
  return resume ? ['--resume'] : []
}
```

- [ ] **Step 4: Run it, verify it passes**

Run: `cd apps/desktop && pnpm exec vitest run test/agent-runtime.test.ts`
Expected: PASS (18 tests — was 17; the prompt-appending cases are replaced by bare-shape cases, net +1).

- [ ] **Step 5: Commit**

```bash
cd /Users/nicolaibthomsen/repos/syv/better-holi-final
git add apps/desktop/src/main/agent/agent-runtime.ts apps/desktop/test/agent-runtime.test.ts
git commit -m "feat(agent): buildAgentArgs is bare — no --append-system-prompt (interactive CC, no prompt content)

Claude goes brr.. via Dash"
```

---

## Task 2: The focus writer — shrink `context-snapshot.ts`

The old snapshot fetched related tasks and backrefs from a server that is gone (its 3 typecheck errors are `Task.related`/`Task.id` — fields that no longer exist). The agent discovers those itself now (`Glob`/`grep`). The writer shrinks to the one thing the agent genuinely cannot see: editor focus.

**Files:**
- Rewrite: `apps/desktop/src/main/agent/context-snapshot.ts`

- [ ] **Step 1: Replace the file**

Replace the entire contents of `apps/desktop/src/main/agent/context-snapshot.ts` with:

```ts
/**
 * The per-turn focus file the UserPromptSubmit hook reads: the note the user has
 * focused in the editor, written to `.holi/context.local.json` in the vault's
 * clone. This is the ONE piece of per-turn state the agent cannot discover
 * itself (it is editor-UI focus, which only Holi holds); tasks, backreferences
 * and sync state the agent finds with its own native tools, and vault
 * conventions live in AGENTS.md (prd/agent.md §Per-turn context).
 *
 * `*.local.*` is local-only (isLocalOnlyPath in shared), so the mirror never
 * adopts this file as a vault doc and it never syncs. Writes are debounced and
 * atomic: a stale focus line is fine, a hook that blocks a turn is not.
 */
import { vaultRelPath } from '@holi/shared'
import { writeAtomic } from '../vault/vault-files'

export const CONTEXT_FILE = '.holi/context.local.json'

export interface FocusInput {
  focusedPath: string | null
  openPaths: string[]
}

export interface ContextFile {
  focusedPath: string | null
  openPaths: string[]
  updatedAt: string
}

export class ContextSnapshot {
  private focus: FocusInput = { focusedPath: null, openPaths: [] }
  private timer: ReturnType<typeof setTimeout> | null = null
  private pending: Promise<void> | null = null
  private stopped = false
  private readonly debounceMs: number
  private readonly log: (msg: string) => void

  constructor(
    private readonly deps: { workRoot: string; debounceMs?: number; log?: (msg: string) => void },
  ) {
    this.debounceMs = deps.debounceMs ?? 150
    this.log = deps.log ?? ((msg) => console.log(`[context] ${msg}`))
  }

  setFocus(focus: FocusInput): void {
    this.focus = focus
    this.schedule()
  }

  /** Write now (tests, and before a session starts). */
  async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    await this.pending // don't race an in-flight write
    if (this.stopped) return
    this.pending = this.write()
    await this.pending
  }

  stop(): void {
    this.stopped = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }

  private schedule(): void {
    if (this.stopped) return
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      this.timer = null
      this.pending = this.write().catch((err) => this.log(`snapshot write failed: ${err}`))
    }, this.debounceMs)
  }

  private async write(): Promise<void> {
    const context: ContextFile = {
      focusedPath: this.focus.focusedPath,
      openPaths: this.focus.openPaths,
      updatedAt: new Date().toISOString(),
    }
    await writeAtomic(this.deps.workRoot, vaultRelPath(CONTEXT_FILE), `${JSON.stringify(context, null, 2)}\n`)
  }
}
```

- [ ] **Step 2: Typecheck the module in isolation**

The manager still imports the old `ContextSnapshot` constructor shape at this point, so a full typecheck will show manager errors — that's expected; Task 3 fixes them. Just confirm the file itself has no unresolved imports:

Run: `cd apps/desktop && pnpm exec node node_modules/typescript/bin/tsc --noEmit 2>&1 | grep "context-snapshot.ts"`
Expected: **no output** (the 3 `Task.*` errors are gone; no new ones).

(No commit yet — this file and Task 3's manager rewrite land together, since the manager constructs `ContextSnapshot`.)

---

## Task 3: Rewrite the manager against `VaultHost`; delete the system prompt

The heart of the slice. The manager loses everything that talked to the deleted vault abstraction (observer, turn protocol, mirror bridges, system prompt) and keeps what is D60-clean: the `AgentRuntime` (PTY), the `TerminalMirror` (record), attach/write/resize/kill/status, and now a session-bound focus writer. Its vault coupling becomes a single `VaultHost.active()` read.

**Files:**
- Rewrite: `apps/desktop/src/main/agent/agent-manager.ts`
- Rewrite: `apps/desktop/test/agent-manager.test.ts`
- Delete: `apps/desktop/src/main/agent/system-prompt.ts`, `apps/desktop/test/system-prompt.test.ts`

- [ ] **Step 1: Replace the manager**

Replace the entire contents of `apps/desktop/src/main/agent/agent-manager.ts` with:

```ts
/**
 * Session orchestration: owns the one live `claude` session — its PTY, its
 * terminal mirror, and the focus file the per-turn hook reads — and ties it to
 * the active vault.
 *
 * Pure Claude Code (prd/agent.md): no MCP surface, no built system prompt, no
 * turn protocol, no presence. The agent's whole surface is its native tools on
 * the vault's files; Holi's only per-turn injection is the focused-note line,
 * written by the focus writer. The vault coupling is a single `VaultHost.active()`
 * read — the clone dir is the cwd, and its being a real git repo is why the
 * agent can run git against it directly.
 *
 * NOTE: no runtime `electron` import (types only). The window arrives through
 * `getWindow()`, so this module loads under vitest.
 */
import type { BrowserWindow } from 'electron'
import type { VaultHost } from '../vault/active-vault'
import {
  AgentRuntime,
  buildAgentArgs,
  buildAgentEnv,
  isClaudeAuthenticated,
  resolveClaudeBin,
  type SpawnPty,
} from './agent-runtime'
import { ContextSnapshot, type FocusInput } from './context-snapshot'
import { TerminalMirror } from './terminal-mirror'

/** The panel fits and resizes immediately after start; this is just the seed. */
const SPAWN_COLS = 80
const SPAWN_ROWS = 24

export interface AgentStatus {
  running: boolean
  /** A turn is open — Claude is mid-edit. Wired from PTY activity in slice 2
   *  (git coexistence); false for now. */
  working: boolean
  /** Synced agent config changed under a live session. Its D60 detection source
   *  was deleted; a "restart to pick up config" nudge is a PRD open question, so
   *  false for now. */
  configStale: boolean
  authenticated: boolean
}

export interface AgentManagerDeps {
  host: VaultHost
  getWindow(): BrowserWindow | null
  spawnPty?: SpawnPty
  resolveBin?: () => string | null
  killGraceMs?: number
  log?: (msg: string) => void
}

export interface AgentManager {
  start(args: { vaultId: string; resume?: boolean }): Promise<{ ok: true }>
  write(data: string): void
  resize(cols: number, rows: number): void
  kill(): Promise<{ ok: true }>
  /** Renderer (re)attach: replayable terminal state, and open the data tap. */
  attach(): Promise<string>
  setFocus(focus: FocusInput): void
  status(): AgentStatus
  dispose(): Promise<void>
}

interface Session {
  vaultId: string
  runtime: AgentRuntime
  mirror: TerminalMirror
  snapshot: ContextSnapshot
}

export function createAgentManager(deps: AgentManagerDeps): AgentManager {
  const log = deps.log ?? ((msg: string) => console.log(`[agent] ${msg}`))
  const resolveBin = deps.resolveBin ?? (() => resolveClaudeBin())

  let session: Session | null = null
  /** False until a renderer has taken the terminal state: PTY output goes to
   * the mirror only, so nothing is streamed to a window that can't show it —
   * and nothing arrives twice on attach. */
  let attached = false

  const send = (channel: string, payload: unknown) => {
    deps.getWindow()?.webContents.send(channel, payload)
  }

  const status = (): AgentStatus => ({
    running: session !== null,
    working: false,
    configStale: false,
    authenticated: isClaudeAuthenticated(),
  })

  const pushStatus = () => send('agent:status', status())

  async function teardown(): Promise<void> {
    const current = session
    if (!current) return
    session = null // guard the double-stop: the PTY exit path tears down too
    attached = false
    current.snapshot.stop()
    await current.runtime.kill()
    current.mirror.dispose()
  }

  async function start({ vaultId, resume }: { vaultId: string; resume?: boolean }): Promise<{ ok: true }> {
    const vault = deps.host.active()
    if (!vault || vault.remote !== vaultId) {
      throw new Error('vault is not active — open it first')
    }

    await teardown() // restart semantics: one session at a time

    const bin = resolveBin()
    if (!bin) {
      throw new Error('Claude CLI not found on PATH — install it (https://claude.com/claude-code) and restart Holi')
    }

    const workRoot = vault.root
    const terminal = new TerminalMirror(SPAWN_COLS, SPAWN_ROWS)
    const snapshot = new ContextSnapshot({ workRoot })
    const runtime = new AgentRuntime({ spawnPty: deps.spawnPty, killGraceMs: deps.killGraceMs })
    runtime.onData((data) => {
      terminal.write(data) // the mirror is the record; the renderer is a view
      if (attached) send('agent-pty:data', data)
    })
    runtime.onExit((e) => {
      log(`session exited (code ${e.exitCode})`)
      send('agent-pty:exit', { code: e.exitCode })
      void teardown().then(pushStatus)
    })

    try {
      runtime.start({
        bin,
        args: buildAgentArgs({ resume }), // no systemPrompt — pure Claude Code
        cwd: workRoot,
        env: buildAgentEnv(process.env),
        cols: SPAWN_COLS,
        rows: SPAWN_ROWS,
      })
    } catch (err) {
      snapshot.stop()
      terminal.dispose()
      throw err
    }

    session = { vaultId, runtime, mirror: terminal, snapshot }
    pushStatus()
    return { ok: true }
  }

  /**
   * A renderer is taking over the terminal. Serialize BEFORE opening the tap:
   * a chunk that lands mid-serialize goes to the mirror only and repaints on
   * the next output — it is never both replayed and streamed.
   */
  async function attach(): Promise<string> {
    if (!session) return ''
    const state = await session.mirror.serialize()
    attached = true
    return state
  }

  return {
    start,
    attach,
    write: (data) => session?.runtime.write(data),
    resize: (cols, rows) => {
      if (!session) return
      session.runtime.resize(cols, rows)
      session.mirror.resize(cols, rows) // the record reflows with the view
    },
    kill: async () => {
      await teardown()
      pushStatus()
      return { ok: true }
    },
    // Focus is session-bound: the hook only matters while a session runs, and the
    // writer targets the session's clone. Before a session starts this no-ops.
    setFocus: (focus) => session?.snapshot.setFocus(focus),
    status,
    dispose: async () => {
      await teardown()
    },
  }
}
```

- [ ] **Step 2: Delete the system prompt and its test**

```bash
cd /Users/nicolaibthomsen/repos/syv/better-holi-final
git rm apps/desktop/src/main/agent/system-prompt.ts apps/desktop/test/system-prompt.test.ts
```

- [ ] **Step 3: Rewrite the manager test**

Replace the entire contents of `apps/desktop/test/agent-manager.test.ts` with:

```ts
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createAgentManager, type AgentManager } from '../src/main/agent/agent-manager'
import { CONTEXT_FILE } from '../src/main/agent/context-snapshot'
import type { PtyProcess } from '../src/main/agent/agent-runtime'
import type { ActiveVault, VaultHost } from '../src/main/vault/active-vault'

const VAULT = 'owner/repo'
const NOTE_PATH = 'notes/plan.md'

class FakePty implements PtyProcess {
  readonly writes: string[] = []
  readonly resizes: Array<[number, number]> = []
  private dataCb: ((d: string) => void) | null = null
  private exitCb: ((e: { exitCode: number }) => void) | null = null
  constructor(readonly pid = 999_999) {}
  onData(cb: (d: string) => void) {
    this.dataCb = cb
  }
  onExit(cb: (e: { exitCode: number }) => void) {
    this.exitCb = cb
  }
  write(d: string) {
    this.writes.push(d)
  }
  resize(c: number, r: number) {
    this.resizes.push([c, r])
  }
  kill() {
    this.exitCb?.({ exitCode: 0 })
  }
  emit(d: string) {
    this.dataCb?.(d)
  }
  exit(code = 0) {
    this.exitCb?.({ exitCode: code })
  }
}

interface Rig {
  manager: AgentManager
  workRoot: string
  sent: Array<{ channel: string; payload: any }>
  spawns: Array<{ file: string; args: string[]; opts: { cwd: string; env: Record<string, string> } }>
  host: { setActive(v: string | null): void }
  pty(): FakePty
}

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const fn of cleanups.splice(0)) await fn()
})

async function rig(opts: { bin?: string | null; active?: string | null } = {}): Promise<Rig> {
  const dir = await mkdtemp(join(tmpdir(), 'holi-am-'))
  const workRoot = join(dir, 'work')
  await mkdir(workRoot, { recursive: true })
  await mkdir(join(workRoot, '.holi'), { recursive: true })

  const sent: Rig['sent'] = []
  const spawns: Rig['spawns'] = []
  const ptys: FakePty[] = []

  let activeRemote: string | null = opts.active === undefined ? VAULT : opts.active
  const host = {
    active: (): ActiveVault | null =>
      activeRemote === null ? null : ({ remote: activeRemote, root: workRoot } as unknown as ActiveVault),
    open: async () => {
      throw new Error('not used in these tests')
    },
    close: async () => {},
    setActive: (v: string | null) => (activeRemote = v),
  } as unknown as VaultHost & { setActive(v: string | null): void }

  const manager = createAgentManager({
    host,
    getWindow: () =>
      ({ webContents: { send: (channel: string, payload: unknown) => sent.push({ channel, payload }) } }) as never,
    spawnPty: (file, args, o) => {
      const pty = new FakePty()
      ptys.push(pty)
      spawns.push({ file, args, opts: o as never })
      return pty
    },
    resolveBin: () => (opts.bin === undefined ? '/bin/fake-claude' : opts.bin),
    killGraceMs: 20,
    log: () => {},
  })

  cleanups.push(async () => {
    await manager.dispose()
    await rm(dir, { recursive: true, force: true })
  })

  return { manager, workRoot, sent, spawns, host, pty: () => ptys.at(-1)! }
}

describe('AgentManager', () => {
  it('spawns claude in the working dir with no system prompt and no skip-permissions', async () => {
    const r = await rig()
    await r.manager.start({ vaultId: VAULT })

    const spawn = r.spawns[0]!
    expect(spawn.file).toBe('/bin/fake-claude')
    expect(spawn.opts.cwd).toBe(r.workRoot)
    expect(spawn.args).not.toContain('--dangerously-skip-permissions')
    expect(spawn.args).not.toContain('--append-system-prompt') // pure Claude Code
    expect(r.manager.status().running).toBe(true)
  })

  it('declares no MCP surface and hands the child no bearer (D60)', async () => {
    const r = await rig()
    await r.manager.start({ vaultId: VAULT })

    const spawn = r.spawns[0]!
    expect(spawn.args).not.toContain('--mcp-config')
    expect(spawn.args).not.toContain('--strict-mcp-config')
    expect(spawn.opts.env.HOLI_AGENT_ENDPOINT).toBeUndefined()
    expect(spawn.opts.env.HOLI_AGENT_TOKEN).toBeUndefined()
  })

  it('holds PTY output in the mirror until a renderer attaches, then streams', async () => {
    const r = await rig()
    await r.manager.start({ vaultId: VAULT })

    r.pty().emit('before the panel mounted\r\n')
    expect(r.sent.filter((s) => s.channel === 'agent-pty:data')).toEqual([])

    const replayed = await r.manager.attach()
    expect(replayed).toContain('before the panel mounted')

    r.pty().emit('after attach')
    expect(r.sent.filter((s) => s.channel === 'agent-pty:data')).toEqual([
      { channel: 'agent-pty:data', payload: 'after attach' },
    ])
  })

  it('attach on a dead session is empty, and a restart starts a fresh mirror', async () => {
    const r = await rig()
    expect(await r.manager.attach()).toBe('')

    await r.manager.start({ vaultId: VAULT })
    r.pty().emit('first session\r\n')
    expect(await r.manager.attach()).toContain('first session')

    await r.manager.start({ vaultId: VAULT }) // restart
    r.pty().emit('second session\r\n')
    const replayed = await r.manager.attach()
    expect(replayed).toContain('second session')
    expect(replayed).not.toContain('first session') // the old mirror died with the PTY
  })

  it('forwards PTY data and exit to the renderer, and tears the session down on exit', async () => {
    const r = await rig()
    await r.manager.start({ vaultId: VAULT })
    await r.manager.attach()

    r.pty().emit('hello from claude')
    expect(r.sent).toContainEqual({ channel: 'agent-pty:data', payload: 'hello from claude' })

    r.pty().exit(3)
    expect(r.sent).toContainEqual({ channel: 'agent-pty:exit', payload: { code: 3 } })
    await new Promise((res) => setTimeout(res, 50))
    expect(r.manager.status().running).toBe(false)
  })

  it('write and resize reach the PTY; a restart kills the prior session', async () => {
    const r = await rig()
    await r.manager.start({ vaultId: VAULT })
    const first = r.pty()
    r.manager.write('hi\r')
    r.manager.resize(100, 30)
    expect(first.writes).toEqual(['hi\r'])
    expect(first.resizes).toEqual([[100, 30]])

    await r.manager.start({ vaultId: VAULT })
    expect(r.spawns).toHaveLength(2)
    expect(r.pty()).not.toBe(first)
    expect(r.manager.status().running).toBe(true)
  })

  it('kill tears the session down and reports not running', async () => {
    const r = await rig()
    await r.manager.start({ vaultId: VAULT })
    expect(r.manager.status().running).toBe(true)

    await r.manager.kill()
    expect(r.manager.status().running).toBe(false)
    expect(r.sent.filter((s) => s.channel === 'agent:status').at(-1)!.payload.running).toBe(false)
  })

  it('setFocus writes the focus file the hook reads — focused path only', async () => {
    const r = await rig()
    await r.manager.start({ vaultId: VAULT })
    r.manager.setFocus({ focusedPath: NOTE_PATH, openPaths: [NOTE_PATH] })

    await new Promise((res) => setTimeout(res, 300))
    const raw = await readFile(join(r.workRoot, CONTEXT_FILE), 'utf8')
    const ctx = JSON.parse(raw)
    expect(ctx.focusedPath).toBe(NOTE_PATH)
    expect(ctx.openPaths).toEqual([NOTE_PATH])
    // the D60 writer carries no server-derived context
    expect(raw).not.toContain('relatedTasks')
    expect(raw).not.toContain('backrefPaths')
  })

  it('setFocus before a session is a no-op (no throw, no file)', async () => {
    const r = await rig()
    r.manager.setFocus({ focusedPath: NOTE_PATH, openPaths: [] })
    await new Promise((res) => setTimeout(res, 200))
    await expect(readFile(join(r.workRoot, CONTEXT_FILE), 'utf8')).rejects.toThrow()
  })

  it('fails readably when the CLI is missing', async () => {
    const r = await rig({ bin: null })
    await expect(r.manager.start({ vaultId: VAULT })).rejects.toThrow(/Claude CLI not found on PATH/)
    expect(r.manager.status().running).toBe(false)
  })

  it('refuses to start against a vault that is not active', async () => {
    const r = await rig()
    await expect(r.manager.start({ vaultId: 'someone/else' })).rejects.toThrow(/not active/)
    r.host.setActive(null)
    await expect(r.manager.start({ vaultId: VAULT })).rejects.toThrow(/not active/)
  })
})
```

- [ ] **Step 4: Run the agent suite**

Run: `cd apps/desktop && pnpm exec vitest run test/agent-manager.test.ts test/agent-runtime.test.ts`
Expected: PASS — 11 (manager) + 18 (runtime) = **29 tests**.

- [ ] **Step 5: Typecheck — main should be clean of agent errors now**

Run: `cd apps/desktop && pnpm exec node node_modules/typescript/bin/tsc --noEmit 2>&1 | grep -E "agent-manager|context-snapshot|system-prompt"`
Expected: **no output**. (The manager's 7 errors and context-snapshot's 3 are gone; system-prompt.ts no longer exists.)

- [ ] **Step 6: Commit**

```bash
cd /Users/nicolaibthomsen/repos/syv/better-holi-final
git add apps/desktop/src/main/agent/agent-manager.ts apps/desktop/src/main/agent/context-snapshot.ts apps/desktop/test/agent-manager.test.ts
git commit -m "feat(agent): rewrite the manager against VaultHost — pure CC, focus-only, no turn protocol

Drops the deleted server-client/VaultManager/VaultMirror abstraction and the
built system prompt (D60). One session tied to host.active(); the only per-turn
injection is the focused-note line via the shrunken focus writer.

Claude goes brr.. via Dash"
```

---

## Task 4: The agent IPC seam (main)

The session is a live byte stream, not a request/response router, so it does not ride the tRPC channel in `ipc.ts`. A dedicated module registers the `agent-pty:*` / `agent:*` channels named in the PRD's wire-shape table. `start` is the one that can throw (no CLI, wrong vault); the drawer wants a message, not an unhandled rejection, so the handler maps a throw to `{ ok: false, message }` — the exact shape `AgentPanel` already checks.

**Files:**
- Create: `apps/desktop/src/main/agent-ipc.ts`

- [ ] **Step 1: Write the module**

Create `apps/desktop/src/main/agent-ipc.ts`:

```ts
/**
 * The agent's IPC seam — distinct from the tRPC seam in `ipc.ts`. The session is
 * a live byte stream: PTY data/exit and status are pushed out to the renderer by
 * the manager (`agent-pty:data`, `agent-pty:exit`, `agent:status`); keystrokes,
 * resize and focus are pushed in; start/kill/attach/status are request/response.
 * Channel names mirror prd/agent.md's wire shape.
 */
import { ipcMain } from 'electron'
import type { AgentManager, AgentStatus } from './agent/agent-manager'
import type { FocusInput } from './agent/context-snapshot'

export function registerAgentIpc(deps: { agent: AgentManager }): void {
  const { agent } = deps

  // The manager throws on a bad start (no CLI, vault not active). The drawer
  // wants a message it can print in red, not an IPC rejection — so tag it.
  ipcMain.handle(
    'agent-pty:start',
    async (
      _e,
      args: { vaultId: string; resume?: boolean },
    ): Promise<{ ok: boolean; message?: string }> => {
      try {
        return await agent.start(args)
      } catch (err) {
        return { ok: false, message: err instanceof Error ? err.message : String(err) }
      }
    },
  )

  ipcMain.handle('agent-pty:kill', () => agent.kill())
  ipcMain.handle('agent:attach', () => agent.attach())
  ipcMain.handle('agent:status', (): AgentStatus => agent.status())

  ipcMain.on('agent-pty:write', (_e, data: string) => agent.write(data))
  ipcMain.on('agent-pty:resize', (_e, size: { cols: number; rows: number }) =>
    agent.resize(size.cols, size.rows),
  )
  ipcMain.on('agent:focus', (_e, focus: FocusInput) => agent.setFocus(focus))
}
```

- [ ] **Step 2: Typecheck**

Run: `cd apps/desktop && pnpm exec node node_modules/typescript/bin/tsc --noEmit 2>&1 | grep "agent-ipc"`
Expected: **no output** (it is not yet imported anywhere; typecheck just confirms it is internally sound).

(No commit yet — it wires into `index.ts` in Task 5, and a registered-but-unused module is nothing to demonstrate on its own.)

---

## Task 5: Instantiate the manager and wire the seam in `index.ts`

The one import that kept the agent off the startup path is gone (Task 3), so `createAgentManager` can finally be constructed and its IPC registered. `getWindow` is a lazy closure over the module-level `mainWindow` (read on each send), so registering the seam before the window exists is fine — the window is up long before the agent sends anything. Dispose the session on quit so the `claude` process group dies with the app.

**Files:**
- Modify: `apps/desktop/src/main/index.ts`

- [ ] **Step 1: Add the imports**

In `apps/desktop/src/main/index.ts`, beside the other `./` imports (~line 20-24), add:

```ts
import { createAgentManager } from './agent/agent-manager'
import { registerAgentIpc } from './agent-ipc'
```

- [ ] **Step 2: Instantiate after `registerIpc`**

In `main()`, immediately after `registerIpc({ router })` (line 139), add:

```ts
  // The vault agent: one live `claude` per user, in the active vault's clone.
  // `getWindow` is lazy — the window is created just below and is up long before
  // the agent streams anything, so registering the seam here is safe.
  const agent = createAgentManager({ host, getWindow: () => mainWindow })
  registerAgentIpc({ agent })
```

- [ ] **Step 3: Dispose on quit**

In the `before-quit` handler's `try` block, as the FIRST step inside it (before `requestFlush`, ~line 174), add:

```ts
        // Kill the agent's PTY (and its process group) before we flush and
        // commit — nothing the session was mid-writing should race the teardown.
        await agent.dispose().catch((err) => console.error('[quit] agent dispose failed:', err))
```

- [ ] **Step 4: Update the stale module comment**

Replace the last paragraph of the top-of-file doc comment (lines 10-13, the "That is why the agent is not wired up…" sentence) with:

```ts
 * The agent is wired here: `createAgentManager` over the vault `host`, its
 * `agent-pty:*`/`agent:*` seam registered alongside the tRPC one. It sits after
 * the router because it shares the host, and before the window because its
 * `getWindow` closure reads `mainWindow` lazily.
```

- [ ] **Step 5: Typecheck + build (the real import-graph check)**

Run: `cd apps/desktop && pnpm exec node node_modules/typescript/bin/tsc --noEmit 2>&1 | grep -c "error TS"`
Expected: a count **≤ 6 + renderer-agent errors** — main is clean; the only agent errors left are in the renderer (`AgentPanel.tsx`), fixed in Tasks 6-7.

Run: `cd apps/desktop && pnpm exec electron-vite build 2>&1 | tail -5`
Expected: builds with no unresolved-import error. This is the proof the manager's import graph (no more `server-client`/`vault-manager`/`vault-mirror`) actually resolves in the main bundle.

- [ ] **Step 6: Commit**

```bash
cd /Users/nicolaibthomsen/repos/syv/better-holi-final
git add apps/desktop/src/main/agent-ipc.ts apps/desktop/src/main/index.ts
git commit -m "feat(agent): instantiate the manager + register the agent IPC seam in main

Claude goes brr.. via Dash"
```

---

## Task 6: The preload surface + renderer types

`AgentPanel` calls `window.holi.agent.*` (16 sites, all currently untyped errors). This exposes them: the three push channels (`onData`/`onExit`/`onStatus`) fan out from one `ipcRenderer` listener each (the house pattern), and the commands are `invoke` (need a reply) or `send` (fire-and-forget).

**Files:**
- Modify: `apps/desktop/src/preload/index.ts`
- Modify: `apps/desktop/src/renderer/src/global.d.ts`

- [ ] **Step 1: Add the preload channels + surface**

In `apps/desktop/src/preload/index.ts`, add three push channels beside `onFlushRequest` (~line 43):

```ts
/** PTY bytes for the drawer's xterm to decode. */
const onAgentData = pushChannel<Uint8Array | string>('agent-pty:data')
/** The session ended. */
const onAgentExit = pushChannel<{ code: number }>('agent-pty:exit')
/** running / working / configStale / authenticated — the header dot + hints. */
const onAgentStatus = pushChannel<unknown>('agent:status')
```

Add the `agent` surface to the `exposeInMainWorld('holi', {…})` object, after `showSaveDialog` (~line 56):

```ts
  agent: {
    onData: onAgentData,
    onExit: onAgentExit,
    onStatus: onAgentStatus,
    attach: (): Promise<string> => ipcRenderer.invoke('agent:attach'),
    status: () => ipcRenderer.invoke('agent:status'),
    start: (args: { vaultId: string; resume?: boolean }) => ipcRenderer.invoke('agent-pty:start', args),
    kill: () => ipcRenderer.invoke('agent-pty:kill'),
    write: (data: string) => ipcRenderer.send('agent-pty:write', data),
    resize: (cols: number, rows: number) => ipcRenderer.send('agent-pty:resize', { cols, rows }),
    setFocus: (focus: { focusedPath: string | null; openPaths: string[] }) =>
      ipcRenderer.send('agent:focus', focus),
  },
```

- [ ] **Step 2: Type the surface in `global.d.ts`**

In `apps/desktop/src/renderer/src/global.d.ts`, add the import beside the others (~line 3):

```ts
import type { AgentStatus } from './state/agent'
```

Replace the outdated sentence in the `holi` doc comment (line 12, "`agent.*` — is gone") — drop `agent.*` from that list since it is back. Then add the `agent` member to the `holi` interface, after `showSaveDialog` (~line 38):

```ts
      /**
       * The vault agent — a live Claude Code session in the drawer. A byte
       * stream, not tRPC: PTY output and status are pushed (`onData`/`onExit`/
       * `onStatus`, each returning its unsubscribe), keystrokes/resize/focus are
       * fire-and-forget, and start/kill/attach/status are request/response.
       */
      agent: {
        onData(cb: (data: Uint8Array | string) => void): () => void
        onExit(cb: (e: { code: number }) => void): () => void
        onStatus(cb: (status: AgentStatus) => void): () => void
        attach(): Promise<string>
        status(): Promise<AgentStatus>
        start(args: { vaultId: string; resume?: boolean }): Promise<{ ok: boolean; message?: string }>
        kill(): Promise<{ ok: true }>
        write(data: string): void
        resize(cols: number, rows: number): void
        setFocus(focus: { focusedPath: string | null; openPaths: string[] }): void
      }
```

- [ ] **Step 3: Typecheck — the `window.holi.agent` errors clear**

Run: `cd apps/desktop && pnpm exec node node_modules/typescript/bin/tsc --noEmit 2>&1 | grep "AgentPanel"`
Expected: only the `activeVaultIdAtom` error (line 12) remains — every `Property 'agent' does not exist` and its downstream implicit-anys are gone. Task 7 clears the last one.

- [ ] **Step 4: Commit**

```bash
cd /Users/nicolaibthomsen/repos/syv/better-holi-final
git add apps/desktop/src/preload/index.ts apps/desktop/src/renderer/src/global.d.ts
git commit -m "feat(agent): expose window.holi.agent — PTY stream + commands over IPC

Claude goes brr.. via Dash"
```

---

## Task 7: Mount the drawer — `activeRemoteAtom`, ⌘J, and the focus push

The last wiring: point `AgentPanel` at the real atom (a vault's identity is its remote under D60), mount it in `Shell`, bind ⌘J, and push editor focus to main so the hook has something to inject.

**Files:**
- Modify: `apps/desktop/src/renderer/src/components/AgentPanel.tsx`
- Modify: `apps/desktop/src/renderer/src/components/Shell.tsx`

- [ ] **Step 1: Fix the atom in `AgentPanel`**

In `apps/desktop/src/renderer/src/components/AgentPanel.tsx`:

Change the import (line 12) from:

```ts
import { activeVaultIdAtom } from '../state/vaults'
```

to:

```ts
import { activeRemoteAtom } from '../state/vaults'
```

Change the hook (line 35) from:

```ts
  const activeVaultId = useAtomValue(activeVaultIdAtom)
```

to:

```ts
  // A vault's identity is its remote (D60); it is the id the manager matches
  // against `host.active().remote`.
  const activeRemote = useAtomValue(activeRemoteAtom)
```

In `startSession` (lines 168-185), rename the two `activeVaultId` uses:

```ts
      if (!activeRemote || !term) return
```

```ts
      const res = await window.holi.agent.start({ vaultId: activeRemote, resume })
```

and update the `useCallback` dependency array (line 184) from `[activeVaultId, setStatus]` to `[activeRemote, setStatus]`.

- [ ] **Step 2: Mount the drawer + ⌘J + focus push in `Shell`**

In `apps/desktop/src/renderer/src/components/Shell.tsx`:

Add the imports — `AgentPanel` beside the other component imports (~line 27) and `agentPanelOpenAtom` beside the state imports (~line 42):

```ts
import { AgentPanel } from './AgentPanel'
```

```ts
import { agentPanelOpenAtom } from '../state/agent'
```

Add the toggle setter beside the other `useSetAtom` calls (~line 56):

```ts
  const setAgentOpen = useSetAtom(agentPanelOpenAtom)
```

Add two effects beside the existing ⌘⇧D effect (after line 92). The ⌘J toggle:

```ts
  // ⌘J toggles the agent drawer (prd/agent.md §Runtime).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'j') {
        e.preventDefault()
        setAgentOpen((v) => !v)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [setAgentOpen])
```

The focus push (place it after `const tab = activeTab(workspace)` and `const pane = …` are declared, ~line 96 — it depends on them):

```ts
  // Feed the agent's per-turn hook the focused note — the one piece of state it
  // cannot discover itself (editor-UI focus). Main writes it to
  // `.holi/context.local.json`; a no-op when no session is running.
  useEffect(() => {
    const focusedPath = tab?.kind === 'note' ? tab.path : null
    const openPaths = pane.tabs.flatMap((t) => (t.kind === 'note' ? [t.path] : []))
    window.holi.agent.setFocus({ focusedPath, openPaths })
  }, [tab, pane])
```

Render the drawer as a flex sibling of `<main>` — add it immediately after `</main>` (line 226), before `{showSettings && …}`:

```tsx
        <AgentPanel />
```

Update the stale comment: in the top-of-file doc comment, replace the paragraph beginning "The agent drawer is plan 6… There is deliberately no ⌘J…" (lines 14-15) with:

```ts
 * The agent drawer (⌘J) mounts here as a right-hand sibling of the editor; the
 * history panel and daily notes are plan 7.
```

- [ ] **Step 3: Typecheck — agent errors fully clear**

Run: `cd apps/desktop && pnpm exec node node_modules/typescript/bin/tsc --noEmit 2>&1 | grep -c "error TS"`
Expected: **6** — only the pre-existing `state/history.ts` errors remain. Confirm none mention `agent`, `AgentPanel`, or `activeVaultId`:

Run: `cd apps/desktop && pnpm exec node node_modules/typescript/bin/tsc --noEmit 2>&1 | grep -iE "agent|activeVaultId"`
Expected: **no output**.

- [ ] **Step 4: Commit**

```bash
cd /Users/nicolaibthomsen/repos/syv/better-holi-final
git add apps/desktop/src/renderer/src/components/AgentPanel.tsx apps/desktop/src/renderer/src/components/Shell.tsx
git commit -m "feat(agent): mount the drawer (⌘J), point at activeRemoteAtom, push editor focus

Claude goes brr.. via Dash"
```

---

## Task 8: Trim the per-turn hook to the focused-note line

The seeded `UserPromptSubmit` hook still prints memory fill-indicators, related tasks and backreferences — all D60-dead (the memory guidance lives in `AGENTS.md`; tasks/backrefs the agent finds natively). It shrinks to the one line the focus writer now feeds it.

**Files:**
- Modify: `apps/desktop/src/main/agent/hooks/user-prompt-submit.mjs`

- [ ] **Step 1: Replace the hook**

Replace the entire contents of `apps/desktop/src/main/agent/hooks/user-prompt-submit.mjs` with:

```js
#!/usr/bin/env node
// Holi UserPromptSubmit hook — injects the ONE piece of per-turn state the agent
// cannot discover itself: the note the user has focused in the editor. Tasks,
// backreferences and sync state the agent finds with its own native tools
// (Glob/grep/git); vault conventions and memory guidance live in AGENTS.md.
// See prd/agent.md §Per-turn context.
//
// Pure local read (<50 ms): Holi's main process keeps `.holi/context.local.json`
// current, so this never talks to a server. Outside Holi — or with nothing
// focused — the file is absent and it prints nothing.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const root = process.env.CLAUDE_PROJECT_DIR || process.cwd()

let context = null
try {
  context = JSON.parse(readFileSync(join(root, '.holi/context.local.json'), 'utf8'))
} catch {
  // no editor context (bare CLI, or nothing focused yet) — print nothing
}

if (context?.focusedPath) {
  process.stdout.write(`Focused note: \`${context.focusedPath}\` (use \`Read\` to view its contents)`)
}
process.exit(0)
```

- [ ] **Step 2: Confirm the seed test still passes**

The hook is seeded verbatim (`?raw`) into `SEED_FILES`, and `seed-content.test.ts` asserts the seeded file equals that value and that line 1 is a shebang — both hold (the shebang stays, the round-trip stays consistent). The pinned key list is unchanged.

Run: `cd apps/desktop && pnpm exec vitest run test/seed-content.test.ts 2>&1 | tail -6`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
cd /Users/nicolaibthomsen/repos/syv/better-holi-final
git add apps/desktop/src/main/agent/hooks/user-prompt-submit.mjs
git commit -m "feat(agent): trim UserPromptSubmit hook to the focused-note line (D60)

Claude goes brr.. via Dash"
```

---

## Task 9: Full gates + live verification

**Files:** none (verification only).

- [ ] **Step 1: Typecheck**

Run: `cd apps/desktop && pnpm exec node node_modules/typescript/bin/tsc --noEmit 2>&1 | grep -c "error TS"`
Expected: **6** (all `state/history.ts`, pre-existing).

- [ ] **Step 2: Desktop suite**

Run: `cd apps/desktop && pnpm exec vitest run 2>&1 | tail -6`
Expected: **610** if the Task 0 baseline was 626 (baseline −13 system-prompt −15 old-am +11 new-am +1 runtime). Confirm **no unexpected failures** — the only intended deltas are those files.

- [ ] **Step 3: Shared suite (untouched — confirm no drift)**

Run: `cd packages/shared && pnpm exec vitest run 2>&1 | tail -3`
Expected: **179**.

- [ ] **Step 4: Build**

Run: `cd apps/desktop && pnpm exec electron-vite build 2>&1 | tail -3`
Expected: clean build.

- [ ] **Step 5: Live (ask the user to relaunch — main changed)**

Every task touched main (`index.ts`, `agent-manager`, `agent-ipc`, `preload`) so the dev app needs a relaunch. Ask the user to relaunch the dev app (CDP 9333), or to run it via `! <cmd>`. Confirm `node-pty` is built for Electron (if the session fails to spawn with a native-module error, run `pnpm run rebuild:natives`) and that `claude` is on PATH (or `HOLI_CLAUDE_BIN` is set). Then, with a vault open:

1. Press **⌘J** → the right-hand drawer opens; the header dot goes green and a real `claude` TUI paints in the terminal (session spawned in the vault's clone dir).
2. Type a prompt like *"create a note `notes/agent-hello.md` with a one-line body"* and approve the native permission prompt → the file appears in the vault tree (the editor's watcher picks up the agent's write) and, being a normal file write, autosaves/commits like any edit.
3. Focus a note in the editor, then ask the agent *"what note am I looking at?"* → its answer reflects the `Focused note:` line (confirm `.holi/context.local.json` in the clone carries `focusedPath`).
4. Press **⌘J** again → the drawer hides but the session keeps running (dot stays green); reopen and the scrollback is intact (mirror replay on attach).
5. Restart (↻) and history (⟲ → `--resume` picker) buttons behave.

Report what actually happened, including whether `node-pty` needed a rebuild and whether the focus line showed up. If the session cannot spawn (no `claude` on the GUI app's PATH), that is the known packaged-PATH caveat — note it rather than treating it as a slice failure.

- [ ] **Step 6: Optional — record a short GIF of the flow** for the PR/handoff (⌘J → type → file appears), per repo norm for UI-visible changes.

---

## Final verification

- [ ] Typecheck **6**: `cd apps/desktop && pnpm exec node node_modules/typescript/bin/tsc --noEmit 2>&1 | grep -c "error TS"`
- [ ] Desktop **610** (or baseline + the stated delta): `cd apps/desktop && pnpm exec vitest run 2>&1 | tail -3`
- [ ] Shared **179**: `cd packages/shared && pnpm exec vitest run 2>&1 | tail -3`
- [ ] Build: `cd apps/desktop && pnpm exec electron-vite build 2>&1 | tail -3`
- [ ] Live (after relaunch): ⌘J opens a live `claude` in the vault clone; it creates/edits a file that lands in the tree; the focused-note line reaches the turn.

---

## Self-review (spec coverage)

- **Spine + strip stale machinery** (PRD build order §1) → Task 1 (empty prompt), Task 2 (focus writer), Task 3 (manager rewrite + delete system-prompt). The deleted `server-client`/`VaultManager`/`VaultMirror` coupling is replaced by a single `VaultHost.active()` read; the turn protocol / observer / presence are deleted, not ported (PRD §"The agent as merge resolver").
- **Empty `--append-system-prompt`** (PRD §Per-turn "Base system prompt — none") → Task 1 + Task 3 (`buildAgentArgs({ resume })`).
- **Focus-only per-turn hook** (PRD §Per-turn "one line, via a UserPromptSubmit hook") → Task 2 (writer), Task 7 (renderer focus push), Task 8 (hook trim). No fill-indicators, related-tasks, backrefs, or sync-state — all removed.
- **`agent` IPC/preload/types bridge** (PRD §Runtime wire shape) → Task 4 (main channels), Task 6 (preload + `global.d.ts`). Channel names match the PRD table (`agent-pty:{data,exit,start,write,resize,kill}` + `agent:status`), plus `agent:attach`/`agent:focus`.
- **Mount `AgentPanel` + ⌘J** (PRD §Runtime "toggled with ⌘J") → Task 7.
- **`createAgentManager` instantiated** (PRD §Wiring state) → Task 5.
- **`activeVaultIdAtom` → `activeRemoteAtom`** (PRD §Wiring state) → Task 7.
- **No `--dangerously-skip-permissions`, no MCP/bearer** (PRD §Runtime spawn, §Permissions) → asserted in Task 3's tests; `buildAgentEnv` (unchanged) still strips `CLAUDECODE`/`CLAUDE_CODE_ENTRYPOINT`.
- **Deferred to later slices (correctly absent here):** the `working` flag from PTY activity + Holi pausing its sync loop + `AGENTS.md` "git is yours" (slice 2); conflict detection → "Ask Claude to reconcile" → seeded `prompt` on `start` (slice 3); `$TYPST_BIN` + seeded `md-to-pdf` skill (slice 4).
- **Stated simplifications (not omissions):** `working`/`configStale` wired to `false` (sources deleted under D60; `working` returns in slice 2, config-drift is a PRD open question); vault-switch session lifecycle relies on restart-on-next-`start` rather than an active teardown signal (proper lifecycle folds into slice 2's coexistence work) — flagged so a reviewer does not read them as bugs.
- **Green-baseline discipline:** every task ends on a green gate; the manager/runtime tests injected fakes stay green through the rewrite; the typecheck baseline drops 36 → 6 (agent errors cleared) with no new errors, and the test-count change is the exact stated delta rather than a silent drift.
```