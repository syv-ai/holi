/**
 * Writing a mail, inside Holi (D71).
 *
 * **The preview is the artifact, not a likeness of it.** `renderMailMarkdown`
 * produces the bytes shown in the preview pane *and* the `text/html` part that
 * is sent; the only difference between the two is the remote-image flag, so
 * they cannot drift. The preview holds remote images back and the sent mail
 * does not — that is correct (the reader's rule, D69), and the existing "load
 * images" banner makes them identical in one click.
 *
 * **Autosave is single-flight and latest-wins**, which is the one piece of
 * concurrency here that has teeth. A second `create` while the first is in
 * flight makes a second draft, and the user watches their message fork.
 *
 * **Nothing is ever read-only.** A draft written outside Holi is converted with
 * `turndown` and opens for editing with a notice saying so.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { Button, ChipInput, Input } from '../../primitives'
import { SandboxedHtml } from './SandboxedHtml'
import { mailComposerExtensions } from '../../editor/extensions'
import { composeFrom, type ComposeIntent } from '../../lib/compose-intent'
import { renderMailMarkdown } from '../../lib/mail-markdown'
import { mailHtmlToMarkdown } from '../../lib/mail-unmarkdown'
import { sanitizeMailHtml } from '../../lib/mail-html'
import { describeSendFailure, type SendFailure } from '../../lib/mail-send-failure'
import type { MailAddress } from '../../lib/mail-types'
import { trpc } from '../../lib/trpc'

/**
 * Idle time before an autosave.
 *
 * 2s, not the 350ms ultramail used. A keystroke-rate debounce turns a paragraph
 * into a dozen `drafts.update` calls against a rate-limited API, and the save
 * state flickers so fast it reads as noise rather than reassurance. Forced
 * saves on blur, close and send are what make the longer wait safe.
 */
const AUTOSAVE_IDLE_MS = 2000

type SaveState = 'pristine' | 'dirty' | 'saving' | 'saved' | 'error'

const SAVE_LABEL: Record<SaveState, string> = {
  pristine: '',
  dirty: 'Unsaved changes',
  saving: 'Saving…',
  saved: 'Saved',
  error: 'Not saved',
}

export interface MailComposerProps {
  intent: ComposeIntent
  /** An existing Gmail draft to continue. Absent means this composer will
   *  create one on its first save. */
  draftId?: string
  /** Every address the account may send from, so reply-all excludes all of
   *  them. Empty is survivable — the user is copied on their own reply. */
  sendAs?: string[]
  suggestions?: MailAddress[]
  onSent: (draft: { id: string | null }) => void
  onDiscarded: () => void
  onClose: () => void
  /** Routes to vault settings for a `reconnect` failure. */
  onReconnect?: () => void
}

