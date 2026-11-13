import { createStore } from 'jotai/vanilla'
import { describe, expect, it } from 'vitest'
import { openTarget } from '../renderer/bridge-host'
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
