# Vault Git Mirror + Remote-Edit Ingress Implementation Plan

> **For agentic workers:** Use the executing-plans skill to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A vault owner connects an owner-provided GitHub repo; the server keeps it mirrored (debounced export commits) and auto-ingests foreign commits (from Claude Code cloud sessions) back into the live CRDTs.

**Architecture:** All machinery lives in `apps/server` (`src/git/*`): a per-vault-locked sync orchestrator drives a **full-tree materializing exporter** (write whole vault into the mirror clone, `git add -A`, commit as the Holi bot, push) and a **diff-against-base ingester** (per changed file, `fast-diff(base, head)` applied as positioned Y.Text ops through the existing live-room-aware `editDocText`). Wiring uses the owner's linked GitHub OAuth token once (deploy key + webhook via the GitHub API); background pushes run on the deploy key. The desktop gains a thin settings pane. Design: `docs/specs/2026-07-13-vault-git-mirror-design.md`; PRD: `docs/prd/vaults-collaboration.md` §Git mirror.

**Tech Stack:** git CLI via `execFile` (no native deps), `fast-diff`, AES-256-GCM at-rest encryption (node crypto), GitHub REST API via `fetch` behind an injectable interface, existing Drizzle/tRPC/Hocuspocus/vitest conventions.

**Environment notes (repo quirks):** run everything through `pnpm` from the repo root (bare `node`/`npx` are broken); Postgres for tests is the compose instance on **5433** (`pnpm db:up`); check exit codes, not piped output. Tests never talk to github.com — remotes are local bare repos, the GitHub API is a fake.

**Two deliberate deviations from the spec, decided here (record in the PRD in Task 15):**
1. **No overlap flag on divergent ingest.** The D26 flag subsystem (non-blocking "let Claude reconcile?") doesn't exist anywhere yet. Ingest takes the pre-snapshot and records a `diverged` warning on `vault_git.warnings` instead; the flag joins when the merge-safety-net feature is built.
2. **No snapshot before ingest-driven doc delete.** `yjs_snapshots.doc_id` cascades on doc delete, so a pre-delete snapshot dies with the row — exactly like today's `notes.delete`. Deleted-doc recovery is a pre-existing gap, not widened here.

---

## File structure

**Server — create:**
- `apps/server/src/crypto.ts` — AES-256-GCM `seal`/`openSealed` for tokens + deploy keys
- `apps/server/src/git/repo-url.ts` — parse/validate GitHub repo URLs, build SSH remote
- `apps/server/src/git/git.ts` — git CLI wrapper (`git`, `gitBuffer`, `isAncestor`, `parseNameStatusZ`)
- `apps/server/src/git/github-api.ts` — `GithubApi` interface + fetch impl (injectable base URLs)
- `apps/server/src/git/oauth.ts` — GitHub account-linking (state mint/consume + HTTP callback)
- `apps/server/src/git/exporter.ts` — vault → tree materialization + bot commit
- `apps/server/src/git/apply-diff.ts` — `fast-diff` → positioned Y.Text ops
- `apps/server/src/git/ingester.ts` — foreign-commit range → doc mutations + warnings
- `apps/server/src/git/sync.ts` — per-vault lock, clone lifecycle, fetch/ingest/export/push loop
- `apps/server/src/git/webhook.ts` — HMAC-verified GitHub push webhook handler
- `apps/server/src/git/scheduler.ts` — quiet-window export poll + hourly fetch backstop
- `apps/server/src/routers/github.ts` — user-level: startConnect / connectionStatus / disconnect
- `apps/server/src/routers/git.ts` — vault-level: status / connectRepo / disconnectRepo / syncNow
- `apps/server/src/test/git.ts` — bare-repo + workdir test helpers, `FakeGithubApi`

**Server — modify:**
- `apps/server/src/config.ts` — encryption key, GitHub OAuth app, public base URL, git tunables
- `apps/server/src/db/schema.ts` — `github_connections`, `vault_git` (+ generated migration)
- `apps/server/src/yjs/snapshots.ts` — add `'pre-git-ingest'` to `SnapshotReason`
- `apps/server/src/routers/index.ts` — register the two routers
- `apps/server/src/main.ts` — custom `http.createServer` routing webhook + OAuth callback + tRPC; start scheduler
- `apps/server/package.json` — add `fast-diff`

**Desktop — create:**
- `apps/desktop/src/renderer/src/state/git.ts` — jotai atoms for github/git status + actions
- `apps/desktop/src/renderer/src/components/VaultSettings.tsx` — settings pane (GitHub link + repo connect + status)

**Desktop — modify:**
- `apps/desktop/src/main/ipc.ts` + `src/preload/index.ts` — `openExternal` IPC
- `apps/desktop/src/renderer/src/components/Shell.tsx` — settings toggle button + pane mount

---

### Task 1: Config + at-rest crypto

**Files:**
- Modify: `apps/server/src/config.ts`
- Create: `apps/server/src/crypto.ts`
- Test: `apps/server/test/crypto.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// apps/server/test/crypto.test.ts
import { describe, expect, it } from 'vitest'
import { encryptionKey, openSealed, seal } from '../src/crypto'

describe('crypto', () => {
  it('round-trips utf8 plaintext', () => {
    const key = encryptionKey()
    const sealed = seal('ghp_secret-token-Ø', key)
    expect(openSealed(sealed, key)).toBe('ghp_secret-token-Ø')
  })

  it('produces a different ciphertext every call (random IV)', () => {
    const key = encryptionKey()
    expect(Buffer.from(seal('x', key)).equals(Buffer.from(seal('x', key)))).toBe(false)
  })

  it('rejects tampered ciphertext', () => {
    const key = encryptionKey()
    const sealed = Buffer.from(seal('x', key))
    sealed[sealed.length - 1] ^= 0xff
    expect(() => openSealed(sealed, key)).toThrow()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @holi/server exec vitest run test/crypto.test.ts`
Expected: FAIL — `Cannot find module '../src/crypto'`

- [ ] **Step 3: Implement config additions + crypto**

Append to the `config` object in `apps/server/src/config.ts` (inside the object literal, after `google`):

```ts
  /** 32-byte hex key for at-rest encryption of GitHub tokens + deploy keys.
   * The dev default is PUBLIC — set HOLI_ENCRYPTION_KEY in any real deployment. */
  encryptionKeyHex:
    process.env.HOLI_ENCRYPTION_KEY ??
    '00000000000000000000000000000000000000000000000000000000000000ff',
  /** Base URL GitHub can reach for webhooks + the OAuth callback (prod: public HTTPS; dev needs a tunnel for real webhook delivery). */
  publicBaseUrl: process.env.PUBLIC_BASE_URL ?? 'http://127.0.0.1:4000',
  github: {
    clientId: process.env.GITHUB_CLIENT_ID,
    clientSecret: process.env.GITHUB_CLIENT_SECRET,
  },
  git: {
    /** Mirror clones live here, one subdir per vault id. Derived state — safe to delete. */
    mirrorDir: process.env.GIT_MIRROR_DIR ?? './data/git-mirrors',
    botName: 'Holi',
    botEmail: 'holi-relay@syv.ai',
    /** Export when a vault has been quiet this long… */
    quietMs: Number(process.env.GIT_QUIET_MS ?? 45_000),
    /** …or unconditionally when it's been dirty longer than this. */
    maxQuietMs: Number(process.env.GIT_MAX_QUIET_MS ?? 5 * 60_000),
    /** Scheduler poll interval. */
    tickMs: Number(process.env.GIT_TICK_MS ?? 15_000),
    /** Webhook-miss backstop: fetch at least this often. */
    fetchBackstopMs: Number(process.env.GIT_FETCH_BACKSTOP_MS ?? 60 * 60_000),
  },
```

```ts
// apps/server/src/crypto.ts
/** AES-256-GCM at-rest encryption for GitHub OAuth tokens and deploy keys.
 * Layout: 12-byte IV ‖ 16-byte auth tag ‖ ciphertext. */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { config } from './config'

const ALG = 'aes-256-gcm'
const IV_LEN = 12
const TAG_LEN = 16

export function encryptionKey(): Buffer {
  const key = Buffer.from(config.encryptionKeyHex, 'hex')
  if (key.length !== 32) throw new Error('HOLI_ENCRYPTION_KEY must be 32 bytes of hex')
  return key
}

export function seal(plaintext: string, key: Buffer): Uint8Array {
  const iv = randomBytes(IV_LEN)
  const cipher = createCipheriv(ALG, key, iv)
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  return Buffer.concat([iv, cipher.getAuthTag(), ct])
}

export function openSealed(sealed: Uint8Array, key: Buffer): string {
  const buf = Buffer.from(sealed)
  const iv = buf.subarray(0, IV_LEN)
  const tag = buf.subarray(IV_LEN, IV_LEN + TAG_LEN)
  const ct = buf.subarray(IV_LEN + TAG_LEN)
  const decipher = createDecipheriv(ALG, key, iv)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8')
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @holi/server exec vitest run test/crypto.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/config.ts apps/server/src/crypto.ts apps/server/test/crypto.test.ts
git commit -m "feat(server): git-mirror config + AES-256-GCM at-rest crypto"
```

---

### Task 2: Schema — `github_connections` + `vault_git`

**Files:**
- Modify: `apps/server/src/db/schema.ts`
- Create: generated migration under `apps/server/drizzle/`
- Test: `apps/server/test/git-schema.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// apps/server/test/git-schema.test.ts
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { encryptionKey, openSealed, seal } from '../src/crypto'
import { githubConnections, vaultGit } from '../src/db/schema'
import { createTestDb, type TestDb } from '../src/test/db'
import { seedUser, seedVault } from '../src/test/fixtures'

let t: TestDb
beforeAll(async () => {
  t = await createTestDb()
})
afterAll(() => t.destroy())

describe('git schema', () => {
  it('stores a github connection with an encrypted token', async () => {
    const user = await seedUser(t.db)
    const key = encryptionKey()
    await t.db.insert(githubConnections).values({
      userId: user.id,
      githubUserId: 12345,
      githubLogin: 'nicolai',
      tokenCiphertext: seal('gho_token', key),
    })
    const [row] = await t.db
      .select()
      .from(githubConnections)
      .where(eq(githubConnections.userId, user.id))
    expect(row!.githubLogin).toBe('nicolai')
    expect(openSealed(row!.tokenCiphertext, key)).toBe('gho_token')
  })

  it('stores vault_git with defaults and cascades on vault delete', async () => {
    const user = await seedUser(t.db)
    const vault = await seedVault(t.db, user.id)
    const key = encryptionKey()
    await t.db.insert(vaultGit).values({
      vaultId: vault.id,
      repoUrl: 'https://github.com/syv-ai/vault-x',
      remote: 'git@github.com:syv-ai/vault-x.git',
      defaultBranch: 'main',
      deployKeyCiphertext: seal('PRIVATE KEY', key),
      deployKeyPublic: 'ssh-ed25519 AAAA...',
      webhookSecretCiphertext: seal('whsec', key),
      enabledBy: user.id,
    })
    const [row] = await t.db.select().from(vaultGit).where(eq(vaultGit.vaultId, vault.id))
    expect(row!.status).toBe('ok')
    expect(row!.baseCommit).toBeNull()
    expect(row!.warnings).toEqual([])

    const { vaults } = await import('../src/db/schema')
    await t.db.delete(vaults).where(eq(vaults.id, vault.id))
    const rows = await t.db.select().from(vaultGit).where(eq(vaultGit.vaultId, vault.id))
    expect(rows).toHaveLength(0)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @holi/server exec vitest run test/git-schema.test.ts`
Expected: FAIL — `githubConnections` not exported

- [ ] **Step 3: Add the tables**

Append to `apps/server/src/db/schema.ts` (add `bigint` to the existing `drizzle-orm/pg-core` import list):

```ts
/** A non-fatal git-sync incident surfaced in vault settings. */
export interface GitWarning {
  at: string // ISO timestamp
  kind: 'binary-skipped' | 'unsafe-path' | 'local-file-skipped' | 'rename-target-occupied' | 'diverged-ingest'
  path: string
  detail?: string
}

/** Per-user GitHub account link (auth-identity PRD §Linked accounts). */
export const githubConnections = pgTable('github_connections', {
  userId: uuid('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  githubUserId: bigint('github_user_id', { mode: 'number' }).notNull(),
  githubLogin: text('github_login').notNull(),
  /** OAuth token, AES-256-GCM sealed (src/crypto.ts). Used only at repo wiring/un-wiring time. */
  tokenCiphertext: bytea('token_ciphertext').notNull(),
  ...timestamps,
})

/** Git mirror wiring, one row per git-enabled vault (design spec 2026-07-13). */
export const vaultGit = pgTable('vault_git', {
  vaultId: uuid('vault_id')
    .primaryKey()
    .references(() => vaults.id, { onDelete: 'cascade' }),
  /** As the owner entered it (github.com HTTPS or SSH form). */
  repoUrl: text('repo_url').notNull(),
  /** What the mirror clone actually fetches/pushes (SSH in prod; a filesystem path in tests). */
  remote: text('remote').notNull(),
  defaultBranch: text('default_branch').notNull().default('main'),
  deployKeyCiphertext: bytea('deploy_key_ciphertext').notNull(),
  deployKeyPublic: text('deploy_key_public').notNull(),
  /** GitHub resource ids so disconnect can delete them (null when not API-managed, e.g. tests). */
  deployKeyId: bigint('deploy_key_id', { mode: 'number' }),
  webhookId: bigint('webhook_id', { mode: 'number' }),
  webhookSecretCiphertext: bytea('webhook_secret_ciphertext').notNull(),
  /** The sync base: last commit exported OR ingested — the diff base for both directions. */
  baseCommit: text('base_commit'),
  status: text('status', { enum: ['ok', 'paused', 'attention'] }).notNull().default('ok'),
  statusDetail: text('status_detail'),
  warnings: jsonb('warnings').$type<GitWarning[]>().notNull().default(sql`'[]'::jsonb`),
  enabledBy: uuid('enabled_by')
    .notNull()
    .references(() => users.id),
  lastExportAt: timestamp('last_export_at', { withTimezone: true }),
  lastIngestAt: timestamp('last_ingest_at', { withTimezone: true }),
  lastFetchAt: timestamp('last_fetch_at', { withTimezone: true }),
  ...timestamps,
})
```

- [ ] **Step 4: Generate the migration**

Run: `pnpm --filter @holi/server db:generate`
Expected: a new `apps/server/drizzle/00XX_*.sql` creating both tables. Inspect it — it must contain `create table "github_connections"` and `create table "vault_git"` and nothing destructive.

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @holi/server exec vitest run test/git-schema.test.ts`
Expected: PASS (2 tests — `createTestDb` runs migrations, picking up the new one)

- [ ] **Step 6: Run the full server suite (migration must not break anything)**

Run: `pnpm --filter @holi/server test`
Expected: all existing tests still PASS

- [ ] **Step 7: Commit**

```bash
git add apps/server/src/db/schema.ts apps/server/drizzle apps/server/test/git-schema.test.ts
git commit -m "feat(server): github_connections + vault_git tables"
```

---

### Task 3: Repo URL parsing

**Files:**
- Create: `apps/server/src/git/repo-url.ts`
- Test: `apps/server/test/repo-url.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// apps/server/test/repo-url.test.ts
import { describe, expect, it } from 'vitest'
import { parseGithubRepoUrl, sshRemote } from '../src/git/repo-url'

describe('parseGithubRepoUrl', () => {
  it.each([
    ['https://github.com/syv-ai/vault-x', 'syv-ai', 'vault-x'],
    ['https://github.com/syv-ai/vault-x.git', 'syv-ai', 'vault-x'],
    ['https://github.com/syv-ai/vault-x/', 'syv-ai', 'vault-x'],
    ['git@github.com:syv-ai/vault-x.git', 'syv-ai', 'vault-x'],
    ['git@github.com:syv-ai/vault-x', 'syv-ai', 'vault-x'],
  ])('parses %s', (raw, owner, repo) => {
    expect(parseGithubRepoUrl(raw)).toEqual({ owner, repo })
  })

  it.each([
    'https://gitlab.com/a/b',
    'https://github.com/only-owner',
    'https://github.com/a/b/c',
    'ftp://github.com/a/b',
    'not a url',
    'git@github.com:a',
  ])('rejects %s', (raw) => {
    expect(() => parseGithubRepoUrl(raw)).toThrow(/github/i)
  })
})

