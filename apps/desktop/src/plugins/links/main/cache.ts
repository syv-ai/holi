/**
 * Previews already fetched, on this machine only: in memory, and in a file
 * in `userData` so a restart does not fetch every page again. Never in a
 * vault: a preview is what a page says today, not something a person wrote.
 *
 * A day old, an entry is fetched again; a failure that may pass (offline, a
 * timeout) is not kept at all. Two asks for one address while it is
 * being fetched share the fetch, since a hover asks on every move.
 */
import { join } from 'node:path'
import { jsonFileStore } from '../../../main/plugin-api'
import type { LinkPreview } from '../shared/preview'
import type { Fetched } from './unfurl'

const TTL_MS = 24 * 60 * 60 * 1000
const MAX_ENTRIES = 500

interface Entry {
  at: number
  preview: LinkPreview
}

type Entries = Record<string, Entry>

export interface PreviewCache {
  get(url: string): Promise<LinkPreview>
}

export function previewCache(
  userData: string,
  fetchPreview: (url: string) => Promise<Fetched>,
  now: () => number = Date.now,
): PreviewCache {
  const store = jsonFileStore<Entries>(
    join(userData, 'links', 'previews.json'),
    (raw) =>
      raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Entries) : {},
    { cache: true },
  )
  const inFlight = new Map<string, Promise<LinkPreview>>()

  const fresh = async (url: string): Promise<LinkPreview> => {
    const { preview, keep } = await fetchPreview(url)
    if (!keep) return preview
    await store
      .update((entries) => {
        const kept = Object.entries({ ...entries, [url]: { at: now(), preview } })
          .sort(([, a], [, b]) => b.at - a.at)
          .slice(0, MAX_ENTRIES)
        return Object.fromEntries(kept)
      })
      .catch(() => {})
    return preview
  }

  return {
    async get(url) {
      const hit = (await store.read())[url]
      if (hit !== undefined && now() - hit.at < TTL_MS) return hit.preview
      const pending = inFlight.get(url)
      if (pending !== undefined) return pending
      const next = fresh(url).finally(() => inFlight.delete(url))
      inFlight.set(url, next)
      return next
    },
  }
}
