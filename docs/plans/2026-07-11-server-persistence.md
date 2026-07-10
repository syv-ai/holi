# Server Persistence (Postgres + Hooks + SSO) Implementation Plan

> **For agentic workers:** Use the executing-plans skill to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the `apps/server` skeleton into the real backend per `docs/prd/server-data.md`: Postgres persistence (Drizzle), Google Workspace SSO + sessions, membership-gated tRPC routers, Hocuspocus persistence hooks, atomic note rename, and the server-side reminder evaluator.

**Architecture:** One Node process (unchanged): Hocuspocus relay on :4444 + tRPC on :4000, now sharing a Postgres pool. Drizzle ORM defines the schema in TS and drizzle-kit autogenerates SQL migrations, which run on boot. Every vault-scoped tRPC procedure and every WebSocket connect funnels through one membership resolution (the single authz chokepoint). Subscriptions use tRPC v11 SSE (`httpSubscriptionLink` on the client later) fed by an in-process event bus. Reminder/recurrence math calls the shared pure functions — never reimplemented.

**Tech Stack:** drizzle-orm + drizzle-kit + postgres (postgres.js driver), zod, jose is NOT used — opaque DB session tokens instead, google-auth-library (OAuth code flow + ID-token verify), @hocuspocus/server v2, tRPC v11, vitest, docker compose Postgres 17 (port 5433).

