/**
 * Workspace is a plugin, not a setting: what it changes follows from it
 * running. Each part gives way to the plugin it draws over when it is off.
 */
import { createStore } from 'jotai'
import { Inbox } from 'lucide-react'
import { expect, test } from 'vitest'
import type { RendererPlugin } from '@/plugin-api'
import {
  coreContributionAtom,
  hubPlacementAtom,
  installedPluginsAtom,
  railAtom,
  surfacesAtom,
  tabsPlacementAtom,
  utilitiesPlacementAtom,
} from '../../../renderer/src/state/plugins'
import { commandsAtom } from '../../../renderer/src/state/commands'
import { WORKSPACE_INFO } from '../info'
import { workspaceRenderer } from '../renderer'

/** On, as a vault that turned it on has it. */
const ON: RendererPlugin = { ...workspaceRenderer, info: { ...WORKSPACE_INFO, default: true } }

/** The apps plugin's own item, as it has it, without its instances. */
const APPS: RendererPlugin = {
  info: { id: 'apps', label: 'Apps', default: true },
  surfaces: [{ kind: 'app', label: 'App', icon: Inbox, render: () => null }],
  rail: [{ surface: 'app', order: 20, label: 'Apps' }],
}

function storeWith(plugins: readonly RendererPlugin[]) {
  const store = createStore()
  store.set(coreContributionAtom, { surfaces: [], rail: [], claims: [] })
  store.set(installedPluginsAtom, plugins)
  return store
}

test('running, it docks the nav menu, puts the tabs in it and Settings and sync in the header', () => {
  const store = storeWith([ON])
  expect(store.get(hubPlacementAtom)).toBe('dock')
  expect(store.get(tabsPlacementAtom)).toBe('hub')
  expect(store.get(utilitiesPlacementAtom)).toBe('header')
})

test('the nav lists its Apps page in place of the apps plugin’s item, wherever it is listed', () => {
  for (const plugins of [
    [ON, APPS],
    [APPS, ON],
  ]) {
    const on = storeWith(plugins).get(railAtom)
    expect(on.map((item) => item.surface)).toEqual(['apps'])
  }
  const off = storeWith([APPS]).get(railAtom)
  expect(off.map((item) => item.surface)).toEqual(['app'])
})

test('with the apps plugin off there is no Apps page or item, and the dock stays', () => {
  const store = storeWith([ON])
  expect(store.get(surfacesAtom).has('apps')).toBe(false)
  expect(store.get(railAtom).map((item) => item.surface)).toEqual([])
  expect(store.get(commandsAtom).some((c) => c.id === 'apps.open')).toBe(false)
  expect(store.get(hubPlacementAtom)).toBe('dock')
})
