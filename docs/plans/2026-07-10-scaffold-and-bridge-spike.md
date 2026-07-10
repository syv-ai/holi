# Monorepo Scaffold + D25 Bridge Spike Implementation Plan

> **For agentic workers:** Use the executing-plans skill to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Scaffold the `better-holi-final` pnpm monorepo (D15) so `pnpm dev` boots a Node server + Electron shell, then build a throwaway harness proving the D25 file↔CRDT bridge turn protocol.

**Architecture:** Three workspace members (`apps/desktop` Electron+Vite+React+Jotai+Tailwind, `apps/server` Hocuspocus+tRPC, `packages/shared` domain types) plus a `spikes/bridge` throwaway package. The spike's core algorithm: freeze a base (text + Yjs state) at each materialization; during an agent turn, pause re-materialization; at turn end, fork a **shadow Y.Doc** from the frozen base state, apply `diff(base, file)` as positioned Y.Text ops on the shadow, then merge the shadow's state-vector delta into the live doc — Yjs itself performs the 3-way positional merge against buffered remote edits. Never blind-replace.

**Tech Stack:** pnpm workspaces, TypeScript (strict), Node ≥ 20.19, Electron via electron-vite, React 18, Jotai, Tailwind v4, tRPC v11, Hocuspocus v2 (pinned `^2` — API known-stable; upgrade later is trivial), yjs, chokidar, diff-match-patch, vitest, tsx.

**Ground rules (from docs/decisions.md — do not violate without user sign-off):**
- Work ONLY in `/Users/nicolaibthomsen/repos/syv/better-holi-final`. Never touch `~/repos/holi` (reference-only) or anything above `better-holi-final/` in `~/repos/syv/`.
- Commit on `main`. Every commit message ends with `Claude goes brr.. via Dash`.
- Skeletons, not features (scaffold); throwaway, not polished (spike). No codegen — `packages/shared` TS types ARE the contract (D14/D15).
- The spike must **diff, never blind-replace** (D2/D25). If the protocol fights back, surface it — do NOT silently fall back to gateway ops (rejected in D2).
- Spike code lives in `spikes/bridge/` and is disposable; the algorithm gets promoted into `packages/shared` later only if the spike report says it holds.

---

## Part A — Monorepo scaffold (D15)

### Task 1: Workspace root

**Files:**
- Create: `pnpm-workspace.yaml`
- Create: `package.json`
- Create: `tsconfig.base.json`
- Create: `.prettierrc.json`
- Create: `.gitignore`

- [ ] **Step 1: Write the workspace manifest files**

`pnpm-workspace.yaml`:

```yaml
packages:
  - 'apps/*'
  - 'packages/*'
  - 'spikes/*'
```

`package.json`:

```json
{
  "name": "holi",
  "private": true,
  "engines": { "node": ">=20.19" },
  "scripts": {
    "dev": "pnpm --parallel --filter \"./apps/*\" dev",
    "test": "pnpm -r test",
    "typecheck": "pnpm -r typecheck",
    "format": "prettier --write ."
  },
  "pnpm": {
    "onlyBuiltDependencies": ["electron", "esbuild"]
  }
}
```

(The `onlyBuiltDependencies` block matters: pnpm ≥ 10 blocks postinstall scripts by default, and without it the Electron binary never downloads.)

`tsconfig.base.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "skipLibCheck": true,
    "esModuleInterop": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "forceConsistentCasingInFileNames": true,
    "noUncheckedIndexedAccess": true
  }
}
```

