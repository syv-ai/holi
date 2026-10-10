/**
 * The quick agents' dock, the pure parts: where it and a panel beside it go,
 * the dock's key in the settings file and through the settings capability,
 * and what main reads from the dock's page and from a panel's.
 */
import { describe, expect, it, vi } from 'vitest'
import type { CapabilityContext } from '../../../main/capabilities/registry'
import { quickCapabilities } from '../main/quick/capabilities'
import type { QuickAgent } from '../main/quick/index'
import { placeBesideDock, placeDock } from '../main/quick/placement'
import { parseQuickSettings } from '../main/quick/settings'
import { DEFAULT_DOCK_HOTKEY, DEFAULT_QUICK_HOTKEY } from '../shared/hotkey'
import { parseDockRequest, parseQuickRequest, type QuickSettingsState } from '../shared/quick'

describe('where the dock goes', () => {
  const area = { x: 0, y: 25, width: 1440, height: 875 }

  it('stands against the right edge, 6 px in, vertically centred', () => {
    expect(placeDock({ width: 28, height: 64 }, area)).toEqual({
      x: 1440 - 6 - 28,
      y: 25 + Math.round((875 - 64) / 2),
      width: 28,
      height: 64,
    })
  })

  it('is never taller than the display', () => {
    const r = placeDock({ width: 28, height: 5_000 }, area)
    expect(r.y).toBe(25 + 6)
    expect(r.height).toBe(875 - 12)
  })

  it('puts a panel to its left, its header level with the dot', () => {
    const dock = { x: 1406, y: 400, width: 28, height: 64 }
    expect(placeBesideDock({ width: 360, height: 60 }, dock, 432, 22, area)).toEqual({
      x: 1406 - 8 - 360,
      y: 410,
      width: 360,
      height: 60,
    })
  })
})

describe("the dock's key in the settings", () => {
  it('is ⌃⌘J unless the file says another key', () => {
    expect(parseQuickSettings({}).dockHotkey).toBe(DEFAULT_DOCK_HOTKEY)
    expect(parseQuickSettings({ dockHotkey: '⌥Space' }).dockHotkey).toBe('⌥Space')
  })

  it('gives way when the file holds one Holi cannot register, or the prompt key', () => {
    expect(parseQuickSettings({ dockHotkey: 'K' }).dockHotkey).toBe(DEFAULT_DOCK_HOTKEY)
    expect(parseQuickSettings({ dockHotkey: 42 }).dockHotkey).toBe(DEFAULT_DOCK_HOTKEY)
    expect(parseQuickSettings({ hotkey: '⌥Space', dockHotkey: '⌥Space' })).toMatchObject({
      hotkey: '⌥Space',
      dockHotkey: DEFAULT_DOCK_HOTKEY,
    })
  })

  it('is never the prompt key, even when the prompt key is its default', () => {
    // A file from before the dock, whose prompt key was set to ⌃⌘J: the
    // defaults trade places.
    expect(parseQuickSettings({ hotkey: DEFAULT_DOCK_HOTKEY })).toMatchObject({
      hotkey: DEFAULT_DOCK_HOTKEY,
      dockHotkey: DEFAULT_QUICK_HOTKEY,
    })
    expect(
      parseQuickSettings({ hotkey: DEFAULT_DOCK_HOTKEY, dockHotkey: DEFAULT_DOCK_HOTKEY }),
    ).toMatchObject({ hotkey: DEFAULT_DOCK_HOTKEY, dockHotkey: DEFAULT_QUICK_HOTKEY })
  })

  it('is taken and given back by the settings capability', async () => {
    const state: QuickSettingsState = {
      enabled: true,
      hotkey: '⌘J',
      conflict: false,
      dockHotkey: '⌥Space',
      dockConflict: false,
      accessibility: true,
    }
    const setSettings = vi.fn(async () => state)
    const quick = { settings: async () => state, setSettings } as unknown as QuickAgent
    const table = quickCapabilities({
      desk: { pending: () => [], answer: () => false },
      quick: () => quick,
      liveRemote: () => 'syv/vault',
    })
    const entry = table['agent.setQuickSettings']
    const ctx = { remote: 'syv/vault' } as unknown as CapabilityContext
    expect(await entry.run(ctx, entry.params({ dockHotkey: '⌥Space' }))).toEqual(state)
    expect(setSettings).toHaveBeenCalledWith({ dockHotkey: '⌥Space' })
    expect(() => entry.params({ dockHotkey: 7 })).toThrow('dockHotkey must be a string')
    const read = table['agent.quickSettings']
    expect(await read.run(ctx, read.params({}))).toMatchObject({ dockHotkey: '⌥Space' })
  })

  it('is pressed in the main window through a capability, which the window answers it with', async () => {
    const dock = vi.fn(async () => true)
    const table = quickCapabilities({
      desk: { pending: () => [], answer: () => false },
      quick: () => ({ dock }) as unknown as QuickAgent,
      liveRemote: () => 'syv/vault',
    })
    const entry = table['agent.quickDock']
    expect(entry.doors).toEqual(['ui'])
    const ctx = { remote: 'syv/vault' } as unknown as CapabilityContext
    expect(await entry.run(ctx, entry.params({}))).toBe(true)
    expect(dock).toHaveBeenCalledOnce()
  })
})

describe("the dock's page", () => {
  it('is read only when well formed', () => {
    expect(parseDockRequest({ kind: 'hover', id: null })).toEqual({ kind: 'hover', id: null })
    expect(parseDockRequest({ kind: 'pick', id: '2' })).toEqual({ kind: 'pick', id: '2' })
    expect(parseDockRequest({ kind: 'size', width: 28, height: 46, dots: [14, 32] })).toEqual({
      kind: 'size',
      width: 28,
      height: 46,
      dots: [14, 32],
    })
    expect(parseDockRequest({ kind: 'size', width: 28, height: 46, dots: [Number.NaN] })).toBeNull()
    expect(parseDockRequest({ kind: 'pick' })).toBeNull()
    expect(parseDockRequest('ready')).toBeNull()
  })
})

describe("a panel's size", () => {
  it('carries the middle of its header, which lines up with its dot, when the page measured it', () => {
    expect(parseQuickRequest({ kind: 'size', width: 540, height: 300, header: 25.5 })).toEqual({
      kind: 'size',
      width: 540,
      height: 300,
      header: 25.5,
    })
    expect(parseQuickRequest({ kind: 'size', width: 400, height: 44 })).toEqual({
      kind: 'size',
      width: 400,
      height: 44,
    })
    expect(parseQuickRequest({ kind: 'size', width: 400, height: 44, header: 'top' })).toEqual({
      kind: 'size',
      width: 400,
      height: 44,
    })
    expect(parseQuickRequest({ kind: 'size', width: Number.NaN, height: 44 })).toBeNull()
  })
})
