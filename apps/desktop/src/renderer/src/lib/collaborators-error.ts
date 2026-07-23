/**
 * Why the collaborator list is missing, in words the user can act on.
 *
 * The panel used to render one catch-all — *"sign in to GitHub with access to
 * this repo"* — for every refusal, which is wrong far more often than it is
 * right. A vault whose origin is a local path (a test fixture) has no repo at
 * `github.com/<remote>` at all, so GitHub answers 404; blaming the user's
 * sign-in for that sends them to fix something that was never broken, and it is
 * flatly contradicted by the org vault two clicks away that lists its members
 * fine.
 *
 * The codes come from `TRPC_CODE` in main's router, which maps GitHub's own
 * refusal kinds. They arrive on `err.data.code` — see `ipcLink`, which had been
 * dropping them, and is the reason this could only ever have been a catch-all
 * before.
 */
export function collaboratorsErrorText(code: string | undefined, remote: string): string {
  switch (code) {
    case 'NOT_FOUND':
      // Deliberately two possibilities in one sentence: from here the 404 for a
      // repo that does not exist and the 404 GitHub returns for a private repo
      // you cannot see are the same response, and claiming either one alone
      // would be a guess.
      return `No repo at github.com/${remote} — this vault isn't backed by GitHub, or your account can't see it.`
    case 'UNAUTHORIZED':
      // The one case the old copy actually described.
      return 'Sign in to GitHub to see who has access.'
    case 'FORBIDDEN':
      // Covers SAML too: main appends the SSO URL to the message, which stays
      // in the tooltip, so the sentence must not claim plain lack of access is
      // the only reading.
      return "Your GitHub account can't read this repo's collaborators."
    case 'TOO_MANY_REQUESTS':
      return 'GitHub rate limit reached — this will load again shortly.'
    default:
      // No code, or one this panel has no advice for. Says what happened and
      // nothing more; the raw message is in the tooltip.
      return "Can't load collaborators."
  }
}

/** The `code` main sent, if it survived the trip. Narrow rather than a cast:
 *  a plain `Error` (a bug in the renderer, say) has no `data` at all. */
export function errorCodeOf(err: unknown): string | undefined {
  const data = (err as { data?: unknown })?.data
  const code = (data as { code?: unknown } | undefined)?.code
  return typeof code === 'string' ? code : undefined
}
