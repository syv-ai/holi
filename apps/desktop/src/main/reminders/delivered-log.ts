import { SETTINGS_LOCAL_FILE, parseSettingsText, writeSettingsText } from '@holi/shared'
import { installedInfos } from '../plugin-host/installed'
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

export function createDeliveredLog(rootFor: (remote: string) => string | null): DeliveredLog {
  return {
    read(remote) {
      const root = rootFor(remote)
      if (root === null) return {}
      const reminders = loadSettings(root).reminders
      return reminders && typeof reminders === 'object' ? (reminders as Delivered) : {}
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
      const next = { ...settings, reminders }
      const file = settingsFile(root)
      mkdirSync(dirname(file), { recursive: true })
      const tmp = `${file}.tmp`
      writeFileSync(tmp, writeSettingsText(next, 'local', installedInfos()), 'utf8')
      renameSync(tmp, file)
    },
  }
}
