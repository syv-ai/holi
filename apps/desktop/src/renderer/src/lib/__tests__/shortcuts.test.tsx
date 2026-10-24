import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { createStore, Provider } from 'jotai'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { ShortcutsDialog } from '@/components/blocks/app-shell-21/components/shortcuts-dialog'
import { hotkeyLabels, matchShortcutKey } from '@/lib/hotkey'
import {
  liveShortcuts,
  resolveShortcut,
  runsFromList,
  SHORTCUTS,
  type KeyContext,
} from '@/lib/shortcuts'
import {
  shortcutsDialogOpenAtom,
  useShortcutDispatcher,
  useShortcutHandlers,
  type ShortcutHandler,
} from '@/state/shortcuts'

const ev = (init: Partial<KeyboardEvent>): KeyboardEvent =>
  ({
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    repeat: false,
    isComposing: false,
    defaultPrevented: false,
    key: '',
    code: '',
    ...init,
  }) as KeyboardEvent

const ALL = new Set(SHORTCUTS.map((s) => s.id))
const ctx = (over: Partial<KeyContext> = {}): KeyContext => ({
  mac: true,
  target: 'page',
  dialogOpen: false,
  live: ALL,
  ...over,
})
const idOf = (e: KeyboardEvent, c: KeyContext) => resolveShortcut(e, c)?.shortcut.id ?? null

describe('the table', () => {
  test('ids are unique and every key is bound once', () => {
    const ids = SHORTCUTS.map((s) => s.id)
    expect(new Set(ids).size).toBe(ids.length)
    const keys = SHORTCUTS.flatMap((s) => s.keys)
    expect(new Set(keys).size).toBe(keys.length)
  })

  test('labels follow the platform', () => {
    expect(hotkeyLabels('⇧⌘T', true)).toEqual(['⇧', '⌘', 'T'])
    expect(hotkeyLabels('⇧⌘T', false)).toEqual(['Ctrl', 'Shift', 'T'])
    expect(hotkeyLabels('⌥⌘←', false)).toEqual(['Ctrl', 'Alt', '←'])
    expect(hotkeyLabels('⌃Tab', true)).toEqual(['⌃', 'Tab'])
  })

  test('the dialog merges rows that share a label', () => {
    const lines = liveShortcuts(new Set(['shortcuts.show', 'shortcuts.toggle']))
    expect(lines).toEqual([{ group: 'Help', label: 'Show keyboard shortcuts', specs: ['?', '⌘/'] }])
  })
})

describe('matching keys', () => {
  test('on a Mac ⌘ is Command only, so ⌃K stays a text key', () => {
    expect(matchShortcutKey(ev({ metaKey: true, key: 'k' }), '⌘K', true)).toBe(true)
    expect(matchShortcutKey(ev({ ctrlKey: true, key: 'k' }), '⌘K', true)).toBe(false)
    expect(matchShortcutKey(ev({ ctrlKey: true, key: 'k' }), '⌘K', false)).toBe(true)
  })

  test('? matches with the Shift that types it', () => {
    expect(matchShortcutKey(ev({ shiftKey: true, key: '?' }), '?', true)).toBe(true)
    expect(matchShortcutKey(ev({ key: '?' }), '?', false)).toBe(true)
  })

  test('⌥ falls back to the physical key', () => {
    const e = ev({ metaKey: true, altKey: true, key: '∑', code: 'KeyW' })
    expect(matchShortcutKey(e, '⌥⌘W', true)).toBe(true)
  })
})

describe('resolveShortcut', () => {
  test('? opens the sheet on the page, never while typing', () => {
    const q = ev({ shiftKey: true, key: '?' })
    expect(idOf(q, ctx())).toBe('shortcuts.show')
    expect(idOf(q, ctx({ target: 'text' }))).toBeNull()
    expect(idOf(q, ctx({ target: 'terminal' }))).toBeNull()
  })

  test('⌘K reaches search from a text field', () => {
    expect(idOf(ev({ metaKey: true, key: 'k' }), ctx({ target: 'text' }))).toBe('search.open')
  })

  test('Ctrl keys belong to the terminal', () => {
    const ctrlK = ev({ ctrlKey: true, key: 'k' })
    expect(idOf(ctrlK, ctx({ mac: false }))).toBe('search.open')
    expect(idOf(ctrlK, ctx({ mac: false, target: 'terminal' }))).toBeNull()
    expect(idOf(ev({ ctrlKey: true, key: 'Tab' }), ctx({ target: 'terminal' }))).toBeNull()
    expect(idOf(ev({ metaKey: true, key: 'k' }), ctx({ target: 'terminal' }))).toBe('search.open')
  })

  test('a key the focused widget handled is left alone', () => {
    expect(idOf(ev({ metaKey: true, key: 'b', defaultPrevented: true }), ctx())).toBeNull()
  })

  test('only live rows fire', () => {
    expect(idOf(ev({ metaKey: true, key: 'k' }), ctx({ live: new Set() }))).toBeNull()
  })

  test('behind a dialog only the dialog toggles fire', () => {
    expect(idOf(ev({ metaKey: true, key: 'n' }), ctx({ dialogOpen: true }))).toBeNull()
    expect(idOf(ev({ metaKey: true, key: '/' }), ctx({ dialogOpen: true }))).toBe(
      'shortcuts.toggle',
    )
  })

  test('the menu-bound key is the menu’s', () => {
    expect(idOf(ev({ metaKey: true, key: 'w' }), ctx())).toBeNull()
  })

  test('⌘9 is the ninth key of one row', () => {
    const match = resolveShortcut(ev({ metaKey: true, key: '9' }), ctx())
    expect(match?.shortcut.id).toBe('tab.goto')
    expect(match?.index).toBe(8)
  })
})

