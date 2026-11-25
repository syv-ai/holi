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
import { timeOf, type TimeFormat } from '../calendar/calendar-format'
import { useTimeFormat } from '../calendar/calendar-settings'
import { googleEventUrl, httpsLink, providerConferenceUrl } from '../../shared/meeting-links'
import type { ThreadMessage } from '../mail-types'
import {
  useMailInvitation,
  type Invitation,
  type InvitationAnswer,
  type InvitationCardState,
} from './use-mail-invitation'

const responses = {
  accepted: { action: 'Accept', label: 'Accepted', variant: 'success' },
  tentative: { action: 'Maybe', label: 'Tentative', variant: 'warning' },
  declined: { action: 'Decline', label: 'Declined', variant: 'destructive' },
} as const
const answers = Object.keys(responses) as InvitationAnswer[]

/** Use the list's invite hint or the full thread's calendar MIME evidence.
 * Opening ordinary mail does not incur an invitation lookup. */
export function MailInvitation({
  thread,
  hasInvite,
  generation,
}: {
  thread: { id: string; messages: ThreadMessage[] }
  hasInvite: boolean
  generation: number
}) {
  if (!hasInvite && !thread.messages.some((message) => message.hasCalendarPayload)) return null
  return <InvitationScope threadId={thread.id} generation={generation} />
}

function InvitationScope({ threadId, generation }: { threadId: string; generation: number }) {
  const remote = useAtomValue(activeRemoteAtom)
  const remoteRevision = useAtomValue(activeRemoteRevisionValueAtom)
  const accountRevision = useAtomValue(googleAccountRevisionAtom)
  const { currentSub, loading, readError } = useGoogleAccount()
  if (remote === null || !currentSub || loading || readError) return null
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
          sending={busy !== 'reading' && busy?.responding === card.key}
          blocked={busy !== null || readError !== null}
          open={(url) => void openLink(url)}
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
  sending,
  blocked,
  open,
  respond,
}: {
  card: InvitationCardState
  clock: TimeFormat
  sending: boolean
  blocked: boolean
  open: (url: string) => void
  respond: (answer: InvitationAnswer) => void
}) {
  const { invitation, error, receipt, refreshPending } = card
  const headingId = useId()
  const isInvitation = invitation.kind === 'invitation'
  const canRespond = isInvitation && invitation.canRespond && !invitation.cancelled
  const response = isInvitation ? invitation.responseStatus : null
  const knownResponse = response && response !== 'needsAction' ? responses[response] : null
  const date = invitationDate(invitation, clock)
  const { organizer, location } = invitation
  const status = sending
    ? 'Sending your response…'
    : receipt === 'sent'
      ? refreshPending
        ? 'Google accepted your response, but its status has not been refreshed.'
        : 'Google accepted your response.'
      : receipt === 'uncertain' && refreshPending
        ? 'We couldn’t confirm whether Google accepted your response. Retry only checks its status.'
        : receipt === 'unchanged'
          ? 'This was already your recorded response.'
          : refreshPending && canRespond
            ? 'Check your response status before responding again.'
            : null

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
        {knownResponse ? (
          <Badge variant={knownResponse.variant}>Response: {knownResponse.label}</Badge>
        ) : response === 'needsAction' ? (
          <Badge variant="secondary">No response yet</Badge>
        ) : null}
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
          answers.map((answer) => (
            <Button
              key={answer}
              type="button"
              variant="outline"
              size="sm"
              disabled={blocked || refreshPending || error !== null || response === answer}
              onClick={() => respond(answer)}
            >
              {responses[answer].action}
            </Button>
          ))}
        {!invitation.cancelled && <InvitationLink invitation={invitation} open={open} />}
      </div>
      {status !== null && (
        <p role="status" className="text-muted-foreground text-sm">
          {status}
        </p>
      )}
      {isInvitation && !canRespond && (!refreshPending || status === null) && (
        <p role="status" className="text-muted-foreground text-sm">
          {invitation.unavailableReason ??
            (invitation.cancelled
              ? 'This invitation was cancelled.'
              : 'You can’t respond to this invitation.')}
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

function InvitationLink({
  invitation,
  open,
}: {
  invitation: Invitation
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
        <Button type="button" size="sm" variant="secondary" onClick={() => open(url)}>
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

function invitationDate({ start, end, allDay }: Invitation, clock: TimeFormat): string | null {
  if (start === null) return null
  const first = new Date(start)
  if (Number.isNaN(first.getTime())) return null
  const last = end === null ? null : new Date(end)
  const day = new Intl.DateTimeFormat(undefined, {
    dateStyle: 'full',
    ...(allDay ? { timeZone: 'UTC' } : {}),
  })
  const firstDay = day.format(first)
  const later = last !== null && last > first
  if (allDay) {
    // iCalendar and Google both describe all-day dates with an exclusive end.
    if (later) last.setUTCDate(last.getUTCDate() - 1)
    const lastDay = later ? day.format(last) : firstDay
    return `${firstDay === lastDay ? firstDay : `${firstDay} – ${lastDay}`} · All day`
  }
  const begins = `${firstDay}, ${timeOf(first, clock)}`
  if (!later) return begins
  const lastDay = day.format(last)
  return `${begins} – ${lastDay === firstDay ? '' : `${lastDay}, `}${timeOf(last, clock)}`
}
