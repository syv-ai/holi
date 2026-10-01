/**
 * Where Home goes, once the `home` setting has met the vault as it really is.
 *
 * Pure and on plain values, for the reason the whole `lib/` split exists: the
 * decision is arithmetic over "what does the vault hold", and the atom that
 * dispatches it is not the place to test whether a deleted note is reported.
 */
import { describe, expect, test } from 'vitest'
import { resolveHome } from '../src/renderer/src/lib/home-target'

/** A vault holding one note, one other file and one app. */
const vault = {
  filePaths: new Set(['Notes/Standup.md', 'plan.pdf']),
  appPaths: new Set(['retro.app']),
}

const on = (home: string) => ({ home, dailyNotes: true })
const off = (home: string) => ({ home, dailyNotes: false })

describe('the recents', () => {
  test('are shown in the Home tab, whatever the vault holds', () => {
    const empty = { filePaths: new Set<string>(), appPaths: new Set<string>() }
    expect(resolveHome(off('recents'), empty)).toEqual({
      reach: 'tab',
      target: { kind: 'recents' },
    })
  })
})

describe('an app', () => {
  test('is shown in the Home tab when the vault holds it', () => {
    expect(resolveHome(on('retro.app'), vault)).toEqual({
      reach: 'tab',
      target: { kind: 'app', path: 'retro.app' },
    })
  })

  test('is reported missing when the vault does not', () => {
    expect(resolveHome(on('gone.app'), vault)).toEqual({
      reach: 'missing',
      target: { kind: 'app', path: 'gone.app' },
    })
  })
})

describe('a file', () => {
  test.each(['Notes/Standup.md', 'plan.pdf'])('opens %s when it exists', (path) => {
    expect(resolveHome(on(path), vault)).toEqual({ reach: 'open', target: { kind: 'file', path } })
  })

  test('is reported missing once deleted', () => {
    expect(resolveHome(on('deleted.md'), vault)).toEqual({
      reach: 'missing',
      target: { kind: 'file', path: 'deleted.md' },
    })
  })
})

describe('the daily', () => {
  test('opens when the vault keeps one', () => {
    expect(resolveHome(on('daily'), vault)).toEqual({ reach: 'open', target: { kind: 'daily' } })
  })

  test('is reported missing when the vault keeps no daily', () => {
    expect(resolveHome(off('daily'), vault)).toEqual({
      reach: 'missing',
      target: { kind: 'daily' },
    })
  })
})

describe('the singleton views', () => {
  // Nothing on disk for them to point at, so `dailyNotes` has no bearing.
  test.each(['board', 'agenda', 'mail'] as const)('%s opens with daily notes off', (kind) => {
    const empty = { filePaths: new Set<string>(), appPaths: new Set<string>() }
    expect(resolveHome(off(kind), empty)).toEqual({ reach: 'open', target: { kind } })
  })
})
