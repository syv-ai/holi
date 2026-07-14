import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { and, eq } from 'drizzle-orm'
import * as Y from 'yjs'
import { YDOC_TEXT_KEY } from '@holi/shared'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createBus } from '../src/bus'
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
  return { db: t.db, bus: createBus(), getLiveDoc: () => null, mirrorDir }
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
