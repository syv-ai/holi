/**
 * The activity log as the renderer holds it: what Holi did in the background
 * (docs/features/status-bar.md), for the bottom panel's Output and the status
 * bar's Output item.
 *
 * Main keeps the log (`main/activity/log.ts`); this is its copy, loaded once
 * and kept current by the `activity:entry` push. It is filled by the app
 * shell for the life of the window, so it collects while the panel is closed.
 */
import { atom, useSetAtom, useStore } from 'jotai'
import { useCallback, useEffect } from 'react'
import type { ActivityChannel, ActivityEntry } from '../../../main/activity/log'
import { trpc } from '@/lib/trpc'

export type { ActivityChannel, ActivityEntry }

/** As many as main keeps. */
export const ACTIVITY_CAP = 2000

/** The Output's filter: everything, or one channel. */
export type ActivityFilter = 'all' | ActivityChannel

export const ACTIVITY_FILTERS: readonly { value: ActivityFilter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'git', label: 'Git' },
  { value: 'sync', label: 'Sync' },
  { value: 'agent', label: 'Agent' },
  { value: 'plugins', label: 'Plugins' },
  { value: 'app', label: 'App' },
]

export const activityEntriesAtom = atom<readonly ActivityEntry[]>([])

/** The first read: until it lands the Output shows a skeleton, and if it
 *  fails, the error with Retry. */
export const activityLoadAtom = atom<'loading' | 'ready' | 'error'>('loading')

export const activityFilterAtom = atom<ActivityFilter>('all')

/** The newest id the person has seen in the Output: an error after it lights
 *  the status bar's Output item. */
export const activitySeenAtom = atom(0)

/** An error was logged since the Output was last looked at. */
export const activityUnseenErrorAtom = atom((get) => {
  const seen = get(activitySeenAtom)
  return get(activityEntriesAtom).some((e) => e.level === 'error' && e.id > seen)
})

/** Mark everything held as seen: the Output is on screen. */
export const markActivitySeenAtom = atom(null, (get, set) => {
  const last = get(activityEntriesAtom).at(-1)
  if (last !== undefined && last.id > get(activitySeenAtom)) set(activitySeenAtom, last.id)
})

/**
 * Two runs of lines as one, by id, oldest first and capped: the first read
 * and the pushes that raced it overlap, and neither alone is the whole.
 */
export function mergeEntries(
  held: readonly ActivityEntry[],
  more: readonly ActivityEntry[],
  cap = ACTIVITY_CAP,
): ActivityEntry[] {
  const byId = new Map<number, ActivityEntry>()
  for (const e of held) byId.set(e.id, e)
  for (const e of more) byId.set(e.id, e)
  const all = [...byId.values()].sort((a, b) => a.id - b.id)
  return all.length > cap ? all.slice(all.length - cap) : all
}

export function filterEntries(
  entries: readonly ActivityEntry[],
  filter: ActivityFilter,
): readonly ActivityEntry[] {
  return filter === 'all' ? entries : entries.filter((e) => e.channel === filter)
}

/** `HH:MM:SS`, local, for a line's time. */
export function clockTime(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '--:--:--'
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

/** A line as text, for the clipboard. */
export function entryText(e: ActivityEntry): string {
  const head = `${clockTime(e.at)} [${e.channel}] ${e.level === 'info' ? '' : `${e.level}: `}${e.message}`
  return e.detail === undefined ? head : `${head}\n${e.detail.replace(/^/gm, '    ')}`
}

/** Load the log and follow it. Mounted once, by the app shell. Returns the
 *  first read again, for Retry. */
export function useActivityLog(): () => void {
  const store = useStore()
  const setLoad = useSetAtom(activityLoadAtom)

  const load = useCallback(() => {
    setLoad('loading')
    trpc.activity.entries
      .query()
      .then((entries) => {
        store.set(activityEntriesAtom, (held) => mergeEntries(held, entries))
        setLoad('ready')
      })
      .catch((err: unknown) => {
        console.error('[activity] load failed:', err)
        setLoad('error')
      })
  }, [store, setLoad])

  useEffect(() => {
    // Absent in a test or a page without the preload bridge.
    const off = window.holi?.activity?.onEntry((entry) =>
      store.set(activityEntriesAtom, (held) => mergeEntries(held, [entry])),
    )
    load()
    return () => off?.()
  }, [store, load])

  return load
}

/** Clear the log, here and in main, so a reload does not bring it back. */
export const clearActivityAtom = atom(null, async (_get, set) => {
  set(activityEntriesAtom, [])
  await trpc.activity.clear.mutate().catch((err: unknown) => {
    console.error('[activity] clear failed:', err)
  })
})
