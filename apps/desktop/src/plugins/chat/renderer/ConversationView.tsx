/**
 * A background run's conversation (a Holi's, an automation's), drawn with
 * the chat's own steps, diffs and cards, read only: it is read from Claude
 * Code's transcript (`chats.conversation`) and read again every few seconds
 * while the run works. Nothing here answers its prompts; a prompt it waits on
 * is said, not offered. The agent's session view draws it through the slot.
 */
import { useAtomValue } from "jotai"
import { useEffect, useState } from "react"

import { Button } from "@/components/ui/button"
import { activeRemoteAtom } from "@/plugin-api"
import type { TranscriptItem } from "../shared/chat"
import { chatCap } from "./state/chats"
import { Transcript, TranscriptSkeleton } from "./Transcript"

/** How often a working run's transcript is read again. */
const POLL_MS = 2_000

type Loaded =
  | { status: "loading" }
  | { status: "ready"; items: TranscriptItem[] }
  | { status: "missing" }
  | { status: "error"; message: string }

export function ConversationView({
  conversationId,
  live,
  title,
}: {
  conversationId: string
  live: boolean
  title: string
}) {
  const remote = useAtomValue(activeRemoteAtom)
  const [loaded, setLoaded] = useState<Loaded>({ status: "loading" })
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    if (remote === null) return
    let stopped = false
    let timer: ReturnType<typeof setTimeout> | null = null
    const read = () => {
      chatCap
        .conversation(remote, { conversationId, live })
        .then((items) => {
          if (stopped) return
          setLoaded(
            items === null ? { status: "missing" } : { status: "ready", items }
          )
        })
        .catch((err: unknown) => {
          if (stopped) return
          setLoaded({
            status: "error",
            message: err instanceof Error ? err.message : String(err),
          })
        })
        .finally(() => {
          if (!stopped && live) timer = setTimeout(read, POLL_MS)
        })
    }
    read()
    return () => {
      stopped = true
      if (timer !== null) clearTimeout(timer)
    }
  }, [remote, conversationId, live, attempt])

  if (loaded.status === "loading") {
    return (
      <div className="flex-1">
        <TranscriptSkeleton />
      </div>
    )
  }
  if (loaded.status === "error" || loaded.status === "missing") {
    return (
      <div
        role="alert"
        className="text-muted-foreground flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center text-sm"
      >
        {loaded.status === "missing"
          ? "Claude Code has not written this conversation down yet."
          : `Couldn’t read this conversation: ${loaded.message}`}
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() => {
            setLoaded({ status: "loading" })
            setAttempt((n) => n + 1)
          }}
        >
          Retry
        </Button>
      </div>
    )
  }
  return (
    <Transcript
      chatId={`bg:${conversationId}`}
      title={title}
      items={loaded.items}
      readOnly
    />
  )
}
