import { useState } from "react"
import { HistoryIcon } from "lucide-react"

import { Button } from "@/components/ui/button"

import { HistoryDialog } from "./history-dialog"
import {
  commitAge,
  shortSha,
  useFileAuthors,
  useFileHistory,
} from "./use-file-history"

/**
 * A file header's history, as GitHub puts it above a file: its latest
 * commit (`4a14110 · 2 months ago`) and History, which opens the commits
 * dialog. The same for a document and for code.
 */
export function FileHistoryButton({ path }: { path: string }) {
  const { history, retry } = useFileHistory(path)
  const authors = useFileAuthors(path)
  const [open, setOpen] = useState(false)
  const latest = history.kind === "ready" ? history.commits[0] : undefined

  return (
    <div className="flex shrink-0 items-center gap-2">
      {latest !== undefined ? (
        // The commit line is the first to give way, below a 768px header.
        <span className="text-muted-foreground hidden text-xs whitespace-nowrap tabular-nums @3xl/view-header:inline">
          <span className="font-mono">{shortSha(latest.sha)}</span> ·{" "}
          <time dateTime={latest.date}>{commitAge(latest.date)}</time>
        </span>
      ) : null}
      {/* Its label gives way below a 512px header; the name stays. */}
      <Button
        variant="ghost"
        size="sm"
        aria-label="History"
        onClick={() => setOpen(true)}
      >
        <HistoryIcon data-icon="inline-start" aria-hidden="true" />
        <span className="hidden @lg/view-header:inline">History</span>
      </Button>
      <HistoryDialog
        path={path}
        history={history}
        authors={authors}
        onRetry={retry}
        open={open}
        onOpenChange={setOpen}
      />
    </div>
  )
}
