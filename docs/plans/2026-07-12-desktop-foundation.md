# Desktop Client Foundation Implementation Plan

> **For agentic workers:** Use the executing-plans skill to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the `apps/desktop` Electron shell into a signed-in, multiplayer note client: Google SSO (system browser + PKCE + loopback), session in `safeStorage`, tRPC-over-IPC, vault list + file tree from server metadata, and a CodeMirror 6 editor with simplified live preview bound to Yjs via `y-codemirror.next` + Hocuspocus, with remote presence and a sync-status indicator.

**Architecture:** The Electron **main** process owns the session token (encrypted at rest via `safeStorage`) and a tRPC client to the Syv server; the renderer talks tRPC through a custom IPC link (token never crosses into the renderer for API calls). For the Yjs WebSocket the renderer runs `HocuspocusProvider` directly, fetching `{url, token}` from main per-connection (documented deviation #1). The editor is a **fresh, trimmed** implementation per D22 — plain decoration-swap live preview, no animation — with `yCollab` providing multiplayer + remote cursors.

**Tech Stack:** Electron 43 + electron-vite + React 18 + Jotai (existing), @trpc/client v11 (custom IPC link), @hocuspocus/provider v2, yjs, y-codemirror.next, CodeMirror 6 (`@codemirror/state|view|language|commands|lang-markdown`), Tailwind v4, vitest.

**Ground rules:**
- Work ONLY in `/Users/nicolaibthomsen/repos/syv/better-holi-final`. `~/repos/holi` is reference-only.
- Commit on `main`. Every commit message ends with `Claude goes brr.. via Dash`.
- The PRDs own the design (`docs/prd/auth-identity.md`, `notes-editor.md`, `vaults-collaboration.md`); D#-decisions are law.
- Bare `node`/`npx` are broken — route everything through `pnpm` from the repo root. Check exit codes, not piped output (`… > /tmp/log 2>&1; echo $?`).
- Ports: relay 4444, API 4000, Postgres 5433. Kill stale dev processes with `lsof -ti :4000 -ti :4444 | xargs kill` (never a broad `pkill` — Dash is Electron; scope any pkill to `electron-vite`).
- Old-editor reference: `~/repos/holi/src/editor/livePreview.ts` et al. — port *shapes*, write fresh trimmed code (D22 cuts the morph layer).

**Decisions taken by this plan (surface to Nicolai, don't re-litigate mid-execution):**
1. **Collab token transits the renderer (deviation from auth PRD §Flows step 6 letter).** The canonical session token lives only in main (`safeStorage`); tRPC calls never expose it. But `HocuspocusProvider` runs in the renderer (the editor needs the `Y.Doc` there), so the renderer fetches `{url, token}` from main per connection and holds it in memory only — never persisted. Rationale: the PRD's own alternative ("the token is attached in the main-side WS client") would require mirroring Y.Docs over IPC — significant novel machinery that D30 disfavors; and the coming file-bridge phase connects main to the relay as a *separate* Yjs client anyway, so main-side doc hosting buys nothing. Revisit if the threat model hardens.
2. **tRPC-over-IPC via a hand-rolled link** (~30 lines), not the `electron-trpc` dependency. Op envelope `{path, type, input}` over one `ipcMain.handle` channel; typed end-to-end by importing `AppRouter` **type-only** from `@holi/server`.
3. **Editor scope = core set.** Live preview covers: ATX headings, strong/emphasis/inline-code/strikethrough, fenced code, blockquote, horizontal rule, markdown links, wiki-link chips. Formatting hotkeys ⌘B/I/E/K/⇧X. **Deferred to an "editor completion" phase:** images, task checkboxes, frontmatter hiding, tables, `@`-mentions, slash commands, hover previews, `[[task:<id>]]` chips.
4. **Dev sign-in**: a dev-only "paste session token" input (renderer, `import.meta.env.DEV` only) so the full flow works without Google credentials — tokens come from `apps/server/scripts/seed-dev.ts`. The real Google flow is implemented and manually verifiable when `GOOGLE_CLIENT_ID/SECRET` are set.
5. **No SSE subscriptions this phase.** File tree refetches after own mutations; live cross-client tree updates ride the tasks-board phase (which needs `httpSubscriptionLink` anyway). Doc *content* is live via Yjs regardless.
6. **Offline cache (y-indexeddb) deferred** to its own phase. This phase ships the sync-status indicator only (`synced | syncing | offline`).
7. **Personal-vault provisioning seeds nothing** (FR-8's daily scaffold/AGENTS/MEMORY land with the daily-notes/agent phases). Enforced single personal vault per user via a partial unique index; `vaults.create` input narrows to `kind: 'shared'`.

---

## File structure

```
apps/server/src/
  auth/google.ts                  # exchangeGoogleCode gains {codeVerifier, redirectUri} (modify)
  auth/provision.ts               # provisionPersonalVault (new)
  routers/auth.ts                 # oauthConfig query; completeGoogle PKCE input + provisioning (modify)
  routers/vaults.ts               # create input narrows to kind 'shared' (modify)
  db/schema.ts                    # partial unique index vaults_personal_owner_idx (modify + migration)
  scripts/seed-dev.ts             # reuse personal vault if present (modify)

apps/desktop/
  vitest.config.ts                # test/**, node env (new)
  src/main/
    index.ts                      # boot: session store, server client, ipc, window (rewrite)
    session.ts                    # safeStorage-backed ClientSession store, DI-testable (new)
    server-client.ts              # tRPC client to Syv API w/ bearer injection + callProcedure (new)
    oauth.ts                      # pkcePair, googleAuthorizeUrl, createLoopbackServer, signInWithGoogle (new)
    ipc.ts                        # ipcMain.handle registrations: trpc, auth, collabAuth (new)
  src/preload/index.ts            # holi bridge: trpc/auth/collabAuth (rewrite)
  src/renderer/src/
    global.d.ts                   # window.holi typing (rewrite)
    lib/ipc-link.ts               # custom tRPC link over the preload bridge (new)
    lib/trpc.ts                   # typed client instance (new)
    lib/tree.ts                   # buildTree(docs, folders) → TreeNode[] (new)
    state/session.ts              # session atoms + actions (new)
    state/vaults.ts               # vaults list / active vault / docs atoms (new)
    state/sync.ts                 # syncStatusAtom (new)
    editor/formatting.ts          # toggle-aware inline formatting + keymap (new)
    editor/livePreview.ts         # decoration builder + ViewPlugin (new)
    editor/wikiLinkChips.ts       # chip widget for [[links]] (new)
    editor/theme.ts               # editor theme incl. tight vertical rhythm (3b) (new)
    editor/extensions.ts          # assembles the editor extension array (new)
    collab/provider.ts            # openDoc(docId) → HocuspocusProvider + status wiring (new)
    components/SignIn.tsx         # Google button + dev token input (new)
    components/Shell.tsx          # sidebar + editor pane + status bar layout (new)
    components/FileTree.tsx       # server-metadata tree + new-note (new)
    components/EditorPane.tsx     # CM6 view lifecycle + yCollab binding (new)
    App.tsx                       # SignIn gate → Shell (rewrite)
  test/                           # vitest suites (new)
```

Each task leaves `pnpm -r typecheck` green and `pnpm dev` bootable. Commit at every task boundary.

---

## Task 1: Server — PKCE exchange, oauthConfig, personal-vault provisioning (TDD)

**Files:**
- Create: `apps/server/src/auth/provision.ts`
- Modify: `apps/server/src/auth/google.ts`, `apps/server/src/routers/auth.ts`, `apps/server/src/routers/vaults.ts`, `apps/server/src/db/schema.ts`, `apps/server/scripts/seed-dev.ts`
- Create: `apps/server/drizzle/0001_*.sql` (generated)
- Test: `apps/server/test/provision.test.ts`

- [ ] **Step 1: Write the failing test `apps/server/test/provision.test.ts`**

```ts
import { and, eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { provisionPersonalVault } from '../src/auth/provision'
import { memberships, vaults } from '../src/db/schema'
import { createTestDb, type TestDb } from '../src/test/db'
import { seedUser } from '../src/test/fixtures'

describe('personal vault provisioning (FR-7)', () => {
  let t: TestDb
  beforeAll(async () => {
    t = await createTestDb()
  })
  afterAll(() => t.destroy())

  it('first call creates exactly one personal vault + owner membership', async () => {
    const u = await seedUser(t.db)
    const vaultId = await provisionPersonalVault(t.db, u.id)
    const rows = await t.db
      .select()
      .from(vaults)
      .where(and(eq(vaults.ownerId, u.id), eq(vaults.kind, 'personal')))
    expect(rows).toHaveLength(1)
    expect(rows[0]?.id).toBe(vaultId)
    const [m] = await t.db.select().from(memberships).where(eq(memberships.vaultId, vaultId))
    expect(m).toMatchObject({ userId: u.id, role: 'owner' })
  })

  it('is idempotent — second call returns the same vault', async () => {
    const u = await seedUser(t.db)
    const first = await provisionPersonalVault(t.db, u.id)
    const second = await provisionPersonalVault(t.db, u.id)
    expect(second).toBe(first)
    const rows = await t.db
      .select()
      .from(vaults)
      .where(and(eq(vaults.ownerId, u.id), eq(vaults.kind, 'personal')))
    expect(rows).toHaveLength(1)
  })

  it('DB enforces one personal vault per owner (partial unique index)', async () => {
    const u = await seedUser(t.db)
    await provisionPersonalVault(t.db, u.id)
    await expect(
      t.db.insert(vaults).values({ name: 'sneaky', kind: 'personal', ownerId: u.id }),
    ).rejects.toThrow()
    // shared vaults are unrestricted
    await t.db.insert(vaults).values({ name: 'a', kind: 'shared', ownerId: u.id })
    await t.db.insert(vaults).values({ name: 'b', kind: 'shared', ownerId: u.id })
  })
})
```

- [ ] **Step 2: Run to verify failure**

```bash
pnpm --filter @holi/server test test/provision.test.ts > /tmp/t.log 2>&1; echo $?; tail -3 /tmp/t.log
```

Expected: FAIL — cannot find module `../src/auth/provision`.

- [ ] **Step 3: Add the partial unique index to `apps/server/src/db/schema.ts`**

Change the `vaults` table definition to add an index callback (it currently has none):

```ts
export const vaults = pgTable(
  'vaults',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    kind: text('kind', { enum: ['personal', 'shared'] }).notNull(),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => users.id),
    theme: jsonb('theme'),
    ...timestamps,
  },
  (t) => [
    /** FR-7: at most one personal vault per user — provisioning race guard. */
    uniqueIndex('vaults_personal_owner_idx')
      .on(t.ownerId)
      .where(sql`${t.kind} = 'personal'`),
  ],
)
```

- [ ] **Step 4: Generate + apply the migration**

```bash
pnpm --filter @holi/server db:generate 2>&1 | tail -3
pnpm --filter @holi/server db:migrate; echo $?
```

Expected: `drizzle/0001_*.sql` created containing `CREATE UNIQUE INDEX "vaults_personal_owner_idx" ... WHERE "vaults"."kind" = 'personal'`; migrate exits 0. (If the dev DB has duplicate personal vaults from repeated seeding, reset it: `docker compose down -v && docker compose up -d --wait && pnpm --filter @holi/server db:migrate`.)

- [ ] **Step 5: Write `apps/server/src/auth/provision.ts`**

```ts
/** FR-7: idempotent first-sign-in personal vault. FR-8 seeding (daily
 * scaffold, AGENTS/MEMORY) is a documented stub — lands with the
 * daily-notes/agent phases. */
import { and, eq } from 'drizzle-orm'
import type { Db } from '../db/client'
import { memberships, vaults } from '../db/schema'

export async function provisionPersonalVault(db: Db, userId: string): Promise<string> {
  const existing = await findPersonal(db, userId)
  if (existing) return existing
  try {
    return await db.transaction(async (tx) => {
      const [vault] = await tx
        .insert(vaults)
        .values({ name: 'Personal', kind: 'personal', ownerId: userId })
        .returning()
      await tx.insert(memberships).values({ vaultId: vault!.id, userId, role: 'owner' })
      return vault!.id
    })
  } catch (err) {
    // concurrent first sign-in lost the race on vaults_personal_owner_idx
    const raced = await findPersonal(db, userId)
    if (raced) return raced
    throw err
  }
}

async function findPersonal(db: Db, userId: string): Promise<string | null> {
  const [row] = await db
    .select({ id: vaults.id })
    .from(vaults)
    .where(and(eq(vaults.ownerId, userId), eq(vaults.kind, 'personal')))
  return row?.id ?? null
}
```

- [ ] **Step 6: PKCE params in `apps/server/src/auth/google.ts`**

Replace the `exchangeGoogleCode` function (keep everything else):

```ts
export interface ExchangeOpts {
  codeVerifier?: string
  redirectUri?: string
}

export async function exchangeGoogleCode(code: string, opts: ExchangeOpts = {}): Promise<GoogleProfile> {
  const client = oauthClient()
  const { tokens } = await client.getToken({
    code,
    codeVerifier: opts.codeVerifier,
    redirect_uri: opts.redirectUri ?? config.google.redirectUri,
  })
  if (!tokens.id_token) throw new Error('Google token exchange returned no id_token')
  const ticket = await client.verifyIdToken({
    idToken: tokens.id_token,
    audience: config.google.clientId,
  })
  const payload = ticket.getPayload()
  if (!payload?.sub || !payload.email) throw new Error('Google ID token missing sub/email')
  assertWorkspace(payload)
  return { sub: payload.sub, email: payload.email, name: payload.name, avatarUrl: payload.picture }
}
```

- [ ] **Step 7: Router changes in `apps/server/src/routers/auth.ts`**

Add the import and two procedure changes:

```ts
import { config } from '../config'
import { provisionPersonalVault } from '../auth/provision'

// new procedure, alongside beginGoogle:
  /** Public OAuth client config for the desktop's system-browser flow.
   * The clientId is public by design; the secret never leaves the server. */
  oauthConfig: publicProcedure.query(() => ({
    clientId: config.google.clientId ?? null,
    workspaceDomain: config.google.workspaceDomain ?? null,
  })),

// completeGoogle becomes:
  completeGoogle: publicProcedure
    .input(
      z.object({
        code: z.string().min(1),
        codeVerifier: z.string().optional(),
        redirectUri: z.string().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const profile = await exchangeGoogleCode(input.code, {
        codeVerifier: input.codeVerifier,
        redirectUri: input.redirectUri,
      })
      const user = await upsertGoogleUser(ctx.db, profile)
      await provisionPersonalVault(ctx.db, user.id)
      const token = await mintSession(ctx.db, user.id)
      return { token, user: { id: user.id, email: user.email, name: user.name, avatarUrl: user.avatarUrl } }
    }),
```

- [ ] **Step 8: Narrow `vaults.create` to shared (`apps/server/src/routers/vaults.ts`)**

Personal vaults exist only via provisioning (FR-14); creating a second one would now 500 on the index. Change the create input:

```ts
  create: authedProcedure
    .input(z.object({ name: z.string().min(1), kind: z.enum(['shared']).default('shared') }))
```

(The rest of `create` is unchanged.)

- [ ] **Step 9: Make `scripts/seed-dev.ts` idempotent on the personal vault**

Replace the vault-insert block (between the user upsert and the doc insert) with:

```ts
  const { provisionPersonalVault } = await import('../src/auth/provision')
  const vaultId = await provisionPersonalVault(db, user!.id)
  const [doc] = await db
    .insert(docs)
    .values({ vaultId, path: `welcome-${Date.now()}.md`, kind: 'note' })
    .returning()
```

…and use `vaultId` instead of `vault!.id` in the final `console.log`. (Unique doc path per run keeps re-seeding conflict-free.)

- [ ] **Step 10: Run the full server suite + typecheck, commit**

```bash
pnpm --filter @holi/server test > /tmp/t.log 2>&1; echo $?; tail -5 /tmp/t.log
pnpm --filter @holi/server typecheck; echo $?
git add apps/server/src apps/server/drizzle apps/server/scripts apps/server/test/provision.test.ts
git commit -m "feat(server): PKCE code exchange + oauthConfig + idempotent personal-vault provisioning (FR-7)

Claude goes brr.. via Dash"
```

Expected: all suites green (existing vaults tests still pass — they create `shared` vaults).

---

## Task 2: Desktop deps + vitest rig

**Files:**
- Modify: `apps/desktop/package.json` (via pnpm add)
- Create: `apps/desktop/vitest.config.ts`

- [ ] **Step 1: Install dependencies**

```bash
pnpm --filter @holi/desktop add @trpc/client @trpc/server yjs y-codemirror.next @hocuspocus/provider@^2 codemirror @codemirror/state @codemirror/view @codemirror/language @codemirror/commands @codemirror/lang-markdown @lezer/common
pnpm --filter @holi/desktop add -D vitest
pnpm --filter @holi/desktop add @holi/server@workspace:*
```

(`@trpc/server` is needed for the `observable` util the custom link uses; `@holi/server` is a workspace dep for the **type-only** `AppRouter` import — runtime code from it is never bundled.)

- [ ] **Step 2: Expose the router type from `@holi/server`**

Add to `apps/server/package.json` (top level, after `"type": "module"`):

```json
  "exports": {
    "./router": "./src/routers/index.ts"
  },
```

- [ ] **Step 3: Write `apps/desktop/vitest.config.ts`**

```ts
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    passWithNoTests: true,
  },
})
```

- [ ] **Step 4: Add the test script**

In `apps/desktop/package.json` scripts, add:

```json
    "test": "vitest run",
```

- [ ] **Step 5: Verify workspace still healthy, commit**

```bash
pnpm -r typecheck; echo $?
pnpm --filter @holi/desktop test > /tmp/t.log 2>&1; echo $?; tail -3 /tmp/t.log
git add apps/desktop/package.json apps/desktop/vitest.config.ts apps/server/package.json pnpm-lock.yaml
git commit -m "chore(desktop): collab/editor/trpc deps + vitest rig + server router type export

Claude goes brr.. via Dash"
```

Expected: typecheck 0; vitest exits 0 (no tests yet, passWithNoTests).

---

## Task 3: Main — session store (TDD)

`safeStorage`-encrypted `ClientSession` at `<userData>/session.bin`. The store is DI-testable: crypto + file path injected; the electron glue is a thin factory.

**Files:**
- Create: `apps/desktop/src/main/session.ts`
- Test: `apps/desktop/test/session.test.ts`

- [ ] **Step 1: Write the failing test `apps/desktop/test/session.test.ts`**

```ts
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { createSessionStore, type SessionCrypto } from '../src/main/session'

/** Reversible fake standing in for Electron safeStorage. */
const fakeCrypto: SessionCrypto = {
  encrypt: (s) => Buffer.from(s, 'utf8').reverse(),
  decrypt: (b) => Buffer.from(b).reverse().toString('utf8'),
}

const dir = mkdtempSync(join(tmpdir(), 'holi-session-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

describe('session store', () => {
  it('save → load round-trips the session', () => {
    const store = createSessionStore(join(dir, 'a.bin'), fakeCrypto)
    const session = {
      token: 'tok-123',
      userId: 'u1',
      email: 'n@syv.ai',
      name: 'N',
      cachedAt: '2026-07-12T00:00:00.000Z',
    }
    store.save(session)
    expect(store.load()).toEqual(session)
  })

  it('load returns null when nothing saved or file is garbage', () => {
    const store = createSessionStore(join(dir, 'missing.bin'), fakeCrypto)
    expect(store.load()).toBeNull()
  })

  it('clear removes the session', () => {
    const store = createSessionStore(join(dir, 'c.bin'), fakeCrypto)
    store.save({ token: 't', userId: 'u', email: 'e', name: null, cachedAt: 'x' })
    store.clear()
    expect(store.load()).toBeNull()
  })

  it('the token is not stored in plaintext on disk', () => {
    const file = join(dir, 'd.bin')
    const store = createSessionStore(file, fakeCrypto)
    store.save({ token: 'super-secret', userId: 'u', email: 'e', name: null, cachedAt: 'x' })
    const raw = require('node:fs').readFileSync(file, 'utf8')
    expect(raw.includes('super-secret')).toBe(false)
  })
})
```

- [ ] **Step 2: Run to verify failure**

```bash
pnpm --filter @holi/desktop test > /tmp/t.log 2>&1; echo $?; tail -3 /tmp/t.log
```

Expected: FAIL — cannot find module `../src/main/session`.

- [ ] **Step 3: Write `apps/desktop/src/main/session.ts`**

```ts
/**
 * ClientSession persistence (auth PRD §Data): the opaque Syv token, encrypted
 * at rest via Electron safeStorage (OS keychain-backed key). Lives ONLY in
 * main — the renderer gets user identity, never the token (tRPC), and a
 * transient collab token per WS connection (plan decision #1).
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

export interface ClientSession {
  token: string
  userId: string
  email: string
  name: string | null
  /** Last successful server contact — offline-grace anchor (FR-19). */
  cachedAt: string
}

export interface SessionCrypto {
  encrypt(plaintext: string): Buffer
  decrypt(ciphertext: Buffer): string
}

export interface SessionStore {
  load(): ClientSession | null
  save(session: ClientSession): void
  clear(): void
}

export function createSessionStore(file: string, crypto: SessionCrypto): SessionStore {
  return {
    load() {
      try {
        return JSON.parse(crypto.decrypt(readFileSync(file))) as ClientSession
      } catch {
        return null
      }
    },
    save(session) {
      mkdirSync(dirname(file), { recursive: true })
      writeFileSync(file, crypto.encrypt(JSON.stringify(session)))
    },
    clear() {
      rmSync(file, { force: true })
    },
  }
}

/** Electron glue — untestable by design, keep it thin. Call after app ready. */
export function electronSessionStore(): SessionStore {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { app, safeStorage } = require('electron') as typeof import('electron')
  return createSessionStore(join(app.getPath('userData'), 'session.bin'), {
    encrypt: (s) => safeStorage.encryptString(s),
    decrypt: (b) => safeStorage.decryptString(b),
  })
}
```

- [ ] **Step 4: Run tests, expect green**

```bash
pnpm --filter @holi/desktop test > /tmp/t.log 2>&1; echo $?; tail -4 /tmp/t.log
```

Expected: 4 passed.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/main/session.ts apps/desktop/test/session.test.ts
git commit -m "feat(desktop): safeStorage-backed session store test-first — token never plaintext at rest

Claude goes brr.. via Dash"
```

---

## Task 4: Main — PKCE + loopback OAuth (TDD pure parts)

**Files:**
- Create: `apps/desktop/src/main/oauth.ts`
- Test: `apps/desktop/test/oauth.test.ts`

- [ ] **Step 1: Write the failing test `apps/desktop/test/oauth.test.ts`**

```ts
import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { createLoopbackServer, googleAuthorizeUrl, pkcePair } from '../src/main/oauth'

describe('pkce', () => {
  it('generates a base64url verifier (43 chars) and its S256 challenge', () => {
    const { verifier, challenge } = pkcePair()
    expect(verifier).toMatch(/^[A-Za-z0-9_-]{43}$/)
    const expected = createHash('sha256').update(verifier).digest('base64url')
    expect(challenge).toBe(expected)
  })

  it('verifiers are unique per call', () => {
    expect(pkcePair().verifier).not.toBe(pkcePair().verifier)
  })
})

describe('authorize url', () => {
  it('carries every required param', () => {
    const url = new URL(
      googleAuthorizeUrl({
        clientId: 'cid',
        redirectUri: 'http://127.0.0.1:9999/oauth/callback',
        challenge: 'chal',
        state: 'st8',
        hd: 'syv.ai',
      }),
    )
    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth')
    expect(url.searchParams.get('client_id')).toBe('cid')
    expect(url.searchParams.get('redirect_uri')).toBe('http://127.0.0.1:9999/oauth/callback')
    expect(url.searchParams.get('response_type')).toBe('code')
    expect(url.searchParams.get('scope')).toBe('openid email profile')
    expect(url.searchParams.get('code_challenge')).toBe('chal')
    expect(url.searchParams.get('code_challenge_method')).toBe('S256')
    expect(url.searchParams.get('state')).toBe('st8')
    expect(url.searchParams.get('hd')).toBe('syv.ai')
  })

  it('omits hd when not configured', () => {
    const url = new URL(
      googleAuthorizeUrl({ clientId: 'c', redirectUri: 'http://127.0.0.1:1/x', challenge: 'y', state: 'z' }),
    )
    expect(url.searchParams.has('hd')).toBe(false)
  })
})

describe('loopback server', () => {
  it('resolves the code for a matching state and rejects a mismatched one', async () => {
    const srv = await createLoopbackServer('expected-state')
    const hit = await fetch(`${srv.redirectUri}?code=the-code&state=expected-state`)
    expect(hit.status).toBe(200)
    await expect(srv.waitForCode()).resolves.toBe('the-code')

    const srv2 = await createLoopbackServer('right')
    const bad = await fetch(`${srv2.redirectUri}?code=x&state=wrong`)
    expect(bad.status).toBe(400)
    await expect(srv2.waitForCode()).rejects.toThrow(/state/)
  })
})
```

- [ ] **Step 2: Run to verify failure**

```bash
pnpm --filter @holi/desktop test test/oauth.test.ts > /tmp/t.log 2>&1; echo $?; tail -3 /tmp/t.log
```

Expected: FAIL — module missing.

- [ ] **Step 3: Write `apps/desktop/src/main/oauth.ts`**

```ts
/**
 * Desktop OAuth (auth PRD §Flows): PKCE + system browser + loopback redirect
 * (RFC 8252). The code exchange happens ON THE SERVER (auth.completeGoogle) —
 * the Google client_secret never touches this machine.
 */
import { createHash, randomBytes } from 'node:crypto'
import { createServer } from 'node:http'

export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString('base64url')
  const challenge = createHash('sha256').update(verifier).digest('base64url')
  return { verifier, challenge }
}

export function googleAuthorizeUrl(opts: {
  clientId: string
  redirectUri: string
  challenge: string
  state: string
  hd?: string
}): string {
  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth')
  url.searchParams.set('client_id', opts.clientId)
  url.searchParams.set('redirect_uri', opts.redirectUri)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('scope', 'openid email profile')
  url.searchParams.set('code_challenge', opts.challenge)
  url.searchParams.set('code_challenge_method', 'S256')
  url.searchParams.set('state', opts.state)
  if (opts.hd) url.searchParams.set('hd', opts.hd)
  return url.href
}

export interface LoopbackServer {
  redirectUri: string
  waitForCode(): Promise<string>
  close(): void
}

/** Ephemeral 127.0.0.1 listener for the OAuth redirect; state is the CSRF nonce. */
export function createLoopbackServer(expectedState: string, timeoutMs = 5 * 60_000): Promise<LoopbackServer> {
  return new Promise((resolveServer) => {
    let settle: { resolve(code: string): void; reject(err: Error): void }
    const codePromise = new Promise<string>((resolve, reject) => {
      settle = { resolve, reject }
    })
    const timer = setTimeout(() => settle.reject(new Error('OAuth timed out')), timeoutMs)

    const server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      if (url.pathname !== '/oauth/callback') {
        res.writeHead(404).end()
        return
      }
      const code = url.searchParams.get('code')
      const state = url.searchParams.get('state')
      if (!code || state !== expectedState) {
        res.writeHead(400, { 'content-type': 'text/plain' }).end('OAuth state mismatch — try again from Holi.')
        settle.reject(new Error('OAuth state mismatch'))
      } else {
        res
          .writeHead(200, { 'content-type': 'text/html' })
          .end('<html><body><p>Signed in — you can return to Holi.</p></body></html>')
        settle.resolve(code)
      }
      clearTimeout(timer)
      server.close()
    })

    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      resolveServer({
        redirectUri: `http://127.0.0.1:${port}/oauth/callback`,
        waitForCode: () => codePromise,
        close: () => {
          clearTimeout(timer)
          server.close()
        },
      })
    })
  })
}
```

- [ ] **Step 4: Run tests, expect green, commit**

```bash
pnpm --filter @holi/desktop test > /tmp/t.log 2>&1; echo $?; tail -4 /tmp/t.log
git add apps/desktop/src/main/oauth.ts apps/desktop/test/oauth.test.ts
git commit -m "feat(desktop): PKCE + loopback OAuth primitives test-first

