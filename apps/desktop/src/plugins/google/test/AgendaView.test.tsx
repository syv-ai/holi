/**
 * The agenda's calendar picker.
 *
 * The tests are about the mine/subscribed distinction being visible and the
 * toggle reaching main, which is what makes it true for the agent as well.
 */
import { render, screen, waitFor, within } from '@/test/render'
import userEvent from '@testing-library/user-event'
import { getDefaultStore } from 'jotai'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { AgendaView } from '../renderer/AgendaView'
import { activeRemoteAtom } from '@/plugin-api'
import { resetMailImagesForTests } from '../renderer/mail-images'

const agendaMock = vi.fn()
const agendaCachedMock = vi.fn()
const calendarsMock = vi.fn()
const setCalendarMock = vi.fn()
const createTaskMock = vi.fn()
const imageSendersMock = vi.fn(() => Promise.resolve<string[]>([]))

/** Google's capabilities, by name, through the UI door. */
const google: Record<string, (params: unknown) => unknown> = {
  'google.agenda': () => agendaMock(),
  'google.agendaCached': () => agendaCachedMock(),
  'google.calendars': () => calendarsMock(),
  'google.setCalendar': (p) => setCalendarMock(p),
  // Reached through `SandboxedHtml`, which every event description renders
  // in. The double has to carry it or the panel throws on mount.
  'google.imageSenders': () => imageSendersMock(),
  'google.allowImagesFrom': () => Promise.resolve({ ok: true }),
  'google.forgetImageSenders': () => Promise.resolve({ ok: true }),
}

vi.mock('@/lib/trpc', () => ({
  trpc: {
    // `tasks.create` is a capability at the UI door; the double sees its
    // params with the vault they run in.
    cap: {
      // The vault runs tasks, so a task can be made from an event.
      names: { query: async () => ['tasks.create'] },
      run: {
        mutate: async ({
          remote,
          name,
          paramsJson,
        }: {
          remote: string
          name: string
          paramsJson?: string
        }) => {
          const params = JSON.parse(paramsJson ?? '{}') as object
          if (name === 'tasks.create') return createTaskMock({ remote, ...params })
          const verb = google[name]
          if (verb === undefined) throw new Error(`no such method: ${name}`)
          return verb(params)
        },
      },
    },
  },
}))

/** A promise this test resolves by hand, so "before Google answers" is an
 *  actual moment rather than a race. */
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => (resolve = r))
  return { promise, resolve }
}

const CALENDARS = [
  { id: 'primary', name: 'Ada', mine: true, color: '#039be5', enabled: true },
  { id: 'jane', name: 'Jane Doe', mine: false, color: '#d50000', enabled: false },
  { id: 'room3', name: 'Meeting Room 3', mine: false, color: null, enabled: false },
]

function event(overrides: Record<string, unknown> = {}) {
  return {
    id: 'e1',
    title: 'Q2 review',
    start: '2026-08-04T09:00:00.000Z',
    end: '2026-08-04T10:00:00.000Z',
    allDay: false,
    htmlLink: 'https://calendar.google.com/x',
    calendarId: 'primary',
    calendarName: 'Ada',
    mine: true,
    color: '#039be5',
    myResponse: null,
    kind: 'default',
    busy: true,
    description: null,
    attendeeCount: 0,
    organizer: null,
    conferenceUrl: null,
    recurring: false,
    ...overrides,
  }
}

const openExternal = vi.fn()

beforeEach(() => {
  agendaMock.mockReset().mockResolvedValue([])
  agendaCachedMock.mockReset().mockResolvedValue(null)
  calendarsMock.mockReset().mockResolvedValue(CALENDARS)
  setCalendarMock.mockReset().mockResolvedValue({ ok: true })
  createTaskMock.mockReset().mockResolvedValue({ path: 'tasks/q2-review.md' })
  imageSendersMock.mockReset().mockResolvedValue([])
  // Module state on jotai's default store, shared by every test in this file.
  resetMailImagesForTests()
  // Every Google call names the vault it is for.
  getDefaultStore().set(activeRemoteAtom, 'git@github.com:syv-ai/notes.git')
  openExternal.mockReset()
  // @ts-expect-error — the preload bridge is not typed onto window in tests.
  window.holi = { openExternal }
})
afterEach(() => {
  // @ts-expect-error — as above.
  delete window.holi
  getDefaultStore().set(activeRemoteAtom, null)
})

