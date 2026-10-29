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
import { emptyFilterQuery, filterRule, type FilterNode, type FilterQuery } from '@/lib/filter-query'

export type { ActivityChannel, ActivityEntry }

/** As many as main keeps. */
const ACTIVITY_CAP = 2000

/** The channels as the Output names them, beside their marks. */
export const ACTIVITY_CHANNEL_LABELS: Record<ActivityChannel, string> = {
  git: 'Git',
  sync: 'Sync',
  agent: 'Agent',
  plugins: 'Plugins',
  app: 'Holi',
}

export const ACTIVITY_LEVEL_LABELS: Record<ActivityEntry['level'], string> = {
  info: 'Info',
  warn: 'Warning',
  error: 'Error',
}

/** A channel's name as the Output shows it, beside its mark. */
export function channelLabel(channel: ActivityChannel): string {
  return ACTIVITY_CHANNEL_LABELS[channel]
}

export const activityEntriesAtom = atom<readonly ActivityEntry[]>([])

/** The first read: until it lands the Output shows a skeleton, and if it
 *  fails, the error with Retry. */
export const activityLoadAtom = atom<'loading' | 'ready' | 'error'>('loading')

/** The Output's Filters: one query tree over channel, level, vault and
 *  message, as ReUI's Filters edits it. */
export const activityQueryAtom = atom<FilterQuery>(emptyFilterQuery())

/** The Output's search, over message, detail, channel and vault. */
export const activitySearchAtom = atom('')

/**
 * A channel's quick filter, from a click on a row's channel: `only` shows that
 * channel, `hide` everything but it. It replaces any top-level channel rule
 * already there, so a second click narrows again rather than ANDing two
 * channels into nothing; every other rule stays.
 */
export function withChannelRule(
  query: FilterQuery,
  channel: ActivityChannel,
  mode: 'only' | 'hide',
): FilterQuery {
  return {
    ...query,
    rules: [
      ...query.rules.filter((node) => node.type !== 'rule' || node.path[0] !== 'channel'),
      filterRule({
        id: `${mode}-${channel}`,
        path: ['channel'],
        operator: mode === 'only' ? 'is' : 'is_not',
        value: channel,
      }),
    ],
  }
}

/** The newest id the person has seen in the Output: an error after it lights
 *  the status bar's Output item.
 * @public exported for its test
 */
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
 * @public exported for its test
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

function readPath(e: ActivityEntry, path: readonly string[]): unknown {
  switch (path[0]) {
    case 'channel':
      return e.channel
    case 'level':
      return e.level
    case 'vault':
      return e.remote
    case 'message':
      return e.message
    default:
      return undefined
  }
}

const list = (value: unknown) => (Array.isArray(value) ? value : [value])
const text = (value: unknown) => String(value ?? '').toLowerCase()
const isBlank = (value: unknown) => value === undefined || value === null || value === ''

const TESTS: Record<string, (actual: unknown, value: unknown) => boolean> = {
  is: (actual, value) => actual === value,
  is_not: (actual, value) => actual !== value,
  is_any_of: (actual, value) => list(value).includes(actual),
  is_none_of: (actual, value) => !list(value).includes(actual),
  contains: (actual, value) => text(actual).includes(text(value)),
  not_contains: (actual, value) => !text(actual).includes(text(value)),
  starts_with: (actual, value) => text(actual).startsWith(text(value)),
  empty: (actual) => isBlank(actual),
  not_empty: (actual) => !isBlank(actual),
}

/** A rule still being built (no value yet) constrains nothing. */
function isIncomplete(operator: string, value: unknown): boolean {
  if (operator === 'empty' || operator === 'not_empty') return false
  if (isBlank(value)) return true
  return Array.isArray(value) && (value.length === 0 || value.some(isBlank))
}

/**
 * A Filters query against one line, its fields read through `read`. Shared
 * by the Output and the Logs tab. null abstains: an unfinished rule must not
 * satisfy an OR on its own.
 */
export function evaluateFilter(
  node: FilterNode,
  read: (path: readonly string[]) => unknown,
): boolean | null {
  if (node.type === 'group') {
    const votes = node.rules
      .map((child) => evaluateFilter(child, read))
      .filter((vote): vote is boolean => vote !== null)
    if (votes.length === 0) return null
    return node.combinator === 'and' ? votes.every(Boolean) : votes.some(Boolean)
  }
  const test = TESTS[node.operator]
  if (!test || isIncomplete(node.operator, node.value)) return null
  const result = test(read(node.path), node.value)
  return node.negated ? !result : result
}

/** The lines the Output shows: those the query passes and the search finds. */
export function shownEntries(
  entries: readonly ActivityEntry[],
  query: FilterQuery,
  search: string,
): readonly ActivityEntry[] {
  const needle = search.trim().toLowerCase()
  const noRules = query.rules.length === 0
  if (noRules && needle === '') return entries
  return entries.filter((e) => {
    if (!noRules && evaluateFilter(query, (path) => readPath(e, path)) === false) return false
    if (needle === '') return true
    return [e.message, e.detail, e.channel, channelLabel(e.channel), e.remote].some(
      (field) => field !== undefined && field.toLowerCase().includes(needle),
    )
  })
}

/** `HH:MM:SS`, local, for a line's time. */
export function clockTime(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '--:--:--'
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

/** Date and time to the second, local, for an opened line. */
export function fullTime(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'medium' })
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
