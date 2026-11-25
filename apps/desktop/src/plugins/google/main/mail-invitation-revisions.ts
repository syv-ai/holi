import type { MimeLocation } from './gmail-mime'
import type { fetchThreadCalendarPayloads } from './gmail-invitation-transport'
import type { parseCalendarMail } from './invite'
import type { InvitationAttempt } from './mail-invitation-store'
import type { MailInvitationIdentity } from './mail-invitation'

type Thread = Awaited<ReturnType<typeof fetchThreadCalendarPayloads>>
type Mail = Thread['messages'][number]
type Revision = InvitationAttempt['revision']
type Parsed = NonNullable<ReturnType<typeof parseCalendarMail>>
type EmbeddedOccurrence = Parsed['value']['embeddedOccurrences'][number]
export type Candidate = Parsed & {
  mail: Mail
  /** Set only in series navigation selection, never in the card scopes. */
  embedded?: EmbeddedOccurrence
}
type RevisionSelection = {
  scopes: Incoming[]
  /** Scoped navigation evidence, false for a withheld slot, or null for no applicable evidence. */
  selectSeriesSlot: (series: Candidate, slot: string) => Incoming | false | null
}
type Incoming = {
  selected: Candidate
  provenParents: Set<string>
  possibleParents: Set<string>
  history: Candidate[]
  response: NonNullable<Revision['mailboxResponse']> | null
  barrier?: Revision
  reason?: string
  cancelledBy?: Candidate
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
  if (a.value.method === 'CANCEL' && b.value.method === 'CANCEL')
    return (
      a.value.details.organizer?.email === b.value.details.organizer?.email &&
      a.value.recurrenceRange === b.value.recurrenceRange
    )
  return (
    a.joinOnly === b.joinOnly &&
    a.value.method !== null &&
    a.value.method === b.value.method &&
    first.sequence === second.sequence &&
    first.materialKey !== null &&
    first.materialKey === second.materialKey
  )
}

function blocked(selected: Candidate, reason: string): Incoming {
  return {
    selected,
    reason,
    provenParents: new Set(),
    possibleParents: new Set(),
    history: [],
    response: null,
  }
}

/** Treat validated cancellation entries as revision evidence for their own
 * scope. An embedded exception never replaces the containing REQUEST. */
function expandCancellations(candidate: Candidate, mailbox: string): Candidate[] {
  const { value } = candidate
  if (candidate.joinOnly || !value.cancellations.length) return [candidate]
  return [
    ...(value.method === 'CANCEL' ? [] : [candidate]),
    ...value.cancellations
      .filter(({ eventCancelled, attendees }) => eventCancelled || attendees.includes(mailbox))
      .map(({ identity, organizer, recurrenceRange }): Candidate => ({
        ...candidate,
        value: {
          ...value,
          method: 'CANCEL',
          recurrenceRange,
          details: {
            ...value.details,
            // The representative's DTSTART may refer to a different occurrence.
            ...(sameGroup(identity, value.details.identity) ? {} : { start: null, end: null }),
            identity,
            organizer,
            cancelled: true,
            unavailableReason: 'This invitation was cancelled',
          },
          request: null,
        },
      })),
  ]
}

type AlternativePart = { alternatives: MimeLocation['alternatives']; signature: string | null }

function alternativeBranches<T extends AlternativePart>(parts: T[]) {
  type Known = T & { signature: string }
  const groups = new Map<string, Map<number, Known[]>>()
  for (const part of parts) {
    const { signature } = part
    if (signature === null) continue
    for (const { group, branch } of part.alternatives) {
      const branches = groups.get(group) ?? new Map<number, Known[]>()
      const renditions = branches.get(branch) ?? []
      renditions.push({ ...part, signature })
      branches.set(branch, renditions)
      groups.set(group, branches)
    }
  }
  return [...groups.values()]
}

function representationsDiffer([first, ...others]: Set<string>[]): boolean {
  return Boolean(
    first &&
    others.some(
      (branch) => branch.size !== first.size || [...branch].some((key) => !first.has(key)),
    ),
  )
}