describe('the dispatcher', () => {
  beforeEach(() => {
    document.documentElement.dataset.platform = 'mac'
  })
  afterEach(() => {
    delete document.documentElement.dataset.platform
  })

  function Host({ handlers }: { handlers: Record<string, ShortcutHandler> }) {
    useShortcutDispatcher()
    useShortcutHandlers(handlers)
    return (
      <>
        <Input aria-label="field" />
        <div contentEditable suppressContentEditableWarning aria-label="editable" />
        <Button type="button">plain</Button>
      </>
    )
  }

  test('runs a live key on the page and not in a field', () => {
    const show = vi.fn()
    render(
      <Provider store={createStore()}>
        <Host handlers={{ 'shortcuts.show': show }} />
      </Provider>,
    )
    fireEvent.keyDown(screen.getByRole('button', { name: 'plain' }), { key: '?', shiftKey: true })
    expect(show).toHaveBeenCalledTimes(1)
    fireEvent.keyDown(screen.getByLabelText('field'), { key: '?', shiftKey: true })
    fireEvent.keyDown(screen.getByLabelText('editable'), { key: '?', shiftKey: true })
    expect(show).toHaveBeenCalledTimes(1)
  })

  test('a handler unmounted is no longer run', () => {
    const search = vi.fn()
    const view = render(
      <Provider store={createStore()}>
        <Host handlers={{ 'search.open': search }} />
      </Provider>,
    )
    view.unmount()
    fireEvent.keyDown(document.body, { key: 'k', metaKey: true })
    expect(search).not.toHaveBeenCalled()
  })
})

describe('split view keys', () => {
  test('⌘T is a new tab, ⌘\\ splits, ⇧⌘\\ separates on either character', () => {
    expect(idOf(ev({ metaKey: true, key: 't' }), ctx())).toBe('tab.new')
    expect(idOf(ev({ metaKey: true, shiftKey: true, key: 't' }), ctx())).toBe('tab.reopen')
    expect(idOf(ev({ metaKey: true, key: '\\' }), ctx())).toBe('pane.split')
    expect(idOf(ev({ metaKey: true, shiftKey: true, key: '|' }), ctx())).toBe('split.separate')
    expect(idOf(ev({ metaKey: true, shiftKey: true, key: '\\' }), ctx())).toBe('split.separate')
  })

  test('⌃⌥ arrows step the members, leaving ⌥⌘← to the files', () => {
    expect(idOf(ev({ ctrlKey: true, altKey: true, key: 'ArrowRight' }), ctx())).toBe('split.next')
    expect(idOf(ev({ ctrlKey: true, altKey: true, key: 'ArrowLeft' }), ctx())).toBe(
      'split.previous',
    )
    expect(idOf(ev({ metaKey: true, altKey: true, key: 'ArrowLeft' }), ctx())).toBe(
      'files.collapseAll',
    )
  })
})

