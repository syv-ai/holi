import { vaultWorkflow } from '@/test/vault-workflow'
import { emptyVaultSnapshot } from '@holi/shared'
/**
 * The composer.
 *
 * The tests that matter here are about *drafts that should not exist* and
 * *drafts that should not fork*: both surface later in Gmail as half-written
 * messages the user does not remember making.
 *
 * The body editor is exercised through its real CodeMirror contenteditable so
 * its document/history survive the composer busy-state transitions.
 */
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Provider, createStore } from 'jotai'
import { createRef, useState } from 'react'
import { undo, redo } from '@codemirror/commands'
import { getCM } from '@replit/codemirror-vim'
import { EditorView } from '@codemirror/view'
import { MailComposer, type MailComposerHandle } from '../renderer/mail-composer'
import { activeRemoteAtom, vimCodeEditingAtom } from '@/plugin-api'
import type { ComposeIntent } from '../renderer/compose-intent'
import type { ThreadMessage } from '../renderer/mail-types'

const saveDraft = vi.fn()
const send = vi.fn()
const discardDraft = vi.fn()
const draftQuery = vi.fn()

// CodeMirror measures its selection; jsdom has no layout engine.
Range.prototype.getBoundingClientRect ??= () => new DOMRect()
Range.prototype.getClientRects ??= () =>
  ({
    length: 0,
    item: () => null,
    [Symbol.iterator]: [][Symbol.iterator],
  }) as unknown as DOMRectList

/** Google's capabilities, by name, through the UI door. */
const google: Record<string, (params: unknown) => unknown> = {
  'google.status': () => ({ account: { email: 'ada@syv.ai' }, missingScopes: [] }),
  'google.accounts': () => ({
    accounts: [{ sub: 'sub-1', email: 'ada@syv.ai' }],
    current: 'sub-1',
  }),
  'google.saveDraft': (p) => saveDraft(p),
  'google.send': (p) => send(p),
  'google.discardDraft': (p) => discardDraft(p),
  'google.draftBody': (p) => draftQuery(p),
}

vi.mock('@/lib/trpc', () => ({
  trpc: {
    vaults: { open: { mutate: async () => emptyVaultSnapshot() } },
    cap: {
      run: {
        mutate: async ({ name, paramsJson }: { name: string; paramsJson?: string }) => {
          const verb = google[name]
          if (verb === undefined) throw new Error(`unexpected ${name}`)
          return verb(paramsJson === undefined ? undefined : JSON.parse(paramsJson))
        },
      },
    },
  },
}))

/** The composer's own mail-image store reads preferences over IPC. */
vi.mock('../renderer/mail-images', () => ({
  useRemoteContent: () => ({ allowed: false, allow: () => {} }),
}))

const PARENT: ThreadMessage = {
  id: 'm1',
  from: { name: 'Bo Berg', email: 'bo@example.com' },
  to: [{ name: 'Ada Holm', email: 'ada@syv.ai' }],
  cc: [],
  bcc: [],
  date: '2026-08-12T08:30:00.000Z',
  body: 'The numbers are attached.',
  html: null,
  attachments: [],
}

const REPLY: ComposeIntent = {
  kind: 'reply',
  threadId: 't1',
  subject: 'Q2 budget',
  parent: PARENT,
  all: false,
}

async function mount(
  props: Partial<React.ComponentProps<typeof MailComposer>> = {},
  vimEnabled = false,
) {
  const onSent = vi.fn()
  const onDiscarded = vi.fn()
  const onClose = vi.fn()
  const store = createStore()
  store.set(activeRemoteAtom, 'syv-ai/vault')
  await vaultWorkflow(store).open('syv-ai/vault')
  store.set(vimCodeEditingAtom, vimEnabled)
  const { unmount } = render(
    <Provider store={store}>
      <MailComposer
        intent={REPLY}
        sendAs={['ada@syv.ai']}
        accountSub="sub-1"
        onSent={onSent}
        onDiscarded={onDiscarded}
        onClose={onClose}
        {...props}
      />
    </Provider>,
  )
  return { onSent, onDiscarded, onClose, unmount, store }
}

const subjectField = (): HTMLElement => screen.getByRole('textbox', { name: 'Subject' })
const saveState = (): string => screen.getByTestId('save-state').textContent ?? ''

beforeEach(async () => {
  vi.clearAllMocks()
  saveDraft.mockResolvedValue({ id: 'd-1' })
  send.mockResolvedValue({ id: 'm-9' })
  discardDraft.mockResolvedValue(undefined)
  // `shouldAdvanceTime` is what makes `userEvent` usable alongside fake timers:
  // userEvent awaits a real-time tick between keystrokes, which a frozen clock
  // never delivers, and every interaction test deadlocks instead of failing.
  vi.useFakeTimers({ shouldAdvanceTime: true })
})

afterEach(() => {
  vi.runOnlyPendingTimers()
  vi.useRealTimers()
})

function setup() {
  return userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
}

describe('composer focus', () => {
  it('focuses the recipient for a new message and the real editor for a reply', async () => {
    const { unmount } = await mount({ intent: { kind: 'new' } })
    expect(screen.getByRole('textbox', { name: /to/i })).toHaveFocus()
    unmount()

    await mount()
    await waitFor(() => expect(screen.getByRole('textbox', { name: 'Message' })).toHaveFocus())
  })

  it('does not steal focus outside while a draft is loading', async () => {
    let resolveDraft: ((draft: unknown) => void) | undefined
    draftQuery.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveDraft = resolve
        }),
    )
    const outside = document.createElement('button')
    document.body.append(outside)
    await mount({ intent: { kind: 'new' }, draftId: 'd-7' })
    outside.focus()

    resolveDraft?.({
      draftId: 'd-7',
      threadId: null,
      to: [],
      cc: [],
      subject: 'Loaded',
      markdown: 'Body',
      html: null,
      foreign: false,
    })
    await waitFor(() => expect(subjectField()).toHaveValue('Loaded'))
    expect(outside).toHaveFocus()
    outside.remove()
  })

  it('restores focus to the opening control when the composer unmounts', async () => {
    const user = setup()
    const onSent = vi.fn()
    const onDiscarded = vi.fn()
    const onClose = vi.fn()
    const store = createStore()
    store.set(activeRemoteAtom, 'syv-ai/vault')
    await vaultWorkflow(store).open('syv-ai/vault')
    function Host() {
      const [open, setOpen] = useState(false)
      return (
        <>
          <button onClick={() => setOpen(true)}>Compose</button>
          {open && (
            <Provider store={store}>
              <MailComposer
                intent={{ kind: 'new' }}
                onSent={onSent}
                onDiscarded={onDiscarded}
                onClose={() => {
                  onClose()
                  setOpen(false)
                }}
              />
            </Provider>
          )}
        </>
      )
    }
    render(<Host />)
    const trigger = screen.getByRole('button', { name: 'Compose' })
    await user.click(trigger)
    expect(screen.getByRole('textbox', { name: /to/i })).toHaveFocus()
    await user.keyboard('{Escape}')
    await waitFor(() => expect(trigger).toHaveFocus())
  })
})

