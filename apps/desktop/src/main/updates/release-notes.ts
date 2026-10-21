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
export const RELEASES_REPO = 'syv-ai/holi'

export interface ReleaseNotes {
  version: string
  /** The release's title, as published. */
  name: string
  /** Its notes, as Markdown; empty when it has none. */
  body: string
  /** Its page on GitHub. */
  url: string
}

/** A version as it can appear in a tag: semver, prerelease included. */
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/

export const isReleaseVersion = (version: string): boolean => VERSION.test(version)

/**
 * Notes per version, fetched once each. A version with no release (a local
 * build) or a failed request answers null, and a failure is asked again next
 * time rather than remembered.
 */
export function createReleaseNotes(deps: {
  fetch: (url: string, init: { headers: Record<string, string> }) => Promise<Response>
}): (version: string) => Promise<ReleaseNotes | null> {
  const known = new Map<string, ReleaseNotes | null>()
  return async (version) => {
    if (!isReleaseVersion(version)) return null
    if (known.has(version)) return known.get(version) ?? null
    let response: Response
    try {
      response = await deps.fetch(
        `https://api.github.com/repos/${RELEASES_REPO}/releases/tags/v${version}`,
        { headers: { Accept: 'application/vnd.github+json' } },
      )
    } catch {
      return null
    }
    if (response.status === 404) {
      known.set(version, null)
      return null
    }
    if (!response.ok) return null
    const raw = (await response.json().catch(() => null)) as {
      name?: unknown
      body?: unknown
      html_url?: unknown
    } | null
    const notes: ReleaseNotes = {
      version,
      name: typeof raw?.name === 'string' && raw.name !== '' ? raw.name : `Holi ${version}`,
      body: typeof raw?.body === 'string' ? raw.body.trim() : '',
      url:
        typeof raw?.html_url === 'string'
          ? raw.html_url
          : `https://github.com/${RELEASES_REPO}/releases/tag/v${version}`,
    }
    known.set(version, notes)
    return notes
  }
}
