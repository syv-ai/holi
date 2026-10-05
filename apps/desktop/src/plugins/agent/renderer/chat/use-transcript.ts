/**
 * A session's conversation for its chat: main reads Claude Code's transcript
 * (`main/claude/transcript.ts`) and the chat asks for what is new, often while
 * a turn runs and seldom while nothing is happening.
 */
import { useAtomValue } from 'jotai'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { activeRemoteAtom } from '@/plugin-api'
import { agentCap, type ChatEntry } from '../agent-cap'
import { parseQuestions, pendingQuestions, type AskQuestion } from '../lib/ask'
import { failure } from '../state/send'

/** One thing the chat draws: a message, or a tool call with its result once
 *  it has one. */
export type ChatItem =
  | { kind: 'user'; id: string; text: string; images?: number }
  | { kind: 'assistant'; id: string; text: string }
  | {
      kind: 'tool'
      id: string
      name: string
      summary: string
      input: string
      result?: { ok: boolean; text: string }
    }

/** The entries as the chat draws them: each result folded into its call. Pure. */
export function toChatItems(entries: readonly ChatEntry[]): ChatItem[] {
  const items: ChatItem[] = []
  const tools = new Map<string, Extract<ChatItem, { kind: 'tool' }>>()
  const seen = new Set<string>()
  for (const entry of entries) {
    if (entry.kind === 'tool-result') {
      const tool = tools.get(entry.id)
      if (tool !== undefined) tool.result = { ok: entry.ok, text: entry.text }
      continue
    }
    const key = `${entry.kind}:${entry.id}`
    if (seen.has(key)) continue
    seen.add(key)
    if (entry.kind === 'tool') {
      const tool = { ...entry }
      tools.set(entry.id, tool)
      items.push(tool)
    } else items.push(entry)
  }
  return items
}

const BUSY_MS = 900
const QUIET_MS = 2500

export function useTranscript(
  sessionId: string,
  busy: boolean,
): {
  items: ChatItem[]
  loaded: boolean
  /** Why the conversation cannot be read, when it cannot. */
  error: string | null
  /** Look now rather than at the next tick: something was just sent. */
  refresh: () => void
} {
  const remote = useAtomValue(activeRemoteAtom)
  const [state, setState] = useState<{
    entries: ChatEntry[]
    loaded: boolean
    error: string | null
  }>({ entries: [], loaded: false, error: null })
  const busyRef = useRef(busy)
  busyRef.current = busy
  const kick = useRef<() => void>(() => {})

  useEffect(() => {
    setState({ entries: [], loaded: false, error: null })
    if (remote === null) return
    let cancelled = false
    let reading = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let offset: number | undefined
    let conversation: string | null = null
    const tick = async (): Promise<void> => {
      if (reading) return
      reading = true
      let error: string | null = null
      const chunk = await agentCap
        .transcript(remote, { id: sessionId, ...(offset === undefined ? {} : { offset }) })
        .catch((err: unknown) => {
          error = failure(err)
          return null
        })
      reading = false
      if (cancelled) return
      if (chunk !== null && conversation !== null && chunk.sessionId !== conversation) {
        // A `/clear`: another conversation, read from its start.
        conversation = null
        offset = undefined
        setState({ entries: [], loaded: false, error: null })
        timer = setTimeout(() => void tick(), 0)
        return
      }
      if (chunk !== null) {
        conversation = chunk.sessionId
        offset = chunk.offset
      }
      const fresh = chunk?.entries ?? []
      setState((prev) =>
        fresh.length === 0 && prev.loaded && prev.error === error
          ? prev
          : {
              entries: fresh.length === 0 ? prev.entries : [...prev.entries, ...fresh],
              loaded: true,
              error,
            },
      )
      timer = setTimeout(() => void tick(), busyRef.current ? BUSY_MS : QUIET_MS)
    }
    kick.current = () => {
      if (timer !== undefined) clearTimeout(timer)
      void tick()
    }
    void tick()
    return () => {
      cancelled = true
      kick.current = () => {}
      if (timer !== undefined) clearTimeout(timer)
    }
  }, [remote, sessionId])

  // A turn starting or ending is worth a look at once, not at the next tick.
  useEffect(() => kick.current(), [busy])

  const items = useMemo(() => toChatItems(state.entries), [state.entries])
  const refresh = useCallback(() => kick.current(), [])
  return { items, loaded: state.loaded, error: state.error, refresh }
}

const QUESTION_MS = 1000

/**
 * The question a session waits on when its call is not in the transcript:
 * Claude Code can hold it in the job record alone. Asked each second while
 * `wanted`, and forgotten once it is not.
 */
export function useBlockedQuestion(sessionId: string, wanted: boolean): string | null {
  const remote = useAtomValue(activeRemoteAtom)
  const [question, setQuestion] = useState<string | null>(null)
  useEffect(() => {
    if (!wanted || remote === null) {
      setQuestion(null)
      return
    }
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const tick = async (): Promise<void> => {
      const json = await agentCap.question(remote, { id: sessionId }).catch(() => null)
      if (cancelled) return
      setQuestion(json)
      timer = setTimeout(() => void tick(), QUESTION_MS)
    }
    void tick()
    return () => {
      cancelled = true
      if (timer !== undefined) clearTimeout(timer)
    }
  }, [remote, sessionId, wanted])
  return question
}

/** The open question of a session that needs you: from the transcript, else
 *  from the job record. Null when there is none this can read. */
export function useQuestions(
  sessionId: string,
  items: readonly ChatItem[],
  needsYou: boolean,
): AskQuestion[] | null {
  const inTranscript = pendingQuestions(items)
  const blocked = useBlockedQuestion(sessionId, needsYou && inTranscript === null)
  return inTranscript ?? (blocked === null ? null : parseQuestions(blocked))
}
