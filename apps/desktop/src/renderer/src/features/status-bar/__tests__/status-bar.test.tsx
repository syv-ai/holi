/**
 * The status bar, the bottom panel and its Output
 * (docs/features/status-bar.md): what the bar's items say and do, the keys
 * that toggle the panel, and the Output's grid, its search and filters, and
 * the lines that open under their rows.
 */
import { Provider, createStore } from 'jotai'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

import { act, fireEvent, render, screen, waitFor, within } from '@/test/render'
import {
  activityEntriesAtom,
  activityLoadAtom,
  activityQueryAtom,
  activitySearchAtom,
  activitySeenAtom,
  activityUnseenErrorAtom,
  mergeEntries,
  withChannelRule,
  shownEntries,
  type ActivityChannel,
  type ActivityEntry,
} from '@/state/activity'
import { emptyFilterQuery } from '@/lib/filter-query'

const channelQuery = (channel: ActivityChannel) =>
  withChannelRule(emptyFilterQuery(), channel, 'only')
import { appLogEntriesAtom, appLogLoadAtom, mergeAppLog, type AppLogEntry } from '@/state/app-logs'
import { bottomPanelAtom, clampPanelHeight, togglePanel } from '@/state/bottom-panel'
import { afterRemoval } from '@/state/panel-terminals'
import { installedPluginsAtom, runningPluginsAtom } from '@/state/plugins'
import { useShortcutDispatcher } from '@/hooks/use-shortcuts'
import { activeRemoteAtom, syncStateAtom } from '@/state/vaults'

import { createFilterQuery, createFilterRule } from '@/components/reui/filters/filters-query'

import { BottomPanel } from '../../bottom-panel/bottom-panel'
import { OutputSearch } from '../../bottom-panel/output-search'
import { LogsSearch, PanelLogs } from '../../bottom-panel/panel-logs'
import { PanelOutput } from '../../bottom-panel/panel-output'
import { StatusBar, syncedAgo, syncItemView } from '../status-bar'

const calls: { name: string; input: unknown }[] = []
let syncInfo: unknown = null

vi.mock('@/lib/trpc', () => {
  const answer = (name: string): unknown => {
    if (name === 'sync.info') return syncInfo
    if (name === 'terminal.list') return []
    if (name === 'terminal.create') return { ok: false, message: 'node-pty did not load' }
    if (name === 'activity.entries') return []
    if (name === 'logs.entries') return []
    return { ok: true }
  }
  const procedure = (name: string) => ({
    query: async (input?: unknown) => {
      calls.push({ name, input })
      return answer(name)
    },
    mutate: async (input?: unknown) => {
      calls.push({ name, input })
      return answer(name)
    },
  })
  const router = (r: string) =>
    new Proxy(
      {},
      {
        get: (_t, key) => (typeof key === 'string' ? procedure(`${r}.${key}`) : undefined),
      },
    )
  return {
    trpc: new Proxy({}, { get: (_t, key) => (typeof key === 'string' ? router(key) : undefined) }),
  }
})

// xterm needs a canvas jsdom does not have; the panel's terminal stands in.
vi.mock('../../bottom-panel/panel-terminal', () => ({
  PanelTerminal: ({ id }: { id: string }) => <div data-testid={`term-${id}`} />,
}))

const entry = (id: number, over: Partial<ActivityEntry> = {}): ActivityEntry => ({
  id,
  at: '2026-10-24T10:00:00.000Z',
  channel: 'git',
  level: 'info',
  message: `line ${id}`,
  ...over,
})

// jsdom lays nothing out, so a real virtualizer measures a zero-height
// viewport and the Output's grid draws no rows. This one draws every row.
vi.mock('@tanstack/react-virtual', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@tanstack/react-virtual')>()),
  useVirtualizer: (opts: { count: number; getItemKey?: (index: number) => string | number }) => {
    const ROW = 33
    const items = Array.from({ length: opts.count }, (_, index) => ({
      index,
      key: opts.getItemKey?.(index) ?? index,
      start: index * ROW,
      end: (index + 1) * ROW,
      size: ROW,
      lane: 0,
    }))
    return {
      getVirtualItems: () => items,
      getTotalSize: () => opts.count * ROW,
      measureElement: () => {},
      measure: () => {},
      scrollToIndex: () => {},
      scrollToOffset: () => {},
    }
  },
}))

