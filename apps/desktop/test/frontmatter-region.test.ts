/**
 * Where the frontmatter block is, and whether its YAML parses — the two pure
 * decisions behind the frontmatter widget (FR-2 hide / FR-16 reveal). Kept out
 * of the CodeMirror wiring so they can be tested as plain string functions.
 */
import { describe, expect, it } from 'vitest'
import {
  frontmatterBlockRange,
  frontmatterRegion,
  frontmatterYamlValid,
} from '../src/renderer/src/editor/frontmatter-region'

describe('frontmatterRegion', () => {
  it('spans the fence block including its trailing newline', () => {
    const doc = '---\ntitle: x\n---\nbody line'
    // '---\ntitle: x\n---\n' is 17 chars; 'body line' starts at index 17.
    expect(frontmatterRegion(doc)).toEqual({ from: 0, to: 17 })
  })

  it('runs to end of document when the fence is all there is', () => {
    const doc = '---\ntitle: x\n---'
    expect(frontmatterRegion(doc)).toEqual({ from: 0, to: doc.length })
  })

  it('is null when there is no leading fence', () => {
    expect(frontmatterRegion('# Heading\n\nbody')).toBeNull()
  })

  it('is null for a --- that is not at the very start', () => {
    expect(frontmatterRegion('intro\n\n---\n\nmore')).toBeNull()
  })

  it('is null for an unterminated fence', () => {
    expect(frontmatterRegion('---\ntitle: x\nnever closes')).toBeNull()
  })
})

describe('frontmatterBlockRange', () => {
  /**
   * The block-replace range is the *region minus its trailing newline*, and the
   * difference is the whole of bug #1. A block decoration is supposed to end at
   * a line end; ending it at the start of the next line instead makes the first
   * body position render inside the widget's row, so the caret sat on the
   * frontmatter — right-most in it, and growing to the widget's height on
   * reveal. Parsing and write-back keep the newline (`frontmatterRegion`); only
   * what CodeMirror is asked to replace drops it.
   */
  it('stops at the end of the closing fence line, not the start of the body', () => {
    const doc = '---\ntitle: x\n---\nbody line'
    expect(frontmatterRegion(doc)).toEqual({ from: 0, to: 17 })
    expect(frontmatterBlockRange(doc)).toEqual({ from: 0, to: 16 })
  })

  it('runs to end of document when the fence is all there is', () => {
    const doc = '---\ntitle: x\n---'
    // No trailing newline to drop — the fence's line end IS the document end.
    expect(frontmatterBlockRange(doc)).toEqual({ from: 0, to: doc.length })
  })

  it('is null when there is no frontmatter', () => {
    expect(frontmatterBlockRange('# Heading\n\nbody')).toBeNull()
  })
})

describe('frontmatterYamlValid', () => {
  it('is true for a document with no frontmatter', () => {
    expect(frontmatterYamlValid('just a note')).toBe(true)
  })

  it('is true for well-formed frontmatter', () => {
    expect(frontmatterYamlValid('---\ntitle: x\ntags: [a, b]\n---\nbody')).toBe(true)
  })

  it('is false for a broken flow sequence', () => {
    expect(frontmatterYamlValid('---\ntags: [a, b\n---\nbody')).toBe(false)
  })

  it('is false for a tab-indented map (YAML forbids tabs)', () => {
    expect(frontmatterYamlValid('---\nkey:\n\tnested: v\n---\nbody')).toBe(false)
  })

  it('is false while the fence is still unterminated', () => {
    expect(frontmatterYamlValid('---\ntitle: x')).toBe(false)
  })
})
