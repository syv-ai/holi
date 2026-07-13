# Agent Drawer Foundations (Slice 1) Implementation Plan

> **For agentic workers:** Use the executing-plans skill to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Everything the agent drawer needs below the PTY: full-vault working-copy materialization in Electron main (live Yjs mirror), the file↔CRDT bridge running the spike-proven turn protocol with persisted crash-safe bases, agent-created/deleted file lifecycle, the server SSE event stream, and the pre-agent-write snapshot op. After this slice, a file edited in the working dir merges live into teammates' editors — no `claude` involved yet.

**Architecture:** `packages/shared` gains the promoted merge core (`applyAgentTurn` on fast-diff, one diff engine repo-wide) and `isLocalOnlyPath`. `apps/server` gains `GET /events/<vaultId>` (SSE off the existing bus) and `snapshots.take`. `apps/desktop` main gains `src/main/vault/*`: `SseClient` (fetch-based SSE consumer), `VaultMirror` (one multiplexed WebSocket, a live Y.Doc + `DocBridge` per doc, chokidar watcher, docs-event handling, create/delete lifecycle symmetric with the git ingress), wired behind a `holi:vault:activate` IPC. Design: `docs/specs/2026-07-13-agent-drawer-design.md`; spike: `docs/spikes/2026-07-10-bridge-turn-protocol.md`.

**Tech Stack:** yjs + @hocuspocus/provider (existing pins), fast-diff, chokidar 5, ws (main-process WebSocket), vitest with in-process Hocuspocus relays (the spike-harness pattern). No native modules in this slice (node-pty is slice 2).

**Environment notes (repo quirks):** run everything through `pnpm` from the repo root (bare `node`/`npx` are broken); Postgres for server tests is the compose instance on **5433** (`pnpm db:up`); check exit codes, not piped output; scope any `pkill` (`better-holi-final.*electron`) — Dash itself is Electron.

