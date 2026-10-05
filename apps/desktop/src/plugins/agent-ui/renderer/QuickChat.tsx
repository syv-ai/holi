/**
 * A smaller chat, for a message and nothing else: what a bubble opens when
 * the agents page is not the one showing. It holds a short summary of the
 * agent's last answer and a box; writing and sending sends the message and
 * **closes it**. The face is the way to the full page. Closing it (✕, Escape)
 * sends nothing.
 *
 * It keeps the agent's work out of sight: while a turn runs it says so in one
 * quiet line, and what the agent did is the full chat's to show. What it does
 * draw in full is what needs you: a permission prompt (Allow, Deny) or a
 * question with its options (`QuickAsk`).
 *
 * A screenshot can be pasted or dropped into the box: it waits above it as a
 * small picture (✕ takes it back) and goes with the message, as in the full
 * chat. The card follows Fisher UI's agent components, on Holi's primitives.
 */
import { useAtomValue, useSetAtom } from 'jotai'
import { ArrowUp, X } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Button, Icon, IconButton, Textarea } from '@/primitives'
import { cn } from '@/plugin-api'
import { AgentFace } from './AgentFace'
import {
  MAX_ATTACHMENTS,
  filesOf,
  isImage,
  mention,
  pastedFiles,
  toBase64,
  uploadName,
} from '../../agent/renderer/chat/attachments'
import { QuickAsk } from './chat/QuickAsk'
import { useQuestions, useTranscript } from '../../agent/renderer/chat/use-transcript'
import { askFailed } from '../../agent/renderer/lib/ask'
import { agentIndicator } from '../../agent/renderer/lib/notices'
import { plainPreview } from '../../agent/renderer/lib/preview'
import { quickChatAtom } from '../../agent/renderer/state/notices'
import { openSessionAtom, pressAtom, sayAtom, uploadAtom } from '../../agent/renderer/state/send'
import { agentSessionsAtom } from '../../agent/renderer/state/sessions'

