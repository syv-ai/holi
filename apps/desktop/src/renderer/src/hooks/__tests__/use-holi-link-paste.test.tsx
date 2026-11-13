import { render } from '@/test/render'
import { beforeEach, expect, test, vi } from 'vitest'
import { useHoliLinkPaste } from '../use-holi-link-paste'

const mocks = vi.hoisted(() => {
  const mutate = vi.fn()
  const toast = Object.assign(vi.fn(), { error: vi.fn() })
  return { mutate, toast }
})
vi.mock('@/lib/trpc', () => ({ trpc: { holiLinks: { openPasted: { mutate: mocks.mutate } } } }))
vi.mock('sonner', () => ({ toast: mocks.toast }))

function Listener() {
  useHoliLinkPaste()
  return null
}

function paste(target: Element, text: string, init: Record<string, unknown> = {}) {
  const event = new Event('paste', { bubbles: true, cancelable: true })
  Object.assign(event, init, {
    clipboardData: { getData: () => text },
  })
  target.dispatchEvent(event)
  return event
}

beforeEach(() => {
  mocks.mutate.mockReset()
  mocks.mutate.mockResolvedValue({ ok: true })
  mocks.toast.error.mockReset()
  document.body.innerHTML = ''
})

test.each([
  'holi://open?vault=a/b&path=a.md',
  'https://syv-ai.github.io/holi/#vault=a/b&path=a.md',
])(
  'routes a trimmed Holi link from page paste and prevents its text insertion: %s',
  async (url) => {
    render(<Listener />)
    const event = paste(document.body, `  ${url}  `, { ctrlKey: true })
    expect(event.defaultPrevented).toBe(true)
    expect(mocks.mutate).toHaveBeenCalledWith({ url })
    await new Promise<void>((resolve) => queueMicrotask(resolve))
    expect(mocks.toast).not.toHaveBeenCalled()
  },
)

test('does not intercept ordinary text or an already-handled paste', () => {
  render(<Listener />)
  expect(paste(document.body, 'just text').defaultPrevented).toBe(false)
  const handled = paste(document.body, 'holi://open?vault=a/b&path=a.md')
  expect(handled.defaultPrevented).toBe(true)
  mocks.mutate.mockClear()
  const earlier = new Event('paste', { bubbles: true, cancelable: true })
  earlier.preventDefault()
  Object.assign(earlier, { clipboardData: { getData: () => 'holi://open?vault=a/b&path=a.md' } })
  document.body.dispatchEvent(earlier)
  expect(mocks.mutate).not.toHaveBeenCalled()
})

test('leaves editor, form and terminal pastes to their owner without a dialog', () => {
  render(<Listener />)
  const editor = document.createElement('div')
  editor.className = 'cm-editor'
  const contentEditable = document.createElement('div')
  contentEditable.setAttribute('contenteditable', 'true')
  const input = document.createElement('input')
  const terminal = document.createElement('div')
  terminal.className = 'xterm'
  const textarea = document.createElement('textarea')
  document.body.append(editor, contentEditable, input, textarea, terminal)
  for (const target of [editor, contentEditable, input, textarea, terminal]) {
    expect(paste(target, 'holi://open?vault=a/b&path=a.md').defaultPrevented).toBe(false)
  }
  expect(mocks.mutate).not.toHaveBeenCalled()
})

test.each(['dialog', 'alertdialog'])('ignores page paste while an open %s exists', (role) => {
  render(<Listener />)
  const dialog = document.createElement('div')
  dialog.setAttribute('role', role)
  dialog.setAttribute('data-state', 'open')
  document.body.append(dialog)
  expect(paste(document.body, 'holi://open?vault=a/b&path=a.md').defaultPrevented).toBe(false)
  expect(mocks.mutate).not.toHaveBeenCalled()
})

test('routes an uppercase scheme through the same main-side opener', () => {
  render(<Listener />)
  expect(paste(document.body, ' HOLI://open?vault=a/b&path=a.md ').defaultPrevented).toBe(true)
  expect(mocks.mutate).toHaveBeenCalledWith({ url: 'HOLI://open?vault=a/b&path=a.md' })
})

test('shows main-side failures as error toasts and never announces success', async () => {
  mocks.mutate.mockResolvedValue({ ok: false, message: 'not found', detail: 'sync it' })
  render(<Listener />)
  paste(document.body, 'holi://open?vault=a/b&path=a.md')
  await vi.waitFor(() =>
    expect(mocks.toast.error).toHaveBeenCalledWith('not found', { description: 'sync it' }),
  )
  expect(mocks.toast).not.toHaveBeenCalled()
})

test('subscribes once and removes the listener on unmount', () => {
  const add = vi.spyOn(document, 'addEventListener')
  const remove = vi.spyOn(document, 'removeEventListener')
  const view = render(<Listener />)
  expect(add.mock.calls.filter(([type]) => type === 'paste')).toHaveLength(1)
  view.unmount()
  expect(remove.mock.calls.filter(([type]) => type === 'paste')).toHaveLength(1)
  add.mockRestore()
  remove.mockRestore()
})