**Deviations from the spec, decided here (record in the spec in Task 11):**
1. **One diff engine.** `applyAgentTurn` is promoted onto **fast-diff** (the server's existing dep) instead of the spike's diff-match-patch — the spike's acceptance tests re-run against it in shared. Any valid diff produces the same merged text; only op granularity differs.
2. **`isLocalOnlyPath` moves to shared and gains root `USER.md`** — the spec says USER.md is machine-local, never vault content; the mirror and the git exporter now share one definition.
3. **Turn signals are watcher-mode in this slice.** The `signalTurnEnd()` seam is in place; the PreToolUse/Stop hook routes land in slice 2 with the McpServer (per the spec's build order).
4. **No-base recovery:** a known doc path on disk with no persisted base can't be diffed — server truth wins (file rewritten). Unknown files found on disk are adopted as agent creations (startup scan + SSE-reconnect refresh).
5. **Failed lifecycle propagation self-heals via `refresh()`:** if `notes.create`/`notes.delete` fails (offline), the next SSE reconnect re-runs the reconcile, which re-adopts unknown files and re-materializes deleted-but-unpropagated ones. No bespoke retry queue.

---

## File structure

**Shared — create:**
- `packages/shared/src/agent-merge.ts` — `BRIDGE_ORIGIN`, `applyTextDiff` (moved from server), `applyAgentTurn` (promoted from the spike)

**Shared — modify:**
- `packages/shared/src/path-safety.ts` — add `isLocalOnlyPath` (moved from server exporter, + `USER.md`)
- `packages/shared/src/index.ts` — export `./agent-merge`
- `packages/shared/package.json` — add `fast-diff`, `yjs`

**Server — create:**
- `apps/server/src/events.ts` — SSE handler (`GET /events/<vaultId>`), bus → stream, membership-gated

**Server — modify:**
- `apps/server/src/git/apply-diff.ts` — **delete** (moved to shared); update importers (`git/ingester.ts`, `git/exporter.ts`)
- `apps/server/src/routers/snapshots.ts` — add `take` mutation (reason `pre-agent-write`)
- `apps/server/src/main.ts` — route `GET /events/<uuid>`
- `apps/server/package.json` — drop `fast-diff` (now via shared)

**Desktop — create (all in main):**
- `apps/desktop/src/main/vault/sse-client.ts` — fetch-based SSE consumer with reconnect/backoff
- `apps/desktop/src/main/vault/vault-files.ts` — atomic tmp+rename writes, abs↔rel mapping, ignore rules, recursive listing
- `apps/desktop/src/main/vault/base-store.ts` — persisted per-doc frozen bases (crash recovery)
- `apps/desktop/src/main/vault/doc-bridge.ts` — per-doc turn protocol (spike `BridgeClient`, productionized)
- `apps/desktop/src/main/vault/vault-mirror.ts` — the vault: providers, watcher, docs events, create/delete lifecycle
- `apps/desktop/src/main/vault/mirror-api.ts` — `MirrorApi` impl over the existing `ServerClient`
- `apps/desktop/src/main/vault/vault-manager.ts` — activate/deactivate per vault; owns SseClient + VaultMirror

**Desktop — modify:**
- `apps/desktop/src/main/index.ts` — construct the manager, pass to IPC, teardown on quit
- `apps/desktop/src/main/ipc.ts` — `holi:vault:activate` handler
- `apps/desktop/src/preload/index.ts` + `src/renderer/src/global.d.ts` — mirror the IPC
- `apps/desktop/src/renderer/src/components/Shell.tsx` — activate on vault switch
- `apps/desktop/package.json` — add `chokidar`, `ws`; devDeps `@hocuspocus/server`, `@types/ws`

**Tests:**
- `packages/shared/test/agent-merge.test.ts` (spike tests adapted) + `packages/shared/test/apply-text-diff.test.ts` (moved from server)
- `apps/server/test/events-sse.test.ts`, extend `apps/server/test/snapshots.test.ts`
- `apps/desktop/test/helpers/relay.ts` (spike harness port), `sse-client.test.ts`, `vault-files.test.ts`, `base-store.test.ts`, `doc-bridge.test.ts`, `vault-mirror.test.ts`, `vault-hammer.test.ts`

---

### Task 1: Promote the merge core into `packages/shared`

**Files:**
- Create: `packages/shared/src/agent-merge.ts`
- Modify: `packages/shared/src/path-safety.ts`, `packages/shared/src/index.ts`, `packages/shared/package.json`
- Modify: `apps/server/src/git/ingester.ts`, `apps/server/src/git/exporter.ts`, `apps/server/package.json`
- Delete: `apps/server/src/git/apply-diff.ts`
- Test: `packages/shared/test/agent-merge.test.ts`; move `apps/server/test/apply-diff.test.ts` → `packages/shared/test/apply-text-diff.test.ts`

- [ ] **Step 1: Add deps to shared**

In `packages/shared/package.json`, add to `dependencies` (create the block if absent — currently the package has none):

```json
  "dependencies": {
    "fast-diff": "^1.3.0",
    "yjs": "^13.6.31"
  },
```

Run: `pnpm install`
Expected: lockfile updates, exit 0.

- [ ] **Step 2: Write the failing test (spike acceptance, adapted to fast-diff + YDOC_TEXT_KEY)**

```ts
// packages/shared/test/agent-merge.test.ts
import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { applyAgentTurn, BRIDGE_ORIGIN, YDOC_TEXT_KEY } from '../src'

function seededDoc(text: string): Y.Doc {
  const doc = new Y.Doc()
  doc.getText(YDOC_TEXT_KEY).insert(0, text)
  return doc
}
const snap = (doc: Y.Doc) => Y.encodeStateAsUpdate(doc)
const read = (doc: Y.Doc) => doc.getText(YDOC_TEXT_KEY).toString()

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
    live.getText(YDOC_TEXT_KEY).insert('# Title\n\nalpha'.length, ' (human)')
    applyAgentTurn(live, base, '# Title\n\nalpha\n\nomega (agent)\n')
    expect(read(live)).toBe('# Title\n\nalpha (human)\n\nomega (agent)\n')
  })

  it('(c) remote insert inside an agent-deleted region survives the delete', () => {
    const live = seededDoc('keep DELETE-ME keep\n')
    const base = snap(live)
    live.getText(YDOC_TEXT_KEY).insert('keep DELETE'.length, '[remote]')
    applyAgentTurn(live, base, 'keep keep\n')
    expect(read(live)).toBe('keep [remote]keep\n')
  })

  it('(b) overlapping same-range rewrites converge without corrupting surroundings', () => {
    const live = seededDoc('start MIDDLE end\n')
    const base = snap(live)
    const text = live.getText(YDOC_TEXT_KEY)
    live.transact(() => {
      text.delete('start '.length, 'MIDDLE'.length)
      text.insert('start '.length, 'HUMAN')
    })
    applyAgentTurn(live, base, 'start AGENT end\n')
    const out = read(live)
    expect(out).toMatch(/^start .+ end\n$/)
    expect(out).toContain('HUMAN')
    expect(out).toContain('AGENT')
    expect(out).not.toContain('MIDDLE')
  })

  it('multiple scattered edits in one turn all land at the right positions', () => {
    const live = seededDoc('L1 aaa\nL2 bbb\nL3 ccc\nL4 ddd\n')
    const base = snap(live)
    live.getText(YDOC_TEXT_KEY).insert('L1 aaa\nL2 bbb'.length, ' [h]')
    applyAgentTurn(live, base, 'L1 AAA\nL2 bbb\nL3 ccc\nL4 DDD\nL5 eee\n')
    expect(read(live)).toBe('L1 AAA\nL2 bbb [h]\nL3 ccc\nL4 DDD\nL5 eee\n')
  })

  it('returns the agent-lineage state (base + agent ops, without remote edits)', () => {
    const live = seededDoc('one\ntwo\n')
    const base = snap(live)
    live.getText(YDOC_TEXT_KEY).insert(0, 'REMOTE ')
    const { agentState } = applyAgentTurn(live, base, 'one\ntwo\nthree\n')
    const lineage = new Y.Doc()
    Y.applyUpdate(lineage, agentState)
    expect(lineage.getText(YDOC_TEXT_KEY).toString()).toBe('one\ntwo\nthree\n')
  })

  it('applies the merge with BRIDGE_ORIGIN so bridges can filter their own echo', () => {
    const live = seededDoc('x\n')
    const base = snap(live)
    let seenOrigin: unknown = 'unset'
    live.on('update', (_u: Uint8Array, origin: unknown) => (seenOrigin = origin))
    applyAgentTurn(live, base, 'y\n')
    expect(seenOrigin).toBe(BRIDGE_ORIGIN)
  })
})

describe('isLocalOnlyPath (shared)', () => {
  it('matches *.local.* basenames, USER.md at root, and nothing else', async () => {
    const { isLocalOnlyPath } = await import('../src')
    expect(isLocalOnlyPath('.holi/settings.local.json')).toBe(true)
    expect(isLocalOnlyPath('CLAUDE.local.md')).toBe(true)
    expect(isLocalOnlyPath('.holi/context.local.json')).toBe(true)
    expect(isLocalOnlyPath('USER.md')).toBe(true)
    expect(isLocalOnlyPath('notes/USER.md')).toBe(false)
    expect(isLocalOnlyPath('notes/a.md')).toBe(false)
    expect(isLocalOnlyPath('.claude/settings.json')).toBe(false)
  })
})
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm --filter @holi/shared exec vitest run test/agent-merge.test.ts`
Expected: FAIL — `applyAgentTurn` not exported

- [ ] **Step 4: Implement `agent-merge.ts` and the `isLocalOnlyPath` move**

```ts
// packages/shared/src/agent-merge.ts
/**
 * The turn-protocol merge core (spike 2026-07-10, promoted; architecture §3).
 * Used by the desktop bridge at agent-turn end and by the server git ingester.
 * Invariants carried from the spike: never blind-replace; the caller must
 * capture base text + base Yjs state atomically at every materialization, and
 * advance the base before releasing the turn lock.
 */
import diff from 'fast-diff'
import * as Y from 'yjs'
import { YDOC_TEXT_KEY } from './ydoc'

export const BRIDGE_ORIGIN = 'bridge-merge'

/** diff(base → next) applied as positioned ops onto a LIVE Y.Text that may
 * contain concurrent edits. Positions are computed against `base`; when the
 * live text has diverged, Yjs convergence semantics apply (both texts survive,
 * deterministically ordered). Returns true when the live text had diverged. */
export function applyTextDiff(text: Y.Text, base: string, next: string): boolean {
  const diverged = text.toString() !== base
  let cursor = 0
  for (const [op, chunk] of diff(base, next)) {
    if (op === diff.EQUAL) {
      cursor += chunk.length
    } else if (op === diff.DELETE) {
      // clamp defensively: a diverged live text can be shorter than base
      const len = Math.min(chunk.length, Math.max(0, text.length - cursor))
      if (len > 0) text.delete(cursor, len)
    } else {
      const at = Math.min(cursor, text.length)
      text.insert(at, chunk)
      cursor += chunk.length
    }
  }
  return diverged
}

/**
 * Turn end: fork a shadow doc from the frozen base state, replay diff(base →
 * file) on the shadow (positions are valid there — the shadow IS the base),
 * then merge the shadow's state-vector delta into the live doc. The shadow is
 * a virtual client that went offline at the freeze point and made exactly the
 * agent's edits; Yjs's CRDT merge does the 3-way positional reconciliation.
 * Returns the shadow's post-op state — the agent's file lineage, which the
 * caller needs as the next frozen base if the agent is still writing.
 */
export function applyAgentTurn(
  live: Y.Doc,
  baseState: Uint8Array,
  fileText: string,
): { agentState: Uint8Array } {
  const shadow = new Y.Doc()
  Y.applyUpdate(shadow, baseState)
  const shadowText = shadow.getText(YDOC_TEXT_KEY)
  const baseText = shadowText.toString()
  if (baseText === fileText) {
    shadow.destroy()
    return { agentState: baseState }
  }
  shadow.transact(() => {
    applyTextDiff(shadowText, baseText, fileText)
  })
  const patch = Y.encodeStateAsUpdate(shadow, Y.encodeStateVector(live))
  Y.applyUpdate(live, patch, BRIDGE_ORIGIN)
  const agentState = Y.encodeStateAsUpdate(shadow)
  shadow.destroy()
  return { agentState }
}
```

Append to `packages/shared/src/path-safety.ts`:

```ts
/** Machine-local paths that sync/mirror/export layers must never treat as
 * vault content: `*.local.*` basenames (`.holi/settings.local.json`,
 * `CLAUDE.local.md`, `.holi/context.local.json`) and the personal root
 * `USER.md` (agent PRD §Config layering). */
export function isLocalOnlyPath(path: string): boolean {
  if (path === 'USER.md') return true
  const base = path.split('/').at(-1) ?? path
  return /\.local\./.test(base)
}
```

Add to `packages/shared/src/index.ts`:

```ts
export * from './agent-merge'
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @holi/shared test`
Expected: PASS (new file + all existing shared tests)

- [ ] **Step 6: Repoint the server at shared and delete the old module**

1. Delete `apps/server/src/git/apply-diff.ts`.
2. In `apps/server/src/git/ingester.ts`: replace `import { applyTextDiff } from './apply-diff'` with adding `applyTextDiff` to the existing `@holi/shared` import, and replace `import { isLocalOnlyPath } from './exporter'` with adding `isLocalOnlyPath` to the same `@holi/shared` import.
3. In `apps/server/src/git/exporter.ts`: delete the local `isLocalOnlyPath` function (and its jsdoc) and import it from `@holi/shared` instead; keep the re-export **out** — importers now use shared directly.
4. Move the diff tests: `git mv apps/server/test/apply-diff.test.ts packages/shared/test/apply-text-diff.test.ts`, then change its import from `../src/git/apply-diff` to `../src` (every test case stays as-is).
5. In `apps/server/package.json`: remove `"fast-diff"` from dependencies, then verify nothing else imports it: `grep -rn "fast-diff" apps/server/src` → expect no hits. Run `pnpm install`.

- [ ] **Step 7: Run both suites + typecheck**

Run: `pnpm --filter @holi/shared test && pnpm --filter @holi/server test && pnpm -r typecheck`
Expected: all PASS / clean (server suite needs `pnpm db:up` first)

- [ ] **Step 8: Commit**

```bash
git add packages/shared apps/server pnpm-lock.yaml
git commit -m "feat(shared): promote turn-protocol merge core + isLocalOnlyPath from spike/server"
```

---

### Task 2: Server — `snapshots.take` (pre-agent-write)

**Files:**
- Modify: `apps/server/src/routers/snapshots.ts`
- Test: `apps/server/test/snapshots.test.ts` (extend)

- [ ] **Step 1: Write the failing test**

Append inside the existing `describe('snapshots', …)` block in `apps/server/test/snapshots.test.ts` (it already has `t`, `userId`, `docId`, `ctxFor`, and imports for `snapshotsRouter`, `yjsSnapshots`, `eq`, `editDocText`, `replaceAllText`, `seedUser`):

```ts
  it('take stores a pre-agent-write snapshot of the current stored state', async () => {
    await editDocText(t.db, () => null, docId, (text) => replaceAllText(text, 'pre-agent content'))
    await snapshotsRouter.createCaller(ctxFor(t, userId)).take({ docId })
    const rows = await t.db.select().from(yjsSnapshots).where(eq(yjsSnapshots.docId, docId))
    const snap = rows.find((r) => r.reason === 'pre-agent-write')
    expect(snap).toBeDefined()
    expect(snap!.label).toBe('before Claude edited')
    expect(snap!.authorId).toBe(userId)
    expect(docText(docFromState(snap!.state))).toBe('pre-agent content')
  })

  it('take prefers the live relay doc over the stored state', async () => {
    const live = docFromState(await loadDocState(t.db, docId))
    live.getText('content').insert(0, 'LIVE ')
    await snapshotsRouter.createCaller({ ...ctxFor(t, userId), getLiveDoc: () => live }).take({ docId })
    const rows = await t.db.select().from(yjsSnapshots).where(eq(yjsSnapshots.docId, docId))
    const latest = rows.filter((r) => r.reason === 'pre-agent-write').at(-1)!
    expect(docText(docFromState(latest.state))).toContain('LIVE ')
  })

  it('take is membership-gated', async () => {
    const outsider = await seedUser(t.db)
    await expect(snapshotsRouter.createCaller(ctxFor(t, outsider.id)).take({ docId })).rejects.toThrow(/FORBIDDEN|forbidden/)
  })
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @holi/server exec vitest run test/snapshots.test.ts`
Expected: FAIL — `take` is not a procedure

- [ ] **Step 3: Implement the mutation**

In `apps/server/src/routers/snapshots.ts`, add `import * as Y from 'yjs'` and `loadDocState` to the existing `../yjs/doc-store` import, then add to the router (after `list`):

```ts
  /** Pre-agent-write snapshot — the bridge calls this at turn open (agent PRD
   * §Merge safety net). Live relay state when the doc has an open room. */
  take: authedProcedure
    .input(z.object({ docId: z.string().uuid(), label: z.string().max(200).optional() }))
    .mutation(async ({ ctx, input }) => {
      await requireDocAccess(ctx.db, input.docId, ctx.user.id)
      const live = ctx.getLiveDoc(input.docId)
      const state = live ? Y.encodeStateAsUpdate(live) : await loadDocState(ctx.db, input.docId)
      if (!state) throw new TRPCError({ code: 'NOT_FOUND' })
      await takeSnapshot(ctx.db, {
        docId: input.docId,
        state,
        reason: 'pre-agent-write',
        label: input.label ?? 'before Claude edited',
        authorId: ctx.user.id,
      })
      return { ok: true }
    }),
```

(`pre-agent-write` already exists in `SnapshotReason` — no schema change.)

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @holi/server exec vitest run test/snapshots.test.ts`
Expected: PASS (existing + 3 new)

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/routers/snapshots.ts apps/server/test/snapshots.test.ts
git commit -m "feat(server): snapshots.take — pre-agent-write snapshot op"
```

---

### Task 3: Server — SSE event stream

**Files:**
- Create: `apps/server/src/events.ts`
- Modify: `apps/server/src/main.ts`
- Test: `apps/server/test/events-sse.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// apps/server/test/events-sse.test.ts
import { createServer, type Server } from 'node:http'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createBus, type Bus } from '../src/bus'
import { makeEventsHandler } from '../src/events'
import { createTestDb, type TestDb } from '../src/test/db'
import { seedSession, seedUser, seedVault } from '../src/test/fixtures'

let t: TestDb
let bus: Bus
let server: Server
let base: string
let vaultId: string
let token: string

beforeAll(async () => {
  t = await createTestDb()
  bus = createBus()
  const user = await seedUser(t.db)
  vaultId = (await seedVault(t.db, user.id)).id
  token = await seedSession(t.db, user.id)
  const handler = makeEventsHandler({ db: t.db, bus })
  server = createServer((req, res) => {
    const m = /^\/events\/([0-9a-f-]{36})$/.exec(req.url ?? '')
    if (req.method === 'GET' && m) return void handler(req, res, m[1]!)
    res.statusCode = 404
    res.end()
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
})
afterAll(async () => {
  server.close()
  await t.destroy()
})

/** Read SSE blocks off a fetch response until `count` events arrived. */
async function readEvents(res: Response, count: number): Promise<Array<{ channel: string; data: unknown }>> {
  const out: Array<{ channel: string; data: unknown }> = []
  const decoder = new TextDecoder()
  let buf = ''
  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
    buf += decoder.decode(chunk, { stream: true })
    let sep: number
    while ((sep = buf.indexOf('\n\n')) >= 0) {
      const block = buf.slice(0, sep)
      buf = buf.slice(sep + 2)
      let channel = ''
      let data = ''
      for (const line of block.split('\n')) {
        if (line.startsWith('event:')) channel = line.slice(6).trim()
        if (line.startsWith('data:')) data = line.slice(5).trim()
      }
      if (channel && data) out.push({ channel, data: JSON.parse(data) })
      if (out.length >= count) return out
    }
  }
  return out
}

describe('GET /events/<vaultId>', () => {
  it('streams docs + tasks events for the vault, not others', async () => {
    const res = await fetch(`${base}/events/${vaultId}`, { headers: { authorization: `Bearer ${token}` } })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/event-stream')
    const doc = { id: '00000000-0000-0000-0000-000000000001', vaultId, path: 'a.md', kind: 'note', createdAt: '', updatedAt: '' }
    // an event for a DIFFERENT vault must not leak into this stream
    bus.emitDocs('99999999-9999-4999-8999-999999999999', { type: 'created', doc: { ...doc, vaultId: 'other' } })
    bus.emitDocs(vaultId, { type: 'created', doc })
    bus.emitTasks(vaultId, { type: 'deleted', taskId: 'task-1' })
    const events = await readEvents(res, 2)
    expect(events[0]).toEqual({ channel: 'docs', data: { type: 'created', doc } })
    expect(events[1]).toEqual({ channel: 'tasks', data: { type: 'deleted', taskId: 'task-1' } })
  })

  it('rejects a missing token with 401 and a non-member with 403', async () => {
    expect((await fetch(`${base}/events/${vaultId}`)).status).toBe(401)
    const outsider = await seedUser(t.db)
    const outsiderToken = await seedSession(t.db, outsider.id)
    expect(
      (await fetch(`${base}/events/${vaultId}`, { headers: { authorization: `Bearer ${outsiderToken}` } })).status,
    ).toBe(403)
  })

  it('unsubscribes from the bus when the client disconnects', async () => {
    const before = bus.listenerCount(`docs:${vaultId}`)
    const controller = new AbortController()
    const res = await fetch(`${base}/events/${vaultId}`, {
      headers: { authorization: `Bearer ${token}` },
      signal: controller.signal,
    })
    expect(res.status).toBe(200)
    expect(bus.listenerCount(`docs:${vaultId}`)).toBe(before + 1)
    controller.abort()
    await new Promise((r) => setTimeout(r, 100))
    expect(bus.listenerCount(`docs:${vaultId}`)).toBe(before)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @holi/server exec vitest run test/events-sse.test.ts`
Expected: FAIL — `../src/events` not found

- [ ] **Step 3: Implement the handler**

```ts
// apps/server/src/events.ts
/** Per-vault SSE stream off the in-process bus — the subscription surface the
 * bus was built for (spec 2026-07-13-agent-drawer-design §Server). Consumed by
 * the desktop's VaultMirror (docs) + ContextSnapshot (tasks); later the board.
 * Plain SSE (not tRPC subscriptions) so the client can authenticate with a
 * normal Authorization header over fetch. */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { resolveVaultRole } from './auth/membership'
import { resolveSession } from './auth/sessions'
import type { Bus, DocsEvent, RemindersEvent, TasksEvent } from './bus'
import type { Db } from './db/client'
import { bearerToken } from './trpc'

const HEARTBEAT_MS = 25_000

export function makeEventsHandler(deps: { db: Db; bus: Bus }) {
  return async (req: IncomingMessage, res: ServerResponse, vaultId: string): Promise<void> => {
    const token = bearerToken(req)
    const user = token ? await resolveSession(deps.db, token) : null
    const role = user ? await resolveVaultRole(deps.db, vaultId, user.id) : null
    if (!role) {
      res.statusCode = user ? 403 : 401
      return void res.end()
    }
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    })
    res.write(':connected\n\n')
    const send = (channel: string, event: unknown) =>
      res.write(`event: ${channel}\ndata: ${JSON.stringify(event)}\n\n`)
    const onDocs = (e: DocsEvent) => void send('docs', e)
    const onTasks = (e: TasksEvent) => void send('tasks', e)
    const onReminders = (e: RemindersEvent) => void send('reminders', e)
    deps.bus.on(`docs:${vaultId}`, onDocs)
    deps.bus.on(`tasks:${vaultId}`, onTasks)
    deps.bus.on(`reminders:${vaultId}`, onReminders)
    const heartbeat = setInterval(() => res.write(':hb\n\n'), HEARTBEAT_MS)
    req.on('close', () => {
      clearInterval(heartbeat)
      deps.bus.off(`docs:${vaultId}`, onDocs)
      deps.bus.off(`tasks:${vaultId}`, onTasks)
      deps.bus.off(`reminders:${vaultId}`, onReminders)
    })
  }
}
```

- [ ] **Step 4: Route it in `main.ts`**

In `apps/server/src/main.ts`: add `import { makeEventsHandler } from './events'`; before `createServer(...)` add `const eventsHandler = makeEventsHandler({ db, bus })`; and as the FIRST branch inside the `createServer` callback add:

```ts
    const eventsMatch = req.method === 'GET' ? /^\/events\/([0-9a-f-]{36})$/.exec(req.url ?? '') : null
    if (eventsMatch) return void eventsHandler(req, res, eventsMatch[1]!)
```

- [ ] **Step 5: Run test + full server suite**

Run: `pnpm --filter @holi/server exec vitest run test/events-sse.test.ts && pnpm --filter @holi/server test && pnpm --filter @holi/server typecheck`
Expected: PASS / clean

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/events.ts apps/server/src/main.ts apps/server/test/events-sse.test.ts
git commit -m "feat(server): per-vault SSE event stream off the bus"
```

---

### Task 4: Desktop — deps + SSE client

**Files:**
- Modify: `apps/desktop/package.json`
- Create: `apps/desktop/src/main/vault/sse-client.ts`
- Test: `apps/desktop/test/sse-client.test.ts`

- [ ] **Step 1: Add deps**

In `apps/desktop/package.json` add to `dependencies`: `"chokidar": "^5.0.0"`, `"ws": "^8.18.0"`; to `devDependencies`: `"@hocuspocus/server": "^2.15.3"`, `"@types/ws": "^8.5.13"`. Run `pnpm install` (exit 0; chokidar 5 and ws are pure JS — no `onlyBuiltDependencies` change needed).

- [ ] **Step 2: Write the failing test**

```ts
// apps/desktop/test/sse-client.test.ts
import { createServer, type Server, type ServerResponse } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { SseClient } from '../src/main/vault/sse-client'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
async function waitUntil(cond: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now()
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('timeout')
    await sleep(10)
  }
}

let server: Server | null = null
let client: SseClient | null = null
afterEach(async () => {
  client?.stop()
  await new Promise((r) => server?.close(r))
  server = null
})

function sseServer(onConn: (res: ServerResponse, connection: number) => void): Promise<string> {
  let connection = 0
  server = createServer((req, res) => {
    if (req.headers.authorization !== 'Bearer tok') {
      res.statusCode = 401
      return void res.end()
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    onConn(res, ++connection)
  })
  return new Promise((resolve) =>
    server!.listen(0, '127.0.0.1', () =>
      resolve(`http://127.0.0.1:${(server!.address() as { port: number }).port}/events/v1`),
    ),
  )
}

describe('SseClient', () => {
  it('parses events, reconnects after a drop, and fires onReconnect', async () => {
    const url = await sseServer((res, connection) => {
      if (connection === 1) {
        res.write(':connected\n\n')
        res.write(`event: docs\ndata: {"type":"created","n":1}\n\n`)
        setTimeout(() => res.destroy(), 50) // server drops the stream
      } else {
        res.write(`event: tasks\ndata: {"type":"deleted","n":2}\n\n`)
      }
    })
    const events: Array<{ channel: string; data: unknown }> = []
    let reconnects = 0
    client = new SseClient({
      url,
      getToken: () => 'tok',
      onEvent: (channel, data) => events.push({ channel, data }),
      onReconnect: () => reconnects++,
      minBackoffMs: 20,
    })
    client.start()
    await waitUntil(() => events.length >= 2)
    expect(events[0]).toEqual({ channel: 'docs', data: { type: 'created', n: 1 } })
    expect(events[1]).toEqual({ channel: 'tasks', data: { type: 'deleted', n: 2 } })
    expect(reconnects).toBe(1)
  })

  it('stop() ends the loop — no further connections', async () => {
    let connections = 0
    const url = await sseServer((res) => {
      connections++
      setTimeout(() => res.destroy(), 20)
    })
    client = new SseClient({ url, getToken: () => 'tok', onEvent: () => {}, minBackoffMs: 20 })
    client.start()
    await waitUntil(() => connections >= 1)
    client.stop()
    const seen = connections
    await sleep(150)
    expect(connections).toBe(seen)
  })
})
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm --filter @holi/desktop exec vitest run test/sse-client.test.ts`
Expected: FAIL — module not found

- [ ] **Step 4: Implement**

```ts
// apps/desktop/src/main/vault/sse-client.ts
/** Fetch-based SSE consumer for the server's /events/<vaultId> stream.
 * fetch (not EventSource) so the Authorization header rides a normal request.
 * Reconnects with capped exponential backoff; onReconnect lets the mirror
 * re-run its full reconcile after a gap. */

export interface SseClientOpts {
  url: string
  getToken(): string | null
  onEvent(channel: string, data: unknown): void
  /** Fired after a successful RE-connect (not the first connect). */
  onReconnect?(): void
  minBackoffMs?: number
  maxBackoffMs?: number
}

export class SseClient {
  private stopped = false
  private abort: AbortController | null = null

  constructor(private readonly opts: SseClientOpts) {}

  start(): void {
    void this.run()
  }

  stop(): void {
    this.stopped = true
    this.abort?.abort()
  }

  private async run(): Promise<void> {
    const min = this.opts.minBackoffMs ?? 1000
    const max = this.opts.maxBackoffMs ?? 30_000
    let attempts = 0
    let everConnected = false
    while (!this.stopped) {
      this.abort = new AbortController()
      try {
        const token = this.opts.getToken()
        if (!token) throw new Error('no session token')
        const res = await fetch(this.opts.url, {
          headers: { authorization: `Bearer ${token}` },
          signal: this.abort.signal,
        })
        if (!res.ok || !res.body) throw new Error(`sse connect failed: ${res.status}`)
        attempts = 0
        if (everConnected) this.opts.onReconnect?.()
        everConnected = true
        await this.consume(res.body)
      } catch {
        // fall through to backoff; stop() aborts land here too
      }
      if (this.stopped) return
      attempts += 1
      await new Promise((r) => setTimeout(r, Math.min(max, min * 2 ** Math.min(attempts - 1, 5))))
    }
  }

  private async consume(body: ReadableStream<Uint8Array>): Promise<void> {
    const decoder = new TextDecoder()
    let buf = ''
    for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
      buf += decoder.decode(chunk, { stream: true })
      let sep: number
      while ((sep = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, sep)
        buf = buf.slice(sep + 2)
        this.dispatch(block)
      }
    }
  }

  private dispatch(block: string): void {
    let channel = ''
    const dataLines: string[] = []
    for (const line of block.split('\n')) {
      if (line.startsWith('event:')) channel = line.slice('event:'.length).trim()
      else if (line.startsWith('data:')) dataLines.push(line.slice('data:'.length).trim())
    }
    if (!channel || dataLines.length === 0) return // comments/heartbeats
    try {
      this.opts.onEvent(channel, JSON.parse(dataLines.join('\n')))
    } catch {
      // malformed data — drop the block, keep the stream
    }
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @holi/desktop exec vitest run test/sse-client.test.ts`
Expected: PASS (2 tests)

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/package.json pnpm-lock.yaml apps/desktop/src/main/vault/sse-client.ts apps/desktop/test/sse-client.test.ts
git commit -m "feat(desktop): SSE client for the vault event stream"
```

---

### Task 5: Desktop — vault file utilities

**Files:**
- Create: `apps/desktop/src/main/vault/vault-files.ts`
- Test: `apps/desktop/test/vault-files.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// apps/desktop/test/vault-files.test.ts
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { vaultRelPath } from '@holi/shared'
import {
  absPathFor,
  isIgnoredPath,
  listFiles,
  moveDocFile,
  removeDocFile,
  toVaultRel,
  writeAtomic,
} from '../src/main/vault/vault-files'

const dirs: string[] = []
afterAll(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true })
})
async function scratch(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), 'holi-vf-'))
  dirs.push(d)
  return d
}

describe('vault-files', () => {
  it('writeAtomic creates parents and leaves no tmp files', async () => {
    const root = await scratch()
    await writeAtomic(root, vaultRelPath('a/b/c.md'), 'hello\n')
    expect(await readFile(join(root, 'a/b/c.md'), 'utf8')).toBe('hello\n')
    expect(await listFiles(root)).toEqual(['a/b/c.md'])
  })

  it('toVaultRel maps abs→rel and rejects escapes', async () => {
    const root = await scratch()
    expect(toVaultRel(root, join(root, 'notes/x.md'))).toBe('notes/x.md')
    expect(toVaultRel(root, join(root, '..', 'outside.md'))).toBeNull()
    expect(toVaultRel(root, '/etc/passwd')).toBeNull()
  })

  it('isIgnoredPath: local-only, tmp markers, junk', () => {
    expect(isIgnoredPath('USER.md')).toBe(true)
    expect(isIgnoredPath('.holi/settings.local.json')).toBe(true)
    expect(isIgnoredPath('notes/.holi-tmp-abc123')).toBe(true)
    expect(isIgnoredPath('.DS_Store')).toBe(true)
    expect(isIgnoredPath('notes/a.md')).toBe(false)
    expect(isIgnoredPath('.claude/settings.json')).toBe(false)
  })

  it('move + remove', async () => {
    const root = await scratch()
    await writeAtomic(root, vaultRelPath('a.md'), 'x')
    await moveDocFile(root, vaultRelPath('a.md'), vaultRelPath('sub/b.md'))
    expect(await listFiles(root)).toEqual(['sub/b.md'])
    await removeDocFile(root, vaultRelPath('sub/b.md'))
    expect(await listFiles(root)).toEqual([])
    await removeDocFile(root, vaultRelPath('sub/b.md')) // idempotent
  })

  it('listFiles walks nested dirs and returns /-separated rels', async () => {
    const root = await scratch()
    await mkdir(join(root, 'x/y'), { recursive: true })
    await writeFile(join(root, 'x/y/z.md'), '1')
    await writeFile(join(root, 'top.md'), '2')
    expect((await listFiles(root)).sort()).toEqual(['top.md', 'x/y/z.md'])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @holi/desktop exec vitest run test/vault-files.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement**

```ts
// apps/desktop/src/main/vault/vault-files.ts
/** Disk plumbing for the working copy. Every write is tmp+rename in the same
 * directory so the agent's Read never sees a torn file (spec §VaultMirror);
 * every path from disk re-validates through vaultRelPath (architecture §9). */
import { randomBytes } from 'node:crypto'
import { mkdir, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join, relative, sep } from 'node:path'
import { isLocalOnlyPath, vaultRelPath, type VaultRelPath } from '@holi/shared'

export const TMP_MARKER = '.holi-tmp-'
const JUNK = new Set(['.DS_Store', 'Thumbs.db'])

export function absPathFor(root: string, rel: VaultRelPath): string {
  return join(root, rel)
}

/** abs → validated vault-relative ('/'-separated), or null when outside/unsafe. */
export function toVaultRel(root: string, absPath: string): VaultRelPath | null {
  const rel = relative(root, absPath)
  if (!rel || rel.startsWith('..') || rel === absPath) return null
  try {
    return vaultRelPath(rel.split(sep).join('/'))
  } catch {
    return null
  }
}

/** Paths the mirror must never treat as vault content. */
export function isIgnoredPath(rel: string): boolean {
  const base = rel.split('/').at(-1)!
  return isLocalOnlyPath(rel) || base.startsWith(TMP_MARKER) || JUNK.has(base)
}

export async function writeAtomic(root: string, rel: VaultRelPath, text: string): Promise<void> {
  const abs = absPathFor(root, rel)
  await mkdir(dirname(abs), { recursive: true })
  const tmp = join(dirname(abs), `${TMP_MARKER}${randomBytes(6).toString('hex')}`)
  await writeFile(tmp, text, 'utf8')
  await rename(tmp, abs)
}

export async function removeDocFile(root: string, rel: VaultRelPath): Promise<void> {
  await rm(absPathFor(root, rel), { force: true })
}

export async function moveDocFile(root: string, from: VaultRelPath, to: VaultRelPath): Promise<void> {
  const dest = absPathFor(root, to)
  await mkdir(dirname(dest), { recursive: true })
  await rename(absPathFor(root, from), dest)
}

/** All files under root as '/'-separated relative paths (recursive). */
export async function listFiles(root: string, prefix = ''): Promise<string[]> {
  const out: string[] = []
  const entries = await readdir(join(root, prefix), { withFileTypes: true }).catch(() => [])
  for (const e of entries) {
    const rel = prefix ? `${prefix}/${e.name}` : e.name
    if (e.isDirectory()) out.push(...(await listFiles(root, rel)))
    else if (e.isFile()) out.push(rel)
  }
  return out
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @holi/desktop exec vitest run test/vault-files.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/main/vault/vault-files.ts apps/desktop/test/vault-files.test.ts
git commit -m "feat(desktop): atomic working-copy file utilities"
```

---

### Task 6: Desktop — persisted base store

**Files:**
- Create: `apps/desktop/src/main/vault/base-store.ts`
- Test: `apps/desktop/test/base-store.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// apps/desktop/test/base-store.test.ts
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { BaseStore } from '../src/main/vault/base-store'

const dirs: string[] = []
afterAll(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true })
})

describe('BaseStore', () => {
  it('round-trips text + binary state and removes', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'holi-bs-'))
    dirs.push(dir)
    const store = new BaseStore(dir)
    const state = new Uint8Array([0, 1, 2, 255, 128])
    await store.save('doc-1', { text: 'hello Ø\n', state })
    const loaded = await store.load('doc-1')
    expect(loaded!.text).toBe('hello Ø\n')
    expect([...loaded!.state]).toEqual([0, 1, 2, 255, 128])
    await store.remove('doc-1')
    expect(await store.load('doc-1')).toBeNull()
  })

  it('load returns null for unknown docs and survives a second save (overwrite)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'holi-bs-'))
    dirs.push(dir)
    const store = new BaseStore(dir)
    expect(await store.load('nope')).toBeNull()
    await store.save('d', { text: 'v1', state: new Uint8Array([1]) })
    await store.save('d', { text: 'v2', state: new Uint8Array([2]) })
    expect((await store.load('d'))!.text).toBe('v2')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @holi/desktop exec vitest run test/base-store.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement**

```ts
// apps/desktop/src/main/vault/base-store.ts
/** Persisted per-doc frozen bases. The spike kept the base in memory; the real
 * bridge persists {text, yjsState} atomically at every advancement so a crash
 * mid-turn reconciles through a normal turn merge on next vault open (spec
 * §Bridge — base persistence). One JSON file per doc under userData. */
import { randomBytes } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export interface DocBase {
  text: string
  state: Uint8Array
}

export class BaseStore {
  constructor(private readonly dir: string) {}

  private file(docId: string): string {
    return join(this.dir, `${docId}.json`)
  }

  async load(docId: string): Promise<DocBase | null> {
    try {
      const raw = JSON.parse(await readFile(this.file(docId), 'utf8')) as { text: string; stateB64: string }
      return { text: raw.text, state: new Uint8Array(Buffer.from(raw.stateB64, 'base64')) }
    } catch {
      return null
    }
  }

  async save(docId: string, base: DocBase): Promise<void> {
    await mkdir(this.dir, { recursive: true })
    const tmp = join(this.dir, `.tmp-${randomBytes(6).toString('hex')}`)
    await writeFile(
      tmp,
      JSON.stringify({ text: base.text, stateB64: Buffer.from(base.state).toString('base64') }),
      'utf8',
    )
    await rename(tmp, this.file(docId))
  }

  async remove(docId: string): Promise<void> {
    await rm(this.file(docId), { force: true })
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @holi/desktop exec vitest run test/base-store.test.ts`
Expected: PASS (2 tests)

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/main/vault/base-store.ts apps/desktop/test/base-store.test.ts
git commit -m "feat(desktop): persisted per-doc frozen-base store"
```

---

### Task 7: Desktop — `DocBridge` (per-doc turn protocol)

**Files:**
- Create: `apps/desktop/src/main/vault/doc-bridge.ts`
- Create: `apps/desktop/test/helpers/relay.ts`
- Test: `apps/desktop/test/doc-bridge.test.ts`

This is the spike's `BridgeClient` productionized: no own watcher (the vault-level watcher feeds `onFileEvent`), disk I/O injected, base persisted at every advancement, `onTurnState` for presence/snapshot wiring, `signalTurnEnd()` as the slice-2 Stop-hook seam. All three spike invariants carried: atomic base capture at materialization, base-advances-before-release, agent-lineage continuation, plus the one-shot disk-recheck (spike findings 2–3).

- [ ] **Step 1: Write the test-relay helper (spike harness port)**

```ts
// apps/desktop/test/helpers/relay.ts
/** In-process Hocuspocus + provider helpers — the spike harness pattern
 * (spikes/bridge/src/harness.ts), retargeted at YDOC_TEXT_KEY. */
import { HocuspocusProvider, HocuspocusProviderWebsocket } from '@hocuspocus/provider'
import { Hocuspocus } from '@hocuspocus/server'
import ws from 'ws'
import * as Y from 'yjs'
import { YDOC_TEXT_KEY } from '@holi/shared'

export async function startRelay(port: number): Promise<Hocuspocus> {
  const relay = new Hocuspocus({ port, quiet: true })
  await relay.listen()
  return relay
}

export function connectDoc(url: string, room: string, doc: Y.Doc) {
  const socket = new HocuspocusProviderWebsocket({ url, WebSocketPolyfill: ws as never })
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
    return this.doc.getText(YDOC_TEXT_KEY)
  }
  get provider(): HocuspocusProvider {
    return this.conn.provider
  }
  toString(): string {
    return this.text.toString()
  }
  insertAfter(marker: string, str: string): void {
    const i = this.toString().indexOf(marker)
    if (i < 0) throw new Error(`marker not found: ${marker}`)
    this.text.insert(i + marker.length, str)
  }
  destroy(): void {
    this.conn.destroy()
  }
}

