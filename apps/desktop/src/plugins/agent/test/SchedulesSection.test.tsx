/**
 * The Schedules section: turning a schedule on approves its prompt, so the
 * row shows the prompt whenever the switch would approve it.
 */
import { render, screen, waitFor } from '@/test/render'
import userEvent from '@testing-library/user-event'
import { Provider, createStore } from 'jotai'
import { beforeEach, expect, test, vi } from 'vitest'
import type { ScheduleSummary } from '../main/schedules/scheduler'
import { SchedulesSection } from '../renderer/SchedulesSection'

const calls: { name: string; params: unknown }[] = []
let schedules: ScheduleSummary[] = []

vi.mock('@/lib/trpc', () => ({
  trpc: {
    cap: {
      run: {
        mutate: async ({ name, paramsJson }: { name: string; paramsJson?: string }) => {
          calls.push({
            name,
            params: paramsJson === undefined ? undefined : JSON.parse(paramsJson),
          })
          return name === 'schedules.list' ? schedules : schedules[0]
        },
      },
    },
  },
}))

const schedule = (over: Partial<ScheduleSummary>): ScheduleSummary => ({
  path: '.holi/schedules/inbox.md',
  slug: 'inbox',
  name: 'Inbox',
  status: 'off',
  when: 'Every 30 minutes',
  allow: ['Edit(tilbud/**)'],
  prompt: 'Draft replies to my new mail.',
  fingerprint: 'f1',
  runs: [],
  ...over,
})

beforeEach(() => {
  calls.length = 0
})

function setup() {
  return render(
    <Provider store={createStore()}>
      <SchedulesSection remote="o/vault" />
    </Provider>,
  )
}

test('shows the prompt a schedule that is off would approve, and switches it on', async () => {
  schedules = [schedule({})]
  setup()
  expect(await screen.findByText('Draft replies to my new mail.')).toBeInTheDocument()
  expect(screen.getByText('Switching it on approves this prompt:')).toBeInTheDocument()
  await userEvent.click(screen.getByRole('switch', { name: 'Runs here' }))
  await waitFor(() =>
    expect(calls).toContainEqual({
      name: 'schedules.enable',
      params: { schedule: '.holi/schedules/inbox.md', fingerprint: 'f1' },
    }),
  )
})

test('shows a changed prompt as the one it would approve now, and no prompt once on', async () => {
  schedules = [schedule({ status: 'changed' })]
  const first = setup()
  expect(await screen.findByText('Draft replies to my new mail.')).toBeInTheDocument()
  expect(screen.getByText('The prompt now, which switching it on approves:')).toBeInTheDocument()
  first.unmount()

  schedules = [schedule({ status: 'on' })]
  setup()
  expect(await screen.findByRole('switch', { name: 'Runs here' })).toBeChecked()
  expect(screen.queryByText('Draft replies to my new mail.')).toBeNull()
})
