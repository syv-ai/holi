import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { Provider, createStore } from 'jotai'
import { createPortal } from 'react-dom'
import { useState } from 'react'
import userEvent from '@testing-library/user-event'
import { act, fireEvent, render, screen, waitFor } from '@/test/render'
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
import {
  HOST_HINT_REQUEST,
  HOST_HINT_SURFACE,
  registerHostHintAdapter,
  registerAsyncHostHintAdapter,
  type AsyncHostHintAdapter,
  requestAdaptedHostHints,
  type HostHintAdapter,
} from '@/lib/host-hints'

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

test('async adapter preparation is request-scoped and cannot replace a newer hint session', async () => {
  let finish!: () => void
  const element = document.createElement('button')
  element.textContent = 'Prepared'
  const owner = document.createElement('div')
  const activate = vi.fn(() => true)
  const cancelPrepare = vi.fn()
  const adapter: HostHintAdapter = {
    prepare: () =>
      new Promise<void>((resolve) => {
        finish = resolve
      }),
    cancelPrepare,
    discover: () => [{ element, label: 'Prepared', x: 100, y: 100, token: 'one' }],
    unchanged: () => true,
    activate,
  }
  const view = setup(<div data-pane-focused data-pane="pane" />)
  const root = document.querySelector<HTMLElement>('[data-pane-focused]')!
  root.append(element, owner)
  registerHostHintAdapter(owner, adapter)
  act(() => requestAdaptedHostHints(owner, adapter))
  expect(hints()).toHaveLength(0)
  act(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })))
  expect(cancelPrepare).toHaveBeenCalledOnce()
  await act(async () => finish())
  expect(hints()).toHaveLength(0)
  expect(activate).not.toHaveBeenCalled()
  view.unmount()
})