describe('the dialog', () => {
  function Live({ ids }: { ids: string[] }) {
    useShortcutHandlers(Object.fromEntries(ids.map((id) => [id, () => {}])))
    return <ShortcutsDialog />
  }

  test('lists the live shortcuts by group, and filters them', async () => {
    document.documentElement.dataset.platform = 'mac'
    const store = createStore()
    store.set(shortcutsDialogOpenAtom, true)
    render(
      <Provider store={store}>
        <Live ids={['search.open', 'tab.next', 'shortcuts.show', 'shortcuts.toggle']} />
      </Provider>,
    )
    expect(await screen.findByRole('group', { name: 'Navigation' })).toBeInTheDocument()
    expect(screen.getByRole('group', { name: 'Tabs' })).toBeInTheDocument()
    expect(screen.queryByRole('group', { name: 'Apps' })).toBeNull()
    expect(screen.getByText('Search')).toBeInTheDocument()
    // Not live, so not listed.
    expect(screen.queryByText('Open board')).toBeNull()

    const field = screen.getByRole('combobox', { name: 'Search keyboard shortcuts' })
    act(() => {
      fireEvent.change(field, { target: { value: 'tab' } })
    })
    expect(screen.getByText('Next tab')).toBeInTheDocument()
    expect(screen.queryByText('Search')).toBeNull()

    act(() => {
      fireEvent.change(field, { target: { value: 'zzz' } })
    })
    expect(screen.getByText('No shortcuts found')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Clear search' }))
    expect(screen.getByText('Search')).toBeInTheDocument()
    delete document.documentElement.dataset.platform
  })

  test('lists ⌘T, the split view keys and its drags', async () => {
    document.documentElement.dataset.platform = 'mac'
    const store = createStore()
    store.set(shortcutsDialogOpenAtom, true)
    render(
      <Provider store={store}>
        <Live ids={['tab.new', 'pane.split', 'split.separate', 'split.next', 'split.previous']} />
      </Provider>,
    )
    expect(await screen.findByRole('group', { name: 'Split view' })).toBeInTheDocument()
    expect(screen.getByText('New tab')).toBeInTheDocument()
    expect(screen.getByText('Separate split view')).toBeInTheDocument()
    expect(screen.getByText('Focus next view in split')).toBeInTheDocument()
    expect(screen.getByText('Drag it to an edge or between two views')).toBeInTheDocument()
    expect(screen.getByText('Drag it from the pill to the tabs')).toBeInTheDocument()
    delete document.documentElement.dataset.platform
  })
})

describe('the dialog runs a row', () => {
  beforeEach(() => {
    document.documentElement.dataset.platform = 'mac'
  })
  afterEach(() => {
    delete document.documentElement.dataset.platform
  })

  function Live({ handlers }: { handlers: Record<string, ShortcutHandler> }) {
    useShortcutDispatcher()
    useShortcutHandlers(handlers)
    return (
      <>
        <Button type="button">before</Button>
        <ShortcutsDialog />
      </>
    )
  }

  const selected = () => screen.getByRole('option', { selected: true })

  test('? opens it, the arrows move, Enter closes it and runs the action', async () => {
    const newTab = vi.fn()
    const terminal = vi.fn()
    const store = createStore()
    const show = () => store.set(shortcutsDialogOpenAtom, (open) => !open)
    render(
      <Provider store={store}>
        <Live
          handlers={{
            'shortcuts.show': show,
            'tab.new': newTab,
            'panel.terminal': terminal,
          }}
        />
      </Provider>,
    )
    const before = screen.getByRole('button', { name: 'before' })
    before.focus()
    fireEvent.keyDown(before, { key: '?', shiftKey: true })
    const field = await screen.findByRole('combobox', { name: 'Search keyboard shortcuts' })
    expect(field).toHaveFocus()
    // The first runnable row is selected on open, and its keys are in its name.
    await waitFor(() => expect(selected()).toHaveAccessibleName('New tab, ⌘ T'))
    fireEvent.keyDown(field, { key: 'ArrowDown' })
    await waitFor(() => expect(selected()).toHaveAccessibleName('Toggle terminal, ⌃ `'))
    fireEvent.keyDown(field, { key: 'Enter' })
    await waitFor(() => expect(terminal).toHaveBeenCalledTimes(1))
    expect(store.get(shortcutsDialogOpenAtom)).toBe(false)
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(before).toHaveFocus()
    expect(newTab).not.toHaveBeenCalled()
  })

  test('Home and End go to the ends, and a run hands its focus to the action', async () => {
    const store = createStore()
    store.set(shortcutsDialogOpenAtom, true)
    const output = vi.fn(() => screen.getByRole('button', { name: 'before' }).focus())
    render(
      <Provider store={store}>
        <Live handlers={{ 'search.open': () => {}, 'tab.new': () => {}, 'panel.output': output }} />
      </Provider>,
    )
    const field = await screen.findByRole('combobox', { name: 'Search keyboard shortcuts' })
    await waitFor(() => expect(selected()).toHaveAccessibleName('Search, ⌘ K'))
    fireEvent.keyDown(field, { key: 'End' })
    await waitFor(() => expect(selected()).toHaveAccessibleName('Show output, ⇧ ⌘ U'))
    fireEvent.keyDown(field, { key: 'Home' })
    await waitFor(() => expect(selected()).toHaveAccessibleName('Search, ⌘ K'))
    fireEvent.keyDown(field, { key: 'End' })
    fireEvent.keyDown(field, { key: 'Enter' })
    await waitFor(() => expect(output).toHaveBeenCalledTimes(1))
    expect(screen.getByRole('button', { name: 'before' })).toHaveFocus()
  })

  test('search narrows the list by name or key, and selects the first match', async () => {
    const store = createStore()
    store.set(shortcutsDialogOpenAtom, true)
    render(
      <Provider store={store}>
        <Live handlers={{ 'search.open': () => {}, 'tab.new': () => {}, 'tab.reopen': () => {} }} />
      </Provider>,
    )
    const field = await screen.findByRole('combobox', { name: 'Search keyboard shortcuts' })
    act(() => {
      fireEvent.change(field, { target: { value: 'reopen' } })
    })
    expect(screen.getAllByRole('option')).toHaveLength(1)
    await waitFor(() => expect(selected()).toHaveAccessibleName('Reopen closed tab, ⇧ ⌘ T'))
    act(() => {
      fireEvent.change(field, { target: { value: '⇧' } })
    })
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual([
      expect.stringContaining('Reopen closed tab'),
    ])
  })

  test('gesture rows and the rows it only shows are skipped', async () => {
    const goto = vi.fn()
    const store = createStore()
    store.set(shortcutsDialogOpenAtom, true)
    render(
      <Provider store={store}>
        <Live
          handlers={{
            'tab.goto': goto,
            'tab.new': () => {},
            'pane.split': () => {},
            'panel.terminal': () => {},
          }}
        />
      </Provider>,
    )
    const field = await screen.findByRole('combobox', { name: 'Search keyboard shortcuts' })
    const gotoRow = screen.getByRole('option', { name: /^Go to tab/ })
    expect(gotoRow).toHaveAttribute('aria-disabled', 'true')
    const gesture = screen.getByRole('option', { name: /^Split with a tab/ })
    expect(gesture).toHaveAttribute('aria-disabled', 'true')
    // ⌘1–9 comes first in the table, but the first row to run is New tab.
    await waitFor(() => expect(selected()).toHaveAccessibleName('New tab, ⌘ T'))
    fireEvent.keyDown(field, { key: 'ArrowDown' })
    await waitFor(() => expect(selected()).toHaveAccessibleName('Split view, ⌘ \\'))
    // Past the five drags straight to the panel.
    fireEvent.keyDown(field, { key: 'ArrowDown' })
    await waitFor(() => expect(selected()).toHaveAccessibleName('Toggle terminal, ⌃ `'))
    fireEvent.click(gotoRow)
    expect(goto).not.toHaveBeenCalled()
    expect(store.get(shortcutsDialogOpenAtom)).toBe(true)
  })
})

describe('every runnable row has an action', () => {
  // The renderer's sources, to find each id a component registers a handler
  // for: a row the dialog runs must be one something can run.
  const sources = import.meta.glob(['../../**/*.{ts,tsx}', '!../../**/__tests__/**'], {
    query: '?raw',
    import: 'default',
    eager: true,
  }) as Record<string, string>
  const registered = new Set(
    Object.values(sources)
      .filter((source) => source.includes('useShortcutHandlers({'))
      .flatMap((source) => [...source.matchAll(/^\s*["']([\w.]+)["']\s*:/gm)].map((m) => m[1])),
  )

  test.each(SHORTCUTS.filter(runsFromList).map((s) => s.id))('%s is registered', (id) => {
    expect(registered).toContain(id)
  })

  test('the dialog runs only ids that are live, and never a gesture', () => {
    const lines = liveShortcuts(ALL)
    for (const line of lines) {
      if (line.gesture !== undefined) expect(line.run).toBeUndefined()
      if (line.run !== undefined) expect(ALL.has(line.run)).toBe(true)
    }
    expect(lines.find((l) => l.label === 'Close tab')?.run).toBe('tab.close')
    expect(lines.find((l) => l.label === 'Show keyboard shortcuts')?.run).toBeUndefined()
  })
})

describe('the panel keys', () => {
  test('⌃` fires from inside a terminal, where other Control keys do not', () => {
    const toggle = ev({ key: '`', code: 'Backquote', ctrlKey: true })
    expect(idOf(toggle, ctx({ target: 'terminal' }))).toBe('panel.terminal')
    expect(idOf(toggle, ctx({ target: 'text' }))).toBe('panel.terminal')
    expect(idOf(ev({ key: 'Tab', ctrlKey: true }), ctx({ target: 'terminal' }))).toBeNull()
  })

  test('⇧⌘U opens Output, and on a Mac ⌘` is left to macOS', () => {
    expect(idOf(ev({ key: 'U', metaKey: true, shiftKey: true }), ctx())).toBe('panel.output')
    expect(idOf(ev({ key: '`', metaKey: true }), ctx())).toBeNull()
    expect(idOf(ev({ key: '`', ctrlKey: true }), ctx({ mac: false }))).toBe('panel.terminal')
  })
})
