/**
 * Finding a word inside a document that is not the app's.
 *
 * These run against a plain jsdom element, which is exactly the contract: the
 * module knows nothing about iframes or React, and takes any `Element`. The
 * coordination across a thread's several frames is the component's job.
 */
import { beforeEach, describe, expect, test } from 'vitest'
import { clearIn, findIn, setActiveMark } from '../mail-find'

let root: HTMLElement

beforeEach(() => {
  root = document.createElement('div')
  document.body.append(root)
})

describe('findIn', () => {
  test('marks every occurrence, in document order', () => {
    root.innerHTML = '<p>budget</p><p>the budget again</p>'

    const marks = findIn(root, 'budget')

    expect(marks).toHaveLength(2)
    expect(root.querySelectorAll('mark')).toHaveLength(2)
    expect(marks[0]!.textContent).toBe('budget')
  })

  test('matches several times inside one text node', () => {
    // The splitting is done right to left so an earlier index survives a later
    // split. Two in one node is what catches getting that backwards.
    root.innerHTML = '<p>budget budget budget</p>'

    expect(findIn(root, 'budget')).toHaveLength(3)
  })

  test('ignores case, and keeps the text that was actually there', () => {
    root.innerHTML = '<p>The Budget</p>'

    const marks = findIn(root, 'budget')

    expect(marks).toHaveLength(1)
    // Not re-cased to the search term — the message said "Budget".
    expect(marks[0]!.textContent).toBe('Budget')
    expect(root.textContent).toBe('The Budget')
  })

  test('finds nothing for an empty term rather than marking everything', () => {
    root.innerHTML = '<p>budget</p>'

    expect(findIn(root, '')).toEqual([])
    expect(root.querySelectorAll('mark')).toHaveLength(0)
  })

  test('searching again replaces the previous marks instead of nesting them', () => {
    root.innerHTML = '<p>the budget report</p>'
    findIn(root, 'budget')

    const marks = findIn(root, 'report')

    expect(marks).toHaveLength(1)
    expect(root.querySelectorAll('mark')).toHaveLength(1)
    expect(root.textContent).toBe('the budget report')
  })

  test('finds the same word twice in a row', () => {
    // The regression `normalize()` exists for: unwrapping leaves the text in
    // three adjacent nodes, and without joining them the second search cannot
    // match a term straddling the seam. The highlight worked once and then
    // stopped working on the same word.
    root.innerHTML = '<p>the budget report</p>'
    findIn(root, 'budget')

    expect(findIn(root, 'budget')).toHaveLength(1)
  })

  test('carries its own colours, so a message cannot hide the highlight', () => {
    root.innerHTML = '<p>budget</p>'

    const style = findIn(root, 'budget')[0]!.getAttribute('style')!

    // Mail brings hostile CSS. A highlight a newsletter can switch off is worse
    // than none, because the counter still claims the match is there.
    expect(style).toContain('!important')
  })
})

describe('clearIn', () => {
  test('puts the document back exactly as it was', () => {
    root.innerHTML = '<p>the budget report</p>'
    const before = root.innerHTML
    findIn(root, 'budget')
    expect(root.innerHTML).not.toBe(before)

    clearIn(root)

    expect(root.innerHTML).toBe(before)
  })

  test('is safe on a document that was never searched', () => {
    root.innerHTML = '<p>nothing here</p>'

    expect(() => clearIn(root)).not.toThrow()
    expect(root.textContent).toBe('nothing here')
  })
})

describe('setActiveMark', () => {
  test('paints exactly one match as the current one', () => {
    root.innerHTML = '<p>budget budget</p>'
    const marks = findIn(root, 'budget')

    setActiveMark(marks, 1)

    expect(marks[0]!.hasAttribute('data-holi-find-active')).toBe(false)
    expect(marks[1]!.hasAttribute('data-holi-find-active')).toBe(true)
    expect(marks[0]!.getAttribute('style')).not.toBe(marks[1]!.getAttribute('style'))
  })

  test('moving the active mark leaves only one active', () => {
    root.innerHTML = '<p>budget budget</p>'
    const marks = findIn(root, 'budget')
    setActiveMark(marks, 1)

    setActiveMark(marks, 0)

    expect(root.querySelectorAll('[data-holi-find-active]')).toHaveLength(1)
  })
})
