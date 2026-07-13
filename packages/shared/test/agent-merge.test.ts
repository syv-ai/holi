import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { applyAgentTurn, BRIDGE_ORIGIN, YDOC_TEXT_KEY } from '../src'

function seededDoc(text: string): Y.Doc {
  const doc = new Y.Doc()
  doc.getText(YDOC_TEXT_KEY).insert(0, text)
  return doc
}
const snap = (doc: Y.Doc) => Y.encodeStateAsUpdate(doc)
const read = (doc: Y.Doc) => doc.getText(YDOC_TEXT_KEY).toString()

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
    live.getText(YDOC_TEXT_KEY).insert('# Title\n\nalpha'.length, ' (human)')
    applyAgentTurn(live, base, '# Title\n\nalpha\n\nomega (agent)\n')
    expect(read(live)).toBe('# Title\n\nalpha (human)\n\nomega (agent)\n')
  })

  it('(c) remote insert inside an agent-deleted region survives the delete', () => {
    const live = seededDoc('keep DELETE-ME keep\n')
    const base = snap(live)
    live.getText(YDOC_TEXT_KEY).insert('keep DELETE'.length, '[remote]')
    applyAgentTurn(live, base, 'keep keep\n')
    expect(read(live)).toBe('keep [remote]keep\n')
  })

  it('(b) overlapping same-range rewrites converge without corrupting surroundings', () => {
    const live = seededDoc('start MIDDLE end\n')
    const base = snap(live)
    const text = live.getText(YDOC_TEXT_KEY)
    live.transact(() => {
      text.delete('start '.length, 'MIDDLE'.length)
      text.insert('start '.length, 'HUMAN')
    })
    applyAgentTurn(live, base, 'start AGENT end\n')
    const out = read(live)
    expect(out).toMatch(/^start .+ end\n$/)
    expect(out).toContain('HUMAN')
    expect(out).toContain('AGENT')
    expect(out).not.toContain('MIDDLE')
  })

  it('multiple scattered edits in one turn all land at the right positions', () => {
    const live = seededDoc('L1 aaa\nL2 bbb\nL3 ccc\nL4 ddd\n')
    const base = snap(live)
    live.getText(YDOC_TEXT_KEY).insert('L1 aaa\nL2 bbb'.length, ' [h]')
    applyAgentTurn(live, base, 'L1 AAA\nL2 bbb\nL3 ccc\nL4 DDD\nL5 eee\n')
    expect(read(live)).toBe('L1 AAA\nL2 bbb [h]\nL3 ccc\nL4 DDD\nL5 eee\n')
  })

  it('returns the agent-lineage state (base + agent ops, without remote edits)', () => {
    const live = seededDoc('one\ntwo\n')
    const base = snap(live)
    live.getText(YDOC_TEXT_KEY).insert(0, 'REMOTE ')
    const { agentState } = applyAgentTurn(live, base, 'one\ntwo\nthree\n')
    const lineage = new Y.Doc()
    Y.applyUpdate(lineage, agentState)
    expect(lineage.getText(YDOC_TEXT_KEY).toString()).toBe('one\ntwo\nthree\n')
  })

  it('applies the merge with BRIDGE_ORIGIN so bridges can filter their own echo', () => {
    const live = seededDoc('x\n')
    const base = snap(live)
    let seenOrigin: unknown = 'unset'
    live.on('update', (_u: Uint8Array, origin: unknown) => (seenOrigin = origin))
    applyAgentTurn(live, base, 'y\n')
    expect(seenOrigin).toBe(BRIDGE_ORIGIN)
  })
})

describe('isLocalOnlyPath (shared)', () => {
  it('matches *.local.* basenames, USER.md at root, and nothing else', async () => {
    const { isLocalOnlyPath } = await import('../src')
    expect(isLocalOnlyPath('.holi/settings.local.json')).toBe(true)
    expect(isLocalOnlyPath('CLAUDE.local.md')).toBe(true)
    expect(isLocalOnlyPath('.holi/context.local.json')).toBe(true)
    expect(isLocalOnlyPath('USER.md')).toBe(true)
    expect(isLocalOnlyPath('notes/USER.md')).toBe(false)
    expect(isLocalOnlyPath('notes/a.md')).toBe(false)
    expect(isLocalOnlyPath('.claude/settings.json')).toBe(false)
  })
})
