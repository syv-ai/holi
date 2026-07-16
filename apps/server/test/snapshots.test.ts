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

  // D53. `list` deliberately never selects `state`, so nothing in the router could tell
  // you what is IN a version — and for interval snapshots, which carry a null label, the
  // only thing on screen is a timestamp. A timeline without this offers "restore 10:31"
  // vs "restore 09:58" and no way to tell them apart.
  describe('preview', () => {
    it('returns the text as of that snapshot, not the doc as it is now', async () => {
      const caller = snapshotsRouter.createCaller(ctxFor(t, userId))
      await editDocText(t.db, () => null, docId, (text) => replaceAllText(text, 'the old words'))
      const state = await loadDocState(t.db, docId)
      await takeSnapshot(t.db, { docId, state: state!, reason: 'manual', label: 'old', authorId: userId })
      await editDocText(t.db, () => null, docId, (text) => replaceAllText(text, 'the new words'))

      const snap = (await caller.list({ docId })).find((s) => s.label === 'old')!
      expect(await caller.preview({ docId, snapshotId: snap.id })).toEqual({ text: 'the old words' })
      // and the doc itself is untouched — preview is restore with the write removed
      expect(docText(docFromState(await loadDocState(t.db, docId)))).toBe('the new words')
    })

    // The only security-relevant line in the procedure: without it, the doc gate is
    // satisfied by a doc you CAN read while the bytes come from one you cannot.
    //
    // The positive control is load-bearing, not padding: tRPC's caller is a proxy that
    // rejects an UNKNOWN procedure with NOT_FOUND too, so the rejection alone passed
    // before `preview` existed at all. Proving the same call succeeds against the right
    // doc is what makes the rejection mean "wrong doc" rather than "no such procedure".
    it('rejects a snapshot id belonging to a different doc', async () => {
      const caller = snapshotsRouter.createCaller(ctxFor(t, userId))
      const snap = (await caller.list({ docId }))[0]!
      const otherDocId = (
        await notesRouter
          .createCaller(ctxFor(t, userId))
          .create({ vaultId, path: `other-${Date.now()}.md`, kind: 'note' })
      ).id

      await expect(caller.preview({ docId, snapshotId: snap.id })).resolves.toHaveProperty('text')
      await expect(caller.preview({ docId: otherDocId, snapshotId: snap.id })).rejects.toMatchObject({
        code: 'NOT_FOUND',
      })
    })

    it('is membership-gated', async () => {
      const snap = (await snapshotsRouter.createCaller(ctxFor(t, userId)).list({ docId }))[0]!
      const outsider = await seedUser(t.db)
      await expect(
        snapshotsRouter.createCaller(ctxFor(t, outsider.id)).preview({ docId, snapshotId: snap.id }),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' })
    })
  })
})
