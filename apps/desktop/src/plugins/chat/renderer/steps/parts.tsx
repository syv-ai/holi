/**
 * The small parts a step's body is drawn with: a mono block that shows its
 * first lines and offers the rest, a path that opens as a tab, and the
 * capped list. After MonoCode's tool rows (`features/sessions/ui/
 * AgentTranscript.tsx`, MIT, Copyright (c) 2026 Nick; see NOTICE.md).
 */
import { useSetAtom } from "jotai"
import { FileTextIcon } from "lucide-react"
import { useState } from "react"

import { Button } from "@/components/ui/button"
import { cn, openDocumentAtom } from "@/plugin-api"

/** Lines a body shows before "Show all". */
export const PEEK_LINES = 12

/** "Show all 40 lines" under a capped body, or "Show less". */
export function MoreButton({
  open,
  total,
  noun = "lines",
  onToggle,
}: {
  open: boolean
  total: number
  noun?: string
  onToggle(): void
}) {
  return (
    <Button
      type="button"
      variant="link"
      size="xs"
      className="text-muted-foreground self-start"
      aria-expanded={open}
      onClick={onToggle}
    >
      {open ? "Show less" : `Show all ${total} ${noun}`}
    </Button>
  )
}

/** Text in a mono block, its first lines shown and the rest a click away. */
export function MonoBlock({
  text,
  tone,
  label,
  max = PEEK_LINES,
  omitted,
}: {
  text: string
  tone?: "error"
  label?: string
  max?: number
  /** Characters Claude Code's output had past what the transcript keeps. */
  omitted?: number
}) {
  const [all, setAll] = useState(false)
  const lines = text.split("\n")
  const capped = !all && lines.length > max
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <pre
        aria-label={label}
        className={cn(
          "bg-muted/60 overflow-x-auto rounded-md px-3 py-2 font-mono text-xs leading-relaxed whitespace-pre-wrap break-words",
          tone === "error" ? "text-destructive" : "text-foreground/85"
        )}
      >
        {capped ? lines.slice(0, max).join("\n") : text}
      </pre>
      {lines.length > max ? (
        <MoreButton
          open={all}
          total={lines.length}
          onToggle={() => setAll((v) => !v)}
        />
      ) : null}
      {all && omitted !== undefined && omitted > 0 ? (
        <p className="text-muted-foreground text-xs">
          {omitted.toLocaleString()} more characters were not kept.
        </p>
      ) : null}
    </div>
  )
}

/** A vault path: opens as a tab. Anything outside the vault is shown, not
 *  opened. */
export function PathLink({
  path,
  line,
  children,
}: {
  path: string
  line?: number
  children?: React.ReactNode
}) {
  const open = useSetAtom(openDocumentAtom)
  const inVault = !path.startsWith("/") && !path.startsWith("~")
  const label = (
    <>
      <FileTextIcon
        aria-hidden="true"
        className="text-muted-foreground size-3.5 shrink-0"
      />
      <span className="min-w-0 truncate font-mono text-xs">{path}</span>
      {line !== undefined ? (
        <span className="text-muted-foreground shrink-0 font-mono text-xs tabular-nums">
          :{line}
        </span>
      ) : null}
      {children}
    </>
  )
  if (!inVault) {
    return (
      <span className="text-muted-foreground flex min-w-0 items-center gap-1.5 px-2 py-0.5">
        {label}
      </span>
    )
  }
  return (
    <Button
      type="button"
      variant="ghost"
      size="xs"
      className="w-full min-w-0 justify-start font-normal"
      onClick={() => open(path)}
    >
      {label}
    </Button>
  )
}
