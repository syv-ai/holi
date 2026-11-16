import { parseSettingsText, SETTINGS_LOCAL_FILE, writeSettingsText } from '@holi/shared'
import { installedInfos } from '../../../../main/plugin-api'
/**
 * The delivery watermark, named. Two verbs over the per-task last-fired map:
 * `read` is what `sweep` indexes (one file read per vault per tick), `markDelivered`
 * advances it. The "never re-fire / never commit / per-task last-fired" invariant
 * lives behind this interface, not in the evaluator.
 *
 * Backed by each vault's `.holi/settings/app.local.yaml` under a `reminders` key —
 * gitignored by the seeded `*.local.*` rule, so a fire is never a commit. Other
 * local settings share the file, so it is read and written as the same YAML
 * document the settings writer produces: parsing it as anything else reads
 * nothing, and the next write would replace the machine's settings.
 * Synchronous by design: the sweep tick reads and marks inline.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { Delivered } from './sweep'

export interface DeliveredLog {
  read(remote: string): Delivered
  markDelivered(remote: string, path: string, fireAt: string): void
  fallbackReceipts(): { has(remote: string, path: string, due: string): boolean }
  markFallback(remote: string, path: string, due: string): void
}

const settingsFile = (root: string) => join(root, SETTINGS_LOCAL_FILE)

function loadSettings(root: string): Record<string, unknown> {
  const file = settingsFile(root)
  if (!existsSync(file)) return {}
  try {
    // An unparseable file reads as `{}`, so a corrupt file never stalls the sweep.
    return parseSettingsText(readFileSync(file, 'utf8'))
  } catch {
    return {}
  }
}

function writeSettings(root: string, settings: Record<string, unknown>): void {
  const file = settingsFile(root)
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.tmp`
  writeFileSync(tmp, writeSettingsText(settings, 'local', installedInfos()), 'utf8')
  renameSync(tmp, file)
}

export function createDeliveredLog(rootFor: (remote: string) => string | null): DeliveredLog {
  return {
    read(remote) {
      const root = rootFor(remote)
      if (root === null) return {}
      const reminders = loadSettings(root).reminders
      return reminders && typeof reminders === 'object' ? (reminders as Delivered) : {}
    },
    fallbackReceipts() {
      const cache = new Map<string, Record<string, unknown> | null>()
      return {
        has(remote, path, due) {
          if (!cache.has(remote)) {
            const root = rootFor(remote)
            const value = root === null ? null : loadSettings(root).overdueTaskReceipts
            cache.set(
              remote,
              value !== null && typeof value === 'object' && !Array.isArray(value)
                ? (value as Record<string, unknown>)
                : null,
            )
          }
          const receipts = cache.get(remote)
          return (
            receipts?.[`receipt-${encodeURIComponent(JSON.stringify([remote, path, due]))}`] ===
            true
          )
        },
      }
    },
    markFallback(remote, path, due) {
      const root = rootFor(remote)
      if (root === null) return
      const settings = loadSettings(root)
      const existing = settings.overdueTaskReceipts
      const receipts =
        existing !== null && typeof existing === 'object' && !Array.isArray(existing)
          ? (existing as Record<string, unknown>)
          : {}
      writeSettings(root, {
        ...settings,
        overdueTaskReceipts: {
          ...receipts,
          [`receipt-${encodeURIComponent(JSON.stringify([remote, path, due]))}`]: true,
        },
      })
    },
    markDelivered(remote, path, fireAt) {
      const root = rootFor(remote)
      if (root === null) return
      const settings = loadSettings(root)
      const reminders: Delivered = {
        ...(settings.reminders && typeof settings.reminders === 'object'
          ? (settings.reminders as Delivered)
          : {}),
        [path]: fireAt,
      }
      writeSettings(root, { ...settings, reminders })
    },
  }
}
