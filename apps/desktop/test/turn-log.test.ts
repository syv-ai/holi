/**
 * The turn log (D88) — two shas per turn, and nothing else.
 *
 * The constraint that shapes every case: a broken log must never break a turn.
 * The bracket this hangs off also resumes sync, so losing a record is a smaller
 * failure than a vault left paused, and every read failure answers `[]`.
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openTurnLog, TURNS_FILE } from '../src/main/agent/turn-log'

let root: string
const dirs: string[] = []

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'holi-turnlog-'))
  dirs.push(root)
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

  it('drops one hand-edited record rather than the whole day', async () => {
    await mkdir(join(root, '.holi/state'), { recursive: true })
    await writeFile(file(), JSON.stringify([record(1), { base: 'x' }, record(2)]), 'utf8')
    expect(await openTurnLog(root).list()).toEqual([record(1), record(2)])
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

  it('puts the newest first', async () => {
    const log = openTurnLog(root)
    await log.append(record(1))
    await log.append(record(2))
    expect(await log.list()).toEqual([record(2), record(1)])
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

  it('drops a turn that changed nothing, so no caller has to ask', async () => {
    const log = openTurnLog(root)
    await log.append({ base: 'same', end: 'same', at: '2026-09-09T00:00:00Z' })
    expect(await log.list()).toEqual([])
  })

  it('never syncs, because the name says so', () => {
    // `.local.` is the whole mechanism (D65): the seeded ignore covers it, and a
    // teammate pulling your turn boundaries would be reading your session.
    expect(file().endsWith('.local.json')).toBe(true)
  })
})
