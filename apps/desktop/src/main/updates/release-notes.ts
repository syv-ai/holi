/**
 * A Holi release's notes, read from its GitHub release (docs/features/updates.md).
 *
 * The release is the feed, so it is also where the notes are: CI publishes
 * each version as `v<version>` with GitHub's generated notes. Read through
 * GitHub's public API rather than from `electron-updater`, which hands over
 * only the version it found, as HTML, and nothing for the running one. One
 * source answers both, as the Markdown it was written in.
 *
 * Plain Node (an injected `fetch`), so it runs under test.
 */

/** Where releases are published: `publish` in `electron-builder.yml`. */
const RELEASES_REPO = 'syv-ai/holi'

interface ReleaseNotes {
  version: string
  /** The release's title, as published. */
  name: string
  /** Its notes, as Markdown; empty when it has none. */
  body: string
  /** Its page on GitHub. */
  url: string
}

/** What asking for a release's notes found: them, no release by that tag (a
 *  local build), or no answer from GitHub (offline, rate-limited, down). */
export type ReleaseNotesAnswer =
  { kind: 'found'; notes: ReleaseNotes } | { kind: 'none' } | { kind: 'unreachable' }

/** A version as it can appear in a tag: semver, prerelease included. */
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/

export const isReleaseVersion = (version: string): boolean => VERSION.test(version)

/** A release's page, from the tag CI publishes rather than from the answer. */
const releaseUrl = (version: string): string =>
  `https://github.com/${RELEASES_REPO}/releases/tag/v${version}`

/**
 * Notes per version, fetched once each. A version with no release answers
 * `none`, remembered; a request that failed answers `unreachable` and is asked
 * again next time.
 */
export function createReleaseNotes(deps: {
  fetch: (url: string, init: { headers: Record<string, string> }) => Promise<Response>
}): (version: string) => Promise<ReleaseNotesAnswer> {
  const known = new Map<string, ReleaseNotesAnswer>()
  return async (version) => {
    if (!isReleaseVersion(version)) return { kind: 'none' }
    const was = known.get(version)
    if (was !== undefined) return was
    let raw: { name?: unknown; body?: unknown } | null
    try {
      const response = await deps.fetch(
        `https://api.github.com/repos/${RELEASES_REPO}/releases/tags/v${version}`,
        { headers: { Accept: 'application/vnd.github+json' } },
      )
      if (response.status === 404) {
        known.set(version, { kind: 'none' })
        return { kind: 'none' }
      }
      if (!response.ok) return { kind: 'unreachable' }
      raw = (await response.json()) as { name?: unknown; body?: unknown } | null
    } catch {
      return { kind: 'unreachable' }
    }
    const answer: ReleaseNotesAnswer = {
      kind: 'found',
      notes: {
        version,
        name: typeof raw?.name === 'string' && raw.name !== '' ? raw.name : `Holi ${version}`,
        body: typeof raw?.body === 'string' ? raw.body.trim() : '',
        url: releaseUrl(version),
      },
    }
    known.set(version, answer)
    return answer
  }
}
