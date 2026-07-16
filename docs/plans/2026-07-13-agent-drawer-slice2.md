# Agent Drawer Slice 2 (The Drawer) Implementation Plan

> **For agentic workers:** Use the executing-plans skill to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. This plan gives contracts, decisions, and gotchas — you write the code. Specs and plans are working files: **never `git add` anything under `docs/`**.

**Goal:** The drawer itself, on the slice-1 foundations: interactive `claude` in a node-pty PTY rendered in an xterm.js right panel, a localhost MCP server (7 ops + hook-signal routes), hooks-primary turn signals, base-prompt + per-turn context injection, managed vault-doc seeding, and a fake-`claude` e2e.

**Architecture:** All new code in `apps/desktop`. Main gains `src/main/agent/*` (AgentRuntime, McpServer + ops, ContextSnapshot, system-prompt port, seed content + hook scripts) orchestrated by an `AgentManager` observing `VaultManager`; `DocBridge`/`VaultMirror` grow small public seams. Renderer gains `AgentPanel` docked right in `Shell`. Design: `docs/specs/2026-07-13-agent-drawer-design.md` (incl. the slice-1 deviations section — settled law). PRD: `docs/prd/agent.md`.

**Tech Stack:** node-pty ^1.0.0 (first native module; Electron-ABI rebuild via `@electron/rebuild`; vitest never loads it), @xterm/xterm ^5.5.0 + @xterm/addon-fit ^0.10.0, hand-rolled MCP streamable-HTTP on `node:http`, vitest with the existing relay harness (`test/helpers/relay.ts`).

**Environment:** everything through `pnpm` from repo root (bare `node`/`npx` broken — tests spawn `process.execPath`); Postgres on 5433 (`pnpm db:up`); a `tsx watch` server may already be running (EADDRINUSE = alive); scope any pkill to `better-holi-final.*electron`; relay test ports 5611–5613 taken — use **5614+**; commits end with `Claude goes brr.. via Dash`.

