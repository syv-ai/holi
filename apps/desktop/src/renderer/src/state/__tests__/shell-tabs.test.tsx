import { createStore } from 'jotai'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import {
  openTabAtom,
  shellWorkspaceAtom,
  updateWorkspaceAtom,
  workspaceOfAtom,
} from '../shell-tabs'
import {
  allTabs,
  closeTab,
  emptyWorkspace,
  openInSplit,
  openNewTab,
  openTab,
  setShares,
  setSticky,
  type ShellWorkspace,
} from '../shell-workspace'
import { tabKey, type TabDescriptor } from '../tab-descriptor'
import { activeRemoteAtom } from '../vaults'

beforeEach(() => localStorage.clear())
afterEach(() => vi.restoreAllMocks())

const remote = 'demo/first'
const storageKey = `holi.workspace.${remote}`

function launch(selected = remote) {
  const store = createStore()
  store.set(activeRemoteAtom, selected)
  return store
}

test('a fresh store restores every tab kind, sticky split metadata and exact strip order before its first write', () => {
  const descriptors: TabDescriptor[] = [
    { kind: 'doc', path: 'holi:notes.md' },
    { kind: 'vault-app', path: 'Apps/Budget.app' },
    { kind: 'board' },
    { kind: 'graph' },
    { kind: 'apps' },
    { kind: 'new', n: 40 },
    { kind: 'agents-home' },
    { kind: 'session', owner: 'claude', id: 'session:one' },
    { kind: 'app', id: 'mail' },
    { kind: 'surface', surface: 'terminal', id: 'run:one' },
    { kind: 'settings' },
  ]
  const keys = descriptors.map(tabKey)
  let ws = descriptors.reduce((ws, tab) => openTab(ws, tabKey(tab), () => false), emptyWorkspace())
  ws = openInSplit({ ...ws, seq: 40 }, 'Beside.md')
  const splitId = ws.active!
  ws = setShares(ws, splitId, [0.3, 0.7])
  ws = setSticky(ws, 'Beside.md', true)
  ws = setSticky(ws, keys[2]!, true)
  ws = closeTab(openTab(ws, 'Closed.md'), 'Closed.md')
  const first = launch()
  first.set(shellWorkspaceAtom, ws)
  const saved = first.get(shellWorkspaceAtom)
  expect(saved.closed.length).toBeGreaterThan(0)

  const restarted = launch()
  expect(restarted.get(shellWorkspaceAtom)).toEqual({ ...saved, closed: [] })
  expect(allTabs(restarted.get(shellWorkspaceAtom))).toEqual(allTabs(saved))

  // No read or subscription first: an early open must extend restoration,
  // not overwrite it with an initially empty workspace.
  const early = launch()
  early.set(openTabAtom, { kind: 'doc', path: 'Early.md' })
  // Closing Closed.md selected the first ordinary document. A plain open
  // belongs immediately after that active entry, not at the strip's end.
  expect(saved.active).toBe(keys[0])
  expect(allTabs(early.get(shellWorkspaceAtom))).toEqual([
    keys[10],
    'Beside.md',
    keys[2],
    keys[0],
    'Early.md',
    keys[1],
    ...keys.slice(3, 10),
  ])
  early.set(shellWorkspaceAtom, openNewTab)
  expect(allTabs(early.get(shellWorkspaceAtom))).toContain('holi:new:42')
})