/** Non-calendar alternatives are renditions of the prose. If two branches
 * carry calendar material, however, they must describe the same evidence. */
export function hasConflictingAlternatives(parts: AlternativePart[]): boolean {
  return alternativeBranches(parts).some((branches) =>
    representationsDiffer(
      [...branches.values()].map((parts) => new Set(parts.map(({ signature }) => signature))),
    ),
  )
}

/** The stable master representation deliberately excludes live exceptions'
 * version fields. Compare those separately, within each MIME alternative and
 * original slot, without making them part of the master's RSVP revision. */
export function disputedEmbeddedAlternatives(
  parts: (AlternativePart & { candidate: Candidate | null })[],
  mailbox: string,
): EmbeddedOccurrence[] {
  const disputed: EmbeddedOccurrence[] = []
  type SlotEvidence = { occurrence: EmbeddedOccurrence; signature: string }
  for (const branches of alternativeBranches(parts)) {
    if (branches.size < 2) continue
    const slots = new Map<string, Map<number, SlotEvidence[]>>()
    for (const [branch, renditions] of branches) {
      for (const { signature, candidate } of renditions) {
        for (const occurrence of candidate?.value.embeddedOccurrences ?? []) {
          const { recurrenceId, sequence, dtstamp, materialKey } = occurrence.details.identity
          const states = occurrence.fields?.attendeeStates
          const response = states && Object.hasOwn(states, mailbox) ? states[mailbox] : null
          const key = JSON.stringify([signature, recurrenceId])
          const byBranch = slots.get(key) ?? new Map<number, SlotEvidence[]>()
          const evidence = byBranch.get(branch) ?? []
          evidence.push({
            occurrence,
            signature: JSON.stringify([
              sequence,
              dtstamp,
              materialKey,
              occurrence.recurrenceRange,
              Boolean(occurrence.fields),
              response,
            ]),
          })
          byBranch.set(branch, evidence)
          slots.set(key, byBranch)
        }
      }
    }
    for (const byBranch of slots.values()) {
      const evidence = [...branches.keys()].map((branch) => byBranch.get(branch) ?? [])
      if (
        representationsDiffer(
          evidence.map((items) => new Set(items.map(({ signature }) => signature))),
        )
      ) {
        for (const items of evidence) for (const { occurrence } of items) disputed.push(occurrence)
      }
    }
  }
  return disputed
}

export function representationOf(candidate: Candidate, mailbox: string): string {
  const { value, joinOnly } = candidate
  return JSON.stringify([
    joinOnly,
    value.method,
    identityOf(candidate),
    responseOf(candidate, mailbox),
    value.cancellations
      .map(({ identity, organizer, recurrenceRange, eventCancelled, attendees }) =>
        JSON.stringify([
          identity,
          organizer?.email,
          recurrenceRange,
          eventCancelled,
          [...attendees].sort(),
        ]),
      )
      .sort(),
  ])
}

function matchingOrganizerCancellations(group: Candidate[]): Candidate[] {
  const requests = group.filter(({ value }) => value.method !== 'CANCEL')
  if (!requests.length) return group
  const organizers = new Set(requests.map(({ value }) => value.details.organizer?.email))
  return group.filter(
    ({ value }) =>
      value.method !== 'CANCEL' ||
      (value.details.organizer !== null && organizers.has(value.details.organizer.email)),
  )
}

function embeddedCandidates(parent: Candidate): Candidate[] {
  return parent.value.embeddedOccurrences.map((embedded) => ({
    ...parent,
    embedded,
    value: {
      ...parent.value,
      recurrenceRange: embedded.recurrenceRange,
      details: {
        ...embedded.details,
        // An incomplete exception can disqualify the parent's slot, but the
        // inherited association is not evidence of a live, verified event.
        organizer: parent.value.details.organizer,
      },
      revisionMaterial: embedded.revisionMaterial,
      embeddedOccurrences: [],
      cancellations: [],
      request: null,
    },
  }))
}