describe('the pristine guard', () => {
  it('creates no draft when the composer is opened and closed untouched', async () => {
    // A reply composer opens pre-filled with a quote, so "has content" is not
    // the same question as "the user wrote something".
    const { onClose } = await mount()

    await vi.advanceTimersByTimeAsync(10_000)

    expect(saveDraft).not.toHaveBeenCalled()
    expect(saveState()).toBe('')
    expect(onClose).not.toHaveBeenCalled()
  })

  it('closes without asking when nothing was typed', async () => {
    const user = setup()
    const { onClose } = await mount()

    // Focus has to be inside the composer: Escape is handled on the section, so
    // an inline composer does not swallow the key for the reader around it.
    await user.click(subjectField())
    await user.keyboard('{Escape}')

    expect(onClose).toHaveBeenCalled()
  })
})

describe('leaving the composer', () => {
  it('pristine leave creates no draft; dirty leave waits for the latest content', async () => {
    const user = setup()
    const handle = createRef<MailComposerHandle>()
    await mount({ ref: handle })
    expect(await handle.current!.prepareToLeave()).toBe(true)
    expect(saveDraft).not.toHaveBeenCalled()

    await user.type(subjectField(), ' latest')
    expect(await handle.current!.prepareToLeave()).toBe(true)
    expect(saveDraft).toHaveBeenCalledTimes(1)
    expect(saveDraft.mock.calls[0]![0]).toMatchObject({
      expectedAccountSub: 'sub-1',
      mail: { subject: 'Re: Q2 budget latest' },
    })
  })

  it('refuses to leave while a send is in flight', async () => {
    const user = setup()
    const handle = createRef<MailComposerHandle>()
    let resolveSend: ((value: { id: string }) => void) | undefined
    send.mockImplementationOnce(
      () =>
        new Promise<{ id: string }>((resolve) => {
          resolveSend = resolve
        }),
    )
    await mount({ ref: handle })

    await user.click(screen.getByRole('button', { name: 'Send' }))
    await user.click(screen.getByRole('button', { name: 'Send' }))
    expect(await handle.current!.prepareToLeave()).toBe(false)
    expect(subjectField()).toBeDisabled()
    expect(screen.getByRole('textbox', { name: /to/i })).toBeDisabled()
    expect(screen.getByRole('textbox', { name: 'Message' })).toHaveAttribute(
      'contenteditable',
      'false',
    )
    expect(send).toHaveBeenCalledTimes(1)

    resolveSend?.({ id: 'm-9' })
    await waitFor(() => expect(send).toHaveBeenCalledTimes(1))
  })

  it('allows the parent close gate to prepare again after a successful save', async () => {
    const user = setup()
    const handle = createRef<MailComposerHandle>()
    await mount({ ref: handle })
    await user.type(subjectField(), ' latest')

    expect(await handle.current!.prepareToLeave()).toBe(true)
    expect(subjectField()).not.toBeDisabled()
    expect(await handle.current!.prepareToLeave()).toBe(true)
  })

  it('does not queue a trailing save when blur and leave only await the same write', async () => {
    const user = setup()
    const handle = createRef<MailComposerHandle>()
    let resolveSave: ((value: { id: string }) => void) | undefined
    saveDraft.mockImplementationOnce(
      () =>
        new Promise<{ id: string }>((resolve) => {
          resolveSave = resolve
        }),
    )
    await mount({ ref: handle })
    await user.type(subjectField(), ' latest')
    await vi.advanceTimersByTimeAsync(2000)
    expect(saveDraft).toHaveBeenCalledTimes(1)

    fireEvent.blur(subjectField())
    const leaving = handle.current!.prepareToLeave()
    resolveSave?.({ id: 'd-1' })
    expect(await leaving).toBe(true)
    expect(saveDraft).toHaveBeenCalledTimes(1)
  })

  it('preserves CodeMirror body, caret, and history when a leave save fails', async () => {
    const user = setup()
    const handle = createRef<MailComposerHandle>()
    saveDraft.mockRejectedValueOnce(new Error('offline'))
    await mount({ intent: { kind: 'new' }, ref: handle })
    const body = screen.getByRole('textbox', { name: 'Message' })
    await user.type(body, 'first body')

    expect(await handle.current!.prepareToLeave()).toBe(false)
    expect(body).toHaveTextContent('first body')
    expect(body).toHaveAttribute('contenteditable', 'true')

    const editor = EditorView.findFromDOM(body)!
    editor.dispatch({ selection: { anchor: editor.state.doc.length } })
    expect(undo(editor)).toBe(true)
    expect(body).not.toHaveTextContent('first body')
    expect(redo(editor)).toBe(true)
    expect(body).toHaveTextContent('first body')
    editor.dispatch({ changes: { from: editor.state.doc.length, insert: '!' } })
    expect(body).toHaveTextContent('first body!')
    await vi.advanceTimersByTimeAsync(2000)
    await waitFor(() => expect(saveDraft).toHaveBeenCalledTimes(2))
    expect(saveDraft.mock.calls[1]![0]).toMatchObject({ mail: { body: 'first body!' } })
  })

  it('preserves the body through a rejected send and saves the next edit exactly', async () => {
    const user = setup()
    const handle = createRef<MailComposerHandle>()
    let rejectSend: ((error: Error) => void) | undefined
    send.mockImplementationOnce(
      () =>
        new Promise<never>((_resolve, reject) => {
          rejectSend = reject
        }),
    )
    await mount({ intent: { kind: 'new' }, ref: handle })
    const body = screen.getByRole('textbox', { name: 'Message' })
    await user.type(body, 'body')
    await user.type(screen.getByRole('textbox', { name: /to/i }), 'bo@example.com{Enter}')
    await user.type(subjectField(), 'Subject')

    await user.click(screen.getByRole('button', { name: 'Send' }))
    await waitFor(() => expect(body).toHaveAttribute('contenteditable', 'false'))
    rejectSend?.(new Error('offline'))
    await waitFor(() => expect(body).toHaveAttribute('contenteditable', 'true'))
    expect(body).toHaveTextContent('body')

    const editor = EditorView.findFromDOM(body)!
    editor.dispatch({ changes: { from: editor.state.doc.length, insert: ' latest' } })
    expect(await handle.current!.prepareToLeave()).toBe(true)
    expect(saveDraft.mock.calls.at(-1)![0]).toMatchObject({ mail: { body: 'body latest' } })
  })

  it('keeps the composer when the leave save fails', async () => {
    const user = setup()
    const handle = createRef<MailComposerHandle>()
    saveDraft.mockRejectedValue(new Error('offline'))
    await mount({ ref: handle })
    await user.type(subjectField(), ' latest')

    expect(await handle.current!.prepareToLeave()).toBe(false)
    expect(subjectField()).toHaveValue('Re: Q2 budget latest')
    expect(subjectField()).not.toBeDisabled()
    await waitFor(() => expect(saveState()).toBe('Not saved'))
    expect(send).not.toHaveBeenCalled()
  })
})

