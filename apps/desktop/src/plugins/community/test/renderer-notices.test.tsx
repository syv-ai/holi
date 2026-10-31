import { createStore } from 'jotai'
import { beforeEach, expect, test } from 'vitest'
import type { PluginRow } from '../main/capabilities'
import { communityNoticeGroups, dismissNoticeAtom, dismissedNoticesAtom } from '../renderer/state'

const row = (overrides: Partial<PluginRow> = {}): PluginRow => ({
  id: 'atlas',
  name: 'Atlas',
  description: '',
  opens: [],
  status: 'needs-setup',
  on: true,
  running: false,
  pin: { repo: 'owner/atlas', path: '', version: '1.0.0', commit: 'old' },
  install: null,
  setup: null,
  serve: null,
  apps: [],
  bin: [],
  commandsNote: null,
  check: null,
  ...overrides,
})

beforeEach(() => localStorage.clear())

test('dismissals persist per vault remote and plugin ID', () => {
  const store = createStore()
  store.set(dismissNoticeAtom, { remote: 'one/vault', id: 'atlas' })
  store.set(dismissNoticeAtom, { remote: 'one/vault', id: 'beacon' })
  store.set(dismissNoticeAtom, { remote: 'two/vault', id: 'atlas' })

  const restored = createStore()
  // A fresh renderer mounts the atom and reads this machine's saved choice.
  const unsubscribe = restored.sub(dismissedNoticesAtom, () => {})
  expect(restored.get(dismissedNoticesAtom)).toEqual({
    'one/vault': ['atlas', 'beacon'],
    'two/vault': ['atlas'],
  })
  expect(
    communityNoticeGroups(
      [row(), row({ id: 'beacon' })],
      restored.get(dismissedNoticesAtom)['one/vault']!,
      {},
    ).waiting,
  ).toEqual([])
  expect(
    communityNoticeGroups([row()], restored.get(dismissedNoticesAtom)['two/vault']!, {}).waiting,
  ).toEqual([])
  expect(communityNoticeGroups([row()], [], {}).waiting).toHaveLength(1)
  unsubscribe()
})

test('dismissal survives readiness and hides a later differing pinned version', () => {
  const store = createStore()
  store.set(dismissNoticeAtom, { remote: 'one/vault', id: 'atlas' })

  expect(
    communityNoticeGroups(
      [row({ status: 'ready', running: true })],
      store.get(dismissedNoticesAtom)['one/vault']!,
      {},
    ).waiting,
  ).toEqual([])
  expect(
    communityNoticeGroups(
      [
        row({
          status: 'pin-differs',
          pin: { repo: 'owner/atlas', path: '', version: '2.0.0', commit: 'new' },
        }),
      ],
      store.get(dismissedNoticesAtom)['one/vault']!,
      {},
    ).waiting,
  ).toEqual([])
})

test('dismissals do not hide readiness failures or running-plugin update offers', () => {
  const failingReadyPlugin = row({
    status: 'ready',
    running: true,
    check: { ok: false, hint: 'Enable Atlas first' },
  })
  const updateRow = row({ id: 'beacon', status: 'ready', running: true })
  const groups = communityNoticeGroups([failingReadyPlugin, updateRow], ['atlas'], {
    beacon: '2.0.0',
  })

  expect(groups.waiting).toEqual([])
  expect(groups.notWorking).toEqual([failingReadyPlugin])
  expect(groups.updatable).toEqual([{ row: updateRow, version: '2.0.0' }])
})
