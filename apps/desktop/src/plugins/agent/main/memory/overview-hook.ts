import { readFileSync } from 'node:fs'
import { lstat, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { exactPath, exactPathSync } from '@holi/shared/path-safety-node'
import { hookCommand, hookScript } from '../claude/settings'
import { jsonFileStore } from '../../../../main/plugin-api'

type Json = Record<string, unknown>

const isObject = (value: unknown): value is Json =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

/** Keep the memory overview command in an adopted vault's SessionStart hooks. */
export async function reconcileMemoryOverviewHook(
  root: string,
  enabled: boolean,
  active: () => boolean = () => true,
): Promise<void> {
  if (!active()) return
  const settingsRel = '.claude/settings.json'
  const scriptRel = hookScript('memory-overview')
  const exists = await lstat(join(root, settingsRel)).then(
    () => true,
    () => false,
  )
  if (!exists) return
  const path = await exactPath(root, settingsRel)
  if (path === null) throw new Error('Claude settings path is not owned by vault')
  const ownedPath = exactPathSync(root, settingsRel)
  if (ownedPath === null || ownedPath !== path)
    throw new Error('Claude settings path is not owned by vault')

  const script = await exactPath(root, scriptRel)
  const hasScript = script !== null && (await stat(script)).isFile()
  let expectedText: string | null = null
  const store = jsonFileStore<Json | null>(path, (_raw, text) => {
    expectedText = text
    if (text === null) return null
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      throw new Error(`Malformed Claude settings: ${settingsRel}`)
    }
    if (!isObject(parsed)) throw new Error(`Malformed Claude settings: ${settingsRel}`)
    return parsed
  })
  const owned = () => active() && exactPathSync(root, settingsRel) === path
  const unchanged = (): boolean => {
    if (!owned()) return false
    try {
      return readFileSync(path, 'utf8') === expectedText
    } catch {
      return false
    }
  }
  const current = await store.read()
  if (current === null) return
  const groups =
    isObject(current.hooks) && Array.isArray(current.hooks.SessionStart)
      ? current.hooks.SessionStart
      : []
  const command = hookCommand('memory-overview')
  const present = groups.some(
    (group) =>
      isObject(group) &&
      Array.isArray(group.hooks) &&
      group.hooks.some((entry: unknown) => isObject(entry) && entry.command === command),
  )
  if ((enabled && (!hasScript || present)) || (!enabled && !present)) return
  await store.update(
    (current) => {
      if (current === null) return null
      const settings = structuredClone(current)
      const hooksRoot = isObject(settings.hooks) ? settings.hooks : null
      const groups =
        hooksRoot && Array.isArray(hooksRoot.SessionStart) ? hooksRoot.SessionStart : []
      const command = hookCommand('memory-overview')
      let found = false
      const nextGroups = groups.flatMap((group) => {
        if (!isObject(group) || !Array.isArray(group.hooks)) return [group]
        const entries = group.hooks as unknown[]
        const retained = entries.filter((entry) => !(isObject(entry) && entry.command === command))
        if (
          enabled &&
          hasScript &&
          entries.some((entry) => isObject(entry) && entry.command === command)
        ) {
          found = true
          return [group]
        }
        if (retained.length === entries.length) return [group]
        if (retained.length === 0) return []
        return [{ ...group, hooks: retained }]
      })
      if (enabled && hasScript && !found) nextGroups.push({ hooks: [{ type: 'command', command }] })
      if (hooksRoot) hooksRoot.SessionStart = nextGroups
      else if (enabled && hasScript)
        settings.hooks = { SessionStart: [{ hooks: [{ type: 'command', command }] }] }
      return settings
    },
    owned,
    unchanged,
  )
}
