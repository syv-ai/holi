/**
 * The delivery watermark, named. Two verbs over the per-task last-fired map:
 * `read` is what `sweep` indexes (one file read per vault per tick), `markDelivered`
 * advances it. The "never re-fire / never commit / per-task last-fired" invariant
 * lives behind this interface, not in the evaluator.
 *
 * Backed by each vault's `.holi/settings.local.json` under a `reminders` key —
 * gitignored by the seeded `*.local.*` rule, so a fire is never a commit. Siblings
 * (e.g. a future login-item flag) share the file, so writes merge rather than clobber.
 * Synchronous by design: the sweep tick reads and marks inline.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { Delivered } from './sweep'

export interface DeliveredLog {
  read(remote: string): Delivered
  markDelivered(remote: string, path: string, fireAt: string): void
}

const settingsFile = (root: string) => join(root, '.holi', 'settings.local.json')

function loadSettings(root: string): Record<string, unknown> {
  const file = settingsFile(root)
  if (!existsSync(file)) return {}
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {}
  } catch {
    // A corrupt local file must not stall the sweep — treat as empty and let the
    // next markDelivered rewrite it clean.
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
      writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n', 'utf8')
      renameSync(tmp, file)
    },
  }
}
