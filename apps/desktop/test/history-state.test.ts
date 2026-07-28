/**
 * The version timeline's pure half. Node env, no jotai store, no React — the atoms are
 * just where these live.
 */
import { describe, expect, it } from 'vitest'
import { partitionVersions, versionLabel, type Version } from '../src/renderer/src/state/history'

const v = (over: Partial<Version> = {}): Version => ({
  sha: 'abc1234',
  subject: 'Update note.md',
  date: '2026-07-16T10:42:00.000Z',
  author: 'nicolai',
  ...over,
})

describe('partitionVersions', () => {
  // Autosave commits are `Update …`; everything else is a landmark (prd §History).
  it('folds the autosave run and surfaces the landmarks', () => {
    const rows = [
      v({ sha: 'a', subject: 'Reconcile conflicts' }),
      v({ sha: 'b', subject: 'Update note.md' }),
      v({ sha: 'c', subject: 'Update 3 files' }),
      v({ sha: 'd', subject: 'Draft Q2 plan' }), // a deliberately-authored / agent commit
    ]
    const { landmarks, automatic } = partitionVersions(rows)
    expect(landmarks.map((x) => x.sha)).toEqual(['a', 'd'])
    expect(automatic.map((x) => x.sha)).toEqual(['b', 'c'])
  })

  it('treats a merge commit as a landmark', () => {
    const { landmarks } = partitionVersions([v({ subject: "Merge branch 'main'" })])
    expect(landmarks).toHaveLength(1)
  })

  it('preserves the log ordering (newest-first) within each group', () => {
    const rows = [v({ sha: 'newest' }), v({ sha: 'oldest' })]
    expect(partitionVersions(rows).automatic.map((x) => x.sha)).toEqual(['newest', 'oldest'])
  })

  it('handles an empty timeline', () => {
    expect(partitionVersions([])).toEqual({ landmarks: [], automatic: [] })
  })
})

describe('versionLabel', () => {
  it('is the commit subject', () => {
    expect(versionLabel(v({ subject: 'Draft Q2 plan' }))).toBe('Draft Q2 plan')
  })

  it('never renders empty — a subjectless commit still names something', () => {
    expect(versionLabel(v({ subject: '' }))).toBe('version')
    expect(versionLabel(v({ subject: '   ' }))).toBe('version')
  })
})
