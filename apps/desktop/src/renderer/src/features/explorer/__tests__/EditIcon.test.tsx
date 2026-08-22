/**
 * "Edit Icon…" writes `.holi/icons.json` — for a note, a folder or a PDF alike.
 */
import { beforeEach, expect, test, vi } from 'vitest'
import userEvent from '@testing-library/user-event'
import { render, screen } from '@/test/render'
import { Dialog } from '@/primitives'
import { EditIcon } from '../EditIcon'

const setIcon = vi.fn((_i: unknown) => Promise.resolve({ ok: true as const }))
vi.mock('@/lib/trpc', () => ({ trpc: { notes: { setIcon: { mutate: (i: unknown) => setIcon(i) } } } }))

const open = (over: Partial<Parameters<typeof EditIcon>[0]> = {}) => {
  const onClose = vi.fn()
  // Mounted the way DialogHost mounts it: the block fills a Dialog's slots and
  // `Dialog.Header` refuses to render outside one.
  render(
    <Dialog open size="sm" onClose={onClose}>
      <EditIcon
        remote="o/r"
        path="Clients"
        current={null}
        frontmatter={null}
        onClose={onClose}
        {...over}
      />
    </Dialog>,
  )
  return { onClose }
}

beforeEach(() => setIcon.mockClear())

test('saves the emoji against the path', async () => {
  const { onClose } = open()

  await userEvent.type(screen.getByLabelText('Icon'), '👥')
  await userEvent.click(screen.getByText('Save'))

  expect(setIcon).toHaveBeenCalledWith({ remote: 'o/r', path: 'Clients', emoji: '👥' })
  expect(onClose).toHaveBeenCalled()
})

// Clearing is the same gesture, so it must not be a second dialog: an empty
// field and the Clear button both mean "no entry".
test('an empty field clears the entry rather than writing an empty one', async () => {
  open({ current: '👥' })

  await userEvent.clear(screen.getByLabelText('Icon'))
  await userEvent.click(screen.getByText('Save'))

  expect(setIcon).toHaveBeenCalledWith({ remote: 'o/r', path: 'Clients', emoji: undefined })
})

test('Clear is offered only when there is an entry to clear', () => {
  open({ current: null })
  expect(screen.queryByText('Clear')).toBeNull()
})

test('refuses to save something that is not one emoji', async () => {
  open()

  await userEvent.type(screen.getByLabelText('Icon'), 'rocket')

  expect(screen.getByText(/not a single emoji/)).toBeTruthy()
  expect(screen.getByText('Save')).toBeDisabled()
  expect(setIcon).not.toHaveBeenCalled()
})

// The one outcome that would make the dialog look broken: writing an entry the
// note's own frontmatter then outranks, with nothing said about it.
test("says so when the note's frontmatter already wins", () => {
  open({ path: 'roadmap.md', frontmatter: '🎯' })
  expect(screen.getByText(/takes precedence/)).toBeTruthy()
})

test('stays open when the write fails, rather than looking like it worked', async () => {
  setIcon.mockRejectedValueOnce(new Error('disk full'))
  const { onClose } = open()

  await userEvent.type(screen.getByLabelText('Icon'), '👥')
  await userEvent.click(screen.getByText('Save'))

  expect(await screen.findByText('disk full')).toBeTruthy()
  expect(onClose).not.toHaveBeenCalled()
})
