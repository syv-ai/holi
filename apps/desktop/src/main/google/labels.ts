/**
 * Gmail's user labels — id → the name a person would recognise.
 *
 * A message carries `Label_12`; only this endpoint knows that means
 * `Work/Clients`. The lookup is **one request per `listThreads` call, not one
 * per thread** — the whole mail area is an invitation to an N+1, and this is
 * the cheapest place to get it wrong.
 *
 * **A failure returns an empty map.** Labels are decoration on a row; losing
 * them must cost the chips, never the inbox they sit on.
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

/** id → user-visible name, for Gmail's user labels only. */
export async function fetchLabelNames(api: GoogleApi): Promise<Map<string, string>> {
  const names = new Map<string, string>()
  try {
    const res = await api.get<{ labels?: RawLabel[] }>(LABELS_URL)
    for (const label of res.labels ?? []) {
      if (label.type !== 'user') continue
      if (label.id === undefined || label.name === undefined) continue
      names.set(label.id, label.name)
    }
  } catch {
    return new Map()
  }
  return names
}