Claude goes brr.. via Dash"
```

---

## Task 5: Main — server tRPC client, sign-in orchestration, IPC handlers

**Files:**
- Create: `apps/desktop/src/main/server-client.ts`
- Create: `apps/desktop/src/main/ipc.ts`
- Rewrite: `apps/desktop/src/main/index.ts`
- Test: `apps/desktop/test/server-client.test.ts`

- [ ] **Step 1: Write the failing test `apps/desktop/test/server-client.test.ts`**

Tests the pure helper that executes an `{path, type, input}` op against a tRPC proxy client, plus the error envelope:

```ts
import { describe, expect, it } from 'vitest'
import { callProcedure, toEnvelope } from '../src/main/server-client'

describe('callProcedure', () => {
  // tRPC proxy nodes are functions with properties — the fake must match
  const listNode = Object.assign(() => {}, { query: async (input: unknown) => ['v1', input] })
  const createNode = Object.assign(() => {}, { mutate: async (input: unknown) => ({ made: input }) })
  const fakeClient = Object.assign(() => {}, {
    vaults: Object.assign(() => {}, { list: listNode, create: createNode }),
  })

  it('resolves nested query paths', async () => {
    await expect(callProcedure(fakeClient, { path: 'vaults.list', type: 'query', input: 7 })).resolves.toEqual([
      'v1',
      7,
    ])
  })

  it('resolves mutations', async () => {
    await expect(
      callProcedure(fakeClient, { path: 'vaults.create', type: 'mutation', input: { name: 'x' } }),
    ).resolves.toEqual({ made: { name: 'x' } })
  })

  it('rejects unknown paths and subscription ops', async () => {
    await expect(callProcedure(fakeClient, { path: 'nope.nope', type: 'query', input: null })).rejects.toThrow()
    await expect(
      callProcedure(fakeClient, { path: 'vaults.list', type: 'subscription', input: null }),
    ).rejects.toThrow(/subscription/)
  })
})

