/**
 * The large-file gate's pure core: which dirty paths commit, which are held back.
 * Pinned here so the size boundary and the deletions-always-commit rule can't
 * drift (docs/specs/2026-08-03-large-binary-policy-design.md).
 */
import { describe, expect, it } from 'vitest'
import { DEFAULT_MAX_COMMITTED_FILE_BYTES, partitionBySize } from '../src/main/vault/large-files'

describe('partitionBySize', () => {
  const THRESHOLD = 10_000
  const sizes: Record<string, number | null> = {
    'big.mp4': 20_000_000,
    'small.md': 100,
    'exactly.bin': THRESHOLD, // at the threshold, not over it
    'gone.md': null,
  }
  const sizeOf = (p: string) => sizes[p] ?? null

  it('holds back only files strictly over the threshold; deletions always commit', () => {
    const { commit, heldBack } = partitionBySize(
      ['big.mp4', 'small.md', 'exactly.bin', 'gone.md'],
      sizeOf,
      THRESHOLD,
    )
    // exactly-at-threshold commits (only strictly-over is held); a null size is a
    // deletion and always commits (it shrinks history, never grows it).
    expect(commit.sort()).toEqual(['exactly.bin', 'gone.md', 'small.md'])
    expect(heldBack).toEqual([{ path: 'big.mp4', bytes: 20_000_000 }])
  })

  it('returns two empty sets for no dirty paths', () => {
    expect(partitionBySize([], sizeOf, 10)).toEqual({ commit: [], heldBack: [] })
  })

  it('defaults the threshold to 10 MB', () => {
    expect(DEFAULT_MAX_COMMITTED_FILE_BYTES).toBe(10 * 1024 * 1024)
  })
})
