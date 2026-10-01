/**
 * Where a mail thread and a calendar event turn out to be the same meeting.
 *
 * **The `.ics`'s `UID` is the whole mechanism, and the reason there is no second
 * conferencing-link parser here.** iCalendar defines the UID as the event's
 * identity and Google indexes it, so a thread can be matched to an event
 * exactly, rather than guessed at from a subject line and a start time. Once the
 * event is in hand, the join link is whatever `calendar.ts` already resolves.
 *
 * So this module is deliberately thin: read a UID, ask the calendar.
 */
import type { GoogleApi } from './api'
import { findEventByICalUid, type CalendarOverrides } from './calendar'
import { fetchThreadIcs } from './gmail'

/** The meeting a thread is about, as the reader needs it. */
export interface ThreadMeeting {
  eventId: string
  title: string
  /** ISO, or a bare date for an all-day event. */
  start: string
  end: string
  /**
   * What a Join button opens, or `null` when the meeting has no video call.
   * "No such meeting" is the whole result being `null`.
   */
  conferenceUrl: string | null
  /** Google Calendar's own page for it: always available, so the reader has
   *  something to offer even when there is nothing to join. */
  htmlLink: string
}

/**
 * ICS unfolding, per RFC 5545: a line past 75 octets continues on the next one
 * behind a single space or tab.
 *
 * Not a nicety. An Outlook UID is around a hundred characters, so it is folded
 * essentially always, and a truncated UID silently matches no event.
 */
function unfold(ics: string): string {
  return ics.replace(/\r?\n[ \t]/g, '')
}

/**
 * The `UID` of the first event in an `.ics`.
 *
 * The first is the right one: a recurring series and its exceptions share a UID,
 * so a file with several VEVENTs still describes one meeting.
 */
export function icsUid(ics: string): string | null {
  for (const line of unfold(ics).split(/\r?\n/)) {
    // Anchored, so Outlook's `X-ALT-UID` is not read as the UID. The optional
    // `;params` is the iCalendar property grammar.
    const match = /^UID(?:;[^:]*)?:(.*)$/i.exec(line.trim())
    if (match !== null && match[1]!.trim() !== '') return match[1]!.trim()
  }
  return null
}

/**
 * The meeting a thread is about, or null.
 *
 * Null covers three different situations on purpose, because the reader treats
 * them the same way (it says nothing):
 *
 * - the thread holds no invite;
 * - it holds one, but the event is not on any calendar the user has enabled
 *   (they declined it, or were never really invited);
 * - the meeting is entirely in the past, so there is nothing left to join.
 *
 * What null must never mean is "probably this one". A Join button that opens a
 * plausible wrong meeting is worse than no button.
 */
export async function resolveThreadMeeting(
  api: GoogleApi,
  threadId: string,
  options: { overrides?: CalendarOverrides } = {},
): Promise<ThreadMeeting | null> {
  const ics = await fetchThreadIcs(api, threadId)
  if (ics === null) return null

  const uid = icsUid(ics)
  if (uid === null) return null

  const event = await findEventByICalUid(api, uid, { overrides: options.overrides })
  if (event === null) return null

  return {
    eventId: event.id,
    title: event.title,
    start: event.start,
    end: event.end,
    conferenceUrl: event.conferenceUrl,
    htmlLink: event.htmlLink,
  }
}
