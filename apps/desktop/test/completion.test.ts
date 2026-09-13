import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, test } from 'vitest'
import { COMPLETION_CLASS, OPTION_CLASS, holiOptionClass } from '@/editor/completion'

describe('a row we author is marked, and nothing else is', () => {
  test('our own sources name a `holi-` type, and get the class the chrome needs', () => {
    expect(holiOptionClass({ label: '/todo', type: 'holi-list-todo' })).toBe(OPTION_CLASS)
  })

  // codemirror-markdown-tables styles its own menu from ~20 rules keyed on
  // `.cm-completionIcon-table`. Marking its rows would lay our row layout over
  // theirs, and `:has()` means we would lose that fight anyway.
  test('a library’s row is left entirely alone', () => {
    expect(holiOptionClass({ label: '2x2', type: 'table' })).toBe('')
    expect(holiOptionClass({ label: 'plain' })).toBe('')
  })
})

describe('every completion popup goes through holiCompletion', () => {
  const read = (rel: string): string =>
    readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8')

  // The chrome hangs off a class that only `holiCompletion` stamps, so a call
  // site that reaches for `autocompletion()` directly gets CodeMirror's look
  // and says nothing about it. That is how the old block came to be dead.
  test.each([
    '../src/renderer/src/editor/extensions.ts',
    '../src/renderer/src/editor/settings-completion.ts',
  ])('%s does not call autocompletion() directly', (file) => {
    expect(read(file)).not.toMatch(/\bautocompletion\(/)
  })
})

test('the popup class is the one the chrome will look for', () => {
  expect(COMPLETION_CLASS).toBe('cm-holi-completion')
})
