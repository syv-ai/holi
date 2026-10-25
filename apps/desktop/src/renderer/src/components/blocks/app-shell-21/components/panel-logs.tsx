import { useMemo } from "react"
import { useAtom, useAtomValue } from "jotai"
import { TerminalSquareIcon } from "lucide-react"

import { createFilterQuery } from "@/components/reui/filters/filters-query"
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty"
import {
  appLogEntriesAtom,
  appLogLoadAtom,
  appLogQueryAtom,
  appLogSearchAtom,
  shownAppLog,
} from "@/state/app-logs"

import { LogSearch } from "./log-search"
import {
  LogLoadError,
  LogLoading,
  LogTable,
  NoMatchingLines,
} from "./log-table"
import { LOGS_COLUMNS, logsDetail, logsFilterFields } from "./logs-columns"

/**
 * The bottom panel's Logs (docs/features/status-bar.md): everything Holi
 * prints, main's console and the window's, streamed raw into the same log
 * grid as the Output.
 */
export function PanelLogs({ onRetry }: { onRetry: () => void }) {
  const all = useAtomValue(appLogEntriesAtom)
  const load = useAtomValue(appLogLoadAtom)
  const [query, setQuery] = useAtom(appLogQueryAtom)
  const [search, setSearch] = useAtom(appLogSearchAtom)
  const entries = useMemo(
    () => shownAppLog(all, query, search),
    [all, query, search]
  )

  if (load === "loading" && all.length === 0) {
    return <LogLoading label="Loading the logs" />
  }

  if (load === "error" && all.length === 0) {
    return (
      <LogLoadError
        title="Could not load the logs"
        description="Holi did not answer with its application log."
        onRetry={onRetry}
      />
    )
  }

  if (all.length === 0) {
    return (
      <Empty className="min-h-0 flex-1 gap-3 p-4">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <TerminalSquareIcon aria-hidden />
          </EmptyMedia>
          <EmptyTitle className="text-sm">Nothing printed yet</EmptyTitle>
          <EmptyDescription className="text-xs">
            Every line main and the window print to their consoles streams here
            as it is written.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    )
  }

  return (
    <LogTable
      entries={entries}
      columns={LOGS_COLUMNS}
      renderDetail={logsDetail}
      emptyMessage={
        <NoMatchingLines
          onClear={() => {
            setQuery(createFilterQuery())
            setSearch("")
          }}
        />
      }
    />
  )
}

/** The Logs tab's search: the scopes the log has seen become Scope's options. */
export function LogsSearch() {
  const entries = useAtomValue(appLogEntriesAtom)
  const scopes = useMemo(
    () =>
      [
        ...new Set(
          entries.flatMap((e) => (e.scope === undefined ? [] : [e.scope]))
        ),
      ].sort(),
    [entries]
  )
  const fields = useMemo(() => logsFilterFields(scopes), [scopes])
  return (
    <LogSearch
      searchAtom={appLogSearchAtom}
      queryAtom={appLogQueryAtom}
      fields={fields}
      placeholder="Search logs…"
      label="Search the logs"
    />
  )
}