describe('toEnvelope', () => {
  it('wraps success and failure', async () => {
    expect(await toEnvelope(Promise.resolve(42))).toEqual({ ok: true, data: 42 })
    const env = await toEnvelope(Promise.reject(Object.assign(new Error('nope'), { data: { code: 'FORBIDDEN' } })))
    expect(env).toEqual({ ok: false, message: 'nope', code: 'FORBIDDEN' })
  })
})
```

- [ ] **Step 2: Run to verify failure**

```bash
pnpm --filter @holi/desktop test test/server-client.test.ts > /tmp/t.log 2>&1; echo $?; tail -3 /tmp/t.log
```

Expected: FAIL — module missing.

- [ ] **Step 3: Write `apps/desktop/src/main/server-client.ts`**

```ts
/**
 * Main-process tRPC client to the Syv server. The bearer token is injected
 * here from the session store — the renderer's calls arrive over IPC as
 * {path, type, input} ops and are executed against this client, so the token
 * never crosses the context bridge for API calls (auth PRD §Flows).
 */
import { createTRPCClient, httpBatchLink } from '@trpc/client'
import type { AppRouter } from '@holi/server/router'

export const API_URL = process.env.HOLI_API_URL ?? 'http://127.0.0.1:4000'
export const RELAY_URL = process.env.HOLI_RELAY_URL ?? 'ws://127.0.0.1:4444'

export function createServerClient(getToken: () => string | null, url = API_URL) {
  return createTRPCClient<AppRouter>({
    links: [
      httpBatchLink({
        url,
        headers() {
          const token = getToken()
          return token ? { authorization: `Bearer ${token}` } : {}
        },
      }),
    ],
  })
}

export type ServerClient = ReturnType<typeof createServerClient>

export interface TrpcOp {
  path: string
  type: 'query' | 'mutation' | 'subscription'
  input: unknown
}

export type TrpcEnvelope = { ok: true; data: unknown } | { ok: false; message: string; code?: string }

/** Execute an IPC op against the (proxy) client: walk the path, call query/mutate. */
export async function callProcedure(client: unknown, op: TrpcOp): Promise<unknown> {
  if (op.type === 'subscription') throw new Error('subscriptions are not supported over the IPC link (plan decision #5)')
  // tRPC's proxy nodes are typeof 'function' — the walk must allow both
  const node = op.path.split('.').reduce<unknown>((acc, key) => {
    if (acc == null || (typeof acc !== 'object' && typeof acc !== 'function')) return undefined
    return (acc as Record<string, unknown>)[key]
  }, client)
  const method = op.type === 'query' ? 'query' : 'mutate'
  const fn = node && (node as Record<string, unknown>)[method]
  if (typeof fn !== 'function') throw new Error(`unknown procedure: ${op.path}`)
  return (fn as (input: unknown) => Promise<unknown>)(op.input)
}

export async function toEnvelope(promise: Promise<unknown>): Promise<TrpcEnvelope> {
  try {
    return { ok: true, data: await promise }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    const code = (err as { data?: { code?: string } }).data?.code
    return { ok: false, message, ...(code ? { code } : {}) }
  }
}
```

- [ ] **Step 4: Run tests, expect green**

```bash
pnpm --filter @holi/desktop test > /tmp/t.log 2>&1; echo $?; tail -4 /tmp/t.log
```

- [ ] **Step 5: Write `apps/desktop/src/main/ipc.ts`**

Untested glue (thin; every branch delegates to tested modules):

```ts
/** IPC surface — the ONLY seam between renderer and main (architecture §8). */
import { ipcMain, shell } from 'electron'
import { randomBytes } from 'node:crypto'
import { createLoopbackServer, googleAuthorizeUrl, pkcePair } from './oauth'
import {
  API_URL,
  RELAY_URL,
  callProcedure,
  createServerClient,
  toEnvelope,
  type ServerClient,
  type TrpcOp,
} from './server-client'
import type { SessionStore } from './session'

export interface PublicUser {
  userId: string
  email: string
  name: string | null
}

export function registerIpc(deps: { store: SessionStore }): void {
  const { store } = deps
  const client: ServerClient = createServerClient(() => store.load()?.token ?? null)

  ipcMain.handle('holi:trpc', (_e, op: TrpcOp) => toEnvelope(callProcedure(client, op)))

  ipcMain.handle('holi:auth:get', (): PublicUser | null => {
    const s = store.load()
    return s ? { userId: s.userId, email: s.email, name: s.name } : null
  })

  ipcMain.handle('holi:auth:signIn', () => toEnvelope(signInWithGoogle(client, store)))

  ipcMain.handle('holi:auth:devSignIn', (_e, token: string) =>
    toEnvelope(
      (async () => {
        // validate the pasted token by resolving the session with it
        const probe = createServerClient(() => token)
        const user = await probe.auth.session.query()
        store.save({
          token,
          userId: user.id,
          email: user.email,
          name: user.name,
          cachedAt: new Date().toISOString(),
        })
        return { userId: user.id, email: user.email, name: user.name } satisfies PublicUser
      })(),
    ),
  )

  ipcMain.handle('holi:auth:signOut', () =>
    toEnvelope(
      (async () => {
        try {
          await client.auth.signOut.mutate()
        } finally {
          store.clear() // local sign-out even if the server is unreachable
        }
        return { ok: true }
      })(),
    ),
  )

  /** Transient collab credentials for the renderer's HocuspocusProvider (plan decision #1). */
  ipcMain.handle('holi:collab:auth', () => {
    const s = store.load()
    return s ? { url: RELAY_URL, token: s.token } : null
  })
}

