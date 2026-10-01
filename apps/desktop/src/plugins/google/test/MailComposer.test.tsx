/**
 * The composer.
 *
 * The tests that matter here are about *drafts that should not exist* and
 * *drafts that should not fork*: both surface later in Gmail as half-written
 * messages the user does not remember making.
 *
 * The body editor is CodeMirror and is exercised in
 * core's `editor/__tests__/plain-markdown-extensions.test.tsx`; dirtiness is driven
 * here through the header fields, which is the same state machine.
 */
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getDefaultStore } from 'jotai'
import { MailComposer } from '../renderer/MailComposer'
import { activeRemoteAtom } from '@/plugin-api'
import type { ComposeIntent } from '../renderer/compose-intent'
import type { ThreadMessage } from '../renderer/mail-types'

const saveDraft = vi.fn()
const send = vi.fn()
const discardDraft = vi.fn()
const draftQuery = vi.fn()

/** Google's capabilities, by name, through the UI door. */
const google: Record<string, (params: unknown) => unknown> = {
  'google.saveDraft': (p) => saveDraft(p),
  'google.send': (p) => send(p),
  'google.discardDraft': (p) => discardDraft(p),
  'google.draftBody': (p) => draftQuery(p),
}

vi.mock('@/lib/trpc', () => ({
  trpc: {
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

function mount(props: Partial<React.ComponentProps<typeof MailComposer>> = {}) {
  const onSent = vi.fn()
  const onDiscarded = vi.fn()
  const onClose = vi.fn()
  const { unmount } = render(
    <MailComposer
      intent={REPLY}
      sendAs={['ada@syv.ai']}
      onSent={onSent}
      onDiscarded={onDiscarded}
      onClose={onClose}
      {...props}
    />,
  )
  return { onSent, onDiscarded, onClose, unmount }
}

const subjectField = (): HTMLElement => screen.getByRole('textbox', { name: 'Subject' })
const saveState = (): string => screen.getByTestId('save-state').textContent ?? ''

beforeEach(() => {
  vi.clearAllMocks()
  // The composer writes in the vault open when it mounts.
  getDefaultStore().set(activeRemoteAtom, 'syv-ai/vault')
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

describe('the pristine guard', () => {
  it('creates no draft when the composer is opened and closed untouched', async () => {
    // A reply composer opens pre-filled with a quote, so "has content" is not
    // the same question as "the user wrote something".
    const { onClose } = mount()

    await vi.advanceTimersByTimeAsync(10_000)

    expect(saveDraft).not.toHaveBeenCalled()
    expect(saveState()).toBe('')
    expect(onClose).not.toHaveBeenCalled()
  })

  it('closes without asking when nothing was typed', async () => {
    const user = setup()
    const { onClose } = mount()

    // Focus has to be inside the composer: Escape is handled on the section, so
    // an inline composer does not swallow the key for the reader around it.
    await user.click(subjectField())
    await user.keyboard('{Escape}')

    expect(onClose).toHaveBeenCalled()
  })
})

describe('autosave', () => {
  it('saves once after the idle wait, not on every keystroke', async () => {
    const user = setup()
    mount()

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
    mount()

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
    mount()

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
    mount()

    await user.type(subjectField(), 'a')
    await vi.advanceTimersByTimeAsync(1000)
    await user.type(subjectField(), 'b')
    await vi.advanceTimersByTimeAsync(2000)

    expect(saveDraft).toHaveBeenCalledTimes(1)
  })

  it('reports Saved, and carries the thread so the cached chip can appear', async () => {
    const user = setup()
    mount()

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
    mount({ intent: { kind: 'new' }, draftId: 'd-4' })
    await waitFor(() => expect(subjectField()).toHaveValue('Re: Q2 budget'))

    await user.type(subjectField(), '!')
    await vi.advanceTimersByTimeAsync(2000)

    expect(saveDraft.mock.calls[0]![0]).toMatchObject({ draftId: 'd-4', threadId: 't7' })
  })

  it('says Not saved and keeps the text when the save is refused', async () => {
    const user = setup()
    saveDraft.mockRejectedValue(new Error('offline'))
    mount()

    await user.type(subjectField(), 'hello')
    await vi.advanceTimersByTimeAsync(2000)

    await waitFor(() => expect(saveState()).toBe('Not saved'))
    expect(subjectField()).toHaveValue('Re: Q2 budgethello')
  })

  it('retries a refused save on the next edit', async () => {
    const user = setup()
    saveDraft.mockRejectedValueOnce(new Error('offline'))
    mount()
    await user.type(subjectField(), 'a')
    await vi.advanceTimersByTimeAsync(2000)
    await waitFor(() => expect(saveState()).toBe('Not saved'))

    await user.type(subjectField(), 'b')
    await vi.advanceTimersByTimeAsync(2000)

    await waitFor(() => expect(saveState()).toBe('Saved'))
  })
})

describe('sending', () => {
  it('refuses to send with no recipients, and says why', async () => {
    mount({ intent: { kind: 'new' } })

    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled()
    expect(screen.getByText('Add a recipient')).toBeInTheDocument()
  })

  it('sends, and reports the result', async () => {
    const user = setup()
    const { onSent } = mount()

    await user.click(screen.getByRole('button', { name: 'Send' }))

    await waitFor(() => expect(onSent).toHaveBeenCalledWith({ id: 'm-9' }))
    expect(send.mock.calls[0]![0]).toMatchObject({ threadId: 't1' })
  })

  it('asks once before sending without a subject, then sends', async () => {
    // A new message, not a reply: `composeFrom` prefixes a reply with `Re:`, so
    // a reply can never actually reach Send with an empty subject.
    const user = setup()
    mount({ intent: { kind: 'new' } })
    await user.type(screen.getByRole('textbox', { name: /to/i }), 'bo@example.com{Enter}')

    await user.click(screen.getByRole('button', { name: 'Send' }))
    expect(send).not.toHaveBeenCalled()
    expect(screen.getByText('Send without a subject?')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Send anyway' }))

    await waitFor(() => expect(send).toHaveBeenCalledTimes(1))
  })

  it('sends an empty body without complaint', async () => {
    const user = setup()
    mount({ intent: { kind: 'new' }, sendAs: [] })
    await user.type(screen.getByRole('textbox', { name: /to/i }), 'bo@example.com{Enter}')
    // A subject, so the empty-SUBJECT confirmation does not intercept the
    // empty BODY this test is about.
    await user.type(subjectField(), 'Quick one')

    await user.click(screen.getByRole('button', { name: 'Send' }))

    await waitFor(() => expect(send).toHaveBeenCalledTimes(1))
  })

  it('forces a save before sending, so the newest text is what goes', async () => {
    const user = setup()
    mount()
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
    mount()

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
    const { onSent } = mount({ onReconnect })

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
    mount()

    await user.click(screen.getByRole('button', { name: 'Send' }))

    await waitFor(() => expect(screen.getByRole('button', { name: 'Retry' })).toBeVisible())
    expect(send).toHaveBeenCalledTimes(1)
  })

  it('offers no retry at all for an unexplained failure', async () => {
    const user = setup()
    send.mockRejectedValue(new Error('something went wrong'))
    mount()

    await user.click(screen.getByRole('button', { name: 'Send' }))

    await waitFor(() => expect(screen.getByText('something went wrong')).toBeVisible())
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull()
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
    mount({ intent: { kind: 'new' }, draftId: 'd-7' })

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
    mount({ intent: { kind: 'new' }, draftId: 'd-7' })

    await waitFor(() => expect(subjectField()).toHaveValue('Written in Gmail'))
    await waitFor(() =>
      expect(screen.getByTestId('mail-body')).toHaveTextContent('Hello from the draft'),
    )
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
    mount({ intent: { kind: 'new' }, draftId: 'd-7' })
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
    mount({ intent: { kind: 'new' }, draftId: 'd-9' })
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
    mount({ intent: { kind: 'new' }, draftId: 'd-8' })

    await waitFor(() => expect(subjectField()).toHaveValue('Ours'))
    expect(screen.queryByTestId('foreign-notice')).toBeNull()
  })
})

describe('discarding', () => {
  it('asks before discarding a draft that exists', async () => {
    const user = setup()
    const { onDiscarded } = mount()
    await user.type(subjectField(), 'a')
    await vi.advanceTimersByTimeAsync(2000)
    await waitFor(() => expect(saveState()).toBe('Saved'))

    await user.click(screen.getByRole('button', { name: 'Discard' }))
    expect(discardDraft).not.toHaveBeenCalled()

    await user.click(screen.getByRole('button', { name: 'Discard draft' }))
    await waitFor(() => expect(onDiscarded).toHaveBeenCalled())
    expect(discardDraft).toHaveBeenCalledWith({ draftId: 'd-1', threadId: 't1' })
  })

  /**
   * A failed discard leaves the draft in Gmail, so the composer must stay open
   * and show the failure rather than close as if the draft were gone.
   */
  it('stays open and says so when the discard is refused', async () => {
    const user = setup()
    discardDraft.mockRejectedValue(new Error('offline'))
    const { onDiscarded } = mount()
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
    const { onDiscarded, unmount } = mount()
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
    mount()
    await user.type(subjectField(), 'a')

    await user.click(screen.getByRole('button', { name: 'Discard' }))
    await user.click(screen.getByRole('button', { name: 'Keep' }))

    await waitFor(() => expect(saveDraft).toHaveBeenCalled())
  })

  it('refuses to close on Escape once something has been typed', async () => {
    const user = setup()
    const { onClose } = mount()
    await user.type(subjectField(), 'a')

    await user.keyboard('{Escape}')

    expect(onClose).not.toHaveBeenCalled()
    expect(screen.getByText('Discard this draft?')).toBeInTheDocument()
  })
})

describe('the preview', () => {
  it('renders the markdown rather than describing it', async () => {
    const user = setup()
    mount()

    await user.click(screen.getByRole('tab', { name: 'Preview' }))

    expect(screen.getByLabelText('preview of your message')).toBeInTheDocument()
  })
})