beforeEach(() => {
  // The grid's scroll area reads running animations, which jsdom lacks.
  Element.prototype.getAnimations ??= () => []
  calls.length = 0
  syncInfo = null
  document.documentElement.dataset.platform = 'mac'
})
afterEach(() => {
  delete document.documentElement.dataset.platform
})

function Dispatcher() {
  useShortcutDispatcher()
  return null
}

function shell(store = createStore()) {
  render(
    <Provider store={store}>
      <Dispatcher />
      <div style={{ height: 800 }}>
        <BottomPanel onRetryOutput={() => {}} />
      </div>
      <StatusBar />
    </Provider>,
  )
  return store
}

describe('pure rules', () => {
  test('togglePanel opens on a tab, switches tabs, and closes the one showing', () => {
    const closed = { open: false, tab: 'output' as const, maximized: false }
    const onTerminal = togglePanel(closed, 'terminal')
    expect(onTerminal).toEqual({
      open: true,
      tab: 'terminal',
      maximized: false,
    })
    expect(togglePanel(onTerminal, 'output')).toMatchObject({
      open: true,
      tab: 'output',
    })
    expect(togglePanel({ ...onTerminal, maximized: true }, 'terminal')).toEqual({
      open: false,
      tab: 'terminal',
      maximized: false,
    })
  })

  test('the panel is held between 120px and 70% of the column', () => {
    expect(clampPanelHeight(50, 1000)).toBe(120)
    expect(clampPanelHeight(900, 1000)).toBe(700)
    expect(clampPanelHeight(300, 1000)).toBe(300)
    expect(clampPanelHeight(300, 100)).toBe(120)
  })

  test('entries merge by id, oldest first, capped', () => {
    const merged = mergeEntries([entry(2), entry(3)], [entry(1), entry(3), entry(4)], 3)
    expect(merged.map((e) => e.id)).toEqual([2, 3, 4])
  })

  test('the query and the search narrow what the Output shows', () => {
    const lines = [
      entry(1, { message: 'Committed abc' }),
      entry(2, { channel: 'sync', message: 'Pushed 1 commit' }),
      entry(3, { channel: 'sync', message: 'Pulled', remote: 'o/notes' }),
    ]
    const ids = (shown: readonly ActivityEntry[]) => shown.map((e) => e.id)
    expect(ids(shownEntries(lines, channelQuery('sync'), ''))).toEqual([2, 3])
    expect(ids(shownEntries(lines, channelQuery('sync'), 'push'))).toEqual([2])
    // The search reads the vault and the channel's name too.
    expect(ids(shownEntries(lines, createFilterQuery(), 'o/notes'))).toEqual([3])
    expect(ids(shownEntries(lines, createFilterQuery(), 'git'))).toEqual([1])
    // A rule with no value yet constrains nothing.
    const unfinished = createFilterQuery([
      createFilterRule({ id: 'r', path: ['level'], operator: 'is' }),
    ])
    expect(ids(shownEntries(lines, unfinished, ''))).toEqual([1, 2, 3])
  })

  test('synced-ago reads as a person says it', () => {
    const at = Date.parse('2026-10-24T10:00:00.000Z')
    expect(syncedAgo('2026-10-24T10:00:00.000Z', at + 20_000)).toBe('Synced just now')
    expect(syncedAgo('2026-10-24T10:00:00.000Z', at + 120_000)).toBe('Synced 2m ago')
    expect(syncedAgo('2026-10-24T10:00:00.000Z', at + 3 * 3_600_000)).toBe('Synced 3h ago')
  })

  test('the sync item syncs when it can and opens the log when it should be read', () => {
    expect(syncItemView({ kind: 'up-to-date' })).toMatchObject({
      click: 'sync',
      problem: null,
    })
    expect(syncItemView({ kind: 'pulling' })).toMatchObject({ busy: true })
    expect(syncItemView({ kind: 'offline', count: 2 })).toMatchObject({
      click: 'sync',
      problem: 'offline',
    })
    expect(syncItemView({ kind: 'conflict', paths: ['a.md'] })).toMatchObject({
      click: 'output',
      problem: 'warn',
    })
    expect(syncItemView({ kind: 'paused', reason: 'an agent turn', manual: true })).toMatchObject({
      problem: null,
    })
  })

  test('removing the terminal in front brings its neighbour', () => {
    const list = ['a', 'b', 'c'].map((id) => ({
      id,
      title: id,
      exitCode: null,
    }))
    expect(afterRemoval(list, 'b', 'b').active).toBe('c')
    expect(afterRemoval(list, 'c', 'c').active).toBe('b')
    expect(afterRemoval(list, 'a', 'c').active).toBe('a')
    expect(afterRemoval([list[0]!], 'a', 'a').active).toBeNull()
  })

  test('an error after the last one seen lights the Output item', () => {
    const store = createStore()
    store.set(activityEntriesAtom, [entry(1), entry(2, { level: 'error' })])
    expect(store.get(activityUnseenErrorAtom)).toBe(true)
    store.set(activitySeenAtom, 2)
    expect(store.get(activityUnseenErrorAtom)).toBe(false)
  })
})