/** Mimics Claude Code's native file tools against the working copy. */
export class AgentSim {
  constructor(private readonly filePath: string) {}
  async read(): Promise<string> {
    const { readFile } = await import('node:fs/promises')
    return readFile(this.filePath, 'utf8')
  }
  async write(content: string): Promise<void> {
    const { writeFile } = await import('node:fs/promises')
    await writeFile(this.filePath, content, 'utf8')
  }
  async edit(oldString: string, newString: string): Promise<void> {
    const current = await this.read()
    if (!current.includes(oldString)) throw new Error(`edit failed: old_string not found`)
    await this.write(current.replace(oldString, newString))
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
export const countOccurrences = (haystack: string, needle: string) => haystack.split(needle).length - 1
```

- [ ] **Step 2: Write the failing DocBridge test**

```ts
// apps/desktop/test/doc-bridge.test.ts
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Hocuspocus } from '@hocuspocus/server'
import * as Y from 'yjs'
import { YDOC_TEXT_KEY } from '@holi/shared'
import { BaseStore } from '../src/main/vault/base-store'
import { DocBridge } from '../src/main/vault/doc-bridge'
import { connectDoc, SimClient, sleep, waitUntil } from './helpers/relay'

const PORT = 5611
const URL = `ws://127.0.0.1:${PORT}`

let relay: Hocuspocus
beforeAll(async () => {
  const { startRelay } = await import('./helpers/relay')
  relay = await startRelay(PORT)
})
afterAll(async () => {
  await relay.destroy()
})

interface Rig {
  bridge: DocBridge
  doc: Y.Doc
  filePath: string
  store: BaseStore
  turnStates: boolean[]
  destroy(): Promise<void>
}

async function rig(room: string, opts: { turnIdleMs?: number } = {}): Promise<Rig> {
  const dir = await mkdtemp(join(tmpdir(), 'holi-db-'))
  const filePath = join(dir, 'doc.md')
  const store = new BaseStore(join(dir, 'bases'))
  const doc = new Y.Doc()
  const conn = connectDoc(URL, room, doc)
  const turnStates: boolean[] = []
  const bridge = new DocBridge({
    doc,
    readFile: () => readFile(filePath, 'utf8').catch(() => null),
    writeFile: async (text) => void (await writeFile(filePath, text, 'utf8')),
    loadBase: () => store.load('d1'),
    saveBase: (b) => store.save('d1', b),
    onTurnState: (active) => turnStates.push(active),
    turnIdleMs: opts.turnIdleMs ?? 200,
    materializeDebounceMs: 40,
  })
  return {
    bridge,
    doc,
    filePath,
    store,
    turnStates,
    async destroy() {
      await bridge.stop()
      conn.destroy()
      await rm(dir, { recursive: true, force: true })
    },
  }
}

describe('DocBridge turn protocol', () => {
  it('(a) agent file edit merges; concurrent human edit to another region survives', async () => {
    const human = new SimClient(URL, 'db-a')
    human.text.insert(0, 'alpha\nomega\n')
    const r = await rig('db-a')
    await waitUntil(() => r.doc.getText(YDOC_TEXT_KEY).toString() === 'alpha\nomega\n')
    await r.bridge.start()
    expect(await readFile(r.filePath, 'utf8')).toBe('alpha\nomega\n')

    await writeFile(r.filePath, 'alpha\nomega (agent)\n', 'utf8')
    await r.bridge.onFileEvent()
    human.insertAfter('alpha', ' (human)') // buffers in the live CRDT mid-turn
    await waitUntil(() => !r.bridge.isTurnActive && r.bridge.turns === 1, 5000, 'turn done')
    await waitUntil(() => human.toString() === 'alpha (human)\nomega (agent)\n', 5000, 'human converged')
    expect(await readFile(r.filePath, 'utf8')).toBe('alpha (human)\nomega (agent)\n')
    expect(r.turnStates).toEqual([true, false])
    human.destroy()
    await r.destroy()
  })

  it('(c) the file stays frozen while a turn is open — remote edits do not hit disk mid-turn', async () => {
    const human = new SimClient(URL, 'db-c')
    human.text.insert(0, 'base\n')
    const r = await rig('db-c', { turnIdleMs: 400 })
    await waitUntil(() => r.doc.getText(YDOC_TEXT_KEY).toString() === 'base\n')
    await r.bridge.start()

    await writeFile(r.filePath, 'base\nagent line\n', 'utf8')
    await r.bridge.onFileEvent()
    expect(r.bridge.isTurnActive).toBe(true)
    human.text.insert(0, 'REMOTE ')
    await sleep(150) // < turnIdleMs: turn still open
    expect(await readFile(r.filePath, 'utf8')).toBe('base\nagent line\n') // frozen
    await waitUntil(() => !r.bridge.isTurnActive, 5000)
    const final = await readFile(r.filePath, 'utf8')
    expect(final).toContain('REMOTE')
    expect(final).toContain('agent line')
    human.destroy()
    await r.destroy()
  })

  it('(e) burst of writes coalesces into one turn; a later burst is a second turn', async () => {
    const r = await rig('db-e')
    r.doc.getText(YDOC_TEXT_KEY).insert(0, 'start\n')
    await r.bridge.start()
    await writeFile(r.filePath, 'start\none\n', 'utf8')
    await r.bridge.onFileEvent()
    await writeFile(r.filePath, 'start\none\ntwo\n', 'utf8')
    await r.bridge.onFileEvent()
    await waitUntil(() => !r.bridge.isTurnActive && r.bridge.turns === 1, 5000, 'first turn')
    await writeFile(r.filePath, 'start\none\ntwo\nthree\n', 'utf8')
    await r.bridge.onFileEvent()
    await waitUntil(() => r.bridge.turns === 2, 5000, 'second turn')
    expect(r.doc.getText(YDOC_TEXT_KEY).toString()).toBe('start\none\ntwo\nthree\n')
    await r.destroy()
  })

  it('signalTurnEnd() ends the turn immediately (the slice-2 Stop-hook seam)', async () => {
    const r = await rig('db-sig', { turnIdleMs: 60_000 }) // idle would never fire in-test
    r.doc.getText(YDOC_TEXT_KEY).insert(0, 'x\n')
    await r.bridge.start()
    await writeFile(r.filePath, 'x\ny\n', 'utf8')
    await r.bridge.onFileEvent()
    expect(r.bridge.isTurnActive).toBe(true)
    r.bridge.signalTurnEnd()
    await waitUntil(() => !r.bridge.isTurnActive, 5000)
    expect(r.doc.getText(YDOC_TEXT_KEY).toString()).toBe('x\ny\n')
    await r.destroy()
  })

  it('crash recovery: persisted base + diverged disk reconciles as a turn on start', async () => {
    const room = 'db-crash'
    const human = new SimClient(URL, room)
    human.text.insert(0, 'one\ntwo\n')
    const r1 = await rig(room)
    await waitUntil(() => r1.doc.getText(YDOC_TEXT_KEY).toString() === 'one\ntwo\n')
    await r1.bridge.start()
    const { filePath, store } = r1
    await r1.bridge.stop() // "crash": bridge gone, base persisted

    // agent wrote while we were down; a human also edited remotely
    await writeFile(filePath, 'one\ntwo\nagent-offline\n', 'utf8')
    human.text.insert(0, 'HUMAN ')

    const doc2 = new Y.Doc()
    const conn2 = connectDoc(URL, room, doc2)
    await waitUntil(() => doc2.getText(YDOC_TEXT_KEY).toString().startsWith('HUMAN '))
    const bridge2 = new DocBridge({
      doc: doc2,
      readFile: () => readFile(filePath, 'utf8').catch(() => null),
      writeFile: async (text) => void (await writeFile(filePath, text, 'utf8')),
      loadBase: () => store.load('d1'),
      saveBase: (b) => store.save('d1', b),
      onTurnState: () => {},
      turnIdleMs: 200,
    })
    await bridge2.start()
    await waitUntil(() => !bridge2.isTurnActive && bridge2.turns === 1, 5000, 'recovery turn')
    await waitUntil(() => human.toString() === 'HUMAN one\ntwo\nagent-offline\n', 5000, 'both survive')
    expect(await readFile(filePath, 'utf8')).toBe('HUMAN one\ntwo\nagent-offline\n')
    await bridge2.stop()
    conn2.destroy()
    human.destroy()
    await r1.destroy()
  })

  it('no persisted base: server truth wins over stray disk content', async () => {
    const r = await rig('db-nobase')
    r.doc.getText(YDOC_TEXT_KEY).insert(0, 'server truth\n')
    await writeFile(r.filePath, 'stray local content\n', 'utf8')
    await r.bridge.start()
    await waitUntil(async () => (await readFile(r.filePath, 'utf8')) === 'server truth\n', 5000)
    expect(r.bridge.turns).toBe(0)
    await r.destroy()
  })
})
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm --filter @holi/desktop exec vitest run test/doc-bridge.test.ts`
Expected: FAIL — `doc-bridge` module not found

- [ ] **Step 4: Implement `DocBridge`**

```ts
// apps/desktop/src/main/vault/doc-bridge.ts
/**
 * Per-doc turn protocol (spec §Bridge; spike BridgeClient productionized).
 * - base = { text, yjsState } captured atomically at every materialization,
 *   PERSISTED at every advancement (crash recovery).
 * - foreign disk≠base ⇒ turn opens (soft lock: re-materialization paused,
 *   base frozen, onTurnState(true) → presence + pre-agent-write snapshot).
 * - idle debounce (or signalTurnEnd, the slice-2 Stop-hook seam) ends it:
 *   applyAgentTurn, base advances BEFORE release; agent-lineage base when the
 *   agent wrote again mid-merge (spike finding 2).
 * - Watcher events are advisory: one-shot disk-recheck after every write we
 *   make or ignore (spike finding 3).
 * The vault-level watcher feeds onFileEvent; this class owns no chokidar.
 */
import * as Y from 'yjs'
import { applyAgentTurn, BRIDGE_ORIGIN, YDOC_TEXT_KEY } from '@holi/shared'
import type { DocBase } from './base-store'

export interface DocBridgeDeps {
  doc: Y.Doc
  readFile(): Promise<string | null>
  writeFile(text: string): Promise<void>
  loadBase(): Promise<DocBase | null>
  saveBase(base: DocBase): Promise<void>
  onTurnState(active: boolean): void
  turnIdleMs?: number
  materializeDebounceMs?: number
}

const RECHECK_MS = 100

export class DocBridge {
  turns = 0

