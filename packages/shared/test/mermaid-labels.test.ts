import { describe, expect, it } from 'vitest'
import { analyseMermaidLabels, patchMermaidLabel } from '../src/mermaid-labels'

describe('Mermaid label source edits', () => {
  it('supports the bounded flowchart grammar and patches only the label token', () => {
    const source = 'flowchart LR\n%% note\n A[Alpha] --> B["Beta"] ;\n'
    const parsed = analyseMermaidLabels(source)
    expect(parsed).toMatchObject({
      supported: true,
      labels: [
        { id: 'A', label: 'Alpha' },
        { id: 'B', label: 'Beta' },
      ],
    })
    const patched = patchMermaidLabel(source, 'B', 'Changed & # " < >')
    expect(patched).toEqual({
      source: source.replace('Beta', 'Changed #amp; #35; #quot; #lt; #gt;'),
    })
    if (!('source' in patched)) throw new Error(patched.error)
    expect(patchMermaidLabel(patched.source, 'B', 'Changed & # " < >')).toEqual(patched)
  })

  it('fails closed for unsupported syntax and duplicate declarations', () => {
    for (const source of [
      'flowchart LR\nA((circle))',
      'flowchart LR\nA[one]\nA[two]',
      'sequenceDiagram\nA->>B: hi',
      'flowchart LR\nA[one<br>two]',
    ]) {
      expect(analyseMermaidLabels(source).supported).toBe(false)
    }
  })

  it('rejects blank and multiline labels', () => {
    expect(patchMermaidLabel('graph TD\n A[Alpha]', 'A', '  ')).toMatchObject({
      error: expect.any(String),
    })
    expect(patchMermaidLabel('graph TD\n A[Alpha]', 'A', 'two\nlines')).toMatchObject({
      error: expect.any(String),
    })
  })
})
