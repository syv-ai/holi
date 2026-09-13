import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, test } from 'vitest'
import { COMPLETION_CLASS, OPTION_CLASS, holiOptionClass } from '@/editor/completion'
import { completionChrome } from '@/editor/theme'

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

describe('the chrome cannot go quietly dead again', () => {
  // The failure this catches is the one that was live for months: a selector
  // CodeMirror's own rule outranks applies nothing and reports nothing.
  test('every selector carries the class that wins the cascade', () => {
    for (const selector of Object.keys(completionChrome)) {
      if (selector.startsWith('@')) continue // keyframes have no selector
      expect(selector).toContain(COMPLETION_CLASS)
    }
  })

  // The popup was the one overlay in the app that ignored D64 theming and
  // light mode, because this block was written in hex.
  test('nothing here is a colour literal', () => {
    expect(JSON.stringify(completionChrome)).not.toMatch(/#[0-9a-fA-F]{3}/)
  })

  // `:has()` carries its argument's specificity, so the table menu outranks
  // anything here. Contesting it would only produce another dead rule.
  test('the markdown-table menu is left to its library', () => {
    expect(JSON.stringify(completionChrome)).not.toContain('cm-completionIcon-table')
  })
})

describe('the popup moves in the app’s vocabulary and no other', () => {
  const chrome = JSON.stringify(completionChrome)

  // D98: anything that cannot name one of the four behaviours does not animate.
  // Opening is `arrive`; the selection is `respond`. Nothing here loops.
  test('every duration comes from the motion tier', () => {
    expect(chrome).toContain('var(--motion-arrive')
    expect(chrome).toContain('var(--motion-respond')
    expect(chrome).not.toContain('var(--motion-inflight')
  })

  // The stated numbers the renderer lint gate exists to stop. A fallback inside
  // a `var()` is the one exception the app already makes, for tokens Tailwind
  // cannot see referenced from CSS-in-JS.
  test('no duration is stated at the call site', () => {
    expect(chrome.replace(/var\(--[a-z-]+, ?\d+m?s\)/g, '')).not.toMatch(/\d+ms/)
  })
})
