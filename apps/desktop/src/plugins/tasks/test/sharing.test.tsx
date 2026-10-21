/**
 * Sharing a task, and making it private, when the rename is refused: the
 * board says why, and it is never swallowed. Making private asks the rename
 * to leave committed notes' links alone.
 */
import { emptyVaultSnapshot } from '@holi/shared'
import { render, screen } from '@/test/render'
import { Provider, createStore } from 'jotai'
import { beforeEach, expect, test, vi } from 'vitest'
import { snapshotAtom } from '@/plugin-api'
import { parseTaskFile } from '../shared/task-file'
import { SharingErrorStrip } from '../renderer/BoardView'
import { setTaskSharedAtom, sharingErrorAtom } from '../renderer/state'

const rename = vi.fn<(move: { from: string; to: string; localLinksOnly?: boolean }) => void>()

vi.mock('@/plugin-api', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/plugin-api')>()
  const { atom } = await import('jotai')
  return {
    ...real,
    renameNoteAtom: atom(
      null,
      async (_get, _set, move: { from: string; to: string; localLinksOnly?: boolean }) => {
        rename(move)
        if (refusal !== null) throw new Error(refusal)
      },
    ),
  }
})

/** What main says when it refuses the rename, or null when it does not. */
let refusal: string | null = null

beforeEach(() => {
  rename.mockReset()
  refusal = null
})

function vault(path: string) {
  const store = createStore()
  store.set(snapshotAtom, {
    ...emptyVaultSnapshot(),
    claimed: {
      tasks: { items: [parseTaskFile('# Call the vendor\n', path)], broken: [] },
    },
  })
  return store
}

test('a refused share is told on the board', async () => {
  refusal = 'already exists: ops/task.call.md'
  const store = vault('ops/task.call.local.md')
  await store.set(setTaskSharedAtom, 'ops/task.call.local.md', true)
  expect(store.get(sharingErrorAtom)).toMatchObject({ title: 'Call the vendor', shared: true })
  render(
    <Provider store={store}>
      <SharingErrorStrip />
    </Provider>,
  )
  expect(
    screen.getByText(/Could not share Call the vendor: already exists: ops\/task.call.md/),
  ).toBeInTheDocument()
})

test('sharing rewrites links; making private rewrites only local ones', async () => {
  const store = vault('ops/task.call.local.md')
  await store.set(setTaskSharedAtom, 'ops/task.call.local.md', true)
  expect(rename).toHaveBeenLastCalledWith({
    from: 'ops/task.call.local.md',
    to: 'ops/task.call.md',
    localLinksOnly: false,
  })
  await store.set(setTaskSharedAtom, 'ops/task.call.md', false)
  expect(rename).toHaveBeenLastCalledWith({
    from: 'ops/task.call.md',
    to: 'ops/task.call.local.md',
    localLinksOnly: true,
  })
  expect(store.get(sharingErrorAtom)).toBeNull()
})
