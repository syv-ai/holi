import type { fetchThreadCalendarPayloads } from './gmail'
import type { parseCalendarMail } from './invite'
import type { InvitationAttempt } from './mail-invitation-store'
import type { MailInvitationIdentity } from './mail-invitation'

type Mail = Awaited<ReturnType<typeof fetchThreadCalendarPayloads>>[number]
type Revision = InvitationAttempt['revision']
export type Candidate = NonNullable<ReturnType<typeof parseCalendarMail>> & { mail: Mail }
type Incoming = {
  selected: Candidate
  parents: Set<string>
  history: Candidate[]
  response: NonNullable<Revision['mailboxResponse']> | null
  barrier?: Revision
  reason?: string
  cancelled?: boolean
}

export function sameGroup(a: Revision, b: Revision): boolean {
  return a.uid === b.uid && a.recurrenceId === b.recurrenceId
}

export function sameRevision(a: Revision, b: Revision): boolean {
  return (
    sameGroup(a, b) &&
    a.sequence === b.sequence &&
    a.dtstamp === b.dtstamp &&
    a.materialKey === b.materialKey
  )
}

export function sameInvitation(a: MailInvitationIdentity, b: MailInvitationIdentity): boolean {
  return a.messageId === b.messageId && sameRevision(a, b)
}

export const identityOf = ({ value }: Candidate) => value.details.identity
export const scopeKey = ({ uid, recurrenceId }: Revision) => JSON.stringify([uid, recurrenceId])

function sameMaterial(a: Candidate, b: Candidate): boolean {
  const first = identityOf(a)
  const second = identityOf(b)
  return (
    a.published === b.published &&
    a.value.method !== null &&
    a.value.method === b.value.method &&
    first.sequence === second.sequence &&
    first.materialKey !== null &&
    first.materialKey === second.materialKey
  )
}

function blocked(selected: Candidate, reason: string): Incoming {
  return { selected, reason, parents: new Set(), history: [], response: null }
}

export function selectInvitationRevisions(deliveries: Candidate[], mailbox: string): Incoming[] {
  // Arrival breaks ties among equivalent deliveries. Sequence and DTSTAMP
  // order revisions within a scope, and establish whether an applicable CANCEL is newer.
  const candidates = [...deliveries].sort(
    (a, b) =>
      Number(a.mail.sent) - Number(b.mail.sent) ||
      b.mail.timestamp - a.mail.timestamp ||
      a.mail.messageId.localeCompare(b.mail.messageId),
  )
  const first = candidates[0]
  if (!first) return []
  const unknown = candidates.find((candidate) => !identityOf(candidate).materialKey)
  if (unknown)
    return [
      blocked(
        unknown,
        unknown.value.details.unavailableReason ??
          'Gmail could not identify a revision in this conversation',
      ),
    ]
  const groups = new Map<string, Candidate[]>()
  for (const candidate of candidates) {
    const identity = identityOf(candidate)
    if (identity.uid !== identityOf(first).uid)
      return [blocked(first, 'This conversation contains unrelated invitations')]
    const key = scopeKey(identity)
    const group = groups.get(key) ?? []
    group.push(candidate)
    groups.set(key, group)
  }
  const cancellations = candidates.filter(
    ({ value, published }) =>
      !published &&
      value.method === 'CANCEL' &&
      value.details.organizer &&
      (value.details.identity.recurrenceId === null || value.recurrenceRange === 'THISANDFUTURE'),
  )
  return [...groups.values()].map((group) => selectScope(group, candidates, cancellations, mailbox))
}

function selectScope(
  group: Candidate[],
  candidates: Candidate[],
  cancellations: Candidate[],
  mailbox: string,
): Incoming {
  const sequence = Math.max(...group.map((candidate) => identityOf(candidate).sequence))
  const history = group.filter((candidate) => identityOf(candidate).sequence === sequence)
  const stamps = [...new Set(history.flatMap((candidate) => identityOf(candidate).dtstamp ?? []))]
    .sort()
    .reverse()
  const newest = stamps[0] ?? null
  const unknownOrder = history.filter((candidate) => identityOf(candidate).dtstamp === null)
  const latest = history.filter((candidate) => identityOf(candidate).dtstamp === newest)
  const selected = latest[0]!
  const response = responseOf(selected, mailbox)
  const equivalent = (candidate: Candidate, other: Candidate) =>
    sameMaterial(candidate, other) &&
    responseMatches(responseOf(candidate, mailbox), responseOf(other, mailbox))
  const organizer = selected.value.details.organizer?.email
  if (group.some((candidate) => candidate.value.details.organizer?.email !== organizer))
    return blocked(selected, 'This occurrence has conflicting organizers')
  if (
    (newest !== null && unknownOrder.length) ||
    latest.some((candidate) => candidate !== selected && !equivalent(candidate, selected))
  )
    return blocked(selected, 'This conversation contains conflicting invitation revisions')

  // Compare series/range cancellation with each covered occurrence, not
  // arrival order. An older cancellation is still a barrier for Sent evidence.
  const covered = cancellations.filter((cancel) => covers(cancel, selected))
  let barrier: Revision | undefined
  for (const cancel of covered) {
    if (cancel.value.details.organizer?.email !== organizer) continue
    const cancellation = identityOf(cancel)
    const order = revisionOrder(cancellation, identityOf(selected))
    if (order === null || order === 0)
      return blocked(selected, 'This occurrence conflicts with a series cancellation')
    if (order > 0) {
      const verified = !candidates.some(
        (other) =>
          sameGroup(identityOf(other), cancellation) &&
          (revisionOrder(identityOf(other), cancellation) ?? 0) === 0 &&
          !equivalent(cancel, other),
      )
      if (!verified)
        return blocked(selected, 'This occurrence conflicts with a series cancellation')
      return { ...blocked(selected, 'This invitation was cancelled'), cancelled: true }
    }
    if (!barrier || revisionOrder(cancellation, barrier) !== -1) barrier = cancellation
  }
  const newerThanCancellation = (candidate: Candidate) =>
    !barrier || revisionOrder(identityOf(candidate), barrier) === 1
  // For Sent continuity walk backwards through equal event material and the
  // connected mailbox's state, not other guests' response parameters.
  const lineage = [...latest]
  for (const stamp of stamps.slice(1)) {
    const deliveries = history.filter((candidate) => identityOf(candidate).dtstamp === stamp)
    if (
      !deliveries.every(
        (candidate) => equivalent(candidate, selected) && newerThanCancellation(candidate),
      )
    )
      break
    lineage.push(...deliveries)
  }
  const parents = new Set<string>()
  for (const candidate of lineage) {
    const parent = candidate.mail.replyHeaders?.inReplyTo
    if (
      parent &&
      candidates.every(
        (other) =>
          other.mail.rfcId !== parent ||
          (candidate.mail.messageId === other.mail.messageId &&
            !sameGroup(identityOf(candidate), identityOf(other))) ||
          (sameRevision(identityOf(candidate), identityOf(other)) && equivalent(candidate, other)),
      )
    )
      parents.add(parent)
  }
  return { selected, history, parents, response, barrier }
}

