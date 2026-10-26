import { useEffect, useMemo } from 'react'
import { useAtom, useAtomValue, useSetAtom } from 'jotai'
import { ScrollTextIcon } from 'lucide-react'

import { createFilterQuery } from '@/components/ui/filters/filters-query'
import {
  activityEntriesAtom,
  activityLoadAtom,
  activityQueryAtom,
  activitySearchAtom,
  markActivitySeenAtom,
  shownEntries,
  withChannelRule,
} from '@/state/activity'

import { createOutputColumns, outputDetail } from './output-columns'
import { LogLoadError, LogLoading, LogTable, NoMatchingLines } from './log-table'
import { EmptyState } from '@/composites/empty-state'

/**
 * The bottom panel's Output (docs/features/status-bar.md): what Holi did in
 * the background, in the panel's log grid (`log-table.tsx`). The search and
 * the filters live in the panel header (`output-search.tsx`). Seeing the
 * Output marks its errors seen, so the status bar's dot goes out.
 */
export function PanelOutput({
  visible,
  onRetry,
}: {
  /** On screen: the panel open on Output. */
  visible: boolean
  onRetry: () => void
}) {
  const all = useAtomValue(activityEntriesAtom)
  const load = useAtomValue(activityLoadAtom)
  const [query, setQuery] = useAtom(activityQueryAtom)
  const [search, setSearch] = useAtom(activitySearchAtom)
  const markSeen = useSetAtom(markActivitySeenAtom)

  const entries = useMemo(() => shownEntries(all, query, search), [all, query, search])
  const columns = useMemo(
    () =>
      createOutputColumns({
        onChannelFilter: (channel, mode) => setQuery((q) => withChannelRule(q, channel, mode)),
      }),
    [setQuery],
  )

  useEffect(() => {
    if (visible) markSeen()
  }, [visible, all, markSeen])

  if (load === 'loading' && all.length === 0) {
    return <LogLoading label="Loading the output" />
  }

  if (load === 'error' && all.length === 0) {
    return (
      <LogLoadError
        title="Could not load the output"
        description="Holi did not answer with its background log."
        onRetry={onRetry}
      />
    )
  }

  if (all.length === 0) {
    return (
      <EmptyState
        icon={ScrollTextIcon}
        title="Nothing has happened in the background yet"
        description="Commits, pulls, pushes and sync changes appear here as Holi makes them. Edit a document and its autosave lands in a few seconds."
      />
    )
  }

  return (
    <LogTable
      entries={entries}
      columns={columns}
      renderDetail={outputDetail}
      emptyMessage={
        <NoMatchingLines
          onClear={() => {
            setQuery(createFilterQuery())
            setSearch('')
          }}
        />
      }
    />
  )
}
