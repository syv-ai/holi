/**
 * The editor's Triggers hold the file's `on:` events as sentences beside its
 * times: one read from the file shows, Add trigger adds an event, a glob
 * outside the vault is refused before saving, and Save writes them with the
 * times. A run events started reads Event, with what started it.
 */
import { render, screen, within } from '@/test/render'
import userEvent from '@testing-library/user-event'
import { Provider, createStore } from 'jotai'
import { beforeEach, expect, test, vi } from 'vitest'
import { activeRemoteAtom } from '@/plugin-api'
import { AutomationEditor, draftOf } from '../renderer/automation-editor'
import type { ScheduleSummary } from '../renderer/schedules-cap'

const run = vi.hoisted(() => vi.fn())
vi.mock('@/lib/trpc', () => ({
  trpc: { cap: { run: { mutate: (input: unknown) => run(input) } } },
}))

const SUMMARY: ScheduleSummary = {
  path: '.holi/schedules/inbox.local.md',
  slug: 'inbox',
  local: true,
  name: 'Sort the inbox',
  status: 'off',
  crons: ['0 9 * * 1-5'],
  on: [{ source: 'file', glob: 'inbox/**', changed: false }],
  allow: [],
  prompt: 'Sort what came in.',
  fingerprint: 'abc',
  runs: [
    {
      at: '2026-10-24T09:00:00Z',
      trigger: 'event',
      outcome: 'started',
      cause: 'file "inbox/a.md" added',
    },
  ],
}

beforeEach(() => {
  run.mockReset()
  run.mockImplementation(async ({ name }: { name: string }) =>
    name === 'holis.list' ? [] : name === 'schedules.save' ? SUMMARY : { ok: true },
  )
})

function setup() {
  const store = createStore()
  store.set(activeRemoteAtom, 'syv/vault')
  render(
    <Provider store={store}>
      <AutomationEditor summary={SUMMARY} initial={{ ...draftOf(SUMMARY), active: false }} />
    </Provider>,
  )
}

test("a file's events show beside its times, and an added one saves with them", async () => {
  const user = userEvent.setup()
  setup()
  const triggers = screen.getByRole('region', { name: 'Triggers' })
  const file = triggers.querySelector<HTMLElement>("[data-event-trigger='file']")!
  expect(within(file).getByRole('textbox', { name: 'Folder or files' })).toHaveValue('inbox/**')

  await user.click(within(triggers).getByRole('button', { name: 'Add trigger' }))
  await user.click(await screen.findByRole('menuitem', { name: 'Before a calendar event' }))
  expect(triggers.querySelector("[data-event-trigger='calendar']")).not.toBeNull()

  await user.click(screen.getByRole('button', { name: 'Save' }))
  await vi.waitFor(() =>
    expect(run).toHaveBeenCalledWith(expect.objectContaining({ name: 'schedules.save' })),
  )
  const call = run.mock.calls.find(([c]) => c.name === 'schedules.save')![0]
  expect(JSON.parse(call.paramsJson).draft).toMatchObject({
    crons: ['0 9 * * 1-5'],
    on: [
      { source: 'file', glob: 'inbox/**', changed: false },
      { source: 'calendar', before: 30 },
    ],
  })
})

test('a glob outside the vault is refused before saving', async () => {
  const user = userEvent.setup()
  setup()
  const field = screen.getByRole('textbox', { name: 'Folder or files' })
  await user.clear(field)
  await user.type(field, '../out')
  expect(screen.getByText(/a glob inside the vault/)).toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()
})

test('a run events started reads Event, with its cause', async () => {
  const user = userEvent.setup()
  setup()
  const history = screen.queryByRole('list', { name: 'Run history' })
  if (history === null) await user.click(screen.getByRole('tab', { name: /Run history|History/ }))
  const list = await screen.findByRole('list', { name: 'Run history' })
  expect(list).toHaveTextContent('Event · file "inbox/a.md" added')
})