`.prettierrc.json` (mirrors the old repo's style):

```json
{
  "printWidth": 100,
  "singleQuote": true,
  "trailingComma": "all",
  "tabWidth": 2
}
```

`.gitignore`:

```
node_modules/
dist/
out/
.env
*.local
.DS_Store
.tmp/
```

- [ ] **Step 2: Install root dev tooling**

Run from repo root:

```bash
pnpm add -Dw typescript prettier @types/node
```

Expected: creates `pnpm-lock.yaml`, `node_modules/`, no errors.

- [ ] **Step 3: Commit**

```bash
git add pnpm-workspace.yaml package.json tsconfig.base.json .prettierrc.json .gitignore pnpm-lock.yaml
git commit -m "chore: scaffold pnpm workspace root

Claude goes brr.. via Dash"
```

---

### Task 2: `packages/shared` — domain type skeleton

**Files:**
- Create: `packages/shared/package.json`
- Create: `packages/shared/tsconfig.json`
- Create: `packages/shared/src/types.ts`
- Create: `packages/shared/src/index.ts`
- Test: `packages/shared/test/types.test.ts`

The shared package exports raw TS source (`exports` points at `.ts`) — consumers (tsx, electron-vite, vitest) all compile TS from workspace links natively. No build step in the skeleton.

- [ ] **Step 1: Write package manifest + tsconfig**

`packages/shared/package.json`:

```json
{
  "name": "@holi/shared",
  "version": "0.0.1",
  "private": true,
  "type": "module",
  "exports": { ".": "./src/index.ts" },
  "scripts": {
    "test": "vitest run",
    "typecheck": "tsc --noEmit"
  }
}
```

`packages/shared/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "include": ["src", "test"]
}
```

- [ ] **Step 2: Install dev deps**

```bash
pnpm --filter @holi/shared add -D typescript vitest
```

- [ ] **Step 3: Write the failing smoke test**

`packages/shared/test/types.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import type { Task, Vault } from '../src/index'

describe('shared domain types', () => {
  it('type-checks a Task and a Vault literal', () => {
    const vault: Vault = {
      id: 'v1',
      name: 'Syv',
      kind: 'shared',
      ownerId: 'u1',
      createdAt: '2026-07-10T00:00:00Z',
      updatedAt: '2026-07-10T00:00:00Z',
    }
    const task: Task = {
      id: 't1',
      vaultId: vault.id,
      title: 'Prove the bridge',
      status: 'doing',
      tags: ['spike'],
      related: [{ kind: 'note', id: 'd1' }],
      createdAt: '2026-07-10T00:00:00Z',
      updatedAt: '2026-07-10T00:00:00Z',
    }
    expect(task.status).toBe('doing')
    expect(vault.kind).toBe('shared')
  })
})
```

- [ ] **Step 4: Run test to verify it fails**

```bash
pnpm --filter @holi/shared test
```

Expected: FAIL — cannot resolve `../src/index`.

- [ ] **Step 5: Write the types**

`packages/shared/src/types.ts` (shapes lifted verbatim from `docs/prd/server-data.md` §Task and `docs/prd/vaults-collaboration.md` §Data & types):

```ts
export type VaultKind = 'personal' | 'shared'
export type Role = 'owner' | 'member'
export type TaskStatus = 'todo' | 'doing' | 'done'
export type Priority = 'low' | 'medium' | 'high'
export type DocKind = 'note' | 'daily'
export type SyncStatus = 'synced' | 'offline' | 'syncing'

export interface Vault {
  id: string
  name: string
  kind: VaultKind
  ownerId: string
  theme?: unknown
  createdAt: string
  updatedAt: string
}

export interface Membership {
  vaultId: string
  userId: string
  role: Role
}

export interface DocMeta {
  id: string
  vaultId: string
  path: string
  kind: DocKind
  createdAt: string
  updatedAt: string
}

export interface Folder {
  id: string
  vaultId: string
  path: string
}

export type RelatedRefKind = 'note' | 'task' | 'email' | 'event'

/** Machine references use stable IDs, never paths (D27). */
export interface RelatedRef {
  kind: RelatedRefKind
  id: string
}

export interface Recurrence {
  frequency: 'daily' | 'weekly' | 'monthly'
  interval: number
  weekdays?: number[]
  endDate?: string
}

export interface Task {
  id: string
  vaultId: string
  title: string
  status: TaskStatus
  /** Stable folder ID driving swim lanes (D4a, D27). */
  area?: string
  /** YYYY-MM-DD */
  due?: string
  priority?: Priority
  tags: string[]
  /** Nd | Nw | YYYY-MM-DDTHH:MM (D19) */
  reminder?: string
  recurrence?: Recurrence
  related: RelatedRef[]
  createdAt: string
  updatedAt: string
}

export interface HealthStatus {
  ok: boolean
  service: string
  time: string
}
```

`packages/shared/src/index.ts`:

```ts
export * from './types'
```

- [ ] **Step 6: Run test to verify it passes**

```bash
pnpm --filter @holi/shared test && pnpm --filter @holi/shared typecheck
```

Expected: PASS, no type errors.

- [ ] **Step 7: Commit**

```bash
git add packages/shared pnpm-lock.yaml
git commit -m "feat(shared): domain type skeleton (Vault/Task/DocMeta per PRDs)

Claude goes brr.. via Dash"
```

---

### Task 3: `apps/server` — Hocuspocus + tRPC boot skeleton

**Files:**
- Create: `apps/server/package.json`
- Create: `apps/server/tsconfig.json`
- Create: `apps/server/src/router.ts`
- Create: `apps/server/src/main.ts`

No Postgres yet — the skeleton boots the relay in-memory and serves one tRPC health query. Persistence hooks come with the real build.

- [ ] **Step 1: Write manifest + tsconfig**

`apps/server/package.json`:

```json
{
  "name": "@holi/server",
  "version": "0.0.1",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "tsx watch src/main.ts",
    "typecheck": "tsc --noEmit"
  }
}
```

`apps/server/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "include": ["src"]
}
```

- [ ] **Step 2: Install deps**

```bash
pnpm --filter @holi/server add @hocuspocus/server@^2 @trpc/server yjs @holi/shared@workspace:*
pnpm --filter @holi/server add -D tsx typescript
```

- [ ] **Step 3: Write the tRPC router**

`apps/server/src/router.ts`:

```ts
import { initTRPC } from '@trpc/server'
import type { HealthStatus } from '@holi/shared'

const t = initTRPC.create()

export const appRouter = t.router({
  health: t.procedure.query(
    (): HealthStatus => ({ ok: true, service: 'holi-server', time: new Date().toISOString() }),
  ),
})

export type AppRouter = typeof appRouter
```

- [ ] **Step 4: Write the entrypoint**

`apps/server/src/main.ts`:

```ts
import { Hocuspocus } from '@hocuspocus/server'
import { createHTTPServer } from '@trpc/server/adapters/standalone'
import { appRouter } from './router'

const RELAY_PORT = 4444
const API_PORT = 4000

const relay = new Hocuspocus({ port: RELAY_PORT })
void relay.listen().then(() => {
  console.log(`[relay] Hocuspocus listening on ws://127.0.0.1:${RELAY_PORT}`)
})

createHTTPServer({ router: appRouter }).listen(API_PORT)
console.log(`[api] tRPC listening on http://127.0.0.1:${API_PORT}`)
```

- [ ] **Step 5: Verify it boots**

```bash
pnpm --filter @holi/server dev
```

Expected log lines: `[api] tRPC listening on http://127.0.0.1:4000` and `[relay] Hocuspocus listening on ws://127.0.0.1:4444`.

In a second shell:

```bash
curl -s "http://127.0.0.1:4000/health"
```

Expected: `{"result":{"data":{"ok":true,"service":"holi-server","time":"..."}}}`. Then stop the dev process.

(If the Hocuspocus v2 constructor/`listen()` API mismatches the installed minor, check `node_modules/@hocuspocus/server/dist` exports and adjust — do not upgrade to v3+ in this task.)

- [ ] **Step 6: Typecheck + commit**

```bash
pnpm --filter @holi/server typecheck
git add apps/server pnpm-lock.yaml
git commit -m "feat(server): hocuspocus + trpc boot skeleton

Claude goes brr.. via Dash"
```

---

### Task 4: `apps/desktop` — Electron + Vite + React 18 + Jotai + Tailwind

**Files:**
- Create: `apps/desktop/package.json`
- Create: `apps/desktop/tsconfig.json`
- Create: `apps/desktop/electron.vite.config.ts`
- Create: `apps/desktop/src/main/index.ts`
- Create: `apps/desktop/src/preload/index.ts`
- Create: `apps/desktop/src/renderer/index.html`
- Create: `apps/desktop/src/renderer/src/main.tsx`
- Create: `apps/desktop/src/renderer/src/App.tsx`
- Create: `apps/desktop/src/renderer/src/index.css`
- Create: `apps/desktop/src/renderer/src/global.d.ts`

electron-vite conventions: main entry `src/main/index.ts`, preload `src/preload/index.ts`, renderer rooted at `src/renderer/`. CJS output (no `"type": "module"`) so `__dirname` works in main — the most battle-tested electron-vite path.

- [ ] **Step 1: Write manifest + configs**

`apps/desktop/package.json`:

```json
{
  "name": "@holi/desktop",
  "version": "0.0.1",
  "private": true,
  "main": "./out/main/index.js",
  "scripts": {
    "dev": "electron-vite dev",
    "build": "electron-vite build",
    "typecheck": "tsc --noEmit"
  }
}
```

`apps/desktop/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "jsx": "react-jsx",
    "lib": ["ES2022", "DOM", "DOM.Iterable"]
  },
  "include": ["src", "electron.vite.config.ts"]
}
```

`apps/desktop/electron.vite.config.ts`:

```ts
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'electron-vite'

export default defineConfig({
  main: {},
  preload: {},
  renderer: {
    plugins: [react(), tailwindcss()],
  },
})
```

