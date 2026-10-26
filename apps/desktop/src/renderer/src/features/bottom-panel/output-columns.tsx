// Cell templates read state through builder calls on a stable row/column,
// which React Compiler cannot see.
'use no memo'

import { EyeOffIcon, FilterIcon } from 'lucide-react'
import { type DataGridFeatures } from '@/components/reui/data-grid/data-grid'
import { DataGridColumnHeader } from '@/components/reui/data-grid/data-grid-column-header'
import { type ColumnDef } from '@tanstack/react-table'

import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from '@/components/ui/context-menu'
import { Skeleton } from '@/components/ui/skeleton'
import { cn } from '@/lib/cn'
import {
  ACTIVITY_LEVEL_LABELS,
  channelLabel,
  clockTime,
  entryText,
  fullTime,
  type ActivityChannel,
  type ActivityEntry,
} from '@/state/activity'

import { ChannelTag } from './channel-mark'
import { LogDetail } from './log-detail'
import { LEVEL_RANK, LevelBadge } from './log-table'

/**
 * The Output grid's columns, after the audit log's in ReUI's
 * `solution-dev-ops-2` (the chevron is the log table's): time, channel,
 * level, message, vault. A channel's context menu filters by it.
 */

export type ChannelFilterMode = 'only' | 'hide'

/** The channel's context menu narrows to it or hides it. A plain click is
 *  the row's, and opens the line. */
function ChannelCell({
  channel,
  onFilter,
}: {
  channel: ActivityChannel
  onFilter: (channel: ActivityChannel, mode: ChannelFilterMode) => void
}) {
  const label = channelLabel(channel)
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <span className="flex min-w-0">
          <ChannelTag channel={channel} />
        </span>
      </ContextMenuTrigger>
      <ContextMenuContent className="w-48">
        <ContextMenuItem onSelect={() => onFilter(channel, 'only')}>
          <FilterIcon aria-hidden />
          Only {label}
        </ContextMenuItem>
        <ContextMenuItem onSelect={() => onFilter(channel, 'hide')}>
          <EyeOffIcon aria-hidden />
          Hide {label}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )
}

/** What an opened Output line shows. A module function, so it is stable. */
export function outputDetail(entry: ActivityEntry) {
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
        { label: 'Channel', value: <ChannelTag channel={entry.channel} /> },
        { label: 'Level', value: ACTIVITY_LEVEL_LABELS[entry.level] },
        {
          label: 'Vault',
          value:
            entry.remote === undefined ? (
              <span className="text-muted-foreground">None</span>
            ) : (
              <span className="font-mono text-xs">{entry.remote}</span>
            ),
        },
      ]}
      detail={entry.detail}
      raw={entry}
      copyText={entryText(entry)}
    />
  )
}

export function createOutputColumns({
  onChannelFilter,
}: {
  onChannelFilter: (channel: ActivityChannel, mode: ChannelFilterMode) => void
}): ColumnDef<DataGridFeatures, ActivityEntry>[] {
  return [
    {
      id: 'time',
      // The id is the log's own order: two lines in one second keep theirs.
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
      id: 'channel',
      accessorFn: (entry) => channelLabel(entry.channel),
      header: ({ column }) => <DataGridColumnHeader column={column} />,
      cell: ({ row }) => <ChannelCell channel={row.original.channel} onFilter={onChannelFilter} />,
      size: 112,
      meta: {
        headerTitle: 'Channel',
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
      // The fixed layout hands any spare width out by these sizes, so the
      // message keeps a modest base and the table fills a wide panel.
      size: 400,
      enableSorting: false,
      meta: {
        headerTitle: 'Message',
        skeleton: <Skeleton className="h-4 w-64" />,
      },
    },
    {
      id: 'vault',
      accessorFn: (entry) => entry.remote ?? '',
      header: ({ column }) => <DataGridColumnHeader column={column} />,
      cell: ({ row }) =>
        row.original.remote === undefined ? (
          <span className="text-muted-foreground text-sm">None</span>
        ) : (
          <span className="text-muted-foreground block truncate font-mono text-xs">
            {row.original.remote}
          </span>
        ),
      size: 200,
      meta: {
        headerTitle: 'Vault',
        skeleton: <Skeleton className="h-4 w-28" />,
      },
    },
  ]
}