describe('sshRemote', () => {
  it('builds the ssh form', () => {
    expect(sshRemote({ owner: 'syv-ai', repo: 'vault-x' })).toBe('git@github.com:syv-ai/vault-x.git')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @holi/server exec vitest run test/repo-url.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement**

```ts
// apps/server/src/git/repo-url.ts
/** github.com only in v1 (design spec §Scope). */
export interface GithubRepo {
  owner: string
  repo: string
}

const SEGMENT = /^[A-Za-z0-9_.-]+$/

export function parseGithubRepoUrl(raw: string): GithubRepo {
  let ownerRepo: string | null = null
  const ssh = /^git@github\.com:(.+)$/.exec(raw.trim())
  if (ssh) {
    ownerRepo = ssh[1]!
  } else {
    let url: URL
    try {
      url = new URL(raw.trim())
    } catch {
      throw new Error('not a valid GitHub repository URL (github.com only)')
    }
    if (url.protocol !== 'https:' || url.hostname !== 'github.com') {
      throw new Error('only https://github.com/… repositories are supported')
    }
    ownerRepo = url.pathname.replace(/^\//, '')
  }
  const parts = ownerRepo.replace(/\/+$/, '').replace(/\.git$/, '').split('/')
  if (parts.length !== 2 || !parts.every((p) => p.length > 0 && SEGMENT.test(p))) {
    throw new Error('expected a github.com/<owner>/<repo> URL')
  }
  return { owner: parts[0]!, repo: parts[1]! }
}

export function sshRemote({ owner, repo }: GithubRepo): string {
  return `git@github.com:${owner}/${repo}.git`
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @holi/server exec vitest run test/repo-url.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/git/repo-url.ts apps/server/test/repo-url.test.ts
git commit -m "feat(server): GitHub repo URL parsing"
```

---

### Task 4: Git CLI wrapper + test helpers

**Files:**
- Create: `apps/server/src/git/git.ts`
- Create: `apps/server/src/test/git.ts`
- Test: `apps/server/test/git-cli.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// apps/server/test/git-cli.test.ts
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { git, gitBuffer, isAncestor, parseNameStatusZ, tryGit } from '../src/git/git'
import { commitAll, initBareRepo, initWorkdir } from '../src/test/git'

const cleanups: string[] = []
afterAll(async () => {
  for (const dir of cleanups) await rm(dir, { recursive: true, force: true })
})

async function scratch(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'holi-git-'))
  cleanups.push(dir)
  return dir
}

describe('git wrapper', () => {
  it('init/commit/rev-parse round-trip', async () => {
    const dir = await scratch()
    const work = await initWorkdir(join(dir, 'w'))
    await writeFile(join(work, 'a.md'), 'hello\n')
    const sha = await commitAll(work, 'first')
    expect(await git(['rev-parse', 'HEAD'], work)).toBe(sha)
  })

  it('gitBuffer returns exact bytes (no trailing-newline mangling)', async () => {
    const dir = await scratch()
    const work = await initWorkdir(join(dir, 'w'))
    await writeFile(join(work, 'a.md'), 'no trailing newline')
    const sha = await commitAll(work, 'c')
    const buf = await gitBuffer(['show', `${sha}:a.md`], work)
    expect(buf.toString('utf8')).toBe('no trailing newline')
  })

  it('isAncestor', async () => {
    const dir = await scratch()
    const work = await initWorkdir(join(dir, 'w'))
    await writeFile(join(work, 'a.md'), '1\n')
    const first = await commitAll(work, 'one')
    await writeFile(join(work, 'a.md'), '2\n')
    const second = await commitAll(work, 'two')
    expect(await isAncestor(work, first, second)).toBe(true)
    expect(await isAncestor(work, second, first)).toBe(false)
  })

  it('tryGit reports failure without throwing', async () => {
    const dir = await scratch()
    const work = await initWorkdir(join(dir, 'w'))
    const res = await tryGit(['rev-parse', 'origin/main'], work)
    expect(res.ok).toBe(false)
  })

  it('parseNameStatusZ handles A/M/D and renames', () => {
    const out = ['M\0a.md', 'A\0new.md', 'D\0gone.md', 'R100\0old.md\0moved.md', ''].join('\0')
    expect(parseNameStatusZ(out)).toEqual([
      { status: 'M', path: 'a.md' },
      { status: 'A', path: 'new.md' },
      { status: 'D', path: 'gone.md' },
      { status: 'R', path: 'moved.md', oldPath: 'old.md', similarity: 100 },
    ])
  })

  it('push to a bare remote and fetch back', async () => {
    const dir = await scratch()
    const bare = await initBareRepo(join(dir, 'bare.git'))
    const work = await initWorkdir(join(dir, 'w'))
    await git(['remote', 'add', 'origin', bare], work)
    await writeFile(join(work, 'a.md'), 'x\n')
    const sha = await commitAll(work, 'c')
    await git(['push', '-u', 'origin', 'main'], work)
    const work2 = await initWorkdir(join(dir, 'w2'))
    await git(['remote', 'add', 'origin', bare], work2)
    await git(['fetch', 'origin'], work2)
    expect(await git(['rev-parse', 'origin/main'], work2)).toBe(sha)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @holi/server exec vitest run test/git-cli.test.ts`
Expected: FAIL — modules not found

- [ ] **Step 3: Implement the wrapper**

```ts
// apps/server/src/git/git.ts
/** Thin git-CLI wrapper. All git I/O in the codebase goes through here so the
 * ssh environment (deploy keys) and error handling live in one place. */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const run = promisify(execFile)
const MAX_BUFFER = 64 * 1024 * 1024

export type GitEnv = Record<string, string>

/** Run git, return stdout with the single trailing newline stripped. */
export async function git(args: string[], cwd: string, env?: GitEnv): Promise<string> {
  const { stdout } = await run('git', args, {
    cwd,
    maxBuffer: MAX_BUFFER,
    env: { ...process.env, ...env },
  })
  return stdout.replace(/\n$/, '')
}

/** Run git, return raw stdout bytes (exact file contents for `show`). */
export async function gitBuffer(args: string[], cwd: string, env?: GitEnv): Promise<Buffer> {
  const { stdout } = await run('git', args, {
    cwd,
    maxBuffer: MAX_BUFFER,
    env: { ...process.env, ...env },
    encoding: 'buffer',
  })
  return stdout
}

export async function tryGit(
  args: string[],
  cwd: string,
  env?: GitEnv,
): Promise<{ ok: true; stdout: string } | { ok: false; error: string }> {
  try {
    return { ok: true, stdout: await git(args, cwd, env) }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

/** True when `ancestor` is an ancestor of (or equal to) `descendant`. */
export async function isAncestor(cwd: string, ancestor: string, descendant: string): Promise<boolean> {
  const res = await tryGit(['merge-base', '--is-ancestor', ancestor, descendant], cwd)
  return res.ok
}

export interface NameStatusEntry {
  status: 'A' | 'M' | 'D' | 'R'
  path: string
  oldPath?: string
  similarity?: number
}

/** Parse `git diff --name-status -M -z` output (NUL-separated). */
export function parseNameStatusZ(out: string): NameStatusEntry[] {
  const fields = out.split('\0').filter((f) => f.length > 0)
  const entries: NameStatusEntry[] = []
  let i = 0
  while (i < fields.length) {
    const code = fields[i]!
    if (code.startsWith('R') || code.startsWith('C')) {
      // copies (C) are treated as adds of the new path
      const oldPath = fields[i + 1]!
      const path = fields[i + 2]!
      if (code.startsWith('R')) {
        entries.push({ status: 'R', path, oldPath, similarity: Number(code.slice(1)) || undefined })
      } else {
        entries.push({ status: 'A', path })
      }
      i += 3
    } else if (code === 'A' || code === 'M' || code === 'D' || code === 'T') {
      // type changes (T) are content changes for our purposes
      entries.push({ status: code === 'T' ? 'M' : code, path: fields[i + 1]! })
      i += 2
    } else {
      // unmerged (U) etc. cannot occur on a plain two-commit diff — skip defensively
      i += 2
    }
  }
  return entries
}
```

- [ ] **Step 4: Implement the test helpers**

```ts
// apps/server/src/test/git.ts
/** Local-repo test helpers — tests never touch github.com or ssh. */
import { mkdir } from 'node:fs/promises'
import { git } from '../git/git'
import type { GithubApi } from '../git/github-api'

/** A bare repo standing in for the GitHub-hosted remote. Returns its path (usable as a git remote). */
export async function initBareRepo(dir: string): Promise<string> {
  await mkdir(dir, { recursive: true })
  await git(['init', '--bare', '--initial-branch=main', '.'], dir)
  return dir
}

/** A normal workdir repo on branch `main` with committer identity configured. */
export async function initWorkdir(dir: string): Promise<string> {
  await mkdir(dir, { recursive: true })
  await git(['init', '--initial-branch=main', '.'], dir)
  await git(['config', 'user.name', 'Test'], dir)
  await git(['config', 'user.email', 'test@example.com'], dir)
  return dir
}

/** Stage everything and commit as the given author; returns the commit sha. */
export async function commitAll(dir: string, message: string, authorEmail = 'test@example.com'): Promise<string> {
  await git(['add', '-A'], dir)
  await git(
    ['-c', `user.email=${authorEmail}`, '-c', 'user.name=Test', 'commit', '--allow-empty-message', '-m', message],
    dir,
  )
  return git(['rev-parse', 'HEAD'], dir)
}

/** In-memory GithubApi for wiring tests. */
export function fakeGithubApi(overrides: Partial<GithubApi> = {}): GithubApi & {
  deployKeys: Array<{ id: number; key: string }>
  webhooks: Array<{ id: number; url: string; secret: string }>
} {
  const deployKeys: Array<{ id: number; key: string }> = []
  const webhooks: Array<{ id: number; url: string; secret: string }> = []
  let nextId = 1
  return {
    deployKeys,
    webhooks,
    exchangeCode: async () => ({ accessToken: 'gho_fake' }),
    getUser: async () => ({ id: 999, login: 'fake-user' }),
    getRepo: async () => ({ defaultBranch: 'main', admin: true }),
    createDeployKey: async (_t, _o, _r, _title, key) => {
      const id = nextId++
      deployKeys.push({ id, key })
      return { id }
    },
    deleteDeployKey: async (_t, _o, _r, id) => {
      const i = deployKeys.findIndex((k) => k.id === id)
      if (i >= 0) deployKeys.splice(i, 1)
    },
    createWebhook: async (_t, _o, _r, url, secret) => {
      const id = nextId++
      webhooks.push({ id, url, secret })
      return { id }
    },
    deleteWebhook: async (_t, _o, _r, id) => {
      const i = webhooks.findIndex((w) => w.id === id)
      if (i >= 0) webhooks.splice(i, 1)
    },
    ...overrides,
  }
}
```

Note: `github-api.ts` doesn't exist yet — create a minimal placeholder so this compiles, filled in properly in Task 5:

```ts
// apps/server/src/git/github-api.ts  (placeholder — replaced in Task 5)
export interface GithubApi {
  exchangeCode(code: string): Promise<{ accessToken: string }>
  getUser(token: string): Promise<{ id: number; login: string }>
  getRepo(token: string, owner: string, repo: string): Promise<{ defaultBranch: string; admin: boolean }>
  createDeployKey(token: string, owner: string, repo: string, title: string, key: string): Promise<{ id: number }>
  deleteDeployKey(token: string, owner: string, repo: string, id: number): Promise<void>
  createWebhook(token: string, owner: string, repo: string, url: string, secret: string): Promise<{ id: number }>
  deleteWebhook(token: string, owner: string, repo: string, id: number): Promise<void>
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @holi/server exec vitest run test/git-cli.test.ts`
Expected: PASS (6 tests)

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/git/git.ts apps/server/src/git/github-api.ts apps/server/src/test/git.ts apps/server/test/git-cli.test.ts
git commit -m "feat(server): git CLI wrapper + local-repo test helpers"
```

---

### Task 5: GitHub API client

**Files:**
- Modify: `apps/server/src/git/github-api.ts` (replace the placeholder)
- Test: `apps/server/test/github-api.test.ts`

- [ ] **Step 1: Write the failing test** (a local HTTP server plays GitHub)

```ts
// apps/server/test/github-api.test.ts
import { createServer, type Server } from 'node:http'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createGithubApi } from '../src/git/github-api'

let server: Server
let baseUrl: string
const seen: Array<{ method: string; url: string; auth?: string; body?: unknown }> = []

beforeAll(async () => {
  server = createServer((req, res) => {
    let raw = ''
    req.on('data', (c: Buffer) => (raw += c.toString()))
    req.on('end', () => {
      seen.push({
        method: req.method!,
        url: req.url!,
        auth: req.headers.authorization,
        body: raw ? JSON.parse(raw) : undefined,
      })
      res.setHeader('content-type', 'application/json')
      if (req.url === '/login/oauth/access_token') return res.end(JSON.stringify({ access_token: 'gho_x' }))
      if (req.url === '/user') return res.end(JSON.stringify({ id: 7, login: 'nicolai' }))
      if (req.url === '/repos/o/r')
        return res.end(JSON.stringify({ default_branch: 'main', permissions: { admin: true } }))
      if (req.url === '/repos/o/r/keys') return res.end(JSON.stringify({ id: 11 }))
      if (req.url === '/repos/o/r/hooks') return res.end(JSON.stringify({ id: 22 }))
      res.statusCode = 404
      res.end('{}')
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const addr = server.address() as { port: number }
  baseUrl = `http://127.0.0.1:${addr.port}`
})
afterAll(() => server.close())

describe('createGithubApi', () => {
  it('drives the endpoints with the right auth + payloads', async () => {
    const api = createGithubApi({
      clientId: 'cid',
      clientSecret: 'csec',
      apiBaseUrl: baseUrl,
      oauthBaseUrl: baseUrl,
    })
    expect(await api.exchangeCode('the-code')).toEqual({ accessToken: 'gho_x' })
    expect(await api.getUser('gho_x')).toEqual({ id: 7, login: 'nicolai' })
    expect(await api.getRepo('gho_x', 'o', 'r')).toEqual({ defaultBranch: 'main', admin: true })
    expect(await api.createDeployKey('gho_x', 'o', 'r', 'holi', 'ssh-ed25519 AAA')).toEqual({ id: 11 })
    expect(await api.createWebhook('gho_x', 'o', 'r', 'https://x/webhooks/github', 's3c')).toEqual({ id: 22 })

    const keyReq = seen.find((r) => r.url === '/repos/o/r/keys')!
    expect(keyReq.auth).toBe('Bearer gho_x')
    expect(keyReq.body).toMatchObject({ key: 'ssh-ed25519 AAA', read_only: false })
    const hookReq = seen.find((r) => r.url === '/repos/o/r/hooks')!
    expect(hookReq.body).toMatchObject({
      events: ['push'],
      config: { url: 'https://x/webhooks/github', secret: 's3c', content_type: 'json' },
    })
  })

  it('throws a readable error on non-2xx', async () => {
    const api = createGithubApi({ clientId: 'c', clientSecret: 's', apiBaseUrl: baseUrl, oauthBaseUrl: baseUrl })
    await expect(api.getRepo('t', 'nope', 'nope')).rejects.toThrow(/404/)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @holi/server exec vitest run test/github-api.test.ts`
Expected: FAIL — `createGithubApi` not exported

- [ ] **Step 3: Implement (replace the whole placeholder file)**

```ts
// apps/server/src/git/github-api.ts
/** GitHub REST client. Interface-first so wiring code is testable with a fake
 * (src/test/git.ts). Only used at connect/disconnect + OAuth time — the
 * background sync loop never calls the GitHub API. */

export interface GithubApi {
  exchangeCode(code: string): Promise<{ accessToken: string }>
  getUser(token: string): Promise<{ id: number; login: string }>
  getRepo(token: string, owner: string, repo: string): Promise<{ defaultBranch: string; admin: boolean }>
  createDeployKey(token: string, owner: string, repo: string, title: string, key: string): Promise<{ id: number }>
  deleteDeployKey(token: string, owner: string, repo: string, id: number): Promise<void>
  createWebhook(token: string, owner: string, repo: string, url: string, secret: string): Promise<{ id: number }>
  deleteWebhook(token: string, owner: string, repo: string, id: number): Promise<void>
}

export interface GithubApiOptions {
  clientId: string
  clientSecret: string
  /** Overridable for tests. */
  apiBaseUrl?: string
  oauthBaseUrl?: string
}

export function createGithubApi(opts: GithubApiOptions): GithubApi {
  const api = opts.apiBaseUrl ?? 'https://api.github.com'
  const oauth = opts.oauthBaseUrl ?? 'https://github.com'

  async function call<T>(token: string | null, method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${api}${path}`, {
      method,
      headers: {
        accept: 'application/vnd.github+json',
        'user-agent': 'holi-server',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    })
    if (!res.ok) throw new Error(`GitHub API ${method} ${path} failed: ${res.status} ${await res.text()}`)
    if (res.status === 204) return undefined as T
    return (await res.json()) as T
  }

  return {
    async exchangeCode(code) {
      const res = await fetch(`${oauth}/login/oauth/access_token`, {
        method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/json', 'user-agent': 'holi-server' },
        body: JSON.stringify({ client_id: opts.clientId, client_secret: opts.clientSecret, code }),
      })
      if (!res.ok) throw new Error(`GitHub code exchange failed: ${res.status}`)
      const data = (await res.json()) as { access_token?: string; error_description?: string }
      if (!data.access_token) throw new Error(`GitHub code exchange failed: ${data.error_description ?? 'no token'}`)
      return { accessToken: data.access_token }
    },
    async getUser(token) {
      const u = await call<{ id: number; login: string }>(token, 'GET', '/user')
      return { id: u.id, login: u.login }
    },
    async getRepo(token, owner, repo) {
      const r = await call<{ default_branch: string; permissions?: { admin?: boolean } }>(
        token,
        'GET',
        `/repos/${owner}/${repo}`,
      )
      return { defaultBranch: r.default_branch, admin: r.permissions?.admin ?? false }
    },
    async createDeployKey(token, owner, repo, title, key) {
      const k = await call<{ id: number }>(token, 'POST', `/repos/${owner}/${repo}/keys`, {
        title,
        key,
        read_only: false,
      })
      return { id: k.id }
    },
    async deleteDeployKey(token, owner, repo, id) {
      await call<void>(token, 'DELETE', `/repos/${owner}/${repo}/keys/${id}`)
    },
    async createWebhook(token, owner, repo, url, secret) {
      const h = await call<{ id: number }>(token, 'POST', `/repos/${owner}/${repo}/hooks`, {
        name: 'web',
        active: true,
        events: ['push'],
        config: { url, secret, content_type: 'json' },
      })
      return { id: h.id }
    },
    async deleteWebhook(token, owner, repo, id) {
      await call<void>(token, 'DELETE', `/repos/${owner}/${repo}/hooks/${id}`)
    },
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @holi/server exec vitest run test/github-api.test.ts`
Expected: PASS (2 tests). Also run `pnpm --filter @holi/server exec vitest run test/git-cli.test.ts` — the fake in `src/test/git.ts` must still satisfy the interface.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/git/github-api.ts apps/server/test/github-api.test.ts
git commit -m "feat(server): GitHub REST client behind an injectable interface"
```

---

### Task 6: GitHub account linking (OAuth) + user-level router

**Files:**
- Create: `apps/server/src/git/oauth.ts`
- Create: `apps/server/src/routers/github.ts`
- Modify: `apps/server/src/routers/index.ts`
- Test: `apps/server/test/github-oauth.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// apps/server/test/github-oauth.test.ts
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { encryptionKey, openSealed } from '../src/crypto'
import { createGithubOAuth } from '../src/git/oauth'
import { githubConnections } from '../src/db/schema'
import { createTestDb, type TestDb } from '../src/test/db'
import { fakeGithubApi } from '../src/test/git'
import { seedUser } from '../src/test/fixtures'

let t: TestDb
beforeAll(async () => {
  t = await createTestDb()
})
afterAll(() => t.destroy())

describe('github oauth linking', () => {
  it('authorize URL carries client id + state; callback stores the encrypted token', async () => {
    const user = await seedUser(t.db)
    const api = fakeGithubApi({
      exchangeCode: async (code) => {
        expect(code).toBe('code-123')
        return { accessToken: 'gho_linked' }
      },
      getUser: async () => ({ id: 4242, login: 'nicolai' }),
    })
    const oauth = createGithubOAuth({ db: t.db, api, clientId: 'cid', publicBaseUrl: 'http://127.0.0.1:4000' })

    const url = new URL(oauth.authorizeUrl(user.id))
    expect(url.searchParams.get('client_id')).toBe('cid')
    expect(url.searchParams.get('scope')).toBe('repo admin:repo_hook')
    const state = url.searchParams.get('state')!
    expect(state.length).toBeGreaterThan(10)

    const html = await oauth.handleCallback({ code: 'code-123', state })
    expect(html).toContain('GitHub connected')

    const [row] = await t.db.select().from(githubConnections).where(eq(githubConnections.userId, user.id))
    expect(row!.githubLogin).toBe('nicolai')
    expect(row!.githubUserId).toBe(4242)
    expect(openSealed(row!.tokenCiphertext, encryptionKey())).toBe('gho_linked')
  })

  it('re-linking overwrites the existing connection', async () => {
    const user = await seedUser(t.db)
    const oauth = createGithubOAuth({
      db: t.db,
      api: fakeGithubApi({ getUser: async () => ({ id: 1, login: 'first' }) }),
      clientId: 'cid',
      publicBaseUrl: 'http://x',
    })
    await oauth.handleCallback({ code: 'c', state: new URL(oauth.authorizeUrl(user.id)).searchParams.get('state')! })
    const oauth2 = createGithubOAuth({
      db: t.db,
      api: fakeGithubApi({ getUser: async () => ({ id: 2, login: 'second' }) }),
      clientId: 'cid',
      publicBaseUrl: 'http://x',
    })
    await oauth2.handleCallback({ code: 'c', state: new URL(oauth2.authorizeUrl(user.id)).searchParams.get('state')! })
    const [row] = await t.db.select().from(githubConnections).where(eq(githubConnections.userId, user.id))
    expect(row!.githubLogin).toBe('second')
  })

  it('rejects an unknown or reused state', async () => {
    const user = await seedUser(t.db)
    const oauth = createGithubOAuth({ db: t.db, api: fakeGithubApi(), clientId: 'cid', publicBaseUrl: 'http://x' })
    await expect(oauth.handleCallback({ code: 'c', state: 'bogus' })).rejects.toThrow(/state/i)
    const state = new URL(oauth.authorizeUrl(user.id)).searchParams.get('state')!
    await oauth.handleCallback({ code: 'c', state })
    await expect(oauth.handleCallback({ code: 'c', state })).rejects.toThrow(/state/i)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @holi/server exec vitest run test/github-oauth.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement the OAuth service**

```ts
// apps/server/src/git/oauth.ts
/** GitHub account linking (auth-identity PRD §Linked accounts). The browser
 * flow: tRPC github.startConnect → authorizeUrl (system browser) → GitHub
 * redirects to `${publicBaseUrl}/github/oauth/callback` on the API server →
 * handleCallback exchanges the code server-side and stores the sealed token.
 * State nonces are in-memory: single-node, 10-min TTL, one-shot. */
import { randomBytes } from 'node:crypto'
import { encryptionKey, seal } from '../crypto'
import type { Db } from '../db/client'
import { githubConnections } from '../db/schema'
import type { GithubApi } from './github-api'

const STATE_TTL_MS = 10 * 60_000

export interface GithubOAuthDeps {
  db: Db
  api: GithubApi
  clientId: string
  publicBaseUrl: string
}

export function createGithubOAuth(deps: GithubOAuthDeps) {
  const pending = new Map<string, { userId: string; expiresAt: number }>()

  function authorizeUrl(userId: string): string {
    const state = randomBytes(24).toString('base64url')
    pending.set(state, { userId, expiresAt: Date.now() + STATE_TTL_MS })
    const url = new URL('https://github.com/login/oauth/authorize')
    url.searchParams.set('client_id', deps.clientId)
    url.searchParams.set('redirect_uri', `${deps.publicBaseUrl}/github/oauth/callback`)
    url.searchParams.set('scope', 'repo admin:repo_hook')
    url.searchParams.set('state', state)
    return url.href
  }

  /** Returns the HTML page shown in the user's browser tab. */
  async function handleCallback(params: { code: string; state: string }): Promise<string> {
    const entry = pending.get(params.state)
    pending.delete(params.state)
    if (!entry || entry.expiresAt < Date.now()) throw new Error('unknown or expired OAuth state')
    const { accessToken } = await deps.api.exchangeCode(params.code)
    const ghUser = await deps.api.getUser(accessToken)
    const values = {
      userId: entry.userId,
      githubUserId: ghUser.id,
      githubLogin: ghUser.login,
      tokenCiphertext: seal(accessToken, encryptionKey()),
      updatedAt: new Date(),
    }
    await deps.db
      .insert(githubConnections)
      .values(values)
      .onConflictDoUpdate({ target: githubConnections.userId, set: values })
    return `<!doctype html><meta charset="utf-8"><title>Holi</title>
<body style="font-family:system-ui;padding:3rem"><h1>GitHub connected ✓</h1>
<p>Signed in as <b>${ghUser.login}</b>. You can close this tab and return to Holi.</p>`
  }

  return { authorizeUrl, handleCallback }
}

export type GithubOAuth = ReturnType<typeof createGithubOAuth>
```

- [ ] **Step 4: Implement the user-level router and register it**

```ts
// apps/server/src/routers/github.ts
/** User-level GitHub account linking. Vault-level repo wiring is routers/git.ts. */
import { eq } from 'drizzle-orm'
import { TRPCError } from '@trpc/server'
import type { GithubOAuth } from '../git/oauth'
import { githubConnections } from '../db/schema'
import { authedProcedure, router } from '../trpc'

export function makeGithubRouter(oauth: GithubOAuth | null) {
  return router({
    /** Returns the URL the desktop opens in the system browser. */
    startConnect: authedProcedure.mutation(({ ctx }) => {
      if (!oauth)
        throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'GitHub OAuth is not configured on the server' })
      return { url: oauth.authorizeUrl(ctx.user.id) }
    }),

    connectionStatus: authedProcedure.query(async ({ ctx }) => {
      const [row] = await ctx.db
        .select({ githubLogin: githubConnections.githubLogin })
        .from(githubConnections)
        .where(eq(githubConnections.userId, ctx.user.id))
      return row ? { connected: true as const, login: row.githubLogin } : { connected: false as const }
    }),

    disconnect: authedProcedure.mutation(async ({ ctx }) => {
      await ctx.db.delete(githubConnections).where(eq(githubConnections.userId, ctx.user.id))
      return { ok: true }
    }),
  })
}
```

`routers/index.ts` currently builds a static `appRouter`. The github router needs the oauth service, so the app router becomes a factory. Change `apps/server/src/routers/index.ts`: keep every existing sub-router registration exactly as is, and wrap:

```ts
// apps/server/src/routers/index.ts — shape after the change (keep all existing imports/routers)
import type { GithubOAuth } from '../git/oauth'
import { makeGithubRouter } from './github'
// … existing imports …

export function makeAppRouter(opts: { githubOAuth: GithubOAuth | null }) {
  return router({
    // … every existing entry unchanged (auth, vaults, notes, tasks, membership, snapshots, reminders, userState …) …
    github: makeGithubRouter(opts.githubOAuth),
  })
}

/** Static type for clients (desktop imports the type only). */
export type AppRouter = ReturnType<typeof makeAppRouter>
```

If the file currently exports `appRouter` as a value used by `main.ts` and tests, update those call sites: `main.ts` builds `makeAppRouter({ githubOAuth })` (Task 12), and any test importing `appRouter` switches to `makeAppRouter({ githubOAuth: null })`. Check with `grep -rn "appRouter" apps --include='*.ts' | grep -v node_modules` and update every hit; the desktop's `AppRouter` **type** import keeps working.

- [ ] **Step 5: Run tests + typecheck**

Run: `pnpm --filter @holi/server exec vitest run test/github-oauth.test.ts && pnpm --filter @holi/server typecheck && pnpm --filter @holi/desktop typecheck`
Expected: PASS / clean — desktop typecheck confirms the `AppRouter` type seam survived

- [ ] **Step 6: Run the full server suite**

Run: `pnpm --filter @holi/server test`
Expected: PASS (call-site updates didn't break router tests)

- [ ] **Step 7: Commit**

```bash
git add apps/server/src/git/oauth.ts apps/server/src/routers/github.ts apps/server/src/routers/index.ts apps/server/test/github-oauth.test.ts
git commit -m "feat(server): GitHub account linking (OAuth) + github router"
```

---

### Task 7: Exporter — materialize vault → commit

**Files:**
- Create: `apps/server/src/git/exporter.ts`
- Test: `apps/server/test/exporter.test.ts`

The exporter materializes the **full** doc tree into the clone on every export (tiny markdown vaults — architecture §Materialization) and lets git compute the delta. `*.local.*` paths never export; tasks aren't docs so they're excluded by construction.

- [ ] **Step 1: Write the failing test**

```ts
// apps/server/test/exporter.test.ts
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as Y from 'yjs'
import { YDOC_TEXT_KEY } from '@holi/shared'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { docs, yjsDocs } from '../src/db/schema'
import { buildExportFiles, exportCommit } from '../src/git/exporter'
import { git } from '../src/git/git'
import { createTestDb, type TestDb } from '../src/test/db'
import { initWorkdir } from '../src/test/git'
import { seedUser, seedVault } from '../src/test/fixtures'

let t: TestDb
const cleanups: string[] = []
beforeAll(async () => {
  t = await createTestDb()
})
afterAll(async () => {
  await t.destroy()
  for (const d of cleanups) await rm(d, { recursive: true, force: true })
})

async function seedDoc(vaultId: string, path: string, text: string): Promise<string> {
  const [row] = await t.db.insert(docs).values({ vaultId, path, kind: 'note' }).returning()
  const ydoc = new Y.Doc()
  ydoc.getText(YDOC_TEXT_KEY).insert(0, text)
  await t.db.insert(yjsDocs).values({ docId: row!.id, state: Y.encodeStateAsUpdate(ydoc) })
  return row!.id
}

describe('exporter', () => {
  it('materializes docs incl. .claude, excludes *.local.*', async () => {
    const user = await seedUser(t.db)
    const vault = await seedVault(t.db, user.id)
    await seedDoc(vault.id, 'notes/a.md', '# A\n')
    await seedDoc(vault.id, '.claude/settings.json', '{}\n')
    await seedDoc(vault.id, '.holi/settings.local.json', 'NEVER\n')
    const files = await buildExportFiles(t.db, vault.id)
    expect([...files.keys()].sort()).toEqual(['.claude/settings.json', 'notes/a.md'])
  })

  it('exportCommit writes the tree, commits as the bot, and is idempotent', async () => {
    const user = await seedUser(t.db)
    const vault = await seedVault(t.db, user.id)
    await seedDoc(vault.id, 'notes/a.md', 'hello\n')
    const dir = await mkdtemp(join(tmpdir(), 'holi-export-'))
    cleanups.push(dir)
    const clone = await initWorkdir(join(dir, 'clone'))

    const sha1 = await exportCommit(t.db, vault.id, clone)
    expect(sha1).toMatch(/^[0-9a-f]{40}$/)
    expect(await readFile(join(clone, 'notes/a.md'), 'utf8')).toBe('hello\n')
    expect(await git(['log', '-1', '--format=%ae'], clone)).toBe('holi-relay@syv.ai')

    // no changes → no new commit
    expect(await exportCommit(t.db, vault.id, clone)).toBeNull()
  })

  it('removes files whose docs are gone (stale tree entries)', async () => {
    const user = await seedUser(t.db)
    const vault = await seedVault(t.db, user.id)
    const id = await seedDoc(vault.id, 'temp.md', 'x\n')
    await seedDoc(vault.id, 'keep.md', 'y\n')
    const dir = await mkdtemp(join(tmpdir(), 'holi-export-'))
    cleanups.push(dir)
    const clone = await initWorkdir(join(dir, 'clone'))
    await exportCommit(t.db, vault.id, clone)

    const { eq } = await import('drizzle-orm')
    await t.db.delete(docs).where(eq(docs.id, id))
    await exportCommit(t.db, vault.id, clone)
    const tree = await git(['ls-tree', '-r', '--name-only', 'HEAD'], clone)
    expect(tree.split('\n')).toEqual(['keep.md'])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @holi/server exec vitest run test/exporter.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement**

```ts
// apps/server/src/git/exporter.ts
/** Vault → mirror-clone materialization. Full-tree every time: write all doc
 * texts, delete anything else, `git add -A` — git computes the real delta, so
 * unchanged content produces no commit. */
import { mkdir, readdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { eq } from 'drizzle-orm'
import { config } from '../config'
import type { Db } from '../db/client'
import { docs, yjsDocs } from '../db/schema'
import { docFromState, docText } from '../yjs/doc-store'
import { git, tryGit } from './git'

/** `*.local.*` anywhere in the basename is machine-local — never exported. */
export function isLocalOnlyPath(path: string): boolean {
  const base = path.split('/').at(-1) ?? path
  return /\.local\./.test(base)
}

export async function buildExportFiles(db: Db, vaultId: string): Promise<Map<string, string>> {
  const rows = await db
    .select({ path: docs.path, state: yjsDocs.state })
    .from(docs)
    .innerJoin(yjsDocs, eq(yjsDocs.docId, docs.id))
    .where(eq(docs.vaultId, vaultId))
  const files = new Map<string, string>()
  for (const row of rows) {
    if (isLocalOnlyPath(row.path)) continue
    files.set(row.path, docText(docFromState(row.state)))
  }
  return files
}

/** Replace the clone's working tree (everything but .git) with `files`. */
export async function writeExportTree(cloneDir: string, files: Map<string, string>): Promise<void> {
  for (const entry of await readdir(cloneDir)) {
    if (entry === '.git') continue
    await rm(join(cloneDir, entry), { recursive: true, force: true })
  }
  for (const [path, text] of files) {
    const abs = join(cloneDir, path)
    await mkdir(dirname(abs), { recursive: true })
    await writeFile(abs, text, 'utf8')
  }
}

/** Materialize + commit as the bot. Returns the new commit sha, or null when
 * the tree is unchanged (nothing to commit). Does NOT push. */
export async function exportCommit(db: Db, vaultId: string, cloneDir: string): Promise<string | null> {
  const files = await buildExportFiles(db, vaultId)
  await writeExportTree(cloneDir, files)
  await git(['add', '-A'], cloneDir)
  const status = await git(['status', '--porcelain'], cloneDir)
  const headExists = (await tryGit(['rev-parse', 'HEAD'], cloneDir)).ok
  if (status === '' && headExists) return null
  const changed = status === '' ? 0 : status.split('\n').length
  await git(
    [
      '-c',
      `user.name=${config.git.botName}`,
      '-c',
      `user.email=${config.git.botEmail}`,
      'commit',
      '--allow-empty',
      '-m',
      `holi sync: ${changed} path(s) changed`,
    ],
    cloneDir,
  )
  return git(['rev-parse', 'HEAD'], cloneDir)
}
```

(`--allow-empty` only matters for the unborn-branch first commit of an empty vault; the `status === '' && headExists` guard prevents empty commits otherwise.)

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @holi/server exec vitest run test/exporter.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/git/exporter.ts apps/server/test/exporter.test.ts
git commit -m "feat(server): git exporter — full-tree materialization + bot commits"
```

---

### Task 8: Diff-apply (`fast-diff` → positioned Y.Text ops)

**Files:**
- Modify: `apps/server/package.json` (add `fast-diff`)
- Create: `apps/server/src/git/apply-diff.ts`
- Modify: `apps/server/src/yjs/snapshots.ts` (add `'pre-git-ingest'` reason)
- Test: `apps/server/test/apply-diff.test.ts`

- [ ] **Step 1: Add the dependency**

Run: `pnpm --filter @holi/server add fast-diff`
Expected: `fast-diff` (^1.x) in `apps/server/package.json` dependencies (ships its own types).

- [ ] **Step 2: Write the failing test**

```ts
// apps/server/test/apply-diff.test.ts
import * as Y from 'yjs'
import { YDOC_TEXT_KEY } from '@holi/shared'
import { describe, expect, it } from 'vitest'
import { applyTextDiff } from '../src/git/apply-diff'

function textDoc(initial: string): { ydoc: Y.Doc; text: Y.Text } {
  const ydoc = new Y.Doc()
  const text = ydoc.getText(YDOC_TEXT_KEY)
  text.insert(0, initial)
  return { ydoc, text }
}

describe('applyTextDiff', () => {
  it('applies an in-place edit as a minimal patch', () => {
    const { text } = textDoc('# Title\n\nbody line\n')
    applyTextDiff(text, '# Title\n\nbody line\n', '# Title\n\nbody line edited\n')
    expect(text.toString()).toBe('# Title\n\nbody line edited\n')
  })

  it('handles pure insert, pure delete, and full replace', () => {
    const a = textDoc('abc')
    applyTextDiff(a.text, 'abc', 'aXbc')
    expect(a.text.toString()).toBe('aXbc')

    const b = textDoc('aXbc')
    applyTextDiff(b.text, 'aXbc', 'abc')
    expect(b.text.toString()).toBe('abc')

    const c = textDoc('old')
    applyTextDiff(c.text, 'old', 'completely different')
    expect(c.text.toString()).toBe('completely different')
  })

  it('preserves concurrent edits to OTHER regions (the D25 property)', () => {
    // live doc has a concurrent edit at the top; the ingested diff touches the bottom
    const { text } = textDoc('LIVE EDIT\nintro\n\noutro\n')
    const base = 'intro\n\noutro\n' // what the last export saw
    const next = 'intro\n\noutro — changed by remote session\n'
    expect(applyTextDiff(text, base, next)).toBe(true) // diverged
    expect(text.toString()).toContain('LIVE EDIT')
    expect(text.toString()).toContain('changed by remote session')
  })

  it('returns false when the live text equals the base (clean apply)', () => {
    const { text } = textDoc('same\n')
    expect(applyTextDiff(text, 'same\n', 'same but new\n')).toBe(false)
  })
})
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm --filter @holi/server exec vitest run test/apply-diff.test.ts`
Expected: FAIL — module not found

- [ ] **Step 4: Implement**

```ts
// apps/server/src/git/apply-diff.ts
/** The server-side D25 shape: diff(base, next) applied as positioned ops onto
 * a LIVE Y.Text that may contain concurrent edits. Positions are computed
 * against `base`; when the live text has diverged, Yjs convergence semantics
 * apply (both texts survive; spike-verified — docs/spikes/2026-07-10-bridge-
 * turn-protocol.md). Callers snapshot before calling and surface a warning on
 * divergence. Returns true when the live text had diverged from base. */
import diff from 'fast-diff'
import type * as Y from 'yjs'

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
```

Add the ingest reason in `apps/server/src/yjs/snapshots.ts` — extend the union:

```ts
export type SnapshotReason =
  | 'interval'
  | 'manual'
  | 'pre-rename'
  | 'pre-agent-write'
  | 'pre-offline-merge'
  | 'pre-reconcile'
  | 'pre-restore'
  | 'pre-git-ingest'
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @holi/server exec vitest run test/apply-diff.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 6: Commit**

```bash
git add apps/server/package.json pnpm-lock.yaml apps/server/src/git/apply-diff.ts apps/server/src/yjs/snapshots.ts apps/server/test/apply-diff.test.ts
git commit -m "feat(server): fast-diff → positioned Y.Text ops (server-side D25 shape)"
```

---

### Task 9: Ingester — foreign commits → doc mutations

**Files:**
- Create: `apps/server/src/git/ingester.ts`
- Test: `apps/server/test/ingester.test.ts`

Edge policy (design spec): create/edit/delete map to doc ops; renames are identity-preserving path moves with **no** link rewrite (`renameNote` is deliberately NOT used — the remote commit carries its own link edits); binaries and unsafe paths are skipped with warnings; `*.local.*` is skipped with a warning.

- [ ] **Step 1: Write the failing test**

```ts
// apps/server/test/ingester.test.ts
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { and, eq } from 'drizzle-orm'
import * as Y from 'yjs'
import { YDOC_TEXT_KEY } from '@holi/shared'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { docs, yjsDocs, yjsSnapshots } from '../src/db/schema'
import { ingestRange } from '../src/git/ingester'
import { createTestDb, type TestDb } from '../src/test/db'
import { commitAll, initWorkdir } from '../src/test/git'
import { seedUser, seedVault } from '../src/test/fixtures'
import { docFromState, docText, loadDocState } from '../src/yjs/doc-store'

let t: TestDb
const cleanups: string[] = []
beforeAll(async () => {
  t = await createTestDb()
})
afterAll(async () => {
  await t.destroy()
  for (const d of cleanups) await rm(d, { recursive: true, force: true })
})

const deps = () => ({ db: t.db, getLiveDoc: () => null })

async function seedDoc(vaultId: string, path: string, text: string): Promise<string> {
  const [row] = await t.db.insert(docs).values({ vaultId, path, kind: 'note' }).returning()
  const ydoc = new Y.Doc()
  ydoc.getText(YDOC_TEXT_KEY).insert(0, text)
  await t.db.insert(yjsDocs).values({ docId: row!.id, state: Y.encodeStateAsUpdate(ydoc) })
  return row!.id
}

async function docTextAt(docId: string): Promise<string> {
  return docText(docFromState(await loadDocState(t.db, docId)))
}

/** Repo scaffold: base commit mirrors the seeded vault; callers then mutate + commit. */
async function repoWithBase(files: Record<string, string>): Promise<{ dir: string; base: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'holi-ingest-'))
  cleanups.push(dir)
  const work = await initWorkdir(join(dir, 'repo'))
  for (const [p, c] of Object.entries(files)) {
    await writeFile(join(work, p), c) // flat paths only in these fixtures
  }
  const base = await commitAll(work, 'base', 'holi-relay@syv.ai')
  return { dir: work, base }
}

describe('ingestRange', () => {
  it('modified file → positioned patch + pre-ingest snapshot', async () => {
    const user = await seedUser(t.db)
    const vault = await seedVault(t.db, user.id)
    const docId = await seedDoc(vault.id, 'a.md', 'intro\nbody\n')
    const { dir, base } = await repoWithBase({ 'a.md': 'intro\nbody\n' })
    await writeFile(join(dir, 'a.md'), 'intro\nbody — remote edit\n')
    const head = await commitAll(dir, 'remote change', 'someone@syv.ai')

    const warnings = await ingestRange(deps(), vault.id, dir, base, head)
    expect(warnings).toEqual([])
    expect(await docTextAt(docId)).toBe('intro\nbody — remote edit\n')
    const snaps = await t.db.select().from(yjsSnapshots).where(eq(yjsSnapshots.docId, docId))
    expect(snaps.some((s) => s.reason === 'pre-git-ingest')).toBe(true)
  })

  it('added file → new doc; deleted file → doc removed', async () => {
    const user = await seedUser(t.db)
    const vault = await seedVault(t.db, user.id)
    await seedDoc(vault.id, 'gone.md', 'bye\n')
    const { dir, base } = await repoWithBase({ 'gone.md': 'bye\n' })
    await writeFile(join(dir, 'new.md'), 'fresh from the cloud\n')
    await rm(join(dir, 'gone.md'))
    const head = await commitAll(dir, 'add+delete', 'someone@syv.ai')

    await ingestRange(deps(), vault.id, dir, base, head)
    const [created] = await t.db
      .select()
      .from(docs)
      .where(and(eq(docs.vaultId, vault.id), eq(docs.path, 'new.md')))
    expect(created).toBeDefined()
    expect(await docTextAt(created!.id)).toBe('fresh from the cloud\n')
    const gone = await t.db.select().from(docs).where(and(eq(docs.vaultId, vault.id), eq(docs.path, 'gone.md')))
    expect(gone).toHaveLength(0)
  })

  it('rename → path move preserving doc id, no link rewrite', async () => {
    const user = await seedUser(t.db)
    const vault = await seedVault(t.db, user.id)
    const movedId = await seedDoc(vault.id, 'old-name.md', 'stable content that stays identical\n')
    const refId = await seedDoc(vault.id, 'ref.md', 'see [[old-name.md]]\n')
    const { dir, base } = await repoWithBase({
      'old-name.md': 'stable content that stays identical\n',
      'ref.md': 'see [[old-name.md]]\n',
    })
    const { rename } = await import('node:fs/promises')
    await rename(join(dir, 'old-name.md'), join(dir, 'new-name.md'))
    const head = await commitAll(dir, 'rename', 'someone@syv.ai')

    await ingestRange(deps(), vault.id, dir, base, head)
    const [moved] = await t.db.select().from(docs).where(eq(docs.id, movedId))
    expect(moved!.path).toBe('new-name.md')
    expect(await docTextAt(refId)).toBe('see [[old-name.md]]\n') // dangling by design
  })

  it('binary, unsafe-path, and *.local.* files are skipped with warnings', async () => {
    const user = await seedUser(t.db)
    const vault = await seedVault(t.db, user.id)
    const { dir, base } = await repoWithBase({ 'a.md': 'x\n' })
    await writeFile(join(dir, 'img.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]))
    await writeFile(join(dir, 'settings.local.json'), '{}\n')
    const head = await commitAll(dir, 'junk', 'someone@syv.ai')

    const warnings = await ingestRange(deps(), vault.id, dir, base, head)
    const kinds = warnings.map((w) => w.kind).sort()
    expect(kinds).toContain('binary-skipped')
    expect(kinds).toContain('local-file-skipped')
    const rows = await t.db.select().from(docs).where(eq(docs.vaultId, vault.id))
    expect(rows.map((r) => r.path).sort()).toEqual([]) // nothing ingested
  })

  it('concurrent live divergence → applied with diverged-ingest warning', async () => {
    const user = await seedUser(t.db)
    const vault = await seedVault(t.db, user.id)
    const docId = await seedDoc(vault.id, 'a.md', 'LIVE\nintro\nbody\n') // vault moved past the export base
    const { dir, base } = await repoWithBase({ 'a.md': 'intro\nbody\n' })
    await writeFile(join(dir, 'a.md'), 'intro\nbody — remote\n')
    const head = await commitAll(dir, 'remote', 'someone@syv.ai')

    const warnings = await ingestRange(deps(), vault.id, dir, base, head)
    expect(warnings.some((w) => w.kind === 'diverged-ingest' && w.path === 'a.md')).toBe(true)
    const text = await docTextAt(docId)
    expect(text).toContain('LIVE')
    expect(text).toContain('remote')
  })
})
```

**Note on the unsafe-path case:** filesystems reject NUL in names, so an actual hostile path can't be committed from a workdir fixture. Assert the guard in a unit test inside the same file:

```ts
  it('unsafe paths are rejected by the path guard (unit)', async () => {
    const { safeIngestPath } = await import('../src/git/ingester')
    expect(safeIngestPath('../escape.md')).toBeNull()
    expect(safeIngestPath('ok/note.md')).toBe('ok/note.md')
  })
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @holi/server exec vitest run test/ingester.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement**

```ts
// apps/server/src/git/ingester.ts
/** Foreign-commit ingestion: diff base..head per file, mutate docs through the
 * live-room-aware editDocText so open editors receive remote-session edits
 * like a teammate's. Design: docs/specs/2026-07-13-vault-git-mirror-design.md. */
import { and, eq } from 'drizzle-orm'
import * as Y from 'yjs'
import { vaultRelPath, YDOC_TEXT_KEY } from '@holi/shared'
import type { Db } from '../db/client'
import { docs, yjsDocs, type GitWarning } from '../db/schema'
import { ensureAncestorFolders } from '../paths'
import type { GetLiveDoc } from '../trpc'
import { docFromState, docText, loadDocState } from '../yjs/doc-store'
import { editDocText } from '../yjs/edit'
import { refreshLinkIndex } from '../yjs/link-index'
import { takeSnapshot } from '../yjs/snapshots'
import { applyTextDiff } from './apply-diff'
import { isLocalOnlyPath } from './exporter'
import { git, gitBuffer, parseNameStatusZ, type NameStatusEntry } from './git'

export interface IngestDeps {
  db: Db
  getLiveDoc: GetLiveDoc
}

/** Validate a repo path for vault use; null when hostile/invalid. */
export function safeIngestPath(raw: string): string | null {
  try {
    return vaultRelPath(raw)
  } catch {
    return null
  }
}

function warning(kind: GitWarning['kind'], path: string, detail?: string): GitWarning {
  return { at: new Date().toISOString(), kind, path, detail }
}

async function blobAt(cloneDir: string, rev: string, path: string): Promise<Buffer> {
  return gitBuffer(['show', `${rev}:${path}`], cloneDir)
}

function isBinary(buf: Buffer): boolean {
  return buf.subarray(0, 8192).includes(0)
}

async function findDoc(db: Db, vaultId: string, path: string) {
  const [row] = await db
    .select()
    .from(docs)
    .where(and(eq(docs.vaultId, vaultId), eq(docs.path, path)))
  return row ?? null
}

async function createDoc(deps: IngestDeps, vaultId: string, path: string, text: string): Promise<void> {
  await deps.db.transaction(async (tx) => {
    await ensureAncestorFolders(tx, vaultId, path)
    const [row] = await tx.insert(docs).values({ vaultId, path, kind: 'note' }).onConflictDoNothing().returning()
    if (!row) return
    const ydoc = new Y.Doc()
    ydoc.getText(YDOC_TEXT_KEY).insert(0, text)
    await tx.insert(yjsDocs).values({ docId: row.id, state: Y.encodeStateAsUpdate(ydoc) })
  })
  const doc = await findDoc(deps.db, vaultId, path)
  if (doc) await refreshLinkIndex(deps.db, vaultId, doc.id, text)
}

/** Patch an existing doc: pre-snapshot, positioned diff, link_index refresh.
 * Returns true when the live text had diverged from the git base. */
async function patchDoc(
  deps: IngestDeps,
  vaultId: string,
  docId: string,
  baseText: string,
  nextText: string,
): Promise<boolean> {
  const preState = await loadDocState(deps.db, docId)
  if (preState) {
    await takeSnapshot(deps.db, {
      docId,
      state: preState,
      reason: 'pre-git-ingest',
      label: 'before remote-session changes merged',
    })
  }
  let diverged = false
  const { text } = await editDocText(deps.db, deps.getLiveDoc, docId, (yText) => {
    diverged = applyTextDiff(yText, baseText, nextText)
  })
  await refreshLinkIndex(deps.db, vaultId, docId, text)
  return diverged
}

export interface IngestOptions {
  /** Initial-connect mode: never touch paths that already have a doc
   * (vault-wins collision policy — the export overwrite follows). */
  skipExisting?: boolean
}

async function ingestEntry(
  deps: IngestDeps,
  vaultId: string,
  cloneDir: string,
  base: string,
  head: string,
  entry: NameStatusEntry,
  warnings: GitWarning[],
  opts: IngestOptions,
): Promise<void> {
  const path = safeIngestPath(entry.path)
  if (!path) return void warnings.push(warning('unsafe-path', entry.path))
  if (isLocalOnlyPath(path)) return void warnings.push(warning('local-file-skipped', path))
  if (opts.skipExisting && (await findDoc(deps.db, vaultId, path))) return

  if (entry.status === 'D') {
    const doc = await findDoc(deps.db, vaultId, path)
    // NOTE: no pre-delete snapshot — yjs_snapshots cascades on doc delete (same as notes.delete).
    if (doc) await deps.db.delete(docs).where(eq(docs.id, doc.id))
    return
  }

  const headBlob = await blobAt(cloneDir, head, path)
  if (isBinary(headBlob)) return void warnings.push(warning('binary-skipped', path))
  const nextText = headBlob.toString('utf8')

  if (entry.status === 'A') {
    const existing = await findDoc(deps.db, vaultId, path)
    if (existing) {
      // base didn't know this path but the vault has it → merge as edit against empty base
      const diverged = await patchDoc(deps, vaultId, existing.id, '', nextText)
      if (diverged) warnings.push(warning('diverged-ingest', path))
    } else {
      await createDoc(deps, vaultId, path, nextText)
    }
    return
  }

  if (entry.status === 'R') {
    const oldPath = safeIngestPath(entry.oldPath!)
    const doc = oldPath ? await findDoc(deps.db, vaultId, oldPath) : null
    if (!doc) {
      // nothing to move — treat as an add
      await ingestEntry(deps, vaultId, cloneDir, base, head, { status: 'A', path: entry.path }, warnings, opts)
      return
    }
    const occupied = await findDoc(deps.db, vaultId, path)
    if (occupied) {
      warnings.push(warning('rename-target-occupied', path, `kept ${oldPath}`))
    } else {
      // identity-preserving move; NO link rewrite (the commit carries its own link edits)
      await ensureAncestorFolders(deps.db, vaultId, path)
      await deps.db.update(docs).set({ path, updatedAt: new Date() }).where(eq(docs.id, doc.id))
    }
    const target = occupied ?? doc
    if ((entry.similarity ?? 100) < 100 || occupied) {
      const baseBlob = await blobAt(cloneDir, base, entry.oldPath!)
      if (!isBinary(baseBlob)) {
        const diverged = await patchDoc(deps, vaultId, target.id, baseBlob.toString('utf8'), nextText)
        if (diverged) warnings.push(warning('diverged-ingest', path))
      }
    }
    return
  }

  // 'M'
  const doc = await findDoc(deps.db, vaultId, path)
  if (!doc) {
    await createDoc(deps, vaultId, path, nextText)
    return
  }
  const baseBlob = await blobAt(cloneDir, base, path)
  const baseText = isBinary(baseBlob) ? '' : baseBlob.toString('utf8')
  const diverged = await patchDoc(deps, vaultId, doc.id, baseText, nextText)
  if (diverged) warnings.push(warning('diverged-ingest', path))
}

/** Ingest every file change in base..head. Returns accumulated warnings. */
export async function ingestRange(
  deps: IngestDeps,
  vaultId: string,
  cloneDir: string,
  base: string,
  head: string,
  opts: IngestOptions = {},
): Promise<GitWarning[]> {
  const out = await git(['diff', '--name-status', '-M', '-z', base, head], cloneDir)
  const entries = parseNameStatusZ(out)
  const warnings: GitWarning[] = []
  for (const entry of entries) {
    await ingestEntry(deps, vaultId, cloneDir, base, head, entry, warnings, opts)
  }
  return warnings
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @holi/server exec vitest run test/ingester.test.ts`
Expected: PASS (6 tests)

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/git/ingester.ts apps/server/test/ingester.test.ts
git commit -m "feat(server): git ingester — foreign commits to positioned doc mutations"
```

---

### Task 10: Sync orchestrator

**Files:**
- Create: `apps/server/src/git/sync.ts`
- Test: `apps/server/test/git-sync.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// apps/server/test/git-sync.test.ts
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { and, eq } from 'drizzle-orm'
import * as Y from 'yjs'
import { YDOC_TEXT_KEY } from '@holi/shared'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { encryptionKey, seal } from '../src/crypto'
import { docs, vaultGit, yjsDocs } from '../src/db/schema'
import { git } from '../src/git/git'
import { syncVault, withVaultLock } from '../src/git/sync'
import { createTestDb, type TestDb } from '../src/test/db'
import { commitAll, initBareRepo, initWorkdir } from '../src/test/git'
import { seedUser, seedVault } from '../src/test/fixtures'
import { docFromState, docText, loadDocState } from '../src/yjs/doc-store'

let t: TestDb
const cleanups: string[] = []
beforeAll(async () => {
  t = await createTestDb()
})
afterAll(async () => {
  await t.destroy()
  for (const d of cleanups) await rm(d, { recursive: true, force: true })
})

async function scratch(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'holi-sync-'))
  cleanups.push(dir)
  return dir
}

async function seedDoc(vaultId: string, path: string, text: string): Promise<string> {
  const [row] = await t.db.insert(docs).values({ vaultId, path, kind: 'note' }).returning()
  const ydoc = new Y.Doc()
  ydoc.getText(YDOC_TEXT_KEY).insert(0, text)
  await t.db.insert(yjsDocs).values({ docId: row!.id, state: Y.encodeStateAsUpdate(ydoc) })
  return row!.id
}

/** vault + vault_git row wired to a local bare remote; returns { vault, bare, mirrorDir }. */
async function gitVault() {
  const user = await seedUser(t.db)
  const vault = await seedVault(t.db, user.id)
  const dir = await scratch()
  const bare = await initBareRepo(join(dir, 'remote.git'))
  const key = encryptionKey()
  await t.db.insert(vaultGit).values({
    vaultId: vault.id,
    repoUrl: `https://github.com/test/${vault.id}`,
    remote: bare,
    defaultBranch: 'main',
    deployKeyCiphertext: seal('unused-for-file-remotes', key),
    deployKeyPublic: 'unused',
    webhookSecretCiphertext: seal('whsec', key),
    enabledBy: user.id,
  })
  return { vault, bare, mirrorDir: join(dir, 'mirrors'), user }
}

function deps(mirrorDir: string) {
  return { db: t.db, getLiveDoc: () => null, mirrorDir }
}

/** Read a path's content from the bare remote's main branch via a throwaway clone. */
async function remoteFile(bare: string, path: string): Promise<string | null> {
  const dir = await scratch()
  const probe = await initWorkdir(join(dir, 'probe'))
  await git(['remote', 'add', 'origin', bare], probe)
  await git(['fetch', 'origin'], probe)
  try {
    return await git(['show', `origin/main:${path}`], probe)
  } catch {
    return null
  }
}

describe('syncVault', () => {
  it('initial sync of an empty remote: exports the vault and sets base_commit', async () => {
    const { vault, bare, mirrorDir } = await gitVault()
    await seedDoc(vault.id, 'hello.md', 'hi\n')
    await syncVault(deps(mirrorDir), vault.id)
    expect(await remoteFile(bare, 'hello.md')).toBe('hi')
    const [row] = await t.db.select().from(vaultGit).where(eq(vaultGit.vaultId, vault.id))
    expect(row!.baseCommit).toMatch(/^[0-9a-f]{40}$/)
    expect(row!.status).toBe('ok')
    expect(row!.lastExportAt).not.toBeNull()
  })

  it('initial sync of a NON-empty remote: repo-only files ingest, collisions are vault-wins', async () => {
    const { vault, bare, mirrorDir } = await gitVault()
    await seedDoc(vault.id, 'both.md', 'vault version\n')
    const dir = await scratch()
    const seedRepo = await initWorkdir(join(dir, 'seed'))
    await git(['remote', 'add', 'origin', bare], seedRepo)
    await writeFile(join(seedRepo, 'both.md'), 'repo version\n')
    await writeFile(join(seedRepo, 'repo-only.md'), 'from the repo\n')
    await commitAll(seedRepo, 'preexisting', 'someone@else.dev')
    await git(['push', '-u', 'origin', 'main'], seedRepo)

    await syncVault(deps(mirrorDir), vault.id)

    const [repoOnly] = await t.db
      .select()
      .from(docs)
      .where(and(eq(docs.vaultId, vault.id), eq(docs.path, 'repo-only.md')))
    expect(repoOnly).toBeDefined()
    expect(await remoteFile(bare, 'both.md')).toBe('vault version') // vault wins, repo history keeps the old blob
  })

  it('foreign commit on the remote → ingested into docs; bot commits are not re-ingested', async () => {
    const { vault, bare, mirrorDir } = await gitVault()
    const docId = await seedDoc(vault.id, 'a.md', 'one\n')
    await syncVault(deps(mirrorDir), vault.id)

    // a remote session pushes a change
    const dir = await scratch()
    const remoteWork = await initWorkdir(join(dir, 'rw'))
    await git(['remote', 'add', 'origin', bare], remoteWork)
    await git(['fetch', 'origin'], remoteWork)
    await git(['reset', '--hard', 'origin/main'], remoteWork)
    await writeFile(join(remoteWork, 'a.md'), 'one\ntwo — from cloud session\n')
    await commitAll(remoteWork, 'cloud edit', 'employee@syv.ai')
    await git(['push', 'origin', 'main'], remoteWork)

    await syncVault(deps(mirrorDir), vault.id)
    expect(docText(docFromState(await loadDocState(t.db, docId)))).toBe('one\ntwo — from cloud session\n')
    const [row] = await t.db.select().from(vaultGit).where(eq(vaultGit.vaultId, vault.id))
    expect(row!.lastIngestAt).not.toBeNull()

    // resync with no new foreign commits must be a no-op (no double-ingest of bot exports)
    const before = row!.baseCommit
    await syncVault(deps(mirrorDir), vault.id)
    const [row2] = await t.db.select().from(vaultGit).where(eq(vaultGit.vaultId, vault.id))
    expect(row2!.baseCommit).toBe(before)
  })

  it('local + foreign changes: non-fast-forward push resolves via ingest-then-re-export', async () => {
    const { vault, bare, mirrorDir } = await gitVault()
    const docId = await seedDoc(vault.id, 'a.md', 'local\n')
    await syncVault(deps(mirrorDir), vault.id)

    // foreign commit lands...
    const dir = await scratch()
    const rw = await initWorkdir(join(dir, 'rw'))
    await git(['remote', 'add', 'origin', bare], rw)
    await git(['fetch', 'origin'], rw)
    await git(['reset', '--hard', 'origin/main'], rw)
    await writeFile(join(rw, 'foreign.md'), 'foreign\n')
    await commitAll(rw, 'foreign', 'someone@syv.ai')
    await git(['push', 'origin', 'main'], rw)

    // ...while the vault also changed
    const { editDocText } = await import('../src/yjs/edit')
    await editDocText(t.db, () => null, docId, (yt) => yt.insert(yt.length, 'more local\n'))

    await syncVault(deps(mirrorDir), vault.id)
    expect(await remoteFile(bare, 'a.md')).toBe('local\nmore local')
    expect(await remoteFile(bare, 'foreign.md')).toBe('foreign')
    const [fdoc] = await t.db
      .select()
      .from(docs)
      .where(and(eq(docs.vaultId, vault.id), eq(docs.path, 'foreign.md')))
    expect(fdoc).toBeDefined()
  })

  it('force-pushed remote → status attention, sync paused until resolved', async () => {
    const { vault, bare, mirrorDir } = await gitVault()
    await seedDoc(vault.id, 'a.md', 'x\n')
    await syncVault(deps(mirrorDir), vault.id)

    const dir = await scratch()
    const rw = await initWorkdir(join(dir, 'rw'))
    await git(['remote', 'add', 'origin', bare], rw)
    await writeFile(join(rw, 'rewritten.md'), 'history rewritten\n')
    await commitAll(rw, 'rewrite', 'someone@syv.ai')
    await git(['push', '--force', 'origin', 'main'], rw)

    await syncVault(deps(mirrorDir), vault.id)
    const [row] = await t.db.select().from(vaultGit).where(eq(vaultGit.vaultId, vault.id))
    expect(row!.status).toBe('attention')

    await syncVault(deps(mirrorDir), vault.id) // attention → no-op, no crash
    expect((await t.db.select().from(vaultGit).where(eq(vaultGit.vaultId, vault.id)))[0]!.status).toBe('attention')
  })
})

describe('withVaultLock', () => {
  it('serializes work per vault', async () => {
    const order: number[] = []
    const slow = withVaultLock('v1', async () => {
      await new Promise((r) => setTimeout(r, 30))
      order.push(1)
    })
    const fast = withVaultLock('v1', async () => {
      order.push(2)
    })
    await Promise.all([slow, fast])
    expect(order).toEqual([1, 2])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @holi/server exec vitest run test/git-sync.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement**

```ts
// apps/server/src/git/sync.ts
/** The per-vault sync loop: fetch → detect force-push → ingest foreign commits
 * → export → push (retrying through non-fast-forwards). Exactly one git writer
 * per vault, enforced by withVaultLock. */
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { eq, sql } from 'drizzle-orm'
import { config } from '../config'
import { encryptionKey, openSealed } from '../crypto'
import type { Db } from '../db/client'
import { vaultGit, type GitWarning } from '../db/schema'
import type { GetLiveDoc } from '../trpc'
import { exportCommit } from './exporter'
import { git, isAncestor, tryGit, type GitEnv } from './git'
import { ingestRange } from './ingester'

const MAX_PUSH_RETRIES = 5
const MAX_WARNINGS_KEPT = 50

export interface SyncDeps {
  db: Db
  getLiveDoc: GetLiveDoc
  /** Override for tests; defaults to config.git.mirrorDir. */
  mirrorDir?: string
}

/* ---------- per-vault serialization ---------- */

const chains = new Map<string, Promise<unknown>>()

export function withVaultLock<T>(vaultId: string, fn: () => Promise<T>): Promise<T> {
  const prev = chains.get(vaultId) ?? Promise.resolve()
  const next = prev.then(fn, fn)
  chains.set(
    vaultId,
    next.catch(() => undefined),
  )
  return next
}

/* ---------- clone + remote-auth plumbing ---------- */

export function cloneDirFor(deps: SyncDeps, vaultId: string): string {
  return join(deps.mirrorDir ?? config.git.mirrorDir, vaultId)
}

/** ssh remotes get GIT_SSH_COMMAND pointing at a 0600 temp copy of the deploy
 * key; filesystem remotes (tests) need nothing. Callers must invoke cleanup. */
async function remoteEnv(row: typeof vaultGit.$inferSelect): Promise<{ env: GitEnv; cleanup: () => Promise<void> }> {
  if (!row.remote.includes('@')) return { env: {}, cleanup: async () => {} }
  const dir = await mkdtemp(join(tmpdir(), 'holi-key-'))
  const keyFile = join(dir, 'key')
  await writeFile(keyFile, openSealed(row.deployKeyCiphertext, encryptionKey()) + '\n', { mode: 0o600 })
  return {
    env: { GIT_SSH_COMMAND: `ssh -i ${keyFile} -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new` },
    cleanup: () => rm(dir, { recursive: true, force: true }),
  }
}

async function ensureClone(deps: SyncDeps, row: typeof vaultGit.$inferSelect, env: GitEnv): Promise<string> {
  const dir = cloneDirFor(deps, row.vaultId)
  const probe = await tryGit(['rev-parse', '--git-dir'], dir).catch(() => ({ ok: false as const, error: 'no dir' }))
  if (probe.ok) return dir
  await mkdir(dir, { recursive: true })
  await git(['init', `--initial-branch=${row.defaultBranch}`, '.'], dir)
  await git(['remote', 'add', 'origin', row.remote], dir)
  const fetched = await tryGit(['fetch', 'origin'], dir, env)
  if (!fetched.ok) throw new Error(`cannot reach remote: ${fetched.error}`)
  return dir
}

/* ---------- status/warning bookkeeping ---------- */

async function setAttention(db: Db, vaultId: string, detail: string): Promise<void> {
  await db
    .update(vaultGit)
    .set({ status: 'attention', statusDetail: detail, updatedAt: new Date() })
    .where(eq(vaultGit.vaultId, vaultId))
}

async function appendWarnings(db: Db, vaultId: string, warnings: GitWarning[]): Promise<void> {
  if (warnings.length === 0) return
  await db
    .update(vaultGit)
    .set({
      warnings: sql`(
        select coalesce(jsonb_agg(w), '[]'::jsonb) from (
          select w from jsonb_array_elements(${vaultGit.warnings} || ${JSON.stringify(warnings)}::jsonb) as w
          order by w->>'at' desc limit ${MAX_WARNINGS_KEPT}
        ) sub
      )`,
      updatedAt: new Date(),
    })
    .where(eq(vaultGit.vaultId, vaultId))
}

/* ---------- the sync pass ---------- */

async function syncPass(deps: SyncDeps, vaultId: string): Promise<void> {
  const { db } = deps
  const [row] = await db.select().from(vaultGit).where(eq(vaultGit.vaultId, vaultId))
  if (!row || row.status !== 'ok') return

  const { env, cleanup } = await remoteEnv(row)
  try {
    const cloneDir = await ensureClone(deps, row, env)
    await tryGit(['fetch', 'origin'], cloneDir, env)
    await db.update(vaultGit).set({ lastFetchAt: new Date() }).where(eq(vaultGit.vaultId, vaultId))

    const remoteHead = await tryGit(['rev-parse', `origin/${row.defaultBranch}`], cloneDir)
    let base = row.baseCommit

    // ----- inbound -----
    if (remoteHead.ok) {
      const head = remoteHead.stdout
      if (base && head !== base) {
        if (!(await isAncestor(cloneDir, base, head))) {
          await setAttention(db, vaultId, `remote history was rewritten (force-push); re-connect or re-baseline`)
          return
        }
        const authors = await git(['log', '--format=%ae', `${base}..${head}`], cloneDir)
        const foreign = authors.split('\n').some((a) => a !== '' && a !== config.git.botEmail)
        if (foreign) {
          const warnings = await ingestRange(deps, vaultId, cloneDir, base, head)
          await appendWarnings(db, vaultId, warnings)
          await db.update(vaultGit).set({ lastIngestAt: new Date() }).where(eq(vaultGit.vaultId, vaultId))
        }
        base = head
      } else if (!base) {
        // first sync against a non-empty repo: repo-only files ingest as adds
        // (diff against git's empty tree); colliding paths are vault-wins —
        // skipExisting leaves them untouched and the export below overwrites
        // them on the remote, with the repo's version preserved in history.
        const emptyTree = await git(['hash-object', '-t', 'tree', '/dev/null'], cloneDir)
        const warnings = await ingestRange(deps, vaultId, cloneDir, emptyTree, head, { skipExisting: true })
        await appendWarnings(db, vaultId, warnings)
        base = head
      }
      await git(['checkout', '-B', row.defaultBranch, head], cloneDir)
    } else {
      // empty remote (unborn branch) — nothing to ingest
      await tryGit(['checkout', '-B', row.defaultBranch], cloneDir)
    }

    // ----- outbound (with non-fast-forward retry loop) -----
    for (let attempt = 0; attempt < MAX_PUSH_RETRIES; attempt++) {
      const sha = await exportCommit(db, vaultId, cloneDirFor(deps, vaultId))
      const target = sha ?? base
      if (sha) {
        const pushed = await tryGit(['push', '-u', 'origin', row.defaultBranch], cloneDirFor(deps, vaultId), env)
        if (!pushed.ok) {
          // someone pushed between our fetch and push: take their commits, retry
          await git(['fetch', 'origin'], cloneDirFor(deps, vaultId), env)
          const head = await git(['rev-parse', `origin/${row.defaultBranch}`], cloneDirFor(deps, vaultId))
          if (base && !(await isAncestor(cloneDirFor(deps, vaultId), base, head))) {
            await setAttention(db, vaultId, 'remote history was rewritten during push')
            return
          }
          if (base) {
            const warnings = await ingestRange(deps, vaultId, cloneDirFor(deps, vaultId), base, head)
            await appendWarnings(db, vaultId, warnings)
          }
          base = head
          await git(['checkout', '-B', row.defaultBranch, head], cloneDirFor(deps, vaultId))
          continue
        }
        await db
          .update(vaultGit)
          .set({ baseCommit: sha, lastExportAt: new Date(), statusDetail: null, updatedAt: new Date() })
          .where(eq(vaultGit.vaultId, vaultId))
        return
      }
      // nothing to export — just advance the base if ingest moved it
      if (target !== row.baseCommit) {
        await db
          .update(vaultGit)
          .set({ baseCommit: target, updatedAt: new Date() })
          .where(eq(vaultGit.vaultId, vaultId))
      }
      return
    }
    await setAttention(db, vaultId, `push kept failing after ${MAX_PUSH_RETRIES} attempts`)
  } catch (err) {
    await setAttention(db, vaultId, err instanceof Error ? err.message : String(err))
  } finally {
    await cleanup()
  }
}

/** Public entry point — serialized per vault. */
export function syncVault(deps: SyncDeps, vaultId: string): Promise<void> {
  return withVaultLock(vaultId, () => syncPass(deps, vaultId))
}
```

**Implementation note on `hash-object -t tree /dev/null`:** this yields git's empty-tree sha (`4b825dc6…`) portably, so `ingestRange(emptyTree, head, { skipExisting: true })` lists every repo file as an add while leaving paths that already have a doc untouched — the vault-wins collision policy. The test asserts the outcome that matters: `repo-only.md` ingested, `both.md` = vault version on the remote.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @holi/server exec vitest run test/git-sync.test.ts`
Expected: PASS (6 tests). These are the load-bearing tests of the whole feature — if the non-FF or force-push cases fail, fix the orchestrator, do not weaken the assertions.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/git/sync.ts apps/server/test/git-sync.test.ts
git commit -m "feat(server): git sync orchestrator — one locked writer per vault"
```

---

### Task 11: Vault-level wiring router (connect / disconnect / status / syncNow)

**Files:**
- Create: `apps/server/src/routers/git.ts`
- Modify: `apps/server/src/routers/index.ts`
- Test: `apps/server/test/git-wiring.test.ts`

- [ ] **Step 1: Write the failing test** (drives the router's service functions directly — router glue is thin)

```ts
// apps/server/test/git-wiring.test.ts
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { encryptionKey, seal } from '../src/crypto'
import { githubConnections, vaultGit } from '../src/db/schema'
import { connectRepo, disconnectRepo } from '../src/routers/git'
import { createTestDb, type TestDb } from '../src/test/db'
import { fakeGithubApi, initBareRepo } from '../src/test/git'
import { seedUser, seedVault } from '../src/test/fixtures'

let t: TestDb
const cleanups: string[] = []
beforeAll(async () => {
  t = await createTestDb()
})
afterAll(async () => {
  await t.destroy()
  for (const d of cleanups) await rm(d, { recursive: true, force: true })
})

async function scratch(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'holi-wire-'))
  cleanups.push(dir)
  return dir
}

async function linkGithub(userId: string): Promise<void> {
  await t.db.insert(githubConnections).values({
    userId,
    githubUserId: 1,
    githubLogin: 'owner',
    tokenCiphertext: seal('gho_owner', encryptionKey()),
  })
}

describe('connectRepo', () => {
  it('wires deploy key + webhook via the API and runs the initial sync', async () => {
    const user = await seedUser(t.db)
    const vault = await seedVault(t.db, user.id)
    await linkGithub(user.id)
    const dir = await scratch()
    const bare = await initBareRepo(join(dir, 'remote.git'))
    const api = fakeGithubApi()

    await connectRepo(
      { db: t.db, getLiveDoc: () => null, api, publicBaseUrl: 'https://holi.syv.ai', mirrorDir: join(dir, 'm') },
      { vaultId: vault.id, userId: user.id, repoUrl: 'https://github.com/syv-ai/vault-x', makeRemote: () => bare },
    )

    expect(api.deployKeys).toHaveLength(1)
    expect(api.deployKeys[0]!.key).toMatch(/^ssh-ed25519 /)
    expect(api.webhooks).toHaveLength(1)
    expect(api.webhooks[0]!.url).toBe('https://holi.syv.ai/webhooks/github')

    const [row] = await t.db.select().from(vaultGit).where(eq(vaultGit.vaultId, vault.id))
    expect(row).toBeDefined()
    expect(row!.status).toBe('ok')
    expect(row!.deployKeyId).toBe(api.deployKeys[0]!.id)
    expect(row!.webhookId).toBe(api.webhooks[0]!.id)
    expect(row!.baseCommit).toMatch(/^[0-9a-f]{40}$/) // initial export ran
  })

  it('refuses without a linked GitHub account / without admin access / when already connected', async () => {
    const user = await seedUser(t.db)
    const vault = await seedVault(t.db, user.id)
    const dir = await scratch()
    const base = {
      db: t.db,
      getLiveDoc: () => null,
      api: fakeGithubApi(),
      publicBaseUrl: 'https://x',
      mirrorDir: join(dir, 'm'),
    }
    const args = { vaultId: vault.id, userId: user.id, repoUrl: 'https://github.com/o/r' }

    await expect(connectRepo(base, args)).rejects.toThrow(/link.*github/i)

    await linkGithub(user.id)
    await expect(
      connectRepo({ ...base, api: fakeGithubApi({ getRepo: async () => ({ defaultBranch: 'main', admin: false }) }) }, args),
    ).rejects.toThrow(/admin/i)

    const bare = await initBareRepo(join(dir, 'remote.git'))
    await connectRepo(base, { ...args, makeRemote: () => bare })
    await expect(connectRepo(base, { ...args, makeRemote: () => bare })).rejects.toThrow(/already/i)
  })
})

describe('disconnectRepo', () => {
  it('removes the GitHub resources, the row, and the mirror clone', async () => {
    const user = await seedUser(t.db)
    const vault = await seedVault(t.db, user.id)
    await linkGithub(user.id)
    const dir = await scratch()
    const bare = await initBareRepo(join(dir, 'remote.git'))
    const api = fakeGithubApi()
    const deps = { db: t.db, getLiveDoc: () => null, api, publicBaseUrl: 'https://x', mirrorDir: join(dir, 'm') }
    await connectRepo(deps, { vaultId: vault.id, userId: user.id, repoUrl: 'https://github.com/o/r', makeRemote: () => bare })

    await disconnectRepo(deps, { vaultId: vault.id, userId: user.id })
    expect(api.deployKeys).toHaveLength(0)
    expect(api.webhooks).toHaveLength(0)
    expect(await t.db.select().from(vaultGit).where(eq(vaultGit.vaultId, vault.id))).toHaveLength(0)
    const { existsSync } = await import('node:fs')
    expect(existsSync(join(dir, 'm', vault.id))).toBe(false)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @holi/server exec vitest run test/git-wiring.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement service functions + router**

```ts
// apps/server/src/routers/git.ts
/** Vault-level git-mirror wiring + status. Owner-only mutations; the owner's
 * linked GitHub token is used ONLY here (wiring/un-wiring) — background sync
 * runs on the deploy key (design spec §Wiring). */
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { eq } from 'drizzle-orm'
import { TRPCError } from '@trpc/server'
import { z } from 'zod'
import { encryptionKey, openSealed, seal } from '../crypto'
import type { Db } from '../db/client'
import { githubConnections, vaultGit } from '../db/schema'
import type { GithubApi } from '../git/github-api'
import { parseGithubRepoUrl, sshRemote, type GithubRepo } from '../git/repo-url'
import { cloneDirFor, syncVault, withVaultLock } from '../git/sync'
import type { GetLiveDoc } from '../trpc'
import { ownerProcedure, router, vaultProcedure } from '../trpc'

const run = promisify(execFile)

export interface GitWiringDeps {
  db: Db
  getLiveDoc: GetLiveDoc
  api: GithubApi
  publicBaseUrl: string
  /** Test override — production uses config.git.mirrorDir via sync.ts default. */
  mirrorDir?: string
}

async function ownerGithubToken(db: Db, userId: string): Promise<string> {
  const [conn] = await db.select().from(githubConnections).where(eq(githubConnections.userId, userId))
  if (!conn)
    throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'link your GitHub account first (app settings)' })
  return openSealed(conn.tokenCiphertext, encryptionKey())
}

/** ed25519 keypair via ssh-keygen (already required for pushes; no native deps). */
async function generateDeployKey(comment: string): Promise<{ privateKey: string; publicKey: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'holi-keygen-'))
  try {
    await run('ssh-keygen', ['-t', 'ed25519', '-N', '', '-C', comment, '-f', join(dir, 'key')])
    return {
      privateKey: await readFile(join(dir, 'key'), 'utf8'),
      publicKey: (await readFile(join(dir, 'key.pub'), 'utf8')).trim(),
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

export async function connectRepo(
  deps: GitWiringDeps,
  args: { vaultId: string; userId: string; repoUrl: string; makeRemote?: (r: GithubRepo) => string },
): Promise<void> {
  const { db } = deps
  const [existing] = await db.select().from(vaultGit).where(eq(vaultGit.vaultId, args.vaultId))
  if (existing) throw new TRPCError({ code: 'CONFLICT', message: 'this vault is already connected to a repo' })

  const token = await ownerGithubToken(db, args.userId)
  const repo = parseGithubRepoUrl(args.repoUrl)
  const info = await deps.api.getRepo(token, repo.owner, repo.repo)
  if (!info.admin)
    throw new TRPCError({ code: 'FORBIDDEN', message: 'you need admin access to that repository' })

  const keys = await generateDeployKey(`holi-vault-${args.vaultId}`)
  const deployKey = await deps.api.createDeployKey(token, repo.owner, repo.repo, 'Holi vault mirror', keys.publicKey)
  const webhookSecret = randomBytes(24).toString('hex')
  const webhook = await deps.api.createWebhook(
    token,
    repo.owner,
    repo.repo,
    `${deps.publicBaseUrl}/webhooks/github`,
    webhookSecret,
  )

  const key = encryptionKey()
  await db.insert(vaultGit).values({
    vaultId: args.vaultId,
    repoUrl: args.repoUrl,
    remote: (args.makeRemote ?? sshRemote)(repo),
    defaultBranch: info.defaultBranch,
    deployKeyCiphertext: seal(keys.privateKey, key),
    deployKeyPublic: keys.publicKey,
    deployKeyId: deployKey.id,
    webhookId: webhook.id,
    webhookSecretCiphertext: seal(webhookSecret, key),
    enabledBy: args.userId,
  })

  await syncVault({ db, getLiveDoc: deps.getLiveDoc, mirrorDir: deps.mirrorDir }, args.vaultId)
  const [row] = await db.select().from(vaultGit).where(eq(vaultGit.vaultId, args.vaultId))
  if (row?.status === 'attention') {
    throw new TRPCError({ code: 'BAD_REQUEST', message: `connected, but the first sync failed: ${row.statusDetail}` })
  }
}

export async function disconnectRepo(deps: GitWiringDeps, args: { vaultId: string; userId: string }): Promise<void> {
  const { db } = deps
  const [row] = await db.select().from(vaultGit).where(eq(vaultGit.vaultId, args.vaultId))
  if (!row) throw new TRPCError({ code: 'NOT_FOUND', message: 'no repo connected' })
  // best-effort GitHub cleanup — the row and clone go away regardless
  try {
    const token = await ownerGithubToken(db, args.userId)
    const repo = parseGithubRepoUrl(row.repoUrl)
    if (row.deployKeyId) await deps.api.deleteDeployKey(token, repo.owner, repo.repo, row.deployKeyId)
    if (row.webhookId) await deps.api.deleteWebhook(token, repo.owner, repo.repo, row.webhookId)
  } catch (err) {
    console.warn('[git] best-effort GitHub cleanup failed:', err)
  }
  await withVaultLock(args.vaultId, async () => {
    await db.delete(vaultGit).where(eq(vaultGit.vaultId, args.vaultId))
    await rm(cloneDirFor({ db, getLiveDoc: deps.getLiveDoc, mirrorDir: deps.mirrorDir }, args.vaultId), {
      recursive: true,
      force: true,
    })
  })
}

export function makeGitRouter(deps: Omit<GitWiringDeps, 'db' | 'getLiveDoc'>) {
  return router({
    status: vaultProcedure.query(async ({ ctx }) => {
      const [row] = await ctx.db.select().from(vaultGit).where(eq(vaultGit.vaultId, ctx.vaultId))
      if (!row) return null
      return {
        repoUrl: row.repoUrl,
        defaultBranch: row.defaultBranch,
        status: row.status,
        statusDetail: row.statusDetail,
        warnings: row.warnings,
        lastExportAt: row.lastExportAt,
        lastIngestAt: row.lastIngestAt,
      }
    }),

    connectRepo: ownerProcedure.input(z.object({ repoUrl: z.string() })).mutation(({ ctx, input }) =>
      connectRepo(
        { ...deps, db: ctx.db, getLiveDoc: ctx.getLiveDoc },
        { vaultId: ctx.vaultId, userId: ctx.user.id, repoUrl: input.repoUrl },
      ),
    ),

    disconnectRepo: ownerProcedure.mutation(({ ctx }) =>
      disconnectRepo({ ...deps, db: ctx.db, getLiveDoc: ctx.getLiveDoc }, { vaultId: ctx.vaultId, userId: ctx.user.id }),
    ),

    syncNow: vaultProcedure.mutation(async ({ ctx }) => {
      await syncVault({ db: ctx.db, getLiveDoc: ctx.getLiveDoc, mirrorDir: deps.mirrorDir }, ctx.vaultId)
      return { ok: true }
    }),
  })
}
```

Register in `apps/server/src/routers/index.ts` — extend the factory options:

```ts
export function makeAppRouter(opts: {
  githubOAuth: GithubOAuth | null
  githubApi: GithubApi | null
  publicBaseUrl: string
}) {
  return router({
    // … existing entries …
    github: makeGithubRouter(opts.githubOAuth),
    git: makeGitRouter({
      api: opts.githubApi ?? unconfiguredGithubApi,
      publicBaseUrl: opts.publicBaseUrl,
    }),
  })
}
```

with a small guard next to it (wiring endpoints fail cleanly when GITHUB_CLIENT_ID isn't set; `git.status`/`syncNow` never touch the API):

```ts
import type { GithubApi } from '../git/github-api'
const unconfiguredGithubApi: GithubApi = new Proxy({} as GithubApi, {
  get: () => () => {
    throw new Error('GitHub OAuth app is not configured on the server (GITHUB_CLIENT_ID/SECRET)')
  },
})
```

Update every `makeAppRouter` call site again (tests from Task 6 gain `githubApi: null, publicBaseUrl: 'http://test'`).

- [ ] **Step 4: Run tests + typecheck**

Run: `pnpm --filter @holi/server exec vitest run test/git-wiring.test.ts && pnpm --filter @holi/server typecheck`
Expected: PASS / clean. Note: this test shells out to `ssh-keygen` — present on macOS/Linux dev machines and the Hetzner target by default.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/routers/git.ts apps/server/src/routers/index.ts apps/server/test/git-wiring.test.ts
git commit -m "feat(server): vault git wiring — connect/disconnect/status/syncNow"
```

---

### Task 12: Webhook endpoint + main.ts assembly

**Files:**
- Create: `apps/server/src/git/webhook.ts`
- Modify: `apps/server/src/main.ts`
- Test: `apps/server/test/webhook.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// apps/server/test/webhook.test.ts
import { createHmac } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { encryptionKey, seal } from '../src/crypto'
import { vaultGit } from '../src/db/schema'
import { makeGithubWebhookHandler } from '../src/git/webhook'
import { createTestDb, type TestDb } from '../src/test/db'
import { seedUser, seedVault } from '../src/test/fixtures'

let t: TestDb
beforeAll(async () => {
  t = await createTestDb()
})
afterAll(() => t.destroy())

function makeReqRes(body: string, headers: Record<string, string>) {
  const chunks = [Buffer.from(body)]
  const req = {
    headers,
    async *[Symbol.asyncIterator]() {
      yield* chunks
    },
  }
  const res = { statusCode: 0, ended: false, end(_?: string) { this.ended = true } }
  return { req: req as never, res: res as never, raw: res }
}

async function seedGitVault(secret: string, repoUrl = 'https://github.com/o/r') {
  const user = await seedUser(t.db)
  const vault = await seedVault(t.db, user.id)
  const key = encryptionKey()
  await t.db.insert(vaultGit).values({
    vaultId: vault.id,
    repoUrl,
    remote: '/tmp/unused',
    defaultBranch: 'main',
    deployKeyCiphertext: seal('k', key),
    deployKeyPublic: 'p',
    webhookSecretCiphertext: seal(secret, key),
    enabledBy: user.id,
  })
  return vault
}

function sign(secret: string, body: string): string {
  return 'sha256=' + createHmac('sha256', secret).update(body).digest('hex')
}

describe('github webhook', () => {
  it('valid signature → 202 and triggers a sync for the matching vault', async () => {
    const vault = await seedGitVault('s3cret')
    const synced: string[] = []
    const handler = makeGithubWebhookHandler({ db: t.db, triggerSync: async (id) => void synced.push(id) })
    const body = JSON.stringify({ repository: { full_name: 'o/r' } })
    const { req, res, raw } = makeReqRes(body, {
      'x-github-event': 'push',
      'x-hub-signature-256': sign('s3cret', body),
    })
    await handler(req, res)
    expect((raw as { statusCode: number }).statusCode).toBe(202)
    await vi.waitFor(() => expect(synced).toEqual([vault.id]))
  })

  it('bad signature → 401, no sync', async () => {
    await seedGitVault('right', 'https://github.com/o/r2')
    const synced: string[] = []
    const handler = makeGithubWebhookHandler({ db: t.db, triggerSync: async (id) => void synced.push(id) })
    const body = JSON.stringify({ repository: { full_name: 'o/r2' } })
    const { req, res, raw } = makeReqRes(body, {
      'x-github-event': 'push',
      'x-hub-signature-256': sign('wrong', body),
    })
    await handler(req, res)
    expect((raw as { statusCode: number }).statusCode).toBe(401)
    expect(synced).toEqual([])
  })

  it('ping event with a valid signature → 204', async () => {
    await seedGitVault('pingsec', 'https://github.com/o/r3')
    const handler = makeGithubWebhookHandler({ db: t.db, triggerSync: async () => {} })
    const body = JSON.stringify({ zen: 'x', repository: { full_name: 'o/r3' } })
    const { req, res, raw } = makeReqRes(body, {
      'x-github-event': 'ping',
      'x-hub-signature-256': sign('pingsec', body),
    })
    await handler(req, res)
    expect((raw as { statusCode: number }).statusCode).toBe(204)
  })

  it('unknown repository → 404', async () => {
    const handler = makeGithubWebhookHandler({ db: t.db, triggerSync: async () => {} })
    const body = JSON.stringify({ repository: { full_name: 'nobody/nothing' } })
    const { req, res, raw } = makeReqRes(body, {
      'x-github-event': 'push',
      'x-hub-signature-256': 'sha256=deadbeef',
    })
    await handler(req, res)
    expect((raw as { statusCode: number }).statusCode).toBe(404)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @holi/server exec vitest run test/webhook.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement the handler**

```ts
// apps/server/src/git/webhook.ts
/** GitHub push webhook: HMAC-verified against the vault's stored secret, then
 * fire-and-forget sync. Webhooks are a latency optimization — correctness is
 * carried by the scheduler's fetch backstop (design spec §Ingester). */
import { createHmac, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { encryptionKey, openSealed } from '../crypto'
import type { Db } from '../db/client'
import { vaultGit } from '../db/schema'
import { parseGithubRepoUrl } from './repo-url'

export interface WebhookDeps {
  db: Db
  triggerSync: (vaultId: string) => Promise<void>
}

function validSignature(secret: string, body: Buffer, header: string | undefined): boolean {
  if (!header?.startsWith('sha256=')) return false
  const expected = createHmac('sha256', secret).update(body).digest()
  const got = Buffer.from(header.slice('sha256='.length), 'hex')
  return got.length === expected.length && timingSafeEqual(got, expected)
}

export function makeGithubWebhookHandler(deps: WebhookDeps) {
  return async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(chunk as Buffer)
    const body = Buffer.concat(chunks)

    let fullName: string | undefined
    try {
      fullName = (JSON.parse(body.toString('utf8')) as { repository?: { full_name?: string } }).repository?.full_name
    } catch {
      /* fall through to 400 */
    }
    if (!fullName) {
      res.statusCode = 400
      return void res.end('malformed payload')
    }

    // find the vault(s) whose configured repo matches the payload's repository
    const rows = await deps.db.select().from(vaultGit)
    const key = encryptionKey()
    const match = rows.find((r) => {
      try {
        const repo = parseGithubRepoUrl(r.repoUrl)
        return `${repo.owner}/${repo.repo}`.toLowerCase() === fullName!.toLowerCase()
      } catch {
        return false
      }
    })
    if (!match) {
      res.statusCode = 404
      return void res.end('unknown repository')
    }
    const secret = openSealed(match.webhookSecretCiphertext, key)
    if (!validSignature(secret, body, req.headers['x-hub-signature-256'] as string | undefined)) {
      res.statusCode = 401
      return void res.end('bad signature')
    }

    if (req.headers['x-github-event'] === 'ping') {
      res.statusCode = 204
      return void res.end()
    }

    res.statusCode = 202
    res.end('accepted')
    void deps.triggerSync(match.vaultId).catch((err) => console.error('[git] webhook-triggered sync failed', err))
  }
}
```

- [ ] **Step 4: Assemble main.ts**

Replace the tRPC server block in `apps/server/src/main.ts` (keep relay + migrations + reminder evaluator exactly as they are):

```ts
// new imports at the top
import { createServer } from 'node:http'
import { createHTTPHandler } from '@trpc/server/adapters/standalone'
import { createGithubApi } from './git/github-api'
import { createGithubOAuth } from './git/oauth'
import { createGitScheduler } from './git/scheduler'
import { syncVault } from './git/sync'
import { makeGithubWebhookHandler } from './git/webhook'
import { makeAppRouter } from './routers'

// …inside main(), replacing the createHTTPServer(...) block:
  const githubApi =
    config.github.clientId && config.github.clientSecret
      ? createGithubApi({ clientId: config.github.clientId, clientSecret: config.github.clientSecret })
      : null
  const githubOAuth = githubApi
    ? createGithubOAuth({ db, api: githubApi, clientId: config.github.clientId!, publicBaseUrl: config.publicBaseUrl })
    : null

  const appRouter = makeAppRouter({ githubOAuth, githubApi, publicBaseUrl: config.publicBaseUrl })
  const trpcHandler = createHTTPHandler({
    router: appRouter,
    createContext: makeCreateContext({ db, bus, getLiveDoc }),
  })
  const webhookHandler = makeGithubWebhookHandler({
    db,
    triggerSync: (vaultId) => syncVault({ db, getLiveDoc }, vaultId),
  })

  createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/webhooks/github') return void webhookHandler(req, res)
    if (req.method === 'GET' && req.url?.startsWith('/github/oauth/callback')) {
      const url = new URL(req.url, config.publicBaseUrl)
      const code = url.searchParams.get('code')
      const state = url.searchParams.get('state')
      if (!githubOAuth || !code || !state) {
        res.statusCode = 400
        return void res.end('bad request')
      }
      void githubOAuth
        .handleCallback({ code, state })
        .then((html) => {
          res.setHeader('content-type', 'text/html; charset=utf-8')
          res.end(html)
        })
        .catch((err) => {
          res.statusCode = 400
          res.end(`GitHub connection failed: ${err instanceof Error ? err.message : err}`)
        })
      return
    }
    trpcHandler(req, res)
  }).listen(config.apiPort)
  console.log(`[api] tRPC + git endpoints listening on http://127.0.0.1:${config.apiPort}`)

  createGitScheduler({ db, getLiveDoc }).start()
  console.log('[git] mirror scheduler started')
```

`createGitScheduler` doesn't exist yet — Task 13 creates it; to keep this task compilable, add the scheduler stub there first OR do Tasks 12–13 in one sitting and typecheck at the end of 13. Recommended: implement Task 13's scheduler file before running this task's typecheck.

- [ ] **Step 5: Run test**

Run: `pnpm --filter @holi/server exec vitest run test/webhook.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 6: Commit** (fold into Task 13's commit if you deferred the typecheck)

```bash
git add apps/server/src/git/webhook.ts apps/server/src/main.ts apps/server/test/webhook.test.ts
git commit -m "feat(server): GitHub webhook endpoint + http route assembly"
```

---

### Task 13: Scheduler — quiet-window export + fetch backstop

**Files:**
- Create: `apps/server/src/git/scheduler.ts`
- Test: `apps/server/test/git-scheduler.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// apps/server/test/git-scheduler.test.ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { encryptionKey, seal } from '../src/crypto'
import { docs, vaultGit } from '../src/db/schema'
import { shouldSync } from '../src/git/scheduler'
import { createTestDb, type TestDb } from '../src/test/db'
import { seedUser, seedVault } from '../src/test/fixtures'

let t: TestDb
beforeAll(async () => {
  t = await createTestDb()
})
afterAll(() => t.destroy())

const T0 = new Date('2026-07-13T12:00:00Z').getTime()
const tunables = { quietMs: 45_000, maxQuietMs: 300_000, fetchBackstopMs: 3_600_000 }

function row(overrides: Partial<{ lastExportAt: Date | null; lastFetchAt: Date | null }>) {
  return { lastExportAt: null, lastFetchAt: new Date(T0), ...overrides }
}

describe('shouldSync', () => {
  it('dirty + quiet → sync', () => {
    expect(
      shouldSync(row({ lastExportAt: new Date(T0 - 600_000) }), new Date(T0 - 60_000), new Date(T0), tunables),
    ).toBe(true)
  })

  it('dirty but still being edited → wait', () => {
    expect(
      shouldSync(row({ lastExportAt: new Date(T0 - 60_000) }), new Date(T0 - 5_000), new Date(T0), tunables),
    ).toBe(false)
  })

  it('dirty, never quiet, but overdue (maxQuietMs since last export) → sync anyway', () => {
    expect(
      shouldSync(row({ lastExportAt: new Date(T0 - 400_000) }), new Date(T0 - 5_000), new Date(T0), tunables),
    ).toBe(true)
  })

  it('clean but fetch backstop due → sync (fetch-only)', () => {
    expect(shouldSync(row({ lastFetchAt: new Date(T0 - 4_000_000) }), null, new Date(T0), tunables)).toBe(true)
  })

  it('clean, recently fetched → idle', () => {
    expect(shouldSync(row({}), null, new Date(T0), tunables)).toBe(false)
  })
})

describe('tick wiring', () => {
  it('invokes syncVault for exactly the vaults that need it', async () => {
    const user = await seedUser(t.db)
    const vault = await seedVault(t.db, user.id)
    const key = encryptionKey()
    await t.db.insert(vaultGit).values({
      vaultId: vault.id,
      repoUrl: 'https://github.com/o/r',
      remote: '/unused',
      defaultBranch: 'main',
      deployKeyCiphertext: seal('k', key),
      deployKeyPublic: 'p',
      webhookSecretCiphertext: seal('s', key),
      enabledBy: user.id,
      lastFetchAt: new Date(), // fresh — no backstop
    })
    // one dirty doc, old enough to be quiet
    await t.db.insert(docs).values({
      vaultId: vault.id,
      path: 'a.md',
      kind: 'note',
      updatedAt: new Date(Date.now() - 120_000),
    })

    const { createGitScheduler } = await import('../src/git/scheduler')
    const synced: string[] = []
    const sched = createGitScheduler({
      db: t.db,
      getLiveDoc: () => null,
      syncImpl: async (_deps, vaultId) => void synced.push(vaultId),
    })
    await sched.tick()
    expect(synced).toEqual([vault.id])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @holi/server exec vitest run test/git-scheduler.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement**

```ts
// apps/server/src/git/scheduler.ts
/** Poll loop (reminders/evaluator.ts pattern): export when a vault has been
 * dirty-and-quiet (or dirty too long), and fetch on the hourly backstop even
 * when idle — webhooks are latency, this loop is correctness. */
import { eq, max } from 'drizzle-orm'
import { config } from '../config'
import type { Db } from '../db/client'
import { docs, vaultGit } from '../db/schema'
import type { GetLiveDoc } from '../trpc'
import { syncVault, type SyncDeps } from './sync'

export interface SchedulerTunables {
  quietMs: number
  maxQuietMs: number
  fetchBackstopMs: number
}

export function shouldSync(
  row: { lastExportAt: Date | null; lastFetchAt: Date | null },
  latestDocChange: Date | null,
  now: Date,
  tunables: SchedulerTunables = config.git,
): boolean {
  const dirty =
    latestDocChange !== null && (row.lastExportAt === null || latestDocChange > row.lastExportAt)
  if (dirty) {
    const quiet = now.getTime() - latestDocChange.getTime() >= tunables.quietMs
    const overdue =
      row.lastExportAt !== null && now.getTime() - row.lastExportAt.getTime() >= tunables.maxQuietMs
    if (quiet || overdue || row.lastExportAt === null) return true
  }
  const lastFetch = row.lastFetchAt?.getTime() ?? 0
  return now.getTime() - lastFetch >= tunables.fetchBackstopMs
}

export function createGitScheduler(deps: {
  db: Db
  getLiveDoc: GetLiveDoc
  mirrorDir?: string
  /** Test seam. */
  syncImpl?: (deps: SyncDeps, vaultId: string) => Promise<void>
}) {
  const sync = deps.syncImpl ?? syncVault
  let timer: NodeJS.Timeout | undefined
  let stopped = false

  async function tick(now = new Date()): Promise<void> {
    const rows = await deps.db
      .select()
      .from(vaultGit)
      .where(eq(vaultGit.status, 'ok'))
    for (const row of rows) {
      const [agg] = await deps.db
        .select({ latest: max(docs.updatedAt) })
        .from(docs)
        .where(eq(docs.vaultId, row.vaultId))
      if (shouldSync(row, agg?.latest ?? null, now)) {
        try {
          await sync({ db: deps.db, getLiveDoc: deps.getLiveDoc, mirrorDir: deps.mirrorDir }, row.vaultId)
        } catch (err) {
          console.error(`[git] sync failed for vault ${row.vaultId}`, err)
        }
      }
    }
  }

  function start(): void {
    const loop = async (): Promise<void> => {
      if (stopped) return
      await tick().catch((err) => console.error('[git] scheduler tick failed', err))
      if (!stopped) timer = setTimeout(loop, config.git.tickMs)
    }
    void loop()
  }

  function stop(): void {
    stopped = true
    clearTimeout(timer)
  }

  return { start, stop, tick }
}
```

- [ ] **Step 4: Run tests + full suite + typecheck**

Run: `pnpm --filter @holi/server exec vitest run test/git-scheduler.test.ts && pnpm --filter @holi/server test && pnpm --filter @holi/server typecheck`
Expected: all PASS (main.ts from Task 12 now compiles)

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/git/scheduler.ts apps/server/test/git-scheduler.test.ts
git commit -m "feat(server): git mirror scheduler — quiet-window export + fetch backstop"
```

---

### Task 14: Desktop — GitHub connect + vault git settings

**Files:**
- Modify: `apps/desktop/src/main/ipc.ts` (add `holi:openExternal`)
- Modify: `apps/desktop/src/preload/index.ts`
- Create: `apps/desktop/src/renderer/src/state/git.ts`
- Create: `apps/desktop/src/renderer/src/components/VaultSettings.tsx`
- Modify: `apps/desktop/src/renderer/src/components/Shell.tsx`
- Test: `apps/desktop/test/git-state.test.ts` (if the desktop tests live elsewhere, follow the existing `vitest` config — check `apps/desktop/vitest.config.ts` / existing test locations first and match them)

- [ ] **Step 1: Add the openExternal IPC**

In `apps/desktop/src/main/ipc.ts`, inside `registerIpc` (shell is already imported):

```ts
  ipcMain.handle('holi:openExternal', (_e, url: string) => {
    if (!/^https:\/\//.test(url)) throw new Error('only https URLs can be opened')
    return shell.openExternal(url)
  })
```

In `apps/desktop/src/preload/index.ts`, add to the exposed object:

```ts
  openExternal: (url: string) => ipcRenderer.invoke('holi:openExternal', url),
```

and mirror it in the renderer's `global.d.ts` `window.holi` type (match the existing declarations style).

- [ ] **Step 2: Write the failing state test**

```ts
// apps/desktop/test/git-state.test.ts  (match existing desktop test dir/style)
import { describe, expect, it } from 'vitest'
import { describeGitStatus } from '../src/renderer/src/state/git'

describe('describeGitStatus', () => {
  it('renders the not-connected state', () => {
    expect(describeGitStatus(null)).toEqual({ label: 'Not connected', tone: 'idle' })
  })
  it('renders ok with last export time', () => {
    const s = describeGitStatus({
      repoUrl: 'https://github.com/o/r',
      defaultBranch: 'main',
      status: 'ok',
      statusDetail: null,
      warnings: [],
      lastExportAt: '2026-07-13T10:00:00.000Z',
      lastIngestAt: null,
    })
    expect(s.label).toContain('Synced')
    expect(s.tone).toBe('ok')
  })
  it('surfaces attention with the detail', () => {
    const s = describeGitStatus({
      repoUrl: 'https://github.com/o/r',
      defaultBranch: 'main',
      status: 'attention',
      statusDetail: 'remote history was rewritten',
      warnings: [],
      lastExportAt: null,
      lastIngestAt: null,
    })
    expect(s.label).toContain('needs attention')
    expect(s.tone).toBe('error')
  })
})
```

- [ ] **Step 3: Implement state + pane**

```ts
// apps/desktop/src/renderer/src/state/git.ts
/** Vault git-mirror + GitHub-connection state (thin — server owns everything). */
import { atom } from 'jotai'
import { trpc } from '../lib/trpc'
import { activeVaultIdAtom } from './vaults'

export interface GitStatusView {
  repoUrl: string
  defaultBranch: string
  status: 'ok' | 'paused' | 'attention'
  statusDetail: string | null
  warnings: Array<{ at: string; kind: string; path: string; detail?: string }>
  lastExportAt: string | null
  lastIngestAt: string | null
}

export function describeGitStatus(s: GitStatusView | null): { label: string; tone: 'idle' | 'ok' | 'error' } {
  if (!s) return { label: 'Not connected', tone: 'idle' }
  if (s.status === 'attention') return { label: `Sync needs attention: ${s.statusDetail ?? ''}`.trim(), tone: 'error' }
  if (s.status === 'paused') return { label: 'Sync paused', tone: 'idle' }
  const when = s.lastExportAt ? new Date(s.lastExportAt).toLocaleTimeString() : 'never'
  return { label: `Synced — last export ${when}`, tone: 'ok' }
}

export const gitStatusAtom = atom<GitStatusView | null>(null)
export const githubLoginAtom = atom<string | null>(null)

export const loadGitStatusAtom = atom(null, async (get, set) => {
  const vaultId = get(activeVaultIdAtom)
  if (!vaultId) return
  const [status, conn] = await Promise.all([
    trpc.git.status.query({ vaultId }),
    trpc.github.connectionStatus.query(),
  ])
  set(gitStatusAtom, status as GitStatusView | null)
  set(githubLoginAtom, conn.connected ? conn.login : null)
})

export const connectGithubAtom = atom(null, async (get, set) => {
  const { url } = await trpc.github.startConnect.mutate()
  await window.holi.openExternal(url)
  // poll until the browser round-trip lands (the callback hits the server)
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 2000))
    const conn = await trpc.github.connectionStatus.query()
    if (conn.connected) {
      set(githubLoginAtom, conn.login)
      return
    }
  }
})

export const connectRepoAtom = atom(null, async (get, set, repoUrl: string) => {
  const vaultId = get(activeVaultIdAtom)
  if (!vaultId) return
  await trpc.git.connectRepo.mutate({ vaultId, repoUrl })
  await set(loadGitStatusAtom)
})

export const disconnectRepoAtom = atom(null, async (get, set) => {
  const vaultId = get(activeVaultIdAtom)
  if (!vaultId) return
  await trpc.git.disconnectRepo.mutate({ vaultId })
  set(gitStatusAtom, null)
})

export const syncNowAtom = atom(null, async (get, set) => {
  const vaultId = get(activeVaultIdAtom)
  if (!vaultId) return
  await trpc.git.syncNow.mutate({ vaultId })
  await set(loadGitStatusAtom)
})
```

(Adjust the `trpc` call style to the existing `lib/trpc.ts` client — check how e.g. `state/vaults.ts` invokes queries/mutations and mirror it exactly.)

```tsx
// apps/desktop/src/renderer/src/components/VaultSettings.tsx
import { useAtomValue, useSetAtom } from 'jotai'
import { useEffect, useState } from 'react'
import {
  connectGithubAtom,
  connectRepoAtom,
  describeGitStatus,
  disconnectRepoAtom,
  githubLoginAtom,
  gitStatusAtom,
  loadGitStatusAtom,
  syncNowAtom,
} from '../state/git'

const toneClass = { idle: 'text-neutral-400', ok: 'text-emerald-400', error: 'text-red-400' } as const

export function VaultSettings({ onClose }: { onClose: () => void }) {
  const status = useAtomValue(gitStatusAtom)
  const githubLogin = useAtomValue(githubLoginAtom)
  const load = useSetAtom(loadGitStatusAtom)
  const connectGithub = useSetAtom(connectGithubAtom)
  const connectRepo = useSetAtom(connectRepoAtom)
  const disconnect = useSetAtom(disconnectRepoAtom)
  const syncNow = useSetAtom(syncNowAtom)
  const [repoUrl, setRepoUrl] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const view = describeGitStatus(status)

  useEffect(() => {
    void load()
  }, [load])

  const guard = (fn: () => Promise<unknown>) => async () => {
    setBusy(true)
    setError(null)
    try {
      await fn()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex h-full flex-col gap-4 p-4 text-sm">
      <div className="flex items-center justify-between">
        <h2 className="text-base font-semibold">Vault settings — Git mirror</h2>
        <button className="rounded bg-neutral-800 px-2 py-1 hover:bg-neutral-700" onClick={onClose}>
          close
        </button>
      </div>

      <section className="space-y-1">
        <h3 className="font-medium">GitHub account</h3>
        {githubLogin ? (
          <p className="text-neutral-400">
            Linked as <span className="text-neutral-200">{githubLogin}</span>
          </p>
        ) : (
          <button
            disabled={busy}
            className="rounded bg-neutral-800 px-2 py-1 hover:bg-neutral-700 disabled:opacity-50"
            onClick={guard(() => connectGithub())}
          >
            Connect GitHub…
          </button>
        )}
      </section>

      <section className="space-y-2">
        <h3 className="font-medium">Repository</h3>
        <p className={toneClass[view.tone]}>{view.label}</p>
        {status ? (
          <div className="flex gap-2">
            <span className="text-neutral-400">{status.repoUrl}</span>
            <button disabled={busy} className="rounded bg-neutral-800 px-2 py-1 hover:bg-neutral-700" onClick={guard(() => syncNow())}>
              sync now
            </button>
            <button disabled={busy} className="rounded bg-red-900 px-2 py-1 hover:bg-red-800" onClick={guard(() => disconnect())}>
              disconnect
            </button>
          </div>
        ) : (
          <form
            className="flex gap-2"
            onSubmit={(e) => {
              e.preventDefault()
              void guard(() => connectRepo(repoUrl))()
            }}
          >
            <input
              className="w-80 rounded border border-neutral-800 bg-neutral-900 px-2 py-1"
              placeholder="https://github.com/org/repo"
              value={repoUrl}
              onChange={(e) => setRepoUrl(e.target.value)}
            />
            <button disabled={busy || !githubLogin} className="rounded bg-neutral-800 px-2 py-1 hover:bg-neutral-700 disabled:opacity-50">
              Connect repository
            </button>
          </form>
        )}
        {!githubLogin && !status && (
          <p className="text-xs text-neutral-500">
            Connecting a repo installs a deploy key + webhook on it (your GitHub account authorizes this once; day-to-day
            sync uses the deploy key). Docs, .claude/ and .holi/settings.json are mirrored; tasks are not.
          </p>
        )}
        {status && status.warnings.length > 0 && (
          <ul className="space-y-1 text-xs text-amber-400">
            {status.warnings.slice(0, 10).map((w, i) => (
              <li key={i}>
                {w.kind}: {w.path} {w.detail ?? ''}
              </li>
            ))}
          </ul>
        )}
        {error && <p className="text-xs text-red-400">{error}</p>}
      </section>
    </div>
  )
}
```

Wire into `Shell.tsx`: add a `⚙` button next to the vault `+` button and a `showSettings` `useState`; when true, render `<VaultSettings onClose={() => setShowSettings(false)} />` in place of `<EditorPane …>` (same slot). Owner-gating is server-side; the pane simply surfaces the server error if a non-owner tries.

- [ ] **Step 4: Run tests + typecheck**

Run: `pnpm --filter @holi/desktop test && pnpm --filter @holi/desktop typecheck`
Expected: PASS / clean

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src
git add apps/desktop/test/git-state.test.ts 2>/dev/null || git add apps/desktop
git commit -m "feat(desktop): vault settings pane — GitHub link + git mirror controls"
```

---

### Task 15: End-to-end verification + docs

**Files:**
- Modify: `docs/prd/vaults-collaboration.md` (record the two documented deviations from the header of this plan)
- Modify: this plan file (tick boxes, note deviations inline)

- [ ] **Step 1: Full suites + typecheck**

Run: `pnpm test && pnpm typecheck`
Expected: all packages green (shared 6 files, server ~24 files incl. the 10 new ones, desktop incl. the new state test)

- [ ] **Step 2: Live dev-loop smoke (no GitHub needed)**

```bash
pnpm db:up
pnpm --filter @holi/server dev   # background terminal
# in a scratch dir: create a bare repo standing in for GitHub
git init --bare --initial-branch=main /tmp/holi-e2e-remote.git
```

Then, with a dev token (`pnpm --filter @holi/server exec tsx scripts/seed-dev.ts`), insert a `vault_git` row for the seeded vault pointing `remote` at `/tmp/holi-e2e-remote.git` (psql on port **5433**, encrypt columns via a one-off `tsx -e` script using `seal()`), edit a doc through the desktop app, wait ~1 min, and verify:
- `git -C /tmp/holi-e2e-remote.git log main --oneline` shows a `holi sync:` commit;
- commit a foreign change to the bare repo from a scratch clone, run `git.syncNow` from the desktop settings pane (or wait for the backstop), and watch the edit appear **live** in the open editor (the CDP headless recipe in project memory works for this).

Expected: both directions round-trip; `vault_git.base_commit` advances.

- [ ] **Step 3: Record deviations + update PRD**

Add to `docs/prd/vaults-collaboration.md` §Git mirror & remote-edit ingress, matching what was built: (a) divergent ingests record a `diverged-ingest` warning in vault settings instead of the merge-safety-net flag (which doesn't exist yet — it takes over when that feature ships); (b) ingest-driven deletes take no pre-snapshot (snapshots cascade with the doc — same recovery gap as any doc delete today). Note anything else that deviated during execution at the bottom of this plan.

- [ ] **Step 4: Commit**

```bash
git add docs
git commit -m "docs: git mirror — record implementation deviations in PRD + plan"
```

---

## Self-review notes (already applied)

- **Spec coverage:** wiring flow (Task 11), exporter + export-set filtering (7), ingester + full edge policy (9), non-FF loop + force-push + serialization (10), webhook + signature + backstop (12–13), OAuth linking (6), non-empty-repo connect policy (10, test 2), status surface + disconnect (11, 14), testing strategy (local bare repos everywhere, fake GitHub API). Out-of-scope items from the spec (branches, task export, attribution) appear in no task — correct.
- **Known simplifications, on purpose:** no `bus` events for git status (the pane polls on open; SSE can come later with the tasks-board work); webhook handler loads all `vault_git` rows to match the repo (fine at company scale); scheduler polls rather than subscribing to doc-change events (one indexed query per git vault per 15 s).
- **Type consistency spot-checks:** `GitWarning.kind` union matches every `warning()` call site; `SyncDeps.mirrorDir` optional threaded through scheduler/wiring/tests; `makeAppRouter` options extended once in Task 6 and once in Task 11 — both shown; `applyTextDiff` returns `boolean` (diverged) and both callers use it.
