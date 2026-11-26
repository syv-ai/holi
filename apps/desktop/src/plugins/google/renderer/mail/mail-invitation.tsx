import { useId } from 'react'
import { useAtomValue } from 'jotai'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Separator } from '@/components/ui/separator'
import { Skeleton } from '@/components/ui/skeleton'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { activeRemoteAtom, activeRemoteRevisionValueAtom } from '@/plugin-api'
import { googleAccountRevisionAtom, useGoogleAccount } from '../account'
import type { TimeFormat } from '../calendar/calendar-format'
import { useTimeFormat } from '../calendar/calendar-settings'
import { googleEventUrl, httpsLink, providerConferenceUrl } from '../../shared/meeting-links'
import type { ThreadMessage } from '../mail-types'
import {
  invitationResponse,
  useMailInvitation,
  type Invitation,
  type InvitationAnswer,
  type InvitationCardState,
} from './use-mail-invitation'

const responseBadges = {
  accepted: { label: 'Accepted', variant: 'success' },
  tentative: { label: 'Tentative', variant: 'warning' },
  declined: { label: 'Declined', variant: 'destructive' },
  delegated: { label: 'Delegated', variant: 'secondary' },
  needsAction: { label: 'No response yet', variant: 'secondary' },
} as const
const answerButtons = [
  ['accepted', 'Accept'],
  ['tentative', 'Maybe'],
  ['declined', 'Decline'],
] as const satisfies readonly (readonly [InvitationAnswer, string])[]

/** Use the list's invite hint or the full thread's calendar MIME evidence.
 * Opening ordinary mail does not incur an invitation lookup. */
export function MailInvitation({
  thread,
  hasInvite,
  generation,
  isCurrentGeneration,
}: {
  thread: { id: string; messages: ThreadMessage[] }
  hasInvite: boolean
  generation: number
  isCurrentGeneration: () => boolean
}) {
  if (!hasInvite && !thread.messages.some((message) => message.hasCalendarPayload)) return null
  return (
    <InvitationScope
      threadId={thread.id}
      generation={generation}
      isCurrentGeneration={isCurrentGeneration}
    />
  )
}

function InvitationScope({
  threadId,
  generation,
  isCurrentGeneration,
}: {
  threadId: string
  generation: number
  isCurrentGeneration: () => boolean
}) {
  const remote = useAtomValue(activeRemoteAtom)
  const remoteRevision = useAtomValue(activeRemoteRevisionValueAtom)
  const accountRevision = useAtomValue(googleAccountRevisionAtom)
  const { currentSub, loading, readError, refresh } = useGoogleAccount()
  if (remote === null) return null
  // The shared read can hold the last good subject through refresh and failure.
  // Do not mount an actionable reader until the current read verifies it again.
  if (loading || readError) {
    return (
      <section aria-label="Calendar invitation" className="flex min-w-0 flex-col gap-3 pt-4">
        {loading ? (
          <div role="status" className="flex flex-col gap-2">
            <p className="text-muted-foreground text-sm">Checking the Google connection…</p>
            <Skeleton className="h-5 w-1/2" />
          </div>
        ) : (
          <Alert variant="destructive">
            <AlertDescription className="min-w-0 wrap-anywhere">
              Could not verify the Google account for this vault. Retry to check the connection
              before responding or opening invitation links.
            </AlertDescription>
          </Alert>
        )}
        {readError && (
          <div>
            <Button type="button" size="sm" variant="outline" disabled={loading} onClick={refresh}>
              Retry
            </Button>
          </div>
        )}
        <Separator />
      </section>
    )
  }
  if (!currentSub) return null
  return (
    <InvitationDetails
      key={JSON.stringify([
        remote,
        remoteRevision,
        currentSub,
        accountRevision,
        threadId,
        generation,
      ])}
      remote={remote}
      remoteRevision={remoteRevision}
      accountRevision={accountRevision}
      expectedAccountSub={currentSub}
      threadId={threadId}
      isCurrentGeneration={isCurrentGeneration}
    />
  )
}