describe('status bar', () => {
  test('shows the branch with a star when dirty, the counts, and when it last synced', async () => {
    syncInfo = {
      remote: 'o/r',
      branch: 'main',
      dirty: true,
      ahead: 0,
      behind: 2,
      lastSyncAt: new Date(Date.now() - 120_000).toISOString(),
      lastError: null,
    }
    const store = createStore()
    store.set(activeRemoteAtom, 'o/r')
    shell(store)
    expect(await screen.findByText('main*')).toBeInTheDocument()
    expect(screen.getByText('2↓ 0↑')).toBeInTheDocument()
    expect(screen.getByText('Synced 2m ago')).toBeInTheDocument()
  })

  test('draws no branch or sync with no vault open', () => {
    shell()
    expect(screen.queryByText(/↓/)).toBeNull()
    expect(screen.getByRole('button', { name: /terminal/i })).toBeInTheDocument()
  })

  test('clicking the sync item syncs now when it is up to date', async () => {
    syncInfo = {
      remote: 'o/r',
      branch: 'main',
      dirty: false,
      ahead: 1,
      behind: 0,
      lastSyncAt: null,
      lastError: null,
    }
    const store = createStore()
    store.set(activeRemoteAtom, 'o/r')
    shell(store)
    fireEvent.click(await screen.findByRole('button', { name: /^Sync: up to date/ }))
    await waitFor(() => expect(calls.some((c) => c.name === 'sync.now')).toBe(true))
  })

  test('clicking it on a conflict opens the Output instead', async () => {
    syncInfo = {
      remote: 'o/r',
      branch: 'main',
      dirty: false,
      ahead: 0,
      behind: 0,
      lastSyncAt: null,
      lastError: null,
    }
    const store = createStore()
    store.set(activeRemoteAtom, 'o/r')
    store.set(syncStateAtom, { kind: 'conflict', paths: ['a.md'] })
    store.set(activityLoadAtom, 'ready')
    shell(store)
    fireEvent.click(await screen.findByRole('button', { name: /^Sync: 1 file conflict/ }))
    expect(store.get(bottomPanelAtom)).toMatchObject({
      open: true,
      tab: 'output',
    })
    expect(calls.some((c) => c.name === 'sync.now')).toBe(false)
  })

  test('Terminal and Output toggle the panel on their tab', () => {
    const store = shell()
    const terminal = screen.getByRole('button', { name: /terminal/i })
    fireEvent.click(terminal)
    expect(store.get(bottomPanelAtom)).toMatchObject({
      open: true,
      tab: 'terminal',
    })
    expect(terminal).toHaveAttribute('aria-pressed', 'true')
    fireEvent.click(screen.getByRole('button', { name: /^output$/i }))
    expect(store.get(bottomPanelAtom)).toMatchObject({
      open: true,
      tab: 'output',
    })
    fireEvent.click(screen.getByRole('button', { name: /^output$/i }))
    expect(store.get(bottomPanelAtom).open).toBe(false)
  })

  test('a new error marks Output until it is seen', async () => {
    const store = createStore()
    store.set(activityLoadAtom, 'ready')
    store.set(activityEntriesAtom, [entry(1, { level: 'error', message: 'Push failed' })])
    shell(store)
    const output = screen.getByRole('button', {
      name: 'Output, with a new error',
    })
    fireEvent.click(output)
    expect(await screen.findByText('Push failed')).toBeInTheDocument()
    await waitFor(() => expect(store.get(activityUnseenErrorAtom)).toBe(false))
  })

  test("a plugin's item joins the bar", () => {
    const store = createStore()
    store.set(installedPluginsAtom, [
      {
        info: { id: 'x', label: 'X', default: true, builtIn: true },
        statusItems: [{ id: 'hi', side: 'right', Component: () => <span>2 working</span> }],
      },
    ])
    expect(store.get(runningPluginsAtom)).toHaveLength(1)
    shell(store)
    expect(screen.getByText('2 working')).toBeInTheDocument()
  })
})

