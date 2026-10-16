/**
 * A session's conversation for its chat: main reads Claude Code's transcript
 * (`main/claude/transcript/`) and the chat asks for what is new, often while
 * a turn runs and seldom while nothing is happening. What it reads is kept as
 * entries and folded into items (`fold.ts`) only when something new arrived.
 */
import { useAtomValue } from 'jotai'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { activeRemoteAtom } from '@/plugin-api'
import { agentCap, type TranscriptChunk } from '../agent-cap'
import { parseQuestions, pendingQuestions, type AskQuestion } from '../lib/ask'
import { failure } from '../state/send'
import { foldEntries, type Folded } from './fold'
import type { ChatContext, ChatEntry, ChatItem, TaskState } from './items'

export type { ChatItem } from './items'

/** The entries as the chat draws them: each result folded into its call. Pure. */
export function toChatItems(entries: readonly ChatEntry[]): ChatItem[] {
  return foldEntries(entries).items
}

const BUSY_MS = 900
const QUIET_MS = 2500

/** What a read could not place, summed over every part read so far. */
export interface DriftSummary {
  /** Lines of the conversation this reader has no rule for, by signature. */
  unknownShapes: { shape: string; count: number }[]
  /** Lines read in all. */
  total: number
  /** Lines too large to parse, or not JSON. */
  oversize: number
  unparseable: number
}

const NO_DRIFT: DriftSummary = { unknownShapes: [], total: 0, oversize: 0, unparseable: 0 }

interface Report {
  lines: number
  unknown: { shape: string; count: number }[]
  oversize: number
  unparseable: number
}

function addDrift(sum: DriftSummary, report: Report | undefined): DriftSummary {
  if (report === undefined) return sum
  const shapes = new Map(sum.unknownShapes.map((u) => [u.shape, u.count]))
  for (const u of report.unknown) shapes.set(u.shape, (shapes.get(u.shape) ?? 0) + u.count)
  return {
    unknownShapes: [...shapes].map(([shape, count]) => ({ shape, count })),
    total: sum.total + report.lines,
    oversize: sum.oversize + report.oversize,
    unparseable: sum.unparseable + report.unparseable,
  }
}

/** A growing run of entries with no `kind:id` twice: a re-read (after a
 *  resume, say) must not repeat what is already there. */
class Entries {
  list: ChatEntry[] = []
  private keys = new Set<string>()

  private fresh(entries: readonly ChatEntry[]): ChatEntry[] {
    const out: ChatEntry[] = []
    for (const entry of entries) {
      const key = `${entry.kind}:${entry.id}`
      if (this.keys.has(key)) continue
      this.keys.add(key)
      out.push(entry)
    }
    return out
  }

  /** Adds to the end; whether anything was new. */
  append(entries: readonly ChatEntry[]): boolean {
    const fresh = this.fresh(entries)
    if (fresh.length === 0) return false
    this.list = this.list.concat(fresh)
    return true
  }

  /** Adds to the start (an earlier part of the file). */
  prepend(entries: readonly ChatEntry[]): boolean {
    const fresh = this.fresh(entries)
    if (fresh.length === 0) return false
    this.list = fresh.concat(this.list)
    return true
  }
}

/** One conversation as read so far; replaced whole by a `/clear`. */
interface Store {
  entries: Entries
  /** The last fold, and whether entries came since. */
  folded: Folded | undefined
  dirty: boolean
  /** Where the first read began in the file; 0, nothing earlier. */
  start: number | undefined
  drift: DriftSummary
  /** The read of an earlier part now running, if one is. */
  earlier: Promise<void> | null
  /** Counts the times the file turned out to be another one (rewritten, or a
   *  `/clear`): a read begun in an earlier epoch is not added. */
  epoch: number
}

const newStore = (): Store => ({
  entries: new Entries(),
  folded: undefined,
  dirty: false,
  start: undefined,
  drift: NO_DRIFT,
  earlier: null,
  epoch: 0,
})

interface Snapshot {
  items: ChatItem[]
  tasks: ReadonlyMap<string, TaskState>
  loaded: boolean
  error: string | null
  drift: DriftSummary
  start: number | undefined
  loadingEarlier: boolean
}

const EMPTY_TASKS: ReadonlyMap<string, TaskState> = new Map()
const INITIAL: Snapshot = {
  items: [],
  tasks: EMPTY_TASKS,
  loaded: false,
  error: null,
  drift: NO_DRIFT,
  start: undefined,
  loadingEarlier: false,
}

/** Most reads, and most entries, one sub-agent's conversation may take. */
const SUBAGENT_READS = 20
const SUBAGENT_ENTRIES = 20_000

