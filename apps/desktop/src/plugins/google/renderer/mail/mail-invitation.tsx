import { useId } from 'react'
import { useAtomValue } from 'jotai'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Separator } from '@/components/ui/separator'
import { Skeleton } from '@/components/ui/skeleton'
import { activeRemoteAtom, activeRemoteRevisionValueAtom, openExternal } from '@/plugin-api'
import { googleAccountRevisionAtom, useGoogleAccount } from '../account'
import { timeOf, type TimeFormat } from '../calendar/calendar-format'
import { useTimeFormat } from '../calendar/calendar-settings'
import type { ThreadMessage } from '../mail-types'
import { useMailInvitation, type Invitation, type InvitationAnswer } from './use-mail-invitation'

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
  const { invitation, meeting, error, busy, receipt, refreshPending, read, respond } =
    useMailInvitation(scope)
  const clock = useTimeFormat()
  const linkHostId = useId()
  const pending = refreshPending || invitation?.responsePending === true
  const canRespond = invitation?.canRespond === true && !invitation.cancelled
  const showResponses = canRespond || (pending && invitation !== null && !invitation.cancelled)
  const blocked = busy !== null || pending || error !== null
  const conference = invitation?.cancelled
    ? null
    : httpsUrl(invitation?.conferenceUrl ?? meeting?.conferenceUrl)
  const meetingUrl = conference ?? httpsUrl(invitation?.htmlLink ?? meeting?.htmlLink)
  const linkSource = conference ? invitation?.conferenceLinkSource : invitation?.htmlLinkSource
  const emailHost =
    invitation !== null && linkSource !== 'provider' && linkSource !== 'calendar'
      ? (meetingUrl?.hostname ?? null)
      : null
  const retry =
    error !== null || pending || (invitation !== null && !canRespond && !invitation.cancelled)

  if (
    invitation === null &&
    meeting === null &&
    busy === null &&
    error === null &&
    receipt === null
  ) {
    return null
  }

  const response = invitation?.responseStatus
  const knownResponse = response && response !== 'needsAction' ? responses[response] : null
  const date = invitation && invitationDate(invitation, clock)
  const organizer = invitation?.organizer
  const status =
    busy === 'responding'
      ? 'Sending your response…'
      : receipt === 'sent'
        ? pending
          ? 'Google accepted your response, but its status has not been refreshed.'
          : 'Google accepted your response.'
        : receipt === 'uncertain' && pending
          ? 'We couldn’t confirm whether Google accepted your response. Retry only checks its status.'
          : receipt === 'unchanged'
            ? 'This was already your recorded response.'
            : null

  return (
    <section aria-label="Calendar invitation" className="flex min-w-0 flex-col gap-3 pt-4">
      {invitation === null && meeting === null && busy === 'reading' && (
        <div role="status" aria-label="Loading calendar invitation" className="flex flex-col gap-2">
          <Skeleton className="h-5 w-1/2" />
          <Skeleton className="h-4 w-2/3" />
          <Skeleton className="h-7 w-1/3" />
        </div>
      )}
      {invitation !== null && (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <h4 className="min-w-0 text-sm font-medium tracking-tight wrap-anywhere">
              {invitation.title}
            </h4>
            {knownResponse ? (
              <Badge variant={knownResponse.variant}>Response: {knownResponse.label}</Badge>
            ) : response === 'needsAction' ? (
              <Badge variant="secondary">No response yet</Badge>
            ) : null}
          </div>
          {(date || organizer || invitation.location) && (
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
              {invitation.location && (
                <div className="flex gap-2">
                  <dt className="text-muted-foreground">Location</dt>
                  <dd className="min-w-0 wrap-anywhere">{invitation.location}</dd>
                </div>
              )}
            </dl>
          )}
        </>
      )}
      {(showResponses || (meetingUrl !== null && emailHost === null)) && (
        <div className="flex flex-wrap items-center gap-2">
          {showResponses &&
            answers.map((answer) => (
              <Button
                key={answer}
                type="button"
                variant="outline"
                size="sm"
                disabled={blocked || response === answer}
                onClick={() => void respond(answer)}
              >
                {responses[answer].action}
              </Button>
            ))}
          {meetingUrl !== null && emailHost === null && (
            <Button
              type="button"
              size="sm"
              variant="secondary"
              onClick={() => openExternal(meetingUrl.href)}
            >
              {conference === null ? 'Open this meeting' : 'Join meeting'}
            </Button>
          )}
        </div>
      )}
      {meetingUrl !== null && emailHost !== null && (
        <div className="flex flex-wrap items-center gap-2">
          <p id={linkHostId} className="min-w-0 text-sm text-muted-foreground wrap-anywhere">
            Destination: <bdi dir="ltr">{emailHost}</bdi>
          </p>
          <Button
            type="button"
            size="sm"
            variant="outline"
            aria-describedby={linkHostId}
            onClick={() => openExternal(meetingUrl.href)}
          >
            Open email link
          </Button>
        </div>
      )}
      {status !== null && (
        <p role="status" className="text-muted-foreground text-sm">
          {status}
        </p>
      )}
      {busy === 'reading' && invitation !== null && (
        <p role="status" className="text-muted-foreground text-sm">
          Checking invitation status…
        </p>
      )}
      {invitation !== null && !canRespond && (!pending || status === null) && (
        <p role="status" className="text-muted-foreground text-sm">
          {invitation.unavailableReason ??
            (invitation.cancelled
              ? 'This invitation was cancelled.'
              : 'You can’t respond to this invitation.')}
        </p>
      )}
      {invitation === null && receipt !== null && busy === null && error === null && (
        <p role="status" className="text-muted-foreground text-sm">
          The invitation is no longer available in this thread.
        </p>
      )}
      {error !== null && (
        <Alert variant="destructive">
          <AlertDescription className="min-w-0 wrap-anywhere">{error}</AlertDescription>
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

function httpsUrl(value: string | null | undefined): URL | null {
  if (!value) return null
  try {
    // URL exposes the actual ASCII (Punycode for IDNs) hostname, not mail copy.
    const url = new URL(value)
    return url.protocol === 'https:' && !url.username && !url.password ? url : null
  } catch {
    return null
  }
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