describe('panel keys', () => {
  test('⌃` toggles the panel on Terminal and ⇧⌘U opens Output', () => {
    const store = shell()
    act(() => {
      fireEvent.keyDown(window, { key: '`', code: 'Backquote', ctrlKey: true })
    })
    expect(store.get(bottomPanelAtom)).toMatchObject({
      open: true,
      tab: 'terminal',
    })
    act(() => {
      fireEvent.keyDown(window, {
        key: 'U',
        code: 'KeyU',
        metaKey: true,
        shiftKey: true,
      })
    })
    expect(store.get(bottomPanelAtom)).toMatchObject({
      open: true,
      tab: 'output',
    })
    act(() => {
      fireEvent.keyDown(window, {
        key: 'U',
        code: 'KeyU',
        metaKey: true,
        shiftKey: true,
      })
    })
    expect(store.get(bottomPanelAtom).open).toBe(false)
  })

  test('a terminal that will not start says why, with Retry', async () => {
    const store = createStore()
    store.set(activeRemoteAtom, 'o/r')
    store.set(bottomPanelAtom, {
      open: true,
      tab: 'terminal',
      maximized: false,
    })
    shell(store)
    expect(await screen.findByText('node-pty did not load')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument()
  })
})

describe('output', () => {
  function output(store: ReturnType<typeof createStore>) {
    render(
      <Provider store={store}>
        <OutputSearch />
        <PanelOutput visible onRetry={() => {}} />
      </Provider>,
    )
  }

  test('empty, loading and error states', () => {
    const store = createStore()
    output(store)
    expect(screen.getByRole('status', { name: 'Loading the output' })).toBeInTheDocument()
    act(() => store.set(activityLoadAtom, 'error'))
    expect(screen.getByText('Could not load the output')).toBeInTheDocument()
    act(() => store.set(activityLoadAtom, 'ready'))
    expect(screen.getByText('Nothing has happened in the background yet')).toBeInTheDocument()
  })

  /** The rows' messages, top to bottom. */
  const messages = () =>
    screen
      .queryAllByRole('button', { name: /^(Show|Hide) details: / })
      .map((b) => b.getAttribute('aria-label')?.replace(/^\w+ details: /, ''))

  test('newest first, narrowed by the channel query and the search', () => {
    const store = createStore()
    store.set(activityLoadAtom, 'ready')
    store.set(activityEntriesAtom, [
      entry(1, { message: 'Committed abc' }),
      entry(2, { channel: 'agent', message: 'Session started: x' }),
    ])
    output(store)
    expect(messages()).toEqual(['Session started: x', 'Committed abc'])

    act(() => store.set(activityQueryAtom, channelQuery('agent')))
    expect(messages()).toEqual(['Session started: x'])

    act(() => store.set(activityQueryAtom, createFilterQuery()))
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search the output' }), {
      target: { value: 'commit' },
    })
    expect(store.get(activitySearchAtom)).toBe('commit')
    expect(messages()).toEqual(['Committed abc'])
  })

  test('the search counts the filters and clears them all at once', () => {
    const store = createStore()
    store.set(activityLoadAtom, 'ready')
    store.set(activityEntriesAtom, [entry(1)])
    output(store)
    expect(screen.queryByRole('button', { name: 'Clear filters' })).toBeNull()
    act(() => store.set(activityQueryAtom, channelQuery('git')))
    expect(screen.getByLabelText('1 filter applied')).toHaveTextContent('1')
    fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }))
    expect(store.get(activityQueryAtom).rules).toEqual([])
  })

  test('picking an attribute in the filter builder keeps it open', async () => {
    const store = createStore()
    store.set(activityLoadAtom, 'ready')
    store.set(activityEntriesAtom, [entry(1)])
    output(store)
    fireEvent.click(screen.getByRole('button', { name: 'Filter' }))
    // jsdom computes no layout, so the popover counts as hidden to queries.
    const open = { hidden: true } as const
    const builder = await screen.findByRole('dialog', {
      name: 'Filters',
      ...open,
    })
    fireEvent.click(
      within(builder).getAllByRole('button', {
        name: /Add filter/,
        ...open,
      })[0]!,
    )
    const channel = await screen.findByRole('option', {
      name: /Channel/,
      ...open,
    })
    // The picker is a Base UI portal outside the Radix popover: the press
    // that picks must not read as a click outside the builder.
    fireEvent.pointerDown(channel)
    fireEvent.click(channel)
    await waitFor(() => expect(store.get(activityQueryAtom).rules).toHaveLength(1))
    expect(screen.getByRole('dialog', { name: 'Filters', ...open })).toBeInTheDocument()
  })

  test('a search that matches nothing offers Clear filters', () => {
    const store = createStore()
    store.set(activityLoadAtom, 'ready')
    store.set(activityEntriesAtom, [entry(1, { message: 'Committed abc' })])
    store.set(activitySearchAtom, 'nothing like it')
    output(store)
    expect(screen.getByText('No matching lines')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }))
    expect(store.get(activitySearchAtom)).toBe('')
    expect(messages()).toEqual(['Committed abc'])
  })

  test('a line opens under its row, with its detail and the raw line', () => {
    const store = createStore()
    store.set(activityLoadAtom, 'ready')
    store.set(activityEntriesAtom, [
      entry(1, {
        message: 'Push failed',
        level: 'error',
        detail: 'fatal: could not resolve host',
      }),
    ])
    output(store)
    expect(screen.queryByText('fatal: could not resolve host')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Show details: Push failed' }))
    expect(screen.getByRole('button', { name: 'Hide details: Push failed' })).toHaveAttribute(
      'aria-expanded',
      'true',
    )
    expect(screen.getByText('fatal: could not resolve host')).toBeInTheDocument()
    expect(screen.getByText('Raw')).toBeInTheDocument()
    // Clicking the row itself closes it again.
    fireEvent.click(screen.getByText('Push failed'))
    expect(screen.queryByText('fatal: could not resolve host')).toBeNull()
  })

  test("a channel's context menu filters by it; a click opens the row", async () => {
    const store = createStore()
    store.set(activityLoadAtom, 'ready')
    store.set(activityEntriesAtom, [
      entry(1, { message: 'Committed abc' }),
      entry(2, { channel: 'agent', message: 'Session started: x' }),
    ])
    output(store)
    // A plain click on the channel is the row's: it opens the line.
    fireEvent.click(screen.getByText('Agent'))
    expect(store.get(activityQueryAtom).rules).toEqual([])
    expect(
      screen.getByRole('button', { name: 'Hide details: Session started: x' }),
    ).toBeInTheDocument()

    // The row's cell, not the opened panel's Channel field below it.
    fireEvent.contextMenu(screen.getAllByText('Agent')[0]!)
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Only Agent' }))
    expect(store.get(activityQueryAtom)).toEqual(channelQuery('agent'))
    expect(messages()).toEqual(['Session started: x'])

    // A second channel replaces the rule rather than ANDing the two.
    act(() => store.set(activityQueryAtom, (q) => withChannelRule(q, 'git', 'hide')))
    const rules = store.get(activityQueryAtom).rules
    expect(rules).toHaveLength(1)
    expect(rules[0]).toMatchObject({ operator: 'is_not', value: 'git' })
  })
})

