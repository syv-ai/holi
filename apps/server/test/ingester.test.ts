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

  it('unsafe paths are rejected by the path guard (unit)', async () => {
    const { safeIngestPath } = await import('../src/git/ingester')
    expect(safeIngestPath('../escape.md')).toBeNull()
    expect(safeIngestPath('ok/note.md')).toBe('ok/note.md')
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
