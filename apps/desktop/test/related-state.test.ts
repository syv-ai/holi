/**
 * `related[]` resolution — the record stores stable ids (D27), so naming a relation is a
 * client-side join. Pure, tested directly.
 *
 * This is also where D27's **tombstone** finally lands: deleting a note does not cascade,
 * so a ref to it survives on purpose and must render as such rather than vanish or, worse,
 * render as `undefined`.
 */
import { describe, expect, it } from 'vitest'
import { resolveRelated } from '../src/renderer/src/state/tasks'
import type { DocMeta, RelatedRef, Task } from '@holi/shared'

const doc = (id: string, path: string) => ({ id, path }) as DocMeta
const task = (id: string, title: string) => ({ id, title }) as Task
const tasksMap = (...ts: Task[]) => new Map(ts.map((t) => [t.id, t]))
const ref = (kind: RelatedRef['kind'], id: string): RelatedRef => ({ kind, id })

describe('resolveRelated', () => {
  it('names a note by its current path — the record never stores one', () => {
    const [r] = resolveRelated([ref('note', 'd1')], [doc('d1', 'projects/plan.md')], tasksMap())
    expect(r).toEqual({ kind: 'note', id: 'd1', label: 'projects/plan.md', missing: false })
  })

  it('names a task by its title', () => {
    const [r] = resolveRelated([ref('task', 't1')], [], tasksMap(task('t1', 'Ship the thing')))
    expect(r).toEqual({ kind: 'task', id: 't1', label: 'Ship the thing', missing: false })
  })

  // D27: no cascade. The ref outlives the note ON PURPOSE — dropping it would silently
  // delete the link on the next inbound file write (see refToFile's tombstone).
  it('renders a deleted note as a tombstone, not as nothing', () => {
    const [r] = resolveRelated([ref('note', 'gone')], [doc('d1', 'a.md')], tasksMap())
    expect(r).toEqual({ kind: 'note', id: 'gone', label: '[deleted note]', missing: true })
  })

  it('renders a deleted task as a tombstone too', () => {
    const [r] = resolveRelated([ref('task', 'gone')], [], tasksMap(task('t1', 'Alive')))
    expect(r).toEqual({ kind: 'task', id: 'gone', label: '[deleted task]', missing: true })
  })

  it('keeps every ref, in order — resolution never drops one', () => {
    const rs = resolveRelated(
      [ref('note', 'gone'), ref('note', 'd1'), ref('task', 't1')],
      [doc('d1', 'a.md')],
      tasksMap(task('t1', 'T')),
    )
    expect(rs.map((r) => r.label)).toEqual(['[deleted note]', 'a.md', 'T'])
  })

  // email/event are representable in the model but have no source to resolve against
  // (Gmail/Calendar are phase 2). "Missing" would be a lie — we cannot look, so we do not
  // claim it is gone.
  it('does not call an unresolvable kind deleted — it just shows what it has', () => {
    const [r] = resolveRelated([ref('email', 'msg-1')], [], tasksMap())
    expect(r).toEqual({ kind: 'email', id: 'msg-1', label: 'msg-1', missing: false })
  })

  it('handles a task with no relations', () => {
    expect(resolveRelated([], [doc('d1', 'a.md')], tasksMap())).toEqual([])
  })
})
