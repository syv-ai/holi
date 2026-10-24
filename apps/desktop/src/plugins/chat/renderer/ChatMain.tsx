/**
 * The chat plugin's main views in the Agents mode (docs/features/chat.md):
 * the new-session page, which is also the mode's home (its slot's `home`),
 * and one chat's conversation with its permission cards inline, the review
 * card under a finished turn, and the composer pinned under it.
 *
 * The new-session page is MonoCode's `EmptySession`: a centred column, the
 * question over a large composer, on the Holis' arcade board faded in as on
 * the New tab. The conversation is its `SessionPane`, cut to what a chat
 * does. Ported from https://github.com/hardbeat920/monocode, MIT License,
 * Copyright (c) 2026 Nick; see NOTICE.md.
 */
import { useAtom, useAtomValue, useSetAtom } from "jotai"
import { ArchiveIcon, ArchiveRestoreIcon } from "lucide-react"
import { useEffect, useRef, useState } from "react"

import { Badge } from "@/components/reui/badge"
import { Button } from "@/components/ui/button"
import { ViewHeader, ViewHeaderTitle } from "@/composites/ViewHeader"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import {
  ArcadeTakeControl,
  arcadeCastAtom,
  cn,
  gridArcadeAtom,
  HoliArcade,
} from "@/plugin-api"
import type { ChatSummary, TranscriptItem } from "../shared/chat"
import { releaseAttachment, type ComposerFile } from "./attachments"
import type { ConversationContext } from "./context"
import { Composer, useVaultName, type ComposerChoice } from "./Composer"
import { SessionInfo } from "./SessionInfo"
import { ReviewCard } from "./ReviewCard"
import {
  chatsAtom,
  chatsLoadedAtom,
  composerPrefsAtom,
  contextsAtom,
  draftsAtom,
  interruptChatAtom,
  loadTranscriptAtom,
  sendChatAtom,
  startChatAtom,
  transcriptsAtom,
  updateChatAtom,
} from "./state/chats"
import { churnAtom, refreshChurnAtom } from "./state/review"
import { Transcript, TranscriptSkeleton } from "./Transcript"

/** The files waiting in a composer; their thumbnails let go once sent. */
function useFiles(): [
  ComposerFile[],
  (files: ComposerFile[]) => void,
  () => SendFiles,
] {
  const [files, setFiles] = useState<ComposerFile[]>([])
  const take = (): SendFiles => {
    const sent = files.map(({ name, mediaType, data }) => ({
      name,
      mediaType,
      data,
    }))
    return {
      files: sent,
      done: () => {
        files.forEach(releaseAttachment)
        setFiles([])
      },
    }
  }
  return [files, setFiles, take]
}

interface SendFiles {
  files: { name: string; mediaType: string; data: string }[]
  done(): void
}

/** A composer's draft, by key, kept in the store. */
function useDraft(key: string): [string, (v: string) => void] {
  const [drafts, setDrafts] = useAtom(draftsAtom)
  return [drafts[key] ?? "", (v) => setDrafts((d) => ({ ...d, [key]: v }))]
}

/** What a composer's next message is about (an app), by key, kept in the
 *  store so a card's Ask about this app can fill the new-session page's. */
function useContextItems(
  key: string
): [
  readonly ConversationContext[],
  (items: readonly ConversationContext[]) => void,
] {
  const [all, setAll] = useAtom(contextsAtom)
  return [
    all[key] ?? [],
    (items) => setAll((now) => ({ ...now, [key]: items })),
  ]
}

/**
 * The new-session page. Nothing is started until the first message is sent;
 * the message is the session's first turn and its title.
 */
