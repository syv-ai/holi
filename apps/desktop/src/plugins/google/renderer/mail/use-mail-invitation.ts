import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useStore } from 'jotai'
import { activeRemoteAtom, activeRemoteRevisionValueAtom, openExternal } from '@/plugin-api'
import { googleAccountRevisionAtom } from '../account'
import { googleCap } from '../google-cap'
import { messageOf } from '../google-errors'

type ReadInput = Parameters<typeof googleCap.mailInvitation>[1]
type ReadResult = Awaited<ReturnType<typeof googleCap.mailInvitation>>
type ReadInvitation = ReadResult['invitations'][number]
export type InvitationAnswer = Parameters<typeof googleCap.respondToMailInvitation>[1]['answer']
export type Invitation = ReadInvitation

export function invitationResponse({ invitation, responseFresh }: InvitationCardState) {
  if (!responseFresh) return { current: null, calendarOnly: null, differingSent: null }
  const { recordedResponseStatus: recorded, responseStatus, sentResponseStatus: sent } = invitation
  const calendarAnswer = recorded !== 'needsAction' && recorded !== 'delegated' ? recorded : null
  // A verified Calendar answer is evidence about that copy only. It cannot
  // settle an outstanding write or turn the local receipt into a confirmation.
  const differingSent = calendarAnswer && sent !== calendarAnswer ? sent : null
  return {
    current: invitation.responsePending ? null : differingSent ? calendarAnswer : responseStatus,
    calendarOnly:
      invitation.responsePending || differingSent || responseStatus === null
        ? calendarAnswer
        : null,
    differingSent,
  }
}
type ResponseResult = Awaited<ReturnType<typeof googleCap.respondToMailInvitation>>
type Receipt = Pick<ResponseResult, 'outcome' | 'answer'>

// A new parent, binding, or material revision cannot inherit a local receipt.
function cardKey({ bindingRevision, kind, scope, identity }: Invitation): string {
  const { messageId, uid, sequence, recurrenceId, dtstamp, materialKey } = identity
  return JSON.stringify([
    bindingRevision,
    kind,
    scope,
    messageId,
    uid,
    sequence,
    recurrenceId,
    dtstamp,
    materialKey,
  ])
}

export interface InvitationCardState {
  key: string
  invitation: Invitation
  error: string | null
  receipt: Receipt | null
  /** The displayed card has a fresh provider readback, even if its RSVP is pending. */
  responseFresh: boolean
  refreshPending: boolean
}

type Operation = 'reading' | 'responding' | 'opening'

interface InvitationState {
  cards: InvitationCardState[]
  busy: 'reading' | { action: Exclude<Operation, 'reading'>; key: string } | null
  readError: string | null
  recoveryReason: string | null
}

/** One keyed reader opening owns these results. Check the live store as well as
 * its mounted lifetime: React may not yet have committed a vault/account change. */
