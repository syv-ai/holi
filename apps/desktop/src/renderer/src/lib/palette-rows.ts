/**
 * What ⌘P lists, and in what order (D102). Pure, so a node test and the
 * screen agree: cmdk runs with `shouldFilter={false}` and renders exactly
 * what `rankRows` returns.
 *
 * A row is one openable thing: a vault path (a note or any other file), a
 * vault app, a live agent session, or one of the five fixed surfaces. Before
 * anything is typed the recents come first, then the rest by modified time;
 * with a query, every row is scored by `command-score` (the scorer cmdk
 * bundles) on its name and then, at a discount, on its key, so a folder name
 * still finds the file inside it. Recents break ties. A cap keeps a vault of
 * thousands of files from mounting thousands of items.
 */
import commandScore from 'command-score'
import { isHiddenPath, type VaultSnapshot } from '@holi/shared'
import type { RecentEntry, RecentKind } from './recents'

export type RowKind = Exclude<RecentKind, 'command'>

export type RowIcon =
  | { emoji: string }
  | {
      glyph:
        | 'note'
        | 'daily'
        | 'file'
        | 'app'
        | 'session'
        | 'board'
        | 'agenda'
        | 'mail'
        | 'settings'
        | 'history'
    }

export interface PaletteRow {
  kind: RowKind
  /** The path, app id, session id or surface kind — what opens it, and what
   *  a recent of the same kind is keyed by. */
  key: string
  name: string
  /** The folder for a path; nothing for the rest. */
  detail?: string
  icon: RowIcon
  /** A git-ignored path: shown, dimmed, as VS Code does. */
  dim?: boolean
  /** ISO mtime, paths only: the order of the untyped list after the recents. */
  updatedAt?: string
}

export interface RankedRow extends PaletteRow {
  /** Came from the recents, so the empty-query list can head it as such. */
  recent: boolean
}

export const ROW_CAP = 50

type SurfaceKey = 'board' | 'agenda' | 'mail' | 'settings' | 'history'

const SURFACES: readonly { key: SurfaceKey; name: string }[] = [
  { key: 'board', name: 'Board' },
  { key: 'agenda', name: 'Agenda' },
  { key: 'mail', name: 'Mail' },
  { key: 'settings', name: 'Settings' },
  { key: 'history', name: 'History' },
]

function splitPath(path: string): { name: string; detail?: string } {
  const slash = path.lastIndexOf('/')
  if (slash < 0) return { name: path }
  return { name: path.slice(slash + 1), detail: path.slice(0, slash) }
}

export interface RowSources {
  snapshot: VaultSnapshot
  appIds: readonly string[]
  sessions: readonly { id: string; name: string; exited: boolean }[]
}

export function buildRows({ snapshot, appIds, sessions }: RowSources): PaletteRow[] {
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
    ...appIds.map((id): PaletteRow => ({ kind: 'app', key: id, name: id, icon: { glyph: 'app' } })),
    ...sessions
      .filter((s) => !s.exited)
      .map((s): PaletteRow => ({
        kind: 'session',
        key: s.id,
        name: s.name,
        icon: { glyph: 'session' },
      })),
    ...SURFACES.map(({ key, name }): PaletteRow => ({
      kind: 'surface',
      key,
      name,
      icon: { glyph: key },
    })),
  ]
}

const rowId = (kind: string, key: string): string => `${kind}:${key}`

/** Position of each recent, so a lower number is more recent. */
function recentOrder(recents: readonly RecentEntry[]): Map<string, number> {
  const order = new Map<string, number>()
  recents.forEach((r, i) => {
    if (!order.has(rowId(r.kind, r.key))) order.set(rowId(r.kind, r.key), i)
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
    const byId = new Map(rows.map((r) => [rowId(r.kind, r.key), r]))
    const recent: RankedRow[] = []
    for (const r of recents) {
      const row = byId.get(rowId(r.kind, r.key))
      if (row !== undefined && !recent.some((x) => x.key === row.key && x.kind === row.kind)) {
        recent.push({ ...row, recent: true })
      }
    }
    const seen = new Set(recent.map((r) => rowId(r.kind, r.key)))
    const rest = rows
      .filter((r) => r.kind === 'path' && !seen.has(rowId(r.kind, r.key)))
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
        (order.get(rowId(a.row.kind, a.row.key)) ?? Infinity) -
          (order.get(rowId(b.row.kind, b.row.key)) ?? Infinity) ||
        a.row.name.localeCompare(b.row.name),
    )
    .slice(0, cap)
    .map(({ row }): RankedRow => ({ ...row, recent: order.has(rowId(row.kind, row.key)) }))
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
  const pos = (c: C): number => order.get(rowId('command', c.id)) ?? Infinity
  const recent = (c: C): boolean => order.has(rowId('command', c.id))

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
