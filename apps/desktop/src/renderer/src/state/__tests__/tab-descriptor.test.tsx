import { describe, expect, test } from 'vitest'

import {
  AGENTS_HOME_KEY,
  BOARD_KEY,
  parseTabKey,
  sessionKey,
  tabForPath,
  tabKey,
  tabPath,
  type TabDescriptor,
} from '../tab-descriptor'
import { BOARD_TAB } from '@/features/sidebar/documents-nav'
import { NEW_TAB_PREFIX } from '@/features/shell/new-tab-view'

const EVERY: TabDescriptor[] = [
  { kind: 'doc', path: 'Notes/Plan.md' },
  { kind: 'doc', path: 'README' },
  { kind: 'vault-app', path: 'Apps/Budget.app' },
  { kind: 'board' },
  { kind: 'graph' },
  { kind: 'new', n: 3 },
  { kind: 'agents-home' },
  { kind: 'session', owner: 'chat', id: 'abc-123' },
  { kind: 'session', owner: 'agent', id: 'session:job:7' },
  { kind: 'app', id: 'mail' },
  { kind: 'settings' },
]

describe('tab keys', () => {
  test('every descriptor survives the trip through its key', () => {
    for (const tab of EVERY) expect(parseTabKey(tabKey(tab))).toEqual(tab)
  })

  test('a document is its path, as the tree and open requests name it', () => {
    expect(tabKey({ kind: 'doc', path: 'Notes/Plan.md' })).toBe('Notes/Plan.md')
    expect(parseTabKey('Daily/2026-10-23.md')).toEqual({
      kind: 'doc',
      path: 'Daily/2026-10-23.md',
    })
  })

  test('a bundle path is its vault app', () => {
    expect(tabForPath('Apps/Budget.app')).toEqual({
      kind: 'vault-app',
      path: 'Apps/Budget.app',
    })
    expect(tabPath('Apps/Budget.app')).toBe('Apps/Budget.app')
  })

  test('a document that would read as a view is escaped', () => {
    const odd: TabDescriptor[] = [
      { kind: 'doc', path: 'holi:board' },
      { kind: 'doc', path: 'Downloads/Tool.app' },
    ]
    for (const tab of odd) {
      expect(tabKey(tab).startsWith('holi:doc:')).toBe(true)
      expect(parseTabKey(tabKey(tab))).toEqual(tab)
    }
  })

  test("the views' keys are the shell's constants", () => {
    expect(BOARD_KEY).toBe(BOARD_TAB)
    expect(tabKey({ kind: 'new', n: 1 })).toBe(`${NEW_TAB_PREFIX}1`)
    expect(AGENTS_HOME_KEY).toBe('holi:agents')
    expect(sessionKey({ owner: 'chat', id: 'x' })).toBe('holi:session:chat:x')
  })

  test('a malformed or unknown view key parses to nothing', () => {
    for (const key of [
      '',
      'holi:',
      'holi:nope',
      'holi:board:extra',
      'holi:new:',
      'holi:new:x',
      'holi:new:-1',
      'holi:session:chat',
      'holi:session::x',
      'holi:session:chat:',
      'holi:app:',
      'holi:doc:',
    ]) {
      expect(parseTabKey(key)).toBeNull()
    }
  })
})
