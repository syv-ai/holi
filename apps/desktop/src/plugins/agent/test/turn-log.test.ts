/**
 * The turn log — two shas per turn, and nothing else.
 *
 * The constraint that shapes every case: a broken log must never break a turn.
 * The bracket this hangs off also resumes sync, so losing a record is a smaller
 * failure than a vault left paused, and every read failure answers `[]`.
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { openTurnLog, TURNS_FILE } from '../main/host/turn-log'

const renameFailure = vi.hoisted(() => ({
  destination: null as string | null,
  entered: null as (() => void) | null,
  wait: null as Promise<void> | null,
}))

vi.mock('node:fs/promises', async (original) => {
  const fs = await original<typeof import('node:fs/promises')>()
  return {
    ...fs,
    rename: async (...args: Parameters<typeof fs.rename>) => {
      if (args[1] === renameFailure.destination) {
        renameFailure.entered?.()
        await renameFailure.wait
        renameFailure.destination = null
        throw Object.assign(new Error('synthetic rename failure'), { code: 'EIO' })
      }
      return fs.rename(...args)
    },
  }
})

let root: string
const dirs: string[] = []

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'holi-turnlog-'))
  dirs.push(root)
  renameFailure.destination = null
  renameFailure.entered = null
  renameFailure.wait = null
})

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })))
})

const record = (n: number) => ({ base: `base${n}`, end: `end${n}`, at: `2026-09-09T0${n}:00:00Z` })
const file = () => join(root, TURNS_FILE)

describe('reading', () => {
  it('is empty for a vault that has never run a turn', async () => {
    expect(await openTurnLog(root).list()).toEqual([])
  })

  it('is empty rather than throwing on a file that is not JSON', async () => {
    await mkdir(join(root, '.holi/state'), { recursive: true })
    await writeFile(file(), 'not json', 'utf8')
    expect(await openTurnLog(root).list()).toEqual([])
  })

  it('is empty rather than throwing on JSON that is not a list', async () => {
    await mkdir(join(root, '.holi/state'), { recursive: true })
    await writeFile(file(), '{"turns":[]}', 'utf8')
    expect(await openTurnLog(root).list()).toEqual([])
  })

  it('reads a record written before a vault could run two sessions', async () => {
    // `sessionId` and `overlapped` arrived with several sessions per vault. Every record already on
    // disk has neither, and must keep reading as one session and no overlap —
    // which is exactly what those turns were.
    await mkdir(join(root, '.holi/state'), { recursive: true })
    await writeFile(file(), JSON.stringify([record(1)]), 'utf8')
    const [read] = await openTurnLog(root).list()
    expect(read).toEqual(record(1))
    expect(read?.sessionId).toBeUndefined()
    expect(read?.overlapped).toBeUndefined()
  })

  it('keeps the session and the overlap flag it was given', async () => {
    await mkdir(join(root, '.holi/state'), { recursive: true })
    const full = { ...record(1), sessionId: 'sess-a', overlapped: true }
    await writeFile(file(), JSON.stringify([full]), 'utf8')
    expect(await openTurnLog(root).list()).toEqual([full])
  })

  it('filters only missing required fields and preserves historical optional values', async () => {
    await mkdir(join(root, '.holi/state'), { recursive: true })
    const legacyExtras = { ...record(2), sessionId: 42, overlapped: 'yes', custom: { note: true } }
    await writeFile(
      file(),
      JSON.stringify([
        record(1),
        { base: 'x' },
        legacyExtras,
        { ...record(4), sessionId: 'session', overlapped: true },
      ]),
      'utf8',
    )
    const log = openTurnLog(root)
    expect(await log.list()).toEqual([
      record(1),
      legacyExtras,
      { ...record(4), sessionId: 'session', overlapped: true },
    ])
    await log.append(record(5))
    expect(await openTurnLog(root).list()).toEqual([
      record(5),
      record(1),
      legacyExtras,
      { ...record(4), sessionId: 'session', overlapped: true },
    ])
  })
})

describe('appending', () => {
  it('stores a record and reads it back', async () => {
    const log = openTurnLog(root)
    await log.append(record(1))
    expect(await log.list()).toEqual([record(1)])
  })

  it('creates .holi/ in a freshly cloned vault', async () => {
    // A clone may have no `.holi/` at all until something writes one.
    const log = openTurnLog(root)
    await log.append(record(1))
    expect(JSON.parse(await readFile(file(), 'utf8'))).toHaveLength(1)
  })

  it('serializes concurrent appends across handles and equivalent path spellings', async () => {
    const left = openTurnLog(root)
    const right = openTurnLog(join(root, '.'))
    await Promise.all(
      Array.from({ length: 20 }, (_, n) => (n % 2 ? left : right).append(record(n))),
    )
    const list = await left.list()
    expect(list).toHaveLength(20)
    expect(new Set(list.map((item) => item.base)).size).toBe(20)
  })

  it('keeps independent vaults with the same session id isolated', async () => {
    const otherRoot = await mkdtemp(join(tmpdir(), 'holi-turnlog-other-'))
    dirs.push(otherRoot)
    const first = openTurnLog(root)
    const second = openTurnLog(otherRoot)
    await Promise.all([
      first.append({ ...record(1), sessionId: 'same' }),
      second.append({ ...record(2), sessionId: 'same' }),
    ])
    expect(await first.list()).toEqual([{ ...record(1), sessionId: 'same' }])
    expect(await second.list()).toEqual([{ ...record(2), sessionId: 'same' }])
  })

  it('puts the newest first', async () => {
    const log = openTurnLog(root)
    await log.append(record(1))
    await log.append(record(2))
    expect(await log.list()).toEqual([record(2), record(1)])
  })

  it('recovers the queued append after a rename failure without replacing the original', async () => {
    const log = openTurnLog(root)
    await mkdir(join(root, '.holi/state'), { recursive: true })
    await writeFile(file(), JSON.stringify([record(0)]), 'utf8')
    let entered!: () => void
    const renameEntered = new Promise<void>((resolve) => (entered = resolve))
    let release!: () => void
    const releaseRename = new Promise<void>((resolve) => (release = resolve))
    renameFailure.destination = file()
    renameFailure.entered = entered
    renameFailure.wait = releaseRename
    const failed = log.append(record(1))
    await renameEntered
    const queued = log.append(record(2))
    release()
    await expect(failed).rejects.toThrow('synthetic rename failure')
    await queued
    expect(await openTurnLog(root).list()).toEqual([record(2), record(0)])
    expect(JSON.parse(await readFile(file(), 'utf8'))).toEqual([record(2), record(0)])
  })

  it('caps at fifty', async () => {
    const log = openTurnLog(root)
    for (let n = 0; n < 51; n++) await log.append({ ...record(1), base: `b${n}`, end: `e${n}` })
    const list = await log.list()
    expect(list).toHaveLength(50)
    // The oldest is the one that fell off.
    expect(list.map((r) => r.base)).not.toContain('b0')
    expect(list[0]!.base).toBe('b50')
  })

  it('keeps a turn that changed nothing, since it still ends the session turn', async () => {
    const log = openTurnLog(root)
    const same = { base: 'same', end: 'same', at: '2026-09-09T00:00:00Z' }
    await log.append(same)
    expect(await log.list()).toEqual([same])
  })

  it('keeps one changed-nothing turn per session under concurrent appends', async () => {
    const log = openTurnLog(root)
    const idle = (sessionId: string, n: number) => ({
      base: 'same',
      end: 'same',
      at: `2026-09-09T0${n}:00:00Z`,
      sessionId,
    })
    await log.append({ ...record(1), sessionId: 'a' })
    await Promise.all(Array.from({ length: 8 }, (_, n) => log.append(idle('a', n + 2))))
    await log.append(idle('b', 3))
    const persisted = await openTurnLog(root).list()
    expect(persisted).toEqual([idle('b', 3), idle('a', 9), { ...record(1), sessionId: 'a' }])
  })

  it('never syncs, because the name says so', () => {
    // `.local.` is the whole mechanism: the seeded ignore covers it, and a
    // teammate pulling your turn boundaries would be reading your session.
    expect(file().endsWith('.local.json')).toBe(true)
  })
})
