/**
 * Convert to PDF: a render that brought everything out closes the dialog;
 * one that could not (an image, a diagram) says what, and closes on Done.
 */
import { render, screen } from '@/test/render'
import userEvent from '@testing-library/user-event'
import { Provider, createStore } from 'jotai'
import { beforeEach, expect, test, vi } from 'vitest'
import { Dialog } from '@/primitives'
import { ConvertToPdf } from '../renderer/ConvertToPdf'

const run = vi.hoisted(() => vi.fn())
vi.mock('@/lib/trpc', () => ({
  trpc: {
    cap: { run: { mutate: (input: unknown) => run(input) } },
    notes: { read: { query: () => Promise.resolve('# Offer\n') } },
  },
}))

const TEMPLATE = { name: 'Plain', slug: 'plain', description: '', fields: [], warnings: [] }
let warnings: string[] = []

beforeEach(() => {
  warnings = []
  run.mockReset()
  run.mockImplementation(async ({ name }: { name: string }) =>
    name === 'pdf.templates'
      ? [TEMPLATE]
      : { pdfPath: '/tmp/offer.pdf', vaultPath: null, bytes: 1000, warnings },
  )
  Object.assign(window, {
    holi: {
      ...(window as unknown as { holi?: object }).holi,
      showSaveDialog: vi.fn(async () => '/tmp/offer.pdf'),
      openPath: vi.fn(async () => undefined),
    },
  })
})

function setup() {
  const onClose = vi.fn()
  render(
    <Provider store={createStore()}>
      <Dialog open onClose={onClose}>
        <ConvertToPdf remote="syv/vault" path="offers/offer.md" onClose={onClose} />
      </Dialog>
    </Provider>,
  )
  return onClose
}

test('a clean render closes the dialog', async () => {
  const user = userEvent.setup()
  const onClose = setup()
  await screen.findByText('Plain')
  await user.click(screen.getByRole('button', { name: 'Convert' }))
  await vi.waitFor(() => expect(onClose).toHaveBeenCalled())
})

test('a render with warnings says what did not come out, and closes on Done', async () => {
  const user = userEvent.setup()
  warnings = ['The image photo.heic could not come out: Typst reads png, jpg, gif, webp and svg.']
  const onClose = setup()
  await screen.findByText('Plain')
  await user.click(screen.getByRole('button', { name: 'Convert' }))
  expect(await screen.findByText(/not everything came out as written/)).toBeInTheDocument()
  expect(screen.getByText(/photo\.heic/)).toBeInTheDocument()
  expect(onClose).not.toHaveBeenCalled()
  await user.click(screen.getByRole('button', { name: 'Done' }))
  expect(onClose).toHaveBeenCalled()
})