function InvitationDetails(scope: Parameters<typeof useMailInvitation>[0]) {
  const { cards, readError, recoveryReason, busy, openLink, read, respond } =
    useMailInvitation(scope)
  const clock = useTimeFormat()
  const retry =
    readError !== null ||
    recoveryReason !== null ||
    cards.some(
      (card) =>
        card.error !== null ||
        card.refreshPending ||
        (card.invitation.kind === 'invitation' &&
          !card.invitation.canRespond &&
          !card.invitation.cancelled),
    )
  if (cards.length === 0 && busy === null && !retry) return null

  return (
    <section aria-label="Calendar invitation" className="flex min-w-0 flex-col gap-3 pt-4">
      {busy === 'reading' &&
        (cards.length === 0 ? (
          <div
            role="status"
            aria-label="Loading calendar invitation"
            className="flex flex-col gap-2"
          >
            <Skeleton className="h-5 w-1/2" />
            <Skeleton className="h-4 w-2/3" />
            <Skeleton className="h-7 w-1/3" />
          </div>
        ) : (
          <p role="status" className="text-muted-foreground text-sm">
            Checking invitation status…
          </p>
        ))}
      {cards.map((card) => (
        <InvitationCard
          key={card.key}
          card={card}
          clock={clock}
          action={typeof busy === 'object' && busy?.key === card.key ? busy.action : null}
          blocked={busy !== null || readError !== null}
          open={(url) => void openLink(card, url)}
          respond={(answer) => void respond(card, answer)}
        />
      ))}
      {(readError ?? recoveryReason) !== null && (
        <Alert variant="destructive">
          <AlertDescription className="min-w-0 wrap-anywhere">
            {readError ?? recoveryReason}
          </AlertDescription>
        </Alert>
      )}
      {retry && (
        <div>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={busy !== null}
            onClick={() => void read()}
          >
            Retry
          </Button>
        </div>
      )}
      <Separator />
    </section>
  )
}

const scopeLabels = { series: 'Whole series', occurrence: 'This occurrence' }

function InvitationCard({
  card,
  clock,
  action,
  blocked,
  open,
  respond,
}: {
  card: InvitationCardState
  clock: TimeFormat
  action: 'responding' | 'opening' | null
  blocked: boolean
  open: (url: string) => void
  respond: (answer: InvitationAnswer) => void
}) {
  const { invitation, error, refreshPending } = card
  const headingId = useId()
  const isInvitation = invitation.kind === 'invitation'
  const canRespond = isInvitation && invitation.canRespond && !invitation.cancelled
  const { current, calendarOnly, differingSent } = invitationResponse(card)
  const response = isInvitation ? (calendarOnly ?? current) : null
  const responseBadge = response === null ? null : responseBadges[response]
  const date = invitationDate(invitation, clock)
  const { organizer, location } = invitation
  const status =
    action === 'responding' ? 'Sending your response…' : responseNotice(card, canRespond)
  // An accepted write and a provider's reason for withholding the current
  // answer are separate facts. Only suppress a repeated notice.
  const reason =
    invitation.unavailableReason ??
    (!refreshPending || status === null
      ? invitation.cancelled
        ? 'This invitation was cancelled.'
        : 'You can’t respond to this invitation.'
      : null)

  return (
    <article aria-labelledby={headingId} className="flex min-w-0 flex-col gap-2">
      <Separator />
      <div className="flex flex-wrap items-center gap-2">
        <h4 id={headingId} className="min-w-0 text-sm font-medium tracking-tight wrap-anywhere">
          {invitation.title}
        </h4>
        {invitation.scope !== 'single' && (
          <Badge variant="secondary">{scopeLabels[invitation.scope]}</Badge>
        )}
        {responseBadge && (
          <Badge variant={responseBadge.variant}>
            {response === 'needsAction'
              ? responseBadge.label
              : `${calendarOnly ? 'Calendar' : 'Response'}: ${responseBadge.label}`}
          </Badge>
        )}
      </div>
      {(date || organizer || location) && (
        <dl className="flex flex-col gap-1 text-sm">
          {date && (
            <div className="flex gap-2">
              <dt className="text-muted-foreground">When</dt>
              <dd>{date}</dd>
            </div>
          )}
          {organizer && (
            <div className="flex gap-2">
              <dt className="text-muted-foreground">Organiser</dt>
              <dd className="min-w-0 wrap-anywhere">
                {organizer.name ? `${organizer.name} <${organizer.email}>` : organizer.email}
              </dd>
            </div>
          )}
          {location && (
            <div className="flex gap-2">
              <dt className="text-muted-foreground">Location</dt>
              <dd className="min-w-0 wrap-anywhere">{location}</dd>
            </div>
          )}
        </dl>
      )}
      <div className="flex flex-wrap items-center gap-2">
        {canRespond &&
          answerButtons.map(([answer, label]) => (
            <Button
              key={answer}
              type="button"
              variant="outline"
              size="sm"
              disabled={blocked || refreshPending || error !== null || current === answer}
              onClick={() => respond(answer)}
            >
              {label}
            </Button>
          ))}
        {!invitation.cancelled && (
          <InvitationLink
            invitation={invitation}
            blocked={blocked || error !== null || !card.responseFresh}
            open={open}
          />
        )}
      </div>
      {action === 'opening' && (
        <p role="status" className="text-muted-foreground text-sm">
          Checking invitation link…
        </p>
      )}
      {isInvitation && differingSent && (
        <p role="status" className="text-muted-foreground text-sm">
          Gmail Sent: {responseBadges[differingSent].label}. This reply differs from the answer
          recorded in Calendar.
        </p>
      )}
      {status !== null && (
        <p role="status" className="text-muted-foreground text-sm">
          {status}
        </p>
      )}
      {isInvitation && !canRespond && reason !== null && reason !== status && (
        <p role="status" className="text-muted-foreground text-sm">
          {reason}
        </p>
      )}
      {error !== null && (
        <Alert variant="destructive">
          <AlertDescription className="min-w-0 wrap-anywhere">{error}</AlertDescription>
        </Alert>
      )}
    </article>
  )
}

