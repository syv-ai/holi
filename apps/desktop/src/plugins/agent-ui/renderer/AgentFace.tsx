/**
 * A session as an orb: a round body in a colour of its own, two eyes and a
 * mouth in one ink, and a status dot that is the dot of the "i". The face says
 * the state by the shape of its features alone (`overview.css`): ready is
 * neutral, working glances up and to the right with the dot orbiting the rim,
 * done smiles, waiting on you is wide-eyed, failed frowns, no session is a
 * flat line. The eyes follow the pointer and the orb breathes and blinks
 * (`orb-loop.ts`), which is the orb's own idle life, bound to no state.
 */
import './overview.css'
import { useEffect, useRef, type CSSProperties } from 'react'
import { cn } from '@/plugin-api'
import type { SessionState } from '../../agent/renderer/state/sessions'
import {
  BLINK_GAP_MS,
  BLINK_HOLD_MS,
  DOUBLE_BLINK_AFTER_MS,
  DOUBLE_BLINK_CHANCE,
  blinkingOff,
  trackOrb,
} from './orb-loop'

/** The bodies, each with the ink that reads on it. Five that are far apart in
 *  lightness, so neighbours in a stack are told apart at a glance. */
const BODIES = [
  { body: 'var(--session-teal)', ink: 'var(--session-ink)' },
  { body: 'var(--session-mauve)', ink: 'var(--session-ink-light)' },
  { body: 'var(--session-olive)', ink: 'var(--session-ink)' },
  { body: 'var(--session-violet)', ink: 'var(--session-ink-light)' },
  { body: 'var(--session-charcoal)', ink: 'var(--session-ink-light)' },
] as const

const STORE = 'holi.agent-bodies'
/** Which body each session has, handed out in turn the first time a session is
 *  drawn and kept, so a session keeps its colour in every place it shows and
 *  sessions that start one after another are never alike. A hash would put two
 *  neighbours in one colour one time in five. */
const given: Map<string, number> = (() => {
  try {
    return new Map(Object.entries(JSON.parse(localStorage.getItem(STORE) ?? '{}')))
  } catch {
    return new Map()
  }
})() as Map<string, number>
let nextBody = Math.max(-1, ...given.values()) + 1

export function headOf(seed: string): (typeof BODIES)[number] {
  let n = given.get(seed)
  if (n === undefined) {
    n = nextBody++ % BODIES.length
    given.set(seed, n)
    try {
      localStorage.setItem(STORE, JSON.stringify(Object.fromEntries(given)))
    } catch {
      // Private window or blocked storage: it lasts until the app closes.
    }
  }
  return BODIES[n % BODIES.length]!
}

type Mood = 'neutral' | 'happy' | 'alert' | 'working' | 'idle' | 'error'

function moodOf(
  state: SessionState | 'off',
  phase: 'new' | 'done' | 'failed' | undefined,
  muted: boolean,
): Mood {
  if (state === 'off' || muted) return 'idle'
  if (state === 'needs-you') return 'alert'
  if (state === 'working') return 'working'
  if (phase === 'failed') return 'error'
  if (phase === 'done') return 'happy'
  return 'neutral'
}

function dotOf(mood: Mood): string | null {
  switch (mood) {
    case 'alert':
      return 'var(--session-dot-needs-you)'
    case 'working':
      return 'var(--session-dot-working)'
    case 'happy':
      return 'var(--session-dot-done)'
    case 'error':
      return 'var(--session-dot-error)'
    case 'neutral':
      return 'var(--session-dot-ready)'
    case 'idle':
      return null
  }
}

export function AgentFace({
  seed,
  state,
  phase,
  size = 'sm',
  muted = false,
}: {
  /** What picks the colour: the session's id. */
  seed: string
  /** `off` is no session: a flat face and no dot. */
  state: SessionState | 'off'
  waitingFor?: string
  /** Only for an idle session: what it has behind it. */
  phase?: 'new' | 'done' | 'failed'
  size?: 'sm' | 'md' | 'lg'
  /** A session that has finished: with `off`, its own colour dimmed and the
   *  face flat, rather than no session's grey. */
  muted?: boolean
}): React.JSX.Element {
  const mood = moodOf(state, phase, muted)
  const look = headOf(seed)
  const dot = state === 'off' ? null : dotOf(mood)
  const plain = state === 'off' && !muted
  const root = useRef<HTMLSpanElement>(null)
  const head = useRef<HTMLSpanElement>(null)
  const feat = useRef<HTMLSpanElement>(null)

  useEffect(() => {
    const rootEl = root.current
    const headEl = head.current
    const featEl = feat.current
    if (rootEl === null || headEl === null || featEl === null) return
    const stop = trackOrb({
      root: rootEl,
      head: headEl,
      feat: featEl,
      pupils: Array.from(rootEl.querySelectorAll<HTMLElement>('.agent-face-eye')),
    })

    // A blink on its own clock, a random 2.5–6 s apart, one in five doubled.
    const timers = new Set<ReturnType<typeof setTimeout>>()
    const later = (fn: () => void, ms: number): void => {
      const id = setTimeout(() => {
        timers.delete(id)
        fn()
      }, ms)
      timers.add(id)
    }
    const shut = (): void => {
      rootEl.setAttribute('data-blink', '')
      later(() => rootEl.removeAttribute('data-blink'), BLINK_HOLD_MS)
    }
    const next = (): void => {
      const [lo, hi] = BLINK_GAP_MS
      later(() => {
        if (!blinkingOff()) {
          shut()
          if (Math.random() < DOUBLE_BLINK_CHANCE) later(shut, DOUBLE_BLINK_AFTER_MS)
        }
        next()
      }, lo + Math.random() * (hi - lo))
    }
    next()

    return () => {
      stop()
      for (const id of timers) clearTimeout(id)
    }
  }, [])

  return (
    <span
      ref={root}
      aria-hidden="true"
      data-state={state}
      data-mood={mood}
      data-size={size}
      style={
        {
          '--body': plain ? 'var(--muted)' : look.body,
          '--ink': plain ? 'var(--muted-foreground)' : look.ink,
        } as CSSProperties
      }
      className={cn('agent-face', muted && 'opacity-55 saturate-50')}
    >
      <span ref={head} className="agent-face-head">
        <span className="agent-face-body">
          <span ref={feat} className="agent-face-feat">
            {(['l', 'r'] as const).map((eye) => (
              <span key={eye} className="agent-face-lid" data-eye={eye}>
                <span className="agent-face-eye-tilt">
                  <span className="agent-face-eye" />
                </span>
              </span>
            ))}
            <span className="agent-face-mouth">
              <span />
            </span>
          </span>
        </span>
        {dot !== null && (
          <span className={cn('agent-face-orbit', mood === 'working' && 'motion-orbit')}>
            <span className="agent-face-dot" style={{ background: dot }} />
          </span>
        )}
      </span>
    </span>
  )
}