export function QuickChat({ sessionId }: { sessionId: string }): React.JSX.Element | null {
  const session = useAtomValue(agentSessionsAtom).find((s) => s.id === sessionId) ?? null
  const setQuick = useSetAtom(quickChatAtom)
  const openFull = useSetAtom(openSessionAtom)
  const say = useSetAtom(sayAtom)
  const press = useSetAtom(pressAtom)
  const upload = useSetAtom(uploadAtom)
  const { items, loaded } = useTranscript(sessionId, session?.state !== 'idle')
  const questions = useQuestions(
    sessionId,
    items,
    session?.state === 'needs-you' && !askFailed(items),
  )
  const [text, setText] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [sending, setSending] = useState(false)
  const box = useRef<HTMLTextAreaElement | null>(null)
  /** Files pasted or dropped, waiting to go with the message. */
  const [files, setFiles] = useState<File[]>([])
  const [over, setOver] = useState(false)
  // A picture of each, for the strip above the box; let go with the file.
  const previews = useMemo(
    () => files.map((file) => (isImage(file) ? URL.createObjectURL(file) : null)),
    [files],
  )
  useEffect(
    () => () => previews.forEach((url) => url !== null && URL.revokeObjectURL(url)),
    [previews],
  )
  const attach = (added: File[]): void => {
    if (added.length === 0) return
    setError(
      files.length + added.length > MAX_ATTACHMENTS
        ? `A message carries at most ${MAX_ATTACHMENTS} files.`
        : null,
    )
    setFiles((all) => [...all, ...added].slice(0, MAX_ATTACHMENTS))
  }

  useEffect(() => box.current?.focus(), [])
  // The session ended under it: nothing to write to.
  useEffect(() => {
    if (session === null) setQuick(null)
  }, [session, setQuick])
  if (session === null) return null

  const lastAnswer = [...items].reverse().find((i) => i.kind === 'assistant') ?? null
  const lastTool = [...items].reverse().find((i) => i.kind === 'tool') ?? null
  const asked = lastTool !== null && lastTool.result === undefined ? lastTool : null
  const needsYou = session.state === 'needs-you' && !askFailed(items)
  const working = session.state === 'working'
  const indicator = agentIndicator(session)
  const empty = text.trim() === '' && files.length === 0

  const send = (): void => {
    if (empty || sending || needsYou) return
    setSending(true)
    setError(null)
    const deliver = async (): Promise<{ ok: true } | { ok: false; message: string }> => {
      // Each file is written into the vault first: Claude Code takes it by path.
      const paths: string[] = []
      try {
        for (const file of files) {
          const saved = await upload({ name: uploadName(file), data: await toBase64(file) })
          if (!saved.ok) return saved
          paths.push(mention(saved.path))
        }
      } catch (err) {
        return { ok: false, message: err instanceof Error ? err.message : String(err) }
      }
      const words = text.trim()
      return say({ id: sessionId, text: [...paths, words].filter((p) => p !== '').join(' ') })
    }
    void deliver().then((res) => {
      setSending(false)
      // Sent: that was all it was for.
      if (res.ok) return setQuick(null)
      setError(res.message)
    })
  }

  return (
    <section
      data-quick-chat={sessionId}
      aria-label={`Message ${session.name}`}
      className="pointer-events-auto motion-in-right overflow-hidden rounded-2xl border border-border/60 bg-popover text-popover-foreground shadow-popover data-[over]:border-ring"
      data-over={over ? '' : undefined}
      onKeyDown={(event) => {
        if (event.key === 'Escape') setQuick(null)
      }}
      onDragOver={(event) => {
        if (needsYou || !Array.from(event.dataTransfer.types).includes('Files')) return
        event.preventDefault()
        setOver(true)
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(event) => {
        setOver(false)
        if (needsYou) return
        const dropped = filesOf(event.dataTransfer)
        if (dropped.length === 0) return
        event.preventDefault()
        attach(dropped)
      }}
    >
      <header className="flex items-center gap-2.5 p-2.5 pb-1.5">
        {/* The face is the way to the full page. */}
        <Button
          variant="ghost"
          size="sm"
          aria-label={`Open the full chat with ${session.name}`}
          data-quick-chat-face=""
          className="size-10 shrink-0 rounded-full p-0"
          onClick={() => void openFull(sessionId)}
        >
          <AgentFace
            size="md"
            seed={session.id}
            state={session.state}
            waitingFor={session.waitingFor}
            phase={session.phase}
          />
        </Button>
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-sm font-medium text-foreground">{session.name}</span>
          <span className="truncate text-xs text-muted-foreground">{indicator.state}</span>
        </div>
        <IconButton icon={X} label="Close" size="sm" onClick={() => setQuick(null)} />
      </header>

      <div className="px-3.5 pb-2 text-sm" data-quick-chat-answer="">
        {needsYou ? (
          <QuickAsk
            waitingFor={session.waitingFor}
            tool={
              asked === null
                ? ''
                : `${asked.name}${asked.summary === '' ? '' : `: ${asked.summary}`}`
            }
            questions={questions}
            press={(keys) => press({ id: sessionId, keys })}
            fallbackLabel="Open the full chat"
            onFallback={() => void openFull(sessionId)}
          />
        ) : working ? (
          // Quiet on purpose: that it is working, and nothing of how.
          <p
            className="flex items-center gap-1.5 text-xs text-muted-foreground"
            data-quick-chat-working=""
          >
            <span className="size-1.5 motion-pulse rounded-full bg-amber-400" />
            Working…
          </p>
        ) : lastAnswer !== null ? (
          // A summary, not the answer: the full chat has the whole of it.
          <p className="line-clamp-3 text-muted-foreground" data-quick-chat-summary="">
            {plainPreview(lastAnswer.text)}
          </p>
        ) : (
          <p className="text-xs text-muted-foreground">
            {loaded ? 'Nothing said yet.' : 'Reading the conversation…'}
          </p>
        )}
      </div>

      <div className="p-2.5 pt-0">
        {error !== null && <p className="px-2 pb-1 text-xs text-destructive">{error}</p>}
        {files.length > 0 && (
          <ul data-quick-chat-files="" className="flex flex-wrap gap-1.5 px-1.5 pb-1.5">
            {files.map((file, i) => (
              <li key={`${file.name}:${i}`} className="relative">
                {previews[i] !== null ? (
                  <img
                    src={previews[i]!}
                    alt={file.name === '' ? 'Pasted image' : file.name}
                    className="size-14 rounded-lg border border-border/60 object-cover"
                  />
                ) : (
                  <span className="flex h-14 max-w-32 items-center rounded-lg border border-border/60 bg-muted px-2 text-xs">
                    <span className="truncate">{file.name}</span>
                  </span>
                )}
                {/* The disc is the backdrop over a picture; the button is bare. */}
                <span className="absolute -top-1.5 -right-1.5 rounded-full bg-popover shadow-sm">
                  <IconButton
                    icon={X}
                    label={`Remove ${file.name === '' ? 'image' : file.name}`}
                    tooltip={false}
                    size="sm"
                    className="size-5"
                    onClick={() => setFiles((all) => all.filter((_, at) => at !== i))}
                  />
                </span>
              </li>
            ))}
          </ul>
        )}
        <div
          className={cn(
            'flex items-end gap-1.5 rounded-3xl border border-border/60 bg-card p-1.5 pl-3.5 motion-respond focus-within:border-ring/60',
            needsYou && 'opacity-60',
          )}
        >
          <Textarea
            ref={box}
            variant="bare"
            rows={1}
            value={text}
            disabled={needsYou}
            aria-label="Message"
            placeholder={needsYou ? 'Answer what it asks above' : `Message ${session.name}`}
            className="max-h-28 min-h-8 flex-1 overflow-y-auto py-1.5 text-sm leading-5"
            onChange={(event) => setText(event.target.value)}
            onPaste={(event) => {
              // A screenshot, or a copied file: attached, not typed. Text, and
              // the bitmap that rides with copied rich text, stay a paste.
              const pasted = pastedFiles(event.clipboardData)
              if (pasted.files.length > 0) {
                event.preventDefault()
                attach(pasted.files)
              } else if (pasted.unreadable) {
                event.preventDefault()
                setError('That image could not be read from the clipboard.')
              }
            }}
            onKeyDown={(event) => {
              if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return
              event.preventDefault()
              send()
            }}
          />
          <Button
            size="sm"
            aria-label="Send"
            disabled={needsYou || sending || empty}
            className="size-8 shrink-0 rounded-full px-0"
            onClick={send}
          >
            <Icon icon={ArrowUp} />
          </Button>
        </div>
      </div>
    </section>
  )
}
