/**
 * A session as a face: a round head in a colour of its own, two eyes, and the
 * status dot every other place shows for it (`agentIndicator`). The eyes say
 * the state too (`overview.css`): a slow blink at rest, quick and glancing
 * while it works, held wide while it waits on you, shut for no session.
 */
import './overview.css'
import { cn } from '@/plugin-api'
import { agentIndicator } from '../../agent/renderer/lib/notices'
import type { SessionState } from '../../agent/renderer/state/sessions'

/** The heads. A session keeps its colour for as long as it has its id. */
const HEADS = [
  'bg-emerald-400',
  'bg-amber-400',
  'bg-rose-400',
  'bg-violet-400',
  'bg-sky-400',
  'bg-pink-400',
  'bg-teal-400',
  'bg-orange-400',
] as const

/** Which head `seed` gets: the same one every time. */
export function headOf(seed: string): (typeof HEADS)[number] {
  let hash = 0
  for (const ch of seed) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0
  return HEADS[hash % HEADS.length]!
}

export function AgentFace({
  seed,
  state,
  waitingFor,
  phase,
  size = 'sm',
  muted = false,
}: {
  /** What picks the colour: the session's id. */
  seed: string
  /** `off` is no session: the eyes are shut and there is no dot. */
  state: SessionState | 'off'
  waitingFor?: string
  /** Only for an idle session: what it has behind it. */
  phase?: 'new' | 'done' | 'failed'
  size?: 'sm' | 'md' | 'lg'
  /** A session that has finished: with `off`, its own colour dimmed and the
   *  eyes shut, rather than no session's grey. */
  muted?: boolean
}): React.JSX.Element {
  const large = size === 'lg'
  const medium = size === 'md'
  const dot = state === 'off' ? null : agentIndicator({ state, waitingFor, phase }).dot
  return (
    <span
      aria-hidden="true"
      data-state={state}
      className={cn(
        'agent-face relative inline-flex shrink-0 items-center justify-center rounded-full',
        state === 'off' && !muted ? 'bg-muted' : headOf(seed),
        large ? 'size-24' : medium ? 'size-10' : 'size-7',
        muted && 'opacity-55 saturate-50',
      )}
    >
      <span
        className={cn(
          'agent-face-eyes flex items-center',
          large ? 'gap-4' : medium ? 'gap-1.5' : 'gap-1',
        )}
      >
        {[0, 1].map((eye) => (
          <span
            key={eye}
            className={cn(
              'agent-face-eye rounded-full',
              state === 'off' && !muted ? 'bg-muted-foreground' : 'bg-neutral-950/85',
              large ? 'h-7 w-3' : medium ? 'h-3 w-1.5' : 'h-2 w-1',
            )}
          />
        ))}
      </span>
      {dot !== null && (
        <span
          className={cn(
            'absolute top-0 left-0 rounded-full ring-2 ring-background',
            dot,
            large ? 'size-4' : medium ? 'size-3' : 'size-2',
          )}
        />
      )}
    </span>
  )
}
