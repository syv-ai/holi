/**
 * The chat plugin's main view in the Agents mode (its slot,
 * docs/features/chat.md): the composer for a new chat, or one chat's
 * conversation with its permission cards inline, the review card under a
 * finished turn, and a composer to reply.
 *
 * After MonoCode's `SessionPane` (MIT, Copyright (c) 2026 Nick; see
 * NOTICE.md), cut to the mock's simplicity.
 */
import { useAtom, useAtomValue, useSetAtom } from 'jotai'
import { Archive, ListChecks, MessageSquarePlus, Square, SquareTerminal, Sun } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Button, Icon, IconButton } from '@/primitives'
import { activeRemoteAtom, appModeAtom, openSurfaceAtom } from '@/plugin-api'
import type { ChatSummary } from '../shared/chat'
import { Composer, type ComposerChoice } from './Composer'
import { StateLabel } from './parts'
import { ReviewCard } from './ReviewCard'
import {
  chatCap,
  chatsAtom,
  chatsLoadedAtom,
  composerPrefsAtom,
  draftsAtom,
  interruptChatAtom,
  loadTranscriptAtom,
  sendChatAtom,
  startChatAtom,
  transcriptsAtom,
  updateChatAtom,
} from './state/chats'
import { churnAtom, refreshChurnAtom } from './state/review'
import { Transcript, TranscriptSkeleton } from './Transcript'

/** The agent's terminal tab: the raw view of a chat, or its sign-in. */
const AGENT_SURFACE = 'agent'

function Bar({
  children,
  end,
}: {
  children: React.ReactNode
  end?: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="flex h-12 shrink-0 items-center gap-2 border-b border-divider pe-3 ps-4 text-sm">
      <div className="flex min-w-0 flex-1 items-center gap-2">{children}</div>
      {end !== undefined && <div className="flex shrink-0 items-center gap-0.5">{end}</div>}
    </div>
  )
}

/** A composer's draft, by key, kept in the store. */
function useDraft(key: string): [string, (v: string) => void] {
  const [drafts, setDrafts] = useAtom(draftsAtom)
  return [drafts[key] ?? '', (v) => setDrafts((d) => ({ ...d, [key]: v }))]
}

const SUGGESTIONS = [
  { icon: Sun, text: 'Brief me on today' },
  { icon: ListChecks, text: 'Turn my meeting notes into tasks' },
] as const

function NewChat(): React.JSX.Element {
  const remote = useAtomValue(activeRemoteAtom)
  const [prefs, setPrefs] = useAtom(composerPrefsAtom)
  const start = useSetAtom(startChatAtom)
  const [draft, setDraft] = useDraft('new')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const vault = remote?.split('/')[1] ?? 'this vault'

  const send = (text = draft) => {
    if (text.trim() === '') return
    setBusy(true)
    setError(null)
    void start({ text }).then((res) => {
      setBusy(false)
      if (res.ok) setDraft('')
      else setError(res.message)
    })
  }

  return (
    <>
      <Bar>
        <Icon icon={MessageSquarePlus} size="sm" className="text-muted-foreground" />
        <span className="font-medium">New chat</span>
      </Bar>
      <div className="grid min-h-0 flex-1 place-items-center overflow-y-auto p-8">
        <div className="flex w-full max-w-2xl flex-col gap-4">
          <h2 className="text-lg font-medium tracking-tight">What should we work on in {vault}?</h2>
          <Composer
            value={draft}
            onChange={setDraft}
            onSend={() => send()}
            busy={busy}
            placeholder="Ask, plan, / for skills, @ for notes…"
            choice={prefs}
            onChoice={setPrefs}
            autoFocus
            error={error}
          />
          <div className="flex flex-wrap gap-1.5">
            {SUGGESTIONS.map((s) => (
              <Button key={s.text} size="xs" variant="secondary" onClick={() => send(s.text)}>
                <Icon icon={s.icon} size="sm" />
                {s.text}
              </Button>
            ))}
          </div>
        </div>
      </div>
    </>
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
      setError(err instanceof Error ? err.message : String(err)),
    )
  }, [id, load, attempt])
  return { items, error, retry: () => setAttempt((n) => n + 1) }
}

