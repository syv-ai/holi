import type { InviteAnswer, RsvpStatus } from './calendar'
import type {
  findInvitationCalendarCopy,
  InvitationLinks,
  InvitationNavigation,
} from './mail-invitation-calendar'
import type { parseMailInvitation } from './mail-invitation'

type Details = NonNullable<ReturnType<typeof parseMailInvitation>>['details']
type VerifiedCopy = Extract<
  Awaited<ReturnType<typeof findInvitationCalendarCopy>>,
  { kind: 'verified' }
>

export type InvitationCardSource = {
  details: Details
  bindingRevision: string
  joinOnly: boolean
  calendar: Pick<
    VerifiedCopy,
    keyof InvitationLinks | 'title' | 'start' | 'end' | 'allDay' | 'location'
  > | null
}

type MailInvitation = Details & {
  bindingRevision: string
  /** Echoed on an action; only main resolves a provider resource. */
  responseTargetKey: string | null
  kind: 'invitation' | 'meeting'
  scope: 'single' | 'series' | 'occurrence'
  responseStatus: ResponsePresentation['status']
  /** A current, verified Calendar answer, not a mail or journal fallback. */
  recordedResponseStatus: MailInvitation['responseStatus']
  /** The latest corroborated Gmail reply, unless superseded by a Calendar response. */
  sentResponseStatus: InviteAnswer | null
  canRespond: boolean
  responsePending: boolean
}

type ResponsePresentation = {
  cancelled: boolean
  unavailableReason: string | null
  status: RsvpStatus | 'delegated' | null
  sentStatus: InviteAnswer | null
  recordedCalendarStatus: RsvpStatus | null
  targetKey: string | null
  canRespond: boolean
  pending: boolean
}

/** Format an already resolved card. No provider or dispatch decision lives here. */
export function projectMailInvitation({
  details,
  bindingRevision,
  joinOnly,
  calendar,
  response,
  navigation,
}: InvitationCardSource & {
  response: ResponsePresentation
  navigation: InvitationNavigation
}): MailInvitation {
  const usesUpcomingLinks = navigation.kind === 'series'
  const upcoming = usesUpcomingLinks ? navigation.links : undefined
  const htmlLink = upcoming?.htmlLink ?? calendar?.htmlLink
  return {
    ...details,
    title: calendar?.title?.trim() || details.title,
    start: calendar?.start ?? details.start,
    end: calendar?.end ?? details.end,
    allDay: calendar?.start ? calendar.allDay : details.allDay,
    location: calendar?.location ?? details.location,
    ...(navigation.kind === 'withheld'
      ? {
          conferenceUrl: null,
          conferenceLinkSource: null,
          htmlLink: null,
          htmlLinkSource: null,
        }
      : {
          conferenceUrl: usesUpcomingLinks
            ? (upcoming?.conferenceUrl ?? null)
            : (calendar?.conferenceUrl ?? details.conferenceUrl),
          conferenceLinkSource: usesUpcomingLinks
            ? (upcoming?.conferenceLinkSource ?? null)
            : calendar?.conferenceUrl
              ? calendar.conferenceLinkSource
              : details.conferenceLinkSource,
          htmlLink: htmlLink ?? (usesUpcomingLinks ? null : details.htmlLink),
          htmlLinkSource: htmlLink
            ? ('calendar' as const)
            : usesUpcomingLinks
              ? null
              : details.htmlLinkSource,
        }),
    bindingRevision,
    kind: joinOnly ? 'meeting' : 'invitation',
    scope:
      details.identity.recurrenceId !== null
        ? 'occurrence'
        : details.recurring
          ? 'series'
          : 'single',
    cancelled: response.cancelled,
    unavailableReason: response.unavailableReason,
    responseTargetKey: response.targetKey,
    responseStatus: response.status,
    recordedResponseStatus: response.recordedCalendarStatus,
    sentResponseStatus: response.sentStatus,
    canRespond: response.canRespond,
    responsePending: response.pending,
  }
}
