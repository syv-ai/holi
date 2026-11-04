import { describe, expect, it } from 'vitest'
import { fenceLanguageId, fencedBlocks } from '../src/fences'

describe('fenceLanguageId', () => {
  it('takes the bare name', () => {
    expect(fenceLanguageId('python')).toBe('python')
  })

  it('lowercases', () => {
    expect(fenceLanguageId('Python')).toBe('python')
    expect(fenceLanguageId('JSON')).toBe('json')
  })

  it('drops everything after the first word', () => {
    // The shapes real documents use: a title, a line-highlight range, knitr.
    expect(fenceLanguageId('js title="app.js"')).toBe('js')
    expect(fenceLanguageId('python {1,3}')).toBe('python')
    expect(fenceLanguageId('{r setup}')).toBe('r')
  })

  it('drops a leading dot', () => {
    expect(fenceLanguageId('.ts')).toBe('ts')
  })

  it('is empty for a bare fence', () => {
    expect(fenceLanguageId('')).toBe('')
    expect(fenceLanguageId('   ')).toBe('')
  })
})

describe('fencedBlocks', () => {
  it('finds a closed fence with its language, body and offsets', () => {
    const text = 'Intro\n\n```mermaid\nflowchart LR\n  A --> B\n```\n\nAfter\n'
    const [block] = fencedBlocks(text)
    expect(block).toMatchObject({ line: 3, lang: 'mermaid', body: 'flowchart LR\n  A --> B' })
    expect(text.slice(block!.from, block!.to)).toBe('```mermaid\nflowchart LR\n  A --> B\n```')
  })

  it('closes only on the same character, at least as long', () => {
    const text = '````md\n```mermaid\nx\n```\n~~~~\n````\n'
    expect(fencedBlocks(text)).toEqual([
      expect.objectContaining({ lang: 'md', body: '```mermaid\nx\n```\n~~~~' }),
    ])
  })

  it('leaves out a fence that never closes', () => {
    expect(fencedBlocks('```mermaid\nflowchart LR\n')).toEqual([])
  })

  it('does not take four spaces of indent as a fence', () => {
    expect(fencedBlocks('    ```mermaid\n    x\n    ```\n')).toEqual([])
  })

  it("strips the opening fence's indent from the body", () => {
    expect(fencedBlocks('  ~~~mermaid\n  a\n    b\n  ~~~\n')[0]!.body).toBe('a\n  b')
  })

  it('refuses a backtick in a backtick fence info string, which is inline code', () => {
    expect(fencedBlocks('```a`b\nx\n```\n')).toEqual([])
  })
})
