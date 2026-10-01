/**
 * What ⌘P lists, and in what order. Pure, so a node test and the
 * screen agree: cmdk runs with `shouldFilter={false}` and renders exactly
 * what `rankRows` returns.
 *
 * A row is one openable thing: a vault path (a note or any other file), a
 * registered surface, one of a surface's instances (a vault app) or open
 * tabs (an agent terminal), or an item a plugin lists (a live agent
 * session). Before
 * anything is typed the recents come first, then the rest by modified time;
 * with a query, every row is scored by `command-score` (the scorer cmdk
 * bundles) on its name and then, at a discount, on its key, so a folder name
 * still finds the file inside it. Recents break ties. A cap keeps a vault of
 * thousands of files from mounting thousands of items.
 */
import commandScore from 'command-score'
import { isHiddenPath, type VaultSnapshot } from '@holi/shared'
import type { Tab } from '../state/panes'
import { entryOfTab, type RecentEntry } from './recents'

export type RowKind = 'path' | 'surface' | 'item'

/** A surface row's icon is its surface's, read from the registry where the
 *  row is drawn. A plugin's item is a dot. */
export type RowIcon =
  { emoji: string } | { glyph: 'note' | 'daily' | 'file' | 'surface' } | { dot: string }

export interface PaletteRow {
  kind: RowKind
  /** The path, surface kind or item key: what opens it, and what a recent
   *  of the same kind is keyed by. */
  key: string
  /** Which instance or tab of a surface (a vault app's bundle path), or the
   *  plugin an item is from. */
  id?: string
  name: string
  /** The folder for a path or an instance; nothing for the rest. */
  detail?: string
  icon: RowIcon
  /** A git-ignored path: shown, dimmed, as VS Code does. */
  dim?: boolean
  /** ISO mtime, paths only: the order of the untyped list after the recents. */
  updatedAt?: string
  /** What it opens takes the keyboard itself (a terminal), so the palette
   *  must not put focus back where it was. */
  focuses?: true
}

export interface RankedRow extends PaletteRow {
  /** Came from the recents, so the empty-query list can head it as such. */
  recent: boolean
  /** A text match: the words around it, shown in place of the folder. */
  snippet?: string
}

export const ROW_CAP = 50

function splitPath(path: string): { name: string; detail?: string } {
  const slash = path.lastIndexOf('/')
  if (slash < 0) return { name: path }
  return { name: path.slice(slash + 1), detail: path.slice(0, slash) }
}

export interface RowSources {
  snapshot: VaultSnapshot
  /** What plugins list that is not a tab (a live agent session). */
  items?: readonly { plugin: string; key: string; name: string; dot: string }[]
  /** The tabs of surfaces that list theirs (an agent's terminals). */
  tabs?: readonly { surface: string; id: string; label: string }[]
  /** The surfaces the palette offers, by kind, with their labels. */
  surfaces?: readonly { kind: string; label: string }[]
  /** Surfaces' instances (each vault app), with their labels. */
  instances?: readonly { surface: string; id: string; label: string }[]
}

export function buildRows({
  snapshot,
  items = [],
  tabs = [],
  surfaces = [],
  instances = [],
}: RowSources): PaletteRow[] {
  const ignored = new Set(snapshot.ignored)
  const pathRow = (
    path: string,
    glyph: 'note' | 'daily' | 'file',
    updatedAt: string,
  ): PaletteRow => {
    const emoji = snapshot.icons[path]
    return {
      kind: 'path',
      key: path,
      ...splitPath(path),
      icon: emoji === undefined ? { glyph } : { emoji },
      ...(ignored.has(path) ? { dim: true } : {}),
      updatedAt,
    }
  }
  return [
    ...snapshot.docs
      .filter((d) => !isHiddenPath(d.path))
      .map((d) => pathRow(d.path, d.kind === 'daily' ? 'daily' : 'note', d.updatedAt)),
    ...snapshot.files
      .filter((f) => !isHiddenPath(f.path))
      .map((f) => pathRow(f.path, 'file', f.updatedAt)),
    ...instances.map(({ surface, id, label }): PaletteRow => ({
      kind: 'surface',
      key: surface,
      id,
      ...splitPath(id),
      name: label,
      icon: { glyph: 'surface' },
    })),
    ...items.map((item): PaletteRow => ({
      kind: 'item',
      key: item.key,
      id: item.plugin,
      name: item.name,
      icon: { dot: item.dot },
      focuses: true,
    })),
    ...tabs.map((t): PaletteRow => ({
      kind: 'surface',
      key: t.surface,
      id: t.id,
      name: t.label,
      icon: { glyph: 'surface' },
      focuses: true,
    })),
    ...surfaces.map(({ kind, label }): PaletteRow => ({
      kind: 'surface',
      key: kind,
      name: label,
      icon: { glyph: 'surface' },
    })),
  ]
}

/** What a row or a recent is, as one string: its kind, key and id. */
export const rowId = ({ kind, key, id }: { kind: string; key: string; id?: string }): string =>
  id === undefined ? `${kind}:${key}` : `${kind}:${key}:${id}`

/** Position of each recent, so a lower number is more recent. */
function recentOrder(recents: readonly RecentEntry[]): Map<string, number> {
  const order = new Map<string, number>()
  recents.forEach((r, i) => {
    if (!order.has(rowId(r))) order.set(rowId(r), i)
  })
  return order
}

