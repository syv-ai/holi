/**
 * The one table of commands (D102).
 *
 * The invariants are what make "one table" mean anything: two rows with one
 * id would run the wrong one from the palette, two rows with one hotkey would
 * fire two commands on one key, and a menu-bound row with no glyph would show
 * nothing beside "Close tab". The dynamic rows are checked for the one thing
 * that could go wrong: offering to switch to the vault you are already in.
 */
import { createStore } from 'jotai'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { installFakeHoli, type FakeHoli } from './helpers/fake-holi'
import { parseHotkey } from '../src/renderer/src/lib/hotkey'
import {
  STATIC_COMMANDS,
  commandsAtom,
  runCommandAtom,
  untitledPath,
} from '../src/renderer/src/state/commands'
import { activeRemoteAtom, vaultsAtom } from '../src/renderer/src/state/vaults'
import { emptyWorkspace, workspaceAtom } from '../src/renderer/src/state/panes'

let holi: FakeHoli
beforeEach(() => {
  holi = installFakeHoli()
})
afterEach(() => holi.restore())

const vault = (remote: string) => ({
  remote,
  path: `/v/${remote}`,
  name: remote.split('/')[1]!,
  lastOpenedAt: '',
})

describe('the static rows', () => {
  it('have unique ids', () => {
    const ids = STATIC_COMMANDS.map((c) => c.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('have unique hotkeys', () => {
    const keys = STATIC_COMMANDS.flatMap((c) => (c.hotkey === undefined ? [] : [c.hotkey]))
    expect(new Set(keys).size).toBe(keys.length)
  })

  it('every hotkey parses to a real key', () => {
    for (const c of STATIC_COMMANDS) {
      if (c.hotkey === undefined) continue
      const p = parseHotkey(c.hotkey)
      expect(p.key, c.id).not.toBe('')
      expect(p.mod, c.id).toBe(true)
    }
  })

  it('a menu-bound row carries a glyph to display', () => {
    for (const c of STATIC_COMMANDS) {
      if (c.boundBy === 'menu') expect(c.hotkey, c.id).toBeDefined()
    }
  })

  it('⌘T and ⌘⇧T are two rows, so shift is not a flag on one', () => {
    const t = STATIC_COMMANDS.find((c) => c.hotkey === '⌘T')
    const shiftT = STATIC_COMMANDS.find((c) => c.hotkey === '⌘⇧T')
    expect(t?.id).toBe('task.new')
    expect(shiftT?.id).toBe('task.new.full')
  })
})

describe('the dynamic rows', () => {
  it('offer a switch to every vault but the active one', () => {
    const store = createStore()
    store.set(vaultsAtom, [vault('o/a'), vault('o/b'), vault('o/c')])
    store.set(activeRemoteAtom, 'o/b')

    const switches = store.get(commandsAtom).filter((c) => c.id.startsWith('vault.switch:'))

    expect(switches.map((c) => c.id)).toEqual(['vault.switch:o/a', 'vault.switch:o/c'])
    expect(switches[0]!.label).toBe('Switch to a')
  })
})

describe('runCommandAtom', () => {
  it('ignores an unknown id', async () => {
    const store = createStore()
    await expect(store.set(runCommandAtom, 'no.such')).resolves.toBeUndefined()
  })

  it('runs a row by id: pane.split adds a pane', async () => {
    const store = createStore()
    store.set(workspaceAtom, emptyWorkspace())

    await store.set(runCommandAtom, 'pane.split')

    expect(store.get(workspaceAtom).panes).toHaveLength(2)
  })

  it('refuses a row whose `when` is false: no vault, no new note', async () => {
    const store = createStore()
    store.set(activeRemoteAtom, null)

    await store.set(runCommandAtom, 'note.new')

    expect(holi.calls.map((c) => c.path)).not.toContain('notes.create')
  })
})

describe('untitledPath', () => {
  it('counts up past what is taken', () => {
    expect(untitledPath(new Set())).toBe('Untitled.md')
    expect(untitledPath(new Set(['Untitled.md']))).toBe('Untitled 2.md')
    expect(untitledPath(new Set(['Untitled.md', 'Untitled 2.md']))).toBe('Untitled 3.md')
  })
})
