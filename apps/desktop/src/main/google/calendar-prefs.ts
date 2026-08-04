/**
 * Which calendars the user has switched on, remembered between launches.
 *
 * **It lives in main, and that is the whole point.** The agenda panel and the
 * agent's `holi-google agenda` both resolve their calendars through this file,
 * so switching a colleague's calendar off is one fact about the account rather
 * than a preference the UI holds and the agent has never heard of. Putting it
 * in the renderer would have meant the agent quietly reading four other
 * people's days.
 *
 * Plain JSON, unencrypted, unlike `token-store.ts` next door: there is no
 * credential here, only a set of ids the user chose. Holi's users are
 * developers, and a config file they can open and fix is worth more than
 * hiding a list of calendar names.
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { CalendarOverrides } from './calendar'

export interface CalendarPrefsStore {
  /** The explicit choices. Absent from the map means "follow the default rule"
   *  — see `resolveCalendars`. */
  read(): Promise<CalendarOverrides>
  set(id: string, enabled: boolean): Promise<void>
}

export function createCalendarPrefs(path: string): CalendarPrefsStore {
  const read = async (): Promise<CalendarOverrides> => {
    let raw: string
    try {
      raw = await readFile(path, 'utf8')
    } catch {
      // Not written yet — every calendar follows the default.
      return {}
    }
    try {
      const parsed: unknown = JSON.parse(raw)
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
      const out: CalendarOverrides = {}
      for (const [id, value] of Object.entries(parsed)) {
        // Anything else is a hand-edit gone wrong. Skipping the entry falls back
        // to the default for that calendar, which is a better answer than
        // treating `"yes"` as truthy and silently enabling someone's calendar.
        if (typeof value === 'boolean') out[id] = value
      }
      return out
    } catch {
      // Corrupt file costs the user their toggles, never their agenda.
      return {}
    }
  }

  return {
    read,
    async set(id, enabled) {
      const next = { ...(await read()), [id]: enabled }
      await mkdir(dirname(path), { recursive: true })
      // Written aside and renamed: a crash mid-write must not leave a truncated
      // file, which `read` would discard along with every other choice.
      const temporary = `${path}.tmp`
      await writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
      await rename(temporary, path)
    },
  }
}
