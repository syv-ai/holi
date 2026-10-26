// Reads the TanStack table instance directly, which React Compiler cannot see.
'use no memo'

import { useCallback, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { ChevronRightIcon, SearchXIcon } from 'lucide-react'

import {
  DataGrid,
  dataGridFeatures,
  type DataGridFeatures,
} from '@/components/reui/data-grid/data-grid'
import {
  DataGridTableVirtual,
  type DataGridTableVirtualizerOptions,
} from '@/components/reui/data-grid/data-grid-table-virtual'
import {
  useTable,
  type ColumnDef,
  type ExpandedState,
  type Row,
  type SortingState,
} from '@tanstack/react-table'
import { Badge } from '@/components/reui/badge'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { cn } from '@/lib/cn'
import { EmptyState, ErrorState } from '@/composites/empty-state'

/**
 * The bottom panel's log grid, shared by the Output and the Logs tab
 * (docs/features/status-bar.md): the events grid of ReUI's
 * `solution-dev-ops-2`, dense and virtualised, newest first, with the
 * expandable rows of its `c-data-grid-8`. A row opens under itself; a click
 * anywhere on it does the same as its chevron.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

const LEVEL_LOOK: Record<
  LogLevel,
  {
    label: string
    variant: 'invert-light' | 'info-light' | 'warning-light' | 'destructive-light'
  }
> = {
  debug: { label: 'Debug', variant: 'invert-light' },
  info: { label: 'Info', variant: 'info-light' },
  warn: { label: 'Warning', variant: 'warning-light' },
  error: { label: 'Error', variant: 'destructive-light' },
}

/** A line's level, for a cell, a filter value or a picker row. */
export function LevelBadge({ level }: { level: LogLevel }) {
  const look = LEVEL_LOOK[level]
  return <Badge variant={look.variant}>{look.label}</Badge>
}

/** A level for sorting: the worse, the higher. */
export const LEVEL_RANK: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
}

/** The first read, in the grid's own shape. */
export function LogLoading({ label }: { label: string }) {
  return (
    <div role="status" aria-label={label} className="flex min-h-0 flex-1 flex-col gap-2 px-3 py-2">
      {[0, 1, 2, 3].map((i) => (
        <div key={i} className="flex items-center gap-2">
          <Skeleton className="h-4 w-16" />
          <Skeleton className="h-4 w-20" />
          <Skeleton className="h-4 flex-1" />
        </div>
      ))}
    </div>
  )
}

/** The first read failed: say so, and offer it again. */
export function LogLoadError({
  title,
  description,
  onRetry,
}: {
  title: string
  description: string
  onRetry: () => void
}) {
  return <ErrorState title={title} message={description} onRetry={onRetry} />
}

/** A search or filters that leave nothing. */
export function NoMatchingLines({ onClear }: { onClear: () => void }) {
  return (
    <EmptyState
      icon={SearchXIcon}
      title="No matching lines"
      description="Nothing in the log matches this search and these filters."
      action={{ label: 'Clear filters', onClick: onClear }}
      className="h-auto"
    />
  )
}

/** What every log line has: a stable, increasing id and its first line. */
export type LogLine = { id: number; message: string }

/** A dense row as drawn: the level badge and the cell padding, plus the
 *  row's hairline. */
const ROW_PX = 33

/** An opened line before its panel has measured itself. */
const DETAIL_GUESS_PX = 280

/** Measures the opened panel for the virtualizer, which measures only the
 *  rows themselves and would otherwise lose this one's height. */
function DetailFrame({
  id,
  onHeight,
  children,
}: {
  id: number
  onHeight: (id: number, height: number) => void
  children: ReactNode
}) {
  const ref = useRef<HTMLDivElement | null>(null)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const report = () => onHeight(id, el.offsetHeight)
    report()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(report)
    observer.observe(el)
    return () => observer.disconnect()
  }, [id, onHeight])
  return (
    <div ref={ref} data-log-detail={id}>
      {children}
    </div>
  )
}