/**
 * Score a row against a query: its name first, then its key at half weight.
 * `0` is no match.
 */
function scoreRow(row: PaletteRow, query: string): number {
  const byName = commandScore(row.name, query)
  if (byName > 0) return byName
  if (row.kind !== 'path') return 0
  return commandScore(row.key, query) * 0.5
}

export function rankRows(
  rows: readonly PaletteRow[],
  query: string,
  recents: readonly RecentEntry[],
  cap = ROW_CAP,
): RankedRow[] {
  const order = recentOrder(recents)
  const q = query.trim()

  if (q === '') {
    const byId = new Map(rows.map((r) => [rowId(r), r]))
    const recent: RankedRow[] = []
    for (const r of recents) {
      const row = byId.get(rowId(r))
      if (row !== undefined && !recent.some((x) => rowId(x) === rowId(row))) {
        recent.push({ ...row, recent: true })
      }
    }
    const seen = new Set(recent.map(rowId))
    const rest = rows
      .filter((r) => r.kind === 'path' && !seen.has(rowId(r)))
      .sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''))
      .map((r): RankedRow => ({ ...r, recent: false }))
    return [...recent, ...rest].slice(0, cap)
  }

  return rows
    .map((row) => ({ row, score: scoreRow(row, q) }))
    .filter((x) => x.score > 0)
    .sort(
      (a, b) =>
        b.score - a.score ||
        (order.get(rowId(a.row)) ?? Infinity) - (order.get(rowId(b.row)) ?? Infinity) ||
        a.row.name.localeCompare(b.row.name),
    )
    .slice(0, cap)
    .map(({ row }): RankedRow => ({ ...row, recent: order.has(rowId(row)) }))
}

/**
 * The notes whose text matched, as rows after the name matches: in the order
 * main found them, only paths the palette lists by name too (so a hidden path
 * stays hidden), and none that the name rows already show.
 */
export function bodyRows(
  rows: readonly PaletteRow[],
  ranked: readonly RankedRow[],
  hits: readonly { path: string; snippet?: string }[],
  cap = ROW_CAP,
): RankedRow[] {
  const byPath = new Map(rows.filter((r) => r.kind === 'path').map((r) => [r.key, r]))
  const shown = new Set(ranked.filter((r) => r.kind === 'path').map((r) => r.key))
  const out: RankedRow[] = []
  for (const hit of hits) {
    const row = byPath.get(hit.path)
    if (row === undefined || shown.has(hit.path)) continue
    shown.add(hit.path)
    out.push({
      ...row,
      recent: false,
      ...(hit.snippet === undefined ? {} : { snippet: hit.snippet }),
    })
    if (out.length >= cap) break
  }
  return out
}

/**
 * The ⌃⇥ switcher's list: the rows that are open as tabs, most recently
 * activated first, with the tab you are on left out — the first row is where
 * one ⌃⇥ takes you. Tabs the recents do not know come after, in pane order.
 */
export function openTabRows(
  rows: readonly PaletteRow[],
  openTabs: readonly Tab[],
  current: Tab | null,
  recents: readonly RecentEntry[],
): RankedRow[] {
  const byId = new Map(rows.map((r) => [rowId(r), r]))
  const currentId = current === null ? null : rowId(entryOfTab(current))
  const open = new Map<string, PaletteRow>()
  for (const tab of openTabs) {
    const id = rowId(entryOfTab(tab))
    const row = byId.get(id)
    if (row !== undefined && id !== currentId) open.set(id, row)
  }
  const ordered: RankedRow[] = []
  for (const r of recents) {
    const row = open.get(rowId(r))
    if (row !== undefined) {
      ordered.push({ ...row, recent: true })
      open.delete(rowId(r))
    }
  }
  for (const row of open.values()) ordered.push({ ...row, recent: false })
  return ordered
}

/** The text after a leading `>`, trimmed; null when the box is not in command mode. */
export function commandQuery(query: string): string | null {
  return query.startsWith('>') ? query.slice(1).trimStart() : null
}

export interface CommandRowSource {
  id: string
  label: string
  hotkey?: string
}

export interface RankedCommand<C extends CommandRowSource = CommandRowSource> {
  command: C
  recent: boolean
}

/**
 * `>` mode: recently used first, then the rest by label; with a query, scored
 * on the label with recents breaking ties. The caller has already dropped
 * rows whose `when` is false.
 */
export function rankCommands<C extends CommandRowSource>(
  commands: readonly C[],
  query: string,
  recents: readonly RecentEntry[],
): RankedCommand<C>[] {
  const order = recentOrder(recents.filter((r) => r.kind === 'command'))
  const q = query.trim()
  const key = (c: C): string => rowId({ kind: 'command', key: c.id })
  const pos = (c: C): number => order.get(key(c)) ?? Infinity
  const recent = (c: C): boolean => order.has(key(c))

  if (q === '') {
    return [...commands]
      .sort((a, b) => pos(a) - pos(b) || a.label.localeCompare(b.label))
      .map((command) => ({ command, recent: recent(command) }))
  }
  return commands
    .map((command) => ({ command, score: commandScore(command.label, q) }))
    .filter((x) => x.score > 0)
    .sort(
      (a, b) =>
        b.score - a.score ||
        pos(a.command) - pos(b.command) ||
        a.command.label.localeCompare(b.command.label),
    )
    .map(({ command }) => ({ command, recent: recent(command) }))
}