async function signInWithGoogle(client: ServerClient, store: SessionStore): Promise<PublicUser> {
  const cfg = await client.auth.oauthConfig.query()
  if (!cfg.clientId) {
    throw new Error(`Google OAuth is not configured on the server (${API_URL}) — use the dev token sign-in`)
  }
  const { verifier, challenge } = pkcePair()
  const state = randomBytes(16).toString('base64url')
  const loopback = await createLoopbackServer(state)
  try {
    await shell.openExternal(
      googleAuthorizeUrl({
        clientId: cfg.clientId,
        redirectUri: loopback.redirectUri,
        challenge,
        state,
        hd: cfg.workspaceDomain ?? undefined,
      }),
    )
    const code = await loopback.waitForCode()
    const { token, user } = await client.auth.completeGoogle.mutate({
      code,
      codeVerifier: verifier,
      redirectUri: loopback.redirectUri,
    })
    store.save({
      token,
      userId: user.id,
      email: user.email,
      name: user.name,
      cachedAt: new Date().toISOString(),
    })
    return { userId: user.id, email: user.email, name: user.name }
  } finally {
    loopback.close()
  }
}
```

- [ ] **Step 6: Rewrite `apps/desktop/src/main/index.ts`**

```ts
import { app, BrowserWindow } from 'electron'
import { join } from 'node:path'
import { registerIpc } from './ipc'
import { electronSessionStore } from './session'

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
  registerIpc({ store: electronSessionStore() })
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
```

- [ ] **Step 7: Typecheck + commit**

```bash
pnpm --filter @holi/desktop typecheck; echo $?
git add apps/desktop/src/main
git commit -m "feat(desktop): main-process tRPC client + Google sign-in orchestration + IPC surface

Claude goes brr.. via Dash"
```

Expected: typecheck 0. (If the `@holi/server/router` type import errors, verify Task 2 Step 2's exports field.)

---

## Task 6: Preload bridge + renderer tRPC link (TDD)

**Files:**
- Rewrite: `apps/desktop/src/preload/index.ts`
- Rewrite: `apps/desktop/src/renderer/src/global.d.ts`
- Create: `apps/desktop/src/renderer/src/lib/ipc-link.ts`
- Create: `apps/desktop/src/renderer/src/lib/trpc.ts`
- Test: `apps/desktop/test/ipc-link.test.ts`

- [ ] **Step 1: Write the failing test `apps/desktop/test/ipc-link.test.ts`**

```ts
import { createTRPCClient } from '@trpc/client'
import { describe, expect, it } from 'vitest'
import type { AppRouter } from '@holi/server/router'
import { ipcLink, type TrpcInvoke } from '../src/renderer/src/lib/ipc-link'

function clientWith(invoke: TrpcInvoke) {
  return createTRPCClient<AppRouter>({ links: [ipcLink(invoke)] })
}

describe('ipc tRPC link', () => {
  it('forwards the op and resolves the data', async () => {
    const seen: unknown[] = []
    const client = clientWith(async (op) => {
      seen.push(op)
      return { ok: true, data: { ok: true, service: 'holi-server', time: 't' } }
    })
    const health = await client.health.query()
    expect(health.service).toBe('holi-server')
    expect(seen[0]).toMatchObject({ path: 'health', type: 'query' })
  })

  it('surfaces error envelopes as rejections carrying the message', async () => {
    const client = clientWith(async () => ({ ok: false, message: 'nope', code: 'FORBIDDEN' }))
    await expect(client.health.query()).rejects.toMatchObject({ message: 'nope' })
  })
})
```

(Input passthrough is covered by the first test's `seen[0]` assertion.)

- [ ] **Step 2: Run to verify failure**

```bash
pnpm --filter @holi/desktop test test/ipc-link.test.ts > /tmp/t.log 2>&1; echo $?; tail -3 /tmp/t.log
```

Expected: FAIL — module missing.

- [ ] **Step 3: Write `apps/desktop/src/renderer/src/lib/ipc-link.ts`**

```ts
/**
 * tRPC terminating link that ships ops over the preload bridge to main,
 * where the authed HTTP client executes them (plan decision #2). Queries and
 * mutations only — subscriptions arrive with the tasks-board phase.
 */
import { TRPCClientError, type TRPCLink } from '@trpc/client'
import { observable } from '@trpc/server/observable'
import type { AppRouter } from '@holi/server/router'

export interface TrpcOpWire {
  path: string
  type: 'query' | 'mutation' | 'subscription'
  input: unknown
}

export type TrpcEnvelope = { ok: true; data: unknown } | { ok: false; message: string; code?: string }

export type TrpcInvoke = (op: TrpcOpWire) => Promise<TrpcEnvelope>

export function ipcLink(invoke: TrpcInvoke): TRPCLink<AppRouter> {
  return () =>
    ({ op }) =>
      observable((observer) => {
        invoke({ path: op.path, type: op.type, input: op.input }).then(
          (envelope) => {
            if (envelope.ok) {
              observer.next({ result: { data: envelope.data } })
              observer.complete()
            } else {
              observer.error(TRPCClientError.from(new Error(envelope.message)))
            }
          },
          (err) => observer.error(TRPCClientError.from(err as Error)),
        )
      })
}
```

- [ ] **Step 4: Run tests, expect green**

```bash
pnpm --filter @holi/desktop test > /tmp/t.log 2>&1; echo $?; tail -4 /tmp/t.log
```

- [ ] **Step 5: Rewrite `apps/desktop/src/preload/index.ts`**

```ts
import { contextBridge, ipcRenderer } from 'electron'

/** The ONE seam between renderer and main (architecture §8). */
contextBridge.exposeInMainWorld('holi', {
  trpc: (op: unknown) => ipcRenderer.invoke('holi:trpc', op),
  auth: {
    get: () => ipcRenderer.invoke('holi:auth:get'),
    signIn: () => ipcRenderer.invoke('holi:auth:signIn'),
    devSignIn: (token: string) => ipcRenderer.invoke('holi:auth:devSignIn', token),
    signOut: () => ipcRenderer.invoke('holi:auth:signOut'),
  },
  collabAuth: () => ipcRenderer.invoke('holi:collab:auth'),
})
```

- [ ] **Step 6: Rewrite `apps/desktop/src/renderer/src/global.d.ts`**

```ts
import type { TrpcEnvelope, TrpcOpWire } from './lib/ipc-link'

export interface PublicUser {
  userId: string
  email: string
  name: string | null
}

type AuthEnvelope = { ok: true; data: PublicUser } | { ok: false; message: string; code?: string }

declare global {
  interface Window {
    holi: {
      trpc(op: TrpcOpWire): Promise<TrpcEnvelope>
      auth: {
        get(): Promise<PublicUser | null>
        signIn(): Promise<AuthEnvelope>
        devSignIn(token: string): Promise<AuthEnvelope>
        signOut(): Promise<{ ok: boolean }>
      }
      collabAuth(): Promise<{ url: string; token: string } | null>
    }
  }
}

export {}
```

- [ ] **Step 7: Write `apps/desktop/src/renderer/src/lib/trpc.ts`**

```ts
import { createTRPCClient } from '@trpc/client'
import type { AppRouter } from '@holi/server/router'
import { ipcLink } from './ipc-link'

export const trpc = createTRPCClient<AppRouter>({
  links: [ipcLink((op) => window.holi.trpc(op))],
})
```

- [ ] **Step 8: Typecheck + commit**

```bash
pnpm --filter @holi/desktop typecheck; echo $?
git add apps/desktop/src/preload apps/desktop/src/renderer/src/global.d.ts apps/desktop/src/renderer/src/lib apps/desktop/test/ipc-link.test.ts
git commit -m "feat(desktop): preload bridge + typed tRPC-over-IPC link test-first

Claude goes brr.. via Dash"
```

---

## Task 7: Renderer — session state + sign-in screen + app gate

UI task (no unit tests — behavior verified end-to-end in Task 12).

**Files:**
- Create: `apps/desktop/src/renderer/src/state/session.ts`
- Create: `apps/desktop/src/renderer/src/components/SignIn.tsx`
- Rewrite: `apps/desktop/src/renderer/src/App.tsx`

- [ ] **Step 1: Write `apps/desktop/src/renderer/src/state/session.ts`**

```ts
import { atom } from 'jotai'
import type { PublicUser } from '../global'

/** null = signed out; undefined = not yet loaded. */
export const sessionAtom = atom<PublicUser | null | undefined>(undefined)

export const loadSessionAtom = atom(null, async (_get, set) => {
  set(sessionAtom, await window.holi.auth.get())
})

export const signOutAtom = atom(null, async (_get, set) => {
  await window.holi.auth.signOut()
  set(sessionAtom, null)
})
```

- [ ] **Step 2: Write `apps/desktop/src/renderer/src/components/SignIn.tsx`**

```tsx
import { useSetAtom } from 'jotai'
import { useState } from 'react'
import { sessionAtom } from '../state/session'

export function SignIn() {
  const setSession = useSetAtom(sessionAtom)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [devToken, setDevToken] = useState('')

  async function run(fn: () => Promise<Awaited<ReturnType<typeof window.holi.auth.signIn>>>) {
    setBusy(true)
    setError(null)
    const res = await fn()
    setBusy(false)
    if (res.ok) setSession(res.data)
    else setError(res.message)
  }

  return (
    <div className="flex h-screen flex-col items-center justify-center gap-4 bg-neutral-950 text-neutral-100">
      <h1 className="text-3xl font-semibold tracking-tight">Holi</h1>
      <button
        className="rounded bg-white px-4 py-2 text-sm font-medium text-neutral-900 hover:bg-neutral-200 disabled:opacity-50"
        disabled={busy}
        onClick={() => run(() => window.holi.auth.signIn())}
      >
        {busy ? 'Waiting for browser…' : 'Sign in with Google'}
      </button>
      {import.meta.env.DEV && (
        <form
          className="flex items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault()
            if (devToken.trim()) void run(() => window.holi.auth.devSignIn(devToken.trim()))
          }}
        >
          <input
            className="w-72 rounded border border-neutral-700 bg-neutral-900 px-2 py-1 text-xs"
            placeholder="dev session token (scripts/seed-dev.ts)"
            value={devToken}
            onChange={(e) => setDevToken(e.target.value)}
          />
          <button className="rounded bg-neutral-800 px-2 py-1 text-xs hover:bg-neutral-700" disabled={busy}>
            dev sign-in
          </button>
        </form>
      )}
      {error && <p className="max-w-md text-center text-xs text-red-400">{error}</p>}
    </div>
  )
}
```

- [ ] **Step 3: Rewrite `apps/desktop/src/renderer/src/App.tsx`**

```tsx
import { useAtomValue, useSetAtom } from 'jotai'
import { useEffect } from 'react'
import { SignIn } from './components/SignIn'
import { Shell } from './components/Shell'
import { loadSessionAtom, sessionAtom } from './state/session'

export function App() {
  const session = useAtomValue(sessionAtom)
  const loadSession = useSetAtom(loadSessionAtom)
  useEffect(() => {
    void loadSession()
  }, [loadSession])

  if (session === undefined) return null // loading keychain
  if (session === null) return <SignIn />
  return <Shell />
}
```

- [ ] **Step 4: Stub `apps/desktop/src/renderer/src/components/Shell.tsx`** (fleshed out in Tasks 8/11/12)

```tsx
import { useAtomValue, useSetAtom } from 'jotai'
import { sessionAtom, signOutAtom } from '../state/session'

