/**
 * "Edit Icon…" writes `.holi/settings/icons.yaml` — for a note, a folder or a PDF alike.
 *
 * The field holds one emoji and refuses anything else, so most of what would
 * otherwise be validation is tested as input behaviour instead.
 *
 * **Emoji go in with `paste`, never `type`.** `userEvent.type` sends one UTF-16
 * unit per keystroke, so `👥` arrives as two lone surrogates and `👩‍💻` as five
 * fragments — neither of which is an emoji, and both of which the field
 * correctly refuses. No real input method does that: the macOS picker inserts
 * the whole sequence in one event, and a physical keyboard cannot type a ZWJ at
 * all. `paste` is that single atomic insert.
 */
import { beforeEach, expect, test, vi } from 'vitest'
import userEvent from '@testing-library/user-event'
import { render, screen } from '@/test/render'
import { Dialog } from '@/primitives'
import { EditIcon } from '../EditIcon'

const setIcon = vi.fn((_i: unknown) => Promise.resolve({ ok: true as const }))
vi.mock('@/lib/trpc', () => ({
  trpc: { notes: { setIcon: { mutate: (i: unknown) => setIcon(i) } } },
}))

const open = (over: { path?: string; current?: string | null } = {}) => {
  const onClose = vi.fn()
  const onOpenMap = vi.fn()
  // Mounted the way DialogHost mounts it: the block fills a Dialog's slots and
  // `Dialog.Header` refuses to render outside one.
  render(
    <Dialog open size="sm" onClose={onClose}>
      <EditIcon
        remote="o/r"
        path={over.path ?? 'Clients'}
        current={over.current ?? null}
        onOpenMap={onOpenMap}
        onClose={onClose}
      />
    </Dialog>,
  )
  return { onClose, onOpenMap, field: screen.getByLabelText('Icon') as HTMLInputElement }
}

beforeEach(() => setIcon.mockClear())

test('saves the emoji against the path', async () => {
  const { onClose, field } = open()

  await userEvent.click(field)
  await userEvent.paste('👥')
  await userEvent.click(screen.getByText('Save'))

  expect(setIcon).toHaveBeenCalledWith({ remote: 'o/r', path: 'Clients', emoji: '👥' })
  expect(onClose).toHaveBeenCalled()
})

test('opens filled in when the path already has an icon', () => {
  expect(open({ current: '👥' }).field.value).toBe('👥')
})

// No Clear button: emptying the field is the gesture, so it has to reach the
// mutation as a clear rather than as an empty string.
test('an empty field clears the entry rather than writing an empty one', async () => {
  const { field } = open({ current: '👥' })

  await userEvent.clear(field)
  await userEvent.click(screen.getByText('Save'))

  expect(setIcon).toHaveBeenCalledWith({ remote: 'o/r', path: 'Clients', emoji: undefined })
})

test('offers no Clear button', () => {
  open({ current: '👥' })
  expect(screen.queryByText('Clear')).toBeNull()
})

test('refuses to hold anything that is not an emoji', async () => {
  const { field } = open()

  await userEvent.click(field)
  await userEvent.paste('rocket')

  expect(field.value).toBe('')
})

// Picking again is how you change your mind, so the second emoji replaces the
// first rather than being refused for making the value too long.
test('a second emoji replaces the first', async () => {
  const { field } = open()

  await userEvent.click(field)
  await userEvent.paste('👥')
  await userEvent.paste('📅')

  expect(field.value).toBe('📅')
})

test('keeps a multi-codepoint emoji whole', async () => {
  const { field } = open()

  // Five code points, one grapheme — slicing by length would cut it in half.
  await userEvent.click(field)
  await userEvent.paste('👩‍💻')

  expect(field.value).toBe('👩‍💻')
})

test('the map link opens the file and closes the dialog', async () => {
  const { onClose, onOpenMap } = open()

  await userEvent.click(screen.getByText('.holi/settings/icons.yaml'))

  expect(onOpenMap).toHaveBeenCalledTimes(1)
  expect(onClose).toHaveBeenCalledTimes(1)
})

test('stays open when the write fails, rather than looking like it worked', async () => {
  setIcon.mockRejectedValueOnce(new Error('disk full'))
  const { onClose, field } = open()

  await userEvent.click(field)
  await userEvent.paste('👥')
  await userEvent.click(screen.getByText('Save'))

  expect(await screen.findByText('disk full')).toBeTruthy()
  expect(onClose).not.toHaveBeenCalled()
})
