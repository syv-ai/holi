import { createStore } from 'jotai/vanilla'
import { describe, expect, it } from 'vitest'
import { hostBridgeMessage, openTarget } from '../renderer/bridge-host'
import type { PluginStore } from '@/plugin-api'

function appTabIds(
  workspace: { entries: (string | { views: string[] })[] },
  calendarTab: string,
): string[] {
  return workspace.entries
    .flatMap((entry) => (typeof entry === 'string' ? [entry] : entry.views))
    .filter((view) => view === calendarTab)
}

describe('vault app open bridge', () => {
  it('refuses a local open when native document authority was revoked', async () => {
    const store = createStore() as PluginStore
    const [{ shellWorkspaceAtom }, { tabKey }] = await Promise.all([
      import('@/state/shell-tabs'),
      import('@/state/tab-descriptor'),
    ])
    const before = store.get(shellWorkspaceAtom)
    const replies: unknown[] = []
    expect(
      hostBridgeMessage(
        { nonce: 'lease', id: 'open-1', method: 'open', params: { target: 'calendar' } },
        {
          store,
          remote: 'ada/a',
          bundle: 'Tools/Calendar.app',
          token: 'token',
          nonce: 'lease',
          current: () => true,
          authorize: async () => false,
          reply: (message) => replies.push(message),
        },
      ),
    ).toBe(true)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(store.get(shellWorkspaceAtom)).toEqual(before)
    expect(store.get(shellWorkspaceAtom).entries).not.toContain(
      tabKey({ kind: 'app', id: 'calendar' }),
    )
    expect(replies).toEqual([])
  })

  it('opens the canonical Calendar app for legacy and canonical targets without duplicates', async () => {
    const store = createStore() as PluginStore
    const [{ shellWorkspaceAtom }, { tabKey }] = await Promise.all([
      import('@/state/shell-tabs'),
      import('@/state/tab-descriptor'),
    ])
    const calendarTab = tabKey({ kind: 'app', id: 'calendar' })

    expect(openTarget(store, { target: 'agenda' })).toEqual({ ok: true })
    expect(appTabIds(store.get(shellWorkspaceAtom), calendarTab)).toEqual([calendarTab])

    expect(openTarget(store, { target: 'calendar' })).toEqual({ ok: true })
    expect(openTarget(store, { target: 'agenda' })).toEqual({ ok: true })
    expect(appTabIds(store.get(shellWorkspaceAtom), calendarTab)).toEqual([calendarTab])
    expect(store.get(shellWorkspaceAtom).active).toBe(calendarTab)
  })
})