**Decisions made in this plan (record in the spec's deviations section in Task 11):**
1. **No login-PTY port.** Interactive CC handles `/login` in the same terminal; the auth probe (non-null `oauthAccount` in `~/.claude.json`, fallback `~/.claude/.claude.json` — the user's own config per the PRD, not the old app's custom CCD) only powers a header hint.
2. **MCP server is hand-rolled** streamable-HTTP JSON-RPC on `node:http` (POST-only `/mcp`, plain JSON responses, GET → 405). 7 tools + 2 hook routes don't justify a protocol SDK; consistent with the repo's hand-rolled SSE.
3. **Ops stay at 7 by folding:** `task_set` with `status:'done'` routes through `tasks.complete` (server rolls recurrence); `task_link` takes `remove:true` for unlink. Ops translate note paths↔docIds both ways — the agent never sees note UUIDs.
4. **Seeding rides the adoption path:** missing managed files are written into the working dir after `mirror.start()`; the watcher adopts them as vault docs like agent-created files. Idempotent via doc-list + disk checks; CONFLICT losers self-heal via `refresh()` (slice-1 deviation 5).
5. **PTY data crosses IPC as strings** (node-pty's native chunk type; xterm accepts them) — not the spec's `Uint8Array`.
6. **node-pty loads lazily** inside the real spawn path only; all tests inject a fake PTY (system-node vitest can't load an Electron-ABI native). Hook scripts are real `.mjs` files imported `?raw` into the seed table.
7. **Seam growth:** `DocBridge.signalTurnOpen()`; `VaultMirror` accessors + `onTurnActivity`/`onMaterialize` deps + `endOpenTurns()`; `VaultManager` `VaultObserver` + `activeVaultId()`/`activeMirror()`.
8. **Bare `--resume`** relaunch uses CC's native picker in xterm; judge ergonomics in the manual smoke before considering `--resume <id>` shortcuts (spec open item).

---

## File structure

Main (create): `src/main/agent/` — `system-prompt.ts`, `mcp-ops.ts`, `mcp-server.ts`, `agent-runtime.ts`, `context-snapshot.ts`, `seed-content.ts`, `agent-manager.ts`, `hooks/{pre-tool-use,stop,user-prompt-submit}.mjs`; plus `src/main/ambient.d.ts` (`*?raw` declaration) and `scripts/check-node-pty.cjs`.

Main (modify): `vault/doc-bridge.ts`, `vault/vault-mirror.ts`, `vault/vault-manager.ts`, `index.ts`, `ipc.ts`.

Renderer: create `components/AgentPanel.tsx`, `state/agent.ts`, `lib/agent-panel-geometry.ts`; modify `Shell.tsx`, `global.d.ts`, `preload/index.ts`.

E2E: `apps/desktop/e2e/fake-claude.mjs`, `apps/desktop/e2e/agent-smoke.ts`.

Tests: extend `test/doc-bridge.test.ts`; create `test/vault-mirror-agent.test.ts` (port 5614), `system-prompt.test.ts`, `mcp-ops.test.ts`, `mcp-server.test.ts`, `agent-runtime.test.ts`, `context-snapshot.test.ts`, `seed-content.test.ts`, `agent-manager.test.ts`, `agent-panel-geometry.test.ts`.

Every task is TDD: failing test → implement → green → commit. Run tests with `pnpm --filter @holi/desktop exec vitest run test/<file>`.

---

### Task 1: Deps + native-module plumbing

- [ ] Root `package.json`: `pnpm.onlyBuiltDependencies` gains `"node-pty"` (pnpm 10 blocks its gyp build otherwise).
- [ ] `apps/desktop/package.json`: deps `node-pty ^1.0.0`, `@xterm/xterm ^5.5.0`, `@xterm/addon-fit ^0.10.0`; devDep `@electron/rebuild ^3.7.0`; script `"rebuild:natives": "electron-rebuild -f -w node-pty"`. `pnpm install`.
- [ ] `pnpm --filter @holi/desktop rebuild:natives` → "Rebuild Complete".
- [ ] Add `scripts/check-node-pty.cjs` (spawn `/bin/echo` through node-pty, assert output) and verify the ABI: `ELECTRON_RUN_AS_NODE=1 pnpm exec electron scripts/check-node-pty.cjs` from `apps/desktop` — the Electron binary as node shares the ABI, so this catches a bad rebuild without booting the app.
- [ ] Commit: `chore(desktop): node-pty + xterm deps, Electron-ABI rebuild plumbing`

Fallback if `@electron/rebuild` fights pnpm: prebuilt fork `@lydell/node-pty` (same API) — record as a deviation.

### Task 2: Base system prompt port

Port `build_system_prompt` from `~/repos/holi/src-tauri/src/services/agent_context.rs` into `src/main/agent/system-prompt.ts`. Keep the old structure and porting rules; rewrite section text for the new system.

- Order: identity layers (**IDENTITY then SOUL**, read from working-copy `.claude/`, omitted when absent) → Tools → Asking the user → Agenda heuristics → Holi base (memory USER/MEMORY → when-to-save → skills → vault-system → conventions → output formatting → scripting → top-level tree), joined by `\n\n***\n\n`.
- Cap: 192,000 chars (48k tokens × 4) with the old truncation marker `[…truncated to 192,000 chars]` (en-US thousands separators).
- Spec-mandated adjustments: **drop** permission-mode and apps/html-widget sections; **retarget** memory guidance to native `Edit`s on `USER.md` (budget 4,000, machine-local) / `MEMORY.md` (budget 5,000, synced), skills to native edits under `.claude/skills/`, task/note guidance to the 7 `mcp__holi__*` ops + native file tools (`note_rename` rewrites `[[links]]` — never `mv`; tasks are server records — never task files; `task_list` filter is status-only). Mention live sync + "Claude is editing…" presence in the vault-system section. Asking-the-user targets native `AskUserQuestion`.
- `readVaultTree(root)`: top level + one descent into dirs, dot-entries skipped, sorted; rendered as indented bullets with `/` suffix on dirs.
- Export `USER_MD_BUDGET`/`MEMORY_MD_BUDGET`.

- [ ] Tests: section order (IDENTITY < SOUL < Tools), identity block omitted when empty, all headers present, dropped strings absent (`Permission mode`, `mcp__holi__memory_write`, `## Apps`), cap marker, tree reading/rendering.
- [ ] Commit: `feat(desktop): base system prompt port (build_system_prompt)`

### Task 3: Bridge + mirror agent seams

- [ ] `DocBridge.signalTurnOpen()` — the PreToolUse seam, symmetric with `signalTurnEnd()`: no-op when stopped/active, else engage the soft lock **before** the write lands (set `turnActive`, fire `onTurnState(true)`, arm the idle timer). Extend `test/doc-bridge.test.ts` with its existing `rig`: (a) open → human edit mid-turn → agent file write → `signalTurnEnd` → both texts survive; (b) hook-opened turn with no write releases as a clean no-op (state vector unchanged, `turnStates [true,false]`); (c) idempotent while active.
- [ ] `VaultMirror` additions: deps `onTurnActivity?(activeTurns)` (maintain a Set of docIds in `onTurnState`; also clear in `closeEntry`) and `onMaterialize?(rel)` (wrap the `writeFile` dep in `openEntry`); public `docIdForPath`/`pathForDocId`/`knownPaths()`/`bridgeForPath(rel)` (started entries only)/`endOpenTurns()` (Stop carries no path — end every active turn; watcher idle stays the fallback).
- [ ] New `test/vault-mirror-agent.test.ts`, port **5614**, self-contained fakeApi (pattern from `vault-mirror.test.ts`), `describe(..., { timeout: 15_000 })`. Gotcha: `refresh()` fire-and-forgets `openEntry` — wait until `bridgeForPath(...) !== null` before poking. `onMaterialize` also fires on the initial materialization — assert on growth, not membership. Cover: accessors, activity up/down, `endOpenTurns` after a foreign disk write, materialize callback on a `SimClient` edit.
- [ ] Full desktop suite + typecheck stay green (changes are additive).
- [ ] Commit: `feat(desktop): bridge/mirror agent seams — signalTurnOpen, accessors, turn activity`

### Task 4: MCP ops (`mcp-ops.ts`)

`buildOps(deps): AgentOp[]` where `AgentOp = { name, description, inputSchema (plain JSON Schema), run(args) }` and `deps = { client: ServerClient, vaultId, docIdForPath, pathForDocId }`. Return sorted by name (deterministic tools/list).

| op | proxies to | notes |
|---|---|---|
| `task_new` | `tasks.create` | fields: title (required), status, due (YYYY-MM-DD), priority, tags, reminder, recurrence, related |
| `task_list` | `tasks.list` | optional `status` filter (that's all the server supports) |
| `task_get` | `tasks.get` | `task_id` |
| `task_set` | `tasks.complete` then/or `tasks.update` | `status:'done'` → complete (recurrence rolls); remaining patch fields → update |
| `task_link` | `tasks.link` / `tasks.unlink` | `remove?: boolean` |
| `task_delete` | `tasks.delete` | → `{ ok: true }` |
| `note_rename` | `notes.rename` | `{ from_path, to_path }`; resolve `from_path` → docId |

- Inbound `related[]` refs of `kind:'note'` take vault-relative **paths**, resolved via `docIdForPath` (throw `unknown note path: <p>` on miss); outbound task rendering adds `path` to note refs via `pathForDocId`. Every call injects `vaultId`. Missing required args throw readable errors (`title is required`, …). Descriptions should steer the agent (done-rolls-recurrence, never-mv, note refs take paths).
- [ ] Tests with a fake tRPC-shaped client recording `{path, input}` calls: the 7 names sorted, path→docId resolution + unknown-path error, outbound path enrichment, the `task_set` done/patch routing (all three combinations), link/unlink, note_rename, required-arg errors.
- [ ] Commit: `feat(desktop): agent MCP ops — 7-op surface over the server client`

### Task 5: McpServer (`mcp-server.ts`)

`class McpServer({ token, ops, onPreToolUse, onStop })` on `node:http`, bind `127.0.0.1:0`; `start(): port`, `stop()` (use `closeAllConnections()`), `endpoint()`, `mcpConfig()`.

- **Every route** requires `authorization === 'Bearer <token>'` → else 401.
- `POST /mcp` JSON-RPC: `initialize` → `{ protocolVersion: <echo client's, fallback '2025-06-18'>, capabilities: { tools: {} }, serverInfo: { name: 'holi', ... }, instructions }`; message without `id` (notification) → 202 empty; `ping` → `{}`; `tools/list` → ops as `{ name, description, inputSchema }`; `tools/call` → run op, result as `content: [{ type: 'text', text: JSON.stringify(result) }]`, **op failures are in-band `isError: true` results, not JSON-RPC errors**; unknown tool → `-32602`; unknown method → `-32601`. `GET /mcp` → 405. Body cap a few MB.
- `POST /hook/pre-tool-use` → `onPreToolUse({ filePath? })`, 204. `POST /hook/stop` → `onStop()`, 204.
- `mcpConfig()` — exact blob (strictness is the CLI flag, not a key; `alwaysLoad` avoids the ToolSearch-deferral first-call race):

```json
{ "mcpServers": { "holi": { "type": "http", "url": "http://127.0.0.1:<port>/mcp", "headers": { "Authorization": "Bearer <token>" }, "alwaysLoad": true } } }
```

- [ ] Tests over real `fetch`: 401s, initialize echo, notification 202, tools/list, tools/call happy + isError + unknown tool/method, hook routes fire callbacks, GET 405, blob shape.
- [ ] Commit: `feat(desktop): local MCP server — bearer-gated ops + hook-signal routes`

### Task 6: AgentRuntime (`agent-runtime.ts`)

Pure helpers + a PTY class. Define a `PtyProcess` interface (`pid, onData, onExit, write, resize, kill`) and `SpawnPty` type; `defaultSpawnPty` does `await import('node-pty')` (lazy — decision 6); everything else takes an injected spawn.

- `buildAgentEnv(base, { endpoint, token })`: copy defined vars, **delete `CLAUDECODE` + `CLAUDE_CODE_ENTRYPOINT`** (nested-session guard), keep PATH/HOME, set `TERM=xterm-256color`, `HOLI_AGENT_ENDPOINT`, `HOLI_AGENT_TOKEN`. No `CLAUDE_CONFIG_DIR` (PRD: user's own `~/.claude`).
- `buildAgentArgs({ systemPrompt, mcpConfig, resume? })`: `--append-system-prompt <p> --mcp-config <blob> --strict-mcp-config` + bare `--resume` when set. **Never `--dangerously-skip-permissions`** — assert in a test.
- `resolveClaudeBin(env?)`: `HOLI_CLAUDE_BIN` override (e2e seam) → scan PATH → old fallback dirs (`/opt/homebrew/bin`, `/usr/local/bin`, `~/.local/bin`, `~/.bun/bin`, `~/.volta/bin`, `~/.npm-global/bin`, `~/n/bin`) for an executable `claude`.
- `isClaudeAuthenticated(home?)`: non-null `oauthAccount` key in `~/.claude.json`, fallback `~/.claude/.claude.json`; any error → false.
- `AgentRuntime`: one PTY; `start()` throws if running; spawn `{ name: 'xterm-256color', cols: 80, rows: 24 }`; onExit clears state **before** emitting (old child-wait rule); `resize` clamps ≥1. `kill()`: **SIGTERM to the process group → 2s grace (configurable) → SIGKILL to the group** via `process.kill(-pid, sig)` (node-pty children are session leaders), ESRCH → fall back to `pty.kill(sig)`; resolve once exit fires (with a backstop timeout); idempotent on a dead runtime.
- [ ] Tests: env/args/resolve/auth-probe helpers with temp dirs; runtime with a fake PTY — data/exit forwarding + state-cleared-before-emit, second-start rejection, cooperative kill = `['SIGTERM']`, stubborn child escalates to `['SIGTERM','SIGKILL']` (give the fake a nonexistent pid so the group-kill ESRCHes into the observable `pty.kill` path; short `killGraceMs`), kill-when-dead is a no-op.
- [ ] Commit: `feat(desktop): AgentRuntime — node-pty claude session with group kill`

### Task 7: ContextSnapshot (`context-snapshot.ts`)

Writes `.holi/context.local.json` (export the path const) via `writeAtomic` — `isLocalOnlyPath` already keeps the mirror away from `*.local.*`. Deps: `workRoot`, `listTasks()`, `backrefs(path)`, `docIdForPath`, `pathForDocId`, `debounceMs` (default ~150). API: `setFocus({ focusedPath, openPaths })`, `onTasksEvent()`, `flush()` (tests/stop), `stop()`.

File shape:

```json
{ "focusedPath": "notes/x.md", "openPaths": [], "relatedTasks": [{ "id", "title", "status", "due?" }], "backrefPaths": [], "updatedAt": "<iso>" }
```

Related tasks = non-done tasks whose `related[]` has `{ kind: 'note', id: <focused docId> }`; backrefs map `srcDocId` → path (drop unmapped). Server fetches degrade to empty sections (log, never throw) — the hook must never block a turn.

- [ ] Tests with fake deps + temp dir: full write, null focus, degrade-on-failure, tasks-event rewrite debounced (N events → 1 fetch).
- [ ] Commit: `feat(desktop): ContextSnapshot — .holi/context.local.json writer`

### Task 8: Managed seeding + hook scripts

Hook scripts are real dependency-free `.mjs` files in `src/main/agent/hooks/`, imported `?raw` in `seed-content.ts` (add `ambient.d.ts` with a `declare module '*?raw'`). **Shebang `#!/usr/bin/env node` must be line 1** — a leading comment above it is a syntax error in ESM. All three: no HOLI env → silent `exit 0`; any error → silent `exit 0` (bare `claude` in a synced checkout outside Holi keeps working).

- `pre-tool-use.mjs`: read stdin JSON, extract `tool_input.file_path`, POST `{ filePath }` to `$HOLI_AGENT_ENDPOINT/hook/pre-tool-use` with the bearer, `AbortSignal.timeout(1000)`.
- `stop.mjs`: POST `/hook/stop`, same rules.
- `user-prompt-submit.mjs`: pure local reads from `$CLAUDE_PROJECT_DIR` (fallback cwd) — <50 ms budget. Emit: USER.md section with fill indicator `[31% — 1,240/4,000 chars]` (port of `fill_indicator`: floor pct clamped to 100, en-US separators; budgets 4,000/5,000; empty → `[0% — empty]` + the old guidance line retargeted to native edits), MEMORY.md likewise, then from `.holi/context.local.json` (when focused): active notes, ``Focused note: `<path>` (use `Read` to view its contents)``, `# Related non-complete tasks` (`- [status] title (id=…, due=…)` or `(none)`), `# Related notes (backreferences)` (`- [[path]]`). Sections joined `\n\n***\n\n`.

`seed-content.ts`: `SEED_FILES` table + `ensureSeeded(workRoot, knownDocPaths): Promise<string[]>` — skip if known doc or on disk, else `writeAtomic`. Seeds:
- `CLAUDE.md` — exactly `<rules>\n@AGENTS.md\n</rules>\n` (the old bootstrap's shim).
- `AGENTS.md`, `MEMORY.md` — short starter bodies (team rules / shared memory, budget noted).
- `.claude/settings.json` — hooks config: `PreToolUse` with `matcher: "Write|Edit|MultiEdit"` → `node "$CLAUDE_PROJECT_DIR/.claude/hooks/pre-tool-use.mjs"`, `Stop` and `UserPromptSubmit` likewise; plus `permissions.ask: ["Bash(curl:*)", "Bash(wget:*)"]` (seeded egress gating, PRD §Security posture).
- the three hook scripts.

- [ ] Tests: SEED_FILES covers exactly the spec §Managed seeding set; shim string exact; settings wiring; `ensureSeeded` seeds-all/skips/idempotent (never overwrites an existing file). Hook scripts: spawn `process.execPath` (bare `node` is broken here; resolve the hooks dir with `fileURLToPath(new URL(...))` — no `__dirname` under vitest ESM) — no-op without env, pre-tool-use POSTs `{filePath}` + bearer to a local capture server, user-prompt-submit renders fill indicators + focused context from fixture files.
- [ ] Commit: `feat(desktop): managed vault seeding + synced hook scripts`

### Task 9: AgentManager + wiring

**`vault-manager.ts`** gains the observer contract and accessors:

```ts
export interface VaultObserver {
  onActivated(vaultId: string, mirror: VaultMirror): void | Promise<void> // after start + seeding
  onDeactivating(vaultId: string): void | Promise<void>                   // BEFORE mirror/events stop
  onTurnActivity(activeTurns: number): void
  onMaterialize(rel: string): void
  onTasksEvent(): void
}
```

`setObserver()`, `activeVaultId()`, `activeMirror()`; thread `onTurnActivity`/`onMaterialize` into the VaultMirror deps; SSE `tasks` channel → `observer.onTasksEvent()` (consumes the slice-1 stub); after `mirror.start()` run `ensureSeeded(workRoot, new Set(mirror.knownPaths()))` (log-don't-throw); `deactivate()` awaits `onDeactivating` **before** stopping events/mirror (open turns must still merge; the agent dies first).

**`agent-manager.ts`** — `createAgentManager({ client, vaultManager, getWindow, spawnPty?, resolveBin?, settleMs?, killGraceMs? })` (the last four are test seams) returning `{ observer, start, write, resize, kill, setFocus, status, dispose }`:

- `start({ vaultId, resume? })`: reject if not the active vault; kill any prior session (restart semantics); resolve bin (`Claude CLI not found on PATH …` error); read `.claude/IDENTITY.md`/`SOUL.md` + `readVaultTree` from the workRoot → `buildSystemPrompt`; mint token `randomBytes(32).toString('base64url')`; `McpServer` with `buildOps` (lookups delegate to the live mirror) + hook callbacks; spawn `AgentRuntime` with cwd = workRoot, `buildAgentArgs`, `buildAgentEnv(process.env, { endpoint, token })`. Stop the MCP server if the spawn throws. Clear `configStale` on (re)start.
- Hook routing: PreToolUse → `toVaultRel(workRoot, filePath)` (outside-vault paths ignored — path safety) → `mirror.bridgeForPath(rel)?.signalTurnOpen()`. Stop → `setTimeout(≈300ms)` settle (let the last write's watcher event land) → `mirror.endOpenTurns()`.
- Observer: `onActivated` → hold mirror + create ContextSnapshot (listTasks/backrefs via the client, lookups via the mirror); `onDeactivating` → kill session + stop snapshot (spec: vault switch kills the session); `onTurnActivity` → `working` flag; `onMaterialize` → if a session is live and rel is agent config (`.claude/`, `CLAUDE.md`, `AGENTS.md`) set `configStale`; `onTasksEvent` → snapshot refresh.
- Status push: `send('agent:status', { running, working, configStale, authenticated: isClaudeAuthenticated() })` on every transition; PTY data/exit → `agent-pty:data` / `agent-pty:exit` via `getWindow()?.webContents.send`. On PTY exit also stop the MCP server (guard the kill path against double-stop).

**Wiring:** `ipc.ts` handles `agent-pty:start/write/resize/kill` (start/kill through `toEnvelope`), `holi:agent:status`, `holi:agent:focus`. `preload/index.ts`: `window.holi.agent.{start,write,resize,kill,status,setFocus,onData,onExit,onStatus}` — push channels use one persistent `ipcRenderer.on` per channel fanning out to a `Set` of subscribers; the `on*` methods return unsubscribe closures. `global.d.ts` mirrors it (import `AgentStatus` from `./state/agent` — create that atoms file now: `AgentStatus`, `agentPanelOpenAtom`, `agentStatusAtom`). `index.ts`: keep a `mainWindow` reference (currently discarded), construct agentManager after vaultManager with a shared `createServerClient`, `vaultManager.setObserver(agentManager.observer)`, pass to `registerIpc`, dispose in `before-quit`.

- [ ] Tests (fake spawnPty/window/mirror/vaultManager/client; the McpServer runs real): spawn wiring (cwd, prompt in args, no skip-permissions, blob url/token match the env vars), live `tools/list` returns the 7 ops, hook round-trips (pre-tool-use → `signalTurnOpen` on the right bridge, outside path ignored, stop → `endOpenTurns` after settle), data/exit forwarding + MCP teardown on exit, `onDeactivating` kills, configStale only for config paths + cleared on restart, working flag, `setFocus` reaches the context file, readable errors (missing bin, inactive vault). Keep `agent-manager.ts` free of runtime `electron` imports (types only) so vitest can load it.
- [ ] Commit: `feat(desktop): AgentManager — session orchestration, vault observer, agent IPC`

### Task 10: AgentPanel (renderer)

No jsdom harness in this repo — renderer verification is typecheck + the Task 11 e2e; extract the width math into a tested pure helper.

- `lib/agent-panel-geometry.ts`: `MIN_AGENT_PANEL_WIDTH = 660` (~80 cols at fontSize 13) and `clampPanelWidth(next, viewport)` (also keeps ~480px for the editor). Small vitest file.
- `AgentPanel.tsx`: sibling `<aside>` after `<main>` in Shell's body flex row (`border-l`, `style={{width}}`), hidden via `display:none` class — **stays mounted** so scrollback survives; re-`fit()` + `agent.resize(cols, rows)` on show/resize (ResizeObserver). One `Terminal` (fontSize 13, mono stack, scrollback, dark theme; import `@xterm/xterm/css/xterm.css`) + FitAddon for the panel's lifetime; `term.onData` → `agent.write`; subscribe `onData/onExit/onStatus` (unsubscribe on unmount). Opening the panel starts the session for the active vault if not running; PTY exit prints a dim `[session ended (code N)]` line into the term. Drag handle on the left edge (mousemove listeners on window; use `clampPanelWidth`). Header: status dot (working = amber pulse, running = green, else grey), title + inline hints (`configStale` → "shared config changed; restart to pick it up", `!authenticated` → "not logged in (run /login below)"), buttons ⟲ history (kill → start with `resume:true`), ↻ restart, ✕ hide. Gotcha: type mouse events via `import type { MouseEvent } from 'react'` (no default React import in this codebase).
- `Shell.tsx`: mount `<AgentPanel />` after `</main>`; window keydown effect for **⌘J / Ctrl-J** toggle (first shortcut in the app); effect pushing `agent.setFocus({ focusedPath: activeDoc?.path ?? null, openPaths: ... })` on activeDoc change; vault-select guard — if `agentStatus.working`, park the selection and show a small inline confirm ("Claude is mid-edit — switching vaults kills the session" / switch anyway / stay) instead of switching immediately (**no native `confirm` in Electron renderers**).
- [ ] Typecheck + suite green; optional eyeball via `pnpm --filter @holi/desktop dev` (⌘J opens; without `claude` a red "Claude CLI not found" line appears).
- [ ] Commit: `feat(desktop): AgentPanel — xterm right dock with ⌘J toggle`

### Task 11: Fake-`claude` e2e + closing the slice

**`e2e/fake-claude.mjs`** (shebang line 1, `chmod +x`): prints a ready banner, reads PTY stdin line-wise (split on `\r`/`\n`), commands:
- `edit <rel> <text…>` — POST `/hook/pre-tool-use` `{ filePath: <abs> }` → append the text as a line to the file (mkdir -p) → POST `/hook/stop` (exactly what real CC's hooks do around a Write);
- `task <title…>` — MCP `tools/call task_new` against `$HOLI_AGENT_ENDPOINT/mcp` with the bearer;
- `exit [code]`. Echo every command + result to stdout so the xterm shows life.

**`e2e/agent-smoke.ts`** — CDP driver on the slice-1 smoke pattern (memory `holi-electron-e2e-via-cdp`: nested `msg.result.result.value` envelope, `ws` dep, poll-based waits). Seven checkpoints:
1. `devSignIn(HOLI_DEV_TOKEN)` + reload → vault active (read the vault `<select>` value).
2. `window.holi.agent.start({ vaultId })` → `status().running` (PTY + MCP up).
3. `agent.write('edit e2e-drawer.md hello from fake claude\r')` → `vaults.listDocs` (via `window.holi.trpc`) gains `e2e-drawer.md` (adoption).
4. Click the doc in the file tree → `.cm-content` contains the text (relay sync).
5. Second `edit` while the doc is open → editor updates live (hook-opened turn → merge → CRDT).
6. `agent.write('task E2E drawer task\r')` → `tasks.list` contains it (bearer-gated MCP → server).
7. `agent.kill()` → `status().running === false`.

- [ ] Run it: db + server up, `pnpm --filter @holi/server exec tsx scripts/seed-dev.ts` for the token; from `apps/desktop`: `HOLI_CLAUDE_BIN=$PWD/e2e/fake-claude.mjs pnpm exec electron-vite dev -- --remote-debugging-port=9223` (note the single `--`); then `HOLI_DEV_TOKEN=<token> pnpm --filter @holi/server exec tsx ../desktop/e2e/agent-smoke.ts` → `7/7`. Cleanup: `pkill -f "better-holi-final.*electron"`.
- [ ] `pnpm -r test && pnpm -r typecheck` — all green.
- [ ] Update `docs/specs/2026-07-13-agent-drawer-design.md` with a "Slice-2 implementation deviations" section (this plan's 8 decisions as executed + anything discovered). **Do not commit the spec or this plan.**
- [ ] Commit (e2e code only): `test(desktop): fake-claude e2e driver for the agent drawer`

**Manual real-`claude` smoke (with Nicolai):** unset `HOLI_CLAUDE_BIN`, dev app, then walk: ⌘J → real CC banner renders ≥80 cols; system prompt live (ask about the vault system); focused-note context lands per turn; ask for an edit → native permission prompt → editor updates live (check the `agentEditing` awareness reaches the doc); "add a task for the Q2 review" → task appears; a rename goes through `note_rename`; edit `.claude/settings.json` mid-session → restart hint; ⟲ `--resume` picker usable in xterm (record the verdict — spec open item); vault switch mid-turn → inline confirm, session dies, switch back + resume works. Note findings in the spec's deviations section (uncommitted).
