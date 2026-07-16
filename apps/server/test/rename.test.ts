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

  /**
   * `renameNote` has rejected a taken path since it was written; `renameFolder` checked
   * NOTHING. It was unreachable — nothing called it outside these tests — and becomes
   * data loss the moment there is a button.
   *
   * There is no transaction to lean on, and there cannot be one: `rewriteReferences`
   * edits CRDT docs through the live relay, which no database transaction can roll back.
   * So the only defence is to reject before touching anything.
   */
  describe('renameFolder rejects a collision before it moves anything', () => {
    const folderIdFor = async (path: string) =>
      (await t.db.select().from(folders).where(eq(folders.path, path)))[0]!.id

    it('rejects renaming onto an existing folder rather than silently merging', async () => {
      const caller = notesRouter.createCaller(ctxFor(t, userId))
      await caller.create({ vaultId, path: 'a/one.md', kind: 'note' })
      await caller.create({ vaultId, path: 'b/two.md', kind: 'note' })

      await expect(
        caller.renameFolder({ vaultId, folderId: await folderIdFor('a'), newPath: 'b' }),
      ).rejects.toMatchObject({ code: 'CONFLICT' })
    })

    // The partial-move case: the collision used to be found MID-LOOP, by the docs unique
    // constraint, after earlier docs had already been moved and their links rewritten.
    it('leaves every doc where it was when it rejects', async () => {
      const caller = notesRouter.createCaller(ctxFor(t, userId))
      const first = await caller.create({ vaultId, path: 'src/aaa.md', kind: 'note' })
      const clash = await caller.create({ vaultId, path: 'src/zzz.md', kind: 'note' })
      // dst/zzz.md already exists, so moving src → dst collides on the SECOND doc
      await caller.create({ vaultId, path: 'dst/zzz.md', kind: 'note' })

      await expect(
        caller.renameFolder({ vaultId, folderId: await folderIdFor('src'), newPath: 'dst' }),
      ).rejects.toMatchObject({ code: 'CONFLICT' })

      // aaa.md sorts first and would have been moved already under the old code
      expect((await t.db.select().from(docs).where(eq(docs.id, first.id)))[0]?.path).toBe('src/aaa.md')
      expect((await t.db.select().from(docs).where(eq(docs.id, clash.id)))[0]?.path).toBe('src/zzz.md')
      expect((await t.db.select().from(folders).where(eq(folders.path, 'src')))[0]).toBeDefined()
    })

    // Positive control: without it, a check that rejects EVERYTHING passes the two above.
    it('still renames a folder when the destination is free', async () => {
      const caller = notesRouter.createCaller(ctxFor(t, userId))
      const doc = await caller.create({ vaultId, path: 'from/note.md', kind: 'note' })
      await caller.renameFolder({ vaultId, folderId: await folderIdFor('from'), newPath: 'to' })
      expect((await t.db.select().from(docs).where(eq(docs.id, doc.id)))[0]?.path).toBe('to/note.md')
    })

    /**
     * The doc-destination half of the guard, reached on purpose.
     *
     * Every path this codebase can currently reach has a folder row — all three `docs`
     * writers call `ensureAncestorFolders`, and the daily-note archive moves through
     * `renameNote`, which does too — so the folder-row check catches every collision
     * that can happen today, and this half is the belt to its braces. Mutation-testing
     * found that out: deleting the doc check failed nothing, because the earlier tests
     * were all being caught by the folder row.
     *
     * So the state is built by hand: a doc under `y/` whose folder row is gone. That
     * makes the folder check miss, and without the doc check the `docs` unique
     * constraint fires **mid-loop** — a half-moved folder. It is what stops a fourth
     * `docs` writer that forgets `ensureAncestorFolders` from resurrecting the bug.
     */
    it('rejects on a taken doc destination even when the folder row is missing', async () => {
      const caller = notesRouter.createCaller(ctxFor(t, userId))
      await caller.create({ vaultId, path: 'x/dup.md', kind: 'note' })
      await caller.create({ vaultId, path: 'y/dup.md', kind: 'note' })
      // the degenerate state: the docs exist, the folder row does not
      await t.db.delete(folders).where(eq(folders.path, 'y'))

      await expect(
        caller.renameFolder({ vaultId, folderId: await folderIdFor('x'), newPath: 'y' }),
      ).rejects.toMatchObject({ code: 'CONFLICT' })
      expect((await t.db.select().from(docs).where(eq(docs.path, 'x/dup.md')))[0]).toBeDefined()
    })
  })
})
