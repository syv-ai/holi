import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { applyAgentTurn } from '../src/merge'

function seededDoc(text: string): Y.Doc {
  const doc = new Y.Doc()
  doc.getText('content').insert(0, text)
  return doc
}
const snap = (doc: Y.Doc) => Y.encodeStateAsUpdate(doc)
const read = (doc: Y.Doc) => doc.getText('content').toString()

describe('applyAgentTurn (frozen base → positioned ops onto live doc)', () => {
  it('full rewrite with no remote edits lands verbatim', () => {
    const live = seededDoc('hello world\n')
    const base = snap(live)
    applyAgentTurn(live, base, 'goodbye world\n')
    expect(read(live)).toBe('goodbye world\n')
  })

  it('no-op turn leaves the doc state untouched', () => {
    const live = seededDoc('same\n')
    const base = snap(live)
    const svBefore = Y.encodeStateVector(live)
    applyAgentTurn(live, base, 'same\n')
    expect(Y.encodeStateVector(live)).toEqual(svBefore)
  })

  it('(a) non-overlapping human and agent edits both survive', () => {
    const live = seededDoc('# Title\n\nalpha\n\nomega\n')
    const base = snap(live)
    // remote (human) edit lands after the freeze:
    live.getText('content').insert('# Title\n\nalpha'.length, ' (human)')
    // agent edited the frozen file:
    applyAgentTurn(live, base, '# Title\n\nalpha\n\nomega (agent)\n')
    expect(read(live)).toBe('# Title\n\nalpha (human)\n\nomega (agent)\n')
  })

  it('(c) remote insert inside an agent-deleted region survives the delete', () => {
    const live = seededDoc('keep DELETE-ME keep\n')
    const base = snap(live)
    live.getText('content').insert('keep DELETE'.length, '[remote]')
    applyAgentTurn(live, base, 'keep keep\n') // agent removed 'DELETE-ME '
    expect(read(live)).toBe('keep [remote]keep\n')
  })

  it('(b) overlapping same-range rewrites converge without corrupting surroundings', () => {
    const live = seededDoc('start MIDDLE end\n')
    const base = snap(live)
    const text = live.getText('content')
    live.transact(() => {
      text.delete('start '.length, 'MIDDLE'.length)
      text.insert('start '.length, 'HUMAN')
    })
    applyAgentTurn(live, base, 'start AGENT end\n')
    const out = read(live)
    // Yjs semantics: both concurrent inserts survive side by side; surroundings intact.
    expect(out).toMatch(/^start .+ end\n$/)
    expect(out).toContain('HUMAN')
    expect(out).toContain('AGENT')
    expect(out).not.toContain('MIDDLE')
    console.log('[spike] overlap merge result:', JSON.stringify(out))
  })

  it('multiple scattered edits in one turn all land at the right positions', () => {
    const live = seededDoc('L1 aaa\nL2 bbb\nL3 ccc\nL4 ddd\n')
    const base = snap(live)
    live.getText('content').insert('L1 aaa\nL2 bbb'.length, ' [h]')
    applyAgentTurn(live, base, 'L1 AAA\nL2 bbb\nL3 ccc\nL4 DDD\nL5 eee\n')
    expect(read(live)).toBe('L1 AAA\nL2 bbb [h]\nL3 ccc\nL4 DDD\nL5 eee\n')
  })
})
