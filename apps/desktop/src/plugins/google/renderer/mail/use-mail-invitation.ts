import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useStore } from 'jotai'
import { activeRemoteAtom, activeRemoteRevisionValueAtom } from '@/plugin-api'
import { googleAccountRevisionAtom } from '../account'
import { googleCap } from '../google-cap'
import { messageOf } from '../google-errors'

type ReadInput = Parameters<typeof googleCap.mailInvitation>[1]
export type Invitation = NonNullable<Awaited<ReturnType<typeof googleCap.mailInvitation>>>
export type InvitationAnswer = Parameters<typeof googleCap.respondToMailInvitation>[1]['answer']
type Meeting = Awaited<ReturnType<typeof googleCap.meeting>>
type Receipt = 'sent' | 'uncertain' | 'unchanged'

function sameInvitation(a: Invitation, b: Invitation): boolean {
  return (
    a.identity.messageId === b.identity.messageId &&
    a.identity.uid === b.identity.uid &&
    a.identity.sequence === b.identity.sequence &&
    a.identity.recurrenceId === b.identity.recurrenceId
  )
}

interface InvitationState {
  invitation: Invitation | null
  meeting: Meeting
  busy: 'reading' | 'responding' | null
  error: string | null
  receipt: Receipt | null
  refreshPending: boolean
}

/** One keyed reader opening owns these results. The store revisions also close
 * the gap between a vault/account transition and React committing the new reader. */
export function useMailInvitation({
  remote,
  remoteRevision,
  accountRevision,
  expectedAccountSub,
  threadId,
}: ReadInput & { remote: string; remoteRevision: number; accountRevision: number }) {
  const store = useStore()
  const owner = useRef<object | null>(null)
  const flight = useRef(false)
  const [state, setState] = useState<InvitationState>({
    invitation: null,
    meeting: null,
    busy: 'reading',
    error: null,
    receipt: null,
    refreshPending: false,
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
    if (state.busy === null) flight.current = false
  }, [state])

  const begin = useCallback(() => {
    const lifetime = owner.current
    const isCurrent = () =>
      lifetime !== null &&
      owner.current === lifetime &&
      store.get(activeRemoteAtom) === remote &&
      store.get(activeRemoteRevisionValueAtom) === remoteRevision &&
      store.get(googleAccountRevisionAtom) === accountRevision
    if (!isCurrent() || flight.current) return null
    flight.current = true
    return isCurrent
  }, [store, remote, remoteRevision, accountRevision])

  const read = useCallback(async () => {
    const request = begin()
    if (request === null) return
    setState((previous) => ({ ...previous, busy: 'reading', error: null }))
    try {
      const invitation = await googleCap.mailInvitation(remote, { threadId, expectedAccountSub })
      if (!request()) return
      // Preserve Join for other calendar mail (e.g. the organizer's sent
      // invitation), but never ask for a second match for a recognized invite.
      const meeting =
        invitation === null
          ? await googleCap.meeting(remote, { id: threadId }).catch(() => null)
          : null
      if (!request()) return
      setState((previous) => ({
        invitation,
        meeting,
        busy: null,
        error: null,
        receipt:
          invitation === null ||
          (previous.invitation !== null && sameInvitation(previous.invitation, invitation))
            ? previous.receipt
            : null,
        refreshPending: invitation?.responsePending === true,
      }))
    } catch (error) {
      if (request()) {
        setState((previous) => ({
          ...previous,
          busy: null,
          error: messageOf(error, 'Could not read the invitation.'),
        }))
      }
    }
  }, [begin, remote, threadId, expectedAccountSub])

  useEffect(() => {
    void read()
  }, [read])

  const { invitation } = state
  const respond = async (answer: InvitationAnswer) => {
    if (
      !invitation?.canRespond ||
      invitation.cancelled ||
      invitation.responsePending ||
      invitation.responseStatus === answer ||
      state.busy !== null ||
      state.refreshPending ||
      state.error !== null
    )
      return
    const request = begin()
    if (request === null) return
    setState((previous) => ({ ...previous, busy: 'responding', receipt: null }))
    try {
      const result = await googleCap.respondToMailInvitation(remote, {
        threadId,
        expectedAccountSub,
        identity: invitation.identity,
        answer,
      })
      if (!request()) return
      setState({
        invitation: result.invitation ?? invitation,
        meeting: null,
        busy: null,
        error: null,
        receipt:
          result.invitation === null || sameInvitation(invitation, result.invitation)
            ? result.outcome
            : null,
        refreshPending: result.refreshPending || result.outcome === 'uncertain',
      })
    } catch (error) {
      if (request()) {
        // Even a refused response must be re-read before another explicit RSVP:
        // the invitation or the Calendar copy may have changed.
        setState((previous) => ({
          ...previous,
          busy: null,
          error: messageOf(
            error,
            'Could not confirm your response. Check its status before responding again.',
          ),
        }))
      }
    }
  }

  return { ...state, read, respond }
}