export function Shell() {
  const session = useAtomValue(sessionAtom)
  const signOut = useSetAtom(signOutAtom)
  return (
    <div className="flex h-screen flex-col items-center justify-center gap-3 bg-neutral-950 text-neutral-100">
      <p className="text-sm">signed in as {session?.email}</p>
      <button className="rounded bg-neutral-800 px-3 py-1.5 text-sm hover:bg-neutral-700" onClick={() => void signOut()}>
        sign out
      </button>
    </div>
  )
}
```

- [ ] **Step 5: Typecheck + manual smoke + commit**

```bash
pnpm -r typecheck; echo $?
```

Manual smoke (requires server + Postgres up):

```bash
pnpm db:up
lsof -ti :4000 -ti :4444 | xargs kill 2>/dev/null
pnpm --filter @holi/server dev > /tmp/server.log 2>&1 &
sleep 3
pnpm --filter @holi/server exec tsx scripts/seed-dev.ts | tail -5   # note the token
pnpm --filter @holi/desktop dev > /tmp/desktop.log 2>&1 &
```

Expected: window shows the SignIn screen; pasting the seeded token into the dev field lands on "signed in as dev@syv.ai"; relaunching the app skips sign-in (keychain persistence); sign out returns to SignIn. Then kill the dev processes (`pkill -f "electron-vite dev"; lsof -ti :4000 -ti :4444 | xargs kill`).

```bash
git add apps/desktop/src/renderer
git commit -m "feat(desktop): sign-in screen + session gate — Google flow with dev-token fallback

Claude goes brr.. via Dash"
```

---

## Task 8: Renderer — vaults, file tree (TDD tree builder), note creation

**Files:**
- Create: `apps/desktop/src/renderer/src/lib/tree.ts`
- Create: `apps/desktop/src/renderer/src/state/vaults.ts`
- Create: `apps/desktop/src/renderer/src/components/FileTree.tsx`
- Test: `apps/desktop/test/tree.test.ts`

- [ ] **Step 1: Write the failing test `apps/desktop/test/tree.test.ts`**

```ts
import { describe, expect, it } from 'vitest'
import { buildTree, type TreeNode } from '../src/renderer/src/lib/tree'

const doc = (id: string, path: string) => ({ id, path })
const folder = (id: string, path: string) => ({ id, path })

function names(nodes: TreeNode[]): string[] {
  return nodes.map((n) => (n.kind === 'folder' ? `${n.name}/` : n.name))
}

describe('buildTree', () => {
  it('nests docs under their folders, folders first, alphabetical', () => {
    const tree = buildTree(
      [doc('d1', 'zebra.md'), doc('d2', 'projects/q2/plan.md'), doc('d3', 'alpha.md')],
      [folder('f1', 'projects'), folder('f2', 'projects/q2')],
    )
    expect(names(tree)).toEqual(['projects/', 'alpha.md', 'zebra.md'])
    const projects = tree[0]!
    if (projects.kind !== 'folder') throw new Error('expected folder')
    expect(names(projects.children)).toEqual(['q2/'])
    const q2 = projects.children[0]!
    if (q2.kind !== 'folder') throw new Error('expected folder')
    expect(names(q2.children)).toEqual(['plan.md'])
    expect(q2.children[0]).toMatchObject({ kind: 'doc', docId: 'd2', path: 'projects/q2/plan.md' })
  })

  it('synthesizes folder nodes missing an identity row (doc deeper than known folders)', () => {
    const tree = buildTree([doc('d1', 'a/b/c.md')], [])
    expect(names(tree)).toEqual(['a/'])
    const a = tree[0]!
    if (a.kind !== 'folder') throw new Error('expected folder')
    expect(names(a.children)).toEqual(['b/'])
  })

  it('hides Holi-managed root entries by default (D6)', () => {
    const tree = buildTree(
      [doc('d1', 'AGENTS.md'), doc('d2', 'MEMORY.md'), doc('d3', '.holi/settings.json'), doc('d4', 'real.md')],
      [folder('f1', '.claude'), folder('f2', '.holi')],
    )
    expect(names(tree)).toEqual(['real.md'])
  })
})
```

- [ ] **Step 2: Run to verify failure**

```bash
pnpm --filter @holi/desktop test test/tree.test.ts > /tmp/t.log 2>&1; echo $?; tail -3 /tmp/t.log
```

Expected: FAIL — module missing.

- [ ] **Step 3: Write `apps/desktop/src/renderer/src/lib/tree.ts`**

```ts
/**
 * File tree from SERVER METADATA — never a disk scan (vaults-collab PRD
 * §Folder hierarchy). Folder identity rows carry stable IDs (D27); folders
 * that exist only as doc-path prefixes get synthesized nodes (id null).
 */

export interface TreeDocInput {
  id: string
  path: string
}
export interface TreeFolderInput {
  id: string
  path: string
}

export type TreeNode =
  | { kind: 'folder'; name: string; path: string; folderId: string | null; children: TreeNode[] }
  | { kind: 'doc'; name: string; path: string; docId: string }

/** Vault-managed roots hidden from the tree by default (D6). */
const HIDDEN_ROOTS = new Set(['.claude', '.holi', 'AGENTS.md', 'MEMORY.md', 'CLAUDE.md'])

export function buildTree(docs: TreeDocInput[], folders: TreeFolderInput[]): TreeNode[] {
  const folderIds = new Map(folders.map((f) => [f.path, f.id]))
  const roots: TreeNode[] = []
  const folderNodes = new Map<string, Extract<TreeNode, { kind: 'folder' }>>()

  function ensureFolder(path: string): Extract<TreeNode, { kind: 'folder' }> {
    const existing = folderNodes.get(path)
    if (existing) return existing
    const name = path.split('/').at(-1)!
    const node: Extract<TreeNode, { kind: 'folder' }> = {
      kind: 'folder',
      name,
      path,
      folderId: folderIds.get(path) ?? null,
      children: [],
    }
    folderNodes.set(path, node)
    const parent = path.includes('/') ? ensureFolder(path.slice(0, path.lastIndexOf('/'))) : null
    ;(parent ? parent.children : roots).push(node)
    return node
  }

  for (const f of folders) ensureFolder(f.path)
  for (const d of docs) {
    const slash = d.path.lastIndexOf('/')
    const parent = slash === -1 ? null : ensureFolder(d.path.slice(0, slash))
    const node: TreeNode = { kind: 'doc', name: d.path.slice(slash + 1), path: d.path, docId: d.id }
    ;(parent ? parent.children : roots).push(node)
  }

  sortLevel(roots)
  for (const f of folderNodes.values()) sortLevel(f.children)
  return roots.filter((n) => !HIDDEN_ROOTS.has(n.name))
}

function sortLevel(nodes: TreeNode[]): void {
  nodes.sort((a, b) =>
    a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'folder' ? -1 : 1,
  )
}
```

- [ ] **Step 4: Run tests, expect green**

```bash
pnpm --filter @holi/desktop test > /tmp/t.log 2>&1; echo $?; tail -4 /tmp/t.log
```

- [ ] **Step 5: Write `apps/desktop/src/renderer/src/state/vaults.ts`**

```ts
import { atom } from 'jotai'
import type { DocMeta, Folder, Vault } from '@holi/shared'
import { trpc } from '../lib/trpc'

export const vaultsAtom = atom<Vault[]>([])
export const activeVaultIdAtom = atom<string | null>(null)
export const docsAtom = atom<{ docs: DocMeta[]; folders: Folder[] }>({ docs: [], folders: [] })
/** The doc open in the editor. */
export const activeDocAtom = atom<DocMeta | null>(null)

export const loadVaultsAtom = atom(null, async (get, set) => {
  const vaults = await trpc.vaults.list.query()
  set(vaultsAtom, vaults)
  const active = get(activeVaultIdAtom)
  if (!active && vaults[0]) set(activeVaultIdAtom, vaults[0].id)
})

export const loadDocsAtom = atom(null, async (get, set) => {
  const vaultId = get(activeVaultIdAtom)
  if (!vaultId) return
  set(docsAtom, await trpc.vaults.listDocs.query({ vaultId }))
})

export const createNoteAtom = atom(null, async (get, set, path: string) => {
  const vaultId = get(activeVaultIdAtom)
  if (!vaultId) return
  const doc = await trpc.notes.create.mutate({ vaultId, path, kind: 'note' })
  await set(loadDocsAtom) // refetch (no subscriptions this phase — plan decision #5)
  set(activeDocAtom, doc)
})

export const createVaultAtom = atom(null, async (_get, set, name: string) => {
  const vault = await trpc.vaults.create.mutate({ name, kind: 'shared' })
  await set(loadVaultsAtom)
  set(activeVaultIdAtom, vault.id)
})
```

- [ ] **Step 6: Write `apps/desktop/src/renderer/src/components/FileTree.tsx`**

```tsx
import { useAtomValue, useSetAtom } from 'jotai'
import { useMemo, useState } from 'react'
import { buildTree, type TreeNode } from '../lib/tree'
import { activeDocAtom, createNoteAtom, docsAtom } from '../state/vaults'

export function FileTree() {
  const { docs, folders } = useAtomValue(docsAtom)
  const tree = useMemo(() => buildTree(docs, folders), [docs, folders])
  const createNote = useSetAtom(createNoteAtom)
  const [newPath, setNewPath] = useState('')

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <form
        className="flex gap-1 p-2"
        onSubmit={(e) => {
          e.preventDefault()
          const path = newPath.trim()
          if (path) {
            void createNote(path.endsWith('.md') ? path : `${path}.md`)
            setNewPath('')
          }
        }}
      >
        <input
          className="min-w-0 flex-1 rounded border border-neutral-800 bg-neutral-900 px-2 py-1 text-xs"
          placeholder="new note path…"
          value={newPath}
          onChange={(e) => setNewPath(e.target.value)}
        />
        <button className="rounded bg-neutral-800 px-2 text-xs hover:bg-neutral-700">+</button>
      </form>
      <div className="min-h-0 flex-1 overflow-y-auto px-1 pb-2 text-sm">
        {tree.map((node) => (
          <TreeRow key={node.path} node={node} depth={0} />
        ))}
        {tree.length === 0 && <p className="px-2 text-xs text-neutral-500">no notes yet</p>}
      </div>
    </div>
  )
}

function TreeRow({ node, depth }: { node: TreeNode; depth: number }) {
  const setActiveDoc = useSetAtom(activeDocAtom)
  const { docs } = useAtomValue(docsAtom)
  const [open, setOpen] = useState(true)
  const pad = { paddingLeft: `${depth * 12 + 8}px` }

  if (node.kind === 'folder') {
    return (
      <div>
        <button
          className="block w-full truncate rounded px-1 py-0.5 text-left text-neutral-400 hover:bg-neutral-900"
          style={pad}
          onClick={() => setOpen((o) => !o)}
        >
          {open ? '▾' : '▸'} {node.name}
        </button>
        {open && node.children.map((c) => <TreeRow key={c.path} node={c} depth={depth + 1} />)}
      </div>
    )
  }
  return (
    <button
      className="block w-full truncate rounded px-1 py-0.5 text-left hover:bg-neutral-900"
      style={pad}
      onClick={() => {
        const doc = docs.find((d) => d.id === node.docId)
        if (doc) setActiveDoc(doc)
      }}
    >
      {node.name}
    </button>
  )
}
```

- [ ] **Step 7: Typecheck + commit**

```bash
pnpm -r typecheck; echo $?
git add apps/desktop/src/renderer apps/desktop/test/tree.test.ts
git commit -m "feat(desktop): vault state + server-metadata file tree test-first + note creation

Claude goes brr.. via Dash"
```

---

## Task 9: Editor — toggle-aware formatting hotkeys (TDD)

**Files:**
- Create: `apps/desktop/src/renderer/src/editor/formatting.ts`
- Test: `apps/desktop/test/formatting.test.ts`

- [ ] **Step 1: Write the failing test `apps/desktop/test/formatting.test.ts`**

```ts
import { EditorSelection, EditorState } from '@codemirror/state'
import { describe, expect, it } from 'vitest'
import { toggleInline, toggleLink } from '../src/renderer/src/editor/formatting'