describe('Bcc recipients', () => {
  it('autosaves and sends committed Bcc recipients in the payload', async () => {
    const user = setup()
    await mount({ intent: { kind: 'new' } })
    await user.type(screen.getByRole('textbox', { name: /to/i }), 'bo@example.com{Enter}')
    await user.click(screen.getByRole('button', { name: 'Bcc' }))
    await user.type(screen.getByRole('textbox', { name: 'Bcc' }), 'hidden@example.com{Enter}')
    await user.type(subjectField(), 'Bcc payload')

    await vi.advanceTimersByTimeAsync(2000)
    await waitFor(() => expect(saveDraft).toHaveBeenCalledOnce())
    expect(saveDraft.mock.calls[0]![0]).toMatchObject({ mail: { bcc: ['hidden@example.com'] } })

    await user.click(screen.getByRole('button', { name: 'Send' }))
    await waitFor(() => expect(send).toHaveBeenCalledOnce())
    expect(send.mock.calls[0]![0]).toMatchObject({ mail: { bcc: ['hidden@example.com'] } })
  })

  it('keeps the Bcc reveal button disabled while a draft is loading', async () => {
    let resolveDraft!: (draft: unknown) => void
    draftQuery.mockImplementationOnce(() => new Promise((resolve) => (resolveDraft = resolve)))
    await mount({ intent: { kind: 'new' }, draftId: 'd-7' })

    const reveal = screen.getByRole('button', { name: 'Bcc' })
    expect(reveal).toBeDisabled()
    await setup().click(reveal)
    expect(screen.queryByRole('textbox', { name: 'Bcc' })).not.toBeInTheDocument()

    resolveDraft({
      draftId: 'd-7',
      threadId: null,
      to: [],
      cc: [],
      bcc: [],
      subject: '',
      markdown: '',
      html: null,
      foreign: false,
    })
    await waitFor(() => expect(reveal).not.toBeDisabled())
  })

  it('does not accept Bcc edits while sending', async () => {
    const user = setup()
    let resolveSend!: (value: { id: string }) => void
    send.mockImplementationOnce(() => new Promise((resolve) => (resolveSend = resolve)))
    await mount({ intent: { kind: 'new' } })
    await user.type(subjectField(), 'Bcc send guard')
    await user.type(screen.getByRole('textbox', { name: /to/i }), 'bo@example.com{Enter}')
    await user.click(screen.getByRole('button', { name: 'Bcc' }))
    const bcc = screen.getByRole('textbox', { name: 'Bcc' })
    await user.type(bcc, 'hidden@example.com{Enter}')
    await user.click(screen.getByRole('button', { name: 'Send' }))

    await waitFor(() => expect(bcc).toBeDisabled())
    expect(send.mock.calls[0]![0]).toMatchObject({ mail: { bcc: ['hidden@example.com'] } })
    resolveSend({ id: 'm-9' })
  })

  it('does not accept Bcc edits while departure saves are pending', async () => {
    const user = setup()
    const handle = createRef<MailComposerHandle>()
    let resolveSave!: (value: { id: string }) => void
    saveDraft.mockImplementationOnce(() => new Promise((resolve) => (resolveSave = resolve)))
    await mount({ intent: { kind: 'new' }, ref: handle })
    await user.type(screen.getByRole('textbox', { name: /to/i }), 'bo@example.com{Enter}')
    await user.click(screen.getByRole('button', { name: 'Bcc' }))
    await user.type(screen.getByRole('textbox', { name: 'Bcc' }), 'hidden@example.com{Enter}')

    const leaving = handle.current!.prepareToLeave()
    await waitFor(() => expect(screen.getByRole('textbox', { name: 'Bcc' })).toBeDisabled())
    expect(saveDraft.mock.calls[0]![0]).toMatchObject({ mail: { bcc: ['hidden@example.com'] } })
    resolveSave({ id: 'd-1' })
    expect(await leaving).toBe(true)
  })

  it('does not accept Bcc edits while discarding a draft', async () => {
    const user = setup()
    let resolveDiscard!: () => void
    discardDraft.mockImplementationOnce(
      () => new Promise<void>((resolve) => (resolveDiscard = resolve)),
    )
    draftQuery.mockResolvedValueOnce({
      draftId: 'd-7',
      threadId: null,
      to: [{ email: 'bo@example.com', name: 'bo@example.com' }],
      cc: [],
      bcc: [{ email: 'hidden@example.com', name: 'hidden@example.com' }],
      subject: 'Subject',
      markdown: '',
      html: null,
      foreign: false,
    })
    await mount({ intent: { kind: 'new' }, draftId: 'd-7' })
    const bcc = await screen.findByRole('textbox', { name: 'Bcc' })
    await user.click(screen.getByRole('button', { name: 'Discard' }))
    await user.click(screen.getByRole('button', { name: 'Discard draft' }))

    await waitFor(() => expect(bcc).toBeDisabled())
    expect(bcc).toHaveValue('')
    resolveDiscard()
  })
})

