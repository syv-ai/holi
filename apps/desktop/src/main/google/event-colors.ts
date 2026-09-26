/**
 * Google's event palette: what a `colorId` actually means.
 *
 * An event carries `colorId: "5"`, an index into a palette Google owns.
 * Hard-coding the eleven values would drift the first time Google retouches
 * them; one cheap request per agenda load buys the colours the user already
 * sees in Google Calendar.
 *
 * **A failure here returns `{}`.** The palette is decoration on top of the
 * calendar's own colour, so losing it must cost the tint, never the agenda.
 */
import type { GoogleApi } from './api'

const COLORS_URL = 'https://www.googleapis.com/calendar/v3/colors'

interface ColorsResponse {
  /** Keyed by colorId. A per-event colorId indexes `event`, not `calendar`,
   *  and mixing them is silently wrong. */
  event?: Record<string, { background?: string; foreground?: string }>
}

/** colorId → hex, from GET /calendar/v3/colors (the `event` map). */
export async function fetchEventColors(api: GoogleApi): Promise<Record<string, string>> {
  try {
    const res = await api.get<ColorsResponse>(COLORS_URL)
    const palette: Record<string, string> = {}
    for (const [id, entry] of Object.entries(res.event ?? {})) {
      if (entry.background !== undefined) palette[id] = entry.background
    }
    return palette
  } catch {
    return {}
  }
}