test('prepared app and asynchronous browser hints share unique labels and keyboard activation', async () => {
  let finish!: () => void
  const view = setup(
    <section data-pane-focused data-pane="pane">
      <button>Native action</button>
      <div data-testid="prepared-app-target" />
      <div data-testid="prepared-app-owner" />
      <iframe data-testid="async-browser-owner" />
    </section>,
  )
  const appOwner = screen.getByTestId('prepared-app-owner')
  const appTarget = screen.getByTestId('prepared-app-target')
  const appAdapter: HostHintAdapter = {
    prepare: () => new Promise<void>((resolve) => (finish = resolve)),
    discover: () => [
      { element: appTarget, label: 'Prepared app action', x: 100, y: 100, token: 'app' },
    ],
    unchanged: () => true,
    activate: () => true,
  }
  const browserTarget = { id: 'browser-action', label: 'Browser action', x: 200, y: 100 }
  const activateBrowser = vi.fn(async () => true)
  const presentBrowser = vi.fn(
    async (
      _request: number,
      _revision: number,
      _labels: readonly { id: string; key: string }[],
      _presentation?: Parameters<AsyncHostHintAdapter['present']>[3],
    ) => true,
  )
  const clearBrowser = vi.fn((_request: number) => {})
  const browserAdapter: AsyncHostHintAdapter = {
    discover: vi.fn(async () => [browserTarget]),
    present: presentBrowser,
    clear: clearBrowser,
    activate: activateBrowser,
    subscribe: vi.fn(() => () => {}),
  }
  const browserOwner = screen.getByTestId('async-browser-owner')
  registerHostHintAdapter(appOwner, appAdapter)
  registerAsyncHostHintAdapter(browserOwner, browserAdapter)
  act(() => requestAdaptedHostHints(appOwner, appAdapter))
  expect(hints()).toHaveLength(0)
  await act(async () => finish())

  const syncHints = hints()
  expect(syncHints.map((hint) => hint.dataset.hintTarget)).toEqual([
    'Native action',
    'Prepared app action',
  ])
  const browserLabels = presentBrowser.mock.calls[0]![2]
  expect(browserLabels).toHaveLength(1)
  expect(browserLabels[0]!.id).toBe('browser-action')
  expect(
    new Set([
      ...syncHints.map((hint) => hint.dataset.hintKey!),
      ...browserLabels.map(({ key }) => key),
    ]).size,
  ).toBe(3)
  expect(syncHints.some((hint) => hint.dataset.hintTarget === 'Browser action')).toBe(false)

  const event = new KeyboardEvent('keydown', {
    key: browserLabels[0]!.key,
    bubbles: true,
    cancelable: true,
  })
  await act(async () => {
    window.dispatchEvent(event)
  })
  expect(event.defaultPrevented).toBe(true)
  expect(activateBrowser).toHaveBeenCalledTimes(1)
  expect(activateBrowser).toHaveBeenCalledWith(1, 'browser-action')
  expect(clearBrowser).toHaveBeenCalledTimes(1)
  expect(clearBrowser).toHaveBeenCalledWith(1)
  view.unmount()
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

test('shares real keyboard labels and native mouse activation with the owned PDF root', async () => {
  const clicked = vi.fn()
  const owner = document.createElement('holi-pdf-container')
  const shadow = owner.attachShadow({ mode: 'open' })
  const control = document.createElement('button')
  control.textContent = 'PDF sidebar'
  control.addEventListener('click', clicked)
  shadow.append(control)
  const pane = (
    <section data-pane="one" data-pane-focused>
      <Button>Host action</Button>
      <div ref={(element) => element?.append(owner)} />
    </section>
  )
  setup(pane)
  layout.place(owner, 300, 100)
  layout.place(control, 300, 100)
  Object.defineProperty(shadow, 'elementFromPoint', {
    configurable: true,
    value: (x: number, y: number) => (x >= 300 && x < 400 && y >= 100 && y < 124 ? control : null),
  })
  act(() =>
    window.dispatchEvent(
      new CustomEvent(HOST_HINT_SURFACE, { detail: { root: shadow, owner, registered: true } }),
    ),
  )
  screen.getByRole('button', { name: 'Host action' }).focus()
  await userEvent.keyboard('f')
  expect(hints().map((hint) => hint.dataset.hintTarget)).toEqual(['Host action', 'PDF sidebar'])
  await choose('PDF sidebar')
  expect(clicked).toHaveBeenCalledOnce()
  act(() =>
    window.dispatchEvent(
      new CustomEvent(HOST_HINT_SURFACE, { detail: { root: shadow, owner, registered: false } }),
    ),
  )
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

test('Escape reaches dialogs and text fields when no hint session owns it', async () => {
  const close = vi.fn()
  const key = vi.fn()
  setup(
    <>
      <div
        role="dialog"
        aria-label="Dialog"
        onKeyDown={(event) => {
          if (event.key === 'Escape') close()
        }}
      >
        <input aria-label="Dialog field" />
      </div>
      <input aria-label="Outside field" onKeyDown={key} />
    </>,
  )

  screen.getByLabelText('Dialog field').focus()
  await userEvent.keyboard('{Escape}')
  expect(close).toHaveBeenCalledOnce()
  expect(hints()).toHaveLength(0)

  screen.getByLabelText('Outside field').focus()
  await userEvent.keyboard('{Escape}')
  expect(key).toHaveBeenCalledOnce()
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

test('exclusive adapted requests ignore async sources while prepared guest labels activate', async () => {
  let finish!: () => void
  const activate = vi.fn(() => true)
  let guestElement!: Element
  const guestAdapter: HostHintAdapter = {
    exclusive: true,
    prepare: vi.fn(() => new Promise<void>((resolve) => (finish = resolve))),
    discover: vi.fn(() => [
      { element: guestElement, label: 'Guest action', x: 80, y: 90, token: 'guest:1' },
    ]),
    unchanged: () => true,
    activate,
  }
  const asyncTarget = { id: 'unrelated', label: 'Unrelated app action', x: 20, y: 20 }
  const asyncAdapter: AsyncHostHintAdapter = {
    discover: vi.fn(async () => [asyncTarget]),
    present: vi.fn(async () => true),
    clear: vi.fn(),
    activate: vi.fn(async () => true),
    subscribe: vi.fn(() => () => {}),
  }
  const view = setup(
    <section data-pane="one" data-pane-focused>
      <Button>Host control</Button>
      <div data-testid="guest-owner" />
      <iframe data-testid="unrelated-app-owner" />
    </section>,
  )
  const owner = screen.getByTestId('guest-owner')
  guestElement = owner
  registerHostHintAdapter(owner, guestAdapter)
  registerAsyncHostHintAdapter(screen.getByTestId('unrelated-app-owner'), asyncAdapter)

  act(() => requestAdaptedHostHints(owner, guestAdapter))
  expect(hints()).toHaveLength(0)
  await act(async () => finish())
  await waitFor(() => expect(guestAdapter.prepare).toHaveBeenCalledOnce())
  await waitFor(() => expect(guestAdapter.discover).toHaveBeenCalledOnce())

  await userEvent.keyboard('a')
  expect(activate).toHaveBeenCalledOnce()
  expect(activate).toHaveBeenCalledWith(
    expect.objectContaining({ label: 'Guest action', token: 'guest:1' }),
  )
  expect(hints()).toHaveLength(0)
  expect(asyncAdapter.discover).not.toHaveBeenCalled()
  expect(asyncAdapter.present).not.toHaveBeenCalled()
  expect(asyncAdapter.activate).not.toHaveBeenCalled()
  expect(asyncAdapter.subscribe).not.toHaveBeenCalled()
  view.unmount()
})

test('request-scoped adapters share the host label namespace and revalidate before activation', async () => {
  const activate = vi.fn(() => true)
  let current = true
  let target = document.createElement('div')
  const adapter: HostHintAdapter = {
    discover: () =>
      current
        ? [{ element: target, label: 'Wrapped shell link', x: 40, y: 50, token: 'buffer:1' }]
        : [],
    unchanged: () => current,
    activate,
  }
  setup(
    <section data-panel-terminal="shell-one">
      <Button>Native control</Button>
      <div className="xterm-screen" />
    </section>,
  )
  const root = document.querySelector<HTMLElement>('[data-panel-terminal]')!
  target = root.querySelector('.xterm-screen')!
  screen.getByRole('button', { name: 'Native control' }).focus()
  act(() => requestAdaptedHostHints(root, adapter))
  expect(hints().map((hint) => hint.dataset.hintTarget)).toEqual([
    'Native control',
    'Wrapped shell link',
  ])
  await choose('Wrapped shell link')
  expect(activate).toHaveBeenCalledTimes(1)

  act(() => requestAdaptedHostHints(root, adapter))
  current = false
  const event = new KeyboardEvent('keydown', { key: 'a', bubbles: true, cancelable: true })
  act(() => window.dispatchEvent(event))
  expect(event.defaultPrevented).toBe(true)
  expect(activate).toHaveBeenCalledTimes(1)
  expect(hints()).toHaveLength(0)
})

test('inactive registered adapters do not block foreground modal actions', async () => {
  const action = vi.fn()
  const unchanged = vi.fn(() => false)
  const adapter: HostHintAdapter = {
    discover: () => [],
    unchanged,
    activate: vi.fn(() => false),
  }
  setup(
    <section data-pane="one" data-pane-focused>
      <div aria-hidden="true">
        <iframe aria-label="Background mail" />
      </div>
      <div role="dialog" aria-label="Foreground dialog">
        <Button onClick={action}>Confirm</Button>
      </div>
    </section>,
  )
  const frame = screen.getByLabelText('Background mail')
  registerHostHintAdapter(frame, adapter)
  const confirm = screen.getByRole('button', { name: 'Confirm' })
  confirm.focus()
  await userEvent.keyboard('f')
  expect(hints().map((hint) => hint.dataset.hintTarget)).toEqual(['Confirm'])
  await choose('Confirm')
  expect(action).toHaveBeenCalledOnce()
  expect(unchanged).not.toHaveBeenCalled()
})

test('a participating adapter becoming inactive cancels its captured labels', async () => {
  let target: Element = document.createElement('a')
  target.textContent = 'Mail target'
  let active = true
  const adapter: HostHintAdapter = {
    discover: () =>
      active ? [{ element: target, label: 'Mail target', x: 40, y: 50, token: target }] : [],
    unchanged: () => true,
    activate: vi.fn(() => true),
  }
  setup(
    <section data-pane="one" data-pane-focused>
      <div data-testid="mail-surface">
        <iframe aria-label="Mail frame" />
      </div>
    </section>,
  )
  const surface = screen.getByTestId('mail-surface')
  const frame = surface.querySelector('iframe')!
  target = frame
  const unregister = registerHostHintAdapter(frame, adapter)
  screen.getByLabelText('Mail frame').focus()
  await userEvent.keyboard('f')
  expect(hints().map((hint) => hint.dataset.hintTarget)).toContain('Mail target')
  active = false
  surface.setAttribute('aria-hidden', 'true')
  await userEvent.keyboard('a')
  expect(hints()).toHaveLength(0)
  expect(adapter.activate).not.toHaveBeenCalled()
  unregister()
})

test('explicit terminal hints show labels; Ctrl-C cancels without consuming the interrupt', async () => {
  setup(
    <div data-panel-terminal="shell-one" className="xterm">
      <textarea aria-label="Shell" />
      <div className="xterm-screen" />
    </div>,
  )
  const shell = screen.getByLabelText('Shell')
  shell.focus()
  const root = document.querySelector<HTMLElement>('[data-panel-terminal]')!
  const adapter: HostHintAdapter = {
    discover: () => [
      {
        element: root.querySelector('.xterm-screen')!,
        label: 'https://example.test',
        x: 32,
        y: 40,
        token: 'terminal:1',
      },
    ],
    unchanged: () => true,
    activate: vi.fn(() => true),
  }
  act(() => requestAdaptedHostHints(root, adapter))
  expect(hints().map((hint) => hint.dataset.hintTarget)).toEqual(['https://example.test'])
  const event = new KeyboardEvent('keydown', {
    key: 'c',
    ctrlKey: true,
    bubbles: true,
    cancelable: true,
  })
  act(() => shell.dispatchEvent(event))
  expect(event.defaultPrevented).toBe(false)
  expect(hints()).toHaveLength(0)
})

test('request-scoped adapter validates its shell lifetime even with no links', async () => {
  let current = true
  const adapter: HostHintAdapter = {
    discover: () => [],
    unchanged: vi.fn(() => current),
    activate: vi.fn(() => false),
  }
  setup(
    <section data-panel-terminal="shell-one">
      <Button>Native control</Button>
    </section>,
  )
  const root = document.querySelector<HTMLElement>('[data-panel-terminal]')!
  act(() => requestAdaptedHostHints(root, adapter))
  // A visible native control still shows a label while the adapter has no links.
  expect(hints().map((hint) => hint.dataset.hintTarget)).toEqual(['Native control'])
  current = false
  const event = new KeyboardEvent('keydown', { key: 'a', bubbles: true, cancelable: true })
  act(() => window.dispatchEvent(event))
  expect(adapter.unchanged).toHaveBeenCalledWith([])
  expect(event.defaultPrevented).toBe(true)
  expect(hints()).toHaveLength(0)
})

test('keeps a zero-target owned adapter subscribed for frame keys and disposes it on cancel', async () => {
  let route: ((event: KeyboardEvent) => boolean) | undefined
  const disposed = vi.fn()
  const adapter: HostHintAdapter = {
    discover: () => [],
    unchanged: () => true,
    activate: vi.fn(() => false),
    subscribe: (_invalidate, onKey) => {
      route = onKey
      const frameDocument = document.querySelector('iframe')!.contentDocument!
      const onFrameKeyDown = (event: KeyboardEvent) => {
        if (!onKey?.(event)) return
        event.preventDefault()
        event.stopImmediatePropagation()
      }
      frameDocument.addEventListener('keydown', onFrameKeyDown, true)
      return () => {
        frameDocument.removeEventListener('keydown', onFrameKeyDown, true)
        disposed()
      }
    },
  }
  setup(
    <section data-pane="one" data-pane-focused>
      <iframe aria-label="Linkless frame" />
    </section>,
  )
  const pane = document.querySelector<HTMLElement>('[data-pane]')!
  const unregister = registerHostHintAdapter(pane.querySelector('iframe')!, adapter)
  const frame = pane.querySelector('iframe')!
  frame.contentDocument!.body.focus()
  await userEvent.keyboard('f')
  expect(hints()).toHaveLength(0)
  const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
  frame.contentDocument!.dispatchEvent(event)
  expect(route).toBeDefined()
  expect(event.defaultPrevented).toBe(true)
  expect(disposed).toHaveBeenCalledOnce()
  unregister()
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

test('async targets share allocated labels with native controls and activate through their owner', async () => {
  const calls: string[] = []
  let remoteKey = ''
  const adapter: AsyncHostHintAdapter = {
    discover: async () => [{ id: 'remote', label: 'Remote item', x: 200, y: 100 }],
    present: vi.fn(async (_request, _revision, labels) => {
      remoteKey = labels[0]?.key ?? ''
      calls.push(`present:${remoteKey}`)
      return true
    }),
    clear: vi.fn(() => calls.push('clear')),
    activate: vi.fn(async () => {
      calls.push('activate')
      return true
    }),
    subscribe: () => vi.fn(),
  }
  setup(
    <section data-pane="one" data-pane-focused>
      <Button>Local</Button>
      <div data-testid="owner" />
    </section>,
  )
  registerAsyncHostHintAdapter(screen.getByTestId('owner'), adapter)
  screen.getByRole('button', { name: 'Local' }).focus()
  await userEvent.keyboard('f')
  await act(async () => await Promise.resolve())
  expect(hints().map((hint) => hint.dataset.hintTarget)).toEqual(['Local'])
  await userEvent.keyboard(remoteKey)
  expect(adapter.activate).toHaveBeenCalledWith(expect.any(Number), 'remote')
  expect(calls.indexOf('activate')).toBeLessThan(calls.indexOf('clear'))
})

test('disposing an async source clears only its active host-hint session', async () => {
  let retireActive: (() => void) | undefined
  let retireOther: (() => void) | undefined
  const source = (label: string, retain: (retire: () => void) => void): AsyncHostHintAdapter => ({
    discover: async () => [{ id: label, label, x: 200, y: 100 }],
    present: vi.fn(async () => true),
    clear: vi.fn(),
    activate: vi.fn(async () => true),
    subscribe: (_request, invalidate) => {
      retain(invalidate)
      return vi.fn()
    },
  })
  setup(
    <>
      <section data-pane="one" data-pane-focused>
        <Button>Local</Button>
        <div data-testid="active-owner" />
      </section>
      <section data-pane="two">
        <div data-testid="other-owner" />
      </section>
    </>,
  )
  const active = source('Active remote', (retire) => (retireActive = retire))
  const other = source('Other remote', (retire) => (retireOther = retire))
  registerAsyncHostHintAdapter(screen.getByTestId('active-owner'), active)
  registerAsyncHostHintAdapter(screen.getByTestId('other-owner'), other)
  screen.getByRole('button', { name: 'Local' }).focus()
  await userEvent.keyboard('f')
  await act(async () => new Promise((resolve) => setTimeout(resolve, 0)))
  expect(hints().map((hint) => hint.dataset.hintTarget)).toContain('Local')

  act(() => retireOther?.())
  expect(hints().map((hint) => hint.dataset.hintTarget)).toEqual(['Local'])

  act(() => retireActive?.())
  expect(hints()).toHaveLength(0)
})

test('pending async discovery buffers typeahead and Escape makes its result inert', async () => {
  let resolve!: (targets: readonly { id: string; label: string; x: number; y: number }[]) => void
  const adapter: AsyncHostHintAdapter = {
    discover: () =>
      new Promise((done) => {
        resolve = done
      }),
    present: vi.fn(async () => true),
    clear: vi.fn(),
    activate: vi.fn(async () => true),
    subscribe: () => vi.fn(),
  }
  setup(
    <section data-pane="one" data-pane-focused>
      <Button>Local</Button>
      <div data-testid="owner" />
    </section>,
  )
  registerAsyncHostHintAdapter(screen.getByTestId('owner'), adapter)
  screen.getByRole('button', { name: 'Local' }).focus()
  await userEvent.keyboard('fa')
  expect(hints()).toHaveLength(0)
  await userEvent.keyboard('{Escape}')
  await act(async () => resolve([{ id: 'late', label: 'Late', x: 200, y: 100 }]))
  expect(adapter.present).not.toHaveBeenCalled()
  expect(adapter.activate).not.toHaveBeenCalled()
})

test('failed async presentation never exposes or activates its target', async () => {
  const adapter: AsyncHostHintAdapter = {
    discover: async () => [{ id: 'remote', label: 'Remote', x: 200, y: 100 }],
    present: vi.fn(async () => false),
    clear: vi.fn(),
    activate: vi.fn(async () => true),
    subscribe: () => vi.fn(),
  }
  setup(
    <section data-pane="one" data-pane-focused>
      <Button>Local</Button>
      <div data-testid="owner" />
    </section>,
  )
  registerAsyncHostHintAdapter(screen.getByTestId('owner'), adapter)
  screen.getByRole('button', { name: 'Local' }).focus()
  await userEvent.keyboard('f')
  await act(async () => await Promise.resolve())
  expect(hints().map((hint) => hint.dataset.hintTarget)).toEqual(['Local'])
  await userEvent.keyboard('a')
  expect(adapter.activate).not.toHaveBeenCalled()
  expect(adapter.clear).toHaveBeenCalledOnce()
})

test('pending async discovery retains chrome targets and replays bounded typeahead', async () => {
  let resolve!: (targets: readonly { id: string; label: string; x: number; y: number }[]) => void
  const click = vi.fn()
  const adapter: AsyncHostHintAdapter = {
    discover: () =>
      new Promise((done) => {
        resolve = done
      }),
    present: vi.fn(async () => true),
    clear: vi.fn(),
    activate: vi.fn(async () => true),
    subscribe: () => vi.fn(),
  }
  setup(
    <section data-pane="one" data-pane-focused>
      {Array.from({ length: 30 }, (_, index) => (
        <Button key={index} onClick={() => click(index)}>
          Action {index}
        </Button>
      ))}
      <div data-testid="owner" />
    </section>,
  )
  registerAsyncHostHintAdapter(screen.getByTestId('owner'), adapter)
  screen.getByRole('button', { name: 'Action 0' }).focus()
  await userEvent.keyboard('fsa')
  expect(hints()).toHaveLength(0)
  await act(async () => resolve([]))
  expect(click).toHaveBeenCalledExactlyOnceWith(26)
  expect(hints()).toHaveLength(0)
})

test('a stalled initial presentation times out without hiding native hints', async () => {
  const adapter: AsyncHostHintAdapter = {
    discover: async () => [{ id: 'remote', label: 'Remote', x: 200, y: 100 }],
    present: vi.fn(() => new Promise<boolean>(() => {})),
    clear: vi.fn(),
    activate: vi.fn(async () => true),
    subscribe: () => vi.fn(),
  }
  setup(
    <section data-pane="one" data-pane-focused>
      <Button>Local</Button>
      <div data-testid="owner" />
    </section>,
  )
  registerAsyncHostHintAdapter(screen.getByTestId('owner'), adapter)
  screen.getByRole('button', { name: 'Local' }).focus()
  await userEvent.keyboard('f')
  await act(async () => new Promise((resolve) => setTimeout(resolve, 140)))
  expect(hints().map((hint) => hint.dataset.hintTarget)).toEqual(['Local'])
  expect(adapter.clear).toHaveBeenCalledOnce()
})

test('pending typeahead overflow cancels discovery without presenting', async () => {
  let resolve!: (targets: readonly { id: string; label: string; x: number; y: number }[]) => void
  const adapter: AsyncHostHintAdapter = {
    discover: () =>
      new Promise((done) => {
        resolve = done
      }),
    present: vi.fn(async () => true),
    clear: vi.fn(),
    activate: vi.fn(async () => true),
    subscribe: () => vi.fn(),
  }
  setup(
    <section data-pane="one" data-pane-focused>
      <Button>Local</Button>
      <div data-testid="owner" />
    </section>,
  )
  registerAsyncHostHintAdapter(screen.getByTestId('owner'), adapter)
  screen.getByRole('button', { name: 'Local' }).focus()
  await userEvent.keyboard('f123456789')
  await act(async () => resolve([{ id: 'late', label: 'Late', x: 200, y: 100 }]))
  expect(hints()).toHaveLength(0)
  expect(adapter.present).not.toHaveBeenCalled()
  expect(adapter.clear).toHaveBeenCalledOnce()
})

test.each(['blur', 'pointer', 'request', 'preference', 'escape', 'surface'] as const)(
  'selected delayed async activation retires on %s',
  async (reason) => {
    let finish!: (value: boolean) => void
    let remoteKey = ''
    let subscriptions = 0
    let unsubscriptions = 0
    const adapter: AsyncHostHintAdapter = {
      discover: async () =>
        Array.from({ length: 30 }, (_, index) => ({
          id: index === 0 ? 'remote' : `remote-${index}`,
          label: `Remote ${index}`,
          x: 200 + index,
          y: 100,
        })),
      present: vi.fn(
        async (_request, _revision, labels: readonly { id: string; key: string }[]) => {
          remoteKey = labels.find((label) => label.id === 'remote')?.key ?? remoteKey
          return true
        },
      ),
      clear: vi.fn(),
      activate: vi.fn(
        () =>
          new Promise<boolean>((resolve) => {
            finish = resolve
          }),
      ),
      subscribe: () => {
        subscriptions++
        return () => {
          unsubscriptions++
        }
      },
    }
    setup(
      <section data-pane="one" data-pane-focused>
        <Button>Local</Button>
        <div data-testid="owner" />
      </section>,
    )
    registerAsyncHostHintAdapter(screen.getByTestId('owner'), adapter)
    const button = screen.getByRole('button', { name: 'Local' })
    button.focus()
    await userEvent.keyboard('f')
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)))
    await userEvent.keyboard(remoteKey)
    expect(adapter.activate).toHaveBeenCalledOnce()
    await userEvent.keyboard('f')
    expect(hints()).toHaveLength(0)
    expect(adapter.activate).toHaveBeenCalledOnce()
    if (reason === 'blur') fireEvent.blur(window)
    if (reason === 'pointer') fireEvent.pointerDown(window)
    if (reason === 'request') {
      act(() =>
        window.dispatchEvent(new CustomEvent(HOST_HINT_REQUEST, { detail: { source: button } })),
      )
    }
    if (reason === 'preference') await act(async () => store.set(vimCodeEditingAtom, false))
    if (reason === 'escape') {
      const ownerEscape = new KeyboardEvent('keydown', {
        key: 'Escape',
        bubbles: true,
        cancelable: true,
      })
      act(() => window.dispatchEvent(ownerEscape))
      expect(ownerEscape.defaultPrevented).toBe(true)
    }
    if (reason === 'surface') {
      const owner = screen.getByTestId('owner')
      const shadow = owner.attachShadow({ mode: 'open' })
      act(() =>
        window.dispatchEvent(
          new CustomEvent(HOST_HINT_SURFACE, {
            detail: { root: shadow, owner, registered: false },
          }),
        ),
      )
    }
    expect(adapter.clear).toHaveBeenCalledOnce()
    await act(async () => finish(true))
    expect(adapter.clear).toHaveBeenCalledOnce()
    expect(subscriptions).toBe(reason === 'request' ? 3 : 2)
    expect(unsubscriptions).toBe(2)
    if (reason === 'escape') {
      const unownedEscape = new KeyboardEvent('keydown', {
        key: 'Escape',
        bubbles: true,
        cancelable: true,
      })
      act(() => window.dispatchEvent(unownedEscape))
      expect(unownedEscape.defaultPrevented).toBe(false)
    }
  },
)

test('a stale async prefix failure cannot cancel a newer request', async () => {
  let failOldPrefix!: (value: boolean) => void
  let remoteKey = ''
  let requestNumber = 0
  const adapter: AsyncHostHintAdapter = {
    discover: async () => {
      const request = ++requestNumber
      return Array.from({ length: 30 }, (_, index) => ({
        id: `remote-${request}-${index}`,
        label: `Remote ${index}`,
        x: 200 + index,
        y: 100,
      }))
    },
    present: vi.fn((request, revision, labels: readonly { id: string; key: string }[]) => {
      remoteKey = labels.find((label) => label.id.endsWith('-26'))?.key ?? remoteKey
      if (request === 1 && revision > 1)
        return new Promise<boolean>((resolve) => {
          failOldPrefix = resolve
        })
      return Promise.resolve(true)
    }),
    clear: vi.fn(),
    activate: vi.fn(async () => true),
    subscribe: () => vi.fn(),
  }
  setup(
    <section data-pane="one" data-pane-focused>
      <Button>Local</Button>
      <div data-testid="owner" />
    </section>,
  )
  registerAsyncHostHintAdapter(screen.getByTestId('owner'), adapter)
  const button = screen.getByRole('button', { name: 'Local' })
  button.focus()
  await userEvent.keyboard('f')
  await act(async () => new Promise((resolve) => setTimeout(resolve, 0)))
  await userEvent.keyboard(remoteKey[0]!)
  act(() =>
    window.dispatchEvent(new CustomEvent(HOST_HINT_REQUEST, { detail: { source: button } })),
  )
  await act(async () => new Promise((resolve) => setTimeout(resolve, 0)))
  await act(async () => failOldPrefix(false))
  await userEvent.keyboard(remoteKey)
  expect(adapter.activate).toHaveBeenCalledWith(2, 'remote-2-26')
})

test.each(['false', 'reject'] as const)(
  'failed async prefix presentation (%s) retires its session',
  async (failure) => {
    const adapter: AsyncHostHintAdapter = {
      discover: async () =>
        Array.from({ length: 30 }, (_, index) => ({
          id: `remote-${index}`,
          label: `Remote ${index}`,
          x: 200 + index,
          y: 100,
        })),
      present: vi.fn(async (_request, _revision, labels) => {
        if (labels.length === 30) return true
        if (failure === 'reject') throw new Error('presentation failed')
        return false
      }),
      clear: vi.fn(),
      activate: vi.fn(async () => true),
      subscribe: () => vi.fn(),
    }
    setup(
      <section data-pane="one" data-pane-focused>
        <Button>Local</Button>
        <div data-testid="owner" />
      </section>,
    )
    registerAsyncHostHintAdapter(screen.getByTestId('owner'), adapter)
    screen.getByRole('button', { name: 'Local' }).focus()
    await userEvent.keyboard('f')
    await act(async () => await new Promise((resolve) => setTimeout(resolve, 0)))
    await userEvent.keyboard('a')
    await act(async () => await new Promise((resolve) => setTimeout(resolve, 0)))
    expect(adapter.present).toHaveBeenCalledTimes(2)
    expect(hints()).toHaveLength(0)
    expect(adapter.activate).not.toHaveBeenCalled()
    expect(adapter.clear).toHaveBeenCalledOnce()
  },
)

test('async discovery errors leave native host hints usable and clear once on cancellation', async () => {
  const adapter: AsyncHostHintAdapter = {
    discover: async () => {
      throw new Error('unavailable')
    },
    present: vi.fn(async () => true),
    clear: vi.fn(),
    activate: vi.fn(async () => true),
    subscribe: () => vi.fn(),
  }
  setup(
    <section data-pane="one" data-pane-focused>
      <Button>Local</Button>
      <div data-testid="owner" />
    </section>,
  )
  registerAsyncHostHintAdapter(screen.getByTestId('owner'), adapter)
  screen.getByRole('button', { name: 'Local' }).focus()
  await userEvent.keyboard('f')
  await act(async () => await Promise.resolve())
  expect(hints().map((hint) => hint.dataset.hintTarget)).toEqual(['Local'])
  await userEvent.keyboard('{Escape}')
  expect(adapter.clear).toHaveBeenCalledOnce()
})
