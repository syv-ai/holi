/**
 * One session as a chat (docs/features/agent-sessions.md, The chat): what was
 * said, what the agent did, what it asks, and a composer. Read from Claude
 * Code's transcript; written through the session's terminal, which is not
 * shown unless asked for. The rows, the approval card and the composer follow
 * Fisher UI's agent components (jakobfisker.dk/en/ui), on Holi's primitives.
 */
import { useAtom, useSetAtom } from 'jotai'
import {
  Bot,
  ChevronDown,
  CircleAlert,
  FileText,
  ImageIcon,
  Globe,
  MessagesSquare,
  PencilLine,
  Search,
  SquareTerminal,
  Wrench,
  type LucideIcon,
} from 'lucide-react'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Button, Icon, IconButton } from '@/primitives'
import { cn, vaultAssetUrl } from '@/plugin-api'
import { SessionTerminal } from '../SessionTerminal'
import {
  archiveSessionAtom,
  ensureTerminalAtom,
  pressAtom,
  sayAtom,
  uploadAtom,
} from '../../../agent/renderer/state/send'
import {
  chatAttachmentsAtom,
  chatDraftsAtom,
  type AgentSession,
} from '../../../agent/renderer/state/sessions'
import { ChatMarkdown } from './ChatMarkdown'
import {
  MAX_ATTACHMENTS,
  insertMarker,
  markerFor,
  pastedFiles,
  splitUserText,
  uploadVaultPath,
  stillAttached,
  toBase64,
  uploadName,
  withPaths,
  type Attachment,
} from '../../../agent/renderer/chat/attachments'
import { Composer } from './Composer'
import { QuickAsk } from './QuickAsk'
import { askFailed } from '../../../agent/renderer/lib/ask'
import type { RichInputHandle } from './RichInput'
import {
  useQuestions,
  useTranscript,
  type ChatItem,
} from '../../../agent/renderer/chat/use-transcript'

/** Fisher UI's ease-out, for a row opening. */
const EASE_OUT = [0.16, 1, 0.3, 1] as const
const ESCAPE = '\x1b'

/** How a tool call reads as one row: what it did, and with what glyph. */
const TOOLS: Readonly<Record<string, { label: string; icon: LucideIcon }>> = {
  Read: { label: 'Read', icon: FileText },
  Edit: { label: 'Edited', icon: PencilLine },
  Write: { label: 'Wrote', icon: PencilLine },
  NotebookEdit: { label: 'Edited', icon: PencilLine },
  Bash: { label: 'Ran', icon: SquareTerminal },
  Grep: { label: 'Searched', icon: Search },
  Glob: { label: 'Searched', icon: Search },
  WebFetch: { label: 'Fetched', icon: Globe },
  WebSearch: { label: 'Searched the web', icon: Globe },
  Agent: { label: 'Delegated', icon: Bot },
  Task: { label: 'Delegated', icon: Bot },
}

type Tool = Extract<ChatItem, { kind: 'tool' }>

