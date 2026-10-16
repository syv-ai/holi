/**
 * One session as a chat (docs/features/agent-sessions.md, The chat): what was
 * said, what the agent did, what it asks, and a composer. Read from Claude
 * Code's transcript; written through the session's terminal, which is not
 * shown unless asked for. The rows (`rows/`) draw each kind of item; this
 * keeps the list: a window of the latest items, the follow of its end, and
 * the footer that says what could not be placed.
 */
import { useAtom, useSetAtom } from 'jotai'
import { ArrowDown, MessagesSquare, SquareTerminal } from 'lucide-react'
import { useReducedMotion } from 'motion/react'
import { useCallback, useEffect, useLayoutEffect, useReducer, useRef, useState } from 'react'
import { Button, Icon, IconButton } from '@/primitives'
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
import {
  MAX_ATTACHMENTS,
  insertMarker,
  markerFor,
  pastedFiles,
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
import { useQuestions, useTranscript } from '../../../agent/renderer/chat/use-transcript'
import type { ChatItem, ToolItem } from '../../../agent/renderer/chat/items'
import { chatDiagnostics, claudeVersions, unplacedTotal } from './diagnostics'
import { ItemRow } from './rows/ItemRow'
import { copyText } from './rows/parts'
import { useRowErrors } from './rows/RowBoundary'
import { UserBubble } from './rows/UserBubble'

const ESCAPE = '\x1b'
/** Shift+Tab as a terminal sends it (back-tab): Claude Code's mode cycle. */
const SHIFT_TAB = '\x1b[Z'

/** How many items the chat draws at first, and how many more each "Show
 *  earlier" reveals. */
export const INITIAL_ITEMS = 150
export const MORE_ITEMS = 100
/** How near the end counts as at the end, in pixels. */
const NEAR_END = 80
/** The window starts at the first item (every earlier one is shown). */
const FROM_START = '*'

const keyOf = (item: ChatItem): string => `${item.kind}:${item.id}`

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
      className="flex items-center gap-3 rounded-3xl bg-secondary px-4 py-2.5 text-sm"
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
    ctx,
    loaded,
    error: unread,
    refresh,
    drift,
    canLoadEarlier,
    loadingEarlier,
    loadEarlier,
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
  const reduceMotion = useReducedMotion() ?? false

  const scroller = useRef<HTMLDivElement | null>(null)
  const list = useRef<HTMLDivElement | null>(null)
  /** Whether the list is at its end, and so follows what arrives. Only the
   *  person scrolling up lets go of it. */
  const pinned = useRef(true)
  const lastTop = useRef(0)
  const lastHeight = useRef(0)
  /** Content arrived while the person was reading above: "Jump to latest". */
  const [away, setAway] = useState(false)
  const toEnd = useCallback(
    (smooth = false): void => {
      const el = scroller.current
      if (el === null) return
      if (smooth && !reduceMotion && typeof el.scrollTo === 'function') {
        el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
      } else el.scrollTop = el.scrollHeight
    },
    [reduceMotion],
  )

  // The window: the first item drawn, by key, so what arrives at the end adds
  // to the list and nothing slides out of the top of it.
  const first = useRef<string | null>(null)
  const head = useRef<string | null>(null)
  /** Earlier items were asked for: when they arrive, some are revealed. */
  const loadingMore = useRef(false)
  /** The list's size and place before a reveal, to put the view back. */
  const anchor = useRef<{ height: number; top: number; token: string } | null>(null)
  const suppressAway = useRef(false)
  const [, redraw] = useReducer((n: number) => n + 1, 0)

  const headKey = items.length === 0 ? null : keyOf(items[0]!)
  const findStart = (): number =>
    first.current === FROM_START
      ? 0
      : first.current === null
        ? -1
        : items.findIndex((i) => keyOf(i) === first.current)
  let start = findStart()
  if (start < 0) {
    start = Math.max(0, items.length - INITIAL_ITEMS)
    first.current = start > 0 ? keyOf(items[start]!) : null
  }
  if (loadingMore.current && head.current !== null && headKey !== head.current) {
    // Earlier items arrived above the first drawn: reveal a page of them.
    loadingMore.current = false
    start = Math.max(0, start - MORE_ITEMS)
    first.current = start > 0 ? keyOf(items[start]!) : FROM_START
  }
  head.current = headKey
  const token = `${start}|${headKey}`

  const showEarlier = (): void => {
    const el = scroller.current
    if (el !== null) anchor.current = { height: el.scrollHeight, top: el.scrollTop, token }
    pinned.current = false
    suppressAway.current = true
    if (start > 0) {
      const next = Math.max(0, start - MORE_ITEMS)
      first.current = next > 0 ? keyOf(items[next]!) : FROM_START
      redraw()
    } else if (canLoadEarlier && !loadingEarlier) {
      // Everything loaded is shown: ask for more, and reveal it as it comes.
      if (items.length > 0 && (first.current === FROM_START || first.current === null)) {
        first.current = keyOf(items[0]!)
      }
      loadingMore.current = true
      void loadEarlier()
    }
  }

  // The view goes back where it was after earlier items are drawn above it.
  useLayoutEffect(() => {
    const a = anchor.current
    const el = scroller.current
    if (a === null || el === null || a.token === token) return
    anchor.current = null
    el.scrollTop = a.top + (el.scrollHeight - a.height)
  })

  useLayoutEffect(() => {
    if (pinned.current) toEnd()
  }, [items, pending, session.state, terminal, toEnd])

  // Whatever makes the content taller (a row opening, a picture loading, late
  // layout) or the viewport shorter (the composer growing) is seen here,
  // which a scroll handler cannot: at the end the list stays there, above the
  // end it is left alone and says that there is more.
  useEffect(() => {
    const el = scroller.current
    const content = list.current
    if (terminal !== null || el === null || content === null) return
    if (typeof ResizeObserver === 'undefined') return
    lastHeight.current = el.scrollHeight
    const observer = new ResizeObserver(() => {
      const grew = el.scrollHeight > lastHeight.current
      lastHeight.current = el.scrollHeight
      if (pinned.current) toEnd()
      else if (grew && !suppressAway.current) setAway(true)
      suppressAway.current = false
    })
    observer.observe(el)
    observer.observe(content)
    return () => observer.disconnect()
  }, [terminal, toEnd])

  // The message has landed once the transcript has one more of ours.
  const said = items.filter((i) => i.kind === 'user').length
  useEffect(() => setPending(null), [said])

  const working = session.state === 'working'
  const needsYou = session.state === 'needs-you' && !askFailed(items)
  const questions = useQuestions(session.id, items, needsYou)
  const lastTool = [...items].reverse().find((i): i is ToolItem => i.kind === 'tool') ?? null
  const asked = lastTool !== null && lastTool.result === undefined ? lastTool : null

  const rowErrors = useRowErrors(session.id)
  const notPlaced = unplacedTotal(drift) + rowErrors.total

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
    pinned.current = true
    setAway(false)
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

  const shown = start === 0 ? items : items.slice(start)
  const lastIndex = items.length - 1
  const copyDiagnostics = (): void => {
    void copyText(
      chatDiagnostics({
        drift,
        failed: rowErrors,
        versions: claudeVersions(items),
      }),
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
          <div className="relative flex min-h-0 flex-1 flex-col">
            <div
              ref={scroller}
              data-chat-scroll=""
              className="min-h-0 flex-1 overflow-y-auto px-4 pt-2 pb-3"
              // A wheel up lets go at once: the scroll event that follows may
              // be read against a position from before the list last grew.
              onWheel={(event) => {
                if (event.deltaY < 0) pinned.current = false
              }}
              onScroll={(event) => {
                const el = event.currentTarget
                if (el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_END) {
                  pinned.current = true
                  setAway(false)
                } else if (el.scrollTop < lastTop.current) pinned.current = false
                lastTop.current = el.scrollTop
              }}
            >
              <div
                ref={list}
                role="log"
                aria-label="Conversation"
                className="agent-chat-list mx-auto flex w-full max-w-2xl flex-col gap-3"
              >
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
                {(start > 0 || canLoadEarlier) && (
                  <Button
                    variant="ghost"
                    size="xs"
                    data-chat-earlier=""
                    aria-busy={loadingEarlier || undefined}
                    className="self-center font-normal text-muted-foreground"
                    onClick={showEarlier}
                  >
                    {start === 0 && loadingEarlier
                      ? 'Loading earlier…'
                      : start > 0
                        ? `Show earlier (${start})`
                        : 'Load earlier'}
                  </Button>
                )}
                {shown.map((item, i) => (
                  <ItemRow
                    key={keyOf(item)}
                    item={item}
                    ctx={ctx}
                    live={working && start + i === lastIndex}
                  />
                ))}
                {pending !== null && <UserBubble text={pending} pending />}
                {working && (
                  <div
                    className="flex items-center gap-1.5 px-1.5 py-1 text-sm text-muted-foreground"
                    data-chat-working=""
                  >
                    {[0, 1, 2].map((dot) => (
                      <span
                        key={dot}
                        className="size-1.5 motion-pulse rounded-full bg-[var(--context-warm)]"
                      />
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
                {notPlaced > 0 && (
                  <div
                    data-chat-drift=""
                    className="flex flex-wrap items-center gap-x-2 px-1 pt-2 text-xs text-muted-foreground"
                  >
                    <span>
                      {notPlaced === 1
                        ? '1 part of this conversation was not recognised'
                        : `${notPlaced} parts of this conversation were not recognised`}
                    </span>
                    <Button
                      variant="ghost"
                      size="xs"
                      className="font-normal text-muted-foreground"
                      onClick={copyDiagnostics}
                    >
                      Copy diagnostics
                    </Button>
                  </div>
                )}
              </div>
            </div>
            {away && (
              <Button
                variant="secondary"
                size="sm"
                data-chat-jump=""
                className="motion-in-bottom absolute bottom-3 left-1/2 -translate-x-1/2 rounded-full shadow-popover"
                onClick={() => {
                  pinned.current = true
                  setAway(false)
                  toEnd(true)
                }}
              >
                <Icon icon={ArrowDown} size="sm" />
                Jump to latest
              </Button>
            )}
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
                  onCycleMode={() => pressKeys(SHIFT_TAB)}
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