**Ground rules:**
- Work ONLY in `/Users/nicolaibthomsen/repos/syv/better-holi-final`. Never touch `~/repos/holi` or anything above `better-holi-final/`.
- Commit on `main`. Every commit message ends with `Claude goes brr.. via Dash`.
- `docs/prd/server-data.md` owns the design — do not redesign what it specifies. D#-decisions are law.
- Bare `node`/`npx` are broken in this shell — route everything through `pnpm` from the repo root (`pnpm --filter @holi/server exec tsx …`, `pnpm --filter @holi/server test`). Check exit codes, not piped output (`… > /tmp/log 2>&1; echo $?`).
- Ports: relay 4444, API 4000, dev Postgres **5433** (5432 is taken by another project's container). Kill stale `tsx watch` with `lsof -ti :4000 -ti :4444 | xargs kill` before re-verifying boot.
- Every path input from a client goes through `vaultRelPath` from `@holi/shared`. Authz middleware, rename transaction, reminder evaluator: test-first.

**Nicolai-approved deviations & documented stubs (surface, don't re-litigate):**
1. **D14 no-codegen relaxed for the DB layer** (Nicolai, 2026-07-11): Drizzle's TS schema + drizzle-kit generated migrations are fine. Scope: the Drizzle schema is server-internal; `packages/shared` types remain the client↔server seam. Task 12 records this in `docs/decisions.md`.
2. **Session tokens (open question → stub):** opaque 256-bit random tokens, SHA-256-hashed at rest in a `sessions` table, 30-day sliding expiry (matches D7's ~30-day offline window). Revocable by row delete. Not JWT — one fewer secret, trivially revocable; revisit if statelessness ever matters.
3. **Snapshot cadence (open question → stub):** on `onStoreDocument`, append an `'interval'` snapshot if the doc's newest snapshot is older than `SNAPSHOT_INTERVAL_MS` (default 10 min). Risky-op snapshots (`pre-rename` etc.) are unconditional. No pruning in v1.
4. **Reminder timezone (open question → stub):** one server-wide IANA zone `HOLI_TZ` (default `Europe/Copenhagen`) anchors all wall-clock reminder strings. Per-user tz is a later migration.
5. **Overlap-detection placement (D26, open):** NOT in this phase — client-side concern until decided. Nothing here blocks it.
6. **Doc shape:** each note's Yjs doc keeps its markdown in `Y.Text` under key `'content'` (the bridge spike's convention), promoted to a shared constant `YDOC_TEXT_KEY`.

---

## File structure

```
compose.yaml                                  # dev Postgres 17 on 5433 (new)
apps/server/
  drizzle.config.ts                           # drizzle-kit config (new)
  drizzle/                                    # generated SQL migrations (committed)
  src/
    main.ts                                   # wire everything (rewrite)
    config.ts                                 # env + defaults (new)
    db/
      schema.ts                               # all tables (new)
      client.ts                               # postgres.js pool + drizzle instance (new)
      migrate.ts                              # boot-time migration runner (new)
    auth/
      google.ts                               # OAuth URL/exchange/verify (new)
      sessions.ts                             # mint/resolve/revoke opaque tokens (new)
    trpc.ts                                   # initTRPC, context, authed/vault/owner procedures (new)
    paths.ts                                  # safePath + ensureAncestorFolders (new)
    bus.ts                                    # typed in-process EventEmitter (tasks/docs/reminders) (new)
    routers/
      auth.ts vaults.ts membership.ts notes.ts snapshots.ts tasks.ts reminders.ts user-state.ts
      index.ts                                # appRouter merge (replaces router.ts)
    yjs/
      doc-store.ts                            # load/store state, materialize text, withDoc helper (new)
      snapshots.ts                            # snapshot policy + append (new)
      link-index.ts                           # refresh link_index from doc text (new)
      rename.ts                               # atomic note/folder rename (new)
      hooks.ts                                # Hocuspocus onAuthenticate/onLoad/onStore (new)
    reminders/
      tz.ts                                   # localToUtc/utcToLocal for HOLI_TZ (new)
      projection.ts                           # recompute a task's reminders row (new)
      evaluator.ts                            # sleep-until-earliest loop (new)
    test/
      db.ts                                   # per-run test database helper (new)
      fixtures.ts                             # user/vault/session factories (new)
  test/                                       # vitest integration suites
packages/shared/src/ydoc.ts                   # YDOC_TEXT_KEY constant (new)
```

Each slice leaves `pnpm dev` bootable. Commit at every task boundary.

---

## Task 1: Dev Postgres + server deps + config

**Files:**
- Create: `compose.yaml`
- Create: `apps/server/src/config.ts`
- Modify: `apps/server/package.json` (deps via pnpm add)
- Modify: `.gitignore` (add `.env`? — already there; add `apps/server/drizzle/meta` NO — commit all of drizzle/)

- [ ] **Step 1: Write `compose.yaml` at repo root**

```yaml
services:
  postgres:
    image: postgres:17-alpine
    ports:
      - '5433:5432'
    environment:
      POSTGRES_USER: holi
      POSTGRES_PASSWORD: holi
      POSTGRES_DB: holi
    volumes:
      - holi-pgdata:/var/lib/postgresql/data
    healthcheck:
      test: ['CMD-SHELL', 'pg_isready -U holi']
      interval: 2s
      timeout: 2s
      retries: 15

volumes:
  holi-pgdata:
```

- [ ] **Step 2: Boot it and verify**

```bash
docker compose up -d --wait
docker compose exec postgres psql -U holi -c 'select 1'
```

Expected: `--wait` returns healthy; psql prints `1`.

- [ ] **Step 3: Install server deps**

From repo root:

```bash
pnpm --filter @holi/server add drizzle-orm postgres zod google-auth-library
pnpm --filter @holi/server add -D drizzle-kit vitest
```

Expected: clean install. (postgres.js and google-auth-library have no postinstall scripts — no `onlyBuiltDependencies` change needed. If pnpm warns about a blocked build script, add that package to root `package.json` → `pnpm.onlyBuiltDependencies`.)

- [ ] **Step 4: Write `apps/server/src/config.ts`**

All env in one place, with dev defaults so `pnpm dev` boots with zero setup:

```ts
/** Server configuration — env vars with dev defaults. */
export const config = {
  relayPort: Number(process.env.RELAY_PORT ?? 4444),
  apiPort: Number(process.env.API_PORT ?? 4000),
  databaseUrl: process.env.DATABASE_URL ?? 'postgres://holi:holi@localhost:5433/holi',
  /** IANA zone anchoring wall-clock reminder strings (documented stub — per-user tz later). */
  timezone: process.env.HOLI_TZ ?? 'Europe/Copenhagen',
  /** Interval snapshots on store: append when newest snapshot is older than this. */
  snapshotIntervalMs: Number(process.env.SNAPSHOT_INTERVAL_MS ?? 10 * 60_000),
  /** Sliding session lifetime (matches D7's ~30-day offline window). */
  sessionTtlMs: Number(process.env.SESSION_TTL_MS ?? 30 * 24 * 3_600_000),
  google: {
    clientId: process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    /** OAuth redirect the desktop app listens on. */
    redirectUri: process.env.GOOGLE_REDIRECT_URI ?? 'http://127.0.0.1:42813/oauth/callback',
    /** Workspace hosted-domain restriction (D7). Unset ⇒ any Google account (dev only). */
    workspaceDomain: process.env.GOOGLE_WORKSPACE_DOMAIN,
  },
}
```

- [ ] **Step 5: Add server scripts**

In `apps/server/package.json` scripts:

```json
{
  "dev": "tsx watch src/main.ts",
  "typecheck": "tsc --noEmit",
  "test": "vitest run",
  "db:generate": "drizzle-kit generate",
  "db:migrate": "tsx src/db/migrate.ts"
}
```

- [ ] **Step 6: Typecheck and commit**

```bash
pnpm --filter @holi/server typecheck; echo $?
git add compose.yaml apps/server/package.json apps/server/src/config.ts pnpm-lock.yaml
git commit -m "feat(server): dev Postgres compose + config + persistence deps

Claude goes brr.. via Dash"
```

---

## Task 2: Drizzle schema + generated migration + boot-time migrator

The schema is a 1:1 transcription of the PRD's tables (`docs/prd/server-data.md` §Postgres schema) plus a `sessions` table (stub #2). Drizzle is server-internal; `@holi/shared` types stay the API seam (deviation #1).

**Files:**
- Create: `apps/server/drizzle.config.ts`
- Create: `apps/server/src/db/schema.ts`
- Create: `apps/server/src/db/client.ts`
- Create: `apps/server/src/db/migrate.ts`
- Create: `apps/server/drizzle/` (generated — commit it)

- [ ] **Step 1: Write `apps/server/drizzle.config.ts`**

```ts
import { defineConfig } from 'drizzle-kit'

export default defineConfig({
  schema: './src/db/schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? 'postgres://holi:holi@localhost:5433/holi',
  },
})
```

- [ ] **Step 2: Write `apps/server/src/db/schema.ts`**

```ts
/**
 * Postgres schema — 1:1 with docs/prd/server-data.md. Server-internal:
 * @holi/shared types remain the client↔server seam (D14 relaxation,
 * Nicolai 2026-07-11). No conversation tables (D9).
 */
import { sql } from 'drizzle-orm'
import {
  boolean,
  customType,
  date,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'
import type { RelatedRef, Recurrence } from '@holi/shared'

const bytea = customType<{ data: Uint8Array }>({ dataType: () => 'bytea' })

const timestamps = {
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}

export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  googleSub: text('google_sub').notNull().unique(),
  email: text('email').notNull().unique(),
  name: text('name'),
  avatarUrl: text('avatar_url'),
  ...timestamps,
})

/** Opaque session tokens, SHA-256-hashed at rest; 30-day sliding TTL (stub #2). */
export const sessions = pgTable(
  'sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull().unique(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('sessions_user_idx').on(t.userId)],
)

export const vaults = pgTable('vaults', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  kind: text('kind', { enum: ['personal', 'shared'] }).notNull(),
  ownerId: uuid('owner_id')
    .notNull()
    .references(() => users.id),
  theme: jsonb('theme'),
  ...timestamps,
})

export const memberships = pgTable(
  'memberships',
  {
    vaultId: uuid('vault_id')
      .notNull()
      .references(() => vaults.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: text('role', { enum: ['owner', 'member'] }).notNull(),
    invitedBy: uuid('invited_by').references(() => users.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.vaultId, t.userId] }), index('memberships_user_idx').on(t.userId)],
)

export const docs = pgTable(
  'docs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    vaultId: uuid('vault_id')
      .notNull()
      .references(() => vaults.id, { onDelete: 'cascade' }),
    path: text('path').notNull(),
    kind: text('kind', { enum: ['note', 'daily'] }).notNull(),
    ...timestamps,
  },
  (t) => [uniqueIndex('docs_vault_path_idx').on(t.vaultId, t.path)],
)

export const folders = pgTable(
  'folders',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    vaultId: uuid('vault_id')
      .notNull()
      .references(() => vaults.id, { onDelete: 'cascade' }),
    path: text('path').notNull(),
    ...timestamps,
  },
  (t) => [uniqueIndex('folders_vault_path_idx').on(t.vaultId, t.path)],
)

export const yjsDocs = pgTable('yjs_docs', {
  docId: uuid('doc_id')
    .primaryKey()
    .references(() => docs.id, { onDelete: 'cascade' }),
  state: bytea('state').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

export const yjsSnapshots = pgTable(
  'yjs_snapshots',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    docId: uuid('doc_id')
      .notNull()
      .references(() => docs.id, { onDelete: 'cascade' }),
    state: bytea('state').notNull(),
    takenAt: timestamp('taken_at', { withTimezone: true }).notNull().defaultNow(),
    reason: text('reason'),
    label: text('label'),
    authorId: uuid('author_id').references(() => users.id),
  },
  (t) => [index('yjs_snapshots_timeline_idx').on(t.docId, t.takenAt.desc())],
)

export const tasks = pgTable(
  'tasks',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    vaultId: uuid('vault_id')
      .notNull()
      .references(() => vaults.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    status: text('status', { enum: ['todo', 'doing', 'done'] }).notNull().default('todo'),
    area: uuid('area').references(() => folders.id),
    due: date('due', { mode: 'string' }),
    priority: text('priority', { enum: ['low', 'medium', 'high'] }),
    tags: text('tags').array().notNull().default(sql`'{}'::text[]`),
    reminder: text('reminder'),
    remindedAt: timestamp('reminded_at', { withTimezone: true }),
    recurrence: jsonb('recurrence').$type<Recurrence>(),
    related: jsonb('related').$type<RelatedRef[]>().notNull().default(sql`'[]'::jsonb`),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    ...timestamps,
  },
  (t) => [index('tasks_board_idx').on(t.vaultId, t.status), index('tasks_area_idx').on(t.vaultId, t.area)],
)

export const reminders = pgTable(
  'reminders',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    taskId: uuid('task_id')
      .notNull()
      .unique()
      .references(() => tasks.id, { onDelete: 'cascade' }),
    vaultId: uuid('vault_id')
      .notNull()
      .references(() => vaults.id, { onDelete: 'cascade' }),
    fireAt: timestamp('fire_at', { withTimezone: true }).notNull(),
    fired: boolean('fired').notNull().default(false),
    computedFrom: text('computed_from'),
  },
  (t) => [index('reminders_pending_idx').on(t.fireAt).where(sql`not ${t.fired}`)],
)

export const perUserState = pgTable(
  'per_user_state',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    vaultId: uuid('vault_id')
      .notNull()
      .references(() => vaults.id, { onDelete: 'cascade' }),
    key: text('key').notNull(),
    value: jsonb('value'),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.vaultId, t.key] })],
)

export const linkIndex = pgTable(
  'link_index',
  {
    vaultId: uuid('vault_id')
      .notNull()
      .references(() => vaults.id, { onDelete: 'cascade' }),
    srcDocId: uuid('src_doc_id')
      .notNull()
      .references(() => docs.id, { onDelete: 'cascade' }),
    targetPath: text('target_path').notNull(),
    occurrences: integer('occurrences').notNull().default(1),
  },
  (t) => [
    primaryKey({ columns: [t.srcDocId, t.targetPath] }),
    index('link_index_target_idx').on(t.vaultId, t.targetPath),
  ],
)
```

Note vs PRD: `reminders.task_id` is UNIQUE (the projection is one row per task — the evaluator upserts by task), and `sessions` is added. Everything else is column-for-column PRD.

- [ ] **Step 3: Write `apps/server/src/db/client.ts`**

```ts
import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import { config } from '../config'
import * as schema from './schema'

export function createDb(url: string = config.databaseUrl) {
  const sql = postgres(url, { max: 10, onnotice: () => {} })
  const db = drizzle(sql, { schema })
  return { db, sql }
}

export type Db = ReturnType<typeof createDb>['db']
```

- [ ] **Step 4: Write `apps/server/src/db/migrate.ts`**

```ts
import { fileURLToPath } from 'node:url'
import { drizzle } from 'drizzle-orm/postgres-js'
import { migrate } from 'drizzle-orm/postgres-js/migrator'
import postgres from 'postgres'
import { config } from '../config'

const MIGRATIONS_DIR = fileURLToPath(new URL('../../drizzle', import.meta.url))

/** Apply pending migrations. Runs on boot (main.ts) and via `pnpm db:migrate`. */
export async function runMigrations(url: string = config.databaseUrl): Promise<void> {
  const sql = postgres(url, { max: 1, onnotice: () => {} })
  try {
    await migrate(drizzle(sql), { migrationsFolder: MIGRATIONS_DIR })
  } finally {
    await sql.end()
  }
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  runMigrations()
    .then(() => console.log('[db] migrations applied'))
    .catch((err) => {
      console.error(err)
      process.exitCode = 1
    })
}
```

- [ ] **Step 5: Generate the initial migration and apply it**

```bash
pnpm --filter @holi/server db:generate
pnpm --filter @holi/server db:migrate; echo $?
```

Expected: `drizzle/0000_*.sql` + `drizzle/meta/` created; migrate exits 0. Inspect the generated SQL — verify `ON DELETE CASCADE` on every FK the PRD marks, the partial index `reminders_pending_idx ... WHERE not "fired"`, and the two unique `(vault_id, path)` indexes.

- [ ] **Step 6: Verify against the live DB and commit**

```bash
docker compose exec postgres psql -U holi -c '\dt'
```

Expected: all 11 tables (`users sessions vaults memberships docs folders yjs_docs yjs_snapshots tasks reminders per_user_state link_index` — 12 with link_index).

```bash
pnpm --filter @holi/server typecheck; echo $?
git add apps/server/drizzle.config.ts apps/server/src/db apps/server/drizzle
git commit -m "feat(server): full Postgres schema (Drizzle) + generated initial migration

D14 no-codegen relaxed for the DB layer per Nicolai 2026-07-11: drizzle-kit
generates SQL migrations from the TS schema; @holi/shared stays the API seam.

Claude goes brr.. via Dash"
```

---

## Task 3: Per-run test database helper

Tests hit the compose Postgres but each suite gets its own throwaway database (decision: compose PG, per-run test DB).

**Files:**
- Create: `apps/server/src/test/db.ts`
- Create: `apps/server/test/db.test.ts`
- Create: `apps/server/vitest.config.ts`

- [ ] **Step 1: Write `apps/server/vitest.config.ts`**

Integration tests share one DB per suite file; keep them sequential within a file, parallel across files (each file has its own database, so no interference):

```ts
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    testTimeout: 15_000,
    hookTimeout: 30_000,
  },
})
```

- [ ] **Step 2: Write `apps/server/src/test/db.ts`**

```ts
import { randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { drizzle } from 'drizzle-orm/postgres-js'
import { migrate } from 'drizzle-orm/postgres-js/migrator'
import postgres from 'postgres'
import * as schema from '../db/schema'

const ADMIN_URL = process.env.TEST_ADMIN_URL ?? 'postgres://holi:holi@localhost:5433/holi'
const MIGRATIONS_DIR = fileURLToPath(new URL('../../drizzle', import.meta.url))

export interface TestDb {
  db: ReturnType<typeof drizzle<typeof schema>>
  sql: postgres.Sql
  destroy(): Promise<void>
}

/** Create a uniquely-named database on the compose Postgres, fully migrated. */
export async function createTestDb(): Promise<TestDb> {
  const name = `holi_test_${randomBytes(6).toString('hex')}`
  const admin = postgres(ADMIN_URL, { max: 1, onnotice: () => {} })
  await admin.unsafe(`create database ${name}`)
  const url = new URL(ADMIN_URL)
  url.pathname = `/${name}`
  const sql = postgres(url.href, { max: 5, onnotice: () => {} })
  await migrate(drizzle(sql), { migrationsFolder: MIGRATIONS_DIR })
  const db = drizzle(sql, { schema })
  return {
    db,
    sql,
    async destroy() {
      await sql.end()
      await admin.unsafe(`drop database ${name} with (force)`)
      await admin.end()
    },
  }
}
```

- [ ] **Step 3: Write the smoke test `apps/server/test/db.test.ts`**

```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { users } from '../src/db/schema'
import { createTestDb, type TestDb } from '../src/test/db'

describe('test database', () => {
  let t: TestDb
  beforeAll(async () => {
    t = await createTestDb()
  })
  afterAll(() => t.destroy())

  it('migrates and round-trips a row', async () => {
    const [row] = await t.db
      .insert(users)
      .values({ googleSub: 'sub-1', email: 'a@syv.ai', name: 'A' })
      .returning()
    expect(row?.id).toMatch(/^[0-9a-f-]{36}$/)
    expect(row?.email).toBe('a@syv.ai')
  })
})
```

- [ ] **Step 4: Run it**

```bash
pnpm --filter @holi/server test > /tmp/t.log 2>&1; echo $?; tail -5 /tmp/t.log
```

Expected: exit 0, 1 passed. (Requires `docker compose up -d` — if connection refused, start it.)

- [ ] **Step 5: Commit**

```bash
git add apps/server/vitest.config.ts apps/server/src/test/db.ts apps/server/test/db.test.ts
git commit -m "test(server): per-run test database helper on compose Postgres

Claude goes brr.. via Dash"
```

---

## Task 4: Sessions — opaque tokens, hashed at rest (TDD)

Stub #2: 256-bit random bearer token, SHA-256 hash stored, 30-day sliding expiry, revocable. One mechanism authenticates tRPC (header) and the Yjs WebSocket (`onAuthenticate` payload).

**Files:**
- Create: `apps/server/src/auth/sessions.ts`
- Test: `apps/server/test/sessions.test.ts`

- [ ] **Step 1: Write the failing tests `apps/server/test/sessions.test.ts`**

```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { mintSession, resolveSession, revokeSession } from '../src/auth/sessions'
import { sessions, users } from '../src/db/schema'
import { createTestDb, type TestDb } from '../src/test/db'

describe('sessions', () => {
  let t: TestDb
  let userId: string
  beforeAll(async () => {
    t = await createTestDb()
    const [u] = await t.db
      .insert(users)
      .values({ googleSub: 's1', email: 'n@syv.ai' })
      .returning()
    userId = u!.id
  })
  afterAll(() => t.destroy())

  it('mint → resolve round-trips the user', async () => {
    const token = await mintSession(t.db, userId)
    const user = await resolveSession(t.db, token)
    expect(user?.id).toBe(userId)
    expect(user?.email).toBe('n@syv.ai')
  })

  it('stores only a hash, never the token', async () => {
    const token = await mintSession(t.db, userId)
    const rows = await t.db.select().from(sessions)
    expect(rows.some((r) => r.tokenHash === token)).toBe(false)
    expect(rows.every((r) => /^[0-9a-f]{64}$/.test(r.tokenHash))).toBe(true)
  })

  it('rejects unknown and expired tokens', async () => {
    expect(await resolveSession(t.db, 'garbage')).toBeNull()
    const token = await mintSession(t.db, userId)
    const past = new Date(Date.now() + 31 * 24 * 3_600_000)
    expect(await resolveSession(t.db, token, past)).toBeNull()
  })

  it('slides expiry on resolve', async () => {
    const token = await mintSession(t.db, userId)
    const before = (await t.db.select().from(sessions)).map((r) => r.expiresAt.getTime())
    const later = new Date(Date.now() + 10 * 24 * 3_600_000)
    await resolveSession(t.db, token, later)
    const after = (await t.db.select().from(sessions)).map((r) => r.expiresAt.getTime())
    expect(Math.max(...after)).toBeGreaterThan(Math.max(...before))
  })

  it('revoke kills the session immediately', async () => {
    const token = await mintSession(t.db, userId)
    await revokeSession(t.db, token)
    expect(await resolveSession(t.db, token)).toBeNull()
  })
})
```

- [ ] **Step 2: Run to verify failure**

```bash
pnpm --filter @holi/server test test/sessions.test.ts > /tmp/t.log 2>&1; echo $?; tail -5 /tmp/t.log
```

Expected: FAIL — cannot find module `../src/auth/sessions`.

- [ ] **Step 3: Write `apps/server/src/auth/sessions.ts`**

```ts
/**
 * Opaque session tokens (documented stub, plan §deviations #2): 256-bit
 * random, SHA-256-hashed at rest, 30-day sliding TTL (D7's offline window),
 * revoked by row delete. Authenticates both tRPC and the Yjs WebSocket.
 */
import { createHash, randomBytes } from 'node:crypto'
import { and, eq, gt } from 'drizzle-orm'
import { config } from '../config'
import type { Db } from '../db/client'
import { sessions, users } from '../db/schema'

export interface SessionUser {
  id: string
  email: string
  name: string | null
  avatarUrl: string | null
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

export async function mintSession(db: Db, userId: string, now = new Date()): Promise<string> {
  const token = randomBytes(32).toString('base64url')
  await db.insert(sessions).values({
    userId,
    tokenHash: hashToken(token),
    expiresAt: new Date(now.getTime() + config.sessionTtlMs),
  })
  return token
}

/** Resolve a bearer token to its user (null if unknown/expired); slides expiry. */
export async function resolveSession(
  db: Db,
  token: string,
  now = new Date(),
): Promise<SessionUser | null> {
  const [row] = await db
    .select({ sessionId: sessions.id, user: users })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(and(eq(sessions.tokenHash, hashToken(token)), gt(sessions.expiresAt, now)))
  if (!row) return null
  await db
    .update(sessions)
    .set({ expiresAt: new Date(now.getTime() + config.sessionTtlMs) })
    .where(eq(sessions.id, row.sessionId))
  const { id, email, name, avatarUrl } = row.user
  return { id, email, name, avatarUrl }
}

export async function revokeSession(db: Db, token: string): Promise<void> {
  await db.delete(sessions).where(eq(sessions.tokenHash, hashToken(token)))
}
```

- [ ] **Step 4: Run tests, expect green, commit**

```bash
pnpm --filter @holi/server test test/sessions.test.ts > /tmp/t.log 2>&1; echo $?; tail -5 /tmp/t.log
git add apps/server/src/auth/sessions.ts apps/server/test/sessions.test.ts
git commit -m "feat(server): opaque session tokens test-first — hashed at rest, sliding 30d TTL

Claude goes brr.. via Dash"
```

---

## Task 5: Google SSO + tRPC context + auth router

**Files:**
- Create: `apps/server/src/auth/google.ts`
- Create: `apps/server/src/trpc.ts`
- Create: `apps/server/src/routers/auth.ts`
- Create: `apps/server/src/test/fixtures.ts`
- Test: `apps/server/test/auth.test.ts`

- [ ] **Step 1: Write `apps/server/src/auth/google.ts`**

The OAuth network calls aren't unit-testable; keep them thin and isolate the verifiable logic (`assertWorkspace`, `upsertGoogleUser`).

```ts
/**
 * Google Workspace SSO (D7): authorization-code flow, hd-restricted.
 * The `hd` param on the auth URL is a UI hint only — the ID token's `hd`
 * claim is the authoritative check (assertWorkspace).
 */
import { OAuth2Client, type TokenPayload } from 'google-auth-library'
import { config } from '../config'
import type { Db } from '../db/client'
import { users } from '../db/schema'

export interface GoogleProfile {
  sub: string
  email: string
  name?: string
  avatarUrl?: string
}

function oauthClient(): OAuth2Client {
  const { clientId, clientSecret, redirectUri } = config.google
  if (!clientId || !clientSecret) {
    throw new Error('Google OAuth not configured (set GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET)')
  }
  return new OAuth2Client({ clientId, clientSecret, redirectUri })
}

export function googleAuthUrl(): string {
  return oauthClient().generateAuthUrl({
    scope: ['openid', 'email', 'profile'],
    hd: config.google.workspaceDomain,
  })
}

/** Enforce the Workspace restriction against the verified ID-token payload. */
export function assertWorkspace(payload: Pick<TokenPayload, 'hd'>): void {
  const domain = config.google.workspaceDomain
  if (domain && payload.hd !== domain) {
    throw new Error(`Google account is not in the ${domain} workspace`)
  }
}

export async function exchangeGoogleCode(code: string): Promise<GoogleProfile> {
  const client = oauthClient()
  const { tokens } = await client.getToken(code)
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

/** Upsert by google_sub — profile fields refresh on every sign-in. */
export async function upsertGoogleUser(db: Db, profile: GoogleProfile) {
  const [user] = await db
    .insert(users)
    .values({
      googleSub: profile.sub,
      email: profile.email,
      name: profile.name,
      avatarUrl: profile.avatarUrl,
    })
    .onConflictDoUpdate({
      target: users.googleSub,
      set: {
        email: profile.email,
        name: profile.name,
        avatarUrl: profile.avatarUrl,
        updatedAt: new Date(),
      },
    })
    .returning()
  return user!
}
```

- [ ] **Step 2: Write `apps/server/src/trpc.ts`**

Context carries `db`, `bus` (defined Task 6 — declare the import now; create a placeholder `src/bus.ts` exporting `export type Bus = unknown` ONLY if you reorder tasks; in plan order Task 6's bus lands before anything consumes it at runtime), the resolved `user`, and the raw `token` (for signOut/refresh).

```ts
import { initTRPC, TRPCError } from '@trpc/server'
import type { IncomingMessage } from 'node:http'
import { resolveSession, type SessionUser } from './auth/sessions'
import type { Bus } from './bus'
import type { Db } from './db/client'

export interface Context {
  db: Db
  bus: Bus
  user: SessionUser | null
  token: string | null
}

export function bearerToken(req: Pick<IncomingMessage, 'headers'>): string | null {
  const header = req.headers.authorization
  if (!header?.startsWith('Bearer ')) return null
  return header.slice('Bearer '.length) || null
}

/** Adapter-facing factory: main.ts partially applies { db, bus }. */
export function makeCreateContext(deps: { db: Db; bus: Bus }) {
  return async ({ req }: { req: IncomingMessage }): Promise<Context> => {
    const token = bearerToken(req)
    const user = token ? await resolveSession(deps.db, token) : null
    return { ...deps, user, token }
  }
}

const t = initTRPC.context<Context>().create()

export const router = t.router
export const publicProcedure = t.procedure

export const authedProcedure = t.procedure.use(({ ctx, next }) => {
  if (!ctx.user) throw new TRPCError({ code: 'UNAUTHORIZED' })
  return next({ ctx: { ...ctx, user: ctx.user } })
})
```

- [ ] **Step 3: Write `apps/server/src/routers/auth.ts`**

```ts
import { z } from 'zod'
import { exchangeGoogleCode, googleAuthUrl, upsertGoogleUser } from '../auth/google'
import { mintSession, revokeSession } from '../auth/sessions'
import { authedProcedure, publicProcedure, router } from '../trpc'

export const authRouter = router({
  beginGoogle: publicProcedure.query(() => ({ url: googleAuthUrl() })),

  completeGoogle: publicProcedure
    .input(z.object({ code: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      const profile = await exchangeGoogleCode(input.code)
      const user = await upsertGoogleUser(ctx.db, profile)
      const token = await mintSession(ctx.db, user.id)
      return { token, user: { id: user.id, email: user.email, name: user.name, avatarUrl: user.avatarUrl } }
    }),

  session: authedProcedure.query(({ ctx }) => ctx.user),

  /** Rotate: mint a fresh token, revoke the presented one. */
  refresh: authedProcedure.mutation(async ({ ctx }) => {
    const token = await mintSession(ctx.db, ctx.user.id)
    if (ctx.token) await revokeSession(ctx.db, ctx.token)
    return { token }
  }),

  signOut: authedProcedure.mutation(async ({ ctx }) => {
    if (ctx.token) await revokeSession(ctx.db, ctx.token)
    return { ok: true }
  }),
})
```

- [ ] **Step 4: Write `apps/server/src/test/fixtures.ts`**

```ts
import { randomBytes } from 'node:crypto'
import { mintSession } from '../auth/sessions'
import type { Db } from '../db/client'
import { memberships, users, vaults } from '../db/schema'
import type { Role, VaultKind } from '@holi/shared'

export async function seedUser(db: Db, email = `${randomBytes(4).toString('hex')}@syv.ai`) {
  const [user] = await db
    .insert(users)
    .values({ googleSub: `sub-${randomBytes(8).toString('hex')}`, email })
    .returning()
  return user!
}

/** Vault + owner membership in one go (mirrors vaults.create). */
export async function seedVault(db: Db, ownerId: string, kind: VaultKind = 'shared', name = 'v') {
  const [vault] = await db.insert(vaults).values({ name, kind, ownerId }).returning()
  await db.insert(memberships).values({ vaultId: vault!.id, userId: ownerId, role: 'owner' })
  return vault!
}

export async function addMember(db: Db, vaultId: string, userId: string, role: Role = 'member') {
  await db.insert(memberships).values({ vaultId, userId, role })
}

export async function seedSession(db: Db, userId: string): Promise<string> {
  return mintSession(db, userId)
}
```

- [ ] **Step 5: Write `apps/server/test/auth.test.ts`**

Tests cover the DB-touching and policy logic (upsert, workspace assert, session/refresh via caller). `beginGoogle`/`exchangeGoogleCode` network paths are exercised in the Task 13 manual verify.

```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { assertWorkspace, upsertGoogleUser } from '../src/auth/google'
import { resolveSession } from '../src/auth/sessions'
import { authRouter } from '../src/routers/auth'
import { createTestDb, type TestDb } from '../src/test/db'
import { seedSession, seedUser } from '../src/test/fixtures'
import type { Context } from '../src/trpc'

const ctxFor = (t: TestDb, user: Awaited<ReturnType<typeof resolveSession>>, token: string | null): Context =>
  ({ db: t.db, bus: undefined as never, user, token }) as Context

describe('auth', () => {
  let t: TestDb
  beforeAll(async () => {
    t = await createTestDb()
  })
  afterAll(() => t.destroy())

  it('upsertGoogleUser inserts then refreshes profile on the same sub', async () => {
    const a = await upsertGoogleUser(t.db, { sub: 'g1', email: 'x@syv.ai', name: 'X' })
    const b = await upsertGoogleUser(t.db, { sub: 'g1', email: 'x@syv.ai', name: 'X Renamed' })
    expect(b.id).toBe(a.id)
    expect(b.name).toBe('X Renamed')
  })

  it('assertWorkspace passes matching hd and is a no-op when unrestricted', () => {
    expect(() => assertWorkspace({ hd: undefined })).not.toThrow() // domain unset in tests
  })

  it('session query returns the caller; unauthenticated is UNAUTHORIZED', async () => {
    const user = await seedUser(t.db)
    const token = await seedSession(t.db, user.id)
    const resolved = await resolveSession(t.db, token)
    const caller = authRouter.createCaller(ctxFor(t, resolved, token))
    expect((await caller.session())?.id).toBe(user.id)
    const anon = authRouter.createCaller(ctxFor(t, null, null))
    await expect(anon.session()).rejects.toMatchObject({ code: 'UNAUTHORIZED' })
  })

  it('refresh rotates the token', async () => {
    const user = await seedUser(t.db)
    const token = await seedSession(t.db, user.id)
    const resolved = await resolveSession(t.db, token)
    const caller = authRouter.createCaller(ctxFor(t, resolved, token))
    const { token: fresh } = await caller.refresh()
    expect(await resolveSession(t.db, token)).toBeNull()
    expect((await resolveSession(t.db, fresh))?.id).toBe(user.id)
  })
})
```

Note: `bus: undefined as never` is fine here — auth procedures never touch the bus. Once Task 6 lands `src/bus.ts`, swap fixtures/tests to `createBus()` if convenient.

- [ ] **Step 6: Make it compile — placeholder bus**

`src/trpc.ts` imports `type Bus` from `./bus` which lands in Task 6. Create the real `src/bus.ts` NOW (it's small — pull it forward from Task 6 Step 1) so this task typechecks; Task 6 then just consumes it.

- [ ] **Step 7: Run tests + typecheck, commit**

```bash
pnpm --filter @holi/server test > /tmp/t.log 2>&1; echo $?; tail -5 /tmp/t.log
pnpm --filter @holi/server typecheck; echo $?
git add apps/server/src/auth apps/server/src/trpc.ts apps/server/src/routers/auth.ts apps/server/src/test/fixtures.ts apps/server/src/bus.ts apps/server/test/auth.test.ts
git commit -m "feat(server): Google Workspace SSO + tRPC context + auth router

Claude goes brr.. via Dash"
```

---

## Task 6: Membership chokepoint (TDD) + event bus + vaults/membership routers

The single authz boundary (PRD §Authorization): `resolveVaultRole` backs BOTH the tRPC middleware and Hocuspocus `onAuthenticate` (Task 8). Security-critical — tests first.

**Files:**
- Create: `apps/server/src/bus.ts` (pulled forward to Task 5 Step 6 — write it there, listed here for ownership)
- Create: `apps/server/src/auth/membership.ts`
- Create: `apps/server/src/db/mappers.ts`
- Modify: `apps/server/src/trpc.ts` (add vaultProcedure/ownerProcedure)
- Modify: `apps/server/src/auth/google.ts` (claim invited-stub users)
- Create: `apps/server/src/routers/vaults.ts`, `apps/server/src/routers/membership.ts`
- Test: `apps/server/test/authz.test.ts`, `apps/server/test/vaults.test.ts`

- [ ] **Step 1: `apps/server/src/bus.ts`** (already created in Task 5 Step 6 — this is its content)

```ts
/** Typed in-process event bus feeding the (S) SSE subscriptions. Single-node
 * by design — multi-node needs shared pub/sub (PRD: open, post-v1). */
import { EventEmitter } from 'node:events'
import type { DocMeta, Task } from '@holi/shared'

export type DocsEvent = { type: 'created' | 'renamed' | 'deleted'; doc: DocMeta }
export type TasksEvent = { type: 'upserted'; task: Task } | { type: 'deleted'; taskId: string }
export type ReminderFire = { taskId: string; title: string; fireAt: string }
export type RemindersEvent = { fires: ReminderFire[]; coalesced: boolean }

export class Bus extends EventEmitter {
  emitDocs(vaultId: string, event: DocsEvent): void {
    this.emit(`docs:${vaultId}`, event)
  }
  emitTasks(vaultId: string, event: TasksEvent): void {
    this.emit(`tasks:${vaultId}`, event)
  }
  emitReminders(vaultId: string, event: RemindersEvent): void {
    this.emit(`reminders:${vaultId}`, event)
  }
  /** Wake the evaluator loop after any reminder-affecting mutation. */
  wakeEvaluator(): void {
    this.emit('evaluator:wake')
  }
}

export function createBus(): Bus {
  const bus = new Bus()
  bus.setMaxListeners(0)
  return bus
}
```

- [ ] **Step 2: Write the failing authz tests `apps/server/test/authz.test.ts`**

```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { resolveVaultRole } from '../src/auth/membership'
import { vaultsRouter } from '../src/routers/vaults'
import { createBus } from '../src/bus'
import { createTestDb, type TestDb } from '../src/test/db'
import { addMember, seedUser, seedVault } from '../src/test/fixtures'
import type { Context } from '../src/trpc'

const ctxFor = (t: TestDb, userId: string): Context =>
  ({
    db: t.db,
    bus: createBus(),
    user: { id: userId, email: 'x@syv.ai', name: null, avatarUrl: null },
    token: 'tok',
  }) as Context

describe('membership chokepoint', () => {
  let t: TestDb
  beforeAll(async () => {
    t = await createTestDb()
  })
  afterAll(() => t.destroy())

  it('resolveVaultRole: owner / member / non-member', async () => {
    const owner = await seedUser(t.db)
    const member = await seedUser(t.db)
    const outsider = await seedUser(t.db)
    const vault = await seedVault(t.db, owner.id)
    await addMember(t.db, vault.id, member.id)
    expect(await resolveVaultRole(t.db, vault.id, owner.id)).toBe('owner')
    expect(await resolveVaultRole(t.db, vault.id, member.id)).toBe('member')
    expect(await resolveVaultRole(t.db, vault.id, outsider.id)).toBeNull()
  })

  it('vaultProcedure rejects non-members with FORBIDDEN', async () => {
    const owner = await seedUser(t.db)
    const outsider = await seedUser(t.db)
    const vault = await seedVault(t.db, owner.id)
    const caller = vaultsRouter.createCaller(ctxFor(t, outsider.id))
    await expect(caller.get({ vaultId: vault.id })).rejects.toMatchObject({ code: 'FORBIDDEN' })
  })

  it('ownerProcedure rejects plain members', async () => {
    const owner = await seedUser(t.db)
    const member = await seedUser(t.db)
    const vault = await seedVault(t.db, owner.id)
    await addMember(t.db, vault.id, member.id)
    const caller = vaultsRouter.createCaller(ctxFor(t, member.id))
    await expect(caller.rename({ vaultId: vault.id, name: 'nope' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    })
  })

  it('membership scoping: vaults.list returns only my vaults', async () => {
    const a = await seedUser(t.db)
    const b = await seedUser(t.db)
    const mine = await seedVault(t.db, a.id, 'personal', 'mine')
    await seedVault(t.db, b.id, 'personal', 'theirs')
    const caller = vaultsRouter.createCaller(ctxFor(t, a.id))
    const list = await caller.list()
    expect(list.map((v) => v.id)).toEqual([mine.id])
  })
})
```

- [ ] **Step 3: Run to verify failure**

```bash
pnpm --filter @holi/server test test/authz.test.ts > /tmp/t.log 2>&1; echo $?; tail -5 /tmp/t.log
```

Expected: FAIL — missing modules `membership`/`vaults`.

- [ ] **Step 4: Write `apps/server/src/auth/membership.ts`**

```ts
/** The single authorization source (PRD §Authorization): membership → role.
 * Backs the tRPC vault middleware AND Hocuspocus onAuthenticate. */
import { and, eq } from 'drizzle-orm'
import type { Role } from '@holi/shared'
import type { Db } from '../db/client'
import { memberships } from '../db/schema'

export async function resolveVaultRole(
  db: Db,
  vaultId: string,
  userId: string,
): Promise<Role | null> {
  const [row] = await db
    .select({ role: memberships.role })
    .from(memberships)
    .where(and(eq(memberships.vaultId, vaultId), eq(memberships.userId, userId)))
  return row?.role ?? null
}
```

- [ ] **Step 5: Add vault/owner procedures to `apps/server/src/trpc.ts`**

Append:

```ts
import { z } from 'zod'
import { resolveVaultRole } from './auth/membership'

const vaultInput = z.object({ vaultId: z.string().uuid() })

/** Every vault-scoped procedure funnels through this middleware — the role in
 * ctx comes from the DB, never from the client (PRD §Authorization). */
export const vaultProcedure = authedProcedure.input(vaultInput).use(async ({ ctx, input, next }) => {
  const role = await resolveVaultRole(ctx.db, input.vaultId, ctx.user.id)
  if (!role) throw new TRPCError({ code: 'FORBIDDEN', message: 'not a member of this vault' })
  return next({ ctx: { ...ctx, vaultId: input.vaultId, role } })
})

export const ownerProcedure = vaultProcedure.use(({ ctx, next }) => {
  if (ctx.role !== 'owner') throw new TRPCError({ code: 'FORBIDDEN', message: 'owner role required' })
  return next()
})
```

(Downstream routers chain `.input(z.object({ ... }))` — tRPC merges object inputs, so every call carries `vaultId` plus its own fields.)

- [ ] **Step 6: Write `apps/server/src/db/mappers.ts`**

DB rows → `@holi/shared` wire types (null → undefined, Date → ISO):

```ts
import type { DocMeta, Folder, Task, Vault } from '@holi/shared'
import type { docs, folders, tasks, vaults } from './schema'

export function toVault(row: typeof vaults.$inferSelect): Vault {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    ownerId: row.ownerId,
    theme: row.theme ?? undefined,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }
}

export function toDocMeta(row: typeof docs.$inferSelect): DocMeta {
  return {
    id: row.id,
    vaultId: row.vaultId,
    path: row.path,
    kind: row.kind,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }
}

export function toFolder(row: typeof folders.$inferSelect): Folder {
  return { id: row.id, vaultId: row.vaultId, path: row.path }
}

export function toTask(row: typeof tasks.$inferSelect): Task {
  return {
    id: row.id,
    vaultId: row.vaultId,
    title: row.title,
    status: row.status,
    area: row.area ?? undefined,
    due: row.due ?? undefined,
    priority: row.priority ?? undefined,
    tags: row.tags,
    reminder: row.reminder ?? undefined,
    recurrence: row.recurrence ?? undefined,
    related: row.related,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }
}
```

- [ ] **Step 7: Write `apps/server/src/routers/vaults.ts`**

```ts
import { on } from 'node:events'
import { eq } from 'drizzle-orm'
import { z } from 'zod'
import type { DocsEvent } from '../bus'
import { toDocMeta, toFolder, toVault } from '../db/mappers'
import { docs, folders, memberships, vaults } from '../db/schema'
import { authedProcedure, ownerProcedure, router, vaultProcedure } from '../trpc'

export const vaultsRouter = router({
  list: authedProcedure.query(async ({ ctx }) => {
    const rows = await ctx.db
      .select({ vault: vaults })
      .from(memberships)
      .innerJoin(vaults, eq(vaults.id, memberships.vaultId))
      .where(eq(memberships.userId, ctx.user.id))
    return rows.map((r) => toVault(r.vault))
  }),

  get: vaultProcedure.query(async ({ ctx }) => {
    const [row] = await ctx.db.select().from(vaults).where(eq(vaults.id, ctx.vaultId))
    return toVault(row!)
  }),

  create: authedProcedure
    .input(z.object({ name: z.string().min(1), kind: z.enum(['personal', 'shared']) }))
    .mutation(async ({ ctx, input }) => {
      return ctx.db.transaction(async (tx) => {
        const [vault] = await tx
          .insert(vaults)
          .values({ name: input.name, kind: input.kind, ownerId: ctx.user.id })
          .returning()
        await tx.insert(memberships).values({ vaultId: vault!.id, userId: ctx.user.id, role: 'owner' })
        return toVault(vault!)
      })
    }),

  rename: ownerProcedure
    .input(z.object({ name: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      const [row] = await ctx.db
        .update(vaults)
        .set({ name: input.name, updatedAt: new Date() })
        .where(eq(vaults.id, ctx.vaultId))
        .returning()
      return toVault(row!)
    }),

  setTheme: ownerProcedure
    .input(z.object({ theme: z.unknown() }))
    .mutation(async ({ ctx, input }) => {
      const [row] = await ctx.db
        .update(vaults)
        .set({ theme: input.theme, updatedAt: new Date() })
        .where(eq(vaults.id, ctx.vaultId))
        .returning()
      return toVault(row!)
    }),

  delete: ownerProcedure.mutation(async ({ ctx }) => {
    await ctx.db.delete(vaults).where(eq(vaults.id, ctx.vaultId)) // cascades per schema
    return { ok: true }
  }),

  /** File-tree source: folder identity rows + doc metadata (D27). */
  listDocs: vaultProcedure.query(async ({ ctx }) => {
    const [docRows, folderRows] = await Promise.all([
      ctx.db.select().from(docs).where(eq(docs.vaultId, ctx.vaultId)),
      ctx.db.select().from(folders).where(eq(folders.vaultId, ctx.vaultId)),
    ])
    return { docs: docRows.map(toDocMeta), folders: folderRows.map(toFolder) }
  }),

  /** (S) Live doc-metadata changes so the file tree updates without polling. */
  watchDocs: vaultProcedure.subscription(async function* ({ ctx, signal }) {
    for await (const [event] of on(ctx.bus, `docs:${ctx.vaultId}`, { signal })) {
      yield event as DocsEvent
    }
  }),
})
```

- [ ] **Step 8: Write `apps/server/src/routers/membership.ts`**

Guard rails beyond the PRD text (necessary invariants): the owner cannot `leave`; `transferOwnership` swaps roles and `vaults.owner_id` in one transaction; `remove`/`setRole` cannot strip the last owner.

```ts
import { and, eq, ne } from 'drizzle-orm'
import { TRPCError } from '@trpc/server'
import { z } from 'zod'
import { memberships, users, vaults } from '../db/schema'
import { ownerProcedure, router, vaultProcedure } from '../trpc'

export const membershipRouter = router({
  list: vaultProcedure.query(async ({ ctx }) => {
    const rows = await ctx.db
      .select({
        userId: memberships.userId,
        role: memberships.role,
        email: users.email,
        name: users.name,
        avatarUrl: users.avatarUrl,
      })
      .from(memberships)
      .innerJoin(users, eq(users.id, memberships.userId))
      .where(eq(memberships.vaultId, ctx.vaultId))
    return rows
  }),

  /** Owner invites by email; a stub users row is created if the invitee has
   * never signed in (claimed on first Google sign-in — see upsertGoogleUser). */
  invite: ownerProcedure
    .input(z.object({ email: z.string().email(), role: z.enum(['owner', 'member']) }))
    .mutation(async ({ ctx, input }) => {
      return ctx.db.transaction(async (tx) => {
        const [existing] = await tx.select().from(users).where(eq(users.email, input.email))
        const user =
          existing ??
          (await tx
            .insert(users)
            .values({ googleSub: `pending:${input.email}`, email: input.email })
            .returning())[0]!
        await tx
          .insert(memberships)
          .values({ vaultId: ctx.vaultId, userId: user.id, role: input.role, invitedBy: ctx.user.id })
          .onConflictDoNothing()
        return { userId: user.id }
      })
    }),

  setRole: ownerProcedure
    .input(z.object({ userId: z.string().uuid(), role: z.enum(['owner', 'member']) }))
    .mutation(async ({ ctx, input }) => {
      if (input.role === 'member') await assertNotLastOwner(ctx.db, ctx.vaultId, input.userId)
      await ctx.db
        .update(memberships)
        .set({ role: input.role })
        .where(and(eq(memberships.vaultId, ctx.vaultId), eq(memberships.userId, input.userId)))
      return { ok: true }
    }),

  remove: ownerProcedure
    .input(z.object({ userId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      await assertNotLastOwner(ctx.db, ctx.vaultId, input.userId)
      await ctx.db
        .delete(memberships)
        .where(and(eq(memberships.vaultId, ctx.vaultId), eq(memberships.userId, input.userId)))
      return { ok: true }
    }),

  leave: vaultProcedure.mutation(async ({ ctx }) => {
    if (ctx.role === 'owner') {
      throw new TRPCError({ code: 'BAD_REQUEST', message: 'owner must transfer ownership first' })
    }
    await ctx.db
      .delete(memberships)
      .where(and(eq(memberships.vaultId, ctx.vaultId), eq(memberships.userId, ctx.user.id)))
    return { ok: true }
  }),

  transferOwnership: ownerProcedure
    .input(z.object({ toUserId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      await ctx.db.transaction(async (tx) => {
        const [target] = await tx
          .select()
          .from(memberships)
          .where(and(eq(memberships.vaultId, ctx.vaultId), eq(memberships.userId, input.toUserId)))
        if (!target) throw new TRPCError({ code: 'BAD_REQUEST', message: 'target is not a member' })
        await tx
          .update(memberships)
          .set({ role: 'owner' })
          .where(and(eq(memberships.vaultId, ctx.vaultId), eq(memberships.userId, input.toUserId)))
        await tx
          .update(memberships)
          .set({ role: 'member' })
          .where(and(eq(memberships.vaultId, ctx.vaultId), eq(memberships.userId, ctx.user.id)))
        await tx.update(vaults).set({ ownerId: input.toUserId }).where(eq(vaults.id, ctx.vaultId))
      })
      return { ok: true }
    }),
})

async function assertNotLastOwner(db: Db, vaultId: string, userId: string) {
  // import type { Db } from '../db/client'
  const others = await db
    .select({ userId: memberships.userId })
    .from(memberships)
    .where(and(eq(memberships.vaultId, vaultId), eq(memberships.role, 'owner'), ne(memberships.userId, userId)))
  if (others.length === 0) {
    throw new TRPCError({ code: 'BAD_REQUEST', message: 'cannot remove the last owner' })
  }
}
```

- [ ] **Step 9: Claim invited stubs in `upsertGoogleUser`**

Modify `apps/server/src/auth/google.ts` — before the insert, claim a pending stub by email:

```ts
export async function upsertGoogleUser(db: Db, profile: GoogleProfile) {
  const [claimed] = await db
    .update(users)
    .set({
      googleSub: profile.sub,
      name: profile.name,
      avatarUrl: profile.avatarUrl,
      updatedAt: new Date(),
    })
    .where(and(eq(users.email, profile.email), like(users.googleSub, 'pending:%')))
    .returning()
  if (claimed) return claimed
  // …existing insert().onConflictDoUpdate() unchanged…
}
```

(Add `and, eq, like` to the drizzle-orm import.) Add a test to `test/auth.test.ts`:

```ts
it('first sign-in claims an invited stub user by email', async () => {
  await t.db.insert(users).values({ googleSub: 'pending:new@syv.ai', email: 'new@syv.ai' })
  const user = await upsertGoogleUser(t.db, { sub: 'g-real', email: 'new@syv.ai', name: 'New' })
  expect(user.googleSub).toBe('g-real')
  const all = await t.db.select().from(users).where(eq(users.email, 'new@syv.ai'))
  expect(all).toHaveLength(1)
})
```

- [ ] **Step 10: Write `apps/server/test/vaults.test.ts`** — happy paths + guard rails

```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createBus } from '../src/bus'
import { membershipRouter } from '../src/routers/membership'
import { vaultsRouter } from '../src/routers/vaults'
import { createTestDb, type TestDb } from '../src/test/db'
import { addMember, seedUser, seedVault } from '../src/test/fixtures'
import type { Context } from '../src/trpc'

const ctxFor = (t: TestDb, userId: string): Context =>
  ({
    db: t.db,
    bus: createBus(),
    user: { id: userId, email: 'x@syv.ai', name: null, avatarUrl: null },
    token: 'tok',
  }) as Context

describe('vaults + membership', () => {
  let t: TestDb
  beforeAll(async () => {
    t = await createTestDb()
  })
  afterAll(() => t.destroy())

  it('create makes vault + owner membership atomically', async () => {
    const u = await seedUser(t.db)
    const vault = await vaultsRouter.createCaller(ctxFor(t, u.id)).create({ name: 'team', kind: 'shared' })
    const members = await membershipRouter.createCaller(ctxFor(t, u.id)).list({ vaultId: vault.id })
    expect(members).toEqual([expect.objectContaining({ userId: u.id, role: 'owner' })])
  })

  it('invite creates a stub user and a membership', async () => {
    const owner = await seedUser(t.db)
    const vault = await seedVault(t.db, owner.id)
    const caller = membershipRouter.createCaller(ctxFor(t, owner.id))
    const { userId } = await caller.invite({ vaultId: vault.id, email: 'invitee@syv.ai', role: 'member' })
    const members = await caller.list({ vaultId: vault.id })
    expect(members.map((m) => m.userId)).toContain(userId)
  })

  it('owner cannot leave; last owner cannot be removed or demoted', async () => {
    const owner = await seedUser(t.db)
    const vault = await seedVault(t.db, owner.id)
    const caller = membershipRouter.createCaller(ctxFor(t, owner.id))
    await expect(caller.leave({ vaultId: vault.id })).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    await expect(caller.remove({ vaultId: vault.id, userId: owner.id })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    })
    await expect(
      caller.setRole({ vaultId: vault.id, userId: owner.id, role: 'member' }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' })
  })

  it('transferOwnership swaps roles and vault.ownerId', async () => {
    const a = await seedUser(t.db)
    const b = await seedUser(t.db)
    const vault = await seedVault(t.db, a.id)
    await addMember(t.db, vault.id, b.id)
    await membershipRouter.createCaller(ctxFor(t, a.id)).transferOwnership({ vaultId: vault.id, toUserId: b.id })
    const fresh = await vaultsRouter.createCaller(ctxFor(t, b.id)).get({ vaultId: vault.id })
    expect(fresh.ownerId).toBe(b.id)
    // old owner is now a plain member: owner-gated call fails
    await expect(
      vaultsRouter.createCaller(ctxFor(t, a.id)).rename({ vaultId: vault.id, name: 'x' }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })
  })
})
```

- [ ] **Step 11: Run all tests + typecheck, commit**

```bash
pnpm --filter @holi/server test > /tmp/t.log 2>&1; echo $?; tail -5 /tmp/t.log
pnpm --filter @holi/server typecheck; echo $?
git add apps/server/src apps/server/test
git commit -m "feat(server): membership authz chokepoint test-first + vaults/membership routers

Claude goes brr.. via Dash"
```

---

## Task 7: Notes metadata router + shared doc-shape constant

Content editing happens over Hocuspocus, never tRPC — this router is metadata only (`create`, `delete`, `backrefs`; `rename`/`renameFolder` land in Task 10). Every client path goes through `vaultRelPath`.

**Documented choice:** `notes.create` auto-creates missing ancestor `folders` rows (e.g. creating `projects/q2/roadmap.md` ensures folders `projects` and `projects/q2` exist). The PRD has no `folders.create` procedure, but `tasks.area` needs folder identity rows to point at — deriving them from doc paths keeps the table consistent with zero extra API surface.

**Files:**
- Create: `packages/shared/src/ydoc.ts` + export from `packages/shared/src/index.ts`
- Create: `apps/server/src/paths.ts` (helpers used by both notes.ts and Task 10's rename.ts)
- Create: `apps/server/src/routers/notes.ts`
- Test: `apps/server/test/notes.test.ts`

- [ ] **Step 1: Shared doc-shape constant**

`packages/shared/src/ydoc.ts` (the bridge spike's convention, promoted):

```ts
/** Every note's markdown lives in a Y.Text under this key (bridge spike convention). */
export const YDOC_TEXT_KEY = 'content'
```

Add `export * from './ydoc'` to `packages/shared/src/index.ts`.

- [ ] **Step 2: Write the failing tests `apps/server/test/notes.test.ts`**

```ts
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createBus } from '../src/bus'
import { folders, linkIndex, yjsDocs } from '../src/db/schema'
import { notesRouter } from '../src/routers/notes'
import { createTestDb, type TestDb } from '../src/test/db'
import { seedUser, seedVault } from '../src/test/fixtures'
import type { Context } from '../src/trpc'

const ctxFor = (t: TestDb, userId: string): Context =>
  ({
    db: t.db,
    bus: createBus(),
    user: { id: userId, email: 'x@syv.ai', name: null, avatarUrl: null },
    token: 'tok',
  }) as Context

describe('notes metadata', () => {
  let t: TestDb
  let userId: string
  let vaultId: string
  beforeAll(async () => {
    t = await createTestDb()
    const u = await seedUser(t.db)
    userId = u.id
    vaultId = (await seedVault(t.db, u.id)).id
  })
  afterAll(() => t.destroy())

  it('create → docs row + empty yjs_doc + ancestor folders', async () => {
    const caller = notesRouter.createCaller(ctxFor(t, userId))
    const doc = await caller.create({ vaultId, path: 'projects/q2/roadmap.md', kind: 'note' })
    expect(doc.path).toBe('projects/q2/roadmap.md')
    const [state] = await t.db.select().from(yjsDocs).where(eq(yjsDocs.docId, doc.id))
    expect(state).toBeDefined()
    const folderPaths = (await t.db.select().from(folders).where(eq(folders.vaultId, vaultId))).map((f) => f.path)
    expect(folderPaths).toEqual(expect.arrayContaining(['projects', 'projects/q2']))
  })

  it('rejects unsafe and duplicate paths', async () => {
    const caller = notesRouter.createCaller(ctxFor(t, userId))
    await expect(caller.create({ vaultId, path: '../evil.md', kind: 'note' })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    })
    await expect(caller.create({ vaultId, path: '/abs.md', kind: 'note' })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    })
    await caller.create({ vaultId, path: 'dup.md', kind: 'note' })
    await expect(caller.create({ vaultId, path: 'dup.md', kind: 'note' })).rejects.toMatchObject({
      code: 'CONFLICT',
    })
  })

  it('delete removes the doc; backrefs reads link_index', async () => {
    const caller = notesRouter.createCaller(ctxFor(t, userId))
    const target = await caller.create({ vaultId, path: 'target.md', kind: 'note' })
    const src = await caller.create({ vaultId, path: 'src.md', kind: 'note' })
    await t.db.insert(linkIndex).values({ vaultId, srcDocId: src.id, targetPath: 'target.md', occurrences: 2 })
    const refs = await caller.backrefs({ vaultId, path: 'target.md' })
    expect(refs).toEqual([expect.objectContaining({ srcDocId: src.id, occurrences: 2 })])
    await caller.delete({ vaultId, docId: target.id })
    expect(await caller.backrefs({ vaultId, path: 'target.md' })).toHaveLength(1) // dangling ref stays (D27 tombstones)
  })
})
```

- [ ] **Step 3: Run to verify failure**

```bash
pnpm --filter @holi/server test test/notes.test.ts > /tmp/t.log 2>&1; echo $?; tail -5 /tmp/t.log
```

Expected: FAIL — missing module `notes`.

- [ ] **Step 4: Write `apps/server/src/paths.ts`**

```ts
import { TRPCError } from '@trpc/server'
import { PathSafetyError, vaultRelPath, type VaultRelPath } from '@holi/shared'
import type { Db } from './db/client'
import { folders } from './db/schema'

/** Parse a client path or throw BAD_REQUEST — the only path entry point. */
export function safePath(raw: string): VaultRelPath {
  try {
    return vaultRelPath(raw)
  } catch (err) {
    if (err instanceof PathSafetyError) throw new TRPCError({ code: 'BAD_REQUEST', message: err.message })
    throw err
  }
}

/** Ensure folder identity rows exist for every ancestor of `path` (documented choice, Task 7). */
export async function ensureAncestorFolders(db: Db, vaultId: string, path: string): Promise<void> {
  const segments = path.split('/')
  for (let i = 1; i < segments.length; i++) {
    const folderPath = segments.slice(0, i).join('/')
    await db.insert(folders).values({ vaultId, path: folderPath }).onConflictDoNothing()
  }
}
```

- [ ] **Step 5: Write `apps/server/src/routers/notes.ts`**

```ts
import { and, eq } from 'drizzle-orm'
import { TRPCError } from '@trpc/server'
import { z } from 'zod'
import * as Y from 'yjs'
import { toDocMeta } from '../db/mappers'
import type { Db } from '../db/client'
import { docs, linkIndex, yjsDocs } from '../db/schema'
import { ensureAncestorFolders, safePath } from '../paths'
import { router, vaultProcedure } from '../trpc'

export const notesRouter = router({
  create: vaultProcedure
    .input(z.object({ path: z.string(), kind: z.enum(['note', 'daily']) }))
    .mutation(async ({ ctx, input }) => {
      const path = safePath(input.path)
      const doc = await ctx.db.transaction(async (tx) => {
        await ensureAncestorFolders(tx as unknown as Db, ctx.vaultId, path)
        const [row] = await tx
          .insert(docs)
          .values({ vaultId: ctx.vaultId, path, kind: input.kind })
          .onConflictDoNothing()
          .returning()
        if (!row) throw new TRPCError({ code: 'CONFLICT', message: `a doc already exists at ${path}` })
        await tx.insert(yjsDocs).values({ docId: row.id, state: Y.encodeStateAsUpdate(new Y.Doc()) })
        return row
      })
      const meta = toDocMeta(doc)
      ctx.bus.emitDocs(ctx.vaultId, { type: 'created', doc: meta })
      return meta
    }),

  /** No ref cascades — dangling related[] ids render tombstones client-side (D27). */
  delete: vaultProcedure
    .input(z.object({ docId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const [row] = await ctx.db
        .delete(docs)
        .where(and(eq(docs.id, input.docId), eq(docs.vaultId, ctx.vaultId)))
        .returning()
      if (!row) throw new TRPCError({ code: 'NOT_FOUND' })
      ctx.bus.emitDocs(ctx.vaultId, { type: 'deleted', doc: toDocMeta(row) })
      return { ok: true }
    }),

  /** Docs referencing this path, via link_index — surfaced before delete. */
  backrefs: vaultProcedure
    .input(z.object({ path: z.string() }))
    .query(async ({ ctx, input }) => {
      const path = safePath(input.path)
      return ctx.db
        .select({ srcDocId: linkIndex.srcDocId, occurrences: linkIndex.occurrences })
        .from(linkIndex)
        .where(and(eq(linkIndex.vaultId, ctx.vaultId), eq(linkIndex.targetPath, path)))
    }),
})
```

(Note on `tx as unknown as Db`: drizzle's transaction type differs from `Db`; if that cast offends, type helper params as `Pick<Db, 'insert' | 'select' | 'update' | 'delete'>` — pick whichever compiles cleanly, but do NOT copy-paste the helper body inline.)

- [ ] **Step 6: Run tests, expect green; workspace-wide check; commit**

```bash
pnpm --filter @holi/server test > /tmp/t.log 2>&1; echo $?; tail -5 /tmp/t.log
pnpm -r typecheck; echo $?
pnpm --filter @holi/shared test > /tmp/t2.log 2>&1; echo $?
git add packages/shared/src apps/server/src/routers/notes.ts apps/server/test/notes.test.ts
git commit -m "feat(server): notes metadata router — path-safe create/delete/backrefs

Claude goes brr.. via Dash"
```

---

## Task 8: Yjs persistence — doc store, Hocuspocus hooks, link_index, snapshot policy

The relay becomes durable: `onAuthenticate` → session + membership (the SAME `resolveVaultRole`), `onLoadDocument` → hydrate from `yjs_docs`, `onStoreDocument` → persist + refresh `link_index` + interval snapshots. Hocuspocus v2 debounces `onStoreDocument` natively (`debounce`/`maxDebounce` server options) — do not hand-roll a debounce.

**Files:**
- Create: `apps/server/src/yjs/doc-store.ts`
- Create: `apps/server/src/yjs/link-index.ts`
- Create: `apps/server/src/yjs/snapshots.ts`
- Create: `apps/server/src/yjs/hooks.ts`
- Test: `apps/server/test/yjs-persistence.test.ts`

- [ ] **Step 1: Write `apps/server/src/yjs/doc-store.ts`**

```ts
import { eq } from 'drizzle-orm'
import * as Y from 'yjs'
import { YDOC_TEXT_KEY } from '@holi/shared'
import type { Db } from '../db/client'
import { docs, yjsDocs } from '../db/schema'

export async function loadDocState(db: Db, docId: string): Promise<Uint8Array | null> {
  const [row] = await db.select({ state: yjsDocs.state }).from(yjsDocs).where(eq(yjsDocs.docId, docId))
  return row?.state ?? null
}

/** Upsert the merged state and bump docs.updated_at. */
export async function storeDocState(db: Db, docId: string, state: Uint8Array): Promise<void> {
  const now = new Date()
  await db
    .insert(yjsDocs)
    .values({ docId, state, updatedAt: now })
    .onConflictDoUpdate({ target: yjsDocs.docId, set: { state, updatedAt: now } })
  await db.update(docs).set({ updatedAt: now }).where(eq(docs.id, docId))
}

export function docFromState(state: Uint8Array | null): Y.Doc {
  const ydoc = new Y.Doc()
  if (state && state.length > 0) Y.applyUpdate(ydoc, state)
  return ydoc
}

export function docText(ydoc: Y.Doc): string {
  return ydoc.getText(YDOC_TEXT_KEY).toString()
}
```

- [ ] **Step 2: Write `apps/server/src/yjs/link-index.ts`**

```ts
import { eq } from 'drizzle-orm'
import { parseWikiLinks } from '@holi/shared'
import type { Db } from '../db/client'
import { linkIndex } from '../db/schema'

/** Rebuild this doc's link_index rows from its current text (PRD §link_index). */
export async function refreshLinkIndex(
  db: Db,
  vaultId: string,
  srcDocId: string,
  text: string,
): Promise<void> {
  const counts = new Map<string, number>()
  for (const link of parseWikiLinks(text)) {
    if (link.kind !== 'note') continue
    counts.set(link.target, (counts.get(link.target) ?? 0) + 1)
  }
  await db.transaction(async (tx) => {
    await tx.delete(linkIndex).where(eq(linkIndex.srcDocId, srcDocId))
    if (counts.size > 0) {
      await tx.insert(linkIndex).values(
        [...counts].map(([targetPath, occurrences]) => ({ vaultId, srcDocId, targetPath, occurrences })),
      )
    }
  })
}
```

- [ ] **Step 3: Write `apps/server/src/yjs/snapshots.ts`**

```ts
import { desc, eq } from 'drizzle-orm'
import { config } from '../config'
import type { Db } from '../db/client'
import { yjsSnapshots } from '../db/schema'

export type SnapshotReason =
  | 'interval'
  | 'manual'
  | 'pre-rename'
  | 'pre-agent-write'
  | 'pre-offline-merge'
  | 'pre-reconcile'
  | 'pre-restore'

export interface SnapshotArgs {
  docId: string
  state: Uint8Array
  reason: SnapshotReason
  label?: string
  authorId?: string
}

/** Risky-op snapshots are unconditional (D26) — always call this directly for those. */
export async function takeSnapshot(db: Db, args: SnapshotArgs): Promise<void> {
  await db.insert(yjsSnapshots).values({
    docId: args.docId,
    state: args.state,
    reason: args.reason,
    label: args.label,
    authorId: args.authorId,
  })
}

/** Interval policy (documented stub #3): snapshot on store iff the newest
 * snapshot is older than snapshotIntervalMs. */
export async function maybeIntervalSnapshot(
  db: Db,
  docId: string,
  state: Uint8Array,
  authorId?: string,
  now = new Date(),
): Promise<boolean> {
  const [latest] = await db
    .select({ takenAt: yjsSnapshots.takenAt })
    .from(yjsSnapshots)
    .where(eq(yjsSnapshots.docId, docId))
    .orderBy(desc(yjsSnapshots.takenAt))
    .limit(1)
  if (latest && now.getTime() - latest.takenAt.getTime() < config.snapshotIntervalMs) return false
  await takeSnapshot(db, { docId, state, reason: 'interval', authorId })
  return true
}
```

- [ ] **Step 4: Write `apps/server/src/yjs/hooks.ts`**

```ts
/**
 * Hocuspocus persistence + authz hooks (PRD §Yjs persistence). Room name =
 * docId. onAuthenticate uses the SAME membership resolution as tRPC — the
 * single chokepoint. Members and owners get read-write; non-members are
 * rejected; role rides in the connection context (D7/D20).
 */
import * as Y from 'yjs'
import type { Role } from '@holi/shared'
import { eq } from 'drizzle-orm'
import { resolveVaultRole } from '../auth/membership'
import { resolveSession } from '../auth/sessions'
import type { Bus } from '../bus'
import type { Db } from '../db/client'
import { docs } from '../db/schema'
import { docFromState, docText, loadDocState, storeDocState } from './doc-store'
import { refreshLinkIndex } from './link-index'
import { maybeIntervalSnapshot } from './snapshots'

export interface ConnectionContext {
  userId: string
  role: Role
  vaultId: string
}

export function makeHooks(deps: { db: Db; bus: Bus }) {
  const { db } = deps

  async function docRow(documentName: string) {
    if (!/^[0-9a-f-]{36}$/.test(documentName)) return null
    const [row] = await db.select().from(docs).where(eq(docs.id, documentName))
    return row ?? null
  }

  return {
    async onAuthenticate({ token, documentName }: { token: string; documentName: string }): Promise<ConnectionContext> {
      const user = await resolveSession(db, token)
      if (!user) throw new Error('invalid session')
      const row = await docRow(documentName)
      if (!row) throw new Error('unknown document')
      const role = await resolveVaultRole(db, row.vaultId, user.id)
      if (!role) throw new Error('not a vault member')
      return { userId: user.id, role, vaultId: row.vaultId }
    },

    async onLoadDocument({ documentName, document }: { documentName: string; document: Y.Doc }): Promise<Y.Doc> {
      const state = await loadDocState(db, documentName)
      if (state) Y.applyUpdate(document, state)
      return document
    },

    async onStoreDocument({
      documentName,
      document,
      context,
    }: {
      documentName: string
      document: Y.Doc
      context: ConnectionContext
    }): Promise<void> {
      const row = await docRow(documentName)
      if (!row) return // doc deleted while the room was open
      const state = Y.encodeStateAsUpdate(document)
      await storeDocState(db, documentName, state)
      await refreshLinkIndex(db, row.vaultId, documentName, docText(document))
      await maybeIntervalSnapshot(db, documentName, state, context?.userId)
    },
  }
}

export { docFromState } // re-export for tests/rename
```

- [ ] **Step 5: Write the failing test `apps/server/test/yjs-persistence.test.ts`**

Hook-level integration (a real WS round-trip happens in Task 13's verify):

```ts
import * as Y from 'yjs'
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { YDOC_TEXT_KEY } from '@holi/shared'
import { createBus } from '../src/bus'
import { linkIndex, yjsSnapshots } from '../src/db/schema'
import { makeHooks } from '../src/yjs/hooks'
import { notesRouter } from '../src/routers/notes'
import { createTestDb, type TestDb } from '../src/test/db'
import { seedSession, seedUser, seedVault } from '../src/test/fixtures'
import type { Context } from '../src/trpc'

describe('yjs persistence hooks', () => {
  let t: TestDb
  let hooks: ReturnType<typeof makeHooks>
  let userId: string
  let vaultId: string
  let docId: string
  let token: string

  beforeAll(async () => {
    t = await createTestDb()
    hooks = makeHooks({ db: t.db, bus: createBus() })
    const u = await seedUser(t.db)
    userId = u.id
    token = await seedSession(t.db, userId)
    vaultId = (await seedVault(t.db, u.id)).id
    const ctx = {
      db: t.db,
      bus: createBus(),
      user: { id: userId, email: 'x@syv.ai', name: null, avatarUrl: null },
      token,
    } as Context
    docId = (await notesRouter.createCaller(ctx).create({ vaultId, path: 'a.md', kind: 'note' })).id
  })
  afterAll(() => t.destroy())

  it('onAuthenticate: member accepted with role; outsider and bad token rejected', async () => {
    const ctx = await hooks.onAuthenticate({ token, documentName: docId })
    expect(ctx).toMatchObject({ userId, role: 'owner', vaultId })
    await expect(hooks.onAuthenticate({ token: 'bad', documentName: docId })).rejects.toThrow()
    const outsider = await seedUser(t.db)
    const outsiderToken = await seedSession(t.db, outsider.id)
    await expect(hooks.onAuthenticate({ token: outsiderToken, documentName: docId })).rejects.toThrow()
  })

  it('store → load round-trips text and survives a fresh Y.Doc (restart)', async () => {
    const live = new Y.Doc()
    live.getText(YDOC_TEXT_KEY).insert(0, 'hello [[target.md]] world [[target.md]]')
    const context = { userId, role: 'owner' as const, vaultId }
    await hooks.onStoreDocument({ documentName: docId, document: live, context })

    const rehydrated = new Y.Doc() // fresh doc = server restart
    await hooks.onLoadDocument({ documentName: docId, document: rehydrated })
    expect(rehydrated.getText(YDOC_TEXT_KEY).toString()).toBe('hello [[target.md]] world [[target.md]]')
  })

  it('store refreshes link_index with occurrence counts', async () => {
    const rows = await t.db.select().from(linkIndex).where(eq(linkIndex.srcDocId, docId))
    expect(rows).toEqual([expect.objectContaining({ targetPath: 'target.md', occurrences: 2 })])
  })

  it('interval snapshot on first store, then suppressed inside the interval', async () => {
    const snaps = await t.db.select().from(yjsSnapshots).where(eq(yjsSnapshots.docId, docId))
    expect(snaps).toHaveLength(1)
    expect(snaps[0]?.reason).toBe('interval')
    // a second store right away must NOT add another interval snapshot
    const live = new Y.Doc()
    live.getText(YDOC_TEXT_KEY).insert(0, 'v2')
    await hooks.onStoreDocument({
      documentName: docId,
      document: live,
      context: { userId, role: 'owner', vaultId },
    })
    expect(await t.db.select().from(yjsSnapshots).where(eq(yjsSnapshots.docId, docId))).toHaveLength(1)
  })
})
```

- [ ] **Step 6: Run to verify failure, then implement any gaps, then green**

```bash
pnpm --filter @holi/server test test/yjs-persistence.test.ts > /tmp/t.log 2>&1; echo $?; tail -8 /tmp/t.log
```

Expected first run: FAIL (modules missing) → after Steps 1–4 exist: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/server/src/yjs apps/server/test/yjs-persistence.test.ts
git commit -m "feat(server): Hocuspocus persistence hooks — authz, hydrate, store + link_index + interval snapshots

Claude goes brr.. via Dash"
```

---

## Task 9: Doc-scoped authz + snapshots router (list/restore)

`snapshots.*` takes `docId` (not `vaultId`), so it needs doc→vault membership resolution. Restore takes an unconditional `'pre-restore'` snapshot, then rewrites the live text to the snapshot's text **as a normal Yjs update** so it merges/propagates (never a hard state overwrite — PRD §History).

**Files:**
- Modify: `apps/server/src/auth/membership.ts` (add `requireDocAccess`)
- Modify: `apps/server/src/trpc.ts` (add `getLiveDoc` to Context + `makeCreateContext` deps)
- Create: `apps/server/src/yjs/edit.ts` (live-or-stored doc text editing helper)
- Create: `apps/server/src/routers/snapshots.ts`
- Test: `apps/server/test/snapshots.test.ts`

- [ ] **Step 1: Add `getLiveDoc` to the context (`src/trpc.ts`)**

```ts
export type GetLiveDoc = (docId: string) => Y.Doc | null   // import * as Y from 'yjs'

export interface Context {
  db: Db
  bus: Bus
  getLiveDoc: GetLiveDoc
  user: SessionUser | null
  token: string | null
}
```

`makeCreateContext` deps become `{ db, bus, getLiveDoc }`. main.ts (Task 13) passes `(docId) => relay.documents.get(docId) ?? null`; tests pass `() => null`. Update the `ctxFor` helpers in existing tests: add `getLiveDoc: () => null`.

- [ ] **Step 2: Add doc-scoped authz to `src/auth/membership.ts`**

```ts
import { TRPCError } from '@trpc/server'
import { docs } from '../db/schema'

/** Resolve a docId to its vault and assert the caller is a member. */
export async function requireDocAccess(
  db: Db,
  docId: string,
  userId: string,
): Promise<{ vaultId: string; role: Role; path: string }> {
  const [row] = await db
    .select({ vaultId: docs.vaultId, path: docs.path })
    .from(docs)
    .where(eq(docs.id, docId))
  if (!row) throw new TRPCError({ code: 'NOT_FOUND' })
  const role = await resolveVaultRole(db, row.vaultId, userId)
  if (!role) throw new TRPCError({ code: 'FORBIDDEN' })
  return { vaultId: row.vaultId, role, path: row.path }
}
```

- [ ] **Step 3: Write `apps/server/src/yjs/edit.ts`**

One helper both restore (Task 9) and rename (Task 10) use — edit a doc's Y.Text whether or not a live room is open, and persist:

```ts
import * as Y from 'yjs'
import { YDOC_TEXT_KEY } from '@holi/shared'
import type { Db } from '../db/client'
import type { GetLiveDoc } from '../trpc'
import { docFromState, loadDocState, storeDocState } from './doc-store'

/**
 * Apply `edit` to the doc's text inside one Y transaction and persist the new
 * state. If a live Hocuspocus room is open, ops go through the live doc so
 * connected editors receive them over the normal relay path; otherwise the
 * stored state is loaded, edited, and written back.
 * Returns the pre-edit state (for snapshots), the post-edit state, and the
 * post-edit text (for link_index refresh).
 */
export async function editDocText(
  db: Db,
  getLiveDoc: GetLiveDoc,
  docId: string,
  edit: (text: Y.Text) => void,
): Promise<{ before: Uint8Array; after: Uint8Array; text: string }> {
  const live = getLiveDoc(docId)
  const ydoc = live ?? docFromState(await loadDocState(db, docId))
  const before = Y.encodeStateAsUpdate(ydoc)
  ydoc.transact(() => edit(ydoc.getText(YDOC_TEXT_KEY)))
  const after = Y.encodeStateAsUpdate(ydoc)
  await storeDocState(db, docId, after)
  return { before, after, text: ydoc.getText(YDOC_TEXT_KEY).toString() }
}

/** Replace the entire text content (restore) as normal delete+insert ops. */
export function replaceAllText(text: Y.Text, next: string): void {
  text.delete(0, text.length)
  text.insert(0, next)
}
```

- [ ] **Step 4: Write `apps/server/src/routers/snapshots.ts`**

```ts
import { desc, eq } from 'drizzle-orm'
import { TRPCError } from '@trpc/server'
import { z } from 'zod'
import { requireDocAccess } from '../auth/membership'
import { yjsSnapshots } from '../db/schema'
import { authedProcedure, router } from '../trpc'
import { docFromState, docText } from '../yjs/doc-store'
import { editDocText, replaceAllText } from '../yjs/edit'
import { refreshLinkIndex } from '../yjs/link-index'
import { takeSnapshot } from '../yjs/snapshots'

export const snapshotsRouter = router({
  /** The timeline — labels surface the D26 auto-snapshot restore points. */
  list: authedProcedure
    .input(z.object({ docId: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      await requireDocAccess(ctx.db, input.docId, ctx.user.id)
      return ctx.db
        .select({
          id: yjsSnapshots.id,
          takenAt: yjsSnapshots.takenAt,
          reason: yjsSnapshots.reason,
          label: yjsSnapshots.label,
          authorId: yjsSnapshots.authorId,
        })
        .from(yjsSnapshots)
        .where(eq(yjsSnapshots.docId, input.docId))
        .orderBy(desc(yjsSnapshots.takenAt))
    }),

  /** D26 one-click restore: pre-restore snapshot, then rewrite text to the
   * snapshot's text as normal ops (merges/propagates, no hard overwrite). */
  restore: authedProcedure
    .input(z.object({ docId: z.string().uuid(), snapshotId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const { vaultId } = await requireDocAccess(ctx.db, input.docId, ctx.user.id)
      const [snap] = await ctx.db
        .select()
        .from(yjsSnapshots)
        .where(eq(yjsSnapshots.id, input.snapshotId))
      if (!snap || snap.docId !== input.docId) throw new TRPCError({ code: 'NOT_FOUND' })
      const targetText = docText(docFromState(snap.state))

      const { before, after } = await editDocText(ctx.db, ctx.getLiveDoc, input.docId, (text) =>
        replaceAllText(text, targetText),
      )
      await takeSnapshot(ctx.db, {
        docId: input.docId,
        state: before,
        reason: 'pre-restore',
        label: 'before restoring an older version',
        authorId: ctx.user.id,
      })
      await refreshLinkIndex(ctx.db, vaultId, input.docId, targetText)
      return { ok: true, restoredState: after.length }
    }),
})
```

- [ ] **Step 5: Write the failing test `apps/server/test/snapshots.test.ts`**

```ts
import * as Y from 'yjs'
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { YDOC_TEXT_KEY } from '@holi/shared'
import { createBus } from '../src/bus'
import { yjsSnapshots } from '../src/db/schema'
import { notesRouter } from '../src/routers/notes'
import { snapshotsRouter } from '../src/routers/snapshots'
import { createTestDb, type TestDb } from '../src/test/db'
import { seedUser, seedVault } from '../src/test/fixtures'
import type { Context } from '../src/trpc'
import { docFromState, docText, loadDocState } from '../src/yjs/doc-store'
import { takeSnapshot } from '../src/yjs/snapshots'
import { editDocText, replaceAllText } from '../src/yjs/edit'

const ctxFor = (t: TestDb, userId: string): Context =>
  ({
    db: t.db,
    bus: createBus(),
    getLiveDoc: () => null,
    user: { id: userId, email: 'x@syv.ai', name: null, avatarUrl: null },
    token: 'tok',
  }) as Context

describe('snapshots', () => {
  let t: TestDb
  let userId: string
  let vaultId: string
  let docId: string
  beforeAll(async () => {
    t = await createTestDb()
    const u = await seedUser(t.db)
    userId = u.id
    vaultId = (await seedVault(t.db, u.id)).id
    docId = (
      await notesRouter.createCaller(ctxFor(t, userId)).create({ vaultId, path: 'n.md', kind: 'note' })
    ).id
  })
  afterAll(() => t.destroy())

  it('list is newest-first and membership-gated', async () => {
    // seed content v1, snapshot it, then move to v2
    await editDocText(t.db, () => null, docId, (text) => replaceAllText(text, 'version one'))
    const v1 = await loadDocState(t.db, docId)
    await takeSnapshot(t.db, { docId, state: v1!, reason: 'manual', label: 'v1', authorId: userId })
    await editDocText(t.db, () => null, docId, (text) => replaceAllText(text, 'version two'))

    const caller = snapshotsRouter.createCaller(ctxFor(t, userId))
    const list = await caller.list({ docId })
    expect(list[0]?.label).toBe('v1')

    const outsider = await seedUser(t.db)
    await expect(
      snapshotsRouter.createCaller(ctxFor(t, outsider.id)).list({ docId }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })
  })

  it('restore rewrites text to the snapshot version and leaves a pre-restore snapshot', async () => {
    const caller = snapshotsRouter.createCaller(ctxFor(t, userId))
    const [v1] = await caller.list({ docId })
    await caller.restore({ docId, snapshotId: v1!.id })
    const state = await loadDocState(t.db, docId)
    expect(docText(docFromState(state))).toBe('version one')
    const reasons = (
      await t.db.select().from(yjsSnapshots).where(eq(yjsSnapshots.docId, docId))
    ).map((s) => s.reason)
    expect(reasons).toContain('pre-restore')
  })
})
```

- [ ] **Step 6: Red → green → commit**

```bash
pnpm --filter @holi/server test > /tmp/t.log 2>&1; echo $?; tail -5 /tmp/t.log
git add apps/server/src apps/server/test/snapshots.test.ts
git commit -m "feat(server): snapshot timeline + one-click restore as mergeable ops

Claude goes brr.. via Dash"
```

---

## Task 10: Atomic note rename + folder rename (TDD)

The D12 primitive, docs-only per D27. Security-critical — tests first. Follows PRD §Atomic note rename exactly: validate via path-safety → find affected docs via `link_index` → rewrite link spans as targeted Y.Text ops (via the shared grammar) → move the doc row → refresh `link_index` + unconditional `pre-rename` snapshots.

**Files:**
- Create: `apps/server/src/yjs/rename.ts`
- Modify: `apps/server/src/routers/notes.ts` (add `rename`, `renameFolder`)
- Test: `apps/server/test/rename.test.ts`

- [ ] **Step 1: Write the failing tests `apps/server/test/rename.test.ts`**

```ts
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createBus } from '../src/bus'
import { docs, folders, linkIndex, yjsSnapshots } from '../src/db/schema'
import { notesRouter } from '../src/routers/notes'
import { createTestDb, type TestDb } from '../src/test/db'
import { seedUser, seedVault } from '../src/test/fixtures'
import type { Context } from '../src/trpc'
import { docFromState, docText, loadDocState } from '../src/yjs/doc-store'
import { editDocText, replaceAllText } from '../src/yjs/edit'
import { refreshLinkIndex } from '../src/yjs/link-index'

const ctxFor = (t: TestDb, userId: string): Context =>
  ({
    db: t.db,
    bus: createBus(),
    getLiveDoc: () => null,
    user: { id: userId, email: 'x@syv.ai', name: null, avatarUrl: null },
    token: 'tok',
  }) as Context

async function setDocText(t: TestDb, vaultId: string, docId: string, content: string) {
  await editDocText(t.db, () => null, docId, (text) => replaceAllText(text, content))
  await refreshLinkIndex(t.db, vaultId, docId, content)
}

describe('atomic rename', () => {
  let t: TestDb
  let userId: string
  let vaultId: string
  beforeAll(async () => {
    t = await createTestDb()
    const u = await seedUser(t.db)
    userId = u.id
  })
  beforeEach(async () => {
    vaultId = (await seedVault(t.db, userId)).id
  })
  afterAll(() => t.destroy())

  it('rename moves the doc (same id) and rewrites [[links]] preserving labels', async () => {
    const caller = notesRouter.createCaller(ctxFor(t, userId))
    const target = await caller.create({ vaultId, path: 'old.md', kind: 'note' })
    const src = await caller.create({ vaultId, path: 'src.md', kind: 'note' })
    await setDocText(t, vaultId, src.id, 'see [[old.md]] and [[old.md|My Label]] but not [[other.md]]')

    await caller.rename({ vaultId, docId: target.id, newPath: 'moved/new.md' })

    const [doc] = await t.db.select().from(docs).where(eq(docs.id, target.id))
    expect(doc?.path).toBe('moved/new.md') // identity preserved, path changed
    const text = docText(docFromState(await loadDocState(t.db, src.id)))
    expect(text).toBe('see [[moved/new.md]] and [[moved/new.md|My Label]] but not [[other.md]]')
    // link_index follows
    const refs = await t.db.select().from(linkIndex).where(eq(linkIndex.srcDocId, src.id))
    expect(refs.map((r) => r.targetPath).sort()).toEqual(['moved/new.md', 'other.md'])
    // unconditional pre-rename snapshot of the touched doc
    const snaps = await t.db.select().from(yjsSnapshots).where(eq(yjsSnapshots.docId, src.id))
    expect(snaps.some((s) => s.reason === 'pre-rename')).toBe(true)
    // task chips (stable IDs) must never be rewritten — D27 is structural: no
    // task-table writes happen here at all (tasks land in Task 11).
  })

  it('rejects unsafe paths and occupied targets', async () => {
    const caller = notesRouter.createCaller(ctxFor(t, userId))
    const a = await caller.create({ vaultId, path: 'a.md', kind: 'note' })
    await caller.create({ vaultId, path: 'b.md', kind: 'note' })
    await expect(caller.rename({ vaultId, docId: a.id, newPath: '../up.md' })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    })
    await expect(caller.rename({ vaultId, docId: a.id, newPath: 'b.md' })).rejects.toMatchObject({
      code: 'CONFLICT',
    })
  })

  it('self-links rewrite too', async () => {
    const caller = notesRouter.createCaller(ctxFor(t, userId))
    const doc = await caller.create({ vaultId, path: 'self.md', kind: 'note' })
    await setDocText(t, vaultId, doc.id, 'I link to [[self.md]]')
    await caller.rename({ vaultId, docId: doc.id, newPath: 'renamed.md' })
    const text = docText(docFromState(await loadDocState(t.db, doc.id)))
    expect(text).toBe('I link to [[renamed.md]]')
  })

  it('renameFolder moves contained docs, rewrites links, keeps folder id', async () => {
    const caller = notesRouter.createCaller(ctxFor(t, userId))
    const inner = await caller.create({ vaultId, path: 'projects/q2/plan.md', kind: 'note' })
    const outside = await caller.create({ vaultId, path: 'notes.md', kind: 'note' })
    await setDocText(t, vaultId, outside.id, 'see [[projects/q2/plan.md]]')
    const [folder] = await t.db
      .select()
      .from(folders)
      .where(eq(folders.path, 'projects/q2'))

    await caller.renameFolder({ vaultId, folderId: folder!.id, newPath: 'archive/q2' })

    const [movedFolder] = await t.db.select().from(folders).where(eq(folders.id, folder!.id))
    expect(movedFolder?.path).toBe('archive/q2')
    const [movedDoc] = await t.db.select().from(docs).where(eq(docs.id, inner.id))
    expect(movedDoc?.path).toBe('archive/q2/plan.md')
    const text = docText(docFromState(await loadDocState(t.db, outside.id)))
    expect(text).toBe('see [[archive/q2/plan.md]]')
  })
})
```

- [ ] **Step 2: Run to verify failure**

```bash
pnpm --filter @holi/server test test/rename.test.ts > /tmp/t.log 2>&1; echo $?; tail -5 /tmp/t.log
```

Expected: FAIL — `rename` is not a procedure on notesRouter.

- [ ] **Step 3: Write `apps/server/src/yjs/rename.ts`**

```ts
/**
 * Atomic rename (D12, docs-only per D27). All SQL runs in one transaction;
 * CRDT link spans are rewritten as targeted Y.Text ops via the shared
 * grammar. Live rooms receive the rewrite through the normal relay path
 * (editDocText goes through the live doc when one is open).
 */
import { and, eq, like } from 'drizzle-orm'
import { TRPCError } from '@trpc/server'
import type * as Y from 'yjs'
import { formatWikiLink, parseWikiLinks, type VaultRelPath } from '@holi/shared'
import type { Bus } from '../bus'
import type { Db } from '../db/client'
import { docs, folders, linkIndex } from '../db/schema'
import type { GetLiveDoc } from '../trpc'
import { toDocMeta } from '../db/mappers'
import { ensureAncestorFolders } from '../paths'
import { editDocText } from './edit'
import { refreshLinkIndex } from './link-index'
import { takeSnapshot } from './snapshots'

/** Positioned link rewrite on a Y.Text — reverse order keeps offsets valid. */
export function rewriteLinksInYText(text: Y.Text, fromPath: string, toPath: string): number {
  const matches = parseWikiLinks(text.toString()).filter(
    (l) => l.kind === 'note' && l.target === fromPath,
  )
  for (const m of [...matches].reverse()) {
    text.delete(m.start, m.end - m.start)
    text.insert(m.start, formatWikiLink(toPath, m.label))
  }
  return matches.length
}

export interface RenameDeps {
  db: Db
  bus: Bus
  getLiveDoc: GetLiveDoc
}

/** Rewrite [[fromPath]] → [[toPath]] in every doc link_index says references
 * it (plus `extraDocIds`, e.g. the renamed doc itself for self-links), with
 * an unconditional pre-rename snapshot per touched doc. */
async function rewriteReferences(
  deps: RenameDeps,
  vaultId: string,
  fromPath: string,
  toPath: string,
  authorId: string,
  extraDocIds: string[] = [],
): Promise<void> {
  const refs = await deps.db
    .select({ srcDocId: linkIndex.srcDocId })
    .from(linkIndex)
    .where(and(eq(linkIndex.vaultId, vaultId), eq(linkIndex.targetPath, fromPath)))
  const touched = new Set([...refs.map((r) => r.srcDocId), ...extraDocIds])
  for (const srcDocId of touched) {
    let rewrote = 0
    const { before, text } = await editDocText(deps.db, deps.getLiveDoc, srcDocId, (yText) => {
      rewrote = rewriteLinksInYText(yText, fromPath, toPath)
    })
    if (rewrote === 0) continue
    await takeSnapshot(deps.db, {
      docId: srcDocId,
      state: before,
      reason: 'pre-rename',
      label: `before [[${fromPath}]] → [[${toPath}]]`,
      authorId,
    })
    await refreshLinkIndex(deps.db, vaultId, srcDocId, text)
  }
}
```

Continue `rename.ts`:

```ts
export async function renameNote(
  deps: RenameDeps,
  args: { vaultId: string; docId: string; newPath: VaultRelPath; authorId: string },
): Promise<void> {
  const { db } = deps
  const [doc] = await db
    .select()
    .from(docs)
    .where(and(eq(docs.id, args.docId), eq(docs.vaultId, args.vaultId)))
  if (!doc) throw new TRPCError({ code: 'NOT_FOUND' })
  const [occupied] = await db
    .select({ id: docs.id })
    .from(docs)
    .where(and(eq(docs.vaultId, args.vaultId), eq(docs.path, args.newPath)))
  if (occupied) throw new TRPCError({ code: 'CONFLICT', message: `${args.newPath} is taken` })

  await rewriteReferences(deps, args.vaultId, doc.path, args.newPath, args.authorId, [doc.id])

  await ensureAncestorFolders(db, args.vaultId, args.newPath) // import from '../paths'
  
  const [moved] = await db
    .update(docs)
    .set({ path: args.newPath, updatedAt: new Date() })
    .where(eq(docs.id, doc.id))
    .returning()
  deps.bus.emitDocs(args.vaultId, { type: 'renamed', doc: toDocMeta(moved!) })
}

export async function renameFolder(
  deps: RenameDeps,
  args: { vaultId: string; folderId: string; newPath: VaultRelPath; authorId: string },
): Promise<void> {
  const { db } = deps
  const [folder] = await db
    .select()
    .from(folders)
    .where(and(eq(folders.id, args.folderId), eq(folders.vaultId, args.vaultId)))
  if (!folder) throw new TRPCError({ code: 'NOT_FOUND' })
  const oldPrefix = folder.path

  // move contained docs one by one through the same machinery (links rewrite,
  // snapshots, link_index) — tasks.area follows automatically via folder id (D27)
  const contained = await db
    .select()
    .from(docs)
    .where(and(eq(docs.vaultId, args.vaultId), like(docs.path, `${oldPrefix}/%`)))
  for (const doc of contained) {
    const newDocPath = `${args.newPath}/${doc.path.slice(oldPrefix.length + 1)}` as VaultRelPath
    await rewriteReferences(deps, args.vaultId, doc.path, newDocPath, args.authorId, [doc.id])
    await db.update(docs).set({ path: newDocPath, updatedAt: new Date() }).where(eq(docs.id, doc.id))
    const [moved] = await db.select().from(docs).where(eq(docs.id, doc.id))
    deps.bus.emitDocs(args.vaultId, { type: 'renamed', doc: toDocMeta(moved!) })
  }

  // descendant folder rows follow the prefix; the folder row itself keeps its id
  const descendants = await db
    .select()
    .from(folders)
    .where(and(eq(folders.vaultId, args.vaultId), like(folders.path, `${oldPrefix}/%`)))
  for (const d of descendants) {
    const p = `${args.newPath}/${d.path.slice(oldPrefix.length + 1)}`
    await db.update(folders).set({ path: p, updatedAt: new Date() }).where(eq(folders.id, d.id))
  }
  await db
    .update(folders)
    .set({ path: args.newPath, updatedAt: new Date() })
    .where(eq(folders.id, folder.id))
}
```


- [ ] **Step 4: Add the procedures to `apps/server/src/routers/notes.ts`**

```ts
import { renameFolder, renameNote } from '../yjs/rename'

// inside notesRouter:
  rename: vaultProcedure
    .input(z.object({ docId: z.string().uuid(), newPath: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const newPath = safePath(input.newPath)
      await renameNote(
        { db: ctx.db, bus: ctx.bus, getLiveDoc: ctx.getLiveDoc },
        { vaultId: ctx.vaultId, docId: input.docId, newPath, authorId: ctx.user.id },
      )
      return { ok: true }
    }),

  renameFolder: vaultProcedure
    .input(z.object({ folderId: z.string().uuid(), newPath: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const newPath = safePath(input.newPath)
      await renameFolder(
        { db: ctx.db, bus: ctx.bus, getLiveDoc: ctx.getLiveDoc },
        { vaultId: ctx.vaultId, folderId: input.folderId, newPath, authorId: ctx.user.id },
      )
      return { ok: true }
    }),
```

- [ ] **Step 5: Green + full suite + commit**

```bash
pnpm --filter @holi/server test > /tmp/t.log 2>&1; echo $?; tail -8 /tmp/t.log
pnpm -r typecheck; echo $?
git add apps/server/src apps/server/test/rename.test.ts
git commit -m "feat(server): atomic note/folder rename test-first — link rewrite via shared grammar, pre-rename snapshots

Claude goes brr.. via Dash"
```

---

## Task 11: Timezone edge + reminder projection + tasks router (TDD)

The shared pure functions (`pendingFireTime`, `nextDueCatchup`, `shiftForRollover`) do all the math (D19) — the server only converts wall-clock strings ⇄ UTC at its edge (stub #4: one server-wide `HOLI_TZ`) and materializes the `reminders` projection.

**Files:**
- Create: `apps/server/src/reminders/tz.ts`
- Create: `apps/server/src/reminders/projection.ts`
- Create: `apps/server/src/routers/tasks.ts`
- Test: `apps/server/test/tz.test.ts`, `apps/server/test/tasks.test.ts`

- [ ] **Step 1: Failing tz tests `apps/server/test/tz.test.ts`** (pure — no DB)

```ts
import { describe, expect, it } from 'vitest'
import { localToUtc, utcToLocal } from '../src/reminders/tz'

describe('timezone edge (HOLI_TZ)', () => {
  it('converts Copenhagen summer (CEST, +02:00) wall-clock to UTC', () => {
    expect(localToUtc('2026-07-15T09:00', 'Europe/Copenhagen').toISOString()).toBe(
      '2026-07-15T07:00:00.000Z',
    )
  })
  it('converts Copenhagen winter (CET, +01:00) wall-clock to UTC', () => {
    expect(localToUtc('2026-01-15T09:00', 'Europe/Copenhagen').toISOString()).toBe(
      '2026-01-15T08:00:00.000Z',
    )
  })
  it('round-trips through utcToLocal', () => {
    const utc = localToUtc('2026-03-29T12:30', 'Europe/Copenhagen') // DST-transition day
    expect(utcToLocal(utc, 'Europe/Copenhagen')).toBe('2026-03-29T12:30')
  })
  it('rejects garbage', () => {
    expect(() => localToUtc('not-a-date', 'Europe/Copenhagen')).toThrow()
  })
})
```

- [ ] **Step 2: Implement `apps/server/src/reminders/tz.ts`**

```ts
/** Wall-clock ⇄ UTC conversion at the scheduler edge (stub #4: one
 * server-wide zone). The shared reminder math never sees timezones. */

function zoneOffsetMs(at: Date, zone: string): number {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    })
      .formatToParts(at)
      .map((p) => [p.type, p.value]),
  )
  const asUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour === '24' ? '0' : parts.hour),
    Number(parts.minute),
    Number(parts.second),
  )
  return asUtc - at.getTime()
}

/** `YYYY-MM-DDTHH:MM[:SS]` wall-clock in `zone` → UTC Date (two-pass for DST edges). */
export function localToUtc(local: string, zone: string): Date {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(local)
  if (!m) throw new Error(`invalid local datetime: ${local}`)
  const wall = Date.UTC(
    Number(m[1]),
    Number(m[2]) - 1,
    Number(m[3]),
    Number(m[4]),
    Number(m[5]),
    Number(m[6] ?? 0),
  )
  let utc = wall
  for (let i = 0; i < 2; i++) utc = wall - zoneOffsetMs(new Date(utc), zone)
  return new Date(utc)
}

/** UTC Date → `YYYY-MM-DDTHH:MM` wall-clock in `zone`. */
export function utcToLocal(at: Date, zone: string): string {
  const shifted = new Date(at.getTime() + zoneOffsetMs(at, zone))
  return shifted.toISOString().slice(0, 16)
}

/** Today's `YYYY-MM-DD` in `zone` — feeds nextDueCatchup. */
export function todayLocal(zone: string, now = new Date()): string {
  return utcToLocal(now, zone).slice(0, 10)
}
```

Run: `pnpm --filter @holi/server test test/tz.test.ts` → PASS.

- [ ] **Step 3: Write `apps/server/src/reminders/projection.ts`**

```ts
/** Materialize tasks.reminder into the reminders table (PRD §reminders):
 * recompute on any mutation touching reminder/due/status/recurrence. */
import { eq } from 'drizzle-orm'
import { pendingFireTime } from '@holi/shared'
import { config } from '../config'
import type { Db } from '../db/client'
import { reminders, type tasks } from '../db/schema'
import { localToUtc, utcToLocal } from './tz'

export async function recomputeReminder(
  db: Db,
  task: typeof tasks.$inferSelect,
  zone: string = config.timezone,
): Promise<void> {
  const remindedAtLocal = task.remindedAt ? utcToLocal(task.remindedAt, zone) : undefined
  const fire = pendingFireTime(task.status, task.reminder ?? undefined, task.due ?? undefined, remindedAtLocal)
  if (fire === null) {
    await db.delete(reminders).where(eq(reminders.taskId, task.id))
    return
  }
  const fireAt = localToUtc(fire, zone)
  await db
    .insert(reminders)
    .values({ taskId: task.id, vaultId: task.vaultId, fireAt, computedFrom: task.reminder })
    .onConflictDoUpdate({
      target: reminders.taskId,
      set: { fireAt, fired: false, computedFrom: task.reminder },
    })
}
```

- [ ] **Step 4: Failing tasks tests `apps/server/test/tasks.test.ts`**

```ts
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createBus } from '../src/bus'
import { reminders, tasks } from '../src/db/schema'
import { tasksRouter } from '../src/routers/tasks'
import { createTestDb, type TestDb } from '../src/test/db'
import { seedUser, seedVault } from '../src/test/fixtures'
import type { Context } from '../src/trpc'
import { localToUtc } from '../src/reminders/tz'

const ctxFor = (t: TestDb, userId: string): Context =>
  ({
    db: t.db,
    bus: createBus(),
    getLiveDoc: () => null,
    user: { id: userId, email: 'x@syv.ai', name: null, avatarUrl: null },
    token: 'tok',
  }) as Context

describe('tasks', () => {
  let t: TestDb
  let userId: string
  let vaultId: string
  beforeAll(async () => {
    t = await createTestDb()
    const u = await seedUser(t.db)
    userId = u.id
    vaultId = (await seedVault(t.db, u.id)).id
  })
  afterAll(() => t.destroy())

  it('create with a relative reminder materializes a reminders row (due-1d @ 09:00 local)', async () => {
    const caller = tasksRouter.createCaller(ctxFor(t, userId))
    const task = await caller.create({ vaultId, title: 'ship it', due: '2030-06-14', reminder: '1d' })
    const [row] = await t.db.select().from(reminders).where(eq(reminders.taskId, task.id))
    expect(row?.fireAt.toISOString()).toBe(
      localToUtc('2030-06-13T09:00', 'Europe/Copenhagen').toISOString(),
    )
    expect(row?.computedFrom).toBe('1d')
  })

  it('invalid reminders are inert — no row, no error (ported semantic)', async () => {
    const caller = tasksRouter.createCaller(ctxFor(t, userId))
    const task = await caller.create({ vaultId, title: 'x', reminder: 'gibberish' })
    expect(await t.db.select().from(reminders).where(eq(reminders.taskId, task.id))).toHaveLength(0)
  })

  it('update recomputes; completing a non-recurring task clears the projection', async () => {
    const caller = tasksRouter.createCaller(ctxFor(t, userId))
    const task = await caller.create({ vaultId, title: 'y', due: '2030-01-10', reminder: '2w' })
    await caller.update({ vaultId, taskId: task.id, patch: { due: '2030-02-10' } })
    const [row] = await t.db.select().from(reminders).where(eq(reminders.taskId, task.id))
    expect(row?.fireAt.toISOString()).toBe(
      localToUtc('2030-01-27T09:00', 'Europe/Copenhagen').toISOString(),
    )
    await caller.complete({ vaultId, taskId: task.id })
    const [done] = await t.db.select().from(tasks).where(eq(tasks.id, task.id))
    expect(done?.status).toBe('done')
    expect(done?.completedAt).not.toBeNull()
    expect(await t.db.select().from(reminders).where(eq(reminders.taskId, task.id))).toHaveLength(0)
  })

  it('complete on a recurring task rolls forward server-side (D19): due advances past today, status back to todo, absolute reminder shifts, reminded_at clears', async () => {
    const caller = tasksRouter.createCaller(ctxFor(t, userId))
    const task = await caller.create({
      vaultId,
      title: 'weekly sync',
      due: '2020-01-06', // decades stale — exercises nextDueCatchup
      reminder: '2020-01-05T15:00',
      recurrence: { frequency: 'weekly', interval: 1 },
    })
    await t.db.update(tasks).set({ remindedAt: new Date() }).where(eq(tasks.id, task.id))
    const rolled = await caller.complete({ vaultId, taskId: task.id })
    expect(rolled.status).toBe('todo')
    expect(rolled.due! >= new Date().toISOString().slice(0, 10)).toBe(true)
    // absolute reminder shifted by the same day-delta (still a T15:00 datetime)
    expect(rolled.reminder).toMatch(/T15:00$/)
    const [row] = await t.db.select().from(tasks).where(eq(tasks.id, task.id))
    expect(row?.remindedAt).toBeNull()
    expect(await t.db.select().from(reminders).where(eq(reminders.taskId, task.id))).toHaveLength(1)
  })

  it('link/unlink mutate the unified related[] by stable id', async () => {
    const caller = tasksRouter.createCaller(ctxFor(t, userId))
    const task = await caller.create({ vaultId, title: 'z' })
    const ref = { kind: 'note' as const, id: '4dbb1757-0000-4000-8000-000000000000' }
    await caller.link({ vaultId, taskId: task.id, related: ref })
    expect((await caller.get({ vaultId, taskId: task.id })).related).toEqual([ref])
    await caller.unlink({ vaultId, taskId: task.id, related: ref })
    expect((await caller.get({ vaultId, taskId: task.id })).related).toEqual([])
  })

  it('watch: mutations emit tasks events on the vault channel', async () => {
    const ctx = ctxFor(t, userId)
    const events: unknown[] = []
    ctx.bus.on(`tasks:${vaultId}`, (e) => events.push(e))
    const caller = tasksRouter.createCaller(ctx)
    const task = await caller.create({ vaultId, title: 'live' })
    await caller.delete({ vaultId, taskId: task.id })
    expect(events).toEqual([
      expect.objectContaining({ type: 'upserted' }),
      expect.objectContaining({ type: 'deleted', taskId: task.id }),
    ])
  })
})
```

- [ ] **Step 5: Implement `apps/server/src/routers/tasks.ts`**

```ts
import { and, eq } from 'drizzle-orm'
import { TRPCError } from '@trpc/server'
import { on } from 'node:events'
import { z } from 'zod'
import { nextDueCatchup, shiftForRollover, type Task } from '@holi/shared'
import type { TasksEvent } from '../bus'
import { config } from '../config'
import { toTask } from '../db/mappers'
import { reminders, tasks } from '../db/schema'
import { recomputeReminder } from '../reminders/projection'
import { todayLocal } from '../reminders/tz'
import { router, vaultProcedure } from '../trpc'

const relatedRef = z.object({ kind: z.enum(['note', 'task', 'email', 'event']), id: z.string() })
const recurrence = z.object({
  frequency: z.enum(['daily', 'weekly', 'monthly', 'yearly']),
  interval: z.number().int().min(1),
  weekdays: z.array(z.enum(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'])).optional(),
  endDate: z.string().optional(),
})
const taskFields = {
  title: z.string().min(1),
  status: z.enum(['todo', 'doing', 'done']).optional(),
  area: z.string().uuid().optional(),
  due: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  priority: z.enum(['low', 'medium', 'high']).optional(),
  tags: z.array(z.string()).optional(),
  reminder: z.string().optional(),
  recurrence: recurrence.optional(),
  related: z.array(relatedRef).optional(),
}

type TaskRow = typeof tasks.$inferSelect

/** Fetch + vault-scope a task row or 404. */
async function taskInVault(db: Db, vaultId: string, taskId: string): Promise<TaskRow> {
  const [row] = await db.select().from(tasks).where(and(eq(tasks.id, taskId), eq(tasks.vaultId, vaultId)))
  if (!row) throw new TRPCError({ code: 'NOT_FOUND' })
  return row
}
```

(Also import `import type { Db } from '../db/client'` and `import type { Bus } from '../bus'` — used by `taskInVault`/`finishMutation`.)

```ts
/** Persist → recompute projection → emit → wake evaluator: every mutation
 * funnels through here so nothing forgets a step. */
async function finishMutation(ctx: { db: Db; bus: Bus }, row: TaskRow): Promise<Task> {
  await recomputeReminder(ctx.db, row)
  const task = toTask(row)
  ctx.bus.emitTasks(row.vaultId, { type: 'upserted', task })
  ctx.bus.wakeEvaluator()
  return task
}

export const tasksRouter = router({
  list: vaultProcedure
    .input(z.object({ filter: z.object({ status: z.enum(['todo', 'doing', 'done']).optional() }).optional() }))
    .query(async ({ ctx, input }) => {
      const where = input.filter?.status
        ? and(eq(tasks.vaultId, ctx.vaultId), eq(tasks.status, input.filter.status))
        : eq(tasks.vaultId, ctx.vaultId)
      return (await ctx.db.select().from(tasks).where(where)).map(toTask)
    }),

  get: vaultProcedure
    .input(z.object({ taskId: z.string().uuid() }))
    .query(async ({ ctx, input }) => toTask(await taskInVault(ctx.db, ctx.vaultId, input.taskId))),

  create: vaultProcedure
    .input(z.object(taskFields))
    .mutation(async ({ ctx, input }) => {
      const [row] = await ctx.db
        .insert(tasks)
        .values({ ...input, vaultId: ctx.vaultId, tags: input.tags ?? [], related: input.related ?? [] })
        .returning()
      return finishMutation(ctx, row!)
    }),

  /** Last-writer-wins per field (D4 — tasks are not CRDTs). */
  update: vaultProcedure
    .input(z.object({ taskId: z.string().uuid(), patch: z.object(taskFields).partial() }))
    .mutation(async ({ ctx, input }) => {
      await taskInVault(ctx.db, ctx.vaultId, input.taskId)
      const [row] = await ctx.db
        .update(tasks)
        .set({ ...input.patch, updatedAt: new Date() })
        .where(eq(tasks.id, input.taskId))
        .returning()
      return finishMutation(ctx, row!)
    }),

  /** Transition to done + server-side recurrence roll-forward (D19). */
  complete: vaultProcedure
    .input(z.object({ taskId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const row = await taskInVault(ctx.db, ctx.vaultId, input.taskId)
      const now = new Date()
      const rolledDue =
        row.recurrence && row.due
          ? nextDueCatchup(row.due, row.recurrence, todayLocal(config.timezone, now))
          : null
      const patch = rolledDue
        ? {
            status: 'todo' as const,
            due: rolledDue,
            reminder:
              row.reminder && row.due
                ? (shiftForRollover(row.reminder, row.due, rolledDue) ?? row.reminder)
                : row.reminder,
            remindedAt: null,
            completedAt: now,
            updatedAt: now,
          }
        : { status: 'done' as const, completedAt: now, updatedAt: now }
      const [updated] = await ctx.db.update(tasks).set(patch).where(eq(tasks.id, row.id)).returning()
      return finishMutation(ctx, updated!)
    }),

  link: vaultProcedure
    .input(z.object({ taskId: z.string().uuid(), related: relatedRef }))
    .mutation(async ({ ctx, input }) => {
      const row = await taskInVault(ctx.db, ctx.vaultId, input.taskId)
      const next = row.related.some((r) => r.kind === input.related.kind && r.id === input.related.id)
        ? row.related
        : [...row.related, input.related]
      const [updated] = await ctx.db
        .update(tasks)
        .set({ related: next, updatedAt: new Date() })
        .where(eq(tasks.id, row.id))
        .returning()
      return finishMutation(ctx, updated!)
    }),

  unlink: vaultProcedure
    .input(z.object({ taskId: z.string().uuid(), related: relatedRef }))
    .mutation(async ({ ctx, input }) => {
      const row = await taskInVault(ctx.db, ctx.vaultId, input.taskId)
      const next = row.related.filter((r) => !(r.kind === input.related.kind && r.id === input.related.id))
      const [updated] = await ctx.db
        .update(tasks)
        .set({ related: next, updatedAt: new Date() })
        .where(eq(tasks.id, row.id))
        .returning()
      return finishMutation(ctx, updated!)
    }),

  delete: vaultProcedure
    .input(z.object({ taskId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const row = await taskInVault(ctx.db, ctx.vaultId, input.taskId)
      await ctx.db.delete(tasks).where(eq(tasks.id, row.id)) // reminders row cascades
      ctx.bus.emitTasks(ctx.vaultId, { type: 'deleted', taskId: row.id })
      return { ok: true }
    }),

  /** (S) Live board updates for every member (architecture §5). */
  watch: vaultProcedure.subscription(async function* ({ ctx, signal }) {
    for await (const [event] of on(ctx.bus, `tasks:${ctx.vaultId}`, { signal })) {
      yield event as TasksEvent
    }
  }),
})
```

- [ ] **Step 6: Red → green → commit**

```bash
pnpm --filter @holi/server test > /tmp/t.log 2>&1; echo $?; tail -8 /tmp/t.log
git add apps/server/src/reminders apps/server/src/routers/tasks.ts apps/server/test/tz.test.ts apps/server/test/tasks.test.ts
git commit -m "feat(server): tasks router + reminder projection test-first — shared pure functions do the math (D19)

Claude goes brr.. via Dash"
```

---

## Task 12: Reminder evaluator loop + reminders/userState routers

The single evaluation loop (PRD §Reminders): sleep until the earliest pending `fire_at`, woken early by `bus.wakeEvaluator()`; on fire, mark + write `tasks.reminded_at` + push per-vault. First tick doubles as the missed-reminder boot pass; >5 backlogged fires per vault coalesce into one event (ported semantic).

**Files:**
- Create: `apps/server/src/reminders/evaluator.ts`
- Create: `apps/server/src/routers/reminders.ts`
- Create: `apps/server/src/routers/user-state.ts`
- Test: `apps/server/test/evaluator.test.ts`

- [ ] **Step 1: Failing evaluator tests `apps/server/test/evaluator.test.ts`**

Test `tick()` directly — deterministic, no timers:

```ts
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createBus, type RemindersEvent } from '../src/bus'
import { reminders, tasks } from '../src/db/schema'
import { createReminderEvaluator } from '../src/reminders/evaluator'
import { createTestDb, type TestDb } from '../src/test/db'
import { seedUser, seedVault } from '../src/test/fixtures'

async function seedFire(t: TestDb, vaultId: string, title: string, fireAt: Date) {
  const [task] = await t.db.insert(tasks).values({ vaultId, title }).returning()
  await t.db.insert(reminders).values({ taskId: task!.id, vaultId, fireAt, computedFrom: 'x' })
  return task!
}

describe('reminder evaluator', () => {
  let t: TestDb
  let vaultId: string
  beforeAll(async () => {
    t = await createTestDb()
    const u = await seedUser(t.db)
    vaultId = (await seedVault(t.db, u.id)).id
  })
  afterAll(() => t.destroy())

  it('tick fires due reminders: marks fired, writes reminded_at, pushes per-vault', async () => {
    const bus = createBus()
    const events: RemindersEvent[] = []
    bus.on(`reminders:${vaultId}`, (e) => events.push(e))
    const task = await seedFire(t, vaultId, 'due now', new Date(Date.now() - 1000))
    const future = await seedFire(t, vaultId, 'later', new Date(Date.now() + 3_600_000))

    const evaluator = createReminderEvaluator({ db: t.db, bus })
    await evaluator.tick()

    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ coalesced: false, fires: [expect.objectContaining({ taskId: task.id })] })
    const [firedRow] = await t.db.select().from(reminders).where(eq(reminders.taskId, task.id))
    expect(firedRow?.fired).toBe(true)
    const [taskRow] = await t.db.select().from(tasks).where(eq(tasks.id, task.id))
    expect(taskRow?.remindedAt).not.toBeNull()
    const [futureRow] = await t.db.select().from(reminders).where(eq(reminders.taskId, future.id))
    expect(futureRow?.fired).toBe(false)

    // second tick: nothing new fires
    await evaluator.tick()
    expect(events).toHaveLength(1)
  })

  it('boot backlog >5 in one vault coalesces into a single summary event', async () => {
    const u = await seedUser(t.db)
    const backlogVault = (await seedVault(t.db, u.id)).id
    const bus = createBus()
    const events: RemindersEvent[] = []
    bus.on(`reminders:${backlogVault}`, (e) => events.push(e))
    for (let i = 0; i < 7; i++) await seedFire(t, backlogVault, `missed ${i}`, new Date(Date.now() - 60_000))

    await createReminderEvaluator({ db: t.db, bus }).tick()

    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ coalesced: true })
    expect(events[0]?.fires).toHaveLength(7)
  })
})
```

- [ ] **Step 2: Implement `apps/server/src/reminders/evaluator.ts`**

```ts
/** The single server-side reminder loop (D19). tick() is separable for tests;
 * start() runs the sleep-until-earliest loop, woken by bus 'evaluator:wake'. */
import { and, asc, eq, inArray, lte } from 'drizzle-orm'
import type { Bus, ReminderFire } from '../bus'
import type { Db } from '../db/client'
import { reminders, tasks } from '../db/schema'
import { utcToLocal } from './tz'
import { config } from '../config'

const COALESCE_THRESHOLD = 5
const MAX_SLEEP_MS = 60_000 // re-check at least every minute (clock drift, missed wakes)

export function createReminderEvaluator(deps: { db: Db; bus: Bus }) {
  const { db, bus } = deps
  let timer: NodeJS.Timeout | undefined
  let running = false
  let stopped = false

  /** Fire everything due; returns when the projection is drained to now. */
  async function tick(now = new Date()): Promise<void> {
    const due = await db
      .select({ id: reminders.id, taskId: reminders.taskId, vaultId: reminders.vaultId, fireAt: reminders.fireAt, title: tasks.title })
      .from(reminders)
      .innerJoin(tasks, eq(tasks.id, reminders.taskId))
      .where(and(eq(reminders.fired, false), lte(reminders.fireAt, now)))
    if (due.length === 0) return
    await db.update(reminders).set({ fired: true }).where(inArray(reminders.id, due.map((d) => d.id)))
    await db.update(tasks).set({ remindedAt: now }).where(inArray(tasks.id, due.map((d) => d.taskId)))
    const byVault = new Map<string, ReminderFire[]>()
    for (const d of due) {
      const fires = byVault.get(d.vaultId) ?? []
      fires.push({ taskId: d.taskId, title: d.title, fireAt: utcToLocal(d.fireAt, config.timezone) })
      byVault.set(d.vaultId, fires)
    }
    for (const [vaultId, fires] of byVault) {
      bus.emitReminders(vaultId, { fires, coalesced: fires.length > COALESCE_THRESHOLD })
    }
  }

  async function schedule(): Promise<void> {
    if (stopped || running) return
    running = true
    try {
      await tick()
    } catch (err) {
      console.error('[reminders] tick failed', err)
    } finally {
      running = false
    }
    if (stopped) return
    const [next] = await db
      .select({ fireAt: reminders.fireAt })
      .from(reminders)
      .where(eq(reminders.fired, false))
      .orderBy(asc(reminders.fireAt))
      .limit(1)
    const delay = next
      ? Math.min(Math.max(next.fireAt.getTime() - Date.now(), 0), MAX_SLEEP_MS)
      : MAX_SLEEP_MS
    clearTimeout(timer)
    timer = setTimeout(() => void schedule(), delay)
  }

  return {
    tick,
    /** Boot: first schedule() run doubles as the missed-reminder pass. */
    start(): void {
      bus.on('evaluator:wake', () => void schedule())
      void schedule()
    },
    stop(): void {
      stopped = true
      clearTimeout(timer)
    },
  }
}
```

- [ ] **Step 3: Write `apps/server/src/routers/reminders.ts` and `user-state.ts`**

`reminders.ts`:

```ts
import { on } from 'node:events'
import { and, eq } from 'drizzle-orm'
import type { RemindersEvent } from '../bus'
import { reminders } from '../db/schema'
import { router, vaultProcedure } from '../trpc'

export const remindersRouter = router({
  /** Introspection/debug (PRD). */
  listPending: vaultProcedure.query(({ ctx }) =>
    ctx.db
      .select()
      .from(reminders)
      .where(and(eq(reminders.vaultId, ctx.vaultId), eq(reminders.fired, false))),
  ),

  /** (S) Fire events → client raises the native notification (D19). */
  subscribe: vaultProcedure.subscription(async function* ({ ctx, signal }) {
    for await (const [event] of on(ctx.bus, `reminders:${ctx.vaultId}`, { signal })) {
      yield event as RemindersEvent
    }
  }),
})
```

`user-state.ts` (UI prefs only, D6):

```ts
import { and, eq } from 'drizzle-orm'
import { z } from 'zod'
import { perUserState } from '../db/schema'
import { router, vaultProcedure } from '../trpc'

const scoped = (ctx: { vaultId: string; user: { id: string } }, key?: string) => {
  const base = [eq(perUserState.userId, ctx.user.id), eq(perUserState.vaultId, ctx.vaultId)]
  return key === undefined ? and(...base) : and(...base, eq(perUserState.key, key))
}

export const userStateRouter = router({
  get: vaultProcedure.input(z.object({ key: z.string() })).query(async ({ ctx, input }) => {
    const [row] = await ctx.db.select().from(perUserState).where(scoped(ctx, input.key))
    return row?.value ?? null
  }),
  getAll: vaultProcedure.query(async ({ ctx }) => {
    const rows = await ctx.db.select().from(perUserState).where(scoped(ctx))
    return Object.fromEntries(rows.map((r) => [r.key, r.value]))
  }),
  set: vaultProcedure
    .input(z.object({ key: z.string(), value: z.unknown() }))
    .mutation(async ({ ctx, input }) => {
      await ctx.db
        .insert(perUserState)
        .values({ userId: ctx.user.id, vaultId: ctx.vaultId, key: input.key, value: input.value })
        .onConflictDoUpdate({
          target: [perUserState.userId, perUserState.vaultId, perUserState.key],
          set: { value: input.value, updatedAt: new Date() },
        })
      return { ok: true }
    }),
  delete: vaultProcedure.input(z.object({ key: z.string() })).mutation(async ({ ctx, input }) => {
    await ctx.db.delete(perUserState).where(scoped(ctx, input.key))
    return { ok: true }
  }),
})
```

- [ ] **Step 4: Red → green → commit**

```bash
pnpm --filter @holi/server test > /tmp/t.log 2>&1; echo $?; tail -8 /tmp/t.log
git add apps/server/src/reminders apps/server/src/routers
git commit -m "feat(server): reminder evaluator loop test-first + reminders/userState routers

Claude goes brr.. via Dash"
```

---

## Task 13: Wire it all up — appRouter, main.ts, seed script, end-to-end verify, docs

**Files:**
- Create: `apps/server/src/routers/index.ts`
- Rewrite: `apps/server/src/main.ts`
- Delete: `apps/server/src/router.ts`
- Create: `apps/server/scripts/seed-dev.ts`, `apps/server/scripts/verify-roundtrip.ts`
- Modify: root `package.json` (add `db:up`), `docs/decisions.md`, `docs/prd/server-data.md`

- [ ] **Step 1: Write `apps/server/src/routers/index.ts`** (replaces `src/router.ts` — delete it and its old import)

```ts
import type { HealthStatus } from '@holi/shared'
import { publicProcedure, router } from '../trpc'
import { authRouter } from './auth'
import { membershipRouter } from './membership'
import { notesRouter } from './notes'
import { remindersRouter } from './reminders'
import { snapshotsRouter } from './snapshots'
import { tasksRouter } from './tasks'
import { userStateRouter } from './user-state'
import { vaultsRouter } from './vaults'

export const appRouter = router({
  health: publicProcedure.query(
    (): HealthStatus => ({ ok: true, service: 'holi-server', time: new Date().toISOString() }),
  ),
  auth: authRouter,
  vaults: vaultsRouter,
  membership: membershipRouter,
  notes: notesRouter,
  snapshots: snapshotsRouter,
  tasks: tasksRouter,
  reminders: remindersRouter,
  userState: userStateRouter,
})

export type AppRouter = typeof appRouter
```

- [ ] **Step 2: Rewrite `apps/server/src/main.ts`**

```ts
import { Hocuspocus } from '@hocuspocus/server'
import { createHTTPServer } from '@trpc/server/adapters/standalone'
import { createBus } from './bus'
import { config } from './config'
import { createDb } from './db/client'
import { runMigrations } from './db/migrate'
import { createReminderEvaluator } from './reminders/evaluator'
import { appRouter } from './routers'
import { makeCreateContext } from './trpc'
import { makeHooks } from './yjs/hooks'

async function main(): Promise<void> {
  await runMigrations()
  const { db } = createDb()
  const bus = createBus()

  const hooks = makeHooks({ db, bus })
  const relay = new Hocuspocus({
    port: config.relayPort,
    // built-in store debouncing — do not hand-roll (PRD: debounced onStoreDocument)
    debounce: 2000,
    maxDebounce: 10_000,
    onAuthenticate: (data) => hooks.onAuthenticate(data),
    onLoadDocument: (data) => hooks.onLoadDocument(data),
    onStoreDocument: (data) =>
      hooks.onStoreDocument({
        documentName: data.documentName,
        document: data.document,
        context: data.context,
      }),
  })
  await relay.listen()
  console.log(`[relay] Hocuspocus listening on ws://127.0.0.1:${config.relayPort}`)

  const getLiveDoc = (docId: string) => relay.documents.get(docId) ?? null
  createHTTPServer({
    router: appRouter,
    createContext: makeCreateContext({ db, bus, getLiveDoc }),
  }).listen(config.apiPort)
  console.log(`[api] tRPC listening on http://127.0.0.1:${config.apiPort}`)

  createReminderEvaluator({ db, bus }).start()
  console.log('[reminders] evaluator started')
}

void main().catch((err) => {
  console.error(err)
  process.exit(1)
})
```

(The arrow-wrapped hooks keep our narrow signatures compatible with Hocuspocus's payload types; if `relay.documents` is typed differently in the installed v2 minor, check `node_modules/@hocuspocus/server/dist` — it is a `Map<string, Document>` in 2.15.)

- [ ] **Step 3: Add root convenience script**

Root `package.json` scripts: `"db:up": "docker compose up -d --wait"`.

- [ ] **Step 4: Write `apps/server/scripts/seed-dev.ts`**

For manual curl/WS verification without Google credentials (Google env vars are only needed for the real SSO path):

```ts
/** Seed a dev user + personal vault + welcome doc; print a session token.
 * Run: pnpm --filter @holi/server exec tsx scripts/seed-dev.ts */
import * as Y from 'yjs'
import { YDOC_TEXT_KEY } from '@holi/shared'
import { mintSession } from '../src/auth/sessions'
import { createDb } from '../src/db/client'
import { runMigrations } from '../src/db/migrate'
import { docs, memberships, users, vaults, yjsDocs } from '../src/db/schema'

async function seed(): Promise<void> {
  await runMigrations()
  const { db, sql } = createDb()
  const [user] = await db
    .insert(users)
    .values({ googleSub: 'dev-local', email: 'dev@syv.ai', name: 'Dev' })
    .onConflictDoUpdate({ target: users.googleSub, set: { updatedAt: new Date() } })
    .returning()
  const [vault] = await db
    .insert(vaults)
    .values({ name: 'dev vault', kind: 'personal', ownerId: user!.id })
    .returning()
  await db.insert(memberships).values({ vaultId: vault!.id, userId: user!.id, role: 'owner' })
  const [doc] = await db
    .insert(docs)
    .values({ vaultId: vault!.id, path: 'welcome.md', kind: 'note' })
    .returning()
  const ydoc = new Y.Doc()
  ydoc.getText(YDOC_TEXT_KEY).insert(0, '# welcome\n')
  await db.insert(yjsDocs).values({ docId: doc!.id, state: Y.encodeStateAsUpdate(ydoc) })
  const token = await mintSession(db, user!.id)
  console.log(JSON.stringify({ token, vaultId: vault!.id, docId: doc!.id }, null, 2))
  await sql.end()
}

void seed()
```

- [ ] **Step 5: Write `apps/server/scripts/verify-roundtrip.ts`**

```bash
pnpm --filter @holi/server add -D @hocuspocus/provider@^2 ws @types/ws
```

```ts
/** Append text to a doc over the real WebSocket, or read it back.
 * Run: pnpm --filter @holi/server exec tsx scripts/verify-roundtrip.ts <docId> <token> [textToAppend] */
import { HocuspocusProvider } from '@hocuspocus/provider'
import WebSocket from 'ws'
import * as Y from 'yjs'
import { YDOC_TEXT_KEY } from '@holi/shared'

const [docId, token, textToAppend] = process.argv.slice(2)
if (!docId || !token) throw new Error('usage: verify-roundtrip.ts <docId> <token> [textToAppend]')

const doc = new Y.Doc()
const provider = new HocuspocusProvider({
  url: 'ws://127.0.0.1:4444',
  name: docId,
  token,
  document: doc,
  WebSocketPolyfill: WebSocket as never,
  onSynced() {
    const text = doc.getText(YDOC_TEXT_KEY)
    if (textToAppend) {
      text.insert(text.length, textToAppend)
      console.log(`[write] appended; doc now: ${JSON.stringify(text.toString())}`)
    } else {
      console.log(`[read] doc content: ${JSON.stringify(text.toString())}`)
    }
    // give the relay's debounced store time to flush before exiting
    setTimeout(() => {
      provider.destroy()
      process.exit(0)
    }, 3000)
  },
  onAuthenticationFailed({ reason }) {
    console.error(`[auth] rejected: ${reason}`)
    process.exit(1)
  },
})
```

- [ ] **Step 6: End-to-end verify (the milestone proof)**

```bash
lsof -ti :4000 -ti :4444 | xargs kill 2>/dev/null
pnpm db:up
pnpm --filter @holi/server dev > /tmp/server.log 2>&1 &
sleep 3; grep -E 'relay|api|reminders' /tmp/server.log
```

Expected: all three subsystem lines.

```bash
curl -s http://127.0.0.1:4000/health                      # → {"ok":true,...}
curl -s http://127.0.0.1:4000/vaults.list                 # → UNAUTHORIZED error JSON
SEED=$(pnpm --filter @holi/server exec tsx scripts/seed-dev.ts | tail -5)
TOKEN=$(echo "$SEED" | grep -o '"token": "[^"]*"' | cut -d'"' -f4)
DOC_ID=$(echo "$SEED" | grep -o '"docId": "[^"]*"' | cut -d'"' -f4)
curl -s http://127.0.0.1:4000/vaults.list -H "Authorization: Bearer $TOKEN"   # → dev vault
pnpm --filter @holi/server exec tsx scripts/verify-roundtrip.ts "$DOC_ID" "$TOKEN" "persisted-marker"
# restart the server (kill + relaunch), then:
pnpm --filter @holi/server exec tsx scripts/verify-roundtrip.ts "$DOC_ID" "$TOKEN"
```

Expected final read: `# welcome\npersisted-marker` — **a Yjs doc survived a server restart**. Also verify `curl -s "http://127.0.0.1:4000/tasks.create?..."` is unnecessary — tasks are covered by the suite; the restart-survival WS round-trip is the new evidence. Finally `pnpm dev` from root must still boot both apps.

- [ ] **Step 7: Documentation updates**

`docs/decisions.md`, under **D14**, append:

```markdown
- **Addendum (2026-07-11, Nicolai):** the no-codegen rule is relaxed for the server's *internal* DB layer — Drizzle ORM defines the Postgres schema in TS and drizzle-kit autogenerates SQL migrations. `packages/shared` remains the only client↔server type seam; there is still no API/type codegen across that seam.
```

`docs/prd/server-data.md` §Open questions — annotate the resolved ones:

- Session-token lifetime → "*Stubbed 2026-07-11:* opaque DB tokens, 30-day sliding TTL, revocation by row delete (plan `2026-07-11-server-persistence.md`)."
- Timezone source → "*Stubbed 2026-07-11:* server-wide `HOLI_TZ` (default Europe/Copenhagen); per-user later."
- Snapshot retention → "*Partially stubbed 2026-07-11:* interval policy = one snapshot per 10 min of active editing; pruning still open."

- [ ] **Step 8: Full workspace check + final commit**

```bash
pnpm -r test > /tmp/t.log 2>&1; echo $?; tail -8 /tmp/t.log
pnpm -r typecheck; echo $?
git add -A
git commit -m "feat(server): wire persistence — appRouter, boot migrations, evaluator, dev seed + WS round-trip verify

Server phase per prd/server-data.md: Postgres via Drizzle, Google SSO +
opaque sessions, membership authz chokepoint, Hocuspocus persistence hooks,
atomic rename, reminder evaluator. Verified: Yjs doc survives server restart.

Claude goes brr.. via Dash"
```

---

## Deliberately NOT in this phase

- Object storage / backup exports (D28 — phase 2 import pipeline).
- Overlap detection (D26, *open* — placement undecided; nothing here blocks either choice).
- Snapshot pruning, WebSocket horizontal scaling, offline reminder ack/dedup (PRD open questions).
- Any client changes beyond `packages/shared` additions (`YDOC_TEXT_KEY`).
- Rate limiting / CORS hardening — the server binds localhost in dev; deployment hardening is the Hetzner phase.