function state(doc: string, anchor: number, head = anchor) {
  return EditorState.create({ doc, selection: EditorSelection.single(anchor, head) })
}

function apply(s: EditorState, spec: ReturnType<typeof toggleInline>) {
  if (!spec) throw new Error('expected a transaction spec')
  return s.update(spec).state
}

describe('toggleInline (FR-3: toggle-aware wrap/unwrap)', () => {
  it('wraps a selection in ** and places the selection inside', () => {
    const next = apply(state('hello world', 0, 5), toggleInline(state('hello world', 0, 5), '**'))
    expect(next.doc.toString()).toBe('**hello** world')
    expect(next.sliceDoc(next.selection.main.from, next.selection.main.to)).toBe('hello')
  })

  it('unwraps when the selection is already surrounded', () => {
    const s = state('**hello** world', 2, 7) // selection = hello
    const next = apply(s, toggleInline(s, '**'))
    expect(next.doc.toString()).toBe('hello world')
  })

  it('unwraps when the selection includes the markers', () => {
    const s = state('**hello** world', 0, 9)
    const next = apply(s, toggleInline(s, '**'))
    expect(next.doc.toString()).toBe('hello world')
  })

  it('expands an empty selection to the word under the caret', () => {
    const s = state('hello world', 2)
    const next = apply(s, toggleInline(s, '*'))
    expect(next.doc.toString()).toBe('*hello* world')
  })

  it('returns null on an empty selection not inside a word', () => {
    expect(toggleInline(state('a  b', 2), '*')).toBeNull()
  })
})

describe('toggleLink (⌘K)', () => {
  it('wraps the selection as [sel](url) with the url selected', () => {
    const s = state('see docs here', 4, 8)
    const next = apply(s, toggleLink(s))
    expect(next.doc.toString()).toBe('see [docs](url) here')
    expect(next.sliceDoc(next.selection.main.from, next.selection.main.to)).toBe('url')
  })
})
```

- [ ] **Step 2: Run to verify failure**

```bash
pnpm --filter @holi/desktop test test/formatting.test.ts > /tmp/t.log 2>&1; echo $?; tail -3 /tmp/t.log
```

Expected: FAIL — module missing.

- [ ] **Step 3: Write `apps/desktop/src/renderer/src/editor/formatting.ts`**

```ts
/**
 * Toggle-aware inline formatting (notes-editor PRD FR-3). Pure functions over
 * EditorState → TransactionSpec so they are headless-testable; the keymap
 * wraps them as commands. Edits flow through the normal transaction path, so
 * the Yjs binding syncs them like any keystroke.
 */
import type { EditorState, TransactionSpec } from '@codemirror/state'
import { keymap } from '@codemirror/view'

export function toggleInline(state: EditorState, marker: string): TransactionSpec | null {
  const sel = state.selection.main
  let { from, to } = sel
  if (from === to) {
    const word = state.wordAt(from)
    if (!word) return null
    from = word.from
    to = word.to
  }
  const len = marker.length
  const before = state.sliceDoc(Math.max(0, from - len), from)
  const after = state.sliceDoc(to, Math.min(state.doc.length, to + len))
  const inner = state.sliceDoc(from, to)

  if (before === marker && after === marker) {
    // **|hello|** → strip surrounding markers
    return {
      changes: [
        { from: from - len, to: from },
        { from: to, to: to + len },
      ],
      selection: { anchor: from - len, head: to - len },
    }
  }
  if (inner.startsWith(marker) && inner.endsWith(marker) && inner.length >= 2 * len) {
    // |**hello**| → strip markers inside the selection
    return {
      changes: { from, to, insert: inner.slice(len, inner.length - len) },
      selection: { anchor: from, head: to - 2 * len },
    }
  }
  return {
    changes: [
      { from, insert: marker },
      { from: to, insert: marker },
    ],
    selection: { anchor: from + len, head: to + len },
  }
}

export function toggleLink(state: EditorState): TransactionSpec | null {
  const sel = state.selection.main
  if (sel.empty) return null
  const text = state.sliceDoc(sel.from, sel.to)
  const insert = `[${text}](url)`
  const urlStart = sel.from + text.length + 3 // past "[text]("
  return {
    changes: { from: sel.from, to: sel.to, insert },
    selection: { anchor: urlStart, head: urlStart + 3 },
  }
}

function run(marker: string) {
  return (view: { state: EditorState; dispatch(spec: TransactionSpec): void }): boolean => {
    const spec = toggleInline(view.state, marker)
    if (!spec) return false
    view.dispatch(spec)
    return true
  }
}

/** ⌘/Ctrl-B bold, ⌘I italic, ⌘E inline code, ⌘K link, ⌘⇧X strikethrough. */
export const formattingKeymap = keymap.of([
  { key: 'Mod-b', run: run('**') },
  { key: 'Mod-i', run: run('*') },
  { key: 'Mod-e', run: run('`') },
  { key: 'Mod-Shift-x', run: run('~~') },
  {
    key: 'Mod-k',
    run: (view) => {
      const spec = toggleLink(view.state)
      if (!spec) return false
      view.dispatch(spec)
      return true
    },
  },
])
```

- [ ] **Step 4: Run tests, expect green, commit**

```bash
pnpm --filter @holi/desktop test > /tmp/t.log 2>&1; echo $?; tail -4 /tmp/t.log
git add apps/desktop/src/renderer/src/editor/formatting.ts apps/desktop/test/formatting.test.ts
git commit -m "feat(desktop): toggle-aware formatting hotkeys test-first (FR-3)

Claude goes brr.. via Dash"
```

---

## Task 10: Editor — simplified live preview + wiki-link chips (TDD builder)

The D22 model: decorations are a pure function of `(syntax tree, selection)`. Lines touched by the selection render **raw** (no concealing decorations); everything else renders. No animation, no frozen caret.

**Files:**
- Create: `apps/desktop/src/renderer/src/editor/livePreview.ts`
- Create: `apps/desktop/src/renderer/src/editor/wikiLinkChips.ts`
- Create: `apps/desktop/src/renderer/src/editor/theme.ts`
- Create: `apps/desktop/src/renderer/src/editor/extensions.ts`
- Test: `apps/desktop/test/live-preview.test.ts`

- [ ] **Step 1: Write the failing test `apps/desktop/test/live-preview.test.ts`**

```ts
import { markdown } from '@codemirror/lang-markdown'
import { ensureSyntaxTree } from '@codemirror/language'
import { EditorSelection, EditorState } from '@codemirror/state'
import type { DecorationSet } from '@codemirror/view'
import { describe, expect, it } from 'vitest'
import { buildDecorations } from '../src/renderer/src/editor/livePreview'

function stateFor(doc: string, cursor = 0) {
  const state = EditorState.create({
    doc,
    selection: EditorSelection.single(cursor),
    extensions: [markdown()],
  })
  ensureSyntaxTree(state, state.doc.length, 5_000)
  return state
}

function specs(set: DecorationSet): { from: number; to: number; spec: Record<string, unknown> }[] {
  const out: { from: number; to: number; spec: Record<string, unknown> }[] = []
  const iter = set.iter()
  while (iter.value) {
    out.push({ from: iter.from, to: iter.to, spec: iter.value.spec as Record<string, unknown> })
    iter.next()
  }
  return out
}

describe('buildDecorations (D22: plain decoration swap)', () => {
  it('conceals heading marks on inactive lines', () => {
    const state = stateFor('# Title\n\nbody text', 12) // caret in body
    const decos = specs(buildDecorations(state, 0, state.doc.length))
    // the "# " HeaderMark (0-2) is concealed
    expect(decos.some((d) => d.from === 0 && d.to === 2)).toBe(true)
  })

  it('reveals raw source on the active line', () => {
    const state = stateFor('# Title\n\nbody text', 3) // caret inside the heading
    const decos = specs(buildDecorations(state, 0, state.doc.length))
    expect(decos.some((d) => d.from === 0 && d.to === 2)).toBe(false)
  })

  it('conceals ** markers around strong text on inactive lines', () => {
    const doc = 'plain\nsome **bold** here'
    const state = stateFor(doc, 0)
    const decos = specs(buildDecorations(state, 0, doc.length))
    const boldStart = doc.indexOf('**')
    expect(decos.some((d) => d.from === boldStart && d.to === boldStart + 2)).toBe(true)
  })

  it('replaces an inactive [[wiki link]] with a chip widget', () => {
    const doc = 'first\nsee [[notes/plan.md]] ok'
    const state = stateFor(doc, 0)
    const decos = specs(buildDecorations(state, 0, doc.length))
    const start = doc.indexOf('[[')
    const end = doc.indexOf(']]') + 2
    const chip = decos.find((d) => d.from === start && d.to === end)
    expect(chip).toBeDefined()
    expect(chip?.spec['widget']).toBeDefined()
  })

  it('reveals the raw [[wiki link]] when the caret is inside it', () => {
    const doc = 'see [[notes/plan.md]] ok'
    const state = stateFor(doc, 8)
    const decos = specs(buildDecorations(state, 0, doc.length))
    expect(decos.some((d) => (d.spec['widget'] as unknown) !== undefined)).toBe(false)
  })
})
```

- [ ] **Step 2: Run to verify failure**

```bash
pnpm --filter @holi/desktop test test/live-preview.test.ts > /tmp/t.log 2>&1; echo $?; tail -3 /tmp/t.log
```

Expected: FAIL — module missing.

- [ ] **Step 3: Write `apps/desktop/src/renderer/src/editor/wikiLinkChips.ts`**

```ts
import { WidgetType } from '@codemirror/view'

/** Inline chip for [[path]] / [[path|Label]] (notes-editor PRD FR-6, core set). */
export class WikiLinkChip extends WidgetType {
  constructor(
    readonly target: string,
    readonly label: string | undefined,
    readonly exists: boolean,
  ) {
    super()
  }

  override eq(other: WikiLinkChip): boolean {
    return other.target === this.target && other.label === this.label && other.exists === this.exists
  }

  override toDOM(): HTMLElement {
    const el = document.createElement('span')
    el.className = `cm-wikilink${this.exists ? '' : ' cm-wikilink-missing'}`
    el.textContent = this.label ?? this.target
    el.dataset['wikiTarget'] = this.target
    return el
  }

  override ignoreEvent(): boolean {
    return false // clicks bubble to the editor's click handler (open target)
  }
}
```

- [ ] **Step 4: Write `apps/desktop/src/renderer/src/editor/livePreview.ts`**

```ts
/**
 * Simplified live preview (D22): a pure decoration builder over the syntax
 * tree + wiki-link grammar. Lines the selection touches render RAW (no
 * concealing decorations there); everything else renders. Rebuilds on
 * docChanged/selectionSet/viewport — a plain recompute, no animation.
 */
import { syntaxTree } from '@codemirror/language'
import { Facet, RangeSetBuilder, type EditorState } from '@codemirror/state'
import {
  Decoration,
  EditorView,
  ViewPlugin,
  WidgetType,
  type DecorationSet,
  type ViewUpdate,
} from '@codemirror/view'
import { parseWikiLinks } from '@holi/shared'
import { WikiLinkChip } from './wikiLinkChips'

/** Doc-path existence lookup for chip styling; wired from server metadata. */
export const docExistsFacet = Facet.define<(path: string) => boolean, (path: string) => boolean>({
  combine: (values) => values[0] ?? (() => true),
})

const conceal = Decoration.replace({})
const strong = Decoration.mark({ class: 'cm-strong' })
const emphasis = Decoration.mark({ class: 'cm-emphasis' })
const strike = Decoration.mark({ class: 'cm-strikethrough' })
const inlineCode = Decoration.mark({ class: 'cm-inline-code' })
const quoteMark = Decoration.mark({ class: 'cm-quote-mark' })
const linkText = Decoration.mark({ class: 'cm-md-link' })
const headingLine = (level: number) => Decoration.line({ class: `cm-heading cm-heading-${level}` })
const codeLine = Decoration.line({ class: 'cm-code-line' })

