/**
 * The version timeline's pure half. Node env, no jotai store, no React — the atoms are
 * just where these live.
 */
import { describe, expect, it } from 'vitest'
import { partitionSnapshots, snapshotLabel, type Snapshot } from '../src/renderer/src/state/history'

const snap = (over: Partial<Snapshot> = {}): Snapshot => ({
  id: 's1',
  takenAt: '2026-07-16T10:42:00.000Z',
  reason: 'interval',
  label: null,
  authorId: null,
  ...over,
})

describe('partitionSnapshots (D54)', () => {
  it('keeps the milestones and folds the automatic ones away', () => {
    const rows = [
      snap({ id: 'a', reason: 'pre-agent-write', label: 'before Claude edited' }),
      snap({ id: 'b', reason: 'interval', label: null }),
      snap({ id: 'c', reason: 'interval', label: null }),
      snap({ id: 'd', reason: 'pre-rename', label: 'before [[a]] → [[b]]' }),
    ]
    const { milestones, automatic } = partitionSnapshots(rows)
    expect(milestones.map((s) => s.id)).toEqual(['a', 'd'])
    expect(automatic.map((s) => s.id)).toEqual(['b', 'c'])
  })

  // The snapshot the whole feature exists to surface must never be the thing that gets
  // buried — that would be the same failure as having no UI at all.
  it('never folds a pre-agent-write snapshot', () => {
    const { milestones } = partitionSnapshots([snap({ reason: 'pre-agent-write', label: 'before Claude edited' })])
    expect(milestones).toHaveLength(1)
  })

  it('keeps a pre-restore snapshot visible — it is the undo of a restore', () => {
    const { milestones } = partitionSnapshots([
      snap({ reason: 'pre-restore', label: 'before restoring an older version' }),
    ])
    expect(milestones).toHaveLength(1)
  })

  // Splitting on `label === null` would be a coincidence that holds today: every writer
  // except `interval` happens to set one. `reason` is what actually says "automatic".
  it('splits on reason, not on a missing label', () => {
    const { milestones, automatic } = partitionSnapshots([snap({ reason: 'manual', label: null })])
    expect(milestones).toHaveLength(1)
    expect(automatic).toHaveLength(0)
  })

  it('preserves the server ordering within each group', () => {
    const rows = [
      snap({ id: 'newest', takenAt: '2026-07-16T12:00:00.000Z' }),
      snap({ id: 'oldest', takenAt: '2026-07-16T08:00:00.000Z' }),
    ]
    expect(partitionSnapshots(rows).automatic.map((s) => s.id)).toEqual(['newest', 'oldest'])
  })

  it('handles an empty timeline', () => {
    expect(partitionSnapshots([])).toEqual({ milestones: [], automatic: [] })
  })
})

describe('snapshotLabel', () => {
  it('uses the label when there is one', () => {
    expect(snapshotLabel(snap({ label: 'before Claude edited' }))).toBe('before Claude edited')
  })

  it('names an unlabelled interval snapshot rather than rendering nothing', () => {
    expect(snapshotLabel(snap({ reason: 'interval', label: null }))).toBe('automatic version')
  })

  // `label` and `reason` are both nullable columns, and four SnapshotReason values have
  // no writer at all — so a reason this function has never seen is not impossible, and
  // must not reach a user as "null".
  it('never renders null, whatever the row holds', () => {
    expect(snapshotLabel(snap({ reason: null, label: null }))).toBe('automatic version')
    expect(snapshotLabel(snap({ reason: 'pre-git-ingest', label: null }))).toBe('pre-git-ingest')
  })
})
