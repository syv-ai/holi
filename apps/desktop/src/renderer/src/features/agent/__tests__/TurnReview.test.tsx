/**
 * What the agent's last turn changed, and taking a piece of it back (D88, #4).
 *
 * The panel is a projection of `state/turns.ts`, so what only this file can show
 * is the reading: that a range whose commits are gone says so instead of looking
 * like a turn that changed nothing, and that a resolution is written when the
 * reviewer says to rather than on every keystroke of an editable diff.
 */
import { render, screen, waitFor, within } from '@/test/render'
import userEvent from '@testing-library/user-event'
import { Provider, createStore } from 'jotai'
import { beforeEach, expect, test, vi } from 'vitest'
import { TurnReview } from '../TurnReview'
import {
  latestTurnAtom,
  turnFilesAtom,
  turnReviewOpenAtom,
  type Turn,
  type TurnFile,
} from '@/state/turns'
import { activeRemoteAtom } from '@/state/vaults'

const files = vi.fn()
const fileDiff = vi.fn()
const revert = vi.fn()
const list = vi.fn()

vi.mock('@/lib/trpc', () => ({
  trpc: {
    turns: {
      list: { query: () => list() },
      files: { query: (i: unknown) => files(i) },
      fileDiff: { query: (i: unknown) => fileDiff(i) },
      revert: { mutate: (i: unknown) => revert(i) },
    },
  },
}))

vi.mock('@/lib/buffer-registry', () => ({ flushAllBuffers: () => Promise.resolve() }))

const TURN: Turn = { base: 'aaa', end: 'bbb', at: '2026-09-09T10:00:00Z' }
const TWO: TurnFile[] = [
  { path: 'notes/plan.md', status: 'M', added: 4, removed: 2 },
  { path: 'notes/new.md', status: 'A', added: 9, removed: 0 },
]

beforeEach(() => {
  for (const fn of [files, fileDiff, revert, list]) fn.mockReset()
  list.mockResolvedValue([TURN])
  files.mockResolvedValue(TWO)
  fileDiff.mockResolvedValue({ before: 'one\ntwo\n', after: 'one\nCHANGED\n' })
  revert.mockResolvedValue({ ok: true })
})

function setup(over: { turn?: Turn | null; files?: TurnFile[] } = {}) {
  const store = createStore()
  store.set(activeRemoteAtom, 'git@github.com:syv-ai/vault.git')
  store.set(turnReviewOpenAtom, true)
  store.set(latestTurnAtom, over.turn === undefined ? TURN : over.turn)
  store.set(turnFilesAtom, over.files ?? TWO)
  return {
    store,
    ...render(
      <Provider store={store}>
        <TurnReview />
      </Provider>,
    ),
  }
}

test('lists each file the turn changed, with its counts', async () => {
  setup()
  const plan = await screen.findByRole('button', { name: /notes\/plan\.md/ })
  expect(within(plan).getByText('+4')).toBeInTheDocument()
  expect(within(plan).getByText('−2')).toBeInTheDocument()
  expect(screen.getByRole('button', { name: /notes\/new\.md/ })).toBeInTheDocument()
})

test('renders nothing when there is no turn to review', () => {
  const { container } = setup({ turn: null })
  expect(container).toBeEmptyDOMElement()
})

test('says a turn’s history is gone rather than that it changed nothing', async () => {
  // A record outlives the commits it names: a reset, a re-clone. An empty file
  // list against a real turn means the range is unreachable, because a turn that
  // changed nothing is never recorded in the first place.
  //
  // The mock has to agree with the seed: the panel re-asks on mount, so seeding
  // an empty list alone would be overwritten by the reload.
  files.mockResolvedValue([])
  setup({ files: [] })
  expect(await screen.findByText(/history is gone/i)).toBeInTheDocument()
})

test('picking a file shows what the turn did to it', async () => {
  setup()
  await userEvent.click(await screen.findByRole('button', { name: /notes\/plan\.md/ }))
  await waitFor(() =>
    expect(fileDiff).toHaveBeenCalledWith({ base: 'aaa', end: 'bbb', path: 'notes/plan.md' }),
  )
  await waitFor(() => expect(document.querySelector('.cm-content')).not.toBeNull())
})

test('a resolution is not written until the reviewer says so', async () => {
  // The diff is editable, so `onResolve` fires on every document change. Writing
  // there would commit once per keystroke; the panel holds the resolved text and
  // waits for the control at the foot, the way History waits for Restore.
  setup()
  await userEvent.click(await screen.findByRole('button', { name: /notes\/plan\.md/ }))
  await waitFor(() => expect(document.querySelector('.cm-content')).not.toBeNull())

  const reject = document.querySelector<HTMLButtonElement>('button[name="reject"]')
  expect(reject, 'the diff offered no reject control').not.toBeNull()
  // The package binds its controls to mousedown, not click.
  reject!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }))
  expect(revert).not.toHaveBeenCalled()

  const keep = await screen.findByRole('button', { name: /keep this resolution/i })
  await userEvent.click(keep)
  await waitFor(() => expect(revert).toHaveBeenCalled())
  expect(revert.mock.calls[0]![0]).toMatchObject({ path: 'notes/plan.md', text: 'one\ntwo\n' })
})

test('the control is dead until something has actually been resolved', async () => {
  setup()
  await userEvent.click(await screen.findByRole('button', { name: /notes\/plan\.md/ }))
  await waitFor(() => expect(document.querySelector('.cm-content')).not.toBeNull())
  expect(await screen.findByRole('button', { name: /keep this resolution/i })).toBeDisabled()
})