class HrWidget extends WidgetType {
  override toDOM(): HTMLElement {
    const el = document.createElement('div')
    el.className = 'cm-hr'
    return el
  }
}

/** Line numbers (1-based) the primary selection touches — these render raw. */
export function activeLines(state: EditorState): Set<number> {
  const lines = new Set<number>()
  const sel = state.selection.main
  const fromLine = state.doc.lineAt(sel.from).number
  const toLine = state.doc.lineAt(sel.to).number
  for (let n = fromLine; n <= toLine; n++) lines.add(n)
  return lines
}

export function buildDecorations(state: EditorState, from: number, to: number): DecorationSet {
  const active = activeLines(state)
  const isActive = (pos: number) => active.has(state.doc.lineAt(pos).number)
  // Collect first (tree iteration + regex scan), sort, then feed the builder
  const ranges: { from: number; to: number; deco: Decoration }[] = []

  syntaxTree(state).iterate({
    from,
    to,
    enter(node) {
      const activeHere = isActive(node.from)
      switch (node.name) {
        case 'ATXHeading1':
        case 'ATXHeading2':
        case 'ATXHeading3':
        case 'ATXHeading4':
        case 'ATXHeading5':
        case 'ATXHeading6': {
          const level = Number(node.name.slice('ATXHeading'.length))
          const line = state.doc.lineAt(node.from)
          ranges.push({ from: line.from, to: line.from, deco: headingLine(level) })
          break
        }
        case 'HeaderMark': {
          // conceal "# " (mark + the following space) on inactive lines
          if (!activeHere) {
            const end = state.sliceDoc(node.to, node.to + 1) === ' ' ? node.to + 1 : node.to
            ranges.push({ from: node.from, to: end, deco: conceal })
          }
          break
        }
        case 'StrongEmphasis':
          ranges.push({ from: node.from, to: node.to, deco: strong })
          if (!activeHere) {
            ranges.push({ from: node.from, to: node.from + 2, deco: conceal })
            ranges.push({ from: node.to - 2, to: node.to, deco: conceal })
          }
          break
        case 'Emphasis':
          ranges.push({ from: node.from, to: node.to, deco: emphasis })
          if (!activeHere) {
            ranges.push({ from: node.from, to: node.from + 1, deco: conceal })
            ranges.push({ from: node.to - 1, to: node.to, deco: conceal })
          }
          break
        case 'Strikethrough':
          ranges.push({ from: node.from, to: node.to, deco: strike })
          if (!activeHere) {
            ranges.push({ from: node.from, to: node.from + 2, deco: conceal })
            ranges.push({ from: node.to - 2, to: node.to, deco: conceal })
          }
          break
        case 'InlineCode':
          ranges.push({ from: node.from, to: node.to, deco: inlineCode })
          if (!activeHere) {
            ranges.push({ from: node.from, to: node.from + 1, deco: conceal })
            ranges.push({ from: node.to - 1, to: node.to, deco: conceal })
          }
          break
        case 'FencedCode': {
          const first = state.doc.lineAt(node.from).number
          const last = state.doc.lineAt(node.to).number
          for (let n = first; n <= last; n++) {
            const line = state.doc.line(n)
            ranges.push({ from: line.from, to: line.from, deco: codeLine })
          }
          break
        }
        case 'QuoteMark':
          ranges.push({ from: node.from, to: node.to, deco: quoteMark })
          break
        case 'HorizontalRule':
          if (!activeHere) {
            ranges.push({ from: node.from, to: node.to, deco: Decoration.replace({ widget: new HrWidget() }) })
          }
          break
        case 'Link': {
          // [text](url) → conceal "[", "](url)" ; style text
          const text = state.sliceDoc(node.from, node.to)
          const close = text.indexOf('](')
          if (close !== -1 && text.endsWith(')')) {
            const url = text.slice(close + 2, -1)
            ranges.push({
              from: node.from + 1,
              to: node.from + close,
              deco: Decoration.mark({ class: 'cm-md-link', attributes: { 'data-href': url } }),
            })
            if (!activeHere) {
              ranges.push({ from: node.from, to: node.from + 1, deco: conceal })
              ranges.push({ from: node.from + close, to: node.to, deco: conceal })
            }
          } else {
            ranges.push({ from: node.from, to: node.to, deco: linkText })
          }
          break
        }
      }
    },
  })

  // wiki-links via the shared grammar (not part of the markdown tree)
  const docExists = state.facet(docExistsFacet)
  const visible = state.sliceDoc(from, to)
  for (const link of parseWikiLinks(visible)) {
    if (link.kind !== 'note') continue
    const start = from + link.start
    const end = from + link.end
    if (isActive(start)) continue
    ranges.push({
      from: start,
      to: end,
      deco: Decoration.replace({ widget: new WikiLinkChip(link.target, link.label, docExists(link.target)) }),
    })
  }

  ranges.sort((a, b) => a.from - b.from || a.to - b.to || (a.deco.spec.widget ? 1 : -1))
  const builder = new RangeSetBuilder<Decoration>()
  for (const r of ranges) builder.add(r.from, r.to, r.deco)
  return builder.finish()
}

export const livePreview = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet

    constructor(readonly view: EditorView) {
      this.decorations = this.build()
    }

    update(update: ViewUpdate): void {
      if (update.docChanged || update.selectionSet || update.viewportChanged) {
        this.decorations = this.build()
      }
    }

    private build(): DecorationSet {
      // visible ranges only (PRD §reveal logic: performance)
      const sets: DecorationSet[] = []
      for (const range of this.view.visibleRanges) {
        sets.push(buildDecorations(this.view.state, range.from, range.to))
      }
      return sets.length === 1 ? sets[0]! : joinSets(sets)
    }
  },
  { decorations: (v) => v.decorations },
)

function joinSets(sets: DecorationSet[]): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>()
  for (const set of sets) {
    const iter = set.iter()
    while (iter.value) {
      builder.add(iter.from, iter.to, iter.value)
      iter.next()
    }
  }
  return builder.finish()
}
```

- [ ] **Step 5: Run tests — iterate until green**

```bash
pnpm --filter @holi/desktop test test/live-preview.test.ts > /tmp/t.log 2>&1; echo $?; tail -10 /tmp/t.log
```

Common failures and fixes: overlapping replace ranges throw in `RangeSetBuilder` (ensure the sort orders correctly and skip a conceal fully inside another conceal); lezer node names differ by version (`console.log` the tree with `syntaxTree(state).toString()` if a case never fires).

- [ ] **Step 6: Write `apps/desktop/src/renderer/src/editor/theme.ts`**

Tight vertical rhythm per PRD FR-3b — rendered blocks stay close to raw-line height:

```ts
import { EditorView } from '@codemirror/view'

export const editorTheme = EditorView.baseTheme({
  '&': { height: '100%', fontSize: '14px' },
  '.cm-scroller': { fontFamily: 'ui-monospace, SF Mono, monospace', lineHeight: '1.6' },
  '.cm-content': { padding: '16px 0', maxWidth: '48rem', margin: '0 auto', caretColor: '#e5e5e5' },

  // headings: size only — no extra margins, so render/un-render doesn't jump (FR-3b)
  '.cm-heading': { fontWeight: '600' },
  '.cm-heading-1': { fontSize: '1.5em' },
  '.cm-heading-2': { fontSize: '1.25em' },
  '.cm-heading-3': { fontSize: '1.1em' },

  '.cm-strong': { fontWeight: '700' },
  '.cm-emphasis': { fontStyle: 'italic' },
  '.cm-strikethrough': { textDecoration: 'line-through' },
  '.cm-inline-code': {
    background: 'rgba(255,255,255,0.08)',
    borderRadius: '3px',
    padding: '0 3px',
  },
  '.cm-code-line': { background: 'rgba(255,255,255,0.04)' },
  '.cm-quote-mark': { color: '#737373' },
  '.cm-md-link': { color: '#7dd3fc', textDecoration: 'underline', cursor: 'pointer' },

  // compact HR (FR-3b: thin rule, minimal margins — not a chunky block)
  '.cm-hr': {
    borderTop: '1px solid #404040',
    margin: '0.3em 0',
    height: '1px',
  },

  '.cm-wikilink': {
    background: 'rgba(125,211,252,0.12)',
    color: '#7dd3fc',
    borderRadius: '4px',
    padding: '0 4px',
    cursor: 'pointer',
  },
  '.cm-wikilink-missing': { color: '#f0abfc', background: 'rgba(240,171,252,0.10)' },

  // remote cursors (y-codemirror.next)
  '.cm-ySelectionInfo': { fontSize: '10px', padding: '0 3px', borderRadius: '3px' },
})
```

- [ ] **Step 7: Write `apps/desktop/src/renderer/src/editor/extensions.ts`**

```ts
import { markdown } from '@codemirror/lang-markdown'
import { bracketMatching, indentOnInput, indentUnit } from '@codemirror/language'
import { drawSelection, dropCursor, EditorView, keymap } from '@codemirror/view'
import { defaultKeymap, indentWithTab } from '@codemirror/commands'
import type { Extension } from '@codemirror/state'
import { formattingKeymap } from './formatting'
import { docExistsFacet, livePreview } from './livePreview'
import { editorTheme } from './theme'

/** The trimmed stack (notes-editor PRD FR-1) minus what other tasks add
 * (yCollab arrives per-doc in EditorPane). CM history is intentionally absent
 * — Y.UndoManager owns undo (FR-4). */
export function baseEditorExtensions(docExists: (path: string) => boolean): Extension[] {
  return [
    drawSelection(),
    dropCursor(),
    indentOnInput(),
    bracketMatching(),
    indentUnit.of('    '),
    EditorView.lineWrapping,
    markdown(),
    docExistsFacet.of(docExists),
    livePreview,
    formattingKeymap,
    keymap.of([...defaultKeymap, indentWithTab]),
    editorTheme,
  ]
}
```

- [ ] **Step 8: Full test run + typecheck + commit**

```bash
pnpm --filter @holi/desktop test > /tmp/t.log 2>&1; echo $?; tail -4 /tmp/t.log
pnpm --filter @holi/desktop typecheck; echo $?
git add apps/desktop/src/renderer/src/editor apps/desktop/test/live-preview.test.ts
git commit -m "feat(desktop): simplified live preview + wiki-link chips test-first (D22 — no morph)

Claude goes brr.. via Dash"
```

---

## Task 11: Collab — Hocuspocus provider, sync status, editor pane

**Files:**
- Create: `apps/desktop/src/renderer/src/state/sync.ts`
- Create: `apps/desktop/src/renderer/src/collab/provider.ts`
- Create: `apps/desktop/src/renderer/src/components/EditorPane.tsx`

- [ ] **Step 1: Write `apps/desktop/src/renderer/src/state/sync.ts`**

```ts
import { atom } from 'jotai'
import type { SyncStatus } from '@holi/shared'

/** The only offline UI (D21): synced | syncing | offline. Never a dialog. */
export const syncStatusAtom = atom<SyncStatus>('offline')
```

- [ ] **Step 2: Write `apps/desktop/src/renderer/src/collab/provider.ts`**

```ts
/**
 * Per-doc collab session: Y.Doc + HocuspocusProvider (room name = docId,
 * server-data PRD §Yjs persistence). Credentials come from main per
 * connection and live only in this closure (plan decision #1).
 */
import { HocuspocusProvider } from '@hocuspocus/provider'
import * as Y from 'yjs'
import { YDOC_TEXT_KEY } from '@holi/shared'
import type { SyncStatus } from '@holi/shared'

export interface DocSession {
  ydoc: Y.Doc
  text: Y.Text
  provider: HocuspocusProvider
  destroy(): void
}

