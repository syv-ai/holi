/** Machine-local workspace storage. Only reversible view keys and layout metadata
 * cross this seam: never editor buffers or the Reopen closed tab history. */
import {
  emptyWorkspace,
  entryId,
  MAX_SPLIT,
  trackRecent,
  type ShellEntry,
  type ShellWorkspace,
} from './shell-workspace'
import { parseTabKey, tabKey } from './tab-descriptor'

const PREFIX = 'holi.workspace.'

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function sequence(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value < Number.MAX_SAFE_INTEGER
  )
}

function viewKey(value: unknown): value is string {
  if (typeof value !== 'string') return false
  const tab = parseTabKey(value)
  return tab !== null && tabKey(tab) === value && (tab.kind !== 'new' || sequence(tab.n))
}

function restore(value: unknown): ShellWorkspace {
  const ws = emptyWorkspace()
  if (!record(value) || !Array.isArray(value.entries)) return ws
  const views = new Set<string>()
  const ids = new Set<string>()
  const take = (value: unknown): value is string => {
    if (!viewKey(value) || views.has(value)) return false
    views.add(value)
    return true
  }
  const entries: ShellEntry[] = []
  for (const entry of value.entries) {
    if (typeof entry === 'string') {
      if (take(entry)) entries.push(entry)
      continue
    }
    if (!record(entry) || !Array.isArray(entry.views)) continue
    const rawViews = entry.views
    const members = rawViews.filter(take)
    if (members.length === 0) continue
    const match = typeof entry.id === 'string' ? /^holi:split:([1-9]\d*)$/.exec(entry.id) : null
    const n = match === null ? null : Number(match[1])
    // A broken split still has useful views. Flatten it in place rather than
    // inventing an identity or letting two split panels share one.
    if (
      members.length < 2 ||
      members.length > MAX_SPLIT ||
      n === null ||
      !sequence(n) ||
      ids.has(String(entry.id))
    ) {
      entries.push(...members)
      continue
    }
    const id = entry.id as string
    ids.add(id)
    const raw = entry.shares
    const validShares =
      Array.isArray(raw) &&
      raw.length === rawViews.length &&
      raw.every((share) => typeof share === 'number' && Number.isFinite(share) && share > 0)
    const shares = validShares
      ? members.map((key) => (raw as number[])[rawViews.indexOf(key)]!)
      : members.map(() => 1)
    const sum = shares.reduce((a, b) => a + b, 0)
    const normalized = shares.map((share) => share / sum)
    entries.push({
      id,
      views: members,
      shares: normalized.every((share) => Number.isFinite(share) && share > 0)
        ? normalized
        : members.map(() => 1 / members.length),
      focused:
        typeof entry.focused === 'string' && members.includes(entry.focused)
          ? entry.focused
          : members[0]!,
    })
  }
  const open = new Set(entries.map(entryId))
  let seq = sequence(value.seq) ? value.seq : 0
  for (const key of [...views, ...ids]) {
    const tab = parseTabKey(key)
    const n = tab?.kind === 'new' ? tab.n : Number(/^holi:split:(\d+)$/.exec(key)?.[1] ?? 0)
    seq = Math.max(seq, n)
  }
  const uniqueReferences = (value: unknown, allowed: Set<string>): string[] =>
    Array.isArray(value)
      ? [
          ...new Set(
            value.filter((key): key is string => typeof key === 'string' && allowed.has(key)),
          ),
        ]
      : []
  return trackRecent({
    ...ws,
    entries,
    active:
      value.active === null || (typeof value.active === 'string' && open.has(value.active))
        ? value.active
        : entries.length
          ? entryId(entries[0]!)
          : null,
    seq,
    recent: uniqueReferences(value.recent, open),
    sticky: uniqueReferences(value.sticky, views),
  })
}

/** Read once per Jotai store, before any write (including an unmounted store).
 * Separate keys mean a write for one remote never rewrites another's snapshot. */
export function readWorkspaces(): Record<string, ShellWorkspace> {
  const all: Record<string, ShellWorkspace> = {}
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i)
      if (key === null || !key.startsWith(PREFIX)) continue
      const remote = key.slice(PREFIX.length)
      if (!/^[^/]+\/[^/]+$/.test(remote)) continue
      try {
        all[remote] = restore(JSON.parse(localStorage.getItem(key) ?? 'null'))
      } catch {
        // One corrupt workspace must not prevent another vault restoring.
      }
    }
  } catch {
    // Storage unavailable: workspaces still last this app session.
  }
  return all
}

export function writeWorkspace(remote: string, ws: ShellWorkspace): void {
  if (!/^[^/]+\/[^/]+$/.test(remote)) return
  try {
    const { entries, active, seq, recent, sticky } = ws
    localStorage.setItem(PREFIX + remote, JSON.stringify({ entries, active, seq, recent, sticky }))
  } catch {
    // Quota or storage access refused: keep the live workspace usable.
  }
}
