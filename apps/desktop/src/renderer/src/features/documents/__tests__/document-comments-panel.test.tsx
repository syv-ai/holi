/**
 * A note's comments in the document view: its open threads are counted on
 * the header's toggle and tinted in the text, the panel lists them with a
 * thread whose passage is gone marked detached, a reply and a resolve go to
 * `comments.*`, and a selection becomes a new thread quoting the file. A file
 * the router says takes no comments shows none of it.
 */
import { emptyVaultSnapshot, type CommentThread } from '@holi/shared'
import userEvent from '@testing-library/user-event'
import { createStore, Provider } from 'jotai'
import { beforeEach, expect, test, vi } from 'vitest'

import { render, screen, waitFor, within } from '@/test/render'
import { activeRemoteAtom, snapshotAtom } from '@/state/vaults'

import { DocumentView } from '../document-view'

Element.prototype.getAnimations ??= () => []
Range.prototype.getBoundingClientRect ??= () => new DOMRect()
Range.prototype.getClientRects ??= () =>
  ({
    length: 0,
    item: () => null,
    [Symbol.iterator]: [][Symbol.iterator],
  }) as unknown as DOMRectList
Element.prototype.scrollIntoView ??= () => undefined
document.elementFromPoint ??= () => null

const files = new Map<string, string>()
let threads: CommentThread[] = []
let refuse = false
const add = vi.fn()
const reply = vi.fn()
const setResolved = vi.fn()

vi.mock('@/lib/trpc', () => ({
  trpc: {
    notes: {
      read: {
        query: ({ path }: { path: string }) => Promise.resolve(files.get(path) ?? ''),
      },
      write: {
        mutate: (input: { path: string; text: string }) => {
          files.set(input.path, input.text)
          return Promise.resolve({ ok: true })
        },
      },
    },
    comments: {
      list: {
        query: () =>
          refuse
            ? Promise.reject(new Error('notes/Plan.md takes no comments'))
            : Promise.resolve(threads),
      },
      add: { mutate: (input: unknown) => add(input) },
      reply: { mutate: (input: unknown) => reply(input) },
      setResolved: { mutate: (input: unknown) => setResolved(input) },
    },
    history: { list: { query: () => Promise.resolve([]) } },
    github: {
      fileContributors: { query: () => Promise.resolve([]) },
      collaborators: { query: () => Promise.resolve({ collaborators: [] }) },
    },
    cap: { run: { mutate: () => Promise.resolve({ ok: true }) } },
  },
}))

vi.mock('@/state/agent-service', async () => {
  const { atom } = await import('jotai')
  // One atom for every call: a new one each render would re-render forever.
  const sessions = atom([])
  return {
    useAgentService: () => ({ name: 'Claude', sessions }),
    showAgentSessionAtom: atom(null, () => undefined),
  }
})

const PATH = 'notes/Plan.md'
const TEXT = '# Plan\n\nShip the beta on Friday.\n'

function thread(id: string, quote: string, extra: Partial<CommentThread> = {}): CommentThread {
  return {
    id,
    anchor: { quote, prefix: '', suffix: '', line: 3 },
    comments: [
      {
        id: `${id}1`,
        author: 'ada',
        at: '2026-10-24T09:00:00Z',
        body: `About ${quote}`,
      },
    ],
    status: null,
    ...extra,
  }
}

beforeEach(() => {
  files.clear()
  threads = []
  refuse = false
  add.mockReset()
  reply.mockReset()
  setResolved.mockReset()
})

function open() {
  files.set(PATH, TEXT)
  const store = createStore()
  store.set(activeRemoteAtom, 'syv/vault')
  store.set(snapshotAtom, {
    ...emptyVaultSnapshot(),
    docs: [{ path: PATH, kind: 'note', updatedAt: '2026-10-23T10:00:00Z' }],
  } as never)
  return render(
    <Provider store={store}>
      <DocumentView path={PATH} onOpen={() => undefined} />
    </Provider>,
  )
}

