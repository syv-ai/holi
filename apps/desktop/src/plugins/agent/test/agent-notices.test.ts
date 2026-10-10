import { CircleAlert, Hand, MessageCircleQuestionMark } from 'lucide-react'
import { describe, expect, it } from 'vitest'
import {
  agentIndicator,
  contextColour,
  needsYouIcon,
  sessionsWorthAsking,
} from '../renderer/lib/notices'

describe('agentIndicator', () => {
  const idle = { state: 'idle' as const }

  it('is green while a session is live and nothing is happening', () => {
    const live = agentIndicator(idle)
    expect(live.dot).toContain('bg-agent-done')
    expect(live.state).toBe('running')
  })

  it('pulses amber while a turn is open', () => {
    const working = agentIndicator({ state: 'working' })
    expect(working.dot).toContain('motion-pulse')
    expect(working.dot).toContain('bg-agent-working')
    expect(working.state).toBe('working…')
  })

  it('says what a session is waiting for, because the reason is the whole point', () => {
    // 'needs you' without a reason is a dot that sends you to the terminal to
    // find out. The listing carries it, so the row can print it.
    const waiting = agentIndicator({ state: 'needs-you', waitingFor: 'permission prompt' })
    expect(waiting.state).toBe('needs you')
    expect(waiting.title).toContain('permission prompt')
  })

  it('still says needs you when the listing gives no reason', () => {
    const waiting = agentIndicator({ state: 'needs-you' })
    expect(waiting.state).toBe('needs you')
    expect(waiting.title).toContain('waiting for you')
  })

  it('never uses an em dash, which is barred from UI copy', () => {
    const cases = [
      idle,
      { state: 'working' as const },
      { state: 'needs-you' as const, waitingFor: 'permission prompt' },
    ]
    for (const args of cases) expect(agentIndicator(args).title).not.toContain('—')
  })
})

describe('sessionsWorthAsking', () => {
  const live = (state: 'needs-you' | 'working' | 'idle') => ({ state })

  it('is empty when every session is idle', () => {
    // Stopping still happens. An idle conversation stops quietly and picks up
    // again from the agents list, so there is nothing to ask about.
    expect(sessionsWorthAsking([live('idle'), live('idle')])).toEqual([])
  })

  it('keeps a session that is mid-turn', () => {
    expect(sessionsWorthAsking([live('idle'), live('working')])).toHaveLength(1)
  })

  it('keeps a session that is waiting on you', () => {
    expect(sessionsWorthAsking([live('needs-you')])).toHaveLength(1)
  })
})

describe('contextColour', () => {
  it("is the row's muted text below 60%", () => {
    expect(contextColour(0)).toBeNull()
    expect(contextColour(59)).toBeNull()
  })

  it('ramps from amber at 60% to full red at 99%, and stays red past it', () => {
    expect(contextColour(60)).toBe(
      'color-mix(in oklab, var(--context-full) 0%, var(--context-warm))',
    )
    expect(contextColour(80)).toContain('var(--context-full) 51%')
    expect(contextColour(99)).toContain('var(--context-full) 100%')
    expect(contextColour(100)).toContain('var(--context-full) 100%')
  })
})

describe('needsYouIcon', () => {
  it('maps the reasons Claude Code reports', () => {
    expect(needsYouIcon('permission prompt')).toBe(Hand)
    expect(needsYouIcon('input needed')).toBe(MessageCircleQuestionMark)
  })

  it('falls back to a generic icon for free text or no reason', () => {
    expect(needsYouIcon('Tea or coffee?')).toBe(CircleAlert)
    expect(needsYouIcon('toString')).toBe(CircleAlert)
    expect(needsYouIcon(undefined)).toBe(CircleAlert)
  })
})
