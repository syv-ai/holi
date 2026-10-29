/**
 * The new-Holi wizard: it explains, then walks who a Holi is, what it does,
 * what it may do without asking and a habit, and creates it through the one
 * create path; then the approval opens, as for any new Holi. A bare `Edit` is
 * refused before anything is written, and `learn` is only the explaining
 * steps.
 */
import { render, screen, waitFor } from '@/test/render'
import userEvent from '@testing-library/user-event'
import { Provider, createStore } from 'jotai'
import { beforeEach, expect, test, vi } from 'vitest'
import { activeRemoteAtom } from '@/plugin-api'
import { ApproveHoliDialog } from '../renderer/approve-holi-dialog'
import { HoliWizardDialog } from '../renderer/wizard/holi-wizard'
import { holisAtom, holiWizardAtom, pendingApprovalAtom, type HoliSummary } from '../renderer/state'

const create = vi.fn()
const save = vi.fn()
vi.mock('../renderer/holis-cap', () => ({
  holiCap: { list: vi.fn(), create: (...a: unknown[]) => create(...a) },
}))
vi.mock('../renderer/habits-cap', () => ({
  habitsCap: { save: (...a: unknown[]) => save(...a) },
}))
// The automations plugin is on: its `schedules.save` is offered.
vi.mock('@/lib/trpc', () => ({
  trpc: { cap: { names: { query: async () => ['schedules.save'] } } },
}))

const made: HoliSummary = {
  id: 'proposal',
  path: '.holi/holis/proposal/holi.yaml',
  dir: '.holi/holis/proposal',
  local: false,
  folder: true,
  name: 'Proposal',
  mascot: 'captain',
  color: '#a5a1ff',
  status: 'new',
  accepts: ['kunder/**/*.md'],
  allow: ['Edit(tilbud/**)'],
  soul: 'Write proposals.',
  unknownKeys: [],
  fingerprint: 'f',
  runs: [],
}

beforeEach(() => {
  create.mockReset()
  save.mockReset()
})

function setup(mode: 'create' | 'learn') {
  const store = createStore()
  store.set(activeRemoteAtom, 'o/vault')
  store.set(holisAtom, [])
  store.set(holiWizardAtom, { mode })
  render(
    <Provider store={store}>
      <HoliWizardDialog />
      <ApproveHoliDialog />
    </Provider>,
  )
  return store
}

const next = () => userEvent.click(screen.getByRole('button', { name: 'Continue' }))

test('walks the steps and creates a Holi, then asks for approval', async () => {
  create.mockResolvedValue(made)
  save.mockResolvedValue({ path: '.holi/schedules/proposal-habit.md' })
  const store = setup('create')

  expect(await screen.findByText('Meet the Holis')).toBeTruthy()
  expect(screen.getByText('SOUL.md')).toBeTruthy()
  await next()
  expect(screen.getByText('How a Holi gets work')).toBeTruthy()
  expect(screen.getByText('Sent')).toBeTruthy()
  expect(screen.getByText('On a schedule')).toBeTruthy()
  await next()

  // Who it is: the name follows the face until typed.
  const name = screen.getByLabelText('Name') as HTMLInputElement
  expect(name.value).toBe('Captain')
  await userEvent.clear(name)
  expect(screen.getByRole('button', { name: 'Continue' })).toHaveProperty('disabled', true)
  await userEvent.type(name, 'Proposal')
  await userEvent.click(screen.getByRole('radio', { name: 'Professor' }))
  await userEvent.type(screen.getByLabelText('Short description'), 'Writes proposals')
  await next()

  await userEvent.type(screen.getByLabelText('Soul'), 'Write proposals.')
  await userEvent.type(screen.getByLabelText('Documents it takes'), 'kunder/**/*.md')
  await next()

  // What it may do: a bare Edit is refused, a folder becomes its rule.
  await userEvent.type(screen.getByLabelText('Another Claude Code rule'), 'Edit{Enter}')
  expect(screen.getByText(/lets a run write anywhere/)).toBeTruthy()
  await userEvent.type(screen.getByLabelText('A folder it may write'), 'tilbud{Enter}')
  expect(screen.getByText('Edit(tilbud/**)')).toBeTruthy()
  await next()

  // A habit, written off.
  await userEvent.click(screen.getByRole('switch', { name: 'Give it a habit' }))
  expect(screen.getByRole('button', { name: 'Continue' })).toHaveProperty('disabled', true)
  await userEvent.type(screen.getByLabelText('What it does each time'), 'Digest kunder/.')
  await next()

  expect(screen.getByText('Review and create', { selector: 'h2' })).toBeTruthy()
  await userEvent.click(screen.getByRole('button', { name: 'Create Holi' }))

  await waitFor(() => expect(create).toHaveBeenCalled())
  expect(create).toHaveBeenCalledWith('o/vault', {
    name: 'Proposal',
    mascot: 'professor',
    color: '#a5a1ff',
    description: 'Writes proposals',
    accepts: ['kunder/**/*.md'],
    allow: ['Edit(tilbud/**)'],
    soul: 'Write proposals.',
  })
  await waitFor(() =>
    expect(save).toHaveBeenCalledWith('o/vault', {
      draft: {
        name: 'Proposal habit',
        crons: ['0 8 * * 1-5'],
        prompt: 'Digest kunder/.',
        holi: 'proposal',
      },
    }),
  )
  // Not approved by making it: the approval opens, as for any new Holi.
  expect(store.get(holiWizardAtom)).toBeNull()
  expect(store.get(pendingApprovalAtom)?.holi.id).toBe('proposal')
  expect(await screen.findByText('Run Proposal on this machine?')).toBeTruthy()
})

test('a refusal from main stays in the wizard, with Try again', async () => {
  create.mockRejectedValue(new Error('There is already a Holi called captain.'))
  const store = setup('create')
  await screen.findByText('Meet the Holis')
  for (let i = 0; i < 6; i++) await next()
  await userEvent.click(screen.getByRole('button', { name: 'Create Holi' }))
  expect(await screen.findByText('There is already a Holi called captain.')).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy()
  expect(store.get(pendingApprovalAtom)).toBeNull()
  expect(save).not.toHaveBeenCalled()
})

test('How Holis work is only the explaining steps, then making one', async () => {
  setup('learn')
  expect(await screen.findByText('Meet the Holis')).toBeTruthy()
  expect(screen.queryByText('Review and create')).toBeNull()
  await next()
  await userEvent.click(screen.getByRole('button', { name: 'Create a Holi' }))
  expect(await screen.findByText('Who it is', { selector: 'h2' })).toBeTruthy()
})
