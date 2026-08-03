/**
 * The sign-out dialog's unpushed-work warning (FR-15 / auth-identity Open-Q3).
 * Pure so the exact wording — the thing standing between a user and deleting a
 * clone that still holds unpublished commits — is pinned here, not in a
 * screenshot.
 */
import { describe, expect, it } from 'vitest'
import { unpushedWarning } from '../src/renderer/src/lib/unpushed-warning'

describe('unpushedWarning', () => {
  it('is null when nothing is ahead (no warning to show)', () => {
    expect(unpushedWarning([])).toBeNull()
  })

  it('names the single vault and its commit count, singular at one', () => {
    expect(unpushedWarning([{ remote: 'acme/notes', ahead: 1 }])).toBe(
      'acme/notes has 1 unpushed commit',
    )
    expect(unpushedWarning([{ remote: 'acme/notes', ahead: 3 }])).toBe(
      'acme/notes has 3 unpushed commits',
    )
  })

  it('summarises count and total across multiple vaults', () => {
    expect(
      unpushedWarning([
        { remote: 'acme/notes', ahead: 2 },
        { remote: 'acme/plans', ahead: 5 },
      ]),
    ).toBe('2 vaults have unpushed commits (7 total)')
  })
})
