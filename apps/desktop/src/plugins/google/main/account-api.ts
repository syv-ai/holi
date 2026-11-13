import { GoogleApi } from './api'
import type { GoogleSession } from './session'

/** Resolve the replaceable session for an account whenever a cached client is made. */
export function accountApi(sub: string, sessionForSub: (sub: string) => GoogleSession | null) {
  return () => {
    const session = sessionForSub(sub)
    if (session === null) throw new Error('that Google account is no longer connected')
    return new GoogleApi({ accessToken: () => session.getAccessToken() })
  }
}
