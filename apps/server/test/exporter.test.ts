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
