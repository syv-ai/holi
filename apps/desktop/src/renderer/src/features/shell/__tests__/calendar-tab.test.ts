import { createStore } from 'jotai'
import { describe, expect, test } from 'vitest'

import { openTabAtom, shellWorkspaceAtom } from '@/state/shell-tabs'
import { allTabs, entryViews, isSplit, type ShellEntry } from '@/state/shell-workspace'
import { parseTabKey, tabKey } from '@/state/tab-descriptor'

const CALENDAR = { kind: 'app', id: 'calendar' } as const

describe('the Calendar shell tab', () => {
  test('uses its registered app identity, deduplicates, and opens beside a note', () => {
    const store = createStore()
    const calendarTab = tabKey(CALENDAR)
    const noteTab = tabKey({ kind: 'doc', path: 'Today.md' })

    store.set(openTabAtom, { kind: 'doc', path: 'Today.md' })
    store.set(openTabAtom, CALENDAR)
    store.set(openTabAtom, CALENDAR)

    expect(allTabs(store.get(shellWorkspaceAtom))).toEqual([noteTab, calendarTab])
    expect(parseTabKey(calendarTab)).toEqual(CALENDAR)

    store.set(openTabAtom, { kind: 'doc', path: 'Today.md' })
    store.set(openTabAtom, CALENDAR, { beside: true })
    const workspace = store.get(shellWorkspaceAtom)
    const split = workspace.entries.find((entry: ShellEntry) => isSplit(entry))
    expect(split).toBeDefined()
    expect(entryViews(split!)).toEqual([noteTab, calendarTab])
  })
})