interface Subagent {
  entries: Entries
  /** Undefined until the first read, which takes the bounded tail of the file. */
  offset: number | undefined
  fingerprint: string | undefined
  folded: Folded | undefined
  items: ChatItem[]
  inflight: Promise<ChatItem[] | null> | null
}

export function useTranscript(
  sessionId: string,
  busy: boolean,
): {
  items: ChatItem[]
  /** The agent's own task list, as its calls left it. */
  tasks: ReadonlyMap<string, TaskState>
  loaded: boolean
  /** Why the conversation cannot be read, when it cannot. */
  error: string | null
  /** Look now rather than at the next tick: something was just sent. */
  refresh: () => void
  /** What the reader could not place in the lines read so far. */
  drift: DriftSummary
  /** There is an earlier part of the file than what is shown. */
  canLoadEarlier: boolean
  loadingEarlier: boolean
  /** Reads the part before what is shown, one at a time. */
  loadEarlier: () => Promise<void>
  /** A sub-agent's conversation, or null when it cannot be read. */
  loadSubagent: (agentId: string) => Promise<ChatItem[] | null>
  /** What a row needs beyond its own item; stable until it changes. */
  ctx: ChatContext
} {
  const remote = useAtomValue(activeRemoteAtom)
  const [snap, setSnap] = useState<Snapshot>(INITIAL)
  const busyRef = useRef(busy)
  busyRef.current = busy
  const kick = useRef<() => void>(() => {})
  const store = useRef<Store>(newStore())
  const subagents = useRef(new Map<string, Subagent>())
  const earlierRef = useRef<() => Promise<void>>(() => Promise.resolve())
  const subagentRef = useRef<(agentId: string) => Promise<ChatItem[] | null>>(() =>
    Promise.resolve(null),
  )

  useEffect(() => {
    const mine = (store.current = newStore())
    subagents.current = new Map()
    setSnap(INITIAL)
    if (remote === null) return
    let cancelled = false
    let reading = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let offset: number | undefined
    let conversation: string | null = null
    /** Shows what is read, folding only if entries came since the last. */
    const publish = (error: string | null): void => {
      if (mine.folded === undefined || mine.dirty) {
        mine.folded = foldEntries(mine.entries.list, mine.folded?.cache)
        mine.dirty = false
      }
      const { items, tasks } = mine.folded
      setSnap({
        items,
        tasks,
        loaded: true,
        error,
        drift: mine.drift,
        start: mine.start,
        loadingEarlier: mine.earlier !== null,
      })
    }
    let shown: string | null | undefined
    let fingerprint: string | undefined
    /** Forgets everything read: the file is another one. */
    const forget = (): void => {
      mine.epoch += 1
      mine.entries = new Entries()
      mine.folded = undefined
      mine.dirty = false
      mine.start = undefined
      mine.drift = NO_DRIFT
      subagents.current = new Map()
    }
    /** Takes in one read. Returns the wait before the next, in ms. */
    const apply = (chunk: TranscriptChunk | null, error: string | null): number => {
      if (chunk !== null && conversation !== null && chunk.sessionId !== conversation) {
        // A `/clear`: another conversation, read from its start.
        conversation = null
        offset = undefined
        fingerprint = undefined
        forget()
        shown = undefined
        setSnap(INITIAL)
        return 0
      }
      let added = false
      if (chunk !== null) {
        if (chunk.reset === true) {
          // The file was rewritten: what was read is no longer in it.
          forget()
          shown = undefined
          added = true
        }
        conversation = chunk.sessionId
        offset = chunk.offset
        fingerprint = chunk.fingerprint
        if (mine.start === undefined) mine.start = chunk.start ?? 0
        mine.drift = addDrift(mine.drift, chunk.drift)
        added = mine.entries.append(chunk.entries) || added
      }
      if (added) mine.dirty = true
      if (added || shown === undefined || shown !== error) {
        shown = error
        publish(error)
      }
      return busyRef.current ? BUSY_MS : QUIET_MS
    }
    const tick = async (): Promise<void> => {
      if (reading) return
      reading = true
      let error: string | null = null
      let chunk: TranscriptChunk | null = null
      try {
        chunk = await agentCap.transcript(remote, {
          id: sessionId,
          ...(offset === undefined ? {} : { offset }),
          ...(offset === undefined || fingerprint === undefined ? {} : { fingerprint }),
        })
      } catch (err: unknown) {
        error = failure(err)
      } finally {
        reading = false
      }
      if (cancelled) return
      // Whatever goes wrong in showing a read, the next look is still booked.
      let wait = busyRef.current ? BUSY_MS : QUIET_MS
      try {
        wait = apply(chunk, error)
      } catch (err: unknown) {
        shown = undefined
        try {
          setSnap((prev) => ({ ...prev, loaded: true, error: failure(err) }))
        } catch {
          // Nothing more can be done for this look.
        }
      }
      if (!cancelled) timer = setTimeout(() => void tick(), wait)
    }
    kick.current = () => {
      if (timer !== undefined) clearTimeout(timer)
      void tick()
    }
    earlierRef.current = () => {
      if (mine.earlier !== null) return mine.earlier
      if (mine.start === undefined || mine.start <= 0) return Promise.resolve()
      const epoch = mine.epoch
      const run = async (): Promise<void> => {
        try {
          const chunk = await agentCap.transcriptEarlier(remote, {
            id: sessionId,
            before: mine.start ?? 0,
          })
          if (cancelled || store.current !== mine || mine.epoch !== epoch) return
          if (chunk === null) mine.start = 0
          else {
            mine.start = chunk.start
            mine.drift = addDrift(mine.drift, chunk.drift)
            if (mine.entries.prepend(chunk.entries)) mine.dirty = true
          }
        } catch {
          // Left as it was: asking again tries again.
        }
        mine.earlier = null
        if (cancelled || store.current !== mine) return
        try {
          publish(shown ?? null)
        } catch {
          // The part is kept; the next look shows it.
        }
      }
      mine.earlier = run()
      setSnap((prev) => ({ ...prev, loadingEarlier: true }))
      return mine.earlier
    }
    subagentRef.current = async (agentId) => {
      let sub = subagents.current.get(agentId)
      if (sub === undefined) {
        sub = {
          entries: new Entries(),
          offset: undefined,
          fingerprint: undefined,
          folded: undefined,
          items: [],
          inflight: null,
        }
        subagents.current.set(agentId, sub)
      }
      const state = sub
      // Asked again while a read runs: the same read answers both.
      state.inflight ??= (async (): Promise<ChatItem[] | null> => {
        try {
          let any = state.entries.list.length > 0
          for (let reads = 0; reads < SUBAGENT_READS; reads++) {
            // The first read has no offset: main takes the bounded tail of a
            // big file. After it, the file is read on from where it ended.
            const chunk = await agentCap.subagent(remote, {
              id: sessionId,
              agentId,
              ...(state.offset === undefined ? {} : { offset: state.offset }),
              ...(state.offset === undefined || state.fingerprint === undefined
                ? {}
                : { fingerprint: state.fingerprint }),
            })
            if (cancelled) return null
            if (chunk === null) return any ? state.items : null
            any = true
            if (chunk.reset === true) {
              // Its file was rewritten: start over from this read.
              state.entries = new Entries()
              state.folded = undefined
              state.items = []
            }
            state.fingerprint = chunk.fingerprint
            const grew = state.entries.append(chunk.entries) || chunk.reset === true
            const moved = chunk.offset !== state.offset
            state.offset = chunk.offset
            if (!grew || !moved || state.entries.list.length >= SUBAGENT_ENTRIES) break
          }
          if (cancelled) return null
          state.folded = foldEntries(state.entries.list, state.folded?.cache)
          state.items = state.folded.items
          return state.items
        } catch {
          return null
        } finally {
          state.inflight = null
        }
      })()
      return state.inflight
    }
    void tick()
    return () => {
      cancelled = true
      kick.current = () => {}
      earlierRef.current = () => Promise.resolve()
      subagentRef.current = () => Promise.resolve(null)
      if (timer !== undefined) clearTimeout(timer)
    }
  }, [remote, sessionId])

  // A turn starting or ending is worth a look at once, not at the next tick.
  useEffect(() => kick.current(), [busy])

  const refresh = useCallback(() => kick.current(), [])
  const loadEarlier = useCallback(() => earlierRef.current(), [])
  const loadSubagent = useCallback((agentId: string) => subagentRef.current(agentId), [])
  const ctx = useMemo<ChatContext>(
    () => ({ tasks: snap.tasks, loadSubagent, sessionId }),
    [snap.tasks, loadSubagent, sessionId],
  )
  return {
    items: snap.items,
    tasks: snap.tasks,
    loaded: snap.loaded,
    error: snap.error,
    refresh,
    drift: snap.drift,
    canLoadEarlier: snap.start !== undefined && snap.start > 0,
    loadingEarlier: snap.loadingEarlier,
    loadEarlier,
    loadSubagent,
    ctx,
  }
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
