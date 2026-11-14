import { describe, expect, it, vi } from 'vitest'
import { activateTerminalLink, fileUrlLinks } from '../renderer/lib/terminal-link-activation'

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
})
