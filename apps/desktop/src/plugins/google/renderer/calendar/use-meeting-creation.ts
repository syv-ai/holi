/** A sheet owns its async results. Closing, switching account/vault or opening
 * another sheet invalidates them. Loading and recovery only read; sending is
 * exclusively an explicit button action, with the submitted payload frozen. */
import { useCallback, useEffect, useRef, useState } from 'react'
import { googleCap } from '../google-cap'
import { messageOf } from '../google-errors'

type MeetingInput = Parameters<typeof googleCap.createMeeting>[1]
type MeetingOperation = Awaited<ReturnType<typeof googleCap.createMeeting>>

export interface MeetingIdentity {
  remote: string
  sub: string
}

export function useMeetingCreation(identity: MeetingIdentity | null, onCreated: () => void) {
  const [loading, setLoading] = useState(identity !== null)
  const [busy, setBusy] = useState(false)
  const [supported, setSupported] = useState(false)
  const [operation, setOperation] = useState<MeetingOperation | null>(null)
  const [submitted, setSubmitted] = useState<MeetingInput | null>(null)
  const [error, setError] = useState<string | null>(null)
  const live = useRef(false)
  const flight = useRef(false)
  const loadEpoch = useRef(0)
  const operationId = useRef<string | null>(null)
  const onCreatedRef = useRef(onCreated)
  onCreatedRef.current = onCreated
  const remote = identity?.remote
  const sub = identity?.sub

  const load = useCallback(async () => {
    if (!remote || !sub || flight.current) return
    const epoch = ++loadEpoch.current
    const current = () => live.current && epoch === loadEpoch.current
    setLoading(true)
    setError(null)
    try {
      const state = await googleCap.meetingState(remote, { sub })
      if (!current()) return
      setSupported(state.meetSupported)
      setOperation(state.operation)
      setSubmitted(state.operation?.input ?? null)
      operationId.current = state.operation?.input.operation ?? null
    } catch (err) {
      if (current()) setError(messageOf(err, 'Could not read meeting options.'))
    } finally {
      if (current()) setLoading(false)
    }
  }, [remote, sub])

  useEffect(() => {
    live.current = true
    void load()
    return () => {
      live.current = false
      loadEpoch.current += 1
    }
  }, [load])

  const submit = async (fields: Omit<MeetingInput, 'operation' | 'sub'>) => {
    if (!remote || !sub || loading || flight.current) return
    flight.current = true
    loadEpoch.current += 1
    setBusy(true)
    setError(null)
    operationId.current ??= crypto.randomUUID()
    const input = submitted ?? { ...fields, sub, operation: operationId.current }
    setSubmitted(input)
    try {
      const result = await googleCap.createMeeting(remote, input)
      if (!live.current) return
      setOperation(result)
      if (result.accepted) onCreatedRef.current()
    } catch (err) {
      if (!live.current) return
      setError(messageOf(err, 'Could not create the meeting. Check status before retrying.'))
      // A refusal before journalling may be edited; a persisted intent may not.
      try {
        const state = await googleCap.meetingState(remote, { sub })
        if (live.current) {
          setOperation(state.operation)
          setSubmitted(state.operation?.input ?? null)
        }
      } catch {
        /* unknown: retain the frozen payload */
      }
    } finally {
      flight.current = false
      if (live.current) setBusy(false)
    }
  }

  const check = async () => {
    if (!remote || !sub || flight.current) return
    flight.current = true
    loadEpoch.current += 1
    setBusy(true)
    setError(null)
    try {
      const result = await googleCap.checkMeeting(remote, { sub })
      if (!live.current) return
      setOperation(result)
      if (result) setSubmitted(result.input)
      if (result?.accepted) onCreatedRef.current()
    } catch (err) {
      if (live.current) setError(messageOf(err, 'Could not check the meeting.'))
    } finally {
      flight.current = false
      if (live.current) setBusy(false)
    }
  }

  const finish = async (close: () => void) => {
    if (!remote || !sub || !operation?.accepted || flight.current) return
    flight.current = true
    loadEpoch.current += 1
    setBusy(true)
    try {
      await googleCap.finishMeeting(remote, { sub, operation: operation.input.operation })
      if (live.current) close()
    } catch (err) {
      if (live.current) setError(messageOf(err, 'Could not dismiss the meeting.'))
    } finally {
      flight.current = false
      if (live.current) setBusy(false)
    }
  }
  return { loading, busy, supported, operation, submitted, error, load, submit, check, finish }
}
