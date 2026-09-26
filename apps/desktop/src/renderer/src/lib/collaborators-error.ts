/**
 * Why the collaborator list is missing, in words the user can act on.
 *
 * One catch-all ("sign in") would blame the user's sign-in for, say, a 404 on
 * a vault not backed by GitHub. The codes come from `TRPC_CODE` in main's
 * router and arrive on `err.data.code` (see `ipcLink`).
 */
export function collaboratorsErrorText(code: string | undefined, remote: string): string {
  switch (code) {
    case 'NOT_FOUND':
      // Both readings: GitHub answers a missing repo and an invisible private
      // one with the same 404.
      return `No repo at github.com/${remote} — this vault isn't backed by GitHub, or your account can't see it.`
    case 'UNAUTHORIZED':
      return 'Sign in to GitHub to see who has access.'
    case 'FORBIDDEN':
      // Covers SAML too (main puts the SSO URL in the tooltip's message), so
      // do not claim plain lack of access.
      return "Your GitHub account can't read this repo's collaborators."
    case 'TOO_MANY_REQUESTS':
      return 'GitHub rate limit reached — this will load again shortly.'
    default:
      // No advice to give; the raw message is in the tooltip.
      return "Can't load collaborators."
  }
}

/** The `code` main sent, if any. Narrowed: a plain `Error` has no `data`. */
export function errorCodeOf(err: unknown): string | undefined {
  const data = (err as { data?: unknown })?.data
  const code = (data as { code?: unknown } | undefined)?.code
  return typeof code === 'string' ? code : undefined
}