/** Open the picker and hand back its menu. */
async function openPicker() {
  const user = userEvent.setup()
  render(<AgendaView />)
  await user.click(await screen.findByRole('button', { name: /choose calendars/i }))
  return { user, menu: await screen.findByRole('menu') }
}

test('separates the calendars you own from the ones you only watch', async () => {
  const { menu } = await openPicker()

  // The grouping IS the feature.
  expect(within(menu).getByText('Your calendars')).toBeInTheDocument()
  expect(within(menu).getByText('Subscribed')).toBeInTheDocument()
})

test('shows subscribed calendars switched off, and yours switched on', async () => {
  const { menu } = await openPicker()

  expect(within(menu).getByRole('menuitemcheckbox', { name: /Ada/ })).toBeChecked()
  expect(within(menu).getByRole('menuitemcheckbox', { name: /Jane Doe/ })).not.toBeChecked()
})

test('switching a colleague on tells main, and reloads the agenda', async () => {
  const { user, menu } = await openPicker()
  agendaMock.mockClear()

  await user.click(within(menu).getByRole('menuitemcheckbox', { name: /Jane Doe/ }))

  // Persisted in main rather than held here, because the agent resolves its own
  // agenda through the same store.
  expect(setCalendarMock).toHaveBeenCalledWith({ id: 'jane', enabled: true })
  await waitFor(() => expect(agendaMock).toHaveBeenCalled())
})

test('stays open while several calendars are ticked', async () => {
  // Radix closes a menu on select by default; a filter list must stay open.
  const { user, menu } = await openPicker()

  await user.click(within(menu).getByRole('menuitemcheckbox', { name: /Jane Doe/ }))

  expect(screen.getByRole('menu')).toBeInTheDocument()
})

test('marks an event from someone else’s calendar as theirs', async () => {
  agendaMock.mockResolvedValue([
    event(),
    event({
      id: 'e2',
      title: 'Dentist',
      calendarId: 'jane',
      calendarName: 'Jane Doe',
      mine: false,
    }),
  ])

  render(<AgendaView />)

  // Attribution on the row, so someone else's event never reads as the user's.
  expect(await screen.findByText('Jane Doe')).toBeInTheDocument()
})

/**
 * Triage on the row: an unanswered invitation, a block that is not a meeting,
 * and time that is not really taken.
 */

test('flags an invitation that still needs an answer', async () => {
  agendaMock.mockResolvedValue([
    event({ myResponse: 'needsAction' }),
    event({ id: 'e2', title: 'Accepted thing', myResponse: 'accepted' }),
  ])
  const user = userEvent.setup()

  render(<AgendaView />)
  const rsvp = await screen.findByRole('button', { name: /answer Q2 review/i })

  // Only the unanswered one. An accepted meeting is a fact, not a task.
  expect(screen.queryByRole('button', { name: /answer Accepted thing/i })).toBeNull()

  await user.click(rsvp)

  // The scope is read-only: Holi cannot RSVP and must not pretend to, so the
  // affordance hands the user to Google rather than faking a reply.
  expect(openExternal).toHaveBeenCalledWith('https://calendar.google.com/x')
})

test('marks out-of-office distinctly from a meeting', async () => {
  agendaMock.mockResolvedValue([
    event({ id: 'ooo', title: 'Away', kind: 'outOfOffice' }),
    event({ id: 'meet', title: 'Sync', kind: 'default' }),
  ])

  render(<AgendaView />)
  await screen.findByText('Away')

  expect(screen.getByText(/out of office/i)).toBeInTheDocument()
  expect(screen.getAllByText(/out of office/i)).toHaveLength(1)
})

