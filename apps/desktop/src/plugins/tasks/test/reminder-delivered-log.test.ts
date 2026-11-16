import { parseSettingsText, seedSettingsText, SETTINGS_LOCAL_FILE } from '@holi/shared'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { writeVaultSettings } from '../../../main/vault/settings'
import { createDeliveredLog } from '../main/reminders/delivered-log'

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
    await writeFile(settingsPath(), seedSettingsText({ colorScheme: 'light' }, 'local', []), 'utf8')
    const log = createDeliveredLog(rootFor)
    log.markDelivered('o/r', 'task.a.md', '2026-07-28T09:00')
    const text = await readFile(settingsPath(), 'utf8')
    const onDisk = parseSettingsText(text)
    expect(onDisk.colorScheme).toBe('light')
    expect(onDisk.reminders).toEqual({ 'task.a.md': '2026-07-28T09:00' })
  })

  it('reads the watermark back from a YAML file', async () => {
    await mkdir(join(root, '.holi/settings'), { recursive: true })
    const seeded = seedSettingsText(
      { colorScheme: 'dark', reminders: { 'task.a.md': '2026-07-28T09:00' } },
      'local',
      [],
    )
    await writeFile(settingsPath(), seeded, 'utf8')
    expect(createDeliveredLog(rootFor).read('o/r')).toEqual({ 'task.a.md': '2026-07-28T09:00' })
  })

  it('keeps fallback occurrence receipts separate from explicit watermarks across settings writes', async () => {
    const log = createDeliveredLog(rootFor)
    log.markDelivered('o/r', 'task.a.md', '2026-07-28T09:00')
    log.markFallback('o/r', 'task.a.md', '2026-07-28')
    expect(await readFile(settingsPath(), 'utf8')).toContain('overdueTaskReceipts')
    expect(parseSettingsText(await readFile(settingsPath(), 'utf8')).overdueTaskReceipts).toEqual({
      'receipt-%5B%22o%2Fr%22%2C%22task.a.md%22%2C%222026-07-28%22%5D': true,
    })
    expect(log.fallbackReceipts().has('o/r', 'task.a.md', '2026-07-28')).toBe(true)
    expect(log.fallbackReceipts().has('o/r', 'task.a.md', '2026-07-29')).toBe(false)
    await writeVaultSettings(root, { local: { colorScheme: 'dark' } })
    const recreated = createDeliveredLog(rootFor)
    expect(recreated.read('o/r')).toEqual({ 'task.a.md': '2026-07-28T09:00' })
    expect(recreated.fallbackReceipts().has('o/r', 'task.a.md', '2026-07-28')).toBe(true)
    const onDisk = parseSettingsText(await readFile(settingsPath(), 'utf8'))
    expect(onDisk.reminders).toEqual({ 'task.a.md': '2026-07-28T09:00' })
    expect(onDisk.overdueTaskReceipts).toEqual({
      'receipt-%5B%22o%2Fr%22%2C%22task.a.md%22%2C%222026-07-28%22%5D': true,
    })
  })

  it('retains earlier, later and minute-normalized occurrences after a restart', () => {
    const log = createDeliveredLog(rootFor)
    for (const due of ['2026-07-28', '2026-07-27', '2026-07-29', '2026-07-29T09:00']) {
      log.markFallback('o/r', 'task.a.md', due)
    }
    const restarted = createDeliveredLog(rootFor)
    for (const due of ['2026-07-28', '2026-07-27', '2026-07-29', '2026-07-29T09:00']) {
      expect(restarted.fallbackReceipts().has('o/r', 'task.a.md', due)).toBe(true)
    }
    expect(restarted.fallbackReceipts().has('o/r', 'task.other.md', '2026-07-28')).toBe(false)
    expect(restarted.fallbackReceipts().has('other/vault', 'task.a.md', '2026-07-28')).toBe(false)
    expect(restarted.read('o/r')).toEqual({})
  })

  it('reads {} when rootFor cannot resolve the remote', () => {
    const log = createDeliveredLog(rootFor)
    expect(log.read('unknown/vault')).toEqual({})
    expect(log.fallbackReceipts().has('unknown/vault', 'task.a.md', '2026-07-28')).toBe(false)
  })
})
