/**
 * An edit's change, inline under its step: old and new line numbers, a sign,
 * the line; removed lines on the destructive wash, added on the success one,
 * hunks parted by a quiet gap. A new file is all additions. The first lines
 * show; the rest are a click away. The diff itself is the reducer's
 * (`shared/tool-views.ts`), from Claude Code's own hunks where it sent them.
 *
 * After MonoCode's `FilePreview` diff rows (MIT, Copyright (c) 2026 Nick;
 * see NOTICE.md), on Holi's tokens.
 */
import { useState } from "react"

import { Badge } from "@/components/reui/badge"
import { cn } from "@/plugin-api"
import type { DiffLine, FileDiff } from "../../shared/chat"
import { MoreButton, PathLink, PEEK_LINES } from "./parts"

function Row({ line }: { line: DiffLine }) {
  if (line.kind === "gap") {
    return (
      <div
        aria-hidden="true"
        className="text-muted-foreground bg-muted/40 col-span-4 px-2 text-center leading-5 select-none"
      >
        ⋯
      </div>
    )
  }
  const sign = line.kind === "add" ? "+" : line.kind === "del" ? "−" : " "
  const wash =
    line.kind === "add"
      ? "bg-success/10"
      : line.kind === "del"
        ? "bg-destructive/10"
        : ""
  const ink =
    line.kind === "add"
      ? "text-success-foreground dark:text-success"
      : line.kind === "del"
        ? "text-destructive"
        : "text-muted-foreground/60"
  return (
    <div
      className={cn("col-span-4 grid grid-cols-subgrid", wash)}
      data-diff-line={line.kind}
    >
      <span className="text-muted-foreground/70 px-1.5 text-end tabular-nums select-none">
        {line.old ?? ""}
      </span>
      <span className="text-muted-foreground/70 px-1.5 text-end tabular-nums select-none">
        {line.new ?? ""}
      </span>
      <span aria-hidden="true" className={cn("select-none", ink)}>
        {sign}
      </span>
      <span className="text-foreground/90 pe-3 break-all whitespace-pre-wrap">
        <span className="sr-only">
          {line.kind === "add"
            ? "Added: "
            : line.kind === "del"
              ? "Removed: "
              : ""}
        </span>
        {line.text === "" ? " " : line.text}
      </span>
    </div>
  )
}

/** One file's diff: its path, its count, its lines. */
export function FileDiffView({
  diff,
  showPath = false,
}: {
  diff: FileDiff
  showPath?: boolean
}) {
  const [all, setAll] = useState(false)
  const shown = all ? diff.lines : diff.lines.slice(0, PEEK_LINES)
  const hidden = diff.lines.length - shown.length
  return (
    <div className="flex min-w-0 flex-col gap-1" data-diff={diff.path}>
      <div className="flex min-w-0 items-center gap-1.5">
        {showPath ? <PathLink path={diff.path} /> : null}
        {diff.created ? <Badge variant="info-light">New file</Badge> : null}
        <span className="flex shrink-0 items-center gap-1 tabular-nums">
          <Badge variant="success-light">+{diff.added}</Badge>
          <Badge variant="destructive-light">−{diff.removed}</Badge>
        </span>
      </div>
      <div
        role="group"
        aria-label={`Changes to ${diff.path}`}
        className="bg-muted/30 grid min-w-0 grid-cols-[auto_auto_1ch_1fr] overflow-hidden rounded-md py-1 font-mono text-xs leading-5"
      >
        {shown.map((line, i) => (
          <Row key={i} line={line} />
        ))}
      </div>
      {hidden > 0 || all ? (
        <MoreButton
          open={all}
          total={diff.lines.length}
          onToggle={() => setAll((v) => !v)}
        />
      ) : null}
      {all && diff.omitted !== undefined ? (
        <p className="text-muted-foreground text-xs">
          {diff.omitted.toLocaleString()} more lines were not kept; open the
          file to read them.
        </p>
      ) : null}
    </div>
  )
}

export function DiffBody({ files }: { files: FileDiff[] }) {
  return (
    <div className="flex min-w-0 flex-col gap-3">
      {files.map((f) => (
        <FileDiffView key={f.path} diff={f} showPath={files.length > 1} />
      ))}
    </div>
  )
}