  private base: DocBase = { text: '', state: new Uint8Array() }
  private turnActive = false
  private stopped = false
  private turnTimer: ReturnType<typeof setTimeout> | null = null
  private materializeTimer: ReturnType<typeof setTimeout> | null = null
  private recheckTimer: ReturnType<typeof setTimeout> | null = null
  private readonly turnIdleMs: number
  private readonly materializeDebounceMs: number
  private readonly onUpdate = (_update: Uint8Array, origin: unknown): void => {
    if (origin !== BRIDGE_ORIGIN) this.scheduleMaterialize()
  }

  constructor(private readonly deps: DocBridgeDeps) {
    this.turnIdleMs = deps.turnIdleMs ?? 800
    this.materializeDebounceMs = deps.materializeDebounceMs ?? 50
  }

  get isTurnActive(): boolean {
    return this.turnActive
  }

  get baseText(): string {
    return this.base.text
  }

  async start(): Promise<void> {
    const persisted = await this.deps.loadBase()
    this.deps.doc.on('update', this.onUpdate)
    if (persisted) {
      this.base = persisted
      const onDisk = await this.deps.readFile()
      if (onDisk !== null && onDisk !== persisted.text) {
        // crash-time agent divergence — reconcile through a normal turn merge
        await this.onFileEvent()
        return
      }
    }
    // no base (fresh doc): server truth wins — we cannot diff without a base
    await this.materialize()
  }