export function NewSession() {
  const [prefs, setPrefs] = useAtom(composerPrefsAtom)
  const start = useSetAtom(startChatAtom)
  const [draft, setDraft] = useDraft("new")
  const [context, setContext] = useContextItems("new")
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [files, setFiles, takeFiles] = useFiles()
  const vault = useVaultName()
  const arcadeOn = useAtomValue(gridArcadeAtom)
  const cast = useAtomValue(arcadeCastAtom)
  /** While someone plays, the board covers the pane and the page steps out;
   *  Escape or Release brings it back, focus on the take-control pill. */
  const [playing, setPlaying] = useState(false)
  /** The pointer is over the board's free ground, not over the column. */
  const [overBoard, setOverBoard] = useState(false)
  const takeControlRef = useRef<HTMLButtonElement>(null)
  const wasPlaying = useRef(false)

  useEffect(() => {
    if (wasPlaying.current && !playing) takeControlRef.current?.focus()
    wasPlaying.current = playing
  }, [playing])

  /** Free ground: the scroller itself, the column's spacers, or the pill's
   *  own row; anything else is the page. */
  function trackBoard(event: React.PointerEvent<HTMLDivElement>) {
    const target = event.target as Element
    const free =
      target === event.currentTarget ||
      target.closest("[data-arcade-free]") !== null
    if (free !== overBoard) setOverBoard(free)
  }

  const send = () => {
    const text = draft
    const outgoing = takeFiles()
    if (text.trim() === "" && outgoing.files.length === 0) return
    setBusy(true)
    setError(null)
    void start({
      text,
      model: prefs.model,
      effort: prefs.effort ?? null,
      mode: prefs.mode,
      files: outgoing.files,
      context,
    }).then((res) => {
      setBusy(false)
      if (res.ok) {
        setDraft("")
        setContext([])
        outgoing.done()
      } else setError(res.message)
    })
  }
  const choice: ComposerChoice = {
    model: prefs.model,
    effort: prefs.effort ?? null,
    mode: prefs.mode,
  }

  return (
    <div
      data-slot="new-session"
      className="@container relative isolate flex min-h-0 flex-1 flex-col"
    >
      {/* The Holis' arcade, as on the New tab: under everything and melting
          into the pane, taking no pointer until someone takes control. The
          first of the fun to go as the pane narrows; machine-local, on by
          default (`gridArcade`). */}
      {arcadeOn ? (
        <HoliArcade
          cast={cast}
          playing={playing}
          onRelease={() => setPlaying(false)}
          className="hidden @3xl:block"
        />
      ) : null}
      <div
        inert={playing}
        aria-hidden={playing || undefined}
        onPointerMove={arcadeOn ? trackBoard : undefined}
        onPointerLeave={() => setOverBoard(false)}
        className={cn(
          "relative z-10 flex min-h-0 flex-1 flex-col overflow-y-auto transition-opacity duration-200 ease-[cubic-bezier(0.22,1,0.36,1)]",
          playing && "opacity-0"
        )}
      >
        {/* MonoCode's column: spacers centre it when there is room, and the
            lower one gives way first, so on a short pane the composer sits
            where it will dock. */}
        <div className="mx-auto flex w-full max-w-3xl flex-1 flex-col px-6 pt-6 pb-6">
          <div
            aria-hidden="true"
            data-arcade-free=""
            className="flex-[1_1_0px]"
          />
          <div data-arcade-keepout="" className="flex flex-col gap-4">
            <h1 className="truncate px-1 text-lg font-medium tracking-tight">
              What should we work on in {vault}?
            </h1>
            <Composer
              value={draft}
              onChange={setDraft}
              onSend={send}
              busy={busy}
              choice={choice}
              onChoice={(next) =>
                setPrefs({
                  model: next.model,
                  effort: next.effort,
                  mode: next.mode,
                })
              }
              autoFocus
              large
              error={error}
              files={files}
              onFiles={setFiles}
              context={context}
              onContext={setContext}
            />
          </div>
          {/* MonoCode's take-control pill, under the column: shown while the
              pointer is on the board's free ground, or on keyboard focus. */}
          {arcadeOn ? (
            <div
              data-arcade-free=""
              className="hidden justify-center pt-4 @3xl:flex"
            >
              <ArcadeTakeControl
                ref={takeControlRef}
                show={overBoard}
                onClick={() => setPlaying(true)}
              />
            </div>
          ) : null}
          <div
            aria-hidden="true"
            data-arcade-free=""
            className="flex-[1_1_1.125rem]"
          />
        </div>
      </div>
    </div>
  )
}

/** A chat's transcript, asked for once, with its loading and error states. */
function useChatTranscript(id: string) {
  const items = useAtomValue(transcriptsAtom)[id]
  const load = useSetAtom(loadTranscriptAtom)
  const [error, setError] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    setError(null)
    void load(id).catch((err: unknown) =>
      setError(err instanceof Error ? err.message : String(err))
    )
  }, [id, load, attempt])
  return { items, error, retry: () => setAttempt((n) => n + 1) }
}

/** The model the chat's last finished turn ran on. */
function lastModel(
  items: readonly TranscriptItem[] | undefined
): string | undefined {
  if (items === undefined) return undefined
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i]!
    if (item.kind === "turn" && item.model !== undefined) return item.model
  }
  return undefined
}

/** Where the chat stands, in words, as a light badge. */
function StateBadge({
  state,
}: {
  state: "needs-you" | "working" | "done" | "idle"
}) {
  if (state === "needs-you")
    return <Badge variant="warning-light">Needs you</Badge>
  if (state === "working") return <Badge variant="info-light">Working…</Badge>
  if (state === "done") return <Badge variant="success-light">Done</Badge>
  return null
}

