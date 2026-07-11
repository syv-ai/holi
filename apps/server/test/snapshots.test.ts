import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
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
