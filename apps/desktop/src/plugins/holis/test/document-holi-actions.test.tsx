/**
 * Send to Holi: the Holis plugin's rows in a document's Agent menu (core's
 * pane header draws the menu from the plugin slot; its own test covers that).
 * The Holis that take the document come first; a send to one not approved
 * here opens the approval dialog, showing its soul, instead of running; making
 * one starts from the document's folder.
 */
import { render, screen } from '@/test/render'
import userEvent from '@testing-library/user-event'
import { Provider, createStore } from 'jotai'
import { expect, test, vi } from 'vitest'
import { activeRemoteAtom } from '@/plugin-api'
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from '@/primitives'
import { ApproveHoliDialog } from '../renderer/approve-holi-dialog'
import { DocumentHoliActions } from '../renderer/document-holi-actions'
import { holisAtom, holiWizardAtom, pendingApprovalAtom, type HoliSummary } from '../renderer/state'

const send = vi.fn()
const create = vi.fn()
vi.mock('../renderer/holis-cap', () => ({
  holiCap: {
    list: vi.fn(),
    send: (...a: unknown[]) => send(...a),
    create: (...a: unknown[]) => create(...a),
  },
}))

const holi = (over: Partial<HoliSummary>): HoliSummary => ({
  id: 'x',
  path: '.holi/holis/x/holi.yaml',
  dir: '.holi/holis/x',
  local: false,
  folder: true,
  name: 'X',
  status: 'approved',
  accepts: [],
  allow: [],
  soul: 'Do it.',
  unknownKeys: [],
  fingerprint: 'f',
  runs: [],
  ...over,
})

function setup() {
  const store = createStore()
  store.set(activeRemoteAtom, 'o/vault')
  store.set(holisAtom, [
    holi({ id: 'proposal', name: 'Proposal', accepts: ['kunder/**/*.md'], status: 'new' }),
    holi({ id: 'notes', name: 'Notes tidy', accepts: ['Notes/**'] }),
    holi({ id: 'broken', name: 'Broken', status: 'invalid' }),
  ])
  render(
    <Provider store={store}>
      <DropdownMenu>
        <DropdownMenuTrigger aria-label="More with this document">More</DropdownMenuTrigger>
        <DropdownMenuContent>
          <DocumentHoliActions path="kunder/nordlys.md" />
        </DropdownMenuContent>
      </DropdownMenu>
      <ApproveHoliDialog />
    </Provider>,
  )
  return store
}

test('lists the Holis that take the document first, broken ones never', async () => {
  setup()
  await userEvent.click(screen.getByLabelText('More with this document'))
  expect(screen.getByText('Send to Holi')).toBeTruthy()
  expect(screen.getByRole('menuitem', { name: /Proposal/ })).toBeTruthy()
  expect(screen.getByRole('menuitem', { name: /All Holis/ })).toBeTruthy()
  expect(screen.queryByText('Broken')).toBeNull()
})

test('a Holi not approved here asks first, showing its soul', async () => {
  const store = setup()
  await userEvent.click(screen.getByLabelText('More with this document'))
  await userEvent.click(screen.getByRole('menuitem', { name: /Proposal/ }))
  expect(send).not.toHaveBeenCalled()
  expect(store.get(pendingApprovalAtom)?.path).toBe('kunder/nordlys.md')
  expect(await screen.findByText('Run Proposal on this machine?')).toBeTruthy()
  expect(screen.getByText('Do it.')).toBeTruthy()
})

test('New Holi opens the wizard from the document folder', async () => {
  const store = setup()
  await userEvent.click(screen.getByLabelText('More with this document'))
  await userEvent.click(screen.getByRole('menuitem', { name: /New Holi/ }))
  expect(create).not.toHaveBeenCalled()
  expect(store.get(holiWizardAtom)).toEqual({
    mode: 'create',
    draft: { accepts: ['kunder/**/*.md'] },
  })
})
