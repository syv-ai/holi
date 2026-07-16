import { and, eq } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createBus } from '../src/bus'
import { docs } from '../src/db/schema'
import { notesRouter } from '../src/routers/notes'
import { createTestDb, type TestDb } from '../src/test/db'
import { seedUser, seedVault } from '../src/test/fixtures'
import type { Context } from '../src/trpc'
import { docFromState, docText, loadDocState } from '../src/yjs/doc-store'
import { editDocText, replaceAllText } from '../src/yjs/edit'
import { refreshLinkIndex } from '../src/yjs/link-index'

const TODAY = '2026-07-15'
const YESTERDAY = '2026-07-14'
const YESTERDAY_FILE = '14-07-2026.md'

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

const readText = async (t: TestDb, docId: string) =>
  docText(docFromState(await loadDocState(t.db, docId)))

const pathOf = async (t: TestDb, docId: string) => {
  const [row] = await t.db.select({ path: docs.path }).from(docs).where(eq(docs.id, docId))
  return row?.path
}

describe('daily notes', () => {
  let t: TestDb
  let userId: string
  let vaultId: string
  let caller: ReturnType<typeof notesRouter.createCaller>

  beforeAll(async () => {
    t = await createTestDb()
  })
  // A fresh user per test: `vaults_personal_owner_idx` allows exactly one personal
  // vault per owner, so tests cannot share one.
  beforeEach(async () => {
    userId = (await seedUser(t.db)).id
    vaultId = (await seedVault(t.db, userId, 'personal')).id
    caller = notesRouter.createCaller(ctxFor(t, userId))
  })
  afterAll(() => t.destroy())

  describe('getOrCreateDaily', () => {
    it('creates a seeded daily note at the DD-MM-YYYY.md root path', async () => {
      const { doc, created } = await caller.getOrCreateDaily({ vaultId, localDate: TODAY })

      expect(created).toBe(true)
      expect(doc.path).toBe('15-07-2026.md')
      expect(await readText(t, doc.id)).toBe(
        `---\ntype: daily-note\ndate: ${TODAY}\n---\n\n# 15-07-2026\n\n`,
      )
      const [row] = await t.db.select().from(docs).where(eq(docs.id, doc.id))
      expect(row!.kind).toBe('daily')
    })

    // The whole point: the unique (vault_id, path) index arbitrates, so a second
    // device gets the winner's row rather than minting a duplicate.
    it('is idempotent — a second call returns the same doc, created: false', async () => {
      const first = await caller.getOrCreateDaily({ vaultId, localDate: TODAY })
      const second = await caller.getOrCreateDaily({ vaultId, localDate: TODAY })

      expect(second.doc.id).toBe(first.doc.id)
      expect(second.created).toBe(false)
      const rows = await t.db
        .select()
        .from(docs)
        .where(and(eq(docs.vaultId, vaultId), eq(docs.path, '15-07-2026.md')))
      expect(rows).toHaveLength(1)
    })

    it('survives concurrent calls racing for the same date', async () => {
      const results = await Promise.all(
        Array.from({ length: 5 }, () => caller.getOrCreateDaily({ vaultId, localDate: TODAY })),
      )
      expect(new Set(results.map((r) => r.doc.id)).size).toBe(1)
      expect(results.filter((r) => r.created)).toHaveLength(1)
    })

    // Re-seeding an adopted doc would duplicate the title into what you wrote.
    it('never re-seeds a note you have already written in', async () => {
      const first = await caller.getOrCreateDaily({ vaultId, localDate: TODAY })
      await setDocText(t, vaultId, first.doc.id, 'my own words')

      await caller.getOrCreateDaily({ vaultId, localDate: TODAY })

      expect(await readText(t, first.doc.id)).toBe('my own words')
    })

    it('adopts a doc already sitting at that path rather than failing', async () => {
      const planted = await caller.create({ vaultId, path: '15-07-2026.md', kind: 'note' })

      const res = await caller.getOrCreateDaily({ vaultId, localDate: TODAY })

      expect(res.doc.id).toBe(planted.id)
      expect(res.created).toBe(false)
    })

    it('rejects a shared vault — daily notes are personal-vault only', async () => {
      const other = await seedUser(t.db)
      const shared = await seedVault(t.db, other.id, 'shared')
      const sharedCaller = notesRouter.createCaller(ctxFor(t, other.id))

      await expect(
        sharedCaller.getOrCreateDaily({ vaultId: shared.id, localDate: TODAY }),
      ).rejects.toThrow(/personal/i)
    })

    it('rejects a date that is not a real ISO date', async () => {
      await expect(caller.getOrCreateDaily({ vaultId, localDate: '15-07-2026' })).rejects.toThrow()
      await expect(caller.getOrCreateDaily({ vaultId, localDate: '2026-02-30' })).rejects.toThrow()
    })
  })

  describe('sweepDaily', () => {
    it("leaves today's note alone", async () => {
      const today = await caller.getOrCreateDaily({ vaultId, localDate: TODAY })

      const res = await caller.sweepDaily({ vaultId, localDate: TODAY })

      expect(res).toEqual({ archived: 0, deleted: 0 })
      expect(await pathOf(t, today.doc.id)).toBe('15-07-2026.md')
    })

    it("archives a written prior-day note into journal/ and rewrites links to it", async () => {
      const daily = await caller.getOrCreateDaily({ vaultId, localDate: YESTERDAY })
      await setDocText(t, vaultId, daily.doc.id, 'bought milk')
      const src = await caller.create({ vaultId, path: 'src.md', kind: 'note' })
      await setDocText(t, vaultId, src.id, `see [[${YESTERDAY_FILE}]] and [[${YESTERDAY_FILE}|Yday]]`)

      const res = await caller.sweepDaily({ vaultId, localDate: TODAY })

      expect(res).toEqual({ archived: 1, deleted: 0 })
      // Same doc id — an archive is a move, not a copy.
      expect(await pathOf(t, daily.doc.id)).toBe(`journal/${YESTERDAY_FILE}`)
      expect(await readText(t, src.id)).toBe(
        `see [[journal/${YESTERDAY_FILE}]] and [[journal/${YESTERDAY_FILE}|Yday]]`,
      )
    })

    it('deletes an untouched, unreferenced stub', async () => {
      const stub = await caller.getOrCreateDaily({ vaultId, localDate: YESTERDAY })

      const res = await caller.sweepDaily({ vaultId, localDate: TODAY })

      expect(res).toEqual({ archived: 0, deleted: 1 })
      expect(await pathOf(t, stub.doc.id)).toBeUndefined()
    })

    // No orphan-rescue exists in this repo, so GC must never create a dangling link.
    it('keeps (archives) an untouched stub that something links to', async () => {
      const stub = await caller.getOrCreateDaily({ vaultId, localDate: YESTERDAY })
      const src = await caller.create({ vaultId, path: 'src.md', kind: 'note' })
      await setDocText(t, vaultId, src.id, `see [[${YESTERDAY_FILE}]]`)

      const res = await caller.sweepDaily({ vaultId, localDate: TODAY })

      expect(res).toEqual({ archived: 1, deleted: 0 })
      expect(await pathOf(t, stub.doc.id)).toBe(`journal/${YESTERDAY_FILE}`)
      expect(await readText(t, src.id)).toBe(`see [[journal/${YESTERDAY_FILE}]]`)
    })

    // Runs on every activation — the second run must find nothing to do.
    it('is idempotent — a re-run is a no-op', async () => {
      const daily = await caller.getOrCreateDaily({ vaultId, localDate: YESTERDAY })
      await setDocText(t, vaultId, daily.doc.id, 'bought milk')

      expect(await caller.sweepDaily({ vaultId, localDate: TODAY })).toEqual({
        archived: 1,
        deleted: 0,
      })
      expect(await caller.sweepDaily({ vaultId, localDate: TODAY })).toEqual({
        archived: 0,
        deleted: 0,
      })
      expect(await pathOf(t, daily.doc.id)).toBe(`journal/${YESTERDAY_FILE}`)
    })

    // D46: only system-minted notes are swept. A hand-authored note that merely
    // looks like a date must never be archived — let alone deleted as a "stub".
    it('ignores a hand-authored note that merely looks like a date', async () => {
      const planted = await caller.create({ vaultId, path: YESTERDAY_FILE, kind: 'note' })

      const res = await caller.sweepDaily({ vaultId, localDate: TODAY })

      expect(res).toEqual({ archived: 0, deleted: 0 })
      expect(await pathOf(t, planted.id)).toBe(YESTERDAY_FILE)
    })

    it('rejects a shared vault', async () => {
      const other = await seedUser(t.db)
      const shared = await seedVault(t.db, other.id, 'shared')
      const sharedCaller = notesRouter.createCaller(ctxFor(t, other.id))

      await expect(sharedCaller.sweepDaily({ vaultId: shared.id, localDate: TODAY })).rejects.toThrow(
        /personal/i,
      )
    })
  })
})