function deliveryOrder(a: Candidate, b: Candidate): number {
  return (
    Number(a.mail.sent) - Number(b.mail.sent) ||
    b.mail.timestamp - a.mail.timestamp ||
    a.mail.messageId.localeCompare(b.mail.messageId)
  )
}

export function selectInvitationRevisions(
  deliveries: Candidate[],
  mailbox: string,
  owners: Thread['owners'],
  disputedEmbedded: ReadonlySet<EmbeddedOccurrence>,
): RevisionSelection {
  // Arrival breaks ties among equivalent deliveries. Sequence and DTSTAMP
  // order revisions within a scope, and establish whether an applicable CANCEL is newer.
  const candidates = deliveries
    .flatMap((candidate) => expandCancellations(candidate, mailbox))
    .sort(deliveryOrder)
  // Publications/exports can identify a meeting, but say nothing about a
  // REQUEST's revision or response. Keep real REQUESTs (including ambiguous
  // ones) and CANCELs in the ordering for their own scope.
  const requestScopes = new Set(
    candidates
      .filter((candidate) => candidate.value.method === 'REQUEST' && identityOf(candidate).uid)
      .map((candidate) => scopeKey(identityOf(candidate))),
  )
  const supersededJoins = new Set(
    candidates.filter(
      (candidate) => candidate.joinOnly && requestScopes.has(scopeKey(identityOf(candidate))),
    ),
  )
  const revisions = candidates.filter((candidate) => !supersededJoins.has(candidate))
  const unknown = revisions.find((candidate) => !identityOf(candidate).materialKey)
  if (unknown)
    return {
      scopes: [
        blocked(
          unknown,
          unknown.value.details.unavailableReason ??
            'Gmail could not identify a revision in this conversation',
        ),
      ],
      selectSeriesSlot: () => null,
    }
  const groups = new Map<string, Candidate[]>()
  for (const candidate of revisions) {
    const key = scopeKey(identityOf(candidate))
    const group = groups.get(key) ?? []
    group.push(candidate)
    groups.set(key, group)
  }
  const scoped = [...groups.values()].map(matchingOrganizerCancellations)
  const eligible = scoped.flat()
  const cancellations = eligible.filter(
    ({ value, joinOnly }) =>
      !joinOnly &&
      value.method === 'CANCEL' &&
      value.details.organizer &&
      (value.details.identity.recurrenceId === null || value.recurrenceRange === 'THISANDFUTURE'),
  )
  const embeddedIn = (series: Candidate, identity: Revision) =>
    series.value.cancellations.some((item) => item.identity === identity)
  const suppresses = (series: Candidate, cancellation: Revision) =>
    revisionOrder(cancellation, identityOf(series)) !== -1 || embeddedIn(series, cancellation)
  const equivalent = (candidate: Candidate, other: Candidate) =>
    sameMaterial(candidate, other) &&
    responseMatches(responseOf(candidate, mailbox), responseOf(other, mailbox))
  const verifyCancellation = (cancel: Candidate) =>
    !eligible.some(
      (other) =>
        sameGroup(identityOf(other), identityOf(cancel)) &&
        (revisionOrder(identityOf(other), identityOf(cancel)) ?? 0) === 0 &&
        !equivalent(cancel, other),
    )
  const coveringCancellation = (
    revision: Revision,
    organizer: string | undefined,
    series?: Candidate,
  ) => {
    let barrier: Revision | undefined
    for (const cancel of cancellations) {
      const cancellation = identityOf(cancel)
      if (cancel.value.details.organizer?.email !== organizer || !covers(cancellation, revision))
        continue
      const order = revisionOrder(cancellation, revision)
      const embedded = series && embeddedIn(series, cancellation)
      if (!embedded && (order === null || order === 0)) return { conflict: true }
      if (embedded || order === 1)
        return verifyCancellation(cancel) ? { cancelledBy: cancel } : { conflict: true }
      if (!barrier || revisionOrder(cancellation, barrier) !== -1) barrier = cancellation
    }
    return { barrier }
  }
  const slots = scoped.map((group) => ({
    entry: selectScope(group, eligible, mailbox, owners, equivalent, coveringCancellation),
    organizers: new Set(group.map(({ value }) => value.details.organizer?.email)),
  }))
  const bySlot = new Map(slots.map((slot) => [scopeKey(identityOf(slot.entry.selected)), slot]))
  const embeddedBySeries = new Map<Candidate, Candidate[]>()
  return {
    scopes: slots.map(({ entry }) => entry),
    selectSeriesSlot(series: Candidate, recurrenceId: string) {
      const revision = identityOf(series)
      const organizer = series.value.details.organizer?.email
      const slot = { ...revision, recurrenceId }
      const key = scopeKey(slot)
      if (!organizer) return false
      let embedded = embeddedBySeries.get(series)
      if (!embedded) {
        // A later master does not turn an already described slot into an
        // unknown slot. Keep prior scoped material for revision comparison.
        embedded = (groups.get(scopeKey(revision)) ?? [])
          .filter(
            ({ value }) =>
              value.method === series.value.method &&
              !value.details.cancelled &&
              value.details.organizer?.email === organizer,
          )
          .flatMap(embeddedCandidates)
        embeddedBySeries.set(series, embedded)
      }
      // A floating or mismatched original slot cannot be assigned an instant
      // or DATE in the provider's expansion. Do not treat it as absent evidence.
      if (
        embedded.some(
          (candidate) => slotKind(identityOf(candidate).recurrenceId!) !== slotKind(recurrenceId),
        )
      )
        return false
      const atSlot = embedded.filter((candidate) => sameGroup(identityOf(candidate), slot))
      const separate = bySlot.get(key)
      let occurrence = separate?.organizers.has(organizer) ? separate.entry : undefined
      if (atSlot.length) {
        const combined = [...(groups.get(key) ?? []), ...atSlot].sort(deliveryOrder)
        const requests = combined.some(({ value }) => value.method === 'REQUEST')
        const group = matchingOrganizerCancellations(
          requests ? combined.filter(({ joinOnly }) => !joinOnly) : combined,
        )
        occurrence = selectScope(group, group, mailbox, owners, equivalent, coveringCancellation)
      }
      // Alternative branches are not independent deliveries. Keep their
      // revisions as possible predecessors but never choose one as proof of
      // this slot. Only a newer exact revision from another message can
      // resolve the dispute, regardless of which branch was rendered.
      if (
        embedded.some(
          (candidate) =>
            candidate.embedded &&
            disputedEmbedded.has(candidate.embedded) &&
            (sameGroup(identityOf(candidate), slot) ||
              (candidate.value.recurrenceRange === 'THISANDFUTURE' &&
                covers(identityOf(candidate), slot))) &&
            (!occurrence ||
              occurrence.selected.mail === candidate.mail ||
              revisionOrder(identityOf(occurrence.selected), identityOf(candidate)) !== 1),
        )
      )
        return false
      // A live range exception cannot describe future rows exactly. Only a
      // strictly newer, verified exact revision can resolve that uncertainty.
      if (
        embedded.some(
          (candidate) =>
            candidate.value.recurrenceRange === 'THISANDFUTURE' &&
            covers(identityOf(candidate), slot) &&
            (!occurrence ||
              revisionOrder(identityOf(occurrence.selected), identityOf(candidate)) !== 1),
        )
      )
        return false
      if (occurrence) {
        const { value, embedded } = occurrence.selected
        if (value.details.organizer?.email !== organizer) return false
        const cancellation =
          occurrence.cancelledBy ??
          (!occurrence.reason && value.details.cancelled ? occurrence.selected : null)
        if (cancellation && (atSlot.length || suppresses(series, identityOf(cancellation))))
          return false
        if (!cancellation) {
          // Ambiguous or incomplete evidence is not the same as an unknown
          // slot, even if Calendar still lists a confirmed row there.
          if (occurrence.reason || !(embedded ? embedded.fields : value.request)) return false
          if (embedded || value.method === 'REQUEST') return occurrence
        }
      }
      const covering = coveringCancellation(slot, organizer, series)
      return covering.conflict || covering.cancelledBy ? false : null
    },
  }
}

