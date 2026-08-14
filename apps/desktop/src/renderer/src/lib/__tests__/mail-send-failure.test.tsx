/**
 * Why a send failed, and what the user can do (D71).
 *
 * The action is the point. A message alone leaves the reader with an apology;
 * only some failures have a fix the user can perform, and offering a Retry for
 * the ones that do not is worse than offering nothing — the failure mode of a
 * send is a duplicate arriving at a real person.
 */
import { describe, expect, it } from 'vitest'
import { describeSendFailure } from '../mail-send-failure'

/** An error as `ipcLink` rebuilds it: main's verdict on `err.data.code`. */
function withCode(code: string): Error {
  return Object.assign(new Error('something Google said'), { data: { code } })
}

describe('describeSendFailure', () => {
  it('routes a missing scope to Reconnect', () => {
    expect(describeSendFailure(withCode('FORBIDDEN')).action).toBe('reconnect')
  })

  it('routes a lost connection to Reconnect', () => {
    expect(describeSendFailure(withCode('UNAUTHORIZED')).action).toBe('reconnect')
    expect(describeSendFailure(withCode('PRECONDITION_FAILED')).action).toBe('reconnect')
  })

  it('offers Retry only for a rate limit', () => {
    expect(describeSendFailure(withCode('TOO_MANY_REQUESTS')).action).toBe('retry')
  })

  it('offers no action for a failure nobody has diagnosed', () => {
    // Deliberately not `retry`. A one-click retry on an unexplained failure is
    // how a real person receives the same email twice.
    expect(describeSendFailure(withCode('INTERNAL_SERVER_ERROR')).action).toBeNull()
    expect(describeSendFailure(new Error('boom')).action).toBeNull()
  })

  it('falls back to the message when the code was lost in transit', () => {
    // An error can still arrive from somewhere that never had a code, and
    // "the code was lost" should degrade to the old answer.
    expect(describeSendFailure(new Error('insufficient permission')).action).toBe('reconnect')
    expect(describeSendFailure(new Error('rate limit reached')).action).toBe('retry')
  })

  it('says the message survived, when it has nothing else to say', () => {
    const failure = describeSendFailure({})

    expect(failure.message).toMatch(/still here/i)
    expect(failure.action).toBeNull()
  })

  it('prefers the code over the prose', () => {
    // Matching on Google's sentences made the wording in `google/api.ts`
    // load-bearing UI behaviour with no test between the two.
    const misleading = Object.assign(new Error('rate limit'), { data: { code: 'FORBIDDEN' } })

    expect(describeSendFailure(misleading).action).toBe('reconnect')
  })
})
