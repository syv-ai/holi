/**
 * Gmail's user labels: id → the name a person would recognise.
 *
 * A message carries `Label_12`; only this endpoint knows that means
 * `Work/Clients`. The lookup is **one request per `listThreads` call, not one
 * per thread**, to avoid an N+1.
 *
 * Decorative lookups return an empty map on failure: losing a label chip
 * must not cost the inbox. Authoritative list validation uses the strict
 * lookup, which rejects failures rather than publishing partial data.
 */
import type { GoogleApi } from './api'

const LABELS_URL = 'https://gmail.googleapis.com/gmail/v1/users/me/labels'

interface RawLabel {
  id?: string
  name?: string
  /** `user` | `system`. Gmail's own labels (INBOX, CATEGORY_*) are `system`,
   *  and are not filing the user did. */
  type?: string
}

/** id → user-visible name; rejects provider failures for authoritative reads. */
export async function fetchLabelNamesStrict(api: GoogleApi): Promise<Map<string, string>> {
  const page = await api.get<{ labels?: RawLabel[] }>(LABELS_URL)
  return new Map(
    (page.labels ?? []).flatMap((label) =>
      label.type === 'user' && label.id !== undefined && label.name !== undefined
        ? [[label.id, label.name] as const]
        : [],
    ),
  )
}

/** Optional row decoration: a failed lookup must not prevent reading mail. */
export async function fetchLabelNames(api: GoogleApi): Promise<Map<string, string>> {
  try {
    return await fetchLabelNamesStrict(api)
  } catch {
    return new Map()
  }
}
