import { SETTINGS_LOCAL_FILE, parseSettingsText, seedSettingsText } from '@holi/shared'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createDeliveredLog } from '../src/main/reminders/delivered-log'

let root: string
const rootFor = (remote: string) => (remote === 'o/r' ? root : null)
const settingsPath = () => join(root, SETTINGS_LOCAL_FILE)

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'holi-delivered-'))
})
afterEach(() => {
  // temp dirs are left for the OS to reap; keeps the test simple and hermetic.
})

describe('createDeliveredLog', () => {
  it('reads {} from a fresh root', () => {
    const log = createDeliveredLog(rootFor)
    expect(log.read('o/r')).toEqual({})
  })

  it('round-trips a delivery: markDelivered then read', () => {
    const log = createDeliveredLog(rootFor)
    log.markDelivered('o/r', 'task.a.md', '2026-07-28T09:00')
    expect(log.read('o/r')).toEqual({ 'task.a.md': '2026-07-28T09:00' })
  })

  it('accumulates several paths under a top-level reminders key', async () => {
    const log = createDeliveredLog(rootFor)
    log.markDelivered('o/r', 'task.a.md', '2026-07-28T09:00')
    log.markDelivered('o/r', 'task.b.md', '2026-07-28T10:00')
    expect(log.read('o/r')).toEqual({
      'task.a.md': '2026-07-28T09:00',
      'task.b.md': '2026-07-28T10:00',
    })
    const onDisk = parseSettingsText(await readFile(settingsPath(), 'utf8'))
    expect(onDisk.reminders).toEqual({
      'task.a.md': '2026-07-28T09:00',
      'task.b.md': '2026-07-28T10:00',
    })
  })

  // The file is the vault's YAML local settings, seeded with this machine's
  // answers. Reading it as anything else loses them on the first fire.
  it('keeps the settings in the seeded YAML file when writing', async () => {
    await mkdir(join(root, '.holi/settings'), { recursive: true })
    await writeFile(settingsPath(), seedSettingsText({ colorScheme: 'light' }, 'local'), 'utf8')
    const log = createDeliveredLog(rootFor)
    log.markDelivered('o/r', 'task.a.md', '2026-07-28T09:00')
    const text = await readFile(settingsPath(), 'utf8')
    expect(text).toContain('# Every setting this vault has.')
    const onDisk = parseSettingsText(text)
    expect(onDisk.colorScheme).toBe('light')
    expect(onDisk.reminders).toEqual({ 'task.a.md': '2026-07-28T09:00' })
  })

  it('reads the watermark back from a YAML file', async () => {
    await mkdir(join(root, '.holi/settings'), { recursive: true })
    const seeded = seedSettingsText(
      { colorScheme: 'dark', reminders: { 'task.a.md': '2026-07-28T09:00' } },
      'local',
    )
    await writeFile(settingsPath(), seeded, 'utf8')
    expect(createDeliveredLog(rootFor).read('o/r')).toEqual({ 'task.a.md': '2026-07-28T09:00' })
  })

  it('reads {} when rootFor cannot resolve the remote', () => {
    const log = createDeliveredLog(rootFor)
    expect(log.read('unknown/vault')).toEqual({})
  })
})