  async stop(): Promise<void> {
    this.stopped = true
    this.deps.doc.off('update', this.onUpdate)
    if (this.turnTimer) clearTimeout(this.turnTimer)
    if (this.materializeTimer) clearTimeout(this.materializeTimer)
    if (this.recheckTimer) clearTimeout(this.recheckTimer)
  }

  /** Fed by the vault-level watcher (and the disk-recheck defense). */
  async onFileEvent(): Promise<void> {
    if (this.stopped) return
    const content = await this.deps.readFile()
    if (content === null) return // deletion is the mirror's business
    if (content === this.base.text) {
      // echo of our own materialization — but fsevents may have coalesced a
      // foreign write into this very event; verify shortly (spike finding 3)
      this.scheduleDiskRecheck()
      return
    }
    if (!this.turnActive) {
      this.turnActive = true // soft lock engaged
      this.deps.onTurnState(true)
    }
    if (this.turnTimer) clearTimeout(this.turnTimer)
    this.turnTimer = setTimeout(() => void this.endTurn(), this.turnIdleMs)
  }

  /** Slice-2 Stop-hook seam: end the open turn now instead of waiting for idle. */
  signalTurnEnd(): void {
    if (!this.turnActive) return
    if (this.turnTimer) clearTimeout(this.turnTimer)
    void this.endTurn()
  }

  private scheduleDiskRecheck(): void {
    if (this.recheckTimer) clearTimeout(this.recheckTimer)
    this.recheckTimer = setTimeout(() => {
      void (async () => {
        if (this.stopped || this.turnActive) return // turn timer owns the file
        const onDisk = await this.deps.readFile()
        if (onDisk !== null && onDisk !== this.base.text) void this.onFileEvent()
      })()
    }, RECHECK_MS)
  }

  private scheduleMaterialize(): void {
    if (this.turnActive) return // soft lock: paused during agent turn
    if (this.materializeTimer) clearTimeout(this.materializeTimer)
    this.materializeTimer = setTimeout(() => void this.materialize(), this.materializeDebounceMs)
  }

  /** CRDT → file. Captures + persists the new base atomically with the write. */
  private async materialize(): Promise<void> {
    if (this.stopped || this.turnActive) return
    const onDisk = await this.deps.readFile()
    if (onDisk !== null && onDisk !== this.base.text && this.base.state.length > 0) {
      // disk already diverged from a real base: an agent turn is underway that
      // the watcher hasn't delivered yet — don't clobber, treat as turn event
      void this.onFileEvent()
      return
    }
    const text = this.deps.doc.getText(YDOC_TEXT_KEY).toString()
    this.base = { text, state: Y.encodeStateAsUpdate(this.deps.doc) }
    await this.deps.saveBase(this.base)
    if (onDisk !== text) await this.deps.writeFile(text)
    this.scheduleDiskRecheck()
  }

