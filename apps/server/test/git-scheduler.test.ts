import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { encryptionKey, seal } from '../src/crypto'
import { docs, vaultGit } from '../src/db/schema'
import { shouldSync } from '../src/git/scheduler'
import { createTestDb, type TestDb } from '../src/test/db'
import { seedUser, seedVault } from '../src/test/fixtures'

let t: TestDb
beforeAll(async () => {
  t = await createTestDb()
})
afterAll(() => t.destroy())

const T0 = new Date('2026-07-13T12:00:00Z').getTime()
const tunables = { quietMs: 45_000, maxQuietMs: 300_000, fetchBackstopMs: 3_600_000 }

function row(overrides: Partial<{ lastExportAt: Date | null; lastFetchAt: Date | null }>) {
  return { lastExportAt: null, lastFetchAt: new Date(T0), ...overrides }
}

describe('shouldSync', () => {
  it('dirty + quiet → sync', () => {
    expect(
      shouldSync(row({ lastExportAt: new Date(T0 - 600_000) }), new Date(T0 - 60_000), new Date(T0), tunables),
    ).toBe(true)
  })

  it('dirty but still being edited → wait', () => {
    expect(
      shouldSync(row({ lastExportAt: new Date(T0 - 60_000) }), new Date(T0 - 5_000), new Date(T0), tunables),
    ).toBe(false)
  })

  it('dirty, never quiet, but overdue (maxQuietMs since last export) → sync anyway', () => {
    expect(
      shouldSync(row({ lastExportAt: new Date(T0 - 400_000) }), new Date(T0 - 5_000), new Date(T0), tunables),
    ).toBe(true)
  })

  it('clean but fetch backstop due → sync (fetch-only)', () => {
    expect(shouldSync(row({ lastFetchAt: new Date(T0 - 4_000_000) }), null, new Date(T0), tunables)).toBe(true)
  })

  it('clean, recently fetched → idle', () => {
    expect(shouldSync(row({}), null, new Date(T0), tunables)).toBe(false)
  })
})

describe('tick wiring', () => {
  it('invokes syncVault for exactly the vaults that need it', async () => {
    const user = await seedUser(t.db)
    const vault = await seedVault(t.db, user.id)
    const key = encryptionKey()
    await t.db.insert(vaultGit).values({
      vaultId: vault.id,
      repoUrl: 'https://github.com/o/r',
      remote: '/unused',
      defaultBranch: 'main',
      deployKeyCiphertext: seal('k', key),
      deployKeyPublic: 'p',
      webhookSecretCiphertext: seal('s', key),
      enabledBy: user.id,
      lastFetchAt: new Date(), // fresh — no backstop
    })
    // one dirty doc, old enough to be quiet
    await t.db.insert(docs).values({
      vaultId: vault.id,
      path: 'a.md',
      kind: 'note',
      updatedAt: new Date(Date.now() - 120_000),
    })

    const { createGitScheduler } = await import('../src/git/scheduler')
    const synced: string[] = []
    const sched = createGitScheduler({
      db: t.db,
      getLiveDoc: () => null,
      syncImpl: async (_deps, vaultId) => void synced.push(vaultId),
    })
    await sched.tick()
    expect(synced).toEqual([vault.id])
  })
})
