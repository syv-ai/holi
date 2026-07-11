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
