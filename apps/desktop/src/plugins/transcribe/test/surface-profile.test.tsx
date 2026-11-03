/**
 * The meeting profile editor: a new profile and an edited one are saved whole.
 *
 * Each test renders the whole tab, so each has 15 s, as `file-view.test.tsx`
 * does: a loaded machine is slow, not wrong.
 */
import { render, screen, waitFor, within } from '@/test/render'
import userEvent from '@testing-library/user-event'
import { Provider, createStore } from 'jotai'
import { beforeEach, expect, test, vi } from 'vitest'
import { activeRemoteAtom } from '@/plugin-api'
import { MeetingsSurface } from '../renderer/meetings-surface'
import { meetingsAtom, profilesAtom, selectedProfileIdAtom } from '../renderer/state'
import { profile } from './meeting-fixture'

const run = vi.hoisted(() => vi.fn())
vi.mock('@/lib/trpc', () => ({
  trpc: { cap: { run: { mutate: (input: unknown) => run(input) } } },
}))
vi.mock('../renderer/audio/capture', () => ({ startCapture: vi.fn() }))

/** Put text in a field at once: typing it a key at a time is slow enough
 *  in a dialog this size to outlast a test's timeout under load. */
async function fill(field: HTMLElement, text: string): Promise<void> {
  await userEvent.click(field)
  await userEvent.paste(text)
}

const saved = (): unknown[] =>
  run.mock.calls
    .map(([c]) => c as { name: string; paramsJson: string })
    .filter((c) => c.name === 'meeting.profiles.save')
    .map((c) => JSON.parse(c.paramsJson).profile)

beforeEach(() => {
  run.mockReset()
  run.mockImplementation(async ({ name, paramsJson }: { name: string; paramsJson: string }) =>
    name === 'meeting.profiles.save' ? JSON.parse(paramsJson).profile : { ok: true },
  )
})

function show() {
  const store = createStore()
  store.set(activeRemoteAtom, 'syv/vault')
  store.set(profilesAtom, [profile])
  store.set(meetingsAtom, [])
  render(
    <Provider store={store}>
      <MeetingsSurface />
    </Provider>,
  )
  return store
}

test('a new profile is saved with its glossary, speech model and speaker numbers', async () => {
  const store = show()
  await userEvent.click(screen.getByRole('button', { name: 'Profiles and speech key' }))
  await userEvent.click(await screen.findByRole('menuitem', { name: 'New profile…' }))
  const dialog = await screen.findByRole('dialog')
  await fill(within(dialog).getByLabelText('Name'), 'Design review')
  await fill(within(dialog).getByLabelText('What do you build?'), 'Holi')
  await fill(within(dialog).getByLabelText('Leave out'), 'Budget')
  await userEvent.click(within(dialog).getByRole('button', { name: 'Add term' }))
  await fill(within(dialog).getByLabelText('Term 1'), 'Claude')
  await fill(within(dialog).getByLabelText('Heard as 1'), 'klot, klod')
  await userEvent.click(within(dialog).getByRole('radio', { name: 'English' }))
  // The rest is folded under More settings.
  expect(within(dialog).queryByRole('radio', { name: 'Fast' })).toBeNull()
  await userEvent.click(within(dialog).getByRole('button', { name: 'More settings' }))
  await userEvent.click(within(dialog).getByRole('radio', { name: 'Fast' }))
  await userEvent.click(within(dialog).getByRole('switch', { name: 'In-room speaker numbers' }))
  await userEvent.click(within(dialog).getByRole('switch', { name: 'Share minutes' }))
  await userEvent.click(within(dialog).getByRole('button', { name: 'Save profile' }))

  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  expect(saved()).toEqual([
    {
      id: 'design-review',
      name: 'Design review',
      platform: 'Holi',
      focus: '',
      ignore: 'Budget',
      glossary: [{ term: 'Claude', heardAs: ['klot', 'klod'] }],
      instructions: '',
      language: 'en',
      shareMinutes: true,
      keepAudio: false,
      asrModel: 'syvai/hviske-v5.3',
      roomDiarize: true,
    },
  ])
  expect(store.get(profilesAtom)?.map((p) => p.id)).toEqual(['planning', 'design-review'])
  expect(store.get(selectedProfileIdAtom)).toBe('design-review')
}, 15_000)

test('an edited profile keeps its id and saves what changed', async () => {
  show()
  await userEvent.click(screen.getByRole('button', { name: 'Profiles and speech key' }))
  await userEvent.click(await screen.findByRole('menuitem', { name: 'Edit profile…' }))
  const dialog = await screen.findByRole('dialog')
  await userEvent.click(within(dialog).getByRole('button', { name: 'More settings' }))
  await fill(within(dialog).getByLabelText('Repository'), '/code/holi')
  await userEvent.click(within(dialog).getByRole('button', { name: 'Save profile' }))
  await waitFor(() => expect(saved()).toHaveLength(1))
  expect(saved()[0]).toEqual({ ...profile, repoPath: '/code/holi' })
}, 15_000)