export async function openDoc(docId: string, onStatus: (s: SyncStatus) => void): Promise<DocSession> {
  const auth = await window.holi.collabAuth()
  if (!auth) throw new Error('not signed in')
  const ydoc = new Y.Doc()
  onStatus('syncing')
  const provider = new HocuspocusProvider({
    url: auth.url,
    name: docId,
    token: auth.token,
    document: ydoc,
    onSynced: () => onStatus('synced'),
    onDisconnect: () => onStatus('offline'),
    onStatus: ({ status }) => {
      if (status === 'connecting') onStatus('syncing')
    },
  })
  return {
    ydoc,
    text: ydoc.getText(YDOC_TEXT_KEY),
    provider,
    destroy() {
      provider.destroy()
      ydoc.destroy()
    },
  }
}

/** Deterministic presence color per user (D20). */
export function presenceColor(userId: string): string {
  const palette = ['#f97316', '#22d3ee', '#a3e635', '#e879f9', '#facc15', '#38bdf8', '#fb7185', '#4ade80']
  let hash = 0
  for (const ch of userId) hash = (hash * 31 + ch.charCodeAt(0)) | 0
  return palette[Math.abs(hash) % palette.length]!
}
```

- [ ] **Step 3: Write `apps/desktop/src/renderer/src/components/EditorPane.tsx`**

```tsx
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { useAtomValue, useSetAtom } from 'jotai'
import { useEffect, useRef } from 'react'
import { yCollab } from 'y-codemirror.next'
import * as Y from 'yjs'
import { openDoc, presenceColor } from '../collab/provider'
import { baseEditorExtensions } from '../editor/extensions'
import { sessionAtom } from '../state/session'
import { syncStatusAtom } from '../state/sync'
import { activeDocAtom, docsAtom } from '../state/vaults'

export function EditorPane() {
  const activeDoc = useAtomValue(activeDocAtom)
  const session = useAtomValue(sessionAtom)
  const { docs } = useAtomValue(docsAtom)
  const setSyncStatus = useSetAtom(syncStatusAtom)
  const hostRef = useRef<HTMLDivElement>(null)
  const docPaths = useRef(new Set<string>())
  docPaths.current = new Set(docs.map((d) => d.path))

  useEffect(() => {
    if (!activeDoc || !hostRef.current || !session) return
    let disposed = false
    let view: EditorView | null = null
    let sessionHandle: Awaited<ReturnType<typeof openDoc>> | null = null

    void openDoc(activeDoc.id, setSyncStatus).then((handle) => {
      if (disposed) {
        handle.destroy()
        return
      }
      sessionHandle = handle
      handle.provider.setAwarenessField('user', {
        name: session.name ?? session.email,
        color: presenceColor(session.userId),
      })
      const undoManager = new Y.UndoManager(handle.text)
      view = new EditorView({
        state: EditorState.create({
          doc: handle.text.toString(),
          extensions: [
            ...baseEditorExtensions((path) => docPaths.current.has(path)),
            // provider.awareness is typed nullable in v2 but always set with a document
            yCollab(handle.text, handle.provider.awareness!, { undoManager }),
          ],
        }),
        parent: hostRef.current!,
      })
      view.focus()
    })

    return () => {
      disposed = true
      view?.destroy()
      sessionHandle?.destroy()
      setSyncStatus('offline')
    }
  }, [activeDoc, session, setSyncStatus])

  if (!activeDoc) {
    return (
      <div className="flex flex-1 items-center justify-center text-sm text-neutral-500">
        select or create a note
      </div>
    )
  }
  return <div ref={hostRef} className="min-w-0 flex-1 overflow-hidden" />
}
```

- [ ] **Step 4: Typecheck + commit**

```bash
pnpm -r typecheck; echo $?
git add apps/desktop/src/renderer/src/state/sync.ts apps/desktop/src/renderer/src/collab apps/desktop/src/renderer/src/components/EditorPane.tsx
git commit -m "feat(desktop): Hocuspocus doc sessions + yCollab editor pane + sync status

Claude goes brr.. via Dash"
```

---

## Task 12: Shell assembly, end-to-end verify, docs

**Files:**
- Rewrite: `apps/desktop/src/renderer/src/components/Shell.tsx`
- Modify: `docs/prd/auth-identity.md` (implementation note)

- [ ] **Step 1: Rewrite `apps/desktop/src/renderer/src/components/Shell.tsx`**

```tsx
import { useAtom, useAtomValue, useSetAtom } from 'jotai'
import { useEffect } from 'react'
import { EditorPane } from './EditorPane'
import { FileTree } from './FileTree'
import { sessionAtom, signOutAtom } from '../state/session'
import { syncStatusAtom } from '../state/sync'
import {
  activeDocAtom,
  activeVaultIdAtom,
  createVaultAtom,
  loadDocsAtom,
  loadVaultsAtom,
  vaultsAtom,
} from '../state/vaults'

export function Shell() {
  const session = useAtomValue(sessionAtom)
  const signOut = useSetAtom(signOutAtom)
  const vaults = useAtomValue(vaultsAtom)
  const [activeVaultId, setActiveVaultId] = useAtom(activeVaultIdAtom)
  const activeDoc = useAtomValue(activeDocAtom)
  const setActiveDoc = useSetAtom(activeDocAtom)
  const syncStatus = useAtomValue(syncStatusAtom)
  const loadVaults = useSetAtom(loadVaultsAtom)
  const loadDocs = useSetAtom(loadDocsAtom)
  const createVault = useSetAtom(createVaultAtom)

  useEffect(() => {
    void loadVaults()
  }, [loadVaults])
  useEffect(() => {
    setActiveDoc(null)
    void loadDocs()
  }, [activeVaultId, loadDocs, setActiveDoc])

  return (
    <div className="flex h-screen flex-col bg-neutral-950 text-neutral-100">
      <div className="flex min-h-0 flex-1">
        <aside className="flex w-64 flex-col border-r border-neutral-900">
          <div className="flex items-center gap-1 p-2">
            <select
              className="min-w-0 flex-1 rounded border border-neutral-800 bg-neutral-900 px-2 py-1 text-sm"
              value={activeVaultId ?? ''}
              onChange={(e) => setActiveVaultId(e.target.value)}
            >
              {vaults.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.name}
                </option>
              ))}
            </select>
            <button
              className="rounded bg-neutral-800 px-2 py-1 text-sm hover:bg-neutral-700"
              title="new shared vault"
              onClick={() => {
                const name = window.prompt('vault name')?.trim()
                if (name) void createVault(name)
              }}
            >
              +
            </button>
          </div>
          <FileTree />
        </aside>
        <main className="flex min-w-0 flex-1 flex-col">
          {activeDoc && (
            <div className="truncate border-b border-neutral-900 px-4 py-2 text-xs text-neutral-400">
              {activeDoc.path}
            </div>
          )}
          <EditorPane />
        </main>
      </div>
      <footer className="flex items-center justify-between border-t border-neutral-900 px-3 py-1 text-xs text-neutral-500">
        <span>
          <span
            className={
              syncStatus === 'synced'
                ? 'text-green-400'
                : syncStatus === 'syncing'
                  ? 'text-yellow-400'
                  : 'text-neutral-500'
            }
          >
            ●
          </span>{' '}
          {syncStatus}
        </span>
        <span className="flex items-center gap-2">
          {session?.email}
          <button className="rounded px-1 hover:bg-neutral-900" onClick={() => void signOut()}>
            sign out
          </button>
        </span>
      </footer>
    </div>
  )
}
```

- [ ] **Step 2: Full workspace check**

```bash
pnpm -r test > /tmp/t.log 2>&1; echo $?; tail -6 /tmp/t.log
pnpm -r typecheck; echo $?
```

Expected: all green.

- [ ] **Step 3: End-to-end verify (the milestone proof)**

```bash
pnpm db:up
lsof -ti :4000 -ti :4444 | xargs kill 2>/dev/null
pnpm --filter @holi/server dev > /tmp/server.log 2>&1 &
sleep 3; grep -cE 'relay|api|reminders' /tmp/server.log     # → 3
SEED=$(pnpm --filter @holi/server exec tsx scripts/seed-dev.ts 2>/dev/null | tail -6)
echo "$SEED"    # note token + docId
pnpm --filter @holi/desktop dev > /tmp/desktop.log 2>&1 &
```

Acceptance script (manual, in the app window):
1. Dev sign-in with the seeded token → Shell shows "Personal"/"dev vault" in the vault picker.
2. File tree shows the seeded `welcome-*.md`; click it → editor opens, status flips to **synced**, content `# welcome` renders as a heading (raw `# ` hidden until the caret enters the line).
3. Type `**bold** and [[welcome.md]] and a missing [[nope.md]]` on a new line, move the caret away → bold renders, chips appear (existing vs missing styling); ⌘B on a selection wraps it.
4. **Remote-edit liveness:** with the doc open, run

```bash
TOKEN=<token from seed>; DOC_ID=<docId from seed>
pnpm --filter @holi/server exec tsx scripts/verify-roundtrip.ts "$DOC_ID" "$TOKEN" "\nfrom-the-relay"
```

Expected: the text appears **live** in the open editor without reload (relay → renderer), with the script's cursor visible while connected.
5. **Persistence:** quit the desktop app, run the read-back:

```bash
pnpm --filter @holi/server exec tsx scripts/verify-roundtrip.ts "$DOC_ID" "$TOKEN"
```

Expected: everything typed in the editor is in the stored doc (renderer → relay → Postgres, after the 2 s debounce).
6. Create a note `projects/idea.md` from the tree input → it appears nested under `projects/`, opens, and syncs.
7. Create a vault via the sidebar `+` (name "team") → it appears in the picker, switches active, shows an empty tree.
8. Sign out → SignIn screen; relaunch → still signed out.

Then stop dev processes:

```bash
pkill -f "electron-vite dev"; lsof -ti :4000 -ti :4444 | xargs kill 2>/dev/null
```

- [ ] **Step 4: Document the collab-token decision**

In `docs/prd/auth-identity.md`, at the end of the **Sign-in** flow section (after the "Why loopback" blockquote), append:

```markdown
> **Implementation note (2026-07-12, desktop-foundation plan):** the canonical session token lives only in Electron main (`safeStorage`); tRPC ops cross IPC token-free. The Yjs `HocuspocusProvider` runs in the renderer, which fetches `{url, token}` from main per connection and holds it in memory only — a pragmatic deviation from the letter of step 6, chosen over mirroring Y.Docs across IPC (D30). Revisit if the renderer threat model hardens.
```

- [ ] **Step 5: Final commit**

```bash
git add -A ':!.dash'
git commit -m "feat(desktop): app shell — sign-in gate, vault picker, file tree, multiplayer editor

Desktop foundation per prd/auth-identity + notes-editor + vaults-collaboration:
Google SSO (PKCE/loopback) with dev-token fallback, safeStorage session,
tRPC-over-IPC, server-metadata file tree, CM6 live preview (D22) bound to
Yjs via yCollab + Hocuspocus with presence and sync status. Verified: live
remote edits render in the open editor; editor keystrokes survive in Postgres.

Claude goes brr.. via Dash"
```

---

## Deliberately NOT in this phase

- **Editor completion** (images, task checkboxes, frontmatter hiding, tables, `@`-mentions, slash commands, hover previews, `[[task:<id>]]` chips, note rename/delete UI + backrefs dialog) — next editor phase.
- **Tasks board UI** + SSE subscriptions (`watchDocs`/`tasks.watch` over `httpSubscriptionLink`) — tasks phase.
- **Daily notes** (scaffold, calendar nav) — daily-notes phase.
- **Offline cache** (y-indexeddb / main-side store, offline grace enforcement, queued-write UX) — offline phase.
- **Membership UI** (invite/remove/transfer panels) — collaboration-UI phase.
- **History timeline UI** (snapshots list/restore) — history phase.
- **Working-copy materialization + file↔CRDT bridge + agent PTY/MCP** — agent phase (bridge connects to the relay from main as its own Yjs client).
- **Session refresh loop** (`auth.refresh` silent rotation) and sign-out cache purge (no local caches exist yet) — offline phase.
- **UI-system port** (cva primitives, tokens.css) — deferred until the UI grows past raw Tailwind.