  private async endTurn(): Promise<void> {
    if (this.stopped) return
    const fileText = await this.deps.readFile()
    if (fileText === null) {
      // file vanished mid-turn (agent rm) — release; the mirror handles deletes
      this.turnActive = false
      this.deps.onTurnState(false)
      return
    }
    const { agentState } = applyAgentTurn(this.deps.doc, this.base.state, fileText)
    this.turns += 1

    const onDisk = await this.deps.readFile()
    if (onDisk === fileText) {
      // turn really over: base = merge result BEFORE release (spike invariant)
      const merged = this.deps.doc.getText(YDOC_TEXT_KEY).toString()
      this.base = { text: merged, state: Y.encodeStateAsUpdate(this.deps.doc) }
      await this.deps.saveBase(this.base)
      if (merged !== fileText) await this.deps.writeFile(merged)
      this.turnActive = false
      this.deps.onTurnState(false)
      this.scheduleDiskRecheck()
    } else {
      // the agent wrote again while we merged: continue on the agent lineage
      // (frozen file text + shadow ops), NOT the merge result (spike finding 2)
      this.base = { text: fileText, state: agentState }
      await this.deps.saveBase(this.base)
      if (this.turnTimer) clearTimeout(this.turnTimer)
      this.turnTimer = setTimeout(() => void this.endTurn(), this.turnIdleMs)
    }
  }
}
```

Note the one deliberate difference from the spike's `materialize`: the disk-divergence-means-turn guard only fires when a real base exists (`state.length > 0`) — a fresh doc with no base takes the server-truth path (deviation #4).

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @holi/desktop exec vitest run test/doc-bridge.test.ts`
Expected: PASS (6 tests)

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/main/vault/doc-bridge.ts apps/desktop/test/helpers/relay.ts apps/desktop/test/doc-bridge.test.ts
git commit -m "feat(desktop): per-doc file<->CRDT bridge with persisted crash-safe bases"
```

---

### Task 8: Desktop — `VaultMirror`

**Files:**
- Create: `apps/desktop/src/main/vault/vault-mirror.ts`
- Test: `apps/desktop/test/vault-mirror.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// apps/desktop/test/vault-mirror.test.ts
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile, unlink, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import type { Hocuspocus } from '@hocuspocus/server'
import type { DocMeta } from '@holi/shared'
import { VaultMirror, type MirrorApi } from '../src/main/vault/vault-mirror'
import { SimClient, sleep, startRelay, waitUntil } from './helpers/relay'

const PORT = 5612
const URL = `ws://127.0.0.1:${PORT}`
const VAULT = 'v-1'

let relay: Hocuspocus
beforeAll(async () => {
  relay = await startRelay(PORT)
})
afterAll(async () => {
  await relay.destroy()
})

function meta(path: string): DocMeta {
  return { id: randomUUID(), vaultId: VAULT, path, kind: 'note', createdAt: '', updatedAt: '' }
}

interface Fake {
  api: MirrorApi
  docs: DocMeta[]
  created: string[]
  deleted: string[]
  snapshots: string[]
}

function fakeApi(docs: DocMeta[]): Fake {
  const fake: Fake = {
    docs,
    created: [],
    deleted: [],
    snapshots: [],
    api: {
      listDocs: async () => [...fake.docs],
      createNote: async (path) => {
        const m = meta(path)
        fake.docs.push(m)
        fake.created.push(path)
        return m
      },
      deleteNote: async (docId) => {
        fake.docs = fake.docs.filter((d) => d.id !== docId)
        fake.deleted.push(docId)
      },
      takeSnapshot: async (docId) => void fake.snapshots.push(docId),
    },
  }
  return fake
}

/** Seed a relay room with content the way the server would serve it. */
function seedRoom(docId: string, text: string): SimClient {
  const c = new SimClient(URL, docId)
  if (text) c.text.insert(0, text)
  return c
}

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const fn of cleanups.splice(0)) await fn()
})

async function makeMirror(fake: Fake): Promise<{ mirror: VaultMirror; root: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'holi-vm-'))
  const root = join(dir, 'work')
  const mirror = new VaultMirror({
    vaultId: VAULT,
    workRoot: root,
    baseDir: join(dir, 'bases'),
    relayUrl: URL,
    token: 'tok',
    api: fake.api,
    turnIdleMs: 200,
    lifecycleDebounceMs: 150,
  })
  cleanups.push(async () => {
    await mirror.stop()
    await rm(dir, { recursive: true, force: true })
  })
  return { mirror, root }
}