test('dims an event that does not block time', async () => {
  agendaMock.mockResolvedValue([
    event({ id: 'free', title: 'FYI release', busy: false }),
    event({ id: 'busy', title: 'Interview', busy: true }),
  ])

  render(<AgendaView />)
  await screen.findByText('FYI release')

  const free = screen.getByText('FYI release').closest('li')!
  const busy = screen.getByText('Interview').closest('li')!
  expect(free.className).toContain('opacity-60')
  expect(busy.className).not.toContain('opacity-60')
})

test('offers the video link for a Zoom conference, not just Meet', async () => {
  agendaMock.mockResolvedValue([event({ conferenceUrl: 'https://syv.zoom.us/j/123' })])
  const user = userEvent.setup()

  render(<AgendaView />)
  await user.click(await screen.findByRole('button', { name: /join Q2 review/i }))

  // Not only Meet: `hangoutLink` alone would miss Zoom and Teams.
  expect(openExternal).toHaveBeenCalledWith('https://syv.zoom.us/j/123')
})

test('puts the event description into the task it creates', async () => {
  agendaMock.mockResolvedValue([event({ description: 'Dial-in 555-0100, agenda in the deck' })])
  const user = userEvent.setup()

  render(<AgendaView />)
  // Making a task lives in the detail pane; the row keeps only RSVP and Join.
  await user.click(await screen.findByRole('button', { name: /show Q2 review/i }))
  await user.click(await screen.findByRole('button', { name: /^task$/i }))

  await waitFor(() => expect(createTaskMock).toHaveBeenCalled())
  const { description } = createTaskMock.mock.calls[0]![0] as { description: string }
  // The link is the representation; the description carries the dial-in.
  expect(description).toContain('https://calendar.google.com/x')
  expect(description).toContain('Dial-in 555-0100')
})

test('paints the cached agenda while Google is still answering', async () => {
  agendaCachedMock.mockResolvedValue([event({ id: 'cached', title: 'Yesterday’s copy' })])
  const live = deferred<unknown[]>()
  agendaMock.mockReturnValue(live.promise)

  render(<AgendaView />)

  // The point of the cache: a day on screen before Google answers.
  expect(await screen.findByText('Yesterday’s copy')).toBeInTheDocument()

  live.resolve([event({ id: 'fresh', title: 'The real thing' })])

  // And replaced the moment the live answer lands.
  expect(await screen.findByText('The real thing')).toBeInTheDocument()
  expect(screen.queryByText('Yesterday’s copy')).toBeNull()
})

test('says nothing about calendars when Google gives none', async () => {
  calendarsMock.mockRejectedValue(new Error('not connected'))

  render(<AgendaView />)
  await screen.findByRole('button', { name: /refresh agenda/i })

  // The agenda's own error surface covers the outage; a second broken control
  // saying the same thing is noise.
  expect(screen.queryByRole('button', { name: /choose calendars/i })).toBeNull()
})

/**
 * The detail pane. Most of these are about how a description reaches the
 * screen, including markup written by whoever sent the invitation.
 */

test('the list and the detail pane are separated by a draggable handle', async () => {
  agendaMock.mockResolvedValue([event()])

  render(<AgendaView />)
  await screen.findByText('Q2 review')

  expect(screen.getByRole('separator')).toBeInTheDocument()
})

test('says nothing until an event is picked', async () => {
  agendaMock.mockResolvedValue([event()])

  render(<AgendaView />)
  await screen.findByText('Q2 review')

  // Nothing is selected on open.
  expect(screen.getByText(/pick an event/i)).toBeInTheDocument()
})

/** Open the one event and hand back its description's document. */
async function descriptionFrame(): Promise<Document> {
  const user = userEvent.setup()
  render(<AgendaView />)
  await user.click(await screen.findByRole('button', { name: /show Q2 review/i }))
  const frame = (await screen.findByLabelText(/description of Q2 review/i)) as HTMLIFrameElement
  await waitFor(() => expect(frame.contentDocument?.body.firstChild).toBeTruthy())
  return frame.contentDocument!
}