function responseNotice(card: InvitationCardState, canRespond: boolean): string | null {
  const { invitation, receipt, responseFresh, refreshPending } = card
  const response = invitationResponse(card).current
  if (receipt?.outcome === 'sent') {
    if (!responseFresh)
      return 'Google accepted your response, but its status has not been refreshed.'
    if (invitation.responsePending)
      return 'Google accepted your response; waiting for it to appear.'
    if (response === receipt.answer) return 'Google accepted your response.'
    return response === null
      ? 'Google accepted your response, but we couldn’t verify the current recorded response.'
      : 'Google accepted your response, but the current recorded response is different.'
  }
  if (receipt?.outcome === 'uncertain') {
    if (refreshPending)
      return 'We couldn’t confirm whether Google accepted your response. Retry only checks its status.'
    if (response !== receipt.answer)
      return response === null
        ? 'We couldn’t verify the current recorded response.'
        : 'The current recorded response does not match the one you tried to send.'
  }
  if (receipt?.outcome === 'unchanged' && response === receipt.answer && !refreshPending)
    return 'This was already your recorded response.'
  return refreshPending && canRespond ? 'Check your response status before responding again.' : null
}

function InvitationLink({
  invitation,
  blocked,
  open,
}: {
  invitation: Invitation
  blocked: boolean
  open: (url: string) => void
}) {
  const hostId = useId()
  // A Calendar match is not proof that the organizer's description contained a
  // real conference link. Reclassify by destination, not by the source label.
  const conference =
    providerConferenceUrl(invitation.conferenceUrl) ?? providerConferenceUrl(invitation.htmlLink)
  const event = googleEventUrl(invitation.htmlLink)
  const email =
    (invitation.conferenceLinkSource === 'mail' ? httpsLink(invitation.conferenceUrl) : null) ??
    (invitation.htmlLinkSource === 'mail' ? httpsLink(invitation.htmlLink) : null)
  const url = conference ?? event ?? email
  if (!url) return null
  const host = new URL(url).hostname
  if (!conference && !event) {
    return (
      <>
        <p id={hostId} className="min-w-0 text-sm text-muted-foreground wrap-anywhere">
          Destination: <bdi dir="ltr">{host}</bdi>
        </p>
        <Button
          type="button"
          size="sm"
          variant="outline"
          aria-describedby={hostId}
          disabled={blocked}
          onClick={() => open(url)}
        >
          Open email link
        </Button>
      </>
    )
  }
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          size="sm"
          variant="secondary"
          disabled={blocked}
          onClick={() => open(url)}
        >
          {conference ? 'Join meeting' : 'Open in Google Calendar'}
        </Button>
      </TooltipTrigger>
      <TooltipContent>
        <bdi dir="ltr" className="wrap-anywhere">
          {host}
        </bdi>
      </TooltipContent>
    </Tooltip>
  )
}

function invitationDate(
  { start, end, allDay, floating }: Invitation,
  clock: TimeFormat,
): string | null {
  if (start === null) return null
  // UTC is just a formatting axis for floating ISO values. Parsing them in the
  // host zone would silently move a time that falls inside a DST gap.
  const first = new Date(floating ? `${start}Z` : start)
  if (Number.isNaN(first.getTime())) return null
  const last = end === null ? null : new Date(floating ? `${end}Z` : end)
  const timeZone = allDay || floating ? 'UTC' : undefined
  const day = new Intl.DateTimeFormat(undefined, { dateStyle: 'full', timeZone })
  const firstDay = day.format(first)
  const later = last !== null && last > first
  if (allDay) {
    // iCalendar and Google both describe all-day dates with an exclusive end.
    if (later) last.setUTCDate(last.getUTCDate() - 1)
    const lastDay = later ? day.format(last) : firstDay
    return `${firstDay === lastDay ? firstDay : `${firstDay} – ${lastDay}`} · All day`
  }
  const time = new Intl.DateTimeFormat(
    undefined,
    clock === '12h'
      ? { hour: 'numeric', minute: '2-digit', hour12: true, timeZone }
      : { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone },
  )
  const begins = `${firstDay}, ${time.format(first)}`
  if (!later) return begins
  const lastDay = day.format(last)
  return `${begins} – ${lastDay === firstDay ? '' : `${lastDay}, `}${time.format(last)}`
}
