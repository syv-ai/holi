import { describe, expect, it } from 'vitest'
import { splitFrontmatter } from '../src/index'

describe('splitFrontmatter', () => {
  it('returns yaml: null when there is no leading fence', () => {
    expect(splitFrontmatter('hello\nworld')).toEqual({ yaml: null, body: 'hello\nworld' })
  })

  it('splits a valid fence into its yaml and body', () => {
    const { yaml, body } = splitFrontmatter('---\ntitle: x\n---\n\nbody here')
    expect(yaml).not.toBeNull()
    expect(yaml?.trim()).toBe('title: x')
    expect(body).toBe('body here')
  })

  it('yields an empty body when the fence is all there is', () => {
    expect(splitFrontmatter('---\ntitle: x\n---\n').body).toBe('')
  })

  it('throws on an unterminated fence', () => {
    expect(() => splitFrontmatter('---\ntitle: x\nno closing fence')).toThrow()
  })
})