function covers(cancel: Candidate, selected: Candidate): boolean {
  const first = identityOf(cancel).recurrenceId
  const slot = identityOf(selected).recurrenceId
  if (!slot || first === slot) return false // Exact cancellation was handled by scope selection.
  if (!first) return true
  // Parser-normalized dates, UTC instants and floating clocks sort within
  // their own value kind. Never convert between kinds to infer coverage.
  const kind = (id: string) =>
    id.length === 10 ? 'date' : id.endsWith('Z') ? 'instant' : 'floating'
  return kind(first) === kind(slot) && slot > first
}

function revisionOrder(a: Revision, b: Revision): -1 | 0 | 1 | null {
  if (a.sequence !== b.sequence) return a.sequence > b.sequence ? 1 : -1
  if (a.dtstamp === b.dtstamp) return 0
  if (!a.dtstamp || !b.dtstamp) return null
  return a.dtstamp > b.dtstamp ? 1 : -1
}

function responseOf(
  candidate: Candidate,
  mailbox: string,
): NonNullable<Revision['mailboxResponse']> | null {
  const states = candidate.value.request?.attendeeStates
  return states && Object.hasOwn(states, mailbox) ? states[mailbox]! : null
}

function responseMatches(a: Revision['mailboxResponse'], b: Revision['mailboxResponse']): boolean {
  return a?.responseStatus === b?.responseStatus && a?.rsvp === b?.rsvp
}

export function onLineage(incoming: Incoming, revision: Revision, mailbox: string): boolean {
  const current = identityOf(incoming.selected)
  if (incoming.reason || (incoming.barrier && revisionOrder(revision, incoming.barrier) !== 1))
    return false
  if (sameRevision(current, revision))
    return (
      revision.mailboxResponse === undefined ||
      responseMatches(incoming.response, revision.mailboxResponse)
    )
  if (
    !sameGroup(current, revision) ||
    current.sequence !== revision.sequence ||
    current.materialKey !== revision.materialKey ||
    revision.mailboxResponse === undefined ||
    !responseMatches(incoming.response, revision.mailboxResponse) ||
    !current.dtstamp ||
    !revision.dtstamp ||
    current.dtstamp <= revision.dtstamp
  )
    return false
  // A journal receipt can anchor a parent no longer present in the thread.
  // Every visible candidate back to that anchor must still agree.
  const anchor = revision.dtstamp
  return incoming.history.every((candidate) => {
    const stamp = identityOf(candidate).dtstamp
    return (
      stamp !== null &&
      (stamp < anchor ||
        (sameMaterial(candidate, incoming.selected) &&
          responseMatches(responseOf(candidate, mailbox), incoming.response)))
    )
  })
}

export function supersedes(incoming: Incoming, revision: Revision, mailbox: string): boolean {
  const current = identityOf(incoming.selected)
  if (incoming.reason || !incoming.selected.value.request || !sameGroup(current, revision))
    return false
  if (current.sequence !== revision.sequence) return current.sequence > revision.sequence
  if (
    onLineage(incoming, revision, mailbox) ||
    !current.dtstamp ||
    !revision.dtstamp ||
    current.dtstamp <= revision.dtstamp
  )
    return false
  // Old journals hashed everybody's response into materialKey. A different
  // hash alone is not proof that a legacy reservation was superseded.
  const prevStamp = revision.dtstamp
  return (
    (revision.mailboxResponse !== undefined &&
      (current.materialKey !== revision.materialKey ||
        !responseMatches(incoming.response, revision.mailboxResponse))) ||
    Boolean(incoming.barrier && revisionOrder(incoming.barrier, revision) === 1) ||
    incoming.history.some((candidate) => {
      const prior = identityOf(candidate)
      return (
        prior.dtstamp !== null &&
        prior.dtstamp >= prevStamp &&
        (!sameMaterial(candidate, incoming.selected) ||
          !responseMatches(responseOf(candidate, mailbox), incoming.response))
      )
    })
  )
}