function ToolRow({ item }: { item: Tool }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const reduce = useReducedMotion() ?? false
  const look = TOOLS[item.name] ?? { label: item.name, icon: Wrench }
  const running = item.result === undefined
  const failed = item.result?.ok === false
  return (
    <div className="text-sm" data-chat-tool={item.name}>
      <Button
        variant="ghost"
        size="sm"
        aria-expanded={open}
        className="h-auto min-h-7 w-full justify-start gap-2.5 rounded-lg px-1.5 py-1 font-normal text-muted-foreground"
        onClick={() => setOpen((o) => !o)}
      >
        <span className="grid size-4 shrink-0 place-items-center">
          {running ? (
            <span className="size-1.5 motion-pulse rounded-full bg-amber-400" />
          ) : (
            <Icon icon={failed ? CircleAlert : look.icon} size="sm" />
          )}
        </span>
        <span className={cn('shrink-0', failed ? 'text-destructive' : 'text-foreground/90')}>
          {look.label}
        </span>
        <span className="min-w-0 truncate font-mono text-xs">{item.summary}</span>
        <Icon
          icon={ChevronDown}
          size="sm"
          className={cn('ml-auto shrink-0 motion-respond', open && 'rotate-180')}
        />
      </Button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            initial={reduce ? { opacity: 0 } : { height: 0, opacity: 0 }}
            animate={reduce ? { opacity: 1 } : { height: 'auto', opacity: 1 }}
            exit={reduce ? { opacity: 0 } : { height: 0, opacity: 0 }}
            transition={{ duration: reduce ? 0 : 0.22, ease: EASE_OUT }}
            className="overflow-hidden"
          >
            <pre className="mt-1 ml-6 max-h-64 overflow-auto rounded-lg border border-border/50 bg-muted/30 px-2.5 py-2 font-mono text-xs whitespace-pre-wrap text-muted-foreground">
              {item.input}
              {item.result !== undefined && item.result.text !== '' && `\n\n${item.result.text}`}
            </pre>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

/**
 * A picture the person attached, drawn from the vault where it was saved
 * (`holi-vault://`), so a screenshot reads as a screenshot. A file that cannot
 * be read back (gone, or not an image after all) falls back to its name.
 */
export function AttachedImage({ path, label }: { path: string; label: string }): React.JSX.Element {
  const [failed, setFailed] = useState(false)
  if (failed) {
    return (
      <span
        data-chat-image=""
        className="flex w-fit items-center gap-1.5 rounded-lg bg-background/60 px-2 py-1 text-xs"
      >
        <Icon icon={ImageIcon} size="sm" />
        <span className="truncate">{label}</span>
      </span>
    )
  }
  return (
    <img
      data-chat-image=""
      src={vaultAssetUrl(path)}
      alt={label}
      draggable={false}
      onError={() => setFailed(true)}
      className="max-h-60 w-auto max-w-full rounded-lg object-contain"
    />
  )
}

/**
 * A person's message, as a bubble. A file it names (`@path`, which is how
 * Claude Code is given one) reads as a chip with the file's name, not as a
 * path, in the place the person put it; one with pictures pasted straight
 * into Claude Code's own input says how many.
 */
function UserBubble({
  text,
  images = 0,
  pending = false,
}: {
  text: string
  /** Pictures that came with it, as the transcript counts them. */
  images?: number
  pending?: boolean
}): React.JSX.Element {
  const parts = splitUserText(text)
  const chip = 'flex w-fit items-center gap-1.5 rounded-lg bg-background/60 px-2 py-1 text-xs'
  return (
    <div
      data-chat-user=""
      className={cn(
        'flex max-w-[85%] flex-col gap-2 self-end rounded-2xl rounded-br-md bg-secondary px-3.5 py-2 text-sm text-secondary-foreground',
        pending && 'opacity-60',
      )}
    >
      {Array.from({ length: images }, (_, i) => (
        <span key={`image-${i}`} data-chat-image="" className={chip}>
          <Icon icon={ImageIcon} size="sm" />
          <span>Image {i + 1}</span>
        </span>
      ))}
      {parts.map((part, i) =>
        part.kind === 'text' ? (
          <span key={i} className="whitespace-pre-wrap">
            {part.text}
          </span>
        ) : part.image && uploadVaultPath(part.path) !== null ? (
          <AttachedImage key={i} path={uploadVaultPath(part.path)!} label={part.label} />
        ) : (
          <span key={i} data-chat-image={part.image ? '' : undefined} className={chip}>
            <Icon icon={part.image ? ImageIcon : FileText} size="sm" />
            <span className="truncate">{part.label}</span>
          </span>
        ),
      )}
    </div>
  )
}

/** How long a finished session gets to come back after "Pick up" before the
 *  chat says it did not. */
const PICK_UP_MS = 20_000

/**
 * What stands in the composer's place for a session that has finished: it can
 * be read, and picking it up starts it again where it left off (Claude Code
 * resumes it when a terminal attaches). Once it is live the chat is the same
 * one, with its composer.
 */
function PickUp({ session }: { session: AgentSession }): React.JSX.Element {
  const ensureTerminal = useSetAtom(ensureTerminalAtom)
  const archive = useSetAtom(archiveSessionAtom)
  const [picking, setPicking] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    if (!picking) return
    const timer = setTimeout(() => {
      setPicking(false)
      setError('It did not come back. Try again, or start a new session.')
    }, PICK_UP_MS)
    return () => clearTimeout(timer)
  }, [picking])
  const pickUp = (): void => {
    setError(null)
    setPicking(true)
    // Picked up, it is a chat in use again, not an archived one.
    void archive({ id: session.id, archived: false })
    void ensureTerminal(session.id).then((t) => {
      if (t !== null) return
      setPicking(false)
      setError('No terminal could be opened on that session.')
    })
  }
  return (
    <div
      data-chat-past=""
      className="flex items-center gap-3 rounded-3xl border border-border/60 bg-card px-4 py-2.5 text-sm shadow-sm"
    >
      <span className="min-w-0 flex-1 truncate text-muted-foreground">
        {error ??
          (session.phase === 'failed' ? 'This session ended badly.' : 'This session is over.')}
      </span>
      <Button size="sm" disabled={picking} onClick={pickUp}>
        {picking ? 'Picking up…' : 'Pick up'}
      </Button>
    </div>
  )
}

