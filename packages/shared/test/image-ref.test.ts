import { describe, expect, it } from 'vitest'
import { resolveImageRef } from '../src/image-ref'

describe('resolveImageRef (markdown ![](target))', () => {
  it('passes http(s) targets through as external', () => {
    expect(resolveImageRef('a/note.md', 'https://x.com/i.png')).toEqual({
      kind: 'external',
      url: 'https://x.com/i.png',
    })
  })

  it('resolves a bare name relative to the note folder', () => {
    expect(resolveImageRef('projects/proposal.md', 'logo.png')).toEqual({
      kind: 'vault',
      path: 'projects/logo.png',
    })
  })

  it('resolves a name in the vault root', () => {
    expect(resolveImageRef('note.md', 'logo.png')).toEqual({ kind: 'vault', path: 'logo.png' })
  })

  it('resolves ./ and ../ against the note folder', () => {
    expect(resolveImageRef('a/note.md', './img.png')).toEqual({ kind: 'vault', path: 'a/img.png' })
    expect(resolveImageRef('a/b/note.md', '../img.png')).toEqual({ kind: 'vault', path: 'a/img.png' })
  })

  it('treats a leading slash as vault-root-absolute (GitHub semantics)', () => {
    expect(resolveImageRef('a/b/note.md', '/assets/logo.png')).toEqual({
      kind: 'vault',
      path: 'assets/logo.png',
    })
  })

  it('resolves a nested relative target', () => {
    expect(resolveImageRef('a/note.md', 'sub/img.png')).toEqual({ kind: 'vault', path: 'a/sub/img.png' })
  })

  it('clamps ".." that would escape the vault root', () => {
    expect(resolveImageRef('note.md', '../../x.png')).toEqual({ kind: 'vault', path: 'x.png' })
  })
})