- [ ] **Step 2: Install deps**

```bash
pnpm --filter @holi/desktop add react@^18 react-dom@^18 jotai @holi/shared@workspace:*
pnpm --filter @holi/desktop add -D electron electron-vite vite @vitejs/plugin-react tailwindcss @tailwindcss/vite typescript @types/react@^18 @types/react-dom@^18
```

Expected: Electron binary downloads (the root `onlyBuiltDependencies` allows its postinstall). If pnpm prints an "ignored build scripts" warning naming electron, run `pnpm approve-builds` or fix the root `pnpm.onlyBuiltDependencies` and reinstall.

- [ ] **Step 3: Write main process**

`apps/desktop/src/main/index.ts`:

```ts
import { app, BrowserWindow, ipcMain } from 'electron'
import { join } from 'node:path'

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  if (process.env['ELECTRON_RENDERER_URL']) {
    void win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(() => {
  ipcMain.handle('holi:ping', () => 'pong')
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
```

- [ ] **Step 4: Write preload**

`apps/desktop/src/preload/index.ts`:

```ts
import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('holi', {
  ping: (): Promise<string> => ipcRenderer.invoke('holi:ping'),
})
```

- [ ] **Step 5: Write renderer**

`apps/desktop/src/renderer/index.html`:

```html
<!doctype html>
<html>
  <head>
    <meta charset="UTF-8" />
    <title>Holi</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

`apps/desktop/src/renderer/src/global.d.ts`:

```ts
declare global {
  interface Window {
    holi: { ping(): Promise<string> }
  }
}

export {}
```

`apps/desktop/src/renderer/src/index.css`:

```css
@import 'tailwindcss';
```

`apps/desktop/src/renderer/src/App.tsx`:

```tsx
import type { SyncStatus } from '@holi/shared'
import { atom, useAtom, useAtomValue } from 'jotai'

const syncStatusAtom = atom<SyncStatus>('offline')
const pingAtom = atom('…')

export function App() {
  const [ping, setPing] = useAtom(pingAtom)
  const status = useAtomValue(syncStatusAtom)
  return (
    <div className="flex h-screen flex-col items-center justify-center gap-3 bg-neutral-950 text-neutral-100">
      <h1 className="text-3xl font-semibold tracking-tight">Holi</h1>
      <p className="text-sm text-neutral-400">sync: {status}</p>
      <button
        className="rounded bg-neutral-800 px-3 py-1.5 text-sm hover:bg-neutral-700"
        onClick={async () => setPing(await window.holi.ping())}
      >
        ping main → {ping}
      </button>
    </div>
  )
}
```

`apps/desktop/src/renderer/src/main.tsx`:

```tsx
import React from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import './index.css'

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
```

- [ ] **Step 6: Verify the app boots**

```bash
pnpm --filter @holi/desktop dev
```

Expected: electron-vite builds main/preload, starts the renderer dev server, an Electron window opens showing “Holi / sync: offline”; clicking the button shows `ping main → pong` (proves preload IPC + Jotai + Tailwind + the `@holi/shared` import all work). Quit the app.

- [ ] **Step 7: Typecheck + commit**

```bash
pnpm --filter @holi/desktop typecheck
git add apps/desktop pnpm-lock.yaml
git commit -m "feat(desktop): electron-vite + react + jotai + tailwind shell

Claude goes brr.. via Dash"
```

---

### Task 5: Verify `pnpm dev` boots both apps together

- [ ] **Step 1: Run the workspace dev script**

```bash
pnpm dev
```

Expected: server logs (`[api] …`, `[relay] …`) AND the Electron window, concurrently. `curl -s "http://127.0.0.1:4000/health"` returns the health payload while the window is open. Stop with Ctrl+C (both processes exit).

- [ ] **Step 2: Fix anything that broke, commit only if fixes were needed**

```bash
git add -A && git commit -m "fix: pnpm dev boots server + desktop together

Claude goes brr.. via Dash"
```

---

## Part B — The bridge spike (D25)

**What the spike must prove** (acceptance from the handoff):
- (a) non-overlapping human+agent edits both survive;
- (b) overlapping same-range edits converge without corrupting surrounding text;
- (c) remote edits landing mid-agent-turn don't poison the diff (frozen base is the trick);
- (d) no lost updates under a randomized hammer loop;
- (e) watcher debounce/event-coalescing doesn't drop turns.

**Core algorithm (the thing under test).** At every materialization the bridge records `base = { text, Y.encodeStateAsUpdate(liveDoc) }`. The first watcher event that shows disk ≠ base starts a turn (soft lock: re-materialization paused). After an idle debounce the turn ends: fork a shadow `Y.Doc` from `base.state`, apply `diff-match-patch(baseText → fileText)` as positioned `Y.Text` insert/delete ops on the shadow, then `Y.applyUpdate(live, Y.encodeStateAsUpdate(shadow, Y.encodeStateVector(live)))`. The shadow acts as a virtual client that went offline at the freeze point and made exactly the agent's edits — Yjs's own merge does the positional 3-way against remote edits buffered in the live doc. New base = merge result; re-materialize; release.

### Task 6: Spike package setup

**Files:**
- Create: `spikes/bridge/package.json`
- Create: `spikes/bridge/tsconfig.json`
- Create: `spikes/bridge/vitest.config.ts`

- [ ] **Step 1: Write manifests**

`spikes/bridge/package.json`:

```json
{
  "name": "@holi/spike-bridge",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "test": "vitest run",
    "typecheck": "tsc --noEmit"
  }
}
```

`spikes/bridge/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "include": ["src", "test"]
}
```

`spikes/bridge/vitest.config.ts` (sockets + chokidar are timing-real; run files sequentially, generous timeouts):

```ts
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    testTimeout: 30_000,
    hookTimeout: 30_000,
    fileParallelism: false,
  },
})
```

- [ ] **Step 2: Install deps**

```bash
pnpm --filter @holi/spike-bridge add yjs @hocuspocus/server@^2 @hocuspocus/provider@^2 chokidar diff-match-patch ws
pnpm --filter @holi/spike-bridge add -D vitest typescript @types/diff-match-patch @types/ws
```

- [ ] **Step 3: Commit**

```bash
git add spikes pnpm-lock.yaml
git commit -m "chore(spike): bridge spike package scaffold

Claude goes brr.. via Dash"
```

---

### Task 7: Merge core — `applyAgentTurn` (TDD, no network)

**Files:**
- Create: `spikes/bridge/src/merge.ts`
- Test: `spikes/bridge/test/merge.test.ts`

These unit tests simulate “remote edits after the freeze” by editing the live doc directly between snapshotting the base and applying the turn — no relay needed to test the merge semantics.

- [ ] **Step 1: Write the failing tests**

`spikes/bridge/test/merge.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { applyAgentTurn } from '../src/merge'

