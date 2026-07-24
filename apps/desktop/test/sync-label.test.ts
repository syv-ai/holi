/**
 * FR-21's vocabulary, and nothing beyond it.
 *
 * Push is automatic (`prd/vaults-sync.md` §Pushing), so there is no "N to
 * publish" and no `publishing`: the words are up to date, pulling, offline
 * (with the waiting count), no write access, conflict, reconciling, paused. A
 * test per kind, because the failure mode here is not a crash, it is a vault
 * confidently reporting the wrong thing.
 */
import { describe, expect, it } from 'vitest'
import { syncLabel } from '../src/renderer/src/lib/sync-label'

describe('syncLabel', () => {
  it('says up to date when there is nothing to do', () => {
    expect(syncLabel({ kind: 'up-to-date' })).toEqual({ text: 'up to date', tone: 'quiet' })
  })

  it('names how much is waiting when offline', () => {
    // The count matters only when a push is failing: online, unpushed commits
    // are a transient nobody needs to see.
    expect(syncLabel({ kind: 'offline', count: 3 })).toEqual({
      text: 'offline — 3 waiting',
      tone: 'warn',
    })
  })

  it('drops the count when offline with nothing waiting', () => {
    expect(syncLabel({ kind: 'offline', count: 0 })).toEqual({ text: 'offline', tone: 'warn' })
  })

  it('reports a permission refusal as its own thing, not offline (FR-16)', () => {
    expect(syncLabel({ kind: 'no-access' })).toEqual({ text: 'no write access', tone: 'warn' })
  })

  it('says pulling while a fetch-and-merge runs', () => {
    expect(syncLabel({ kind: 'pulling' })).toEqual({ text: 'pulling', tone: 'busy' })
  })

  it('warns on conflict and reconciling', () => {
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
