/**
 * The toolbar's "+": a task, file, folder or app is named in a field that
 * opens next to the focused row (`newItemPlace`), and each lands where its
 * field was and opens the way its kind does.
 */
import { emptyVaultSnapshot } from '@holi/shared'
import { getDefaultStore } from 'jotai'
import userEvent from '@testing-library/user-event'
import { beforeEach, expect, test, vi } from 'vitest'
import { render, screen, waitFor } from '@/test/render'
import { CORE_CONTRIBUTION } from '@/components/core-surfaces'
import { coreContributionAtom } from '@/state/plugins'
import { FileTree } from '../FileTree'
import { activeRemoteAtom, snapshotAtom, vaultsAtom } from '../../../state/vaults'

const REMOTE = 'syv-ai/holi'
const EMPTY = emptyVaultSnapshot()
const store = getDefaultStore()

const createTask = vi.fn(async (_input: unknown) => ({ path: 'Finance/task.call-the-bank.md' }))
const init = vi.fn(async (_input: unknown) => ({ created: [] }))
vi.mock('../../../lib/trpc', () => ({
  trpc: {
    vaults: { snapshot: { query: () => Promise.resolve(EMPTY) } },
    // `tasks.create` and `apps.init` are capabilities at the UI door; the
    // doubles see their params with the vault they run in.
    cap: {
      run: {
        mutate: ({
          remote,
          name,
          paramsJson,
        }: {
          remote: string
          name: string
          paramsJson?: string
        }) =>
          name === 'tasks.create'
            ? createTask({ remote, ...(JSON.parse(paramsJson ?? '{}') as object) })
            : name === 'apps.init'
              ? init({ remote, ...(JSON.parse(paramsJson ?? '{}') as object) })
              : Promise.reject(new Error(`no such method: ${name}`)),
      },
    },
  },
}))

function tree() {
  const open = { preview: vi.fn(), pinned: vi.fn(), pane: vi.fn() }
  // Apps are core's claim, installed as `main.tsx` installs it.
  store.set(coreContributionAtom, CORE_CONTRIBUTION)
  store.set(activeRemoteAtom, REMOTE)
  store.set(vaultsAtom, [{ remote: REMOTE, path: '/vault' } as never])
  store.set(snapshotAtom, {
    ...EMPTY,
    docs: [
      { path: 'Finance/2026.md', kind: 'note', updatedAt: '' },
      { path: 'Finance/2027.md', kind: 'note', updatedAt: '' },
      { path: 'Travel/Rome.md', kind: 'note', updatedAt: '' },
      { path: 'inbox.md', kind: 'note', updatedAt: '' },
    ],
  })
  render(
    <FileTree
      activePath={null}
      onOpenPreview={open.preview}
      onOpenPinned={open.pinned}
      onOpenInNewPane={open.pane}
    />,
  )
  return open
}

const rowFor = (path: string) => document.querySelector<HTMLElement>(`[data-path="${path}"]`)

/** Rows and the name field in document order: the field by its placeholder. */
const order = () =>
  [...document.querySelectorAll<HTMLElement>('[data-path], input[placeholder]')].map(
    (el) => el.dataset.path ?? `<${el.getAttribute('placeholder')}>`,
  )

async function make(label: string) {
  await userEvent.click(screen.getByRole('button', { name: 'New' }))
  await userEvent.click(screen.getByRole('button', { name: label }))
}

/** Type into the field once it has focused and placed its caret (a tick after
 *  focus, as a rename's preselection needs), then press Enter. */
async function name(text: string) {
  await waitFor(() => expect(document.activeElement).toHaveAttribute('placeholder'))
  await new Promise((resolve) => setTimeout(resolve, 0))
  await userEvent.keyboard(`${text}{Enter}`)
}

beforeEach(() => {
  createTask.mockClear()
  init.mockClear()
})

test('with nothing focused, the field is the first row at the root', async () => {
  tree()
  await make('New File')
  expect(order()[0]).toBe('<note name>')
})

test('with a folder focused, the field is first inside it, and the folder opens', async () => {
  tree()
  await userEvent.click(rowFor('Travel')!)
  await userEvent.click(rowFor('Travel')!) // closed again: the field opens it
  await make('New Folder')
  expect(order()).toEqual(['Finance', 'Travel', '<folder name>', 'Travel/Rome.md', 'inbox.md'])
})

test('with a file focused, a task is named right under it and opens once made', async () => {
  const open = tree()
  await userEvent.click(rowFor('Finance')!)
  await userEvent.click(rowFor('Finance/2026.md')!)
  await make('New Task')
  const list = order()
  expect(list.slice(list.indexOf('Finance/2026.md'), list.indexOf('Finance/2026.md') + 3)).toEqual([
    'Finance/2026.md',
    '<task title>',
    'Finance/2027.md',
  ])
  await name('Call the bank')
  expect(createTask).toHaveBeenCalledWith({
    remote: REMOTE,
    title: 'Call the bank',
    status: 'todo',
    folder: 'Finance',
  })
  await waitFor(() => expect(open.pinned).toHaveBeenCalledWith('Finance/task.call-the-bank.md'))
})

test('an app is scaffolded beside the focused file, and its index.html opens', async () => {
  const open = tree()
  await userEvent.click(rowFor('inbox.md')!)
  await make('New App')
  expect(order().at(-1)).toBe('<app name>')
  await name('Budget')
  await waitFor(() => expect(init).toHaveBeenCalledWith({ remote: REMOTE, path: 'Budget.app' }))
  await waitFor(() => expect(open.preview).toHaveBeenCalledWith('Budget.app/index.html'))
})