export function ChatView({
  session,
  past = false,
  visible,
}: {
  session: AgentSession
  /** It has finished: read-only until it is picked up again. */
  past?: boolean
  /** The page it is on is the one showing. */
  visible: boolean
}): React.JSX.Element {
  const {
    items,
    loaded,
    error: unread,
    refresh,
  } = useTranscript(session.id, session.state !== 'idle')
  const say = useSetAtom(sayAtom)
  const press = useSetAtom(pressAtom)
  const ensureTerminal = useSetAtom(ensureTerminalAtom)
  const [drafts, setDrafts] = useAtom(chatDraftsAtom)
  const draft = drafts[session.id] ?? ''
  const setDraft = (text: string): void => setDrafts((d) => ({ ...d, [session.id]: text }))
  /** Sent, and not in the transcript yet. */
  const [pending, setPending] = useState<string | null>(null)
  const upload = useSetAtom(uploadAtom)
  /** Files chosen for the next message, not yet sent: each is a marker in the
   *  draft. */
  const [allAttachments, setAllAttachments] = useAtom(chatAttachmentsAtom)
  const attachments = allAttachments[session.id] ?? []
  const setAttachments = (next: readonly Attachment[]): void =>
    setAllAttachments((all) => ({ ...all, [session.id]: next }))
  const [uploading, setUploading] = useState(false)
  const input = useRef<RichInputHandle | null>(null)
  const [error, setError] = useState<string | null>(null)
  /** The terminal on this session while it is the one showing, by id. */
  const [terminal, setTerminal] = useState<string | null>(null)

  const scroller = useRef<HTMLDivElement | null>(null)
  /** Whether the list is at its end, and so follows what arrives. */
  const stuck = useRef(true)
  useLayoutEffect(() => {
    const el = scroller.current
    if (el !== null && stuck.current) el.scrollTop = el.scrollHeight
  }, [items, pending, session.state, terminal])

  // The message has landed once the transcript has one more of ours.
  const said = items.filter((i) => i.kind === 'user').length
  useEffect(() => setPending(null), [said])

  const working = session.state === 'working'
  const needsYou = session.state === 'needs-you' && !askFailed(items)
  const questions = useQuestions(session.id, items, needsYou)
  const lastTool = [...items].reverse().find((i): i is Tool => i.kind === 'tool') ?? null
  const asked = lastTool !== null && lastTool.result === undefined ? lastTool : null

  /**
   * Attach files: each gets a marker, put into the draft at the cursor (or at
   * the end, when the box has not the focus), so the words around it are its
   * context. Deleting the marker removes the file.
   */
  const attach = (files: File[]): void => {
    const room = Math.max(0, MAX_ATTACHMENTS - attachments.length)
    setError(files.length > room ? `A message carries at most ${MAX_ATTACHMENTS} files.` : null)
    const field = input.current
    const added: Attachment[] = []
    let text = field?.getText() ?? draft
    for (const file of files.slice(0, room)) {
      const marker = markerFor(
        file,
        [...attachments, ...added].map((a) => a.marker),
        text,
      )
      if (field !== null) {
        field.insertMarker(marker)
        text = field.getText()
      } else {
        text = insertMarker(text, text.length, text.length, marker).text
      }
      added.push({ id: `${marker}:${Math.random()}`, file, marker })
    }
    if (added.length === 0) return
    setAttachments([...attachments, ...added])
    if (field === null) setDraft(text)
  }

  // A paste anywhere on the page is for the chat while it is the page showing
  // and nothing else is taking text. On the document, not the box, so it lands
  // whichever part of the chat has focus. Files and screenshots are attached;
  // text, and a paste into any other field, are left alone (`pastedFiles`).
  const attachRef = useRef(attach)
  attachRef.current = attach
  const failRef = useRef(setError)
  const root = useRef<HTMLDivElement | null>(null)
  const takesPaste = visible && !past && terminal === null && !needsYou
  useEffect(() => {
    if (!takesPaste) return
    const onPaste = (event: ClipboardEvent): void => {
      const target = event.target instanceof Node ? event.target : null
      const inChat = target !== null && root.current?.contains(target) === true
      if (!inChat && target !== document.body) return
      const pasted = pastedFiles(event.clipboardData)
      if (pasted.files.length === 0 && !pasted.unreadable) return
      event.preventDefault()
      if (pasted.files.length > 0) attachRef.current(pasted.files)
      else failRef.current('That image could not be read from the clipboard.')
    }
    document.addEventListener('paste', onPaste)
    return () => document.removeEventListener('paste', onPaste)
  }, [takesPaste])

  const send = (): void => {
    const text = draft.trim()
    if (text === '' || uploading) return
    // Only what the text still names goes: a deleted marker is a removed file.
    const sending = stillAttached(text, attachments)
    setError(null)
    stuck.current = true
    const deliver = async (): Promise<void> => {
      // Each file is written into the vault first: Claude Code takes it by path.
      const paths = new Map<string, string>()
      if (sending.length > 0) setUploading(true)
      try {
        for (const a of sending) {
          const saved = await upload({ name: uploadName(a.file), data: await toBase64(a.file) })
          if (!saved.ok) return setError(saved.message)
          paths.set(a.marker, saved.path)
        }
      } catch (err) {
        return setError(err instanceof Error ? err.message : String(err))
      } finally {
        setUploading(false)
      }
      setDraft('')
      setAttachments([])
      setPending(text)
      const res = await say({ id: session.id, text: withPaths(text, paths) })
      if (res.ok) return refresh()
      // Refused: the message goes back in the box.
      setPending(null)
      setAttachments(sending)
      setDraft(text)
      setError(res.message)
    }
    void deliver()
  }
  const pressKeys = (keys: string): void => {
    void press({ id: session.id, keys }).then((res) => setError(res.ok ? null : res.message))
  }
  const toggleTerminal = (): void => {
    if (terminal !== null) return setTerminal(null)
    void ensureTerminal(session.id).then((t) =>
      t === null
        ? setError('No terminal could be opened on that session.')
        : setTerminal(t.terminalId),
    )
  }

  return (
    <div ref={root} className="relative flex min-h-0 flex-1 flex-col" data-agent-chat={session.id}>
      {/* A finished session has no terminal to show: opening one picks it up. */}
      {!past && (
        <IconButton
          icon={terminal === null ? SquareTerminal : MessagesSquare}
          label={terminal === null ? 'Show the terminal' : 'Back to the chat'}
          size="sm"
          className="absolute top-1 left-2 z-10"
          onClick={toggleTerminal}
        />
      )}
      {terminal !== null ? (
        <div className="flex min-h-0 flex-1 flex-col pt-8">
          <SessionTerminal terminalId={terminal} visible={visible} />
        </div>
      ) : (
        <>
          <div
            ref={scroller}
            className="min-h-0 flex-1 overflow-y-auto px-4 pt-2 pb-3"
            onScroll={(event) => {
              const el = event.currentTarget
              stuck.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
            }}
          >
            <div className="mx-auto flex w-full max-w-2xl flex-col gap-3">
              {unread !== null && (
                <p className="py-10 text-center text-sm text-destructive" data-chat-unread="">
                  The conversation could not be read. {unread}
                </p>
              )}
              {unread === null && loaded && items.length === 0 && pending === null && (
                <p className="py-10 text-center text-sm text-muted-foreground">
                  {past ? 'Nothing was said.' : 'Nothing said yet. Tell it what you want done.'}
                </p>
              )}
              {items.map((item) =>
                item.kind === 'user' ? (
                  <UserBubble key={`u:${item.id}`} text={item.text} images={item.images} />
                ) : item.kind === 'assistant' ? (
                  <ChatMarkdown key={`a:${item.id}`} text={item.text} />
                ) : (
                  <ToolRow key={`t:${item.id}`} item={item} />
                ),
              )}
              {pending !== null && <UserBubble text={pending} pending />}
              {working && (
                <div
                  className="flex items-center gap-1.5 px-1.5 py-1 text-sm text-muted-foreground"
                  data-chat-working=""
                >
                  {[0, 1, 2].map((dot) => (
                    <span key={dot} className="size-1.5 motion-pulse rounded-full bg-amber-400" />
                  ))}
                  <span className="ml-1">Working…</span>
                </div>
              )}
              {needsYou && (
                <QuickAsk
                  waitingFor={session.waitingFor}
                  tool={
                    asked === null
                      ? ''
                      : `${asked.name}${asked.summary === '' ? '' : `: ${asked.summary}`}`
                  }
                  questions={questions}
                  press={(keys) => press({ id: session.id, keys })}
                  fallbackLabel="Answer in the terminal"
                  onFallback={toggleTerminal}
                />
              )}
            </div>
          </div>
          <div className="shrink-0 px-4 pb-3">
            <div className="mx-auto w-full max-w-2xl">
              {error !== null && <p className="px-2 pb-1 text-xs text-destructive">{error}</p>}
              {past ? (
                <PickUp session={session} />
              ) : (
                <Composer
                  value={draft}
                  onChange={setDraft}
                  onSend={send}
                  inputRef={input}
                  markers={attachments.map((a) => a.marker)}
                  attached={stillAttached(draft, attachments).length}
                  onAttach={attach}
                  uploading={uploading}
                  onStop={() => pressKeys(ESCAPE)}
                  working={working}
                  disabled={needsYou}
                  placeholder={
                    needsYou ? 'Answer what it asks above first' : `Message ${session.name}`
                  }
                  {...(session.contextPercent === undefined
                    ? {}
                    : { hint: `${session.contextPercent}% context` })}
                />
              )}
            </div>
          </div>
        </>
      )}
    </div>
  )
}