describe('autosave', () => {
  it('saves once after the idle wait, not on every keystroke', async () => {
    const user = setup()
    await mount()

    await user.type(subjectField(), 'abc')
    expect(saveDraft).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(2000)

    expect(saveDraft).toHaveBeenCalledTimes(1)
  })

  it('creates exactly one draft, never two', async () => {
    // The fork. Without single-flight, a second edit landing while the create
    // is in flight creates a SECOND draft, because `draftId` is not known yet.
    const user = setup()
    let resolve: ((value: { id: string }) => void) | undefined
    saveDraft.mockImplementationOnce(
      () =>
        new Promise<{ id: string }>((r) => {
          resolve = r
        }),
    )
    await mount()

    await user.type(subjectField(), 'a')
    await vi.advanceTimersByTimeAsync(2000)
    expect(saveDraft).toHaveBeenCalledTimes(1)

    // A further edit while the create is still in flight.
    await user.type(subjectField(), 'b')
    await vi.advanceTimersByTimeAsync(2000)
    expect(saveDraft).toHaveBeenCalledTimes(1)

    resolve?.({ id: 'd-1' })

    await waitFor(() => expect(saveDraft).toHaveBeenCalledTimes(2))
    // And the second call UPDATES the draft the first one created.
    expect(saveDraft.mock.calls[1]![0]).toMatchObject({ draftId: 'd-1' })
  })

  it('does not lose an edit made while a save was in flight', async () => {
    // The subtle half of single-flight: marking the draft clean when the
    // request returns would skip the queued save for text typed *during* it.
    const user = setup()
    let resolve: ((value: { id: string }) => void) | undefined
    saveDraft.mockImplementationOnce(
      () =>
        new Promise<{ id: string }>((r) => {
          resolve = r
        }),
    )
    await mount()

    await user.type(subjectField(), 'first')
    await vi.advanceTimersByTimeAsync(2000)
    await user.type(subjectField(), '-second')
    await vi.advanceTimersByTimeAsync(2000)

    resolve?.({ id: 'd-1' })

    await waitFor(() => expect(saveDraft).toHaveBeenCalledTimes(2))
    const saved = saveDraft.mock.calls[1]![0] as { mail: { subject: string } }
    expect(saved.mail.subject).toContain('-second')
    await waitFor(() => expect(saveState()).toBe('Saved'))
  })

  it('coalesces two edits inside the idle window into one save', async () => {
    const user = setup()
    await mount()

    await user.type(subjectField(), 'a')
    await vi.advanceTimersByTimeAsync(1000)
    await user.type(subjectField(), 'b')
    await vi.advanceTimersByTimeAsync(2000)

    expect(saveDraft).toHaveBeenCalledTimes(1)
  })

  it('reports Saved, and carries the thread so the cached chip can appear', async () => {
    const user = setup()
    await mount()

    await user.type(subjectField(), 'a')
    await vi.advanceTimersByTimeAsync(2000)

    await waitFor(() => expect(saveState()).toBe('Saved'))
    expect(saveDraft.mock.calls[0]![0]).toMatchObject({ threadId: 't1' })
  })

  /**
   * The thread a continued draft belongs to comes from the draft, not from the
   * intent: `continueDraft` opens every draft as `new`. Without it every
   * autosave rebuilds the draft with no `In-Reply-To`, moving a reply out of
   * its conversation.
   */
  it('keeps a continued draft in the thread it belongs to', async () => {
    const user = setup()
    draftQuery.mockResolvedValue({
      draftId: 'd-4',
      threadId: 't7',
      to: [{ name: 'Bo', email: 'bo@example.com' }],
      cc: [],
      subject: 'Re: Q2 budget',
      markdown: 'half a reply',
      html: '<p>half a reply</p>',
      text: 'half a reply',
      foreign: false,
    })
    await mount({ intent: { kind: 'new' }, draftId: 'd-4' })
    await waitFor(() => expect(subjectField()).toHaveValue('Re: Q2 budget'))

    await user.type(subjectField(), '!')
    await vi.advanceTimersByTimeAsync(2000)

    expect(saveDraft.mock.calls[0]![0]).toMatchObject({ draftId: 'd-4', threadId: 't7' })
  })

  it('says Not saved and keeps the text when the save is refused', async () => {
    const user = setup()
    saveDraft.mockRejectedValue(new Error('offline'))
    await mount()

    await user.type(subjectField(), 'hello')
    await vi.advanceTimersByTimeAsync(2000)

    await waitFor(() => expect(saveState()).toBe('Not saved'))
    expect(subjectField()).toHaveValue('Re: Q2 budgethello')
  })

  it('does not treat a save without an id as durable', async () => {
    const user = setup()
    const handle = createRef<MailComposerHandle>()
    saveDraft.mockResolvedValueOnce({ id: null })
    await mount({ intent: { kind: 'new' }, ref: handle })
    await user.type(subjectField(), 'draft')

    expect(await handle.current!.prepareToLeave()).toBe(false)
    expect(subjectField()).not.toBeDisabled()
    expect(send).not.toHaveBeenCalled()
  })

  it('retries a refused save on the next edit', async () => {
    const user = setup()
    saveDraft.mockRejectedValueOnce(new Error('offline'))
    await mount()
    await user.type(subjectField(), 'a')
    await vi.advanceTimersByTimeAsync(2000)
    await waitFor(() => expect(saveState()).toBe('Not saved'))

    await user.type(subjectField(), 'b')
    await vi.advanceTimersByTimeAsync(2000)

    await waitFor(() => expect(saveState()).toBe('Saved'))
  })
})