function selectScope(
  group: Candidate[],
  candidates: Candidate[],
  mailbox: string,
  owners: Thread['owners'],
  equivalent: (candidate: Candidate, other: Candidate) => boolean,
  coveringCancellation: (
    revision: Revision,
    organizer: string | undefined,
  ) => { conflict?: boolean; cancelledBy?: Candidate; barrier?: Revision },
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
  const { conflict, cancelledBy, barrier } = coveringCancellation(identityOf(selected), organizer)
  if (conflict) return blocked(selected, 'This occurrence conflicts with a series cancellation')
  if (cancelledBy) return { ...blocked(selected, 'This invitation was cancelled'), cancelledBy }
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
  const provenParents = new Set<string>()
  const possibleParents = new Set<string>()
  for (const candidate of lineage) {
    // The containing message is not an occurrence RSVP parent, and a
    // malformed REQUEST can order revisions but cannot anchor a reply.
    if (candidate.embedded || !candidate.value.request) continue
    // Ownership disputes cannot erase the link from known REQUEST material
    // to a claimed parent. Such a link can withhold, but never confirm, an answer.
    for (const claim of candidate.mail.claims) possibleParents.add(claim)
    const parent = candidate.mail.replyHeaders?.inReplyTo
    if (
      parent &&
      owners.get(parent) === candidate.mail.messageId &&
      // Only one Gmail message may own the parent. Within it, other scopes
      // and the join-only sidecars excluded from ordering aren't REQUEST evidence.
      candidates.every(
        (other) =>
          other.mail.messageId !== candidate.mail.messageId ||
          !sameGroup(identityOf(candidate), identityOf(other)) ||
          (sameRevision(identityOf(candidate), identityOf(other)) && equivalent(candidate, other)),
      )
    )
      provenParents.add(parent)
  }
  return { selected, history, provenParents, possibleParents, response, barrier }
}