export function LogTable<T extends LogLine>({
  entries,
  columns,
  renderDetail,
  emptyMessage,
}: {
  entries: readonly T[]
  /** The columns after the chevron. One must be `time`, which sorts by id. */
  columns: ColumnDef<DataGridFeatures, T>[]
  /** What an opened line shows. Stable across renders (a module function),
   *  or every row's cells rebuild. */
  renderDetail: (entry: T) => ReactNode
  emptyMessage: ReactNode
}) {
  const [sorting, setSorting] = useState<SortingState>([{ id: 'time', desc: true }])
  const [expanded, setExpanded] = useState<ExpandedState>({})
  /** Each opened line's panel height, as it measured itself. */
  const [detailHeights, setDetailHeights] = useState<Readonly<Record<number, number>>>({})

  const onDetailHeight = useCallback((id: number, height: number) => {
    setDetailHeights((was) => (was[id] === height ? was : { ...was, [id]: height }))
  }, [])

  const allColumns = useMemo<ColumnDef<DataGridFeatures, T>[]>(
    () => [
      {
        id: 'expand',
        header: () => <span className="sr-only">Details</span>,
        cell: ({ row }) => (
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-expanded={row.getIsExpanded()}
            aria-label={`${row.getIsExpanded() ? 'Hide' : 'Show'} details: ${row.original.message}`}
            className="text-muted-foreground"
            onClick={(e) => {
              e.stopPropagation()
              row.toggleExpanded()
            }}
          >
            <ChevronRightIcon
              aria-hidden
              className={cn(
                'motion-respond motion-reduce:transition-none',
                row.getIsExpanded() && 'rotate-90',
              )}
            />
          </Button>
        ),
        size: 36,
        enableSorting: false,
        enableHiding: false,
        enableResizing: false,
        meta: {
          expandedContent: (entry: T) => (
            <DetailFrame id={entry.id} onHeight={onDetailHeight}>
              {renderDetail(entry)}
            </DetailFrame>
          ),
          skeleton: <Skeleton className="size-4" />,
        },
      },
      ...columns,
    ],
    [columns, renderDetail, onDetailHeight],
  )

  const table = useTable({
    features: dataGridFeatures,
    data: entries as T[],
    columns: allColumns,
    getRowId: (row) => String(row.id),
    getRowCanExpand: () => true,
    state: { sorting, expanded },
    onSortingChange: setSorting,
    onExpandedChange: setExpanded,
    // Virtualised: the data already is the page.
    manualPagination: true,
  })

  // The virtualizer measures nothing here: a row is ROW_PX, and an opened
  // one adds its panel's measured height. It re-reads sizes only when its
  // item keys' function changes, so a new one comes with every change to
  // what is open or how tall it drew; the keys themselves stay the row ids.
  const virtualizerOptions = useMemo(
    // The type asks for the virtualizer's own defaults (scrollToFn and the
    // observers) as well; useVirtualizer fills those in.
    () =>
      ({
        estimateSize: (_index: number, row: Row<DataGridFeatures, T>) =>
          row.getIsExpanded()
            ? ROW_PX + (detailHeights[row.original.id] ?? DETAIL_GUESS_PX)
            : ROW_PX,
        getItemKey: (_index: number, row: Row<DataGridFeatures, T>) => row.id,
      }) as DataGridTableVirtualizerOptions<T>,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [detailHeights, expanded],
  )

  return (
    <DataGrid
      table={table}
      recordCount={entries.length}
      onRowClick={(entry) => table.getRow(String(entry.id)).toggleExpanded()}
      emptyMessage={emptyMessage}
      tableLayout={{ dense: true, headerSticky: true, headerBackground: false }}
      tableClassNames={{
        bodyRow: '[&:has([aria-expanded=true])]:bg-muted/30',
      }}
    >
      {/* The table is its own scroll container: the scroll area's outer
          wrapper sizes to its content, so it never takes the panel's
          height, and the virtualizer would draw every row. */}
      <div className="min-h-0 flex-1">
        <DataGridTableVirtual
          height="100%"
          estimateSize={ROW_PX}
          virtualizerOptions={virtualizerOptions}
        />
      </div>
    </DataGrid>
  )
}
