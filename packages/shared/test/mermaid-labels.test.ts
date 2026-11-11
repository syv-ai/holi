import { describe, expect, it } from 'vitest'
import { analyseMermaidLabels, minimalTextChange, patchMermaidLabel } from '../src/mermaid-labels'

describe('Mermaid label source edits', () => {
  it.each([
    ['', 'text', { from: 0, to: 0, insert: 'text' }],
    ['text', '', { from: 0, to: 4, insert: '' }],
    ['AlphaAlpha', 'Alpha', { from: 5, to: 10, insert: '' }],
    ['aaaa', 'a', { from: 1, to: 4, insert: '' }],
    ['ababa', 'aba', { from: 3, to: 5, insert: '' }],
    ['same', 'same', { from: 4, to: 4, insert: '' }],
  ])('calculates a non-overlapping minimal edit for %s → %s', (oldText, newText, expected) => {
    expect(minimalTextChange(oldText, newText)).toEqual(expected)
  })

  it('supports bounded declarations, references, chains, separators and comments', () => {
    const source = '%% leading\r\nflowchart LR\r\nA[Alpha]-->B["Beta"] ; %% trailing\r\nA-->C\n'
    const parsed = analyseMermaidLabels(source)
    expect(parsed).toMatchObject({
      supported: true,
      labels: [
        { id: 'A', label: 'Alpha' },
        { id: 'B', label: 'Beta' },
      ],
    })
    if (!parsed.supported) throw new Error(parsed.reason)
    expect(parsed.labels.map(({ from, to }) => source.slice(from, to))).toEqual(['Alpha', 'Beta'])
  })

  it.each([
    ['unquoted', 'A[Alpha]', 'A', '] --> Injected[new]', '] --#62; Injected[new]'],
    ['quoted', 'A["Alpha"]', 'A', '] --> Injected[new]', '] --#62; Injected[new]'],
    [
      'punctuation',
      'A[Old]',
      'A',
      '`"\\!@#$%^&*()_+-={}[]|:;<>?,./~',
      '#96;#34;\\!@#$%^&amp;*()_+-={}[]|:;#60;#62;?,./~',
    ],
  ])('encodes edited %s labels without changing structure', (_name, graph, id, draft, encoded) => {
    const result = patchMermaidLabel(`flowchart TD\n${graph}`, id, draft)
    expect(result).toEqual({
      source: `flowchart TD\nA["${encoded}"]`,
    })
    if (!('source' in result)) throw new Error(result.error)
    expect(analyseMermaidLabels(result.source)).toMatchObject({
      supported: true,
      labels: [{ id, label: draft }],
    })
  })

  it('decodes numeric and named entities once and preserves no-op bytes', () => {
    const source = '%%before\r\nflowchart LR\r\nA[&#93;]-->B["#x1F680; &quot;"]\r\n%%after\r\n'
    const parsed = analyseMermaidLabels(source)
    expect(parsed).toMatchObject({
      supported: true,
      labels: [
        { id: 'A', label: ']' },
        { id: 'B', label: '🚀 "' },
      ],
    })
    expect(patchMermaidLabel(source, 'A', ']')).toEqual({ source })
    expect(patchMermaidLabel(source, 'B', '🚀 "')).toEqual({ source })
  })

  it('recognizes leading blank lines and decodes only prefixed entities, once', () => {
    expect(
      analyseMermaidLabels('\n\r\n %% comment\n graph TD\nA[clamp; &amp; #amp;]'),
    ).toMatchObject({
      supported: true,
      labels: [{ id: 'A', label: 'clamp; & &' }],
    })
    const result = patchMermaidLabel('graph TD\nA[Old]', 'A', 'literal &amp;')
    expect(result).toEqual({ source: 'graph TD\nA["literal &amp;amp;"]' })
    if (!('source' in result)) throw new Error(result.error)
    expect(analyseMermaidLabels(result.source)).toMatchObject({
      supported: true,
      labels: [{ id: 'A', label: 'literal &amp;' }],
    })
  })

  it('uses UTF-16 offsets for Unicode labels and preserves all other bytes', () => {
    const source = '%% 😀\r\nflowchart LR\r\nA[old]-->B[other] ; %%same\r\n'
    const result = patchMermaidLabel(source, 'A', '🌻新')
    expect(result).toEqual({ source: source.replace('old', '🌻新') })
    if (!('source' in result)) throw new Error(result.error)
    expect(analyseMermaidLabels(result.source)).toMatchObject({
      supported: true,
      labels: [
        { id: 'A', label: '🌻新' },
        { id: 'B', label: 'other' },
      ],
    })
  })

  it('rejects duplicate declarations and unsupported or ambiguous forms', () => {
    for (const source of [
      'flowchart LR\nA((circle))',
      'flowchart LR\nA[one]\nA[two]',
      'flowchart LR\nA[one]-->A[two]',
      'sequenceDiagram\nA->>B: hi',
      'flowchart LR\nA[one<br>two]',
      'flowchart LR\nA["<b>html</b>"]',
      'flowchart LR\nA[one]\nsubgraph X',
      'flowchart LR\nA[one] -- text --> B',
      'flowchart LR\nA[one]\n%%{init: {}}%%',
      'flowchart LR\nA[one]\nclick A callback',
      'flowchart LR\nA[one]\nB["**markdown**"]',
      'flowchart LR\nA[one\ntwo]',
      'flowchart LR\nA[one]\nflowchart TD',
      'flowchart XY\nA[one]',
      'flowchart LR A[one]',
    ])
      expect(analyseMermaidLabels(source).supported, source).toBe(false)
  })

  it('rejects blank, multiline and control-character drafts', () => {
    for (const label of ['  ', 'two\nlines', 'two\rlines', 'bad\u0001label']) {
      expect(patchMermaidLabel('graph TD\n A[Alpha]', 'A', label)).toMatchObject({
        error: expect.any(String),
      })
    }
  })
})
