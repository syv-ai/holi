import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { Provider, createStore } from 'jotai'
import { createPortal } from 'react-dom'
import { useState } from 'react'
import userEvent from '@testing-library/user-event'
import { act, fireEvent, render, screen } from '@/test/render'
import { installHintLayout } from '@/test/host-hint-layout'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from '@/components/ui/dropdown-menu'
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from '@/components/ui/select'
import { useShortcutDispatcher, useShortcutHandlers } from '@/hooks/use-shortcuts'
import { vimCodeEditingAtom } from '@/state/preferences'
import { liveShortcutIdsAtom } from '@/state/shortcuts'
import { HostHintLayer } from '../host-hint-layer'

let store: ReturnType<typeof createStore>
let layout: ReturnType<typeof installHintLayout>
const help = vi.fn()
const search = vi.fn()
function Keys() {
  useShortcutDispatcher()
  useShortcutHandlers({ 'shortcuts.show': help, 'search.open': search })
  return null
}
function setup(children: React.ReactNode, enabled = true, scopeKey = 'vault:tab:one') {
  store = createStore()
  store.set(vimCodeEditingAtom, enabled)
  const element = (key: string) => (
    <Provider store={store}>
      <Keys />
      {children}
      <HostHintLayer scopeKey={key} />
    </Provider>
  )
  const result = render(element(scopeKey))
  return { ...result, scope: (key: string) => result.rerender(element(key)) }
}
function hints() {
  return [...document.querySelectorAll<HTMLElement>('[data-hint-key]')]
}
async function choose(name: string) {
  const hint = hints().find((node) => node.dataset.hintTarget === name)
  expect(hint, `hint for ${name}`).toBeDefined()
  await userEvent.keyboard(hint!.dataset.hintKey!)
}
beforeEach(() => {
  layout = installHintLayout()
  help.mockClear()
  search.mockClear()
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

test('normal host f discovers actual buttons including chrome and only the focused split', async () => {
  const click = vi.fn()
  setup(
    <>
      <Button>Sidebar</Button>
      <section data-pane="one" data-pane-focused>
        <Button onClick={click}>Focused</Button>
      </section>
      <section data-pane="two">
        <Button>Other</Button>
      </section>
    </>,
  )
  screen.getByRole('button', { name: 'Focused' }).focus()
  await userEvent.keyboard('f')
  expect(hints().map((node) => node.dataset.hintTarget)).toEqual(['Sidebar', 'Focused'])
  await choose('Focused')
  expect(click).toHaveBeenCalledTimes(1)
  expect(hints()).toHaveLength(0)
  expect(screen.getByRole('button', { name: 'Focused' })).toHaveFocus()
})

test('the preference defaults off, unregisters shortcut help and disables in-flight hints', async () => {
  setup(<Button>Action</Button>, false)
  screen.getByRole('button').focus()
  await userEvent.keyboard('f')
  expect(hints()).toHaveLength(0)
  expect(store.get(liveShortcutIdsAtom).has('vim.hints')).toBe(false)
  await act(async () => store.set(vimCodeEditingAtom, true))
  expect(store.get(liveShortcutIdsAtom).has('vim.hints')).toBe(true)
  await userEvent.keyboard('f')
  expect(hints()).toHaveLength(1)
  await act(async () => store.set(vimCodeEditingAtom, false))
  expect(hints()).toHaveLength(0)
})

test('Escape cancels without activating or moving focus; help and platform shortcuts still work', async () => {
  const click = vi.fn()
  setup(<Button onClick={click}>Action</Button>)
  const button = screen.getByRole('button')
  button.focus()
  await userEvent.keyboard('f{Escape}')
  expect(hints()).toHaveLength(0)
  expect(button).toHaveFocus()
  expect(click).not.toHaveBeenCalled()
  await userEvent.keyboard('f?')
  expect(help).toHaveBeenCalledTimes(1)
  expect(hints()).toHaveLength(0)
  await userEvent.keyboard('f')
  fireEvent.keyDown(button, { key: 'k', metaKey: true, ctrlKey: true })
  expect(hints()).toHaveLength(0)
})

test('ordinary fields, contenteditable, terminal, composition and repeated f are untouched', async () => {
  setup(
    <>
      <Button>Action</Button>
      <input aria-label="Field" />
      <div contentEditable suppressContentEditableWarning aria-label="Note" />
      <div className="xterm">
        <textarea aria-label="Terminal" />
      </div>
    </>,
  )
  const input = screen.getByLabelText('Field')
  input.focus()
  await userEvent.keyboard('f')
  expect(input).toHaveValue('f')
  const note = screen.getByLabelText('Note')
  note.focus()
  await userEvent.keyboard('f')
  expect(note).toHaveTextContent('f')
  screen.getByLabelText('Terminal').focus()
  await userEvent.keyboard('f')
  expect(hints()).toHaveLength(0)
  const button = screen.getByRole('button')
  button.focus()
  fireEvent.keyDown(button, { key: 'f', isComposing: true })
  expect(hints()).toHaveLength(0)
  fireEvent.keyDown(button, { key: 'f', repeat: true })
  expect(hints()).toHaveLength(0)
})

test('many targets require complete multi-character labels and prefix-filter visible labels', async () => {
  const click = vi.fn()
  setup(
    <>
      {Array.from({ length: 30 }, (_, i) => (
        <Button key={i} onClick={() => click(i)}>
          Action {i}
        </Button>
      ))}
    </>,
  )
  screen.getByRole('button', { name: 'Action 0' }).focus()
  await userEvent.keyboard('f')
  expect(hints()).toHaveLength(30)
  expect(hints().every((hint) => hint.dataset.hintKey!.length === 2)).toBe(true)
  await userEvent.keyboard('s')
  expect(click).not.toHaveBeenCalled()
  expect(hints()).toHaveLength(4)
  await userEvent.keyboard('a')
  expect(click).toHaveBeenCalledExactlyOnceWith(26)
})

test('stale controls never activate and layout, scope, pointer, focus, composition and blur cancel', async () => {
  const click = vi.fn()
  const fixture = setup(
    <>
      <Button onClick={click}>Action</Button>
      <Button>Other</Button>
    </>,
  )
  const action = screen.getByRole('button', { name: 'Action' })
  action.focus()
  await userEvent.keyboard('f')
  action.setAttribute('disabled', '')
  await userEvent.keyboard('a')
  expect(click).not.toHaveBeenCalled()
  expect(hints()).toHaveLength(0)
  action.removeAttribute('disabled')
  for (const cancel of [
    () => fireEvent.resize(window),
    () => fireEvent.scroll(window),
    () => fireEvent.compositionStart(action),
    () => fireEvent.blur(window),
    () => fireEvent.pointerDown(action),
    () => screen.getByRole('button', { name: 'Other' }).focus(),
  ]) {
    action.focus()
    await userEvent.keyboard('f')
    expect(hints().length).toBeGreaterThan(0)
    await act(async () => cancel())
    expect(hints()).toHaveLength(0)
  }
  action.focus()
  await userEvent.keyboard('f')
  fixture.scope('another-vault:tab:one')
  expect(hints()).toHaveLength(0)
})

test('covered and moved targets are invalidated before a label can run', async () => {
  const click = vi.fn()
  setup(<Button onClick={click}>Action</Button>)
  const action = screen.getByRole('button')
  action.focus()
  await userEvent.keyboard('f')
  layout.place(action, 300, 300)
  await userEvent.keyboard('a')
  expect(click).not.toHaveBeenCalled()
  expect(hints()).toHaveLength(0)
})

test('SVG graph-node links receive hints and bubble a mouse click from their painted child', async () => {
  const open = vi.fn()
  setup(
    <>
      <Button>Start</Button>
      <svg>
        <g role="link" tabIndex={0} aria-label="Open graph note" onClick={open}>
          <circle data-testid="graph-dot" cx="20" cy="20" r="10" />
        </g>
      </svg>
    </>,
  )
  const node = screen.getByRole('link')
  layout.place(node, 300, 100, 24, 24)
  layout.place(screen.getByTestId('graph-dot'), 300, 100, 24, 24)
  screen.getByRole('button').focus()
  await userEvent.keyboard('f')
  await choose('Open graph note')
  expect(open).toHaveBeenCalledTimes(1)
  expect(node).toHaveFocus()
})

test('stock switch toggles exactly once through its native click', async () => {
  function Fixture() {
    const [checked, set] = useState(false)
    return <Switch aria-label="Toggle" checked={checked} onCheckedChange={set} />
  }
  setup(<Fixture />)
  screen.getByRole('switch').focus()
  await userEvent.keyboard('f')
  await choose('Toggle')
  expect(screen.getByRole('switch')).toBeChecked()
})

test('stock Radix menu opens with a hinted pointer press and its portal owns subsequent hints', async () => {
  const select = vi.fn()
  setup(
    <>
      <Button>Background</Button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button>Menu</Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuItem onSelect={select}>Choose item</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </>,
  )
  screen.getByRole('button', { name: 'Background' }).focus()
  await userEvent.keyboard('f')
  await choose('Menu')
  const item = await screen.findByRole('menuitem')
  item.focus()
  await userEvent.keyboard('f')
  expect(hints().map((hint) => hint.dataset.hintTarget)).toEqual(['Choose item'])
  await choose('Choose item')
  expect(select).toHaveBeenCalledTimes(1)
})

test('stock Select trigger and option use their existing mouse path', async () => {
  const select = vi.fn()
  setup(
    <Select onValueChange={select}>
      <SelectTrigger aria-label="Choice">
        <SelectValue placeholder="Choose" />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="one">One</SelectItem>
        <SelectItem value="two">Two</SelectItem>
      </SelectContent>
    </Select>,
  )
  screen.getByRole('combobox').focus()
  await userEvent.keyboard('f')
  await choose('Choice')
  const item = await screen.findByRole('option', { name: 'Two' })
  item.focus()
  await userEvent.keyboard('f')
  await choose('Two')
  expect(select).toHaveBeenCalledExactlyOnceWith('two')
})

test('nested portalled overlays use their focused top layer and Escape leaves the overlay open', async () => {
  setup(
    <>
      <Button>Background</Button>
      {createPortal(
        <div role="dialog" aria-label="Dialog">
          <Button>Dialog button</Button>
        </div>,
        document.body,
      )}
      {createPortal(
        <div role="menu" aria-label="Nested">
          <Button role="menuitem">Nested item</Button>
        </div>,
        document.body,
      )}
    </>,
  )
  screen.getByRole('menuitem').focus()
  await userEvent.keyboard('f')
  expect(hints().map((hint) => hint.dataset.hintTarget)).toEqual(['Nested item'])
  await userEvent.keyboard('{Escape}')
  expect(screen.getByRole('menu')).toBeInTheDocument()
  expect(screen.getByRole('menuitem')).toHaveFocus()
})
