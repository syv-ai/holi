/**
 * FR-21's vocabulary, and nothing beyond it.
 *
 * The words are fixed by the requirement: up to date, N to publish, pulling,
 * offline, conflict, reconciling — plus `publishing` and `paused`, which plan 4
 * added and its doc justifies. A test per kind, because the failure mode here
 * is not a crash, it is a vault confidently reporting the wrong thing.
 */
import { describe, expect, it } from 'vitest'
import { syncLabel } from '../src/renderer/src/lib/sync-label'

describe('syncLabel', () => {
  it('says up to date when there is nothing to do', () => {
    expect(syncLabel({ kind: 'up-to-date' })).toEqual({ text: 'up to date', tone: 'quiet' })
  })

  it('counts what is waiting to publish', () => {
    // FR-13: the control shows how many commits are waiting, and nothing else
    // is asked of the user.
    expect(syncLabel({ kind: 'ahead', count: 3 })).toEqual({ text: '3 to publish', tone: 'quiet' })
  })

  it('does not say "1 to publishs"', () => {
    expect(syncLabel({ kind: 'ahead', count: 1 }).text).toBe('1 to publish')
  })

  it('distinguishes pulling from publishing', () => {
    // Calling a publish "pulling" would be a lie at the moment it matters most:
    // a publish is the one thing that leaves the machine.
    expect(syncLabel({ kind: 'pulling' })).toEqual({ text: 'pulling', tone: 'busy' })
    expect(syncLabel({ kind: 'publishing' })).toEqual({ text: 'publishing', tone: 'busy' })
  })

  it('warns on offline, conflict and reconciling', () => {
    expect(syncLabel({ kind: 'offline' })).toEqual({ text: 'offline', tone: 'warn' })
    expect(syncLabel({ kind: 'reconciling' })).toEqual({ text: 'reconciling', tone: 'warn' })
    expect(syncLabel({ kind: 'conflict', paths: ['a.md', 'b.md'] })).toEqual({
      text: '2 files conflict',
      tone: 'warn',
    })
  })

  it('renders a pause with the reason main wrote', () => {
    // Main writes these as whole sentences — "on spike/idea, not main — sync
    // paused" — because only main knows why. Prefixing or re-wording it here
    // would produce "paused: on spike/idea, not main — sync paused".
    expect(syncLabel({ kind: 'paused', reason: 'on spike/idea, not main — sync paused' })).toEqual({
      text: 'on spike/idea, not main — sync paused',
      tone: 'warn',
    })
  })
})