interface LoadedDraft {
  to: MailAddress[]
  cc: MailAddress[]
  subject: string
  markdown: string
  foreign: boolean
  /** The thread the draft is filed in, if any — see `applyLoaded`. */
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
}: MailComposerProps): React.JSX.Element {
  /**
   * The thread this message belongs to, and therefore what every save and the
   * send rebuild the threading headers from.
   *
   * State rather than a derived value because a *continued* draft carries its
   * own thread, which the intent cannot know: `continueDraft` opens every draft
   * as `new` deliberately — recipients, subject and body all arrive from
   * `google.draft` a moment later, and a second source for them would flicker —
   * so `applyLoaded` is where a continued reply learns its thread.
   */
  const [threadId, setThreadId] = useState<string | undefined>(
    intent.kind === 'new' ? undefined : intent.threadId,
  )
  /**
   * A forward carries the original's attachments (D71).
   *
   * The message id travels, never the bytes: main fetches them and hands them
   * to `buildRfc822`, so there is no base64 in renderer state, no file picker
   * and no size-cap UI to design.
   */
  // Memoised: a fresh object each render would change `save`'s identity every
  // render, and the autosave effect depends on `save` — so the 2s debounce
  // would reschedule itself continuously instead of settling.
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
  const [tab, setTab] = useState<'edit' | 'preview'>('edit')
  const [foreign, setForeign] = useState(false)
  const [saveState, setSaveState] = useState<SaveState>('pristine')
  const [failure, setFailure] = useState<SendFailure | null>(null)
  const [sending, setSending] = useState(false)
  const [confirmingSubject, setConfirmingSubject] = useState(false)
  const [confirmingDiscard, setConfirmingDiscard] = useState(false)

  /** The Gmail draft id, once one exists. A ref because the autosave loop reads
   *  it after an await, where state would be a render behind. */
  const draftRef = useRef<string | null>(draftId ?? null)
  const savingRef = useRef(false)
  const queuedRef = useRef(false)
  /** No save has any business happening before the first real edit. Ultramail
   *  shipped without this guard and left zombie empty drafts behind. */
  const dirtyRef = useRef(false)
  /** State updates are skipped once this is false. The save on unmount below
   *  outlives the component on purpose, and its result has nowhere to go. */
  const mountedRef = useRef(true)

  /** The current values, readable from inside an async save without capturing
   *  a stale closure. */
  const latest = useRef({ to, cc, subject, markdown })
  latest.current = { to, cc, subject, markdown }

  // ---- loading an existing draft -----------------------------------------

  const applyLoaded = (draft: LoadedDraft): void => {
    setTo(draft.to)
    setCc(draft.cc)
    setShowCc(draft.cc.length > 0)
    setSubject(draft.subject)
    setMarkdown(draft.markdown)
    setForeign(draft.foreign)
    if (draft.threadId !== undefined) setThreadId(draft.threadId)
    // Loading is not an edit. Marking it dirty would save the draft straight
    // back over itself, which for a foreign draft means replacing the
    // original's formatting before the user has touched anything.
    dirtyRef.current = false
    setSaveState('pristine')
  }

  useEffect(() => {
    if (draftId === undefined) return
    let cancelled = false
    void trpc.google.draft
      .query({ id: draftId })
      .then((draft) => {
        if (cancelled) return
        // `markdown` is null exactly when `X-Holi-Source` was absent, which is
        // main telling the renderer to convert — main cannot, since turndown
        // needs a DOM and main has none. With no html either there is nothing
        // to convert and the plain text IS the message: converting `''` would
        // open blank and autosave that over a real draft on the first keystroke.
        const body =
          draft.markdown ?? (draft.html === null ? draft.text : mailHtmlToMarkdown(draft.html))
        applyLoaded({
          to: draft.to,
          cc: draft.cc,
          subject: draft.subject,
          markdown: body,
          foreign: draft.foreign,
          // The draft's own thread, which outranks the intent: `continueDraft`
          // opens every draft as `new` on purpose, so this is the only place the
          // thread of a continued reply is known. Losing it rebuilds the draft
          // with no `In-Reply-To` and moves it out of its conversation.
          threadId: draft.threadId ?? undefined,
        })
      })
      .catch((error: unknown) => {
        if (!cancelled) setFailure(describeSendFailure(error))
      })
    return () => {
      cancelled = true
    }
  }, [draftId])

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
   * One save, and then the trailing one it may have queued — as a single
   * promise, so awaiting it means the composer is actually quiescent.
   *
   * The recursion is what makes that true. Starting the queued save with a bare
   * `void save()` (which is what this was) leaves it outside the chain: a caller
   * awaiting the save it triggered gets control back while a later one is still
   * on the wire. Harmless for the autosave, and not harmless for Send.
   */
  const runSave = useCallback(async (): Promise<void> => {
    savingRef.current = true
    if (mountedRef.current) setSaveState('saving')
    try {
      const result = await trpc.google.saveDraft.mutate({
        ...(draftRef.current === null ? {} : { draftId: draftRef.current }),
        ...(threadId === undefined ? {} : { threadId }),
        ...(forwardOf === undefined ? {} : { forwardOf }),
        mail: payload(),
      })
      if (result.id !== null) draftRef.current = result.id
      /**
       * Only clean if nothing changed *while this save was in flight*.
       *
       * Clearing unconditionally is the obvious version and it silently loses
       * work: the queued save that runs next would find a clean flag, return
       * immediately, and everything typed during the request would sit unsaved
       * until the user happened to type again. The composer would say "Saved"
       * the whole time.
       */
      if (!queuedRef.current) dirtyRef.current = false
      if (mountedRef.current) {
        setSaveState(queuedRef.current ? 'dirty' : 'saved')
        setFailure(null)
      }
    } catch {
      // The text is untouched. A refused save is retried on the next edit or on
      // Send; it never discards what the user wrote.
      dirtyRef.current = true
      if (mountedRef.current) setSaveState('error')
    } finally {
      savingRef.current = false
    }
    if (queuedRef.current) {
      queuedRef.current = false
      await runSave()
    }
  }, [payload, threadId, forwardOf])

  /** The chain currently in flight, so a caller arriving mid-save can await the
   *  whole of it rather than just setting the queued flag and walking away. */
  const inFlightRef = useRef<Promise<void> | null>(null)

  const save = useCallback(async (): Promise<void> => {
    if (!dirtyRef.current) return
    if (savingRef.current) {
      // Latest-wins: coalesce every request arriving mid-flight into one
      // trailing save, rather than queueing a call per keystroke — then wait for
      // the chain that will run it, which now includes that trailing save.
      queuedRef.current = true
      await inFlightRef.current
      return
    }
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

  const markDirty = useCallback(() => {
    dirtyRef.current = true
    setSaveState((state) => (state === 'saving' ? state : 'dirty'))
  }, [])

  useEffect(() => {
    if (!dirtyRef.current) return
    const timer = setTimeout(() => void save(), AUTOSAVE_IDLE_MS)
    return () => clearTimeout(timer)
  }, [to, cc, subject, markdown, save])

  /**
   * A forced save on the way out.
   *
   * This is what makes closing safe rather than lossy: a dismissed composer
   * leaves its text in Gmail Drafts, where the Drafts view (D71, Task 12) can
   * find it again. Without it, closing a dirty composer inside the 2s idle
   * window silently discards everything typed since the last save.
   *
   * The save deliberately outlives the component, so its state updates are
   * suppressed rather than issued at nothing.
   */
  const saveOnUnmount = useRef(save)
  saveOnUnmount.current = save
  useEffect(() => {
    return () => {
      mountedRef.current = false
      if (dirtyRef.current) void saveOnUnmount.current()
    }
  }, [])

  // ---- sending ------------------------------------------------------------

  const canSend = to.length > 0 && !sending

  const send = useCallback(async (): Promise<void> => {
    setSending(true)
    setFailure(null)
    try {
      // Forced save first, so a draft that exists is the one being sent and a
      // failure leaves the newest text in Gmail rather than an older copy.
      if (dirtyRef.current) await save()
      const result = await trpc.google.send.mutate({
        ...(draftRef.current === null ? {} : { draftId: draftRef.current }),
        ...(threadId === undefined ? {} : { threadId }),
        ...(forwardOf === undefined ? {} : { forwardOf }),
        mail: payload(),
      })
      onSent(result)
    } catch (error: unknown) {
      // Never auto-retried. The failure mode of a send is a duplicate arriving
      // at a real person, not a message lost.
      setFailure(describeSendFailure(error))
    } finally {
      setSending(false)
    }
  }, [onSent, payload, save, threadId, forwardOf])

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
    if (draftRef.current !== null) {
      try {
        await trpc.google.discardDraft.mutate({
          draftId: draftRef.current,
          ...(threadId === undefined ? {} : { threadId }),
        })
      } catch (error: unknown) {
        // Closing here would unmount the composer, so the failure just set would
        // render at nothing and the user would be told the draft was thrown away
        // while it sat in Gmail. It stays open, saying so, with the text intact.
        setFailure(describeSendFailure(error))
        return
      }
    }
    // The draft is gone, so there is nothing left to save — and the unmount save
    // below is a `create`, which would put the message the user just discarded
    // straight back into Drafts.
    dirtyRef.current = false
    onDiscarded()
  }

  const attemptClose = (): void => {
    // Pristine closes like any dialog. Dirty refuses: the exits are Send and an
    // explicit Discard, so nothing the user wrote leaves without being asked
    // about.
    if (dirtyRef.current) {
      setConfirmingDiscard(true)
      return
    }
    onClose()
  }

  return (
    <section
      className="flex min-h-0 flex-col gap-2 border-t border-border p-3"
      aria-label="Compose mail"
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.stopPropagation()
          attemptClose()
        }
      }}
    >
      {foreign && (
        <p
          className="rounded-md bg-muted px-2 py-1 text-xs text-muted-foreground"
          data-testid="foreign-notice"
        >
          This draft was written outside Holi and has been converted to markdown.
          Saving will replace the original formatting.
        </p>
      )}

      <div className="flex items-baseline gap-2">
        <span className="w-12 shrink-0 text-xs text-muted-foreground">To</span>
        <ChipInput
          label="To"
          value={to}
          onChange={(next) => {
            setTo(next)
            markDirty()
          }}
          suggestions={suggestions}
        />
        {!showCc && (
          <Button variant="ghost" size="sm" onClick={() => setShowCc(true)}>
            Cc
          </Button>
        )}
      </div>

      {showCc && (
        <div className="flex items-baseline gap-2">
          <span className="w-12 shrink-0 text-xs text-muted-foreground">Cc</span>
          <ChipInput
            label="Cc"
            value={cc}
            onChange={(next) => {
              setCc(next)
              markDirty()
            }}
            suggestions={suggestions}
          />
        </div>
      )}

      <div className="flex items-baseline gap-2">
        <span className="w-12 shrink-0 text-xs text-muted-foreground">Subject</span>
        <Input
          aria-label="Subject"
          value={subject}
          onChange={(event) => {
            setSubject(event.target.value)
            markDirty()
          }}
          onBlur={() => void save()}
        />
      </div>

      {forwarded.length > 0 && (
        <p className="text-xs text-muted-foreground" data-testid="forwarded-attachments">
          {/* Named, because the user is about to send files they cannot see.
              The bytes are fetched in main at send time; this is the only
              account of what will travel. */}
          Attached: {forwarded.map((file) => file.filename).join(', ')}
        </p>
      )}

      <div className="flex gap-1 text-xs" role="tablist" aria-label="Compose view">
        {(['edit', 'preview'] as const).map((which) => (
          <Button
            key={which}
            role="tab"
            aria-selected={tab === which}
            variant={tab === which ? 'secondary' : 'ghost'}
            size="sm"
            onClick={() => {
              // Switching to preview is a natural save point, and it is the
              // moment the user is most likely to walk away.
              if (which === 'preview') void save()
              setTab(which)
            }}
          >
            {which === 'edit' ? 'Edit' : 'Preview'}
          </Button>
        ))}
      </div>

      {tab === 'edit' ? (
        <MarkdownEditor
          value={markdown}
          onChange={(next) => {
            setMarkdown(next)
            markDirty()
          }}
          onBlur={() => void save()}
        />
      ) : (
        <SandboxedHtml html={html} label="preview of your message" />
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
            <Button size="sm" variant="outline" onClick={() => void send()}>
              Retry
            </Button>
          )}
        </div>
      )}

      {confirmingSubject && (
        <div className="flex items-center gap-2 text-xs" role="alert">
          <span className="min-w-0 flex-1">Send without a subject?</span>
          <Button size="sm" onClick={attemptSend}>
            Send anyway
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setConfirmingSubject(false)}>
            Go back
          </Button>
        </div>
      )}

      {confirmingDiscard && (
        <div className="flex items-center gap-2 text-xs" role="alert">
          <span className="min-w-0 flex-1">Discard this draft?</span>
          {/* "Discard draft", not "Discard" — the button that opened this
              confirmation is also called Discard, and two controls with the
              same name one line apart is how a confirmation stops confirming
              anything. */}
          <Button size="sm" variant="destructive" onClick={() => void discard()}>
            Discard draft
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              setConfirmingDiscard(false)
              void save()
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
          onClick={() => {
            if (draftRef.current === null && !dirtyRef.current) onDiscarded()
            else setConfirmingDiscard(true)
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
 * The body editor.
 *
 * Its own component so the CodeMirror lifecycle is not entangled with the
 * composer's state machine. The view is created once and never recreated from
 * `value` — a controlled CodeMirror that rebuilds on every keystroke loses the
 * cursor, the selection and the undo history.
 */
function MarkdownEditor({
  value,
  onChange,
  onBlur,
}: {
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

  useEffect(() => {
    const parent = host.current
    if (parent === null) return
    const view = new EditorView({
      state: EditorState.create({
        doc: initial.current,
        extensions: [
          ...mailComposerExtensions(),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) notify.current(update.state.doc.toString())
            if (update.focusChanged && !update.view.hasFocus) blurred.current()
          }),
        ],
      }),
      parent,
    })
    return () => view.destroy()
  }, [])

  return <div ref={host} className="min-h-40 flex-1 overflow-auto" data-testid="mail-body" />
}
