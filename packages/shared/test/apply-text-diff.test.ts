import * as Y from 'yjs'
import { describe, expect, it } from 'vitest'
import { applyTextDiff, YDOC_TEXT_KEY } from '../src'

function textDoc(initial: string): { ydoc: Y.Doc; text: Y.Text } {
  const ydoc = new Y.Doc()
  const text = ydoc.getText(YDOC_TEXT_KEY)
  text.insert(0, initial)
  return { ydoc, text }
}

describe('applyTextDiff', () => {
  it('applies an in-place edit as a minimal patch', () => {
    const { text } = textDoc('# Title\n\nbody line\n')
    applyTextDiff(text, '# Title\n\nbody line\n', '# Title\n\nbody line edited\n')
    expect(text.toString()).toBe('# Title\n\nbody line edited\n')
  })

  it('handles pure insert, pure delete, and full replace', () => {
    const a = textDoc('abc')
    applyTextDiff(a.text, 'abc', 'aXbc')
    expect(a.text.toString()).toBe('aXbc')

    const b = textDoc('aXbc')
    applyTextDiff(b.text, 'aXbc', 'abc')
    expect(b.text.toString()).toBe('abc')

    const c = textDoc('old')
    applyTextDiff(c.text, 'old', 'completely different')
    expect(c.text.toString()).toBe('completely different')
  })

  it('preserves concurrent edits to OTHER regions (the D25 property)', () => {
    // live doc has a concurrent edit at the top; the ingested diff touches the bottom
    const { text } = textDoc('LIVE EDIT\nintro\n\noutro\n')
    const base = 'intro\n\noutro\n' // what the last export saw
    const next = 'intro\n\noutro — changed by remote session\n'
    expect(applyTextDiff(text, base, next)).toBe(true) // diverged
    expect(text.toString()).toContain('LIVE EDIT')
    expect(text.toString()).toContain('changed by remote session')
  })

  it('returns false when the live text equals the base (clean apply)', () => {
    const { text } = textDoc('same\n')
    expect(applyTextDiff(text, 'same\n', 'same but new\n')).toBe(false)
  })
})