test('shows the description a row has no room for', async () => {
  // Bare text with real newlines, as an API- or .ics-created event carries.
  agendaMock.mockResolvedValue([
    event({ description: 'Dial-in 555-0100\nDeck is in the drive folder' }),
  ])

  const frame = await descriptionFrame()

  // Down the same renderer as markup: one path, so one place the sandbox could
  // be forgotten rather than two.
  expect(frame.body.textContent).toContain('Dial-in 555-0100')
  // Converted, not collapsed. Putting raw text into an HTML document would run
  // the two lines together.
  expect(frame.querySelectorAll('br')).toHaveLength(1)
})

test('a plain description keeps the characters that look like markup', async () => {
  // `<b` with no closing `>` on purpose: an HTML parser reads that as an
  // unterminated start tag and swallows everything after it, so this fails
  // loudly if the escape is dropped. A bare `< 5000` would survive either way
  // and prove nothing.
  agendaMock.mockResolvedValue([event({ description: 'budget <b 5000 EUR & rising' })])

  const frame = await descriptionFrame()

  // Escaped on the way in, so a stray `<` stays visible text; `&` is escaped
  // first, or it would double-escape the entity the `<` produces.
  expect(frame.body.textContent).toContain('budget <b 5000 EUR & rising')
})

test('renders an HTML description as markup, in a frame of its own', async () => {
  // What Meet and Zoom write into an invitation: a stranger's markup, so it
  // takes the same sandboxed path a mail body does.
  agendaMock.mockResolvedValue([
    event({ description: '<p>Join here: <a href="https://meet.example/x">link</a></p>' }),
  ])
  const user = userEvent.setup()

  render(<AgendaView />)
  await user.click(await screen.findByRole('button', { name: /show Q2 review/i }))

  const frame = (await screen.findByLabelText(/description of Q2 review/i)) as HTMLIFrameElement
  await waitFor(() => expect(frame.contentDocument?.body.firstChild).toBeTruthy())

  // Real markup, and *inside* the frame, not in the app's document.
  const anchor = frame.contentDocument!.querySelector('a')
  expect(anchor?.getAttribute('href')).toBe('https://meet.example/x')
  expect(screen.queryByText(/<a href/)).toBeNull()
})

test('names the things the row had to drop to fit', async () => {
  agendaMock.mockResolvedValue([
    event({
      location: 'Room 3, second floor',
      organizer: 'Mette',
      attendeeCount: 12,
      recurring: true,
    }),
  ])
  const user = userEvent.setup()

  render(<AgendaView />)
  await user.click(await screen.findByRole('button', { name: /show Q2 review/i }))

  expect(await screen.findByText('Room 3, second floor')).toBeInTheDocument()
  expect(screen.getByText('Mette')).toBeInTheDocument()
  expect(screen.getByText('12 people')).toBeInTheDocument()
  // On a row, repeating is invisible and not blocking time is only a dimming.
  expect(screen.getByText('repeats')).toBeInTheDocument()
})

test('lets go of an event that a refresh drops from the agenda', async () => {
  agendaMock.mockResolvedValue([event({ description: 'Dial-in 555-0100' })])
  const user = userEvent.setup()

  render(<AgendaView />)
  await user.click(await screen.findByRole('button', { name: /show Q2 review/i }))
  await screen.findByLabelText(/description of Q2 review/i)

  // An event missing from the next response empties the pane rather than
  // staying pinned to a stale object.
  agendaMock.mockResolvedValue([])
  await user.click(screen.getByRole('button', { name: /refresh agenda/i }))

  expect(await screen.findByText(/pick an event/i)).toBeInTheDocument()
  expect(screen.queryByLabelText(/description of Q2 review/i)).toBeNull()
})

test('remembers its width per account, not per vault', async () => {
  agendaMock.mockResolvedValue([event()])
  const reads = vi.spyOn(Storage.prototype, 'getItem')

  render(<AgendaView />)
  await screen.findByText('Q2 review')

  const keys = reads.mock.calls.map(([key]) => key)
  reads.mockRestore()

  // The agenda is account-wide: the same calendar whichever vault is
  // open, and open with no vault at all.
  expect(keys).toContain('holi:panelLayouts:global')
  expect(keys).not.toContain('holi:panelLayouts')
})
