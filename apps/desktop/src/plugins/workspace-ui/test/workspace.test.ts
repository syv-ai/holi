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
} from '../../../renderer/src/state/plugins'
import { googleRenderer } from '../../google/renderer'
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

test('it is off until a vault turns it on', () => {
  expect(WORKSPACE_INFO.default).toBe(false)
  const store = storeWith([workspaceRenderer, googleRenderer])
  expect(store.get(hubPlacementAtom)).toBe('sidebar')
  expect(store.get(tabsPlacementAtom)).toBe('strip')
})

test('running, it docks the nav menu and puts the tabs in it', () => {
  const store = storeWith([ON])
  expect(store.get(hubPlacementAtom)).toBe('dock')
  expect(store.get(tabsPlacementAtom)).toBe('hub')
})

test('the nav lists its Apps page in place of the apps plugin’s item', () => {
  const on = storeWith([ON, APPS]).get(railAtom)
  expect(on.map((item) => item.surface)).toEqual(['apps'])
  const off = storeWith([APPS]).get(railAtom)
  expect(off.map((item) => item.surface)).toEqual(['app'])
})

test('the Agenda opens on the month only while it runs', () => {
  const kept = storeWith([googleRenderer]).get(surfacesAtom).get('agenda')!
  const replaced = storeWith([ON, googleRenderer]).get(surfacesAtom).get('agenda')!
  expect(replaced.render).not.toBe(kept.render)
  expect(replaced.homeable).toBe(true)
})
