/**
 * Writing a mail, inside Holi.
 *
 * **The preview is the artifact, not a likeness of it.** `renderMailMarkdown`
 * produces the bytes shown in the preview pane *and* the `text/html` part that
 * is sent; the only difference is the remote-image flag (the preview holds
 * remote images back), so they cannot drift.
 *
 * **Autosave is single-flight and latest-wins.** A second `create` while the
 * first is in flight makes a second draft, and the message forks.
 *
 * **Nothing is ever read-only.** A draft written outside Holi is converted with
 * `turndown` and opens for editing with a notice saying so.
 */
import { useAtomValue } from 'jotai'
import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import type { Ref } from 'react'
import { useGoogleAccount } from './account'
import { Compartment, EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { Skeleton } from '@/components/ui/skeleton'
import { ChipInput } from './chip-input'
import { SandboxedHtml } from './sandboxed-html'
import { activeRemoteAtom, cn, plainMarkdownExtensions } from '@/plugin-api'
import { composeFrom, type ComposeIntent } from './compose-intent'
import { renderMailMarkdown } from './mail-markdown'
import { mailHtmlToMarkdown } from './mail-unmarkdown'
import { sanitizeMailHtml } from './mail-html'
import { describeSendFailure, type SendFailure } from './mail-send-failure'
import type { MailAddress } from './mail-types'
import { googleCap } from './google-cap'

/**
 * Idle time before an autosave. A keystroke-rate debounce turns a paragraph
 * into a dozen `drafts.update` calls against a rate-limited API. Forced saves
 * on blur, close and send are what make the longer wait safe.
 */
const AUTOSAVE_IDLE_MS = 2000

type SaveState = 'pristine' | 'dirty' | 'saving' | 'saved' | 'error'
type FailedOperation = 'load' | 'save' | 'send' | 'discard'

const SAVE_LABEL: Record<SaveState, string> = {
  pristine: '',
  dirty: 'Unsaved changes',
  saving: 'Saving…',
  saved: 'Saved',
  error: 'Not saved',
}

export interface MailComposerHandle {
  /** Flushes the latest edit. False means the composer must remain mounted. */
  prepareToLeave(): Promise<boolean>
}

export interface MailComposerProps {
  ref?: Ref<MailComposerHandle>
  /** Account identity supplied by the mounted Mail surface when available. */
  accountSub?: string
  intent: ComposeIntent
  /** An existing Gmail draft to continue. Absent means this composer will
   *  create one on its first save. */
  draftId?: string
  /** Every address the account may send from, so reply-all excludes all of
   *  them. Empty is survivable: the user is copied on their own reply. */
  sendAs?: string[]
  suggestions?: MailAddress[]
  onSent: (draft: { id: string | null }) => void
  onDiscarded: () => void
  onClose: () => void
  /** Routes to vault settings for a `reconnect` failure. */
  onReconnect?: () => void
  /** Drop the seam and inset the composer draws under a thread: in a dialog
   *  the dialog is already the frame. */
  bare?: boolean
}

const COMPOSE_VIEWS = [
  { value: 'edit', label: 'Edit' },
  { value: 'preview', label: 'Preview' },
] as const satisfies readonly { value: 'edit' | 'preview'; label: string }[]

interface LoadedDraft {
  to: MailAddress[]
  cc: MailAddress[]
  subject: string
  markdown: string
  foreign: boolean
  /** The thread the draft is filed in, if any. See `applyLoaded`. */
  threadId: string | undefined
}

export function MailComposer({
  intent,
  draftId,
  sendAs = [],
  suggestions = [],
  onSent,
  onDiscarded,
  onClose,
  onReconnect,
  bare = false,
  ref,
  accountSub: accountSubProp,
}: MailComposerProps): React.JSX.Element {
  /**
   * The vault whose account this message is written in, fixed at mount: a
   * draft started in one vault is saved and sent there, whatever is open by
   * the time Send is pressed.
   */
  const [remote] = useState(useAtomValue(activeRemoteAtom))
  const { currentSub } = useGoogleAccount()
  const accountSubRef = useRef<string | null>(accountSubProp ?? currentSub)
  if (accountSubRef.current === null && currentSub !== null) accountSubRef.current = currentSub
  const vault = useCallback((): string => {
    if (remote === null) throw new Error('No vault is open.')
    return remote
  }, [remote])
  /**
   * The thread every save and the send rebuild the threading headers from.
   *
   * State rather than derived: `continueDraft` opens every draft as `new`, so a
   * continued reply learns its thread only in `applyLoaded`.
   */
  const [threadId, setThreadId] = useState<string | undefined>(
    intent.kind === 'new' ? undefined : intent.threadId,
  )
  /**
   * A forward carries the original's attachments. The message id travels,
   * never the bytes: main fetches them and hands them to `buildRfc822`.
   */
  // Memoised: a fresh object each render would change `save`'s identity, and
  // the autosave debounce would reschedule itself continuously.
  const forwardOf = useMemo(
    () => (intent.kind === 'forward' ? { messageId: intent.parent.id } : undefined),
    [intent],
  )
  const forwarded = intent.kind === 'forward' ? intent.parent.attachments : []

  // The opening state, computed once and deliberately never again: `sendAs`
  // arrives asynchronously, and recomputing on it would rewrite the recipients
  // and the body out from under whatever the user had already typed.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const opening = useMemo(() => composeFrom(intent, sendAs), [])

  const [to, setTo] = useState<MailAddress[]>(opening.to)
  const [cc, setCc] = useState<MailAddress[]>(opening.cc)
  const [showCc, setShowCc] = useState(opening.cc.length > 0)
  const [subject, setSubject] = useState(opening.subject)
  const [markdown, setMarkdown] = useState(opening.body)
  /** Bumped when a draft loads: the editor reads its text only at mount, so a
   *  loaded body reaches it by remounting it (`key`). */
  const [loads, setLoads] = useState(0)
  const [tab, setTab] = useState<'edit' | 'preview'>('edit')
  const [foreign, setForeign] = useState(false)
  const [saveState, setSaveState] = useState<SaveState>('pristine')
  const [failure, setFailure] = useState<SendFailure | null>(null)
  const [failedOperation, setFailedOperation] = useState<FailedOperation | null>(null)
  const [sending, setSending] = useState(false)
  const [departing, setDeparting] = useState(false)
  const [discarding, setDiscarding] = useState(false)
  const [confirmingSubject, setConfirmingSubject] = useState(false)
  const [confirmingDiscard, setConfirmingDiscard] = useState(false)

  /** The Gmail draft id, once one exists. A ref because the autosave loop reads
   *  it after an await, where state would be a render behind. */
  const draftRef = useRef<string | null>(draftId ?? null)
  const savingRef = useRef(false)
  const queuedRef = useRef(false)
  /** No save before the first real edit, or empty drafts pile up in Gmail. */
  const dirtyRef = useRef(false)
  /** State updates are skipped once this is false. The save on unmount below
   *  outlives the component on purpose, and its result has nowhere to go. */
  const mountedRef = useRef(true)

  /** The current values, readable from inside an async save without capturing
   *  a stale closure. */
  const latest = useRef({ to, cc, subject, markdown })
  const editVersion = useRef(0)
  const loadingRef = useRef(draftId !== undefined)
  const [loadAttempt, setLoadAttempt] = useState(0)
  const sectionRef = useRef<HTMLElement | null>(null)
  const originRef = useRef<HTMLElement | null>(
    typeof document === 'undefined' ? null : (document.activeElement as HTMLElement | null),
  )
  const focusLoadedDraftRef = useRef(false)

  useLayoutEffect(() => {
    const section = sectionRef.current
    const origin = originRef.current
    if (draftId === undefined && intent.kind === 'new') {
      section?.querySelector<HTMLElement>('[aria-label="To"]')?.focus()
    }
    return () => {
      if (section?.contains(document.activeElement) && origin !== null && origin.isConnected) {
        origin.focus()
      }
    }
    // The origin and initial focus policy belong to this composer instance.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useLayoutEffect(() => {
    if (loads === 0 || !focusLoadedDraftRef.current) return
    focusLoadedDraftRef.current = false
    sectionRef.current?.querySelector<HTMLElement>('[aria-label="To"]')?.focus()
  }, [loads])

  // ---- loading an existing draft -----------------------------------------

  const applyLoaded = (draft: LoadedDraft): void => {
    latest.current = {
      to: draft.to,
      cc: draft.cc,
      subject: draft.subject,
      markdown: draft.markdown,
    }
    setTo(draft.to)
    setCc(draft.cc)
    setShowCc(draft.cc.length > 0)
    setSubject(draft.subject)
    setMarkdown(draft.markdown)
    setLoads((n) => n + 1)
    setForeign(draft.foreign)
    if (draft.threadId !== undefined) setThreadId(draft.threadId)
    // Loading is not an edit: marking it dirty would save a foreign draft back
    // over its original formatting before the user touched anything.
    dirtyRef.current = false
    setSaveState('pristine')
  }

  useEffect(() => {
    if (draftId === undefined) return
    let cancelled = false
    if (remote === null || accountSubRef.current === null) return
    void googleCap
      .draftBody(remote, { id: draftId, expectedAccountSub: accountSubRef.current ?? undefined })
      .then((draft) => {
        if (cancelled || editVersion.current !== 0 || !mountedRef.current) return
        loadingRef.current = false
        focusLoadedDraftRef.current = document.activeElement === originRef.current
        // `markdown` is null exactly when `X-Holi-Source` was absent: the
        // renderer converts, since turndown needs a DOM. With no html either the
        // plain text IS the message; converting `''` would open blank and
        // autosave that over a real draft on the first keystroke.
        const body =
          draft.markdown ?? (draft.html === null ? draft.text : mailHtmlToMarkdown(draft.html))
        applyLoaded({
          to: draft.to,
          cc: draft.cc,
          subject: draft.subject,
          markdown: body,
          foreign: draft.foreign,
          // The draft's own thread outranks the intent. Losing it rebuilds the
          // draft with no `In-Reply-To` and moves it out of its conversation.
          threadId: draft.threadId ?? undefined,
        })
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          loadingRef.current = true
          setFailedOperation('load')
          setFailure(describeSendFailure(error))
        }
      })
    return () => {
      cancelled = true
    }
  }, [draftId, remote, currentSub, loadAttempt])

  // ---- the payload --------------------------------------------------------

  const html = useMemo(() => renderMailMarkdown(markdown), [markdown])

  const payload = useCallback(() => {
    const current = latest.current
    const rendered = renderMailMarkdown(current.markdown)
    return {
      to: current.to.map((address) => address.email),
      ...(current.cc.length === 0 ? {} : { cc: current.cc.map((address) => address.email) }),
      subject: current.subject,
      body: current.markdown,
      // Same pure function on the same input as the preview, differing only in
      // the remote-image flag — so the two cannot drift.
      html: sanitizeMailHtml(rendered, { allowRemoteContent: true }).html,
    }
  }, [])

  // ---- autosave -----------------------------------------------------------

  /**
   * One save, and then the trailing one it may have queued, as a single
   * promise, so awaiting it means the composer is actually quiescent. The
   * recursion is what makes that true: a bare `void save()` for the queued one
   * would let Send proceed while a later save is still on the wire.
   */
  const runSave = useCallback(async (): Promise<void> => {
    savingRef.current = true
    if (mountedRef.current) setSaveState('saving')
    let saveError: unknown
    try {
      if (accountSubRef.current === null)
        throw new Error('No Google account is connected to this vault.')
      const result = await googleCap.saveDraft(vault(), {
        expectedAccountSub: accountSubRef.current ?? undefined,
        ...(draftRef.current === null ? {} : { draftId: draftRef.current }),
        ...(threadId === undefined ? {} : { threadId }),
        ...(forwardOf === undefined ? {} : { forwardOf }),
        mail: payload(),
      })
      if (result.id !== null) draftRef.current = result.id
      if (draftRef.current === null)
        throw new Error('Draft could not be saved; Gmail returned no draft id.')
      /**
       * Only clean if nothing changed *while this save was in flight*. Clearing
       * unconditionally makes the queued save find a clean flag and skip,
       * leaving everything typed during the request unsaved.
       */
      if (!queuedRef.current) dirtyRef.current = false
      if (mountedRef.current) {
        setSaveState(queuedRef.current ? 'dirty' : 'saved')
        setFailure(null)
        setFailedOperation(null)
      }
    } catch (error) {
      dirtyRef.current = true
      if (mountedRef.current) {
        setSaveState('error')
        setFailedOperation('save')
        setFailure({
          message: error instanceof Error ? error.message : 'Draft could not be saved.',
          action: 'retry',
        })
      }
      saveError = error
    } finally {
      savingRef.current = false
    }
    if (queuedRef.current) {
      queuedRef.current = false
      await runSave()
      saveError = undefined
    }
    if (saveError !== undefined) throw saveError
  }, [payload, threadId, forwardOf, vault])

  /** The chain currently in flight, so a caller arriving mid-save can await the
   *  whole of it rather than just setting the queued flag and walking away. */
  const inFlightRef = useRef<Promise<void> | null>(null)

  const save = useCallback(async (): Promise<void> => {
    if (savingRef.current) {
      // A real edit queues its own trailing write in markDirty. A read-only
      // waiter (blur, navigation, send) only joins that existing chain.
      await inFlightRef.current
      return
    }
    if (!dirtyRef.current) return
    // `runSave` sets `savingRef` before its first await, so the ref below is
    // assigned before any other caller can observe the flag and read it.
    const chain = runSave()
    inFlightRef.current = chain
    try {
      await chain
    } finally {
      if (inFlightRef.current === chain) inFlightRef.current = null
    }
  }, [runSave])

  const markDirty = useCallback((patch?: Partial<typeof latest.current>): boolean => {
    if (loadingRef.current || sendingRef.current || departingRef.current || discardingRef.current)
      return false
    if (patch !== undefined) latest.current = { ...latest.current, ...patch }
    editVersion.current += 1
    dirtyRef.current = true
    if (savingRef.current) queuedRef.current = true
    setSaveState((state) => (state === 'saving' ? state : 'dirty'))
    return true
  }, [])

  useEffect(() => {
    if (!dirtyRef.current) return
    const timer = setTimeout(() => void save().catch(() => {}), AUTOSAVE_IDLE_MS)
    return () => clearTimeout(timer)
  }, [to, cc, subject, markdown, save])

  /**
   * A forced save on the way out, so a dismissed composer leaves its text in
   * Gmail Drafts rather than losing what was typed inside the idle window.
   * The save deliberately outlives the component, so its state updates are
   * suppressed.
   */
  const saveOnUnmount = useRef(save)
  saveOnUnmount.current = save
  useEffect(() => {
    return () => {
      mountedRef.current = false
      if (dirtyRef.current) void saveOnUnmount.current().catch(() => {})
    }
  }, [])

  // ---- sending ------------------------------------------------------------

  const sendingRef = useRef(false)
  const departingRef = useRef(false)
  const discardingRef = useRef(false)
  const canSend = to.length > 0 && !sending && !departing && !discarding && !loadingRef.current

  const send = useCallback(async (): Promise<void> => {
    if (sendingRef.current || discardingRef.current || departingRef.current || loadingRef.current)
      return
    sendingRef.current = true
    setSending(true)
    setFailure(null)
    setFailedOperation(null)
    try {
      // Forced save first, so a draft that exists is the one being sent and a
      // failure leaves the newest text in Gmail rather than an older copy.
      if (dirtyRef.current) {
        try {
          await save()
        } catch {
          return
        }
      }
      if (accountSubRef.current === null)
        throw new Error('No Google account is connected to this vault.')
      const result = await googleCap.send(vault(), {
        expectedAccountSub: accountSubRef.current ?? undefined,
        ...(draftRef.current === null ? {} : { draftId: draftRef.current }),
        ...(threadId === undefined ? {} : { threadId }),
        ...(forwardOf === undefined ? {} : { forwardOf }),
        mail: payload(),
      })
      if (mountedRef.current) onSent(result)
    } catch (error: unknown) {
      // Never auto-retried. The failure mode of a send is a duplicate arriving
      // at a real person, not a message lost.
      if (mountedRef.current) {
        setFailedOperation('send')
        const sendFailure = describeSendFailure(error)
        setFailure({
          ...sendFailure,
          // Retrying a send is always explicit; the composer never retries it
          // after an unknown outcome.
          action: sendFailure.action === null ? 'retry' : sendFailure.action,
        })
      }
    } finally {
      sendingRef.current = false
      if (mountedRef.current) setSending(false)
    }
  }, [onSent, payload, save, threadId, forwardOf, vault])

  const attemptSend = (): void => {
    if (subject.trim() === '' && !confirmingSubject) {
      setConfirmingSubject(true)
      return
    }
    setConfirmingSubject(false)
    void send()
  }

  // ---- discarding and closing --------------------------------------------

  const discard = async (): Promise<void> => {
    if (discardingRef.current || sendingRef.current || departingRef.current) return
    discardingRef.current = true
    setDiscarding(true)
    if (inFlightRef.current !== null) {
      try {
        await inFlightRef.current
      } catch {
        /* discard may still remove saved draft */
      }
    }
    if (draftRef.current !== null) {
      try {
        await googleCap.discardDraft(vault(), {
          draftId: draftRef.current,
          expectedAccountSub:
            accountSubRef.current ??
            (() => {
              throw new Error('No Google account is connected to this vault.')
            })(),
          ...(threadId === undefined ? {} : { threadId }),
        })
      } catch (error: unknown) {
        // Stay open with the failure and the text intact: closing would hide
        // that the draft still sits in Gmail.
        if (mountedRef.current) {
          setFailedOperation('discard')
          const discardFailure = describeSendFailure(error)
          setFailure({
            ...discardFailure,
            action: discardFailure.action === null ? 'retry' : discardFailure.action,
          })
        }
        discardingRef.current = false
        if (mountedRef.current) setDiscarding(false)
        return
      }
    }
    // The unmount save would be a `create`, putting the discarded message
    // straight back into Drafts.
    dirtyRef.current = false
    setFailedOperation(null)
    if (mountedRef.current) onDiscarded()
  }

  const prepareToLeave = useCallback(async (): Promise<boolean> => {
    if (!mountedRef.current || sendingRef.current || discardingRef.current || departingRef.current)
      return false
    if (!dirtyRef.current) return true
    departingRef.current = true
    setDeparting(true)
    try {
      await save()
      return true
    } catch {
      return false
    } finally {
      // The parent may call the gate again before it actually removes us.
      departingRef.current = false
      if (mountedRef.current) setDeparting(false)
    }
  }, [save])
  useImperativeHandle(ref, () => ({ prepareToLeave }), [prepareToLeave])

  const attemptClose = async (): Promise<void> => {
    if (!(await prepareToLeave()) || !mountedRef.current) return
    onClose()
  }

  return (
    <section
      ref={sectionRef}
      className={cn('flex min-h-0 flex-col gap-2', !bare && 'border-t border-divider py-3')}
      aria-label="Compose mail"
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.stopPropagation()
          attemptClose()
        }
      }}
    >
      {bare && (
        <div className="flex items-center justify-between gap-2 border-b border-divider pb-2">
          <h2 className="text-sm font-medium">{draftId === undefined ? 'New message' : 'Draft'}</h2>
          <Button type="button" size="sm" variant="ghost" onClick={attemptClose}>
            Close
          </Button>
        </div>
      )}
      {loadingRef.current && draftId !== undefined && (
        <div aria-label="Loading draft" className="flex flex-col gap-2">
          <Skeleton className="h-8 w-full" />
          <Skeleton className="h-8 w-3/4" />
          <Skeleton className="h-40 w-full" />
        </div>
      )}

      {foreign && (
        <p
          className="rounded-md bg-muted px-2 py-1 text-xs text-muted-foreground"
          data-testid="foreign-notice"
        >
          This draft was written outside Holi and has been converted to markdown. Saving will
          replace the original formatting.
        </p>
      )}

      <div className="flex items-baseline gap-2">
        <span className="w-12 shrink-0 text-xs text-muted-foreground">To</span>
        <ChipInput
          label="To"
          disabled={loadingRef.current || sending || departing || discarding}
          value={to}
          onChange={(next) => {
            if (markDirty({ to: next })) setTo(next)
          }}
          suggestions={suggestions}
        />
        {!showCc && (
          <Button
            variant="ghost"
            size="sm"
            disabled={sending || departing || discarding}
            onClick={() => setShowCc(true)}
          >
            Cc
          </Button>
        )}
      </div>

      {showCc && (
        <div className="flex items-baseline gap-2">
          <span className="w-12 shrink-0 text-xs text-muted-foreground">Cc</span>
          <ChipInput
            label="Cc"
            disabled={loadingRef.current || sending || departing || discarding}
            value={cc}
            onChange={(next) => {
              if (markDirty({ cc: next })) setCc(next)
            }}
            suggestions={suggestions}
          />
        </div>
      )}

      <div className="flex items-baseline gap-2">
        <span className="w-12 shrink-0 text-xs text-muted-foreground">Subject</span>
        <Input
          aria-label="Subject"
          disabled={loadingRef.current || sending || departing || discarding}
          value={subject}
          onChange={(event) => {
            if (markDirty({ subject: event.target.value })) setSubject(event.target.value)
          }}
          onBlur={() => void save().catch(() => {})}
        />
      </div>

      {forwarded.length > 0 && (
        <p className="text-xs text-muted-foreground" data-testid="forwarded-attachments">
          {/* Named, because the bytes are fetched in main at send time and this
              is the only account of what will travel. */}
          Attached: {forwarded.map((file) => file.filename).join(', ')}
        </p>
      )}

      <ToggleGroup
        type="single"
        aria-label="Compose view"
        size="sm"
        spacing={1}
        disabled={sending || departing || discarding}
        value={tab}
        // Pressing the current pick reports '', which a pick never is here.
        onValueChange={(which) => {
          if (which !== 'edit' && which !== 'preview') return
          // Switching to preview is a natural save point.
          if (which === 'preview' && tab !== 'preview') void save().catch(() => {})
          setTab(which)
        }}
      >
        {COMPOSE_VIEWS.map((view) => (
          <ToggleGroupItem key={view.value} value={view.value}>
            {view.label}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>

      {tab === 'edit' ? (
        <MarkdownEditor
          key={loads}
          focusOnMount={draftId === undefined && intent.kind !== 'new'}
          disabled={loadingRef.current || sending || departing || discarding}
          value={markdown}
          onChange={(next) => {
            if (markDirty({ markdown: next })) setMarkdown(next)
          }}
          onBlur={() => void save().catch(() => {})}
        />
      ) : (
        <SandboxedHtml html={html} label="Preview of your message" />
      )}

      {failure !== null && (
        <div className="flex items-center gap-2 rounded-md bg-destructive/10 px-2 py-1 text-xs">
          <span className="min-w-0 flex-1">{failure.message}</span>
          {failure.action === 'reconnect' && onReconnect !== undefined && (
            <Button size="sm" variant="outline" onClick={onReconnect}>
              Reconnect
            </Button>
          )}
          {failure.action === 'retry' && (
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                setFailure(null)
                switch (failedOperation) {
                  case 'load':
                    loadingRef.current = true
                    setLoadAttempt((n) => n + 1)
                    break
                  case 'save':
                    void save().catch(() => {})
                    break
                  case 'send':
                    void send()
                    break
                  case 'discard':
                    void discard()
                    break
                  case null:
                    break
                }
              }}
            >
              Retry
            </Button>
          )}
        </div>
      )}

      {confirmingSubject && (
        <div className="flex items-center gap-2 text-xs" role="alert">
          <span className="min-w-0 flex-1">Send without a subject?</span>
          <Button size="sm" disabled={sending || departing || discarding} onClick={attemptSend}>
            Send anyway
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={sending || departing || discarding}
            onClick={() => setConfirmingSubject(false)}
          >
            Go back
          </Button>
        </div>
      )}

      {confirmingDiscard && (
        <div className="flex items-center gap-2 text-xs" role="alert">
          <span className="min-w-0 flex-1">Discard this draft?</span>
          {/* "Discard draft", not "Discard": the button that opened this
              confirmation is also called Discard. */}
          <Button
            size="sm"
            variant="destructive"
            disabled={sending || departing || discarding}
            onClick={() => void discard()}
          >
            Discard draft
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={sending || departing || discarding}
            onClick={() => {
              setConfirmingDiscard(false)
              void save().catch(() => {})
            }}
          >
            Keep
          </Button>
        </div>
      )}

      <div className="flex items-center gap-2">
        <Button size="sm" disabled={!canSend} onClick={attemptSend}>
          Send
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={sending || departing || discarding}
          onClick={() => {
            if (sendingRef.current || departingRef.current || discardingRef.current) return
            if (draftRef.current === null && !dirtyRef.current) {
              if (mountedRef.current) onDiscarded()
            } else setConfirmingDiscard(true)
          }}
        >
          Discard
        </Button>
        {to.length === 0 && <span className="text-xs text-muted-foreground">Add a recipient</span>}
        <span className="ml-auto text-xs text-muted-foreground" data-testid="save-state">
          {SAVE_LABEL[saveState]}
        </span>
      </div>
    </section>
  )
}

