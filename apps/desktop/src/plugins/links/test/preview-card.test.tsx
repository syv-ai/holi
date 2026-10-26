/**
 * A saved link's card: the page's title, site and description from main's
 * preview, opened in the browser on a click; and the claim's Open in Browser
 * opens what the file says now.
 */
import { render, screen } from '@/test/render'
import userEvent from '@testing-library/user-event'
import { Provider, createStore } from 'jotai'
import { emptyVaultSnapshot } from '@holi/shared'
import { beforeEach, expect, test, vi } from 'vitest'
import { activeRemoteAtom, snapshotAtom } from '@/plugin-api'
import { LINK_PATH_CLAIM } from '../renderer/claim'

const run = vi.hoisted(() => vi.fn())
const read = vi.hoisted(() => vi.fn())
vi.mock('@/lib/trpc', () => ({
  trpc: {
    cap: { run: { mutate: (input: unknown) => run(input) } },
    notes: { read: { query: (input: unknown) => read(input) } },
  },
}))

const PATH = 'Decks/link.q3-strategy.md'
const URL = 'https://docs.google.com/presentation/d/abc'
const openExternal = vi.fn(async () => undefined)

beforeEach(() => {
  run.mockReset()
  run.mockResolvedValue({
    url: URL,
    title: 'Q3 Strategy',
    siteName: 'Google Docs',
    description: 'The deck for the quarter.',
  })
  read.mockResolvedValue(`---\nurl: ${URL}\n---\n`)
  Object.assign(window, { holi: { ...(window as { holi?: object }).holi, openExternal } })
})

function store() {
  const s = createStore()
  s.set(activeRemoteAtom, 'syv/vault')
  s.set(snapshotAtom, {
    ...emptyVaultSnapshot(),
    claimed: { links: { items: [{ path: PATH, url: URL }], broken: [] } },
  } as never)
  return s
}

test("a link's tab shows its page as a card, which opens it in the browser", async () => {
  const Banner = LINK_PATH_CLAIM.banner!
  render(
    <Provider store={store()}>
      <Banner path={PATH} />
    </Provider>,
  )
  expect(await screen.findByText('Q3 Strategy')).toBeInTheDocument()
  expect(screen.getByText('Google Docs')).toBeInTheDocument()
  expect(screen.getByText('The deck for the quarter.')).toBeInTheDocument()
  expect(run).toHaveBeenCalledWith(expect.objectContaining({ name: 'links.preview' }))
  await userEvent.click(screen.getByText('Q3 Strategy'))
  expect(openExternal).toHaveBeenCalledWith(URL)
})

test('Open in Browser opens the address the file holds', async () => {
  const item = LINK_PATH_CLAIM.rowMenu![0]!
  expect(item.label).toBe('Open in Browser')
  item.run({ remote: 'syv/vault', path: PATH, openDialog: () => undefined })
  await vi.waitFor(() => expect(openExternal).toHaveBeenCalledWith(URL))
})

test('New Link refuses what is not a web address, before asking main', async () => {
  await expect(
    LINK_PATH_CLAIM.create!.run({ remote: 'syv/vault', parent: '', name: 'notes.md' }),
  ).rejects.toThrow(/isn’t a web address/)
  expect(run).not.toHaveBeenCalled()
})