describe('VaultMirror', () => {
  it('materializes every listed doc on start, including .claude content', async () => {
    const a = meta('notes/a.md')
    const b = meta('.claude/settings.json')
    const ca = seedRoom(a.id, '# A\n')
    const cb = seedRoom(b.id, '{}\n')
    cleanups.push(async () => (ca.destroy(), cb.destroy()))
    const fake = fakeApi([a, b])
    const { mirror, root } = await makeMirror(fake)
    await mirror.start()
    await waitUntil(async () => (await readFile(join(root, 'notes/a.md'), 'utf8').catch(() => null)) === '# A\n')
    await waitUntil(async () => (await readFile(join(root, '.claude/settings.json'), 'utf8').catch(() => null)) === '{}\n')
  })

  it('a remote edit re-materializes the file', async () => {
    const a = meta('live.md')
    const human = seedRoom(a.id, 'v1\n')
    cleanups.push(async () => human.destroy())
    const { mirror, root } = await makeMirror(fakeApi([a]))
    await mirror.start()
    await waitUntil(async () => (await readFile(join(root, 'live.md'), 'utf8').catch(() => null)) === 'v1\n')
    human.text.insert(0, 'v2 ')
    await waitUntil(async () => (await readFile(join(root, 'live.md'), 'utf8').catch(() => null)) === 'v2 v1\n')
  })

  it('docs events: created materializes, renamed moves, deleted removes', async () => {
    const { mirror, root } = await makeMirror(fakeApi([]))
    await mirror.start()

    const c = meta('new.md')
    const seed = seedRoom(c.id, 'fresh\n')
    cleanups.push(async () => seed.destroy())
    mirror.handleDocsEvent({ type: 'created', doc: c })
    await waitUntil(async () => (await readFile(join(root, 'new.md'), 'utf8').catch(() => null)) === 'fresh\n')

    mirror.handleDocsEvent({ type: 'renamed', doc: { ...c, path: 'moved/new.md' } })
    await waitUntil(async () => (await readFile(join(root, 'moved/new.md'), 'utf8').catch(() => null)) === 'fresh\n')

    mirror.handleDocsEvent({ type: 'deleted', doc: { ...c, path: 'moved/new.md' } })
    await waitUntil(async () => (await readFile(join(root, 'moved/new.md'), 'utf8').catch(() => null)) === null)
  })

  it('agent-created file becomes a doc with its content (git-ingress symmetry)', async () => {
    const fake = fakeApi([])
    const { mirror, root } = await makeMirror(fake)
    await mirror.start()
    await mkdir(join(root, 'notes'), { recursive: true })
    await writeFile(join(root, 'notes/idea.md'), 'agent wrote this\n', 'utf8')
    await waitUntil(() => fake.created.includes('notes/idea.md'), 8000, 'createNote called')
    const created = fake.docs.find((d) => d.path === 'notes/idea.md')!
    const observer = new SimClient(URL, created.id)
    cleanups.push(async () => observer.destroy())
    await waitUntil(() => observer.toString() === 'agent wrote this\n', 8000, 'content synced')
  })

  it('local-only and junk files are never adopted', async () => {
    const fake = fakeApi([])
    const { mirror, root } = await makeMirror(fake)
    await mirror.start()
    await writeFile(join(root, 'USER.md'), 'personal\n', 'utf8')
    await mkdir(join(root, '.holi'), { recursive: true })
    await writeFile(join(root, '.holi/settings.local.json'), '{}\n', 'utf8')
    await writeFile(join(root, '.DS_Store'), 'junk', 'utf8')
    await sleep(600) // > lifecycleDebounceMs — nothing should happen
    expect(fake.created).toEqual([])
  })

  it('agent rm deletes the doc server-side', async () => {
    const a = meta('kill-me.md')
    const seed = seedRoom(a.id, 'bye\n')
    cleanups.push(async () => seed.destroy())
    const fake = fakeApi([a])
    const { mirror, root } = await makeMirror(fake)
    await mirror.start()
    await waitUntil(async () => (await readFile(join(root, 'kill-me.md'), 'utf8').catch(() => null)) === 'bye\n')
    await unlink(join(root, 'kill-me.md'))
    await waitUntil(() => fake.deleted.includes(a.id), 8000, 'deleteNote called')
  })

  it('agent edit runs a turn: snapshot taken, awareness flagged, human concurrent edit survives', async () => {
    const a = meta('shared.md')
    const human = seedRoom(a.id, 'alpha\nomega\n')
    cleanups.push(async () => human.destroy())
    const fake = fakeApi([a])
    const { mirror, root } = await makeMirror(fake)
    await mirror.start()
    const file = join(root, 'shared.md')
    await waitUntil(async () => (await readFile(file, 'utf8').catch(() => null)) === 'alpha\nomega\n')

    const awareness: unknown[] = []
    human.provider.awareness!.on('change', () => {
      for (const [, state] of human.provider.awareness!.getStates()) {
        if ('agentEditing' in (state as Record<string, unknown>)) awareness.push((state as Record<string, unknown>).agentEditing)
      }
    })

    await writeFile(file, 'alpha\nomega (agent)\n', 'utf8')
    human.insertAfter('alpha', ' (human)')
    await waitUntil(() => human.toString() === 'alpha (human)\nomega (agent)\n', 8000, 'merged')
    await waitUntil(async () => (await readFile(file, 'utf8')) === 'alpha (human)\nomega (agent)\n', 8000, 'file remat')
    expect(fake.snapshots).toEqual([a.id])
    expect(awareness).toContain(true)
  })

  it('startup scan adopts unknown files already on disk', async () => {
    const fake = fakeApi([])
    const dir = await mkdtemp(join(tmpdir(), 'holi-vm-'))
    const root = join(dir, 'work')
    await mkdir(root, { recursive: true })
    await writeFile(join(root, 'leftover.md'), 'crash orphan\n', 'utf8')
    const mirror = new VaultMirror({
      vaultId: VAULT,
      workRoot: root,
      baseDir: join(dir, 'bases'),
      relayUrl: URL,
      token: 'tok',
      api: fake.api,
      turnIdleMs: 200,
      lifecycleDebounceMs: 150,
    })
    cleanups.push(async () => {
      await mirror.stop()
      await rm(dir, { recursive: true, force: true })
    })
    await mirror.start()
    await waitUntil(() => fake.created.includes('leftover.md'), 8000, 'adopted at startup')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @holi/desktop exec vitest run test/vault-mirror.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement `VaultMirror`**

```ts
// apps/desktop/src/main/vault/vault-mirror.ts
/**
 * Full-vault live mirror (spec §VaultMirror): a Y.Doc + Hocuspocus provider
 * per doc over ONE multiplexed WebSocket; CRDT→disk via DocBridge; doc-list
 * truth from the server (listDocs + SSE docs events + reconcile on reconnect);
 * agent-created/deleted files propagate with git-ingress symmetry.
 */
import { mkdir, readFile } from 'node:fs/promises'
import { HocuspocusProvider, HocuspocusProviderWebsocket } from '@hocuspocus/provider'
import { watch, type FSWatcher } from 'chokidar'
import ws from 'ws'
import * as Y from 'yjs'
import { BRIDGE_ORIGIN, YDOC_TEXT_KEY, vaultRelPath, type DocMeta, type VaultRelPath } from '@holi/shared'
import { BaseStore } from './base-store'
import { DocBridge } from './doc-bridge'
import {
  absPathFor,
  isIgnoredPath,
  listFiles,
  moveDocFile,
  removeDocFile,
  toVaultRel,
  writeAtomic,
} from './vault-files'

export interface MirrorApi {
  listDocs(): Promise<DocMeta[]>
  createNote(path: string): Promise<DocMeta>
  deleteNote(docId: string): Promise<void>
  takeSnapshot(docId: string, label: string): Promise<void>
}

/** Mirrors the server bus's DocsEvent shape (apps/server/src/bus.ts). */
export interface DocsEvent {
  type: 'created' | 'renamed' | 'deleted'
  doc: DocMeta
}

export interface VaultMirrorDeps {
  vaultId: string
  workRoot: string
  baseDir: string
  relayUrl: string
  token: string
  api: MirrorApi
  turnIdleMs?: number
  lifecycleDebounceMs?: number
  log?: (msg: string) => void
}

interface DocEntry {
  docId: string
  rel: VaultRelPath
  doc: Y.Doc
  provider: HocuspocusProvider
  bridge: DocBridge
  started: boolean
}

export class VaultMirror {
  private readonly entries = new Map<string, DocEntry>() // by docId
  private readonly byPath = new Map<string, DocEntry>() // by rel
  private readonly pendingLifecycle = new Map<string, ReturnType<typeof setTimeout>>() // by rel
  private readonly bases: BaseStore
  private socket: HocuspocusProviderWebsocket | null = null
  private watcher: FSWatcher | null = null
  private stopped = false
  private readonly lifecycleDebounceMs: number
  private readonly log: (msg: string) => void

  constructor(private readonly deps: VaultMirrorDeps) {
    this.bases = new BaseStore(deps.baseDir)
    this.lifecycleDebounceMs = deps.lifecycleDebounceMs ?? 400
    this.log = deps.log ?? ((msg) => console.log(`[mirror:${deps.vaultId}] ${msg}`))
  }

  async start(): Promise<void> {
    await mkdir(this.deps.workRoot, { recursive: true })
    this.socket = new HocuspocusProviderWebsocket({
      url: this.deps.relayUrl,
      WebSocketPolyfill: ws as never,
    })
    await this.refresh()
    this.watcher = watch(this.deps.workRoot, { ignoreInitial: true })
    this.watcher.on('add', (p) => this.onDiskEvent('add', p))
    this.watcher.on('change', (p) => this.onDiskEvent('change', p))
    this.watcher.on('unlink', (p) => this.onDiskEvent('unlink', p))
  }

  /** Working copies stay on disk — persisted bases make the next activate
   * reconcile any divergence instead of clobbering. */
  async stop(): Promise<void> {
    this.stopped = true
    for (const timer of this.pendingLifecycle.values()) clearTimeout(timer)
    this.pendingLifecycle.clear()
    await this.watcher?.close()
    for (const entry of [...this.entries.values()]) await this.closeEntry(entry, { removeFromDisk: false })
    this.socket?.destroy()
  }

  /** Reconcile against server truth: open/close/move entries per listDocs,
   * then adopt unknown disk files. Runs at start and on SSE reconnect. */
  async refresh(): Promise<void> {
    const docs = await this.deps.api.listDocs()
    const seen = new Set<string>()
    for (const meta of docs) {
      seen.add(meta.id)
      const existing = this.entries.get(meta.id)
      if (!existing) void this.openEntry(meta)
      else if (existing.rel !== meta.path) await this.applyRename(existing, meta.path)
    }
    for (const entry of [...this.entries.values()]) {
      if (!seen.has(entry.docId)) await this.closeEntry(entry, { removeFromDisk: true })
    }
    await this.adoptUnknownFiles()
  }

  handleDocsEvent(event: DocsEvent): void {
    void this.applyDocsEvent(event).catch((err) => this.log(`docs event failed: ${err}`))
  }

  private async applyDocsEvent(event: DocsEvent): Promise<void> {
    if (this.stopped) return
    const existing = this.entries.get(event.doc.id)
    if (event.type === 'created' && !existing) await this.openEntry(event.doc)
    else if (event.type === 'renamed' && existing) await this.applyRename(existing, event.doc.path)
    else if (event.type === 'deleted' && existing) await this.closeEntry(existing, { removeFromDisk: true })
  }

  private async openEntry(meta: DocMeta, seedText?: string): Promise<void> {
    if (this.entries.has(meta.id)) return
    let rel: VaultRelPath
    try {
      rel = vaultRelPath(meta.path)
    } catch (err) {
      this.log(`unsafe doc path skipped: ${meta.path} (${err})`)
      return
    }
    const doc = new Y.Doc()
    let resolveSynced!: () => void
    const synced = new Promise<void>((r) => (resolveSynced = r))
    const provider = new HocuspocusProvider({
      websocketProvider: this.socket!,
      name: meta.id,
      document: doc,
      token: this.deps.token,
      onSynced: () => resolveSynced(),
    })
    const entry: DocEntry = { docId: meta.id, rel, doc, provider, bridge: null as unknown as DocBridge, started: false }
    entry.bridge = new DocBridge({
      doc,
      readFile: () => readFile(absPathFor(this.deps.workRoot, entry.rel), 'utf8').catch(() => null),
      writeFile: (text) => writeAtomic(this.deps.workRoot, entry.rel, text),
      loadBase: () => this.bases.load(entry.docId),
      saveBase: (b) => this.bases.save(entry.docId, b),
      onTurnState: (active) => this.onTurnState(entry, active),
      turnIdleMs: this.deps.turnIdleMs,
    })
    this.entries.set(meta.id, entry)
    this.byPath.set(rel, entry)
    await synced
    if (this.stopped || this.entries.get(meta.id) !== entry) return
    if (seedText !== undefined) {
      doc.transact(() => doc.getText(YDOC_TEXT_KEY).insert(0, seedText), BRIDGE_ORIGIN)
    }
    await entry.bridge.start()
    entry.started = true
  }

  private async closeEntry(entry: DocEntry, opts: { removeFromDisk: boolean }): Promise<void> {
    this.entries.delete(entry.docId)
    this.byPath.delete(entry.rel)
    await entry.bridge.stop()
    entry.provider.destroy()
    entry.doc.destroy()
    if (opts.removeFromDisk) await removeDocFile(this.deps.workRoot, entry.rel).catch(() => {})
    await this.bases.remove(entry.docId)
  }

  private async applyRename(entry: DocEntry, newPathRaw: string): Promise<void> {
    let newRel: VaultRelPath
    try {
      newRel = vaultRelPath(newPathRaw)
    } catch (err) {
      this.log(`unsafe rename target skipped: ${newPathRaw} (${err})`)
      return
    }
    if (newRel === entry.rel) return
    this.byPath.delete(entry.rel)
    const oldRel = entry.rel
    entry.rel = newRel // bridge deps close over entry.rel — rebind is automatic
    this.byPath.set(newRel, entry)
    await moveDocFile(this.deps.workRoot, oldRel, newRel).catch(async () => {
      // file wasn't there (e.g. never materialized) — write current doc text
      await writeAtomic(this.deps.workRoot, newRel, entry.doc.getText(YDOC_TEXT_KEY).toString())
    })
  }

  private onTurnState(entry: DocEntry, active: boolean): void {
    entry.provider.setAwarenessField('agentEditing', active ? true : null)
    if (active) {
      void this.deps.api
        .takeSnapshot(entry.docId, 'before Claude edited')
        .catch((err) => this.log(`pre-agent-write snapshot failed for ${entry.rel}: ${err}`))
    }
  }

  private onDiskEvent(kind: 'add' | 'change' | 'unlink', absPath: string): void {
    if (this.stopped) return
    const rel = toVaultRel(this.deps.workRoot, absPath)
    if (!rel || isIgnoredPath(rel)) return
    const entry = this.byPath.get(rel)
    if (kind === 'unlink') {
      if (!entry) {
        const pending = this.pendingLifecycle.get(rel)
        if (pending) clearTimeout(pending) // create raced a delete — drop it
        this.pendingLifecycle.delete(rel)
        return
      }
      this.scheduleLifecycle(rel, () => this.propagateDelete(entry))
    } else {
      if (entry) {
        if (entry.started) void entry.bridge.onFileEvent()
      } else {
        this.scheduleLifecycle(rel, () => this.adoptFile(rel))
      }
    }
  }

  private scheduleLifecycle(rel: string, action: () => Promise<void>): void {
    const pending = this.pendingLifecycle.get(rel)
    if (pending) clearTimeout(pending)
    this.pendingLifecycle.set(
      rel,
      setTimeout(() => {
        this.pendingLifecycle.delete(rel)
        void action().catch((err) => this.log(`lifecycle failed for ${rel}: ${err}`))
      }, this.lifecycleDebounceMs),
    )
  }

  /** Agent rm → doc delete (git-ingress symmetry). On failure the file simply
   * re-materializes from server truth on the next refresh — logged, accepted. */
  private async propagateDelete(entry: DocEntry): Promise<void> {
    const onDisk = await readFile(absPathFor(this.deps.workRoot, entry.rel), 'utf8').catch(() => null)
    if (onDisk !== null) return // file came back (rename/rewrite) — not a delete
    if (this.entries.get(entry.docId) !== entry) return // already closed by a docs event
    await this.closeEntry(entry, { removeFromDisk: false })
    await this.deps.api.deleteNote(entry.docId)
  }

  /** Agent-created file → notes.create + seed the fresh doc with its content. */
  private async adoptFile(rel: VaultRelPath): Promise<void> {
    if (this.stopped || this.byPath.has(rel)) return
    const text = await readFile(absPathFor(this.deps.workRoot, rel), 'utf8').catch(() => null)
    if (text === null) return // vanished again
    if (text.includes('\0')) {
      this.log(`binary content skipped (not adopted): ${rel}`)
      return
    }
    const meta = await this.deps.api.createNote(rel)
    await this.openEntry(meta, text)
  }

  private async adoptUnknownFiles(): Promise<void> {
    for (const rel of await listFiles(this.deps.workRoot)) {
      if (isIgnoredPath(rel) || this.byPath.has(rel) || this.pendingLifecycle.has(rel)) continue
      let safe: VaultRelPath
      try {
        safe = vaultRelPath(rel)
      } catch {
        continue
      }
      await this.adoptFile(safe).catch((err) => this.log(`adopt failed for ${rel}: ${err}`))
    }
  }
}
```

Note: `seedText` insertion uses `BRIDGE_ORIGIN` so the entry's own bridge — not yet started — never treats its own seed as a remote update to re-materialize.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @holi/desktop exec vitest run test/vault-mirror.test.ts`
Expected: PASS (8 tests). Chokidar timing on CI-grade machines can make the lifecycle tests take a few seconds — the `waitUntil` timeouts allow it.

- [ ] **Step 5: Run the whole desktop suite**

Run: `pnpm --filter @holi/desktop test`
Expected: all PASS (new + the existing 32)

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/main/vault/vault-mirror.ts apps/desktop/test/vault-mirror.test.ts
git commit -m "feat(desktop): VaultMirror — full-vault live materialization + agent file lifecycle"
```

---

### Task 9: Hammer test against the real bridge

**Files:**
- Test: `apps/desktop/test/vault-hammer.test.ts`

The spike's acceptance (d) — no lost updates under uncoordinated concurrency — re-run against the production `VaultMirror`+`DocBridge` stack instead of the spike harness.

- [ ] **Step 1: Write the test**

```ts
// apps/desktop/test/vault-hammer.test.ts
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Hocuspocus } from '@hocuspocus/server'
import type { DocMeta } from '@holi/shared'
import { VaultMirror, type MirrorApi } from '../src/main/vault/vault-mirror'
import { AgentSim, converged, countOccurrences, SimClient, sleep, startRelay, waitUntil } from './helpers/relay'

const PORT = 5613
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

describe('acceptance (d) against the real mirror: no lost updates', () => {
  it('humans hammer continuously while the agent edits in bursts; every marker survives exactly once', async () => {
    const rnd = mulberry32(0xd25)
    const seed = ['# Hammer', 'L1:', 'L2:', 'L3:', 'L4:', 'L5:', 'L6:', 'L7:', 'L8:', 'AGENT:'].join('\n') + '\n'
    const docMeta: DocMeta = { id: randomUUID(), vaultId: 'v', path: 'hammer.md', kind: 'note', createdAt: '', updatedAt: '' }

    const h1 = new SimClient(URL, docMeta.id)
    const h2 = new SimClient(URL, docMeta.id)
    h1.text.insert(0, seed)
    await waitUntil(() => h2.toString() === seed, 10_000, 'seed propagated')

    const dir = await mkdtemp(join(tmpdir(), 'holi-hammer-'))
    const root = join(dir, 'work')
    const api: MirrorApi = {
      listDocs: async () => [docMeta],
      createNote: async () => {
        throw new Error('unexpected create')
      },
      deleteNote: async () => {},
      takeSnapshot: async () => {},
    }
    const mirror = new VaultMirror({
      vaultId: 'v',
      workRoot: root,
      baseDir: join(dir, 'bases'),
      relayUrl: URL,
      token: 'tok',
      api,
      turnIdleMs: 300,
    })
    await mirror.start()
    const filePath = join(root, 'hammer.md')
    await waitUntil(async () => (await readFile(filePath, 'utf8').catch(() => null)) === seed, 10_000, 'materialized')
    const agent = new AgentSim(filePath)

    const tokens: string[] = []
    let n = 0
    const humanOp = (who: SimClient, tag: string) => {
      const token = ` ${tag}-${++n}#`
      who.insertAfter(`L${1 + Math.floor(rnd() * 8)}:`, token)
      tokens.push(token.trim())
    }

    const BURSTS = 8
    for (let burst = 1; burst <= BURSTS; burst++) {
      const agentOps = 2 + Math.floor(rnd() * 3)
      for (let op = 0; op < agentOps; op++) {
        const token = `a${++n}#`
        if (rnd() < 0.3) {
          const current = await agent.read()
          await agent.write(
            current.split('\n').map((line) => (line.startsWith('AGENT:') ? `${line} ${token}` : line)).join('\n'),
          )
        } else {
          await agent.edit('AGENT:', `AGENT: ${token}`)
        }
        tokens.push(token)
        humanOp(h1, 'h1')
        humanOp(h2, 'h2')
        await sleep(30 + rnd() * 60)
      }
      humanOp(h1, 'h1')
      humanOp(h2, 'h2')
      await sleep(700)
    }

    const all = () => [h1.toString(), h2.toString()]
    await waitUntil(() => converged(all()), 20_000, 'replicas converged')
    await sleep(600) // final re-materialization settles
    const file = await readFile(filePath, 'utf8')
    expect(converged([...all(), file])).toBe(true)

    const missing = tokens.filter((t) => countOccurrences(file, t) === 0)
    const duplicated = tokens.filter((t) => countOccurrences(file, t) > 1)
    console.log(`[hammer] ${tokens.length} markers, ${missing.length} missing, ${duplicated.length} duplicated`)
    expect(missing).toEqual([])
    expect(duplicated).toEqual([])

    await mirror.stop()
    h1.destroy()
    h2.destroy()
    await rm(dir, { recursive: true, force: true })
  }, 120_000)
})
```

- [ ] **Step 2: Run it (this test validates existing code — it should pass immediately; if it fails, the bridge has a real bug: debug, don't loosen the test)**

Run: `pnpm --filter @holi/desktop exec vitest run test/vault-hammer.test.ts`
Expected: PASS, `0 missing, 0 duplicated` in the log

- [ ] **Step 3: Run it three more times for flake confidence**

Run: `pnpm --filter @holi/desktop exec vitest run test/vault-hammer.test.ts && pnpm --filter @holi/desktop exec vitest run test/vault-hammer.test.ts && pnpm --filter @holi/desktop exec vitest run test/vault-hammer.test.ts`
Expected: PASS every run

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/test/vault-hammer.test.ts
git commit -m "test(desktop): randomized hammer — no lost updates through the real mirror"
```

---

### Task 10: Wire it into the app (manager, IPC, renderer activation)

**Files:**
- Create: `apps/desktop/src/main/vault/mirror-api.ts`, `apps/desktop/src/main/vault/vault-manager.ts`
- Modify: `apps/desktop/src/main/index.ts`, `apps/desktop/src/main/ipc.ts`, `apps/desktop/src/preload/index.ts`, `apps/desktop/src/renderer/src/global.d.ts`, `apps/desktop/src/renderer/src/components/Shell.tsx`

No new unit tests here — every part is a thin composition of tested pieces; verification is typecheck + the live smoke below.

- [ ] **Step 1: Implement `mirror-api.ts`**

```ts
// apps/desktop/src/main/vault/mirror-api.ts
/** MirrorApi over the main-process tRPC client — ops run as the signed-in
 * user, so membership gating stays server-side (spec §McpServer principle). */
import type { ServerClient } from '../server-client'
import type { MirrorApi } from './vault-mirror'

export function makeMirrorApi(client: ServerClient, vaultId: string): MirrorApi {
  return {
    listDocs: async () => (await client.vaults.listDocs.query({ vaultId })).docs,
    createNote: (path) => client.notes.create.mutate({ vaultId, path, kind: 'note' }),
    deleteNote: async (docId) => {
      await client.notes.delete.mutate({ vaultId, docId })
    },
    takeSnapshot: async (docId, label) => {
      await client.snapshots.take.mutate({ docId, label })
    },
  }
}
```

- [ ] **Step 2: Implement `vault-manager.ts`**

```ts
// apps/desktop/src/main/vault/vault-manager.ts
/** One active vault at a time (spec §Session lifecycle): activate tears down
 * the previous vault's mirror + event stream and starts the next. Working
 * copies live under userData/working-copies/<vaultId>; frozen bases under
 * userData/vault-bases/<vaultId>. */
import { join } from 'node:path'
import { app } from 'electron'
import { API_URL, RELAY_URL, createServerClient } from '../server-client'
import type { SessionStore } from '../session'
import { makeMirrorApi } from './mirror-api'
import { SseClient } from './sse-client'
import { VaultMirror, type DocsEvent } from './vault-mirror'

export interface VaultManager {
  activate(vaultId: string): Promise<{ ok: true }>
  deactivate(): Promise<void>
  /** The active working dir — slice 2 points the PTY here. */
  workRootFor(vaultId: string): string
}

export function createVaultManager(deps: { store: SessionStore; dataDir?: string }): VaultManager {
  let current: { vaultId: string; mirror: VaultMirror; events: SseClient } | null = null

  const dataDir = () => deps.dataDir ?? app.getPath('userData')
  const workRootFor = (vaultId: string) => join(dataDir(), 'working-copies', vaultId)

  async function deactivate(): Promise<void> {
    if (!current) return
    const { mirror, events } = current
    current = null
    events.stop()
    await mirror.stop()
  }

  async function activate(vaultId: string): Promise<{ ok: true }> {
    if (current?.vaultId === vaultId) return { ok: true }
    await deactivate()
    const session = deps.store.load()
    if (!session) throw new Error('not signed in')
    const client = createServerClient(() => deps.store.load()?.token ?? null)
    const mirror = new VaultMirror({
      vaultId,
      workRoot: workRootFor(vaultId),
      baseDir: join(dataDir(), 'vault-bases', vaultId),
      relayUrl: RELAY_URL,
      token: session.token,
      api: makeMirrorApi(client, vaultId),
    })
    const events = new SseClient({
      url: `${API_URL}/events/${vaultId}`,
      getToken: () => deps.store.load()?.token ?? null,
      onEvent: (channel, data) => {
        if (channel === 'docs') mirror.handleDocsEvent(data as DocsEvent)
        // 'tasks' + 'reminders' get consumers in slice 2 (ContextSnapshot)
      },
      onReconnect: () => void mirror.refresh().catch((err) => console.error('[mirror] refresh failed:', err)),
    })
    await mirror.start()
    events.start()
    current = { vaultId, mirror, events }
    return { ok: true }
  }

  return { activate, deactivate, workRootFor }
}
```

- [ ] **Step 3: Wire IPC, preload, global.d.ts, index.ts**

`apps/desktop/src/main/ipc.ts` — extend the deps and add the handler:

```ts
// signature change:
export function registerIpc(deps: { store: SessionStore; vaultManager: VaultManager }): void {
  const { store, vaultManager } = deps
```

(add `import type { VaultManager } from './vault/vault-manager'`), and next to the other handlers:

```ts
  ipcMain.handle('holi:vault:activate', (_e, vaultId: string) =>
    toEnvelope(vaultManager.activate(String(vaultId))),
  )
```

`apps/desktop/src/main/index.ts` — add `import { createVaultManager } from './vault/vault-manager'` and replace the current `app.whenReady()` block with:

```ts
app.whenReady().then(() => {
  const store = electronSessionStore()
  const vaultManager = createVaultManager({ store })
  registerIpc({ store, vaultManager })
  app.on('before-quit', () => void vaultManager.deactivate())
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})
```

`apps/desktop/src/preload/index.ts` — add inside the exposed object:

```ts
  vault: {
    activate: (vaultId: string) => ipcRenderer.invoke('holi:vault:activate', vaultId),
  },
```

`apps/desktop/src/renderer/src/global.d.ts` — add to the `holi` interface:

```ts
      vault: {
        activate(vaultId: string): Promise<TrpcEnvelope>
      }
```

`apps/desktop/src/renderer/src/components/Shell.tsx` — in the existing `useEffect` that depends on `activeVaultId` (the one calling `loadDocs`), add the activation call as its first line:

```ts
    if (activeVaultId) void window.holi.vault.activate(activeVaultId)
```

- [ ] **Step 4: Typecheck + full desktop suite**

Run: `pnpm --filter @holi/desktop typecheck && pnpm --filter @holi/desktop test && pnpm --filter @holi/server typecheck`
Expected: clean / PASS

- [ ] **Step 5: Live smoke (manual, per the dev-loop quirks)**

1. `pnpm db:up`, then `pnpm --filter @holi/server dev` (relay :4444, API :4000); seed a token via `pnpm --filter @holi/server exec tsx scripts/seed-dev.ts`.
2. `pnpm --filter @holi/desktop dev`, sign in with the dev token, open a vault, create a note with some text.
3. Verify the working copy exists: `ls "$HOME/Library/Application Support/holi-desktop/working-copies/"` (the app-name dir may differ — check `userData`) and `cat` the note file — content matches the editor.
4. Type in the editor → `cat` again within ~1s → file updated.
5. `echo "from disk" >> <note file>` → the line appears **live in the open editor** (the bridge turn merged it).
6. Create a new file in the working dir (`echo hi > <workdir>/smoke-test.md`) → it appears in the file tree (via SSE) within a couple of seconds.
7. `rm <workdir>/smoke-test.md` → the doc disappears from the tree.

Expected: all seven behaviors hold. If 5–7 work, slice 1's core promise (drawer-less agent edits) is real.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/main apps/desktop/src/preload apps/desktop/src/renderer
git commit -m "feat(desktop): vault activation wiring — mirror + SSE behind holi:vault:activate"
```

---

### Task 11: Full workspace green + record deviations

**Files:**
- Modify: `docs/specs/2026-07-13-agent-drawer-design.md` (deviations section at the bottom)
- Modify: `docs/plans/2026-07-13-agent-drawer-foundations.md` (check off tasks)

- [ ] **Step 1: Run everything**

Run: `pnpm -r test && pnpm -r typecheck`
Expected: every package PASS / clean (server needs `pnpm db:up`)

- [ ] **Step 2: Append a deviations section to the spec**

Append to `docs/specs/2026-07-13-agent-drawer-design.md`:

```markdown
## Slice-1 implementation deviations (2026-07-13)

Recorded during `docs/plans/2026-07-13-agent-drawer-foundations.md` execution:

1. **One diff engine.** `applyAgentTurn` was promoted onto fast-diff (the server's existing dep), not the spike's diff-match-patch; the spike acceptance tests re-ran green against it in `packages/shared`.
2. **`isLocalOnlyPath` lives in shared** and now also matches root `USER.md` (machine-local per this spec); the git exporter and the mirror share one definition.
3. **Turn signals are watcher-mode in slice 1**; `DocBridge.signalTurnEnd()` is the seam the slice-2 Stop-hook route calls.
4. **No-base recovery:** a known doc path on disk with no persisted base takes server truth (nothing to diff against); unknown files are adopted as agent creations (startup scan + SSE-reconnect refresh).
5. **Lifecycle propagation failures self-heal via `refresh()`** on SSE reconnect instead of a bespoke retry queue.
```

- [ ] **Step 3: Update memory of test counts if MEMORY.md tracks them** — skip if not applicable.

- [ ] **Step 4: Commit**

```bash
git add docs/specs/2026-07-13-agent-drawer-design.md docs/plans/2026-07-13-agent-drawer-foundations.md
git commit -m "docs: agent drawer slice-1 — record implementation deviations"
```
