/**
 * Which documents a reconcile locks (`prd/vaults-sync.md` FR-19).
 *
 * The rule is narrow in two directions, and both matter: only a *live*
 * reconcile locks anything, and it locks only the files it is actually
 * resolving.
 */
import { describe, expect, it } from 'vitest'
import { isLockedForReconcile } from '../src/renderer/src/lib/reconcile-lock'

describe('isLockedForReconcile', () => {
  it('locks a file the reconcile is resolving', () => {
    const state = { kind: 'reconciling', paths: ['README.md'] } as const
    expect(isLockedForReconcile(state, 'README.md')).toBe(true)
  })

  it('leaves every other file in the vault editable', () => {
    // FR-19's second sentence. A reconcile is not a mode the vault enters; it
    // is a lock on the files that actually hold markers.
    const state = { kind: 'reconciling', paths: ['README.md'] } as const
    expect(isLockedForReconcile(state, 'notes/other.md')).toBe(false)
  })

  it('does not lock for a conflict banner over a clean tree', () => {
    // FR-17 is non-blocking: the merge was aborted, the files have no markers
    // in them, and the whole point of the banner is that you can ignore it and
    // keep working. Locking here would make a teammate's waiting change stop
    // yours.
    const state = { kind: 'conflict', paths: ['README.md'] } as const
    expect(isLockedForReconcile(state, 'README.md')).toBe(false)
  })
})
