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