function seededDoc(text: string): Y.Doc {
  const doc = new Y.Doc()
  doc.getText('content').insert(0, text)
  return doc
}
const snap = (doc: Y.Doc) => Y.encodeStateAsUpdate(doc)
const read = (doc: Y.Doc) => doc.getText('content').toString()

describe('applyAgentTurn (frozen base → positioned ops onto live doc)', () => {
  it('full rewrite with no remote edits lands verbatim', () => {
    const live = seededDoc('hello world\n')
    const base = snap(live)
    applyAgentTurn(live, base, 'goodbye world\n')
    expect(read(live)).toBe('goodbye world\n')
  })

  it('no-op turn leaves the doc state untouched', () => {
    const live = seededDoc('same\n')
    const base = snap(live)
    const svBefore = Y.encodeStateVector(live)
    applyAgentTurn(live, base, 'same\n')
    expect(Y.encodeStateVector(live)).toEqual(svBefore)
  })

  it('(a) non-overlapping human and agent edits both survive', () => {
    const live = seededDoc('# Title\n\nalpha\n\nomega\n')
    const base = snap(live)
    // remote (human) edit lands after the freeze:
    live.getText('content').insert('# Title\n\nalpha'.length, ' (human)')
    // agent edited the frozen file:
    applyAgentTurn(live, base, '# Title\n\nalpha\n\nomega (agent)\n')
    expect(read(live)).toBe('# Title\n\nalpha (human)\n\nomega (agent)\n')
  })

  it('(c) remote insert inside an agent-deleted region survives the delete', () => {
    const live = seededDoc('keep DELETE-ME keep\n')
    const base = snap(live)
    live.getText('content').insert('keep DELETE'.length, '[remote]')
    applyAgentTurn(live, base, 'keep keep\n') // agent removed 'DELETE-ME '
    expect(read(live)).toBe('keep [remote]keep\n')
  })

  it('(b) overlapping same-range rewrites converge without corrupting surroundings', () => {
    const live = seededDoc('start MIDDLE end\n')
    const base = snap(live)
    const text = live.getText('content')
    live.transact(() => {
      text.delete('start '.length, 'MIDDLE'.length)
      text.insert('start '.length, 'HUMAN')
    })
    applyAgentTurn(live, base, 'start AGENT end\n')
    const out = read(live)
    // Yjs semantics: both concurrent inserts survive side by side; surroundings intact.
    expect(out).toMatch(/^start .+ end\n$/)
    expect(out).toContain('HUMAN')
    expect(out).toContain('AGENT')
    expect(out).not.toContain('MIDDLE')
    console.log('[spike] overlap merge result:', JSON.stringify(out))
  })

  it('multiple scattered edits in one turn all land at the right positions', () => {
    const live = seededDoc('L1 aaa\nL2 bbb\nL3 ccc\nL4 ddd\n')
    const base = snap(live)
    live.getText('content').insert('L1 aaa\nL2 bbb'.length, ' [h]')
    applyAgentTurn(live, base, 'L1 AAA\nL2 bbb\nL3 ccc\nL4 DDD\nL5 eee\n')
    expect(read(live)).toBe('L1 AAA\nL2 bbb [h]\nL3 ccc\nL4 DDD\nL5 eee\n')
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
pnpm --filter @holi/spike-bridge test
```

Expected: FAIL — cannot resolve `../src/merge`.

- [ ] **Step 3: Implement the merge core**

`spikes/bridge/src/merge.ts`:

```ts
import DiffMatchPatch from 'diff-match-patch'
import * as Y from 'yjs'

const dmp = new DiffMatchPatch()

export const BRIDGE_ORIGIN = 'bridge-merge'

/**
 * D25 turn end: apply what the agent changed (diff of frozen base → file) as
 * positioned Yjs ops onto the live doc, which may hold buffered remote edits.
 *
 * Implementation: fork a shadow doc from the frozen base state, replay the
 * text diff as Y.Text ops on the shadow (positions are valid there — the
 * shadow IS the base), then merge the shadow's delta into the live doc.
 * The shadow acts as a virtual client that went offline at the freeze point;
 * Yjs's own CRDT merge performs the 3-way positional reconciliation.
 * Never blind-replace (D2/D25).
 */
export function applyAgentTurn(live: Y.Doc, baseState: Uint8Array, fileText: string): void {
  const shadow = new Y.Doc()
  Y.applyUpdate(shadow, baseState)
  const shadowText = shadow.getText('content')
  const baseText = shadowText.toString()
  if (baseText === fileText) {
    shadow.destroy()
    return
  }

  const diffs = dmp.diff_main(baseText, fileText)
  dmp.diff_cleanupSemantic(diffs)

  shadow.transact(() => {
    let pos = 0
    for (const [op, chunk] of diffs) {
      if (op === DiffMatchPatch.DIFF_EQUAL) {
        pos += chunk.length
      } else if (op === DiffMatchPatch.DIFF_DELETE) {
        shadowText.delete(pos, chunk.length)
      } else {
        shadowText.insert(pos, chunk)
        pos += chunk.length
      }
    }
  })

  const patch = Y.encodeStateAsUpdate(shadow, Y.encodeStateVector(live))
  Y.applyUpdate(live, patch, BRIDGE_ORIGIN)
  shadow.destroy()
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
pnpm --filter @holi/spike-bridge test
```

Expected: all 6 PASS. Note the logged overlap-merge result for the report (expected shape: `start HUMANAGENT end\n` or `start AGENTHUMAN end\n` — both inserts survive; **this is both-survive, not the "last-writer" D25's prose describes** — capture for the report).

- [ ] **Step 5: Commit**

```bash
git add spikes/bridge/src/merge.ts spikes/bridge/test/merge.test.ts
git commit -m "spike(bridge): frozen-base shadow-doc merge core + unit tests

Claude goes brr.. via Dash"
```

---

### Task 8: Harness actors — relay, sim clients, agent, BridgeClient

**Files:**
- Create: `spikes/bridge/src/harness.ts`
- Create: `spikes/bridge/src/agent.ts`
- Create: `spikes/bridge/src/bridge-client.ts`
- Test: `spikes/bridge/test/protocol.test.ts` (smoke test only in this task; scenarios in Task 9)

- [ ] **Step 1: Write the harness utilities**

`spikes/bridge/src/harness.ts`:

```ts
import { HocuspocusProvider, HocuspocusProviderWebsocket } from '@hocuspocus/provider'
import { Hocuspocus } from '@hocuspocus/server'
import ws from 'ws'
import * as Y from 'yjs'

export async function startRelay(port: number): Promise<Hocuspocus> {
  const relay = new Hocuspocus({ port, quiet: true })
  await relay.listen()
  return relay
}

export function connectDoc(url: string, room: string, doc: Y.Doc) {
  const socket = new HocuspocusProviderWebsocket({
    url,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    WebSocketPolyfill: ws as any,
  })
  const provider = new HocuspocusProvider({ websocketProvider: socket, name: room, document: doc })
  return {
    provider,
    destroy: () => {
      provider.destroy()
      socket.destroy()
    },
  }
}

/** A simulated human editing through the relay. */
export class SimClient {
  readonly doc = new Y.Doc()
  private readonly conn: ReturnType<typeof connectDoc>

  constructor(url: string, room: string) {
    this.conn = connectDoc(url, room, this.doc)
  }

  get text(): Y.Text {
    return this.doc.getText('content')
  }

  toString(): string {
    return this.text.toString()
  }

  insertAt(index: number, str: string): void {
    this.text.insert(index, str)
  }

  insertAfter(marker: string, str: string): void {
    const current = this.toString()
    const i = current.indexOf(marker)
    if (i < 0) throw new Error(`marker not found: ${marker}`)
    this.text.insert(i + marker.length, str)
  }

  replaceOnce(oldStr: string, newStr: string): void {
    const current = this.toString()
    const i = current.indexOf(oldStr)
    if (i < 0) throw new Error(`text not found: ${oldStr}`)
    this.doc.transact(() => {
      this.text.delete(i, oldStr.length)
      this.text.insert(i, newStr)
    })
  }

  destroy(): void {
    this.conn.destroy()
  }
}

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

export async function waitUntil(
  cond: () => boolean | Promise<boolean>,
  timeoutMs = 10_000,
  label = 'condition',
): Promise<void> {
  const start = Date.now()
  while (!(await cond())) {
    if (Date.now() - start > timeoutMs) throw new Error(`timeout waiting for: ${label}`)
    await sleep(20)
  }
}

export const converged = (texts: string[]) => texts.every((t) => t === texts[0])

export const countOccurrences = (haystack: string, needle: string) =>
  haystack.split(needle).length - 1
```

- [ ] **Step 2: Write the agent simulator**

`spikes/bridge/src/agent.ts`:

```ts
import { readFile, writeFile } from 'node:fs/promises'

/** Mimics Claude Code's native file tools against the materialized working copy. */
export class AgentSim {
  constructor(private readonly filePath: string) {}

  /** CC `Read`. */
  async read(): Promise<string> {
    return readFile(this.filePath, 'utf8')
  }

  /** CC `Write`: full-file rewrite. */
  async write(content: string): Promise<void> {
    await writeFile(this.filePath, content, 'utf8')
  }

  /** CC `Edit`: targeted string replace; throws if old_string is missing (mirrors CC's guard). */
  async edit(oldString: string, newString: string): Promise<void> {
    const current = await this.read()
    if (!current.includes(oldString)) {
      throw new Error(`edit failed: old_string not found: ${JSON.stringify(oldString)}`)
    }
    await this.write(current.replace(oldString, newString))
  }
}
```

- [ ] **Step 3: Write the bridge client (the component under test)**

`spikes/bridge/src/bridge-client.ts`:

```ts
import chokidar, { type FSWatcher } from 'chokidar'
import { readFile, writeFile } from 'node:fs/promises'
import * as Y from 'yjs'
import { applyAgentTurn, BRIDGE_ORIGIN } from './merge'

interface BridgeOpts {
  /** Quiet period after the last file event before the turn ends. */
  turnIdleMs: number
  /** Debounce for CRDT→file re-materialization on remote updates. */
  materializeDebounceMs: number
}

/**
 * D25 turn protocol, per doc:
 * - base = { text, Yjs state } captured at every materialization
 * - first watcher event where disk ≠ base ⇒ turn starts (soft lock:
 *   re-materialization paused, base frozen)
 * - idle debounce ⇒ turn ends: applyAgentTurn(live, base.state, fileText),
 *   new base = merge result, re-materialize, release
 */
export class BridgeClient {
  readonly doc = new Y.Doc()
  turns = 0

  private base: { text: string; state: Uint8Array } = { text: '', state: new Uint8Array() }
  private turnActive = false
  private turnTimer: ReturnType<typeof setTimeout> | null = null
  private materializeTimer: ReturnType<typeof setTimeout> | null = null
  private watcher: FSWatcher | null = null
  private readonly opts: BridgeOpts

  constructor(
    private readonly filePath: string,
    opts: Partial<BridgeOpts> = {},
  ) {
    this.opts = { turnIdleMs: 250, materializeDebounceMs: 50, ...opts }
  }

  get text(): Y.Text {
    return this.doc.getText('content')
  }

  get isTurnActive(): boolean {
    return this.turnActive
  }

  get baseText(): string {
    return this.base.text
  }

  async start(): Promise<void> {
    await this.materialize()
    this.doc.on('update', (_update: Uint8Array, origin: unknown) => {
      if (origin !== BRIDGE_ORIGIN) this.scheduleMaterialize()
    })
    this.watcher = chokidar.watch(this.filePath, { ignoreInitial: true })
    this.watcher.on('change', () => void this.onFileEvent())
    this.watcher.on('add', () => void this.onFileEvent())
  }

  async stop(): Promise<void> {
    if (this.turnTimer) clearTimeout(this.turnTimer)
    if (this.materializeTimer) clearTimeout(this.materializeTimer)
    await this.watcher?.close()
  }

  private scheduleMaterialize(): void {
    if (this.turnActive) return // soft lock: paused during agent turn
    if (this.materializeTimer) clearTimeout(this.materializeTimer)
    this.materializeTimer = setTimeout(() => void this.materialize(), this.opts.materializeDebounceMs)
  }

  /** CRDT → file. Captures the new base (text + state) atomically with the write. */
  private async materialize(): Promise<void> {
    if (this.turnActive) return
    const onDisk = await readFile(this.filePath, 'utf8').catch(() => null)
    if (onDisk !== null && onDisk !== this.base.text) {
      // Disk already diverged from base: an agent turn is underway that the
      // watcher hasn't delivered yet. Don't clobber — treat as a turn event.
      void this.onFileEvent()
      return
    }
    const text = this.text.toString()
    this.base = { text, state: Y.encodeStateAsUpdate(this.doc) }
    if (onDisk !== text) await writeFile(this.filePath, text, 'utf8')
  }

  private async onFileEvent(): Promise<void> {
    const content = await readFile(this.filePath, 'utf8').catch(() => null)
    if (content === null) return
    if (content === this.base.text) return // echo of our own materialization / no-op
    if (!this.turnActive) this.turnActive = true // soft lock engaged
    if (this.turnTimer) clearTimeout(this.turnTimer)
    this.turnTimer = setTimeout(() => void this.endTurn(), this.opts.turnIdleMs)
  }

  private async endTurn(): Promise<void> {
    const fileText = await readFile(this.filePath, 'utf8')
    applyAgentTurn(this.doc, this.base.state, fileText)
    this.turnActive = false
    this.turns += 1
    await this.materialize() // new base = merge result; release
  }
}
```

- [ ] **Step 4: Write the integration smoke test**

`spikes/bridge/test/protocol.test.ts` (scenario tests are added to this file in Task 9):

```ts
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Hocuspocus } from '@hocuspocus/server'
import { AgentSim } from '../src/agent'
import { BridgeClient } from '../src/bridge-client'
import {
  connectDoc,
  converged,
  SimClient,
  sleep,
  startRelay,
  waitUntil,
} from '../src/harness'

const PORT = 5401
const URL = `ws://127.0.0.1:${PORT}`

let relay: Hocuspocus
beforeAll(async () => {
  relay = await startRelay(PORT)
})
afterAll(async () => {
  await relay.destroy()
})

interface Scenario {
  filePath: string
  h1: SimClient
  h2: SimClient
  bridge: BridgeClient
  agent: AgentSim
  all: () => string[]
  settle: (expectedTurns: number) => Promise<string>
  teardown: () => Promise<void>
}

async function setupScenario(
  room: string,
  seed: string,
  bridgeOpts: ConstructorParameters<typeof BridgeClient>[1] = {},
): Promise<Scenario> {
  const dir = await mkdtemp(join(tmpdir(), 'bridge-spike-'))
  const filePath = join(dir, 'doc.md')
  const h1 = new SimClient(URL, room)
  const h2 = new SimClient(URL, room)
  h1.text.insert(0, seed)
  await waitUntil(() => h2.toString() === seed, 10_000, 'seed propagated to h2')

  const bridge = new BridgeClient(filePath, bridgeOpts)
  const conn = connectDoc(URL, room, bridge.doc)
  await waitUntil(() => bridge.text.toString() === seed, 10_000, 'bridge doc synced')
  await bridge.start()
  const agent = new AgentSim(filePath)

  const all = () => [h1.toString(), h2.toString(), bridge.text.toString()]
  return {
    filePath,
    h1,
    h2,
    bridge,
    agent,
    all,
    settle: async (expectedTurns: number) => {
      await waitUntil(() => bridge.turns >= expectedTurns, 15_000, `turns >= ${expectedTurns}`)
      await waitUntil(() => !bridge.isTurnActive, 15_000, 'turn released')
      await waitUntil(() => converged(all()), 10_000, 'replicas converged')
      await sleep(200) // let final re-materialization land on disk
      return readFile(filePath, 'utf8')
    },
    teardown: async () => {
      await bridge.stop()
      conn.destroy()
      h1.destroy()
      h2.destroy()
      await rm(dir, { recursive: true, force: true })
    },
  }
}

describe('bridge harness smoke', () => {
  it('materializes the doc and reflects a pure human edit back to disk', async () => {
    const s = await setupScenario('smoke', 'hello\n')
    try {
      await waitUntil(async () => (await readFile(s.filePath, 'utf8')) === 'hello\n')
      s.h1.insertAfter('hello', ' world')
      await waitUntil(
        async () => (await readFile(s.filePath, 'utf8')) === 'hello world\n',
        10_000,
        'human edit re-materialized',
      )
      expect(s.bridge.turns).toBe(0) // human edits never open a turn
      expect(s.bridge.baseText).toBe('hello world\n')
    } finally {
      await s.teardown()
    }
  })

  it('a lone agent edit lands in every replica', async () => {
    const s = await setupScenario('smoke-agent', 'alpha\nbeta\n')
    try {
      await waitUntil(async () => (await readFile(s.filePath, 'utf8')) === 'alpha\nbeta\n')
      await s.agent.edit('beta', 'BETA')
      const file = await s.settle(1)
      expect(file).toBe('alpha\nBETA\n')
      expect(s.all()).toEqual(['alpha\nBETA\n', 'alpha\nBETA\n', 'alpha\nBETA\n'])
    } finally {
      await s.teardown()
    }
  })
})
```

- [ ] **Step 5: Run the tests**

```bash
pnpm --filter @holi/spike-bridge test
```

Expected: merge unit tests + both smoke tests PASS. (If `HocuspocusProviderWebsocket`/`WebSocketPolyfill` misbehaves under the installed v2 minor, check `node_modules/@hocuspocus/provider/dist` exports; Node ≥ 22's global `WebSocket` is the fallback — drop the polyfill option.)

- [ ] **Step 6: Typecheck + commit**

```bash
pnpm --filter @holi/spike-bridge typecheck
git add spikes/bridge
git commit -m "spike(bridge): bridge client + agent sim + relay harness

Claude goes brr.. via Dash"
```

---

### Task 9: Acceptance scenarios (a), (c) end-to-end

**Files:**
- Modify: `spikes/bridge/test/protocol.test.ts` (append a new describe block)

(Acceptance (b) — overlap semantics — is covered deterministically at the unit level in Task 7; re-testing it through a racy socket adds noise, not signal.)

- [ ] **Step 1: Append the scenario tests**

Append to `spikes/bridge/test/protocol.test.ts`:

```ts
describe('D25 acceptance', () => {
  it('(a) concurrent non-overlapping human + agent edits both survive', async () => {
    const seed = '# Doc\n\nalpha\n\ngamma\n'
    const s = await setupScenario('accept-a', seed)
    try {
      await waitUntil(async () => (await readFile(s.filePath, 'utf8')) === seed)
      s.h1.insertAfter('alpha', ' (H1)')
      await s.agent.edit('gamma', 'gamma (A1)')
      const file = await s.settle(1)
      expect(file).toContain('alpha (H1)')
      expect(file).toContain('gamma (A1)')
      expect(converged([...s.all(), file])).toBe(true)
    } finally {
      await s.teardown()
    }
  })

  it('(c) remote edits landing mid-agent-turn do not poison the diff', async () => {
    const seed = 'one\ntwo\nthree\n'
    const s = await setupScenario('accept-c', seed, { turnIdleMs: 500 })
    try {
      await waitUntil(async () => (await readFile(s.filePath, 'utf8')) === seed)

      await s.agent.edit('one', 'ONE') // opens the turn
      await waitUntil(() => s.bridge.isTurnActive, 5_000, 'turn opened')

      // Remote human edit lands while the turn is active — buffered in the
      // live CRDT, invisible to the frozen file:
      s.h1.insertAfter('three', '\nfour (remote mid-turn)')
      await sleep(100)
      expect(await readFile(s.filePath, 'utf8')).not.toContain('four (remote mid-turn)') // file is frozen

      await s.agent.edit('three', 'THREE') // extends the same turn
      const file = await s.settle(1)

      expect(file).toContain('ONE')
      expect(file).toContain('THREE')
      expect(file).toContain('four (remote mid-turn)')
      expect(file).toContain('two') // untouched region intact
      expect(converged([...s.all(), file])).toBe(true)
    } finally {
      await s.teardown()
    }
  })
})
```

- [ ] **Step 2: Run, verify PASS**

```bash
pnpm --filter @holi/spike-bridge test
```

Expected: all tests PASS. Watch (c) especially — it is the frozen-base claim itself. If (c) fails, STOP and investigate before continuing; a failure here reopens D25 and the user wants that surfaced, not patched around.

- [ ] **Step 3: Commit**

```bash
git add spikes/bridge/test/protocol.test.ts
git commit -m "spike(bridge): acceptance (a) + (c) — frozen base survives mid-turn remote edits

Claude goes brr.. via Dash"
```

---

### Task 10: Acceptance (e) coalescing + (d) randomized hammer

**Files:**
- Modify: `spikes/bridge/test/protocol.test.ts` (append the coalescing test)
- Create: `spikes/bridge/test/hammer.test.ts`

- [ ] **Step 1: Append the coalescing test (e)**

Append to `spikes/bridge/test/protocol.test.ts`:

```ts
describe('D25 acceptance — watcher coalescing (e)', () => {
  it('rapid Write+Edit+Edit within the idle window coalesce into ONE turn; separate bursts land as separate turns', async () => {
    const seed = 'title\nbody\nfooter\n'
    const s = await setupScenario('accept-e', seed, { turnIdleMs: 400 })
    try {
      await waitUntil(async () => (await readFile(s.filePath, 'utf8')) === seed)

      // Burst 1: three rapid ops, all inside one idle window
      await s.agent.write('title v2\nbody\nfooter\n')
      await s.agent.edit('body', 'body v2')
      await s.agent.edit('footer', 'footer v2')
      const file1 = await s.settle(1)
      expect(s.bridge.turns).toBe(1) // coalesced — not three turns
      expect(file1).toBe('title v2\nbody v2\nfooter v2\n')

      // Burst 2 after idle: a distinct second turn, nothing dropped
      await s.agent.edit('title v2', 'title v3')
      const file2 = await s.settle(2)
      expect(s.bridge.turns).toBe(2)
      expect(file2).toBe('title v3\nbody v2\nfooter v2\n')
      expect(converged([...s.all(), file2])).toBe(true)
    } finally {
      await s.teardown()
    }
  })
})
```

- [ ] **Step 2: Write the hammer test (d)**

Turn boundaries in the hammer are burst-shaped on purpose: the harness detects turn end by watcher idle, so an agent op landing in the same instant a turn ends would race `endTurn`'s read↔rematerialize window. That race is real and goes in the report (real impl should end turns on an agent-side signal — Stop hook / PTY idle — with debounce only as fallback); the hammer's job is lost-update detection under concurrency, so it keeps agent ops inside bursts with quiet gaps, while humans edit continuously with no coordination at all.

`spikes/bridge/test/hammer.test.ts`:

```ts
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Hocuspocus } from '@hocuspocus/server'
import { AgentSim } from '../src/agent'
import { BridgeClient } from '../src/bridge-client'
import {
  connectDoc,
  converged,
  countOccurrences,
  SimClient,
  sleep,
  startRelay,
  waitUntil,
} from '../src/harness'

const PORT = 5402
const URL = `ws://127.0.0.1:${PORT}`

let relay: Hocuspocus
beforeAll(async () => {
  relay = await startRelay(PORT)
})
afterAll(async () => {
  await relay.destroy()
})

function mulberry32(seed: number) {
  return () => {
    let t = (seed += 0x6d2b79f5)
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

describe('D25 acceptance — randomized hammer (d): no lost updates', () => {
  it('humans hammer continuously while the agent edits in bursts; every marker survives exactly once', async () => {
    const rnd = mulberry32(0xd25)
    const seed =
      ['# Hammer', 'L1:', 'L2:', 'L3:', 'L4:', 'L5:', 'L6:', 'L7:', 'L8:', 'AGENT:'].join('\n') +
      '\n'

    const dir = await mkdtemp(join(tmpdir(), 'bridge-hammer-'))
    const filePath = join(dir, 'doc.md')
    const h1 = new SimClient(URL, 'hammer')
    const h2 = new SimClient(URL, 'hammer')
    h1.text.insert(0, seed)
    await waitUntil(() => h2.toString() === seed, 10_000, 'seed propagated')

    const bridge = new BridgeClient(filePath, { turnIdleMs: 300 })
    const conn = connectDoc(URL, 'hammer', bridge.doc)
    await waitUntil(() => bridge.text.toString() === seed, 10_000, 'bridge synced')
    await bridge.start()
    const agent = new AgentSim(filePath)
    await waitUntil(async () => (await readFile(filePath, 'utf8')) === seed)

    const tokens: string[] = []
    let n = 0
    const humanOp = (who: SimClient, tag: string) => {
      const token = ` ${tag}-${++n}#`
      who.insertAfter(`L${1 + Math.floor(rnd() * 8)}:`, token)
      tokens.push(token.trim())
    }

    const BURSTS = 8
    for (let burst = 1; burst <= BURSTS; burst++) {
      const agentOps = 2 + Math.floor(rnd() * 3) // 2–4 ops per burst
      for (let op = 0; op < agentOps; op++) {
        const token = `a${++n}#`
        if (rnd() < 0.3) {
          // full-file rewrite (CC Write after Read): append to the AGENT line
          const current = await agent.read()
          await agent.write(
            current
              .split('\n')
              .map((line) => (line.startsWith('AGENT:') ? `${line} ${token}` : line))
              .join('\n'),
          )
        } else {
          // targeted replace (CC Edit)
          await agent.edit('AGENT:', `AGENT: ${token}`)
        }
        tokens.push(token)
        humanOp(h1, 'h1')
        humanOp(h2, 'h2')
        await sleep(30 + rnd() * 60)
      }
      // quiet gap ends the turn; humans keep going regardless
      humanOp(h1, 'h1')
      humanOp(h2, 'h2')
      await sleep(700)
    }

    // Settle: no active turn, all replicas + disk converged
    await waitUntil(() => !bridge.isTurnActive, 20_000, 'final turn released')
    const all = () => [h1.toString(), h2.toString(), bridge.text.toString()]
    await waitUntil(() => converged(all()), 15_000, 'replicas converged')
    await sleep(300)
    const file = await readFile(filePath, 'utf8')
    expect(converged([...all(), file])).toBe(true)

    // The heart of acceptance (d): nothing lost, nothing duplicated
    const missing = tokens.filter((t) => countOccurrences(file, t) === 0)
    const duplicated = tokens.filter((t) => countOccurrences(file, t) > 1)
    console.log(
      `[spike] hammer: ${tokens.length} markers, ${bridge.turns} agent turns, ` +
        `${missing.length} missing, ${duplicated.length} duplicated`,
    )
    expect(missing).toEqual([])
    expect(duplicated).toEqual([])
    expect(bridge.turns).toBeGreaterThanOrEqual(4)

    await bridge.stop()
    conn.destroy()
    h1.destroy()
    h2.destroy()
    await rm(dir, { recursive: true, force: true })
  })
})
```

- [ ] **Step 3: Run the full spike suite, several times**

```bash
pnpm --filter @holi/spike-bridge test
pnpm --filter @holi/spike-bridge test
pnpm --filter @holi/spike-bridge test
```

Expected: PASS ×3 (the hammer is seeded but socket/watcher timing is real — repeated runs are the point). Record the hammer's logged stats for the report. If a run fails, capture the exact missing/duplicated markers and diagnose before rerunning — a genuine lost update is a decision-reopening finding, not a flake to shrug off.

- [ ] **Step 4: Commit**

```bash
git add spikes/bridge/test
git commit -m "spike(bridge): acceptance (e) coalescing + (d) randomized hammer

Claude goes brr.. via Dash"
```

---

### Task 11: Spike report

**Files:**
- Create: `docs/spikes/2026-07-10-bridge-turn-protocol.md`
- Modify: `docs/README.md` (add one index line — read it first, match its list style)

- [ ] **Step 1: Write the report from OBSERVED results**

Template — every `⟨…⟩` must be replaced with what the tests actually showed; do not publish guesses:

```markdown
# Spike report — D25 file↔CRDT bridge turn protocol

**Date:** 2026-07-10 · **Verdict:** ⟨holds / holds with caveats / fights back — reopen D25⟩

The bridge (D2/D25) is the only genuinely novel component in the rebuild; this spike
built a throwaway harness (`spikes/bridge/`) and hammered the turn protocol before any
other code, per the de-risk mandate in D25.

## What was built

- **Merge core** (`spikes/bridge/src/merge.ts`): at turn end, fork a shadow Y.Doc from the
  frozen base state, apply `diff-match-patch(base → file)` as positioned Y.Text ops on the
  shadow, then merge the shadow's state-vector delta into the live doc. The shadow acts as
  a virtual client offline since the freeze; **Yjs's own CRDT merge does the 3-way**. Never
  blind-replace.
- **BridgeClient** (`src/bridge-client.ts`): chokidar watcher; first disk≠base event opens
  the turn (soft lock, re-materialization paused, base frozen); idle debounce ends it;
  new base = merge result.
- **Harness**: in-process Hocuspocus relay, two SimClient humans, AgentSim mimicking CC
  `Write`/`Edit` (read → string-replace → full write).

## Acceptance results

| # | Criterion | Test | Result |
|---|---|---|---|
| a | non-overlapping human+agent edits both survive | `protocol.test.ts` "(a)" + `merge.test.ts` | ⟨PASS/FAIL⟩ |
| b | same-range overlap converges, surroundings intact | `merge.test.ts` "(b)" | ⟨PASS/FAIL⟩ |
| c | mid-turn remote edits don't poison the diff | `protocol.test.ts` "(c)" | ⟨PASS/FAIL⟩ |
| d | no lost updates under randomized hammer | `hammer.test.ts` (⟨N⟩ markers, ⟨N⟩ turns, ×⟨runs⟩ runs) | ⟨PASS/FAIL⟩ |
| e | debounce/coalescing drops no turns | `protocol.test.ts` "(e)" | ⟨PASS/FAIL⟩ |

## Findings

1. **Same-range overlap is both-survive, not last-writer.** Concurrent inserts into the
   same range interleave (observed: ⟨actual merged string⟩) — Yjs deletes merge, but both
   replacement texts survive side by side. D25's prose says "character-level last-writer";
   the accurate statement is ⟨…⟩. This does not break convergence and D26's safety net is
   designed for exactly this garble class, but the wording in D25/D26 should be corrected.
2. **Turn-end detection by watcher idle has an inherent race.** If the agent writes at the
   exact moment a turn ends (between `endTurn`'s file read and its re-materialization), the
   agent's read of the just-superseded file can produce a stale diff. The harness sidesteps
   it with burst-shaped agent activity; the real bridge should end turns on an **agent-side
   signal** (CC Stop hook or PTY idle state) with watcher debounce as fallback. ⟨observed?
   any hammer near-misses?⟩
3. **Self-write echo suppression by content-equality worked** (`content === base.text` on
   watcher events) — no marker files, no mtime bookkeeping. ⟨caveats observed⟩
4. ⟨further findings from the runs⟩

## What to promote into `packages/shared` (when the real bridge is built)

`applyAgentTurn` as-is (shadow-fork + dmp diff + SV-delta merge, ~40 lines), plus the
base-capture invariant: **base text and base state must be captured atomically at every
materialization**. The BridgeClient shell is harness-grade, not production code.

## Open questions for the real bridge

- Turn-start signal: watcher-first-event vs CC PreToolUse/PTY-busy (affects the
  materialize-vs-first-write race noted in `BridgeClient.materialize`).
- Turn-end signal: Stop hook vs idle debounce (finding 2).
- ⟨others observed⟩
```

- [ ] **Step 2: Add the index line**

Read `docs/README.md`, find the natural section (or add a `## Spikes` section at the end of the doc list), append:

```markdown
- [spikes/2026-07-10-bridge-turn-protocol.md](spikes/2026-07-10-bridge-turn-protocol.md) — Spike 1 findings: the D25 frozen-base turn protocol under concurrent hammering
```

- [ ] **Step 3: Commit**

```bash
git add docs/spikes docs/README.md
git commit -m "docs: D25 bridge spike report — findings + verdict

Claude goes brr.. via Dash"
```

---

## Self-review checklist (run after execution too)

- Spec coverage: D15 layout (Task 1–5), all five spike acceptance criteria (Tasks 7–10: a→7+9, b→7, c→7+9, d→10, e→10), spike report either-way outcome (Task 11). ✓
- The bridge never blind-replaces (merge.ts is diff-only). ✓
- No task touches `docs/` except plans/, spikes/, and one README index line. ✓
- Type names consistent across tasks (`applyAgentTurn(live, baseState, fileText)`, `BridgeClient.turns/isTurnActive/baseText`, `SimClient.insertAfter/replaceOnce`, `AgentSim.read/write/edit`, harness `waitUntil/converged/countOccurrences`). ✓
