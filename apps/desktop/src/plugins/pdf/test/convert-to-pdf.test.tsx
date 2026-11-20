/**
 * Convert to PDF: a render that brought everything out closes the dialog;
 * one that could not (an image, a diagram) says what, and closes on Done.
 */
import { render, screen } from '@/test/render'
import userEvent from '@testing-library/user-event'
import { Provider, createStore } from 'jotai'
import { beforeEach, expect, test, vi } from 'vitest'
import { Dialog, DialogContent } from '@/components/ui/dialog'
import { ConvertToPdf } from '../renderer/convert-to-pdf'
import reportManifest from '../main/vault/once/.holi/document-templates/report/template.json'
import { parseFields } from '../shared/template-fields'

const run = vi.hoisted(() => vi.fn())
vi.mock('@/lib/trpc', () => ({
  trpc: {
    cap: { run: { mutate: (input: unknown) => run(input) } },
    notes: { read: { query: () => Promise.resolve('# Offer\n') } },
  },
}))

const TEMPLATE = {
  ...reportManifest,
  slug: 'report',
  ...parseFields(reportManifest.fields),
}
let warnings: string[] = []

beforeEach(() => {
  warnings = []
  run.mockReset()
  run.mockImplementation(async ({ name }: { name: string }) =>
    name === 'pdf.templates'
      ? [TEMPLATE]
      : { pdfPath: '/v/offers/offer.pdf', vaultPath: 'offers/offer.pdf', bytes: 1000, warnings },
  )
})

function setup(path = 'offers/offer.md') {
  const onClose = vi.fn()
  render(
    <Provider store={createStore()}>
      <Dialog open onOpenChange={(open) => !open && onClose()}>
        <DialogContent>
          <ConvertToPdf remote="syv/vault" path={path} onClose={onClose} />
        </DialogContent>
      </Dialog>
    </Provider>,
  )
  return onClose
}

test('a clean render, beside the note and never over a file, closes the dialog', async () => {
  const user = userEvent.setup()
  const onClose = setup()
  await screen.findByText('Report')
  await user.click(screen.getByRole('button', { name: 'Convert' }))
  await vi.waitFor(() => expect(onClose).toHaveBeenCalled())
  const calls = run.mock.calls.map(([input]) => input as { name: string; paramsJson: string })
  const params: unknown = JSON.parse(calls.find((c) => c.name === 'pdf.render')?.paramsJson ?? '')
  expect(params).toMatchObject({ path: 'offers/offer.md', unique: true })
  expect(params).not.toHaveProperty('out')
})

test('the Report dialog sends edited Title and Client metadata into rendering', async () => {
  const user = userEvent.setup()
  const onClose = setup('kunder/Acme/reports/offer.md')
  await vi.waitFor(() => {
    expect(screen.getByRole('textbox', { name: 'Title' })).toHaveValue('Offer')
    expect(screen.getByRole('textbox', { name: 'Client' })).toHaveValue('Acme')
  })
  await user.clear(screen.getByRole('textbox', { name: 'Title' }))
  await user.type(screen.getByRole('textbox', { name: 'Title' }), 'Edited title')
  await user.clear(screen.getByRole('textbox', { name: 'Client' }))
  await user.type(screen.getByRole('textbox', { name: 'Client' }), 'Edited client')
  await user.click(screen.getByRole('button', { name: 'Convert' }))
  await vi.waitFor(() => expect(onClose).toHaveBeenCalled())
  const calls = run.mock.calls.map(([input]) => input as { name: string; paramsJson: string })
  const params: unknown = JSON.parse(calls.find((c) => c.name === 'pdf.render')?.paramsJson ?? '')
  expect(params).toMatchObject({
    path: 'kunder/Acme/reports/offer.md',
    template: 'report',
    meta: { title: 'Edited title', client: 'Edited client' },
  })
})

test('a render with warnings says what did not come out, and closes on Done', async () => {
  const user = userEvent.setup()
  warnings = ['The image photo.heic could not come out: Typst reads png, jpg, gif, webp and svg.']
  const onClose = setup()
  await screen.findByText('Report')
  await user.click(screen.getByRole('button', { name: 'Convert' }))
  expect(await screen.findByText(/not everything came out as written/)).toBeInTheDocument()
  expect(screen.getByText(/photo\.heic/)).toBeInTheDocument()
  expect(onClose).not.toHaveBeenCalled()
  await user.click(screen.getByRole('button', { name: 'Done' }))
  expect(onClose).toHaveBeenCalled()
})
