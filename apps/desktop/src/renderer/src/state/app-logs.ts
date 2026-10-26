/**
 * The application log as the renderer holds it: everything Holi prints, main
 * and window (docs/features/status-bar.md), for the bottom panel's Logs tab.
 *
 * Main keeps the log (`main/logs/app-log.ts`) from launch; this is its copy,
 * loaded once by the panel and kept current by the `logs:entry` push.
 */
import { atom, useSetAtom, useStore } from 'jotai'
import { useCallback, useEffect } from 'react'
import type { AppLogEntry, AppLogLevel, AppLogSource } from '../../../main/logs/app-log'
import { trpc } from '@/lib/trpc'
import { emptyFilterQuery, type FilterQuery } from '@/lib/filter-query'
import { clockTime, evaluateFilter } from './activity'

export type { AppLogEntry, AppLogLevel, AppLogSource }

/** As many as main keeps. */
const APP_LOG_CAP = 5000

export const APP_LOG_LEVEL_LABELS: Record<AppLogLevel, string> = {
  debug: 'Debug',
  info: 'Info',
  warn: 'Warning',
  error: 'Error',
}

export const APP_LOG_SOURCE_LABELS: Record<AppLogSource, string> = {
  main: 'Main',
  renderer: 'Window',
}

export const appLogEntriesAtom = atom<readonly AppLogEntry[]>([])

/** The first read: a skeleton until it lands, the error with Retry if not. */
export const appLogLoadAtom = atom<'loading' | 'ready' | 'error'>('loading')

/** The Logs tab's Filters, over level, process, scope and message. */
export const appLogQueryAtom = atom<FilterQuery>(emptyFilterQuery())

/** The Logs tab's search, over message, detail and scope. */
export const appLogSearchAtom = atom('')

/** Two runs of lines as one, by id, oldest first and capped. */
export function mergeAppLog(
  held: readonly AppLogEntry[],
  more: readonly AppLogEntry[],
  cap = APP_LOG_CAP,
): AppLogEntry[] {
  const byId = new Map<number, AppLogEntry>()
  for (const e of held) byId.set(e.id, e)
  for (const e of more) byId.set(e.id, e)
  const all = [...byId.values()].sort((a, b) => a.id - b.id)
  return all.length > cap ? all.slice(all.length - cap) : all
}

function readPath(e: AppLogEntry, path: readonly string[]): unknown {
  switch (path[0]) {
    case 'level':
      return e.level
    case 'source':
      return e.source
    case 'scope':
      return e.scope
    case 'message':
      return e.message
    default:
      return undefined
  }
}

/** The lines the Logs tab shows: those the query passes and the search finds. */
export function shownAppLog(
  entries: readonly AppLogEntry[],
  query: FilterQuery,
  search: string,
): readonly AppLogEntry[] {
  const needle = search.trim().toLowerCase()
  const noRules = query.rules.length === 0
  if (noRules && needle === '') return entries
  return entries.filter((e) => {
    if (!noRules && evaluateFilter(query, (path) => readPath(e, path)) === false) return false
    if (needle === '') return true
    return [e.message, e.detail, e.scope].some(
      (field) => field !== undefined && field.toLowerCase().includes(needle),
    )
  })
}

/** A line as text, for the clipboard. */
export function appLogText(e: AppLogEntry): string {
  const scope = e.scope === undefined ? '' : `[${e.scope}] `
  const head = `${clockTime(e.at)} ${e.source} ${e.level}: ${scope}${e.message}`
  return e.detail === undefined ? head : `${head}\n${e.detail.replace(/^/gm, '    ')}`
}

/** Load the log and follow it. Mounted once, by the bottom panel. Returns the
 *  first read again, for Retry. */
export function useAppLog(): () => void {
  const store = useStore()
  const setLoad = useSetAtom(appLogLoadAtom)

  const load = useCallback(() => {
    setLoad('loading')
    trpc.logs.entries
      .query()
      .then((entries) => {
        store.set(appLogEntriesAtom, (held) => mergeAppLog(held, entries))
        setLoad('ready')
      })
      .catch((err: unknown) => {
        console.error('[logs] load failed:', err)
        setLoad('error')
      })
  }, [store, setLoad])

  useEffect(() => {
    // Absent in a test or a page without the preload bridge.
    const off = window.holi?.logs?.onEntry((entry) =>
      store.set(appLogEntriesAtom, (held) => mergeAppLog(held, [entry])),
    )
    load()
    return () => off?.()
  }, [store, load])

  return load
}

/** Clear the log, here and in main, so a reload does not bring it back. */
export const clearAppLogAtom = atom(null, async (_get, set) => {
  set(appLogEntriesAtom, [])
  await trpc.logs.clear.mutate().catch((err: unknown) => {
    console.error('[logs] clear failed:', err)
  })
})