export function useMailInvitation({
  remote,
  remoteRevision,
  accountRevision,
  expectedAccountSub,
  threadId,
  isCurrentGeneration,
}: ReadInput & {
  remote: string
  remoteRevision: number
  accountRevision: number
  isCurrentGeneration: () => boolean
}) {
  const store = useStore()
  const owner = useRef<object | null>(null)
  const currentCards = useRef<InvitationCardState[]>([])
  const flight = useRef<{ operation: Operation } | null>(null)
  const [state, setState] = useState<InvitationState>({
    cards: [],
    busy: 'reading',
    readError: null,
    recoveryReason: null,
  })

  useLayoutEffect(() => {
    owner.current = {}
    return () => {
      owner.current = null
      flight.current = null
    }
  }, [])

  // Do not readmit an action until its result and disabled state have committed.
  useLayoutEffect(() => {
    currentCards.current = state.cards
    if (state.busy === null) flight.current = null
  }, [state])

  const ownsReader = useCallback(
    () =>
      owner.current !== null &&
      isCurrentGeneration() &&
      store.get(activeRemoteAtom) === remote &&
      store.get(activeRemoteRevisionValueAtom) === remoteRevision &&
      store.get(googleAccountRevisionAtom) === accountRevision,
    [store, remote, remoteRevision, accountRevision, isCurrentGeneration],
  )

  const begin = useCallback(
    (operation: Operation) => {
      const lifetime = owner.current
      if (!ownsReader()) return null
      // A response can supersede a pending link check, but not another read or write.
      if (flight.current && !(operation === 'responding' && flight.current.operation === 'opening'))
        return null
      const epoch = { operation }
      flight.current = epoch
      return () => flight.current === epoch && owner.current === lifetime && ownsReader()
    },
    [ownsReader],
  )

  const readCards = useCallback(
    async (request: () => boolean) => {
      try {
        const { invitations, recoveryReason } = await googleCap.mailInvitation(remote, {
          threadId,
          expectedAccountSub,
        })
        if (!request()) return
        setState((previous) => {
          // A read that could not reconstruct any cards is not evidence against
          // a known receipt. Keep the displayed facts, with actions blocked.
          if (
            invitations.length === 0 &&
            recoveryReason !== null &&
            previous.cards.some((card) => card.receipt !== null)
          )
            return { ...previous, busy: null, readError: recoveryReason }
          const receipts = new Map(previous.cards.map((card) => [card.key, card.receipt]))
          return {
            cards: invitations.map((invitation) => {
              const key = cardKey(invitation)
              const receipt = receipts.get(key)
              return {
                key,
                invitation,
                error: null,
                receipt: receipt ?? null,
                responseFresh: true,
                refreshPending: invitation.responsePending,
              }
            }),
            busy: null,
            readError: null,
            recoveryReason,
          }
        })
      } catch (error) {
        if (request()) {
          setState((previous) => ({
            ...previous,
            busy: null,
            readError: messageOf(error, 'Could not read the invitation.'),
          }))
        }
      }
    },
    [remote, threadId, expectedAccountSub],
  )

  const read = useCallback(async () => {
    const request = begin('reading')
    if (request === null) return
    setState((previous) => ({ ...previous, busy: 'reading', readError: null }))
    await readCards(request)
  }, [begin, readCards])

  useEffect(() => {
    void read()
  }, [read])

  const respond = async (card: InvitationCardState, answer: InvitationAnswer) => {
    const { key, invitation } = card
    if (
      invitation.kind !== 'invitation' ||
      !invitation.canRespond ||
      invitation.cancelled ||
      invitationResponse(card).current === answer ||
      !currentCards.current.includes(card) ||
      state.readError !== null ||
      !card.responseFresh ||
      card.refreshPending ||
      card.error !== null
    )
      return
    const request = begin('responding')
    if (request === null) return
    // The single-card result cannot verify siblings of a series. Retire the
    // old group now, including any link awaiting actor validation.
    const reconcileGroup = invitation.scope === 'series' && currentCards.current.length > 1
    const updateCard = (
      busy: InvitationState['busy'],
      update: (current: InvitationCardState) => InvitationCardState,
    ) =>
      setState((previous) => ({
        ...previous,
        busy,
        cards: previous.cards.map((current) => (current.key === key ? update(current) : current)),
      }))
    setState((previous) => ({
      ...previous,
      busy: { action: 'responding', key },
      cards: previous.cards.map((current) =>
        current.key === key
          ? { ...current, receipt: null, responseFresh: false }
          : reconcileGroup
            ? { ...current, responseFresh: false }
            : current,
      ),
    }))
    let result: ResponseResult
    try {
      result = await googleCap.respondToMailInvitation(remote, {
        threadId,
        expectedAccountSub,
        expectedBindingRevision: invitation.bindingRevision,
        expectedResponseTargetKey: invitation.responseTargetKey,
        identity: invitation.identity,
        answer,
      })
    } catch (error) {
      if (request()) {
        // A refused response also needs a read before another RSVP for this card.
        updateCard(null, (current) => ({
          ...current,
          error: messageOf(
            error,
            'Could not confirm your response. Check its status before responding again.',
          ),
        }))
      }
      return
    }
    if (!request()) return
    const updated = result.invitation
    const sameRevision = updated === null || cardKey(updated) === key
    const fresh =
      updated !== null && sameRevision && (!reconcileGroup || result.outcome !== 'uncertain')
    const refreshGroup = reconcileGroup && fresh
    updateCard(refreshGroup ? 'reading' : null, (current) => ({
      ...current,
      invitation: fresh ? updated : current.invitation,
      receipt: sameRevision ? { outcome: result.outcome, answer: result.answer } : null,
      responseFresh: fresh,
      refreshPending: !fresh || result.refreshPending || updated.responsePending,
    }))
    if (refreshGroup) await readCards(request)
  }

  const openLink = async (card: InvitationCardState, url: string) => {
    if (
      state.busy !== null ||
      state.readError !== null ||
      card.error !== null ||
      !card.responseFresh ||
      !currentCards.current.includes(card)
    )
      return
    const request = begin('opening')
    if (request === null) return
    setState((previous) => ({ ...previous, busy: { action: 'opening', key: card.key } }))
    try {
      await googleCap.validateMailInvitationBinding(remote, {
        expectedAccountSub,
        expectedBindingRevision: card.invitation.bindingRevision,
      })
      if (request() && currentCards.current.includes(card)) openExternal(url)
      if (request()) setState((previous) => ({ ...previous, busy: null }))
    } catch (error) {
      if (!request()) return
      setState((previous) => ({
        ...previous,
        busy: null,
        cards: previous.cards.map((current) =>
          current === card
            ? {
                ...current,
                error: messageOf(
                  error,
                  'Could not verify this invitation before opening its link.',
                ),
              }
            : current,
        ),
      }))
    }
  }

  return { ...state, openLink, read, respond }
}