describe('logs', () => {
  const line = (id: number, over: Partial<AppLogEntry> = {}): AppLogEntry => ({
    id,
    at: '2026-10-24T10:00:00.000Z',
    level: 'info',
    source: 'main',
    message: `printed ${id}`,
    ...over,
  })

  function logs(store: ReturnType<typeof createStore>) {
    render(
      <Provider store={store}>
        <LogsSearch />
        <PanelLogs onRetry={() => {}} />
      </Provider>,
    )
  }

  const messages = () =>
    screen
      .queryAllByRole('button', { name: /^(Show|Hide) details: / })
      .map((b) => b.getAttribute('aria-label')?.replace(/^\w+ details: /, ''))

  test("streams main's and the window's lines, newest first", () => {
    const store = createStore()
    store.set(appLogLoadAtom, 'ready')
    store.set(appLogEntriesAtom, [
      line(1, { scope: 'router', message: 'rescan failed', level: 'error' }),
      line(2, { source: 'renderer', message: '[activity] load failed' }),
    ])
    logs(store)
    expect(messages()).toEqual(['[activity] load failed', 'rescan failed'])
    expect(screen.getByText('Window')).toBeInTheDocument()
    expect(screen.getByText('router')).toBeInTheDocument()
    // A new line streams in at the top.
    act(() =>
      store.set(appLogEntriesAtom, (held) => mergeAppLog(held, [line(3, { message: 'hello' })])),
    )
    expect(messages()[0]).toBe('hello')
  })

  test('the search narrows by message, detail and scope', () => {
    const store = createStore()
    store.set(appLogLoadAtom, 'ready')
    store.set(appLogEntriesAtom, [
      line(1, { scope: 'vaults', message: 'could not push' }),
      line(2, { message: 'Error: boom', detail: '    at sync (git.ts:9)' }),
    ])
    logs(store)
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search the logs' }), {
      target: { value: 'git.ts' },
    })
    expect(messages()).toEqual(['Error: boom'])
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search the logs' }), {
      target: { value: 'vaults' },
    })
    expect(messages()).toEqual(['could not push'])
  })

  test('a line opens under its row with its stack', () => {
    const store = createStore()
    store.set(appLogLoadAtom, 'ready')
    store.set(appLogEntriesAtom, [
      line(1, { message: 'Error: boom', detail: '    at sync (git.ts:9)' }),
    ])
    logs(store)
    fireEvent.click(screen.getByRole('button', { name: 'Show details: Error: boom' }))
    // In the Detail block, and again inside the raw JSON.
    expect(screen.getAllByText('at sync (git.ts:9)', { exact: false }).length).toBeGreaterThan(0)
  })

  test('empty, loading and error states', () => {
    const store = createStore()
    logs(store)
    expect(screen.getByRole('status', { name: 'Loading the logs' })).toBeInTheDocument()
    act(() => store.set(appLogLoadAtom, 'error'))
    expect(screen.getByText('Could not load the logs')).toBeInTheDocument()
    act(() => store.set(appLogLoadAtom, 'ready'))
    expect(screen.getByText('Nothing printed yet')).toBeInTheDocument()
  })
})
