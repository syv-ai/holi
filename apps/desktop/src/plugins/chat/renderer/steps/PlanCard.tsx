/**
 * The plan Claude Code proposes from plan mode (ExitPlanMode), as a card of
 * markdown. Its approval is Claude Code's own `can_use_tool` prompt: Approve
 * allows the call (and, when Claude Code offers the switch, accepts edits
 * from there on); Keep planning denies it, with an optional note that goes
 * back to Claude Code as the reason. Nothing here decides for Claude Code.
 */
import { useSetAtom } from "jotai"
import { useState } from "react"

import { Badge } from "@/components/reui/badge"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardAction,
  CardContent,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Textarea } from "@/components/ui/textarea"
import type { TranscriptItem } from "../../shared/chat"
import { Markdown } from "../Markdown"
import { answerChatAtom } from "../state/chats"

type PlanItem = Extract<TranscriptItem, { kind: "plan" }>

const STATUS: Record<
  PlanItem["status"],
  { text: string; variant: "warning-light" | "success-light" | "secondary" }
> = {
  pending: { text: "Waiting for you", variant: "warning-light" },
  approved: { text: "Approved", variant: "success-light" },
  rejected: { text: "Kept planning", variant: "secondary" },
  proposed: { text: "Proposed", variant: "secondary" },
}

export function PlanCard({ chatId, item }: { chatId: string; item: PlanItem }) {
  const answer = useSetAtom(answerChatAtom)
  const [noting, setNoting] = useState(false)
  const [note, setNote] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const pending = item.status === "pending" && item.requestId !== undefined
  const status = STATUS[item.status]

  const send = (
    a:
      | { kind: "allow"; mode?: "acceptEdits" }
      | { kind: "deny"; message?: string }
  ) => {
    if (item.requestId === undefined) return
    setBusy(true)
    setError(null)
    void answer({ id: chatId, requestId: item.requestId, answer: a })
      .then((res) => {
        if (!res.ok) setError(res.message)
      })
      .finally(() => setBusy(false))
  }

  return (
    <Card size="sm" data-plan={item.id} aria-label="Plan">
      <CardHeader className="border-b">
        <CardTitle>Plan</CardTitle>
        <CardAction>
          <Badge variant={status.variant}>{status.text}</Badge>
        </CardAction>
      </CardHeader>
      <CardContent>
        {item.plan.trim() === "" ? (
          <p className="text-muted-foreground text-sm">No plan text.</p>
        ) : (
          <Markdown text={item.plan} />
        )}
      </CardContent>
      {pending ? (
        <CardFooter className="flex-col items-stretch gap-2 border-t">
          {noting ? (
            <div className="flex flex-col gap-2">
              <Textarea
                autoFocus
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder="What should change? (optional)"
                aria-label="A note for Claude Code"
                className="min-h-16 text-sm"
              />
              <div className="flex flex-wrap items-center gap-1.5">
                <Button
                  type="button"
                  size="xs"
                  disabled={busy}
                  onClick={() =>
                    send({
                      kind: "deny",
                      ...(note.trim() === "" ? {} : { message: note.trim() }),
                    })
                  }
                >
                  Keep planning
                </Button>
                <Button
                  type="button"
                  size="xs"
                  variant="ghost"
                  disabled={busy}
                  onClick={() => setNoting(false)}
                >
                  Cancel
                </Button>
              </div>
            </div>
          ) : (
            <div className="flex flex-wrap items-center gap-1.5">
              <Button
                type="button"
                size="xs"
                disabled={busy}
                onClick={() => send({ kind: "allow" })}
              >
                Approve
              </Button>
              {item.canAcceptEdits === true ? (
                <Button
                  type="button"
                  size="xs"
                  variant="outline"
                  disabled={busy}
                  onClick={() => send({ kind: "allow", mode: "acceptEdits" })}
                >
                  Approve and accept edits
                </Button>
              ) : null}
              <Button
                type="button"
                size="xs"
                variant="outline"
                disabled={busy}
                onClick={() => setNoting(true)}
              >
                Keep planning
              </Button>
            </div>
          )}
          {error !== null ? (
            <p role="alert" className="text-destructive text-xs">
              {error}
            </p>
          ) : null}
        </CardFooter>
      ) : null}
    </Card>
  )
}
