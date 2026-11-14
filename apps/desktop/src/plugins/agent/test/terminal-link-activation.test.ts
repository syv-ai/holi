import { describe, expect, it, vi } from 'vitest'
import {
  activateTerminalLink,
  fileUrlLinks,
  isTerminalLinkActivation,
  wrappedTerminalLine,
} from '../renderer/lib/terminal-link-activation'

const ROOT = '/Users/ada/Holi/syv/vault'
const FILES = new Set(['notes/a.md'])

function handlers() {
  return {
    openDocument: vi.fn(),
    openExternal: vi.fn(),
    revealLocalFile: vi.fn(),
  }
}

describe('embedded terminal link activation', () => {
  it('opens HTTP(S) links externally', () => {
    const actions = handlers()
    activateTerminalLink('https://example.com/path', { ...actions, paths: FILES, root: ROOT })
    activateTerminalLink('http://example.com', { ...actions, paths: FILES, root: ROOT })
    expect(actions.openExternal).toHaveBeenNthCalledWith(1, 'https://example.com/path')
    expect(actions.openExternal).toHaveBeenNthCalledWith(2, 'http://example.com/')
  })

  it('opens known vault file URLs as documents', () => {
    const actions = handlers()
    activateTerminalLink('file:///Users/ada/Holi/syv/vault/notes/a.md', {
      ...actions,
      paths: FILES,
      root: ROOT,
    })
    expect(actions.openDocument).toHaveBeenCalledWith('notes/a.md')
    expect(actions.revealLocalFile).not.toHaveBeenCalled()
  })

  it('reveals file URLs outside the vault without executing them', () => {
    const actions = handlers()
    activateTerminalLink('file:///Users/ada/Desktop/report%20draft.pdf', {
      ...actions,
      paths: FILES,
      root: ROOT,
    })
    expect(actions.revealLocalFile).toHaveBeenCalledWith('/Users/ada/Desktop/report draft.pdf')
    expect(actions.openExternal).not.toHaveBeenCalled()
    expect(actions.openDocument).not.toHaveBeenCalled()
  })

  it('ignores unsafe schemes and malformed file URLs', () => {
    const actions = handlers()
    for (const link of [
      'javascript:alert(1)',
      'data:text/html,hello',
      'file://remote/etc/passwd',
    ]) {
      activateTerminalLink(link, { ...actions, paths: FILES, root: ROOT })
    }
    expect(actions.openExternal).not.toHaveBeenCalled()
    expect(actions.openDocument).not.toHaveBeenCalled()
    expect(actions.revealLocalFile).not.toHaveBeenCalled()
  })

  it('recognizes plaintext file URLs without trailing punctuation', () => {
    expect(fileUrlLinks('See file:///tmp/report%20draft.pdf, then continue')).toEqual([
      { text: 'file:///tmp/report%20draft.pdf', start: 4, end: 34 },
    ])
  })

  it('requires a modified primary click for activation', () => {
    const event = (button: number, metaKey = false, ctrlKey = false) =>
      ({ button, metaKey, ctrlKey }) as MouseEvent
    expect(isTerminalLinkActivation(event(0))).toBe(false)
    expect(isTerminalLinkActivation(event(2, true))).toBe(false)
    expect(isTerminalLinkActivation(event(0, true))).toBe(true)
    expect(isTerminalLinkActivation(event(0, false, true))).toBe(true)
  })

  it('finds a wrapped file URL across rows and maps offsets to terminal cells', () => {
    const url = 'file:///Users/ada/notes/a%20draft.md'
    const rows = [
      { isWrapped: false, text: `prefix ${url.slice(0, 17)}` },
      { isWrapped: true, text: url.slice(17) },
    ]
    const logical = wrappedTerminalLine(1, 24, (row) => {
      const item = rows[row]
      if (!item) return undefined
      return {
        isWrapped: item.isWrapped,
        getCell: (index: number) => ({
          getChars: () => item.text[index] ?? '',
          getWidth: () => 1,
        }),
      }
    })
    const link = fileUrlLinks(logical.text)[0]!
    expect(link.text).toBe(url)
    expect(logical.cellAt(link.start)).toEqual({ x: 8, y: 1 })
    expect(logical.cellAt(link.end - 1)).toEqual({ x: url.length - 17, y: 2 })
  })

  it('preserves blank gaps, skips wide-cell continuations, and returns absolute rows', () => {
    const rows = [
      { isWrapped: false, cells: ['x', ' ', ''] },
      { isWrapped: true, cells: ['y', ''] },
    ]
    const logical = wrappedTerminalLine(4, 3, (row) => {
      const item = rows[row - 3]
      if (!item) return undefined
      return {
        isWrapped: item.isWrapped,
        getCell: (index: number) => {
          if (index >= item.cells.length) return undefined
          return {
            getChars: () => item.cells[index]!,
            getWidth: () => (row === 3 && index === 2 ? 0 : 1),
          }
        },
      }
    })
    expect(logical.text).toBe('x y ')
    expect(logical.cellAt(2)).toEqual({ x: 1, y: 5 })
  })
})
