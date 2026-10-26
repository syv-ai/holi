// Cell templates read state through builder calls on a stable row/column,
// which React Compiler cannot see.
'use no memo'

import { AppWindowIcon, CpuIcon, SignalIcon, TagIcon, TextIcon } from 'lucide-react'
import { type DataGridFeatures } from '@/components/reui/data-grid/data-grid'
import { DataGridColumnHeader } from '@/components/reui/data-grid/data-grid-column-header'
import { type FilterField } from '@/components/reui/filters/filters-types'
import { type ColumnDef } from '@tanstack/react-table'

import { Skeleton } from '@/components/ui/skeleton'
import { cn } from '@/lib/cn'
import {
  APP_LOG_LEVEL_LABELS,
  APP_LOG_SOURCE_LABELS,
  appLogText,
  type AppLogEntry,
  type AppLogLevel,
  type AppLogSource,
} from '@/state/app-logs'
import { clockTime, fullTime } from '@/state/activity'

import { LogDetail } from './log-detail'
import { BADGE_MENU, FACE_MENU, faceValue } from './log-search'
import { LEVEL_RANK, LevelBadge } from './log-table'

/**
 * The Logs tab's columns, detail and filters (docs/features/status-bar.md):
 * everything Holi prints, main and window, in the panel's log grid. Time,
 * level, the process that printed it, the `[scope]` it opened with, and the
 * message.
 */

const LEVELS = Object.keys(APP_LOG_LEVEL_LABELS) as AppLogLevel[]
const SOURCES = Object.keys(APP_LOG_SOURCE_LABELS) as AppLogSource[]

const isLevel = (value: string): value is AppLogLevel => value in APP_LOG_LEVEL_LABELS
const isSource = (value: string): value is AppLogSource => value in APP_LOG_SOURCE_LABELS

/** The process that printed a line, with its glyph. */
function SourceTag({ source }: { source: AppLogSource }) {
  const Glyph = source === 'main' ? CpuIcon : AppWindowIcon
  return (
    <span className="inline-flex min-w-0 items-center gap-1.5">
      <Glyph aria-hidden className="text-muted-foreground size-3.5 shrink-0" />
      <span className="truncate">{APP_LOG_SOURCE_LABELS[source]}</span>
    </span>
  )
}

/** What an opened line shows. A module function, so it is stable. */
export function logsDetail(entry: AppLogEntry) {
  return (
    <LogDetail
      id={entry.id}
      fields={[
        {
          label: 'Time',
          value: (
            <time dateTime={entry.at} className="tabular-nums">
              {fullTime(entry.at)}
            </time>
          ),
        },
        { label: 'Level', value: APP_LOG_LEVEL_LABELS[entry.level] },
        { label: 'Process', value: <SourceTag source={entry.source} /> },
        {
          label: 'Scope',
          value:
            entry.scope === undefined ? (
              <span className="text-muted-foreground">None</span>
            ) : (
              <span className="font-mono text-xs">{entry.scope}</span>
            ),
        },
      ]}
      detail={entry.detail}
      raw={entry}
      copyText={appLogText(entry)}
    />
  )
}

export const LOGS_COLUMNS: ColumnDef<DataGridFeatures, AppLogEntry>[] = [
  {
    id: 'time',
    // The id is the log's own order: two lines in one millisecond keep theirs.
    accessorFn: (entry) => entry.id,
    header: ({ column }) => <DataGridColumnHeader column={column} />,
    cell: ({ row }) => (
      <time dateTime={row.original.at} className="font-mono text-xs tabular-nums">
        {clockTime(row.original.at)}
      </time>
    ),
    size: 88,
    meta: {
      headerTitle: 'Time',
      skeleton: <Skeleton className="h-4 w-16" />,
    },
  },
  {
    id: 'level',
    accessorFn: (entry) => LEVEL_RANK[entry.level],
    header: ({ column }) => <DataGridColumnHeader column={column} />,
    cell: ({ row }) => <LevelBadge level={row.original.level} />,
    size: 96,
    meta: {
      headerTitle: 'Level',
      skeleton: <Skeleton className="h-5 w-14 rounded-full" />,
    },
  },
  {
    id: 'source',
    accessorFn: (entry) => APP_LOG_SOURCE_LABELS[entry.source],
    header: ({ column }) => <DataGridColumnHeader column={column} />,
    cell: ({ row }) => <SourceTag source={row.original.source} />,
    size: 104,
    meta: {
      headerTitle: 'Process',
      skeleton: <Skeleton className="h-4 w-16" />,
    },
  },
  {
    id: 'scope',
    accessorFn: (entry) => entry.scope ?? '',
    header: ({ column }) => <DataGridColumnHeader column={column} />,
    cell: ({ row }) =>
      row.original.scope === undefined ? null : (
        <span className="text-muted-foreground block truncate font-mono text-xs">
          {row.original.scope}
        </span>
      ),
    size: 128,
    meta: {
      headerTitle: 'Scope',
      skeleton: <Skeleton className="h-4 w-20" />,
    },
  },
  {
    id: 'message',
    accessorKey: 'message',
    header: ({ column }) => <DataGridColumnHeader column={column} />,
    cell: ({ row }) => (
      <span
        className={cn(
          'block truncate font-mono text-xs',
          row.original.level === 'error' && 'text-destructive',
        )}
      >
        {row.original.message}
      </span>
    ),
    // The fixed layout hands spare width out by size: the message takes it.
    size: 480,
    enableSorting: false,
    meta: {
      headerTitle: 'Message',
      skeleton: <Skeleton className="h-4 w-64" />,
    },
  },
]

/** The fields, with the scopes the log has seen as Scope's options. */
export function logsFilterFields(scopes: readonly string[]): FilterField[] {
  return [
    {
      id: 'level',
      label: 'Level',
      icon: <SignalIcon aria-hidden="true" />,
      type: 'select',
      className: BADGE_MENU,
      options: LEVELS.map((level) => ({
        value: level,
        label: APP_LOG_LEVEL_LABELS[level],
        icon: (
          <span aria-hidden="true">
            <LevelBadge level={level} />
          </span>
        ),
      })),
      renderValue: faceValue(
        (value) => (isLevel(value) ? <LevelBadge level={value} /> : value),
        'any level',
      ),
    },
    {
      id: 'source',
      label: 'Process',
      icon: <CpuIcon aria-hidden="true" />,
      type: 'select',
      className: FACE_MENU,
      options: SOURCES.map((source) => ({
        value: source,
        label: APP_LOG_SOURCE_LABELS[source],
        icon: <SourceTag source={source} />,
      })),
      renderValue: faceValue(
        (value) => (isSource(value) ? <SourceTag source={value} /> : value),
        'any process',
      ),
    },
    {
      id: 'scope',
      label: 'Scope',
      icon: <TagIcon aria-hidden="true" />,
      type: 'select',
      searchable: true,
      className: FACE_MENU,
      options: scopes.map((scope) => ({
        value: scope,
        label: scope,
        icon: (
          <span aria-hidden="true" className="font-mono text-xs">
            {scope}
          </span>
        ),
      })),
      renderValue: faceValue(
        (value) => <span className="truncate font-mono text-xs">{value}</span>,
        'any scope',
      ),
    },
    {
      id: 'message',
      label: 'Message',
      icon: <TextIcon aria-hidden="true" />,
      type: 'text',
      placeholder: 'failed',
      operators: [
        { value: 'contains', label: 'contains' },
        { value: 'not_contains', label: 'excludes' },
        { value: 'starts_with', label: 'starts with' },
      ],
    },
  ]
}
