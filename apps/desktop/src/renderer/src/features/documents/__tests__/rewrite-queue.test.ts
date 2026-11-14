import { describe, expect, it } from 'vitest'
import { Mapping, StepMap } from '@tiptap/pm/transform'
import { Schema } from '@tiptap/pm/model'

import { enqueueRewrite, mapRewriteTargets, removeRewrite, updateRewrite } from '../rewrite-queue'

const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: { content: 'text*', group: 'block' },
    text: { group: 'inline' },
  },
})
const doc = (text: string) =>
  schema.node('doc', null, [schema.node('paragraph', null, text ? schema.text(text) : [])])
const item = {
  from: 1,
  to: 4,
  blockFrom: 0,
  blockTo: 5,
  passage: 'one',
  blockType: 'paragraph',
  instruction: 'improve',
}

describe('rewrite request queue', () => {
  it('adds, edits and removes requests without sharing mutable state', () => {
    const first = enqueueRewrite([], item, 'a')
    expect(updateRewrite(first, 'a', { instruction: 'shorten' })[0]?.instruction).toBe('shorten')
    expect(removeRewrite(first, 'a')).toEqual([])
    expect(first).toHaveLength(1)
  })

  it('maps targets through edits before and inside the paragraph', () => {
    const queue = enqueueRewrite([], item, 'a')
    const before = new Mapping([new StepMap([0, 0, 2])])
    expect(mapRewriteTargets(queue, before, doc('x one')).at(0)).toMatchObject({
      from: 3,
      to: 6,
      valid: true,
    })
    const inside = new Mapping([new StepMap([2, 1, 2])])
    expect(mapRewriteTargets(queue, inside, doc('oXne')).at(0)).toMatchObject({ valid: true })
  })

  it('invalidates a target whose mapped range no longer identifies one text block', () => {
    const queue = enqueueRewrite([], item, 'a')
    const split = schema.node('doc', null, [
      schema.node('paragraph', null, schema.text('o')),
      schema.node('paragraph', null, schema.text('ne')),
    ])
    expect(mapRewriteTargets(queue, new Mapping(), split)[0]?.valid).toBe(false)
  })

  it('invalidates deleted and merged targets and stays invalid across later edits', () => {
    const queue = enqueueRewrite([], item, 'a')
    const deleted = mapRewriteTargets(queue, new Mapping([new StepMap([1, 3, 0])]), doc(''))
    expect(deleted[0]?.valid).toBe(false)

    const merged = schema.node('doc', null, [
      schema.node('paragraph', null, schema.text('one two')),
    ])
    const mergedTarget = mapRewriteTargets(queue, new Mapping(), merged)
    expect(mergedTarget[0]?.valid).toBe(false)
    expect(updateRewrite(mergedTarget, 'a', { instruction: 'new request' })[0]?.valid).toBe(false)
    expect(mapRewriteTargets(mergedTarget, new Mapping(), doc('one two'))[0]?.valid).toBe(false)
  })

  it('invalidates targets on an external reload instead of guessing among duplicates', () => {
    const queue = enqueueRewrite([], item, 'a')
    const remainingDuplicate = doc('one')
    expect(mapRewriteTargets(queue, new Mapping(), remainingDuplicate, true)[0]).toMatchObject({
      valid: false,
      from: item.from,
      to: item.to,
    })
  })
})
