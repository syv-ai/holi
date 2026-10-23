/**
 * What a session's last turn changed, under its reply: the files and their
 * lines, and Keep or Revert for the whole turn. Keep takes it out of Ready for
 * review; Revert writes each file back to how it was before the turn, as new
 * commits, the same write the turn review makes per hunk
 * (docs/features/agent-sessions.md, Turn review). A file opens as a tab.
 *
 * After MonoCode's `SessionReview` (MIT, Copyright (c) 2026 Nick; see
 * NOTICE.md), on shadcn's card.
 */
import { useAtomValue, useSetAtom } from "jotai"
import { FileTextIcon, GitCompareIcon } from "lucide-react"
import { useState } from "react"

import { Badge } from "@/components/reui/badge"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardAction,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { openDocumentAtom } from "@/plugin-api"
import { churnAtom, keepTurnAtom, revertTurnAtom } from "./state/review"

/** `+135 −21`, as two light badges. */
function Lines({ added, removed }: { added: number; removed: number }) {
  return (
    <span className="flex shrink-0 items-center gap-1 tabular-nums">
      <Badge variant="success-light">+{added}</Badge>
      <Badge variant="destructive-light">−{removed}</Badge>
    </span>
  )
}

export function ReviewCard({ chatId }: { chatId: string }) {
  const churn = useAtomValue(churnAtom)[chatId]
  const keep = useSetAtom(keepTurnAtom)
  const revert = useSetAtom(revertTurnAtom)
  const open = useSetAtom(openDocumentAtom)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  if (churn === undefined || churn.files.length === 0) return null

  const act = (fn: () => Promise<unknown>) => {
    setBusy(true)
    setError(null)
    void fn()
      .then((res) => {
        if (
          res !== null &&
          typeof res === "object" &&
          "ok" in res &&
          res.ok === false
        ) {
          setError(String((res as unknown as { message: string }).message))
        }
      })
      .catch((err: unknown) =>
        setError(err instanceof Error ? err.message : String(err))
      )
      .finally(() => setBusy(false))
  }

  const count = churn.files.length
  return (
    <Card size="sm" data-review-card={chatId}>
      <CardHeader className="border-b">
        <CardTitle className="flex items-center gap-2">
          <GitCompareIcon
            aria-hidden="true"
            className="text-muted-foreground size-4"
          />
          {count} {count === 1 ? "file" : "files"} changed
          <Lines added={churn.added} removed={churn.removed} />
        </CardTitle>
        <CardAction className="flex gap-1.5">
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() => act(() => revert(chatId))}
          >
            Revert
          </Button>
          <Button
            type="button"
            size="sm"
            disabled={busy}
            onClick={() => act(() => keep(chatId))}
          >
            Keep
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent className="flex flex-col gap-0.5 px-1.5">
        {churn.files.map((f) => (
          <Button
            key={f.path}
            type="button"
            variant="ghost"
            className="w-full justify-start font-normal"
            onClick={() => open(f.path)}
          >
            <FileTextIcon
              aria-hidden="true"
              className="text-muted-foreground"
            />
            <span className="min-w-0 flex-1 truncate text-start">{f.path}</span>
            <Lines added={f.added} removed={f.removed} />
          </Button>
        ))}
        {error !== null ? (
          <p role="alert" className="text-destructive px-2 text-xs">
            {error}
          </p>
        ) : null}
      </CardContent>
    </Card>
  )
}
