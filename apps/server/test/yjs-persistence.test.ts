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