function covers(cancel: Revision, selected: Revision): boolean {
  const first = cancel.recurrenceId
  const slot = selected.recurrenceId
  if (cancel.uid !== selected.uid || !slot || first === slot) return false // Exact cancellation was handled by scope selection.
  if (!first) return true
  // Parser-normalized dates, UTC instants and floating clocks sort within
  // their own value kind. Never convert between kinds to infer coverage.
  return slotKind(first) === slotKind(slot) && slot > first
}

function slotKind(id: string) {
  return id.length === 10 ? 'date' : id.endsWith('Z') ? 'instant' : 'floating'
}

/** Order only; equal version fields do not establish equal material. */
export function revisionOrder(a: Revision, b: Revision): -1 | 0 | 1 | null {
  if (a.sequence !== b.sequence) return a.sequence > b.sequence ? 1 : -1
  if (a.dtstamp === b.dtstamp) return 0
  if (!a.dtstamp || !b.dtstamp) return null
  return a.dtstamp > b.dtstamp ? 1 : -1
}

function responseOf(
  candidate: Candidate,
  mailbox: string,
): NonNullable<Revision['mailboxResponse']> | null {
  const states = (candidate.embedded?.fields ?? candidate.value.request)?.attendeeStates
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
  if (revisionOrder(current, revision) !== 1) return false
  if (current.sequence !== revision.sequence) return true
  if (onLineage(incoming, revision, mailbox)) return false
  // Old journals hashed everybody's response into materialKey. A different
  // hash alone is not proof that a legacy reservation was superseded.
  // Equal sequence and strict order require usable stamps on both sides.
  const prevStamp = revision.dtstamp!
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