function ChatView({ chat }: { chat: ChatSummary }): React.JSX.Element {
  const remote = useAtomValue(activeRemoteAtom)
  const send = useSetAtom(sendChatAtom)
  const interrupt = useSetAtom(interruptChatAtom)
  const update = useSetAtom(updateChatAtom)
  const openSurface = useSetAtom(openSurfaceAtom)
  const setMode = useSetAtom(appModeAtom)
  const refreshChurn = useSetAtom(refreshChurnAtom)
  const churn = useAtomValue(churnAtom)[chat.id]
  const { items, error: loadError, retry } = useChatTranscript(chat.id)
  const [draft, setDraft] = useDraft(chat.id)
  const [error, setError] = useState<string | null>(null)
  const [choice, setChoice] = useState<ComposerChoice>({
    model: chat.model ?? null,
    mode: chat.mode,
  })
  useEffect(() => {
    setChoice({ model: chat.model ?? null, mode: chat.mode })
  }, [chat.id, chat.model, chat.mode])
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
    chat.state === 'idle'
      ? chat.endedAt !== undefined && !chat.reviewed
        ? 'done'
        : 'idle'
      : chat.state

  const reply = () => {
    const text = draft
    setError(null)
    setDraft('')
    void send({ id: chat.id, text, model: choice.model, mode: choice.mode }).then((res) => {
      if (!res.ok) {
        setError(res.message)
        setDraft(text)
      }
    })
  }

  const openTerminal = () => {
    if (remote === null) return
    void chatCap.terminal(remote, { id: chat.id }).then((res) => {
      if (!res.ok) setError(res.message)
      else {
        setMode('documents')
        openSurface(AGENT_SURFACE, res.terminalId)
      }
    })
  }

  return (
    <>
      <Bar
        end={
          <>
            <IconButton
              icon={SquareTerminal}
              label="Open a copy in a terminal"
              size="sm"
              onClick={openTerminal}
            />
            {chat.state === 'working' && (
              <IconButton
                icon={Square}
                label="Stop this turn"
                size="sm"
                onClick={() => void interrupt(chat.id)}
              />
            )}
            <IconButton
              icon={Archive}
              label="Archive"
              size="sm"
              onClick={() => void update({ id: chat.id, archived: !chat.archived })}
            />
          </>
        }
      >
        <span className="truncate font-medium">{chat.title}</span>
        <span className="flex shrink-0 items-center gap-2 text-xs">
          <StateLabel state={state} />
        </span>
      </Bar>
      <div className="flex min-h-0 flex-1 flex-col">
        {loadError !== null ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-2 text-sm text-muted-foreground">
            Could not read this conversation: {loadError}
            <Button size="xs" variant="secondary" onClick={retry}>
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
            items={items}
            footer={
              state === 'done' && churn !== undefined ? <ReviewCard chatId={chat.id} /> : undefined
            }
          />
        )}
        <div className="px-8 pb-5">
          <div className="mx-auto max-w-3xl">
            <Composer
              value={draft}
              onChange={setDraft}
              onSend={reply}
              onStop={() => void interrupt(chat.id)}
              busy={chat.state !== 'idle'}
              placeholder="Reply…"
              choice={choice}
              onChoice={setChoice}
              error={error}
            />
          </div>
        </div>
      </div>
    </>
  )
}

/** The slot's main view: `id` is `new` or a chat's id. */
export function ChatMain({ id }: { id: string }): React.JSX.Element {
  const chats = useAtomValue(chatsAtom)
  const loaded = useAtomValue(chatsLoadedAtom)
  const chat = chats.find((c) => c.id === id)
  return (
    <div className="flex min-h-0 flex-1 flex-col bg-background" data-chat-main={id}>
      {id === 'new' ? (
        <NewChat />
      ) : chat !== undefined ? (
        <ChatView key={chat.id} chat={chat} />
      ) : !loaded ? (
        <div className="flex-1">
          <TranscriptSkeleton />
        </div>
      ) : (
        <NewChat />
      )}
    </div>
  )
}
