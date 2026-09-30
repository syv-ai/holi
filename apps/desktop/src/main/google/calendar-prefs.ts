/**
 * Which calendars the user has switched on, remembered between launches.
 *
 * **It lives in main, and that is the whole point.** The agenda panel and the
 * agent's `holi-google agenda` both resolve their calendars through this file,
 * so switching a colleague's calendar off also hides it from the agent.
 *
 * Plain JSON, unencrypted, unlike `token-store.ts`: there is no credential
 * here, and a config file developers can open and fix is worth more than
 * hiding a list of calendar names.
 */
import { jsonFileStore } from '../json-file-store'
import type { CalendarOverrides } from './calendar'

export interface CalendarPrefsStore {
  /** The explicit choices. Absent from the map means "follow the default rule"
   *  — see `resolveCalendars`. */
  read(): Promise<CalendarOverrides>
  set(id: string, enabled: boolean): Promise<void>
}

/** Not written yet (every calendar follows the default) or corrupt (the user
 *  loses their toggles, never their agenda): no choices. */
function parseOverrides(parsed: unknown): CalendarOverrides {
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
  const out: CalendarOverrides = {}
  for (const [id, value] of Object.entries(parsed)) {
    // Anything else is a hand-edit gone wrong. Skipping the entry falls back
    // to the default for that calendar, which is a better answer than
    // treating `"yes"` as truthy and silently enabling someone's calendar.
    if (typeof value === 'boolean') out[id] = value
  }
  return out
}

export function createCalendarPrefs(path: string): CalendarPrefsStore {
  const store = jsonFileStore(path, parseOverrides)
  return {
    read: store.read,
    async set(id, enabled) {
      await store.update((current) => ({ ...current, [id]: enabled }))
    },
  }
}
