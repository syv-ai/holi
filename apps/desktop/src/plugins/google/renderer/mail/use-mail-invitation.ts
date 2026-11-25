import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useStore } from 'jotai'
import { activeRemoteAtom, activeRemoteRevisionValueAtom, openExternal } from '@/plugin-api'
import { googleAccountRevisionAtom } from '../account'
import { googleCap } from '../google-cap'
import { messageOf } from '../google-errors'

type ReadInput = Parameters<typeof googleCap.mailInvitation>[1]
type ReadResult = Awaited<ReturnType<typeof googleCap.mailInvitation>>
export type Invitation = ReadResult['invitations'][number]
export type InvitationAnswer = Parameters<typeof googleCap.respondToMailInvitation>[1]['answer']
type Receipt = 'sent' | 'uncertain' | 'unchanged'

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
  refreshPending: boolean
}

interface InvitationState {
  cards: InvitationCardState[]
  busy: 'reading' | { action: 'responding' | 'opening'; key: string } | null
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
}: ReadInput & { remote: string; remoteRevision: number; accountRevision: number }) {
  const store = useStore()
  const owner = useRef<object | null>(null)
  const currentCards = useRef<InvitationCardState[]>([])
  const flight = useRef(false)
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
      flight.current = false
    }
  }, [])

  // Do not readmit an action until its result and disabled state have committed.
  useLayoutEffect(() => {
    currentCards.current = state.cards
    if (state.busy === null) flight.current = false
  }, [state])

  const ownsReader = useCallback(
    () =>
      owner.current !== null &&
      store.get(activeRemoteAtom) === remote &&
      store.get(activeRemoteRevisionValueAtom) === remoteRevision &&
      store.get(googleAccountRevisionAtom) === accountRevision,
    [store, remote, remoteRevision, accountRevision],
  )

  const begin = useCallback(() => {
    const lifetime = owner.current
    if (!ownsReader() || flight.current) return null
    flight.current = true
    return () => owner.current === lifetime && ownsReader()
  }, [ownsReader])

  const read = useCallback(async () => {
    const request = begin()
    if (request === null) return
    setState((previous) => ({ ...previous, busy: 'reading', readError: null }))
    try {
      const { invitations, recoveryReason } = await googleCap.mailInvitation(remote, {
        threadId,
        expectedAccountSub,
      })
      if (!request()) return
      setState((previous) => {
        const receipts = new Map(previous.cards.map((card) => [card.key, card.receipt]))
        return {
          cards: invitations.map((invitation) => {
            const key = cardKey(invitation)
            return {
              key,
              invitation,
              error: null,
              receipt: receipts.get(key) ?? null,
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
  }, [begin, remote, threadId, expectedAccountSub])

  useEffect(() => {
    void read()
  }, [read])

  const respond = async (card: InvitationCardState, answer: InvitationAnswer) => {
    const { key, invitation } = card
    if (
      invitation.kind !== 'invitation' ||
      !invitation.canRespond ||
      invitation.cancelled ||
      invitation.responseStatus === answer ||
      state.busy !== null ||
      state.readError !== null ||
      card.refreshPending ||
      card.error !== null
    )
      return
    const request = begin()
    if (request === null) return
    const updateCard = (
      busy: InvitationState['busy'],
      update: (current: InvitationCardState) => InvitationCardState,
    ) =>
      setState((previous) => ({
        ...previous,
        busy,
        cards: previous.cards.map((current) => (current.key === key ? update(current) : current)),
      }))
    updateCard({ action: 'responding', key }, (current) => ({ ...current, receipt: null }))
    try {
      const result = await googleCap.respondToMailInvitation(remote, {
        threadId,
        expectedAccountSub,
        expectedBindingRevision: invitation.bindingRevision,
        identity: invitation.identity,
        answer,
      })
      if (!request()) return
      const updated = result.invitation
      const sameRevision = updated === null || cardKey(updated) === key
      updateCard(null, (current) => ({
        ...current,
        invitation: sameRevision && updated !== null ? updated : current.invitation,
        receipt: sameRevision ? result.outcome : null,
        refreshPending:
          !sameRevision ||
          result.refreshPending ||
          result.outcome === 'uncertain' ||
          updated?.responsePending === true,
      }))
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
    }
  }

  const openLink = async (card: InvitationCardState, url: string) => {
    if (
      state.busy !== null ||
      state.readError !== null ||
      card.error !== null ||
      !currentCards.current.includes(card)
    )
      return
    const request = begin()
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