/**
 * The body editor. The view is created once and never recreated from `value`:
 * a controlled CodeMirror that rebuilds on every keystroke loses the cursor,
 * the selection and the undo history.
 */
function MarkdownEditor({
  value,
  onChange,
  onBlur,
  disabled,
  focusOnMount = false,
}: {
  disabled: boolean
  focusOnMount?: boolean
  value: string
  onChange: (next: string) => void
  onBlur: () => void
}): React.JSX.Element {
  const host = useRef<HTMLDivElement | null>(null)
  const notify = useRef(onChange)
  notify.current = onChange
  const blurred = useRef(onBlur)
  blurred.current = onBlur
  /** The opening document. Read once — see the note above. */
  const initial = useRef(value)
  const editable = useRef(new Compartment())
  const viewRef = useRef<EditorView | null>(null)
  const ignoreOpeningBlur = useRef(focusOnMount)

  // The view is created once so readonly changes cannot discard its document
  // or undo history; the following effect reconfigures the compartment.
  useEffect(() => {
    const parent = host.current
    if (parent === null) return
    const view = new EditorView({
      state: EditorState.create({
        doc: initial.current,
        extensions: [
          ...plainMarkdownExtensions(),
          editable.current.of([
            EditorState.readOnly.of(disabled),
            EditorView.editable.of(!disabled),
          ]),
          // The field's accessible name: CodeMirror's content element is a
          // bare `contenteditable` otherwise.
          EditorView.contentAttributes.of({ 'aria-label': 'Message', 'aria-multiline': 'true' }),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) notify.current(update.state.doc.toString())
            if (update.focusChanged && !update.view.hasFocus) {
              if (ignoreOpeningBlur.current) ignoreOpeningBlur.current = false
              else blurred.current()
            }
          }),
        ],
      }),
      parent,
    })
    viewRef.current = view
    if (focusOnMount) view.focus()
    return () => {
      viewRef.current = null
      view.destroy()
    }
    // disabled initializes the compartment; later values are reconfigured below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    const editor = viewRef.current
    if (editor === null) return
    editor.dispatch({
      effects: editable.current.reconfigure([
        EditorState.readOnly.of(disabled),
        EditorView.editable.of(!disabled),
      ]),
    })
  }, [disabled])

  return <div ref={host} className="min-h-40 flex-1 overflow-auto" data-testid="mail-body" />
}