function ChatView({ chat }: { chat: ChatSummary }) {
  const send = useSetAtom(sendChatAtom)
  const interrupt = useSetAtom(interruptChatAtom)
  const update = useSetAtom(updateChatAtom)
  const refreshChurn = useSetAtom(refreshChurnAtom)
  const churn = useAtomValue(churnAtom)[chat.id]
  const { items, error: loadError, retry } = useChatTranscript(chat.id)
  const [draft, setDraft] = useDraft(chat.id)
  const [context, setContext] = useContextItems(chat.id)
  const [files, setFiles, takeFiles] = useFiles()
  const [error, setError] = useState<string | null>(null)
  const [choice, setChoice] = useState<ComposerChoice>({
    model: chat.model ?? null,
    effort: chat.effort ?? null,
    mode: chat.mode,
  })
  useEffect(() => {
    setChoice({
      model: chat.model ?? null,
      effort: chat.effort ?? null,
      mode: chat.mode,
    })
  }, [chat.id, chat.model, chat.effort, chat.mode])
  useEffect(() => {
    // The turn's record is written once sync resumes after it: read it a
    // moment after the end, and again in case the settle commit was slow.
    if (chat.endedAt === undefined) return
    void refreshChurn()
    const a = setTimeout(() => void refreshChurn(), 1_500)
    const b = setTimeout(() => void refreshChurn(), 5_000)
    return () => {
      clearTimeout(a)
      clearTimeout(b)
    }
  }, [chat.endedAt, refreshChurn])

  const state =
    chat.state === "idle"
      ? chat.endedAt !== undefined && !chat.reviewed
        ? "done"
        : "idle"
      : chat.state

  const reply = () => {
    const text = draft
    const about = context
    const outgoing = takeFiles()
    setError(null)
    setDraft("")
    setContext([])
    void send({
      id: chat.id,
      text,
      model: choice.model,
      effort: choice.effort,
      mode: choice.mode,
      files: outgoing.files,
      context: about,
    }).then((res) => {
      if (!res.ok) {
        setError(res.message)
        setDraft(text)
        setContext(about)
      } else outgoing.done()
    })
  }

  return (
    <>
      {/* The same row as a document's (`ViewHeader`), so a session and a
          document side by side line up. */}
      <ViewHeader>
        <ViewHeaderTitle
          title={chat.title}
          badge={<StateBadge state={state} />}
        />
        <span className="flex shrink-0 items-center gap-0.5">
          {chat.info !== undefined ? <SessionInfo info={chat.info} /> : null}
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label={chat.archived ? "Unarchive" : "Archive"}
                onClick={() =>
                  void update({ id: chat.id, archived: !chat.archived })
                }
              >
                {chat.archived ? (
                  <ArchiveRestoreIcon aria-hidden="true" />
                ) : (
                  <ArchiveIcon aria-hidden="true" />
                )}
              </Button>
            </TooltipTrigger>
            <TooltipContent>
              {chat.archived ? "Unarchive" : "Archive"}
            </TooltipContent>
          </Tooltip>
        </span>
      </ViewHeader>
      <div className="flex min-h-0 flex-1 flex-col">
        {loadError !== null ? (
          <div
            role="alert"
            className="text-muted-foreground flex flex-1 flex-col items-center justify-center gap-3 text-sm"
          >
            Couldn’t read this conversation: {loadError}
            <Button type="button" size="sm" variant="outline" onClick={retry}>
              Retry
            </Button>
          </div>
        ) : items === undefined ? (
          <div className="flex-1">
            <TranscriptSkeleton />
          </div>
        ) : (
          <Transcript
            chatId={chat.id}
            title={chat.title}
            items={items}
            footer={
              state === "done" && churn !== undefined ? (
                <ReviewCard chatId={chat.id} />
              ) : undefined
            }
          />
        )}
        {/* The composer, pinned under the conversation. */}
        <div className="px-6 pb-5">
          <div className="mx-auto w-full max-w-3xl">
            <Composer
              value={draft}
              onChange={setDraft}
              onSend={reply}
              onStop={() => void interrupt(chat.id)}
              busy={chat.state !== "idle"}
              choice={choice}
              onChoice={setChoice}
              ranModel={lastModel(items)}
              autoFocus
              error={error}
              files={files}
              onFiles={setFiles}
              context={context}
              onContext={setContext}
            />
          </div>
        </div>
      </div>
    </>
  )
}

/** The slot's main view: `id` is `new` or a chat's id. */
export function ChatMain({ id }: { id: string }) {
  const chats = useAtomValue(chatsAtom)
  const loaded = useAtomValue(chatsLoadedAtom)
  const chat = chats.find((c) => c.id === id)
  return (
    <div className="flex min-h-0 flex-1 flex-col" data-chat-main={id}>
      {id === "new" ? (
        <NewSession />
      ) : chat !== undefined ? (
        <ChatView key={chat.id} chat={chat} />
      ) : !loaded ? (
        <div className="flex-1">
          <TranscriptSkeleton />
        </div>
      ) : (
        <NewSession />
      )}
    </div>
  )
}

/** The Agents mode's home: the new-session page. */
export function ChatHome() {
  return <ChatMain id="new" />
}