test('explicit remote updates and A→B→A switches keep each vault isolated across restart', () => {
  const store = launch()
  store.set(openTabAtom, { kind: 'doc', path: 'First.md' })
  store.set(activeRemoteAtom, 'demo/second')
  store.set(openTabAtom, { kind: 'doc', path: 'Second.md' })
  // A plugin finishing work for the now inactive vault names its remote.
  store.set(updateWorkspaceAtom, remote, (ws) => openTab(ws, 'Later.md'))
  expect(allTabs(store.get(shellWorkspaceAtom))).toEqual(['Second.md'])
  store.set(activeRemoteAtom, remote)
  store.set(openTabAtom, { kind: 'graph' })
  store.set(activeRemoteAtom, 'demo/second')
  store.set(activeRemoteAtom, remote)
  expect(allTabs(store.get(shellWorkspaceAtom))).toEqual(['First.md', 'Later.md', 'holi:graph'])

  const restarted = launch('demo/second')
  expect(allTabs(restarted.get(shellWorkspaceAtom))).toEqual(['Second.md'])
  expect(allTabs(restarted.get(workspaceOfAtom)(remote))).toEqual([
    'First.md',
    'Later.md',
    'holi:graph',
  ])
  restarted.set(activeRemoteAtom, '')
  restarted.set(openTabAtom, { kind: 'settings' })
  expect(localStorage.getItem('holi.workspace.')).toBeNull()
})

test.each(['{', 'null', '{"entries":{}}'])(
  'unreadable stored workspace starts safely: %s',
  (raw) => {
    localStorage.setItem(storageKey, raw)
    const store = launch()
    expect(store.get(shellWorkspaceAtom)).toEqual(emptyWorkspace())
    store.set(openTabAtom, { kind: 'graph' })
    expect(launch().get(shellWorkspaceAtom).entries).toEqual(['holi:graph'])
  },
)

test('malformed layouts preserve useful views without aliases, invalid focus, shares or reused sequence ids', () => {
  localStorage.setItem(
    storageKey,
    JSON.stringify({
      entries: [
        'Plan.md',
        'holi:doc:Plan.md',
        'holi:split:2',
        null,
        {
          id: 'holi:split:12',
          views: ['Plan.md', 'holi:new:20', 'Other.md', 'Other.md'],
          shares: [0, -1, 2, 3],
          focused: 'missing',
        },
        { id: 'holi:split:12', views: ['Third.md', 'Fourth.md'], shares: [0.2, 0.8] },
        { id: 'Plan.md', views: ['Fifth.md', 'Sixth.md'] },
        'holi:new:99999999999999999999999',
        'holi:unknown',
      ],
      active: 'missing',
      seq: -5,
      recent: ['missing', 'Plan.md', 'Plan.md'],
      sticky: ['missing', 'Other.md', 'Other.md'],
      closed: ['Secret.md'],
    }),
  )
  const store = launch()
  const ws = store.get(shellWorkspaceAtom)
  expect(ws).toEqual({
    entries: [
      'Plan.md',
      {
        id: 'holi:split:12',
        views: ['holi:new:20', 'Other.md'],
        shares: [0.5, 0.5],
        focused: 'holi:new:20',
      },
      'Third.md',
      'Fourth.md',
      'Fifth.md',
      'Sixth.md',
    ],
    active: 'Plan.md',
    seq: 20,
    recent: ['Plan.md'],
    sticky: ['Other.md'],
    closed: [],
  } satisfies ShellWorkspace)
  store.set(shellWorkspaceAtom, openNewTab)
  expect(allTabs(store.get(shellWorkspaceAtom))).toContain('holi:new:21')
  expect(launch().get(shellWorkspaceAtom)).toEqual(store.get(shellWorkspaceAtom))
})

test('storage refusal retains live updates and a later successful write saves the full workspace', () => {
  const store = launch()
  const write = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
    throw new DOMException('quota', 'QuotaExceededError')
  })
  expect(() => store.set(openTabAtom, { kind: 'graph' })).not.toThrow()
  expect(store.get(shellWorkspaceAtom).entries).toEqual(['holi:graph'])
  write.mockRestore()
  store.set(openTabAtom, { kind: 'board' })
  expect(launch().get(shellWorkspaceAtom).entries).toEqual(['holi:graph', 'holi:board'])

  vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
    throw new DOMException('denied', 'SecurityError')
  })
  const unavailable = launch()
  expect(unavailable.get(shellWorkspaceAtom)).toEqual(emptyWorkspace())
  expect(() => unavailable.set(openTabAtom, { kind: 'settings' })).not.toThrow()
  expect(unavailable.get(shellWorkspaceAtom).entries).toEqual(['holi:settings'])
})