describe('operation-specific retries', () => {
  it('retries a failed discard of a saved draft without saving or sending', async () => {
    const user = setup()
    draftQuery.mockResolvedValue({
      draftId: 'd-1',
      threadId: 't1',
      to: [],
      cc: [],
      subject: 'Draft',
      markdown: 'saved body',
      html: '<p>saved body</p>',
      text: 'saved body',
      foreign: false,
    })
    discardDraft.mockRejectedValueOnce(new Error('offline'))
    await mount({ intent: { kind: 'new' }, draftId: 'd-1' })
    await waitFor(() => expect(subjectField()).toHaveValue('Draft'))

    await user.click(screen.getByRole('button', { name: 'Discard' }))
    await user.click(screen.getByRole('button', { name: 'Discard draft' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument())
    expect(subjectField()).not.toBeDisabled()

    await user.click(screen.getByRole('button', { name: 'Retry' }))
    await waitFor(() => expect(discardDraft).toHaveBeenCalledTimes(2))
    expect(saveDraft).not.toHaveBeenCalled()
    expect(send).not.toHaveBeenCalled()
  })

  it('retries a dirty draft discard instead of saving it', async () => {
    const user = setup()
    draftQuery.mockResolvedValue({
      draftId: 'd-1',
      threadId: 't1',
      to: [],
      cc: [],
      subject: 'Draft',
      markdown: 'saved body',
      html: '<p>saved body</p>',
      text: 'saved body',
      foreign: false,
    })
    discardDraft.mockRejectedValueOnce(new Error('offline'))
    await mount({ intent: { kind: 'new' }, draftId: 'd-1' })
    await waitFor(() => expect(subjectField()).toHaveValue('Draft'))
    await user.type(subjectField(), ' edited')
    await user.click(screen.getByRole('button', { name: 'Discard' }))
    await user.click(screen.getByRole('button', { name: 'Discard draft' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument())

    const savesBeforeRetry = saveDraft.mock.calls.length
    await user.click(screen.getByRole('button', { name: 'Retry' }))
    await waitFor(() => expect(discardDraft).toHaveBeenCalledTimes(2))
    expect(saveDraft).toHaveBeenCalledTimes(savesBeforeRetry)
    expect(send).not.toHaveBeenCalled()
  })

  it('explicitly retries a send whose outcome is unknown', async () => {
    const user = setup()
    send.mockRejectedValueOnce(new Error('offline'))
    await mount()

    await user.click(screen.getByRole('button', { name: 'Send' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument())
    expect(send).toHaveBeenCalledTimes(1)

    await user.click(screen.getByRole('button', { name: 'Retry' }))
    await waitFor(() => expect(send).toHaveBeenCalledTimes(2))
  })

  it('retries only the save when a send is blocked by save failure', async () => {
    const user = setup()
    saveDraft.mockRejectedValueOnce(new Error('offline'))
    await mount()
    await user.type(subjectField(), ' latest')
    await user.click(screen.getByRole('button', { name: 'Send' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument())
    expect(saveDraft).toHaveBeenCalledTimes(1)
    expect(send).not.toHaveBeenCalled()

    await user.click(screen.getByRole('button', { name: 'Retry' }))
    await waitFor(() => expect(saveDraft).toHaveBeenCalledTimes(2))
    expect(send).not.toHaveBeenCalled()
  })
})

describe('sending', () => {
  it('refuses to send with no recipients, and says why', async () => {
    await mount({ intent: { kind: 'new' } })

    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled()
    expect(screen.getByText('Add a recipient')).toBeInTheDocument()
  })

  it('sends, and reports the result', async () => {
    const user = setup()
    const { onSent } = await mount()

    await user.click(screen.getByRole('button', { name: 'Send' }))

    await waitFor(() => expect(onSent).toHaveBeenCalledWith({ id: 'm-9' }))
    expect(send.mock.calls[0]![0]).toMatchObject({ threadId: 't1' })
  })

  it('asks once before sending without a subject, then sends', async () => {
    // A new message, not a reply: `composeFrom` prefixes a reply with `Re:`, so
    // a reply can never actually reach Send with an empty subject.
    const user = setup()
    await mount({ intent: { kind: 'new' } })
    await user.type(screen.getByRole('textbox', { name: /to/i }), 'bo@example.com{Enter}')

    await user.click(screen.getByRole('button', { name: 'Send' }))
    expect(send).not.toHaveBeenCalled()
    expect(screen.getByText('Send without a subject?')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Send anyway' }))

    await waitFor(() => expect(send).toHaveBeenCalledTimes(1))
  })

  it('sends an empty body without complaint', async () => {
    const user = setup()
    await mount({ intent: { kind: 'new' }, sendAs: [] })
    await user.type(screen.getByRole('textbox', { name: /to/i }), 'bo@example.com{Enter}')
    // A subject, so the empty-SUBJECT confirmation does not intercept the
    // empty BODY this test is about.
    await user.type(subjectField(), 'Quick one')

    await user.click(screen.getByRole('button', { name: 'Send' }))

    await waitFor(() => expect(send).toHaveBeenCalledTimes(1))
  })

  it('forces a save before sending, so the newest text is what goes', async () => {
    const user = setup()
    await mount()
    await user.type(subjectField(), 'x')

    await user.click(screen.getByRole('button', { name: 'Send' }))

    await waitFor(() => expect(send).toHaveBeenCalled())
    expect(saveDraft).toHaveBeenCalled()
  })

  /**
   * Send racing the autosave. If Send does not await the in-flight save chain,
   * it goes out with `draftId` still unknown, main takes the compose branch,
   * and the user gets a sent message AND an orphan draft.
   */
  it('waits for an in-flight save, so the send is of the draft rather than a second message', async () => {
    const user = setup()
    let resolve: ((value: { id: string }) => void) | undefined
    saveDraft.mockImplementationOnce(
      () =>
        new Promise<{ id: string }>((r) => {
          resolve = r
        }),
    )
    await mount()

    await user.type(subjectField(), 'a')
    await vi.advanceTimersByTimeAsync(2000)
    expect(saveDraft).toHaveBeenCalledTimes(1) // the create is on the wire

    await user.type(subjectField(), 'b') // dirty again, mid-flight
    const clicked = user.click(screen.getByRole('button', { name: 'Send' }))
    await vi.advanceTimersByTimeAsync(0)
    expect(send).not.toHaveBeenCalled() // still waiting on the save

    resolve?.({ id: 'd-1' })
    await clicked

    await waitFor(() => expect(send).toHaveBeenCalledTimes(1))
    expect(send.mock.calls[0]![0]).toMatchObject({ draftId: 'd-1' })
  })

  it('offers Reconnect for a scope failure, and keeps the text', async () => {
    const user = setup()
    send.mockRejectedValue(Object.assign(new Error('nope'), { data: { code: 'FORBIDDEN' } }))
    const onReconnect = vi.fn()
    const { onSent } = await mount({ onReconnect })

    await user.click(screen.getByRole('button', { name: 'Send' }))

    await waitFor(() => expect(screen.getByRole('button', { name: 'Reconnect' })).toBeVisible())
    expect(onSent).not.toHaveBeenCalled()
    expect(subjectField()).toHaveValue('Re: Q2 budget')
  })

  it('offers Retry for a rate limit, but never retries by itself', async () => {
    // The failure mode of a send is a duplicate arriving at a real person.
    const user = setup()
    send.mockRejectedValue(
      Object.assign(new Error('slow down'), { data: { code: 'TOO_MANY_REQUESTS' } }),
    )
    await mount()

    await user.click(screen.getByRole('button', { name: 'Send' }))

    await waitFor(() => expect(screen.getByRole('button', { name: 'Retry' })).toBeVisible())
    expect(send).toHaveBeenCalledTimes(1)
  })

  it('offers an explicit retry for an unexplained send failure without retrying by itself', async () => {
    const user = setup()
    send.mockRejectedValueOnce(new Error('something went wrong'))
    await mount()

    await user.click(screen.getByRole('button', { name: 'Send' }))

    await waitFor(() => expect(screen.getByText('something went wrong')).toBeVisible())
    expect(screen.getByRole('button', { name: 'Retry' })).toBeVisible()
    expect(send).toHaveBeenCalledTimes(1)

    await user.click(screen.getByRole('button', { name: 'Retry' }))
    await waitFor(() => expect(send).toHaveBeenCalledTimes(2))
  })
})

describe('an existing draft with Bcc recipients', () => {
  it('shows Bcc and carries it through autosave and send', async () => {
    draftQuery.mockResolvedValue({
      draftId: 'd-1',
      threadId: null,
      to: [{ name: 'Bo', email: 'bo@example.com' }],
      cc: [],
      bcc: [{ name: 'Archive', email: 'hidden@example.com' }],
      subject: 'Draft',
      markdown: 'Body',
      html: '<p>Body</p>',
      text: 'Body',
      foreign: false,
    })
    const user = setup()
    await mount({ intent: { kind: 'new' }, draftId: 'd-1' })

    await screen.findByRole('textbox', { name: 'Bcc' })
    expect(screen.getByText('hidden@example.com')).toBeInTheDocument()

    await user.type(subjectField(), '!')
    await vi.advanceTimersByTimeAsync(2_000)
    await waitFor(() => expect(saveDraft).toHaveBeenCalled())
    expect(saveDraft.mock.calls[0]?.[0]).toMatchObject({
      draftId: 'd-1',
      mail: { bcc: ['hidden@example.com'] },
    })

    await user.click(screen.getByRole('button', { name: 'Send' }))
    await waitFor(() => expect(send).toHaveBeenCalled())
    expect(send.mock.calls.at(-1)?.[0]).toMatchObject({
      draftId: 'd-1',
      mail: { bcc: ['hidden@example.com'] },
    })
  })
})

describe('a draft written outside Holi', () => {
  it('converts it, says so, and leaves it editable', async () => {
    // No draft is ever read-only.
    draftQuery.mockResolvedValue({
      draftId: 'd-7',
      threadId: null,
      to: [{ name: 'Bo', email: 'bo@example.com' }],
      cc: [],
      subject: 'Written in Gmail',
      markdown: null,
      html: '<p>Hello <strong>there</strong></p>',
      foreign: true,
    })
    await mount({ intent: { kind: 'new' }, draftId: 'd-7' })

    await waitFor(() => expect(screen.getByTestId('foreign-notice')).toBeVisible())
    expect(subjectField()).toHaveValue('Written in Gmail')
    expect(subjectField()).not.toBeDisabled()
    expect(screen.queryByText(/read.only/i)).toBeNull()
  })

  it('shows the loaded body in the editor', async () => {
    // The body arrives after the editor has mounted, so the editor has to take it.
    draftQuery.mockResolvedValue({
      draftId: 'd-7',
      threadId: null,
      to: [],
      cc: [],
      subject: 'Written in Gmail',
      markdown: 'Hello from the draft',
      html: null,
      foreign: false,
    })
    await mount({ intent: { kind: 'new' }, draftId: 'd-7' })

    await waitFor(() => expect(subjectField()).toHaveValue('Written in Gmail'))
    await waitFor(() =>
      expect(screen.getByTestId('mail-body')).toHaveTextContent('Hello from the draft'),
    )
    expect(screen.getByRole('textbox', { name: /to/i })).toHaveFocus()
  })

  it('does not save a loaded draft back over itself before it is touched', async () => {
    // Loading is not an edit: saving would replace a foreign draft's original
    // formatting before the user did anything.
    draftQuery.mockResolvedValue({
      draftId: 'd-7',
      threadId: null,
      to: [],
      cc: [],
      subject: 'Written in Gmail',
      markdown: null,
      html: '<p>Hello</p>',
      foreign: true,
    })
    await mount({ intent: { kind: 'new' }, draftId: 'd-7' })
    await waitFor(() => expect(screen.getByTestId('foreign-notice')).toBeVisible())

    await vi.advanceTimersByTimeAsync(10_000)

    expect(saveDraft).not.toHaveBeenCalled()
  })

  /**
   * A draft with no `text/html` part at all, as a plain-text client writes.
   * `html` and `markdown` are both null, so converting the html would open blank
   * and the first keystroke would autosave that over the user's message.
   */
  it('opens a plain-text foreign draft with its text, not blank', async () => {
    const user = setup()
    draftQuery.mockResolvedValue({
      draftId: 'd-9',
      threadId: null,
      to: [],
      cc: [],
      subject: 'From the agent',
      markdown: null,
      html: null,
      text: 'a short poem about a turtle',
      foreign: true,
    })
    await mount({ intent: { kind: 'new' }, draftId: 'd-9' })
    await waitFor(() => expect(screen.getByTestId('foreign-notice')).toBeVisible())

    await user.type(subjectField(), '!')
    await vi.advanceTimersByTimeAsync(2000)

    expect(saveDraft.mock.calls[0]![0]).toMatchObject({
      mail: { body: 'a short poem about a turtle' },
    })
  })

  it('shows no notice for a draft Holi wrote, and uses its markdown verbatim', async () => {
    draftQuery.mockResolvedValue({
      draftId: 'd-8',
      threadId: null,
      to: [],
      cc: [],
      subject: 'Ours',
      markdown: '**bold**',
      html: '<p><strong>bold</strong></p>',
      foreign: false,
    })
    await mount({ intent: { kind: 'new' }, draftId: 'd-8' })

    await waitFor(() => expect(subjectField()).toHaveValue('Ours'))
    expect(screen.queryByTestId('foreign-notice')).toBeNull()
  })
})

describe('discarding', () => {
  it('does not discard a pristine reply while send is in flight', async () => {
    const user = setup()
    const { onDiscarded } = await mount()
    let resolveSend: ((value: { id: string }) => void) | undefined
    send.mockImplementationOnce(
      () =>
        new Promise<{ id: string }>((resolve) => {
          resolveSend = resolve
        }),
    )

    await user.click(screen.getByRole('button', { name: 'Send' }))
    await user.click(screen.getByRole('button', { name: 'Discard' }))

    expect(onDiscarded).not.toHaveBeenCalled()
    expect(send).toHaveBeenCalledTimes(1)
    expect(discardDraft).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'Discard' })).toBeDisabled()
    resolveSend?.({ id: 'm-9' })
    await waitFor(() => expect(onDiscarded).not.toHaveBeenCalled())
  })
  it('asks before discarding a draft that exists', async () => {
    const user = setup()
    const { onDiscarded } = await mount()
    await user.type(subjectField(), 'a')
    await vi.advanceTimersByTimeAsync(2000)
    await waitFor(() => expect(saveState()).toBe('Saved'))

    await user.click(screen.getByRole('button', { name: 'Discard' }))
    expect(discardDraft).not.toHaveBeenCalled()

    await user.click(screen.getByRole('button', { name: 'Discard draft' }))
    await waitFor(() => expect(onDiscarded).toHaveBeenCalled())
    expect(discardDraft).toHaveBeenCalledWith({
      draftId: 'd-1',
      threadId: 't1',
      expectedAccountSub: 'sub-1',
    })
  })

  /**
   * A failed discard leaves the draft in Gmail, so the composer must stay open
   * and show the failure rather than close as if the draft were gone.
   */
  it('refuses to leave while discard is in flight', async () => {
    const user = setup()
    const handle = createRef<MailComposerHandle>()
    let resolveDiscard: (() => void) | undefined
    discardDraft.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolveDiscard = resolve
        }),
    )
    await mount({ ref: handle })
    await user.type(subjectField(), 'a')
    await vi.advanceTimersByTimeAsync(2000)
    await waitFor(() => expect(saveState()).toBe('Saved'))

    await user.click(screen.getByRole('button', { name: 'Discard' }))
    const discarding = user.click(screen.getByRole('button', { name: 'Discard draft' }))
    await vi.advanceTimersByTimeAsync(0)
    expect(await handle.current!.prepareToLeave()).toBe(false)
    expect(subjectField()).toBeDisabled()
    resolveDiscard?.()
    await discarding
  })

  it('stays open and says so when the discard is refused', async () => {
    const user = setup()
    discardDraft.mockRejectedValue(new Error('offline'))
    const { onDiscarded } = await mount()
    await user.type(subjectField(), 'a')
    await vi.advanceTimersByTimeAsync(2000)
    await waitFor(() => expect(saveState()).toBe('Saved'))

    await user.click(screen.getByRole('button', { name: 'Discard' }))
    await user.click(screen.getByRole('button', { name: 'Discard draft' }))

    await waitFor(() => expect(screen.getByRole('region', { name: 'Compose mail' })).toBeVisible())
    expect(onDiscarded).not.toHaveBeenCalled()
    expect(subjectField()).toHaveValue('Re: Q2 budgeta')
  })

  it('does not save the draft it just deleted back into existence', async () => {
    // After a discard the unmount save would be a `create` for the message the
    // user just threw away.
    const user = setup()
    const { onDiscarded, unmount } = await mount()
    await user.type(subjectField(), 'a')
    await vi.advanceTimersByTimeAsync(2000)
    await waitFor(() => expect(saveState()).toBe('Saved'))
    await user.type(subjectField(), 'b') // dirty again

    await user.click(screen.getByRole('button', { name: 'Discard' }))
    await user.click(screen.getByRole('button', { name: 'Discard draft' }))
    await waitFor(() => expect(onDiscarded).toHaveBeenCalled())

    // The parent removes the composer once it hears back — which is what runs
    // the unmount save.
    saveDraft.mockClear()
    unmount()
    await vi.advanceTimersByTimeAsync(10_000)

    expect(saveDraft).not.toHaveBeenCalled()
  })

  it('Keep forces a save instead of losing the text', async () => {
    const user = setup()
    await mount()
    await user.type(subjectField(), 'a')

    await user.click(screen.getByRole('button', { name: 'Discard' }))
    await user.click(screen.getByRole('button', { name: 'Keep' }))

    await waitFor(() => expect(saveDraft).toHaveBeenCalled())
  })

  it('refuses to close on Escape once something has been typed', async () => {
    const user = setup()
    const { onClose } = await mount()
    await user.type(subjectField(), 'a')

    await user.keyboard('{Escape}')

    await waitFor(() => expect(onClose).toHaveBeenCalled())
  })
})

describe('the preview', () => {
  it('renders the markdown rather than describing it', async () => {
    const user = setup()
    await mount({}, true)
    await user.click(screen.getByRole('textbox', { name: 'Message' }))
    expect(screen.getByTestId('vim-mode')).toBeInTheDocument()

    await user.click(screen.getByRole('radio', { name: 'Preview' }))

    expect(screen.getByLabelText('Preview of your message')).toBeInTheDocument()
    expect(screen.queryByTestId('vim-mode')).not.toBeInTheDocument()
  })
})

describe('Vim in compose fields', () => {
  it('keeps subject commands out of compose actions and insert-mode keys editable', async () => {
    const user = setup()
    const { onClose } = await mount({ intent: { kind: 'new' } }, true)
    const subject = subjectField()
    await user.click(subject)

    await user.keyboard('{Escape}')
    expect(onClose).not.toHaveBeenCalled()
    await user.keyboard('f')
    expect(subject).toHaveValue('')
    expect(screen.getByLabelText('Vim normal mode')).toBeInTheDocument()
    await user.keyboard('if')
    expect(subject).toHaveValue('f')
    await user.keyboard('{Escape}')
    await user.keyboard('f')

    expect(subject).toHaveValue('f')
    expect(onClose).not.toHaveBeenCalled()
    expect(send).not.toHaveBeenCalled()
    expect(discardDraft).not.toHaveBeenCalled()
  })

  it('does not accept recipient chips or trigger compose actions in normal mode', async () => {
    const user = setup()
    const { onClose } = await mount(
      {
        intent: { kind: 'new' },
        suggestions: [{ name: 'Bo Berg', email: 'bo@example.com' }],
      },
      true,
    )
    const to = screen.getByRole('textbox', { name: 'To' })
    await user.type(to, 'bo@example.com')
    await user.keyboard('{Escape}{Enter}')

    expect(screen.queryAllByTestId('chip')).toHaveLength(0)
    expect(onClose).not.toHaveBeenCalled()
    expect(send).not.toHaveBeenCalled()

    await user.keyboard('i{Enter}')
    expect(screen.getByTestId('chip')).toHaveTextContent('bo@example.com')
  })
})

describe('Vim in the message body', () => {
  it('reserves mode-row space when focus leaves so action buttons do not move', async () => {
    const user = setup()
    await mount({ intent: { kind: 'new' } }, true)
    const body = screen.getByRole('textbox', { name: 'Message' })
    await user.click(body)
    const slot = screen.getByTestId('vim-mode-slot')
    expect(slot).toHaveClass('min-h-6')
    expect(screen.getByTestId('vim-mode')).toHaveTextContent('NORMAL')

    await user.click(subjectField())
    expect(screen.queryByTestId('vim-mode')).not.toBeInTheDocument()
    expect(screen.getByTestId('vim-mode-slot')).toBe(slot)
    expect(slot).toBeEmptyDOMElement()
  })

  it('restores mode disclosure after enabling Vim live and refocusing the body', async () => {
    const user = setup()
    const { store } = await mount({ intent: { kind: 'new' } })
    const body = screen.getByRole('textbox', { name: 'Message' })
    const editor = EditorView.findFromDOM(body)!
    await user.click(body)
    expect(screen.queryByTestId('vim-mode')).not.toBeInTheDocument()

    act(() => store.set(vimCodeEditingAtom, true))
    await waitFor(() => expect(screen.getByTestId('vim-mode')).toHaveTextContent('NORMAL'))
    await user.click(subjectField())
    expect(screen.queryByTestId('vim-mode')).not.toBeInTheDocument()
    await user.click(body)
    expect(screen.getByTestId('vim-mode')).toHaveTextContent('NORMAL')
    expect(EditorView.findFromDOM(body)).toBe(editor)

    await user.keyboard('i')
    await waitFor(() => expect(screen.getByTestId('vim-mode')).toHaveTextContent('INSERT'))
    await user.click(subjectField())
    await user.click(body)
    expect(screen.getByTestId('vim-mode')).toHaveTextContent('INSERT')
    expect(EditorView.findFromDOM(body)).toBe(editor)
  })

  it('edits through real keys and keeps the editor and undo history across preference changes', async () => {
    const user = setup()
    const { store } = await mount({ intent: { kind: 'new' } }, true)
    const body = screen.getByRole('textbox', { name: 'Message' })
    const editor = EditorView.findFromDOM(body)!
    await user.click(body)

    await user.keyboard('ihello')
    await user.keyboard('{Escape}')
    await waitFor(() => expect(getCM(editor)?.state.vim?.insertMode).toBe(false))
    expect(editor.state.doc.toString()).toBe('hello')
    expect(screen.getByTestId('vim-mode')).toHaveTextContent('NORMAL')

    act(() => store.set(vimCodeEditingAtom, false))
    expect(EditorView.findFromDOM(body)).toBe(editor)
    expect(editor.state.doc.toString()).toBe('hello')
    expect(screen.queryByTestId('vim-mode')).not.toBeInTheDocument()

    act(() => store.set(vimCodeEditingAtom, true))
    expect(EditorView.findFromDOM(body)).toBe(editor)
    expect(editor.state.doc.toString()).toBe('hello')
    expect(undo(editor)).toBe(true)
    expect(editor.state.doc.toString()).toBe('')
  })

  it('keeps normal-mode f out of the body while insert-mode f is text', async () => {
    const user = setup()
    await mount({ intent: { kind: 'new' } }, true)
    const body = screen.getByRole('textbox', { name: 'Message' })
    const editor = EditorView.findFromDOM(body)!
    await user.click(body)

    await user.keyboard('f')
    expect(editor.state.doc.toString()).toBe('')
    await user.keyboard('if')
    expect(editor.state.doc.toString()).toBe('f')
    await user.click(subjectField())
    expect(screen.queryByTestId('vim-mode')).not.toBeInTheDocument()
    await user.keyboard('f')
    expect(editor.state.doc.toString()).toBe('f')
  })

  it('keeps the same Vim editor when a pending send makes the body readonly', async () => {
    const user = setup()
    let resolveSend: ((result: { id: string }) => void) | undefined
    send.mockImplementationOnce(
      () =>
        new Promise<{ id: string }>((resolve) => {
          resolveSend = resolve
        }),
    )
    await mount({ intent: { kind: 'new' } }, true)
    await user.type(screen.getByRole('textbox', { name: /to/i }), 'bo@example.com{Enter}')
    await user.type(subjectField(), 'Subject')
    const body = screen.getByRole('textbox', { name: 'Message' })
    const editor = EditorView.findFromDOM(body)!
    await user.click(body)
    await user.keyboard('ihello{Escape}')
    await user.click(screen.getByRole('button', { name: 'Send' }))
    await waitFor(() => expect(body).toHaveAttribute('contenteditable', 'false'))

    expect(EditorView.findFromDOM(body)).toBe(editor)
    expect(editor.state.doc.toString()).toBe('hello')
    expect(screen.queryByTestId('vim-mode')).not.toBeInTheDocument()
    resolveSend?.({ id: 'm-9' })
  })

  it('keeps Vim find motions available after an operator prefix', async () => {
    const user = setup()
    await mount({ intent: { kind: 'new' } }, true)
    const body = screen.getByRole('textbox', { name: 'Message' })
    const editor = EditorView.findFromDOM(body)!
    await user.click(body)

    await user.keyboard('iabcxdef{Escape}0dfx')

    expect(editor.state.doc.toString()).toBe('def')
  })

  it('reports visual mode and uses the first Escape for Vim before close', async () => {
    const user = setup()
    const { onClose } = await mount({ intent: { kind: 'new' } }, true)
    const body = screen.getByRole('textbox', { name: 'Message' })
    const editor = EditorView.findFromDOM(body)!
    await user.click(body)

    await user.keyboard('iword')
    await user.keyboard('{Escape}')
    expect(onClose).not.toHaveBeenCalled()
    expect(getCM(editor)?.state.vim?.insertMode).toBe(false)
    await user.keyboard('v')
    await waitFor(() => expect(screen.getByTestId('vim-mode')).toHaveTextContent('VISUAL'))
    await user.keyboard('{Escape}')
    expect(onClose).not.toHaveBeenCalled()
    expect(getCM(editor)?.state.vim?.visualMode).toBe(false)
    await user.keyboard('{Control>}z{/Control}')
    expect(editor.state.doc.toString()).toBe('')
    await user.keyboard('{Escape}')
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce())
  })
})
