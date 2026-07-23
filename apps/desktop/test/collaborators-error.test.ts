/**
 * Which refusal produced an empty collaborator list, and what the panel says
 * about it. Pure, so the branch that actually shipped wrong — a 404 on a vault
 * that is not on GitHub, reported as a sign-in problem — is pinned here rather
 * than only in a screenshot.
 */
import { describe, expect, it } from 'vitest'
import {
  collaboratorsErrorText,
  errorCodeOf,
} from '../src/renderer/src/lib/collaborators-error'

describe('collaboratorsErrorText', () => {
  it('blames the repo, not the sign-in, on a 404', () => {
    const text = collaboratorsErrorText('NOT_FOUND', 'local/notes')
    expect(text).toContain('local/notes')
    expect(text).not.toMatch(/sign in/i)
  })

  it('asks for a sign-in only when the user is actually signed out', () => {
    expect(collaboratorsErrorText('UNAUTHORIZED', 'syv-ai/holi')).toMatch(/sign in/i)
  })

  it('distinguishes no-access from signed-out', () => {
    const text = collaboratorsErrorText('FORBIDDEN', 'syv-ai/holi')
    expect(text).toMatch(/access|read/i)
    expect(text).not.toMatch(/sign in/i)
  })

  it('names the rate limit as temporary', () => {
    expect(collaboratorsErrorText('TOO_MANY_REQUESTS', 'syv-ai/holi')).toMatch(/rate limit/i)
  })

  it('falls back to a bare statement for a code it has no advice for', () => {
    const text = collaboratorsErrorText('INTERNAL_SERVER_ERROR', 'syv-ai/holi')
    expect(text).toBe("Can't load collaborators.")
    // The same sentence covers "no code at all" — a renderer bug, not a refusal.
    expect(collaboratorsErrorText(undefined, 'syv-ai/holi')).toBe(text)
  })
})

describe('errorCodeOf', () => {
  it('reads the code tRPC hangs on the error', () => {
    expect(errorCodeOf({ data: { code: 'NOT_FOUND' } })).toBe('NOT_FOUND')
  })

  it('is undefined for anything that is not a coded refusal', () => {
    expect(errorCodeOf(new Error('boom'))).toBeUndefined()
    expect(errorCodeOf({ data: {} })).toBeUndefined()
    expect(errorCodeOf(null)).toBeUndefined()
    expect(errorCodeOf(undefined)).toBeUndefined()
  })
})