test('open threads are counted, tinted in the text and listed; a lost passage is detached', async () => {
  const user = userEvent.setup()
  threads = [
    thread('t1', 'the beta'),
    thread('t2', 'a passage since deleted'),
    thread('t3', 'Friday', {
      status: { resolved: true, by: 'bo', at: '2026-10-24T10:00:00Z' },
    }),
  ]
  open()
  const toggle = await screen.findByRole('button', { name: 'Comments, 2 open' })
  const box = await screen.findByRole('textbox', { name: 'Plan document' })
  await waitFor(() =>
    expect(box.querySelector("[data-comment-thread='t1']")).toHaveTextContent('the beta'),
  )
  // A resolved thread is not tinted.
  expect(box.querySelector("[data-comment-thread='t3']")).toBeNull()

  await user.click(toggle)
  const panel = screen.getByRole('complementary', { name: 'Comments' })
  expect(within(panel).getByText('About the beta')).toBeInTheDocument()
  const lost = panel.querySelector("[data-thread='t2']") as HTMLElement
  expect(within(lost).getByText('Detached')).toBeInTheDocument()

  await user.click(within(panel).getByRole('tab', { name: /Resolved/ }))
  expect(within(panel).getByText('Resolved by bo')).toBeInTheDocument()
})

test('a reply and a resolve go to the thread', async () => {
  const user = userEvent.setup()
  threads = [thread('t1', 'the beta')]
  reply.mockResolvedValue({ ok: true })
  setResolved.mockResolvedValue({ ok: true })
  open()
  await user.click(await screen.findByRole('button', { name: 'Comments, 1 open' }))
  const panel = screen.getByRole('complementary', { name: 'Comments' })
  await user.click(within(panel).getByRole('button', { name: 'Reply' }))
  await user.type(within(panel).getByRole('combobox', { name: 'Reply' }), 'Agreed')
  await user.click(within(panel).getAllByRole('button', { name: 'Reply' }).at(-1)!)
  await waitFor(() =>
    expect(reply).toHaveBeenCalledWith({
      remote: 'syv/vault',
      path: PATH,
      thread: 't1',
      body: 'Agreed',
    }),
  )
  await user.click(within(panel).getByRole('button', { name: 'Resolve' }))
  await waitFor(() =>
    expect(setResolved).toHaveBeenCalledWith({
      remote: 'syv/vault',
      path: PATH,
      thread: 't1',
      resolved: true,
    }),
  )
})

test('a selection becomes a thread quoting the file', async () => {
  const user = userEvent.setup()
  add.mockResolvedValue({ thread: 'new1' })
  open()
  const box = await screen.findByRole('textbox', { name: 'Plan document' })
  await screen.findByRole('button', { name: 'Comments' })
  // Select "the beta" in the editor through its DOM.
  const text = [...box.querySelectorAll('p')].find((p) =>
    p.textContent?.includes('Ship'),
  )!.firstChild!
  const at = text.textContent!.indexOf('the beta')
  const range = document.createRange()
  range.setStart(text, at)
  range.setEnd(text, at + 'the beta'.length)
  box.focus()
  const selection = window.getSelection()!
  selection.removeAllRanges()
  selection.addRange(range)
  document.dispatchEvent(new Event('selectionchange'))
  await waitFor(() => expect(window.getSelection()?.toString()).toBe('the beta'))

  await user.keyboard('{Control>}{Alt>}m{/Alt}{/Control}')
  const panel = await screen.findByRole('complementary', { name: 'Comments' })
  const draft = panel.querySelector('[data-comment-draft]') as HTMLElement
  expect(draft).toHaveTextContent('the beta')
  await user.type(within(draft).getByRole('combobox', { name: 'Comment' }), 'Which beta?')
  await user.click(within(draft).getByRole('button', { name: 'Comment' }))
  await waitFor(() =>
    expect(add).toHaveBeenCalledWith({
      remote: 'syv/vault',
      path: PATH,
      body: 'Which beta?',
      anchor: expect.objectContaining({ quote: 'the beta', line: 3 }),
    }),
  )
})

test('a file that takes no comments shows none', async () => {
  refuse = true
  open()
  await screen.findByRole('textbox', { name: 'Plan document' })
  await waitFor(() => expect(screen.queryByRole('button', { name: /^Comments/ })).toBeNull())
})
