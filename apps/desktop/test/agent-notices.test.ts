import { describe, expect, it } from 'vitest'
import {
  agentIndicator,
  agentThemeNote,
  sessionsWorthAsking,
} from '../src/renderer/src/lib/agent-notices'

describe('agentThemeNote', () => {
  it('says nothing when there is no session to be stale', () => {
    expect(agentThemeNote({ running: false, modeAtSpawn: 'dark', mode: 'light' })).toBeNull()
  })

  it('says nothing before a session has ever recorded a mode', () => {
    expect(agentThemeNote({ running: true, modeAtSpawn: null, mode: 'light' })).toBeNull()
  })

  it('says nothing while the session and the app agree', () => {
    expect(agentThemeNote({ running: true, modeAtSpawn: 'dark', mode: 'dark' })).toBeNull()
  })

  it('asks for a restart once the app has moved and the session has not', () => {
    // Claude Code reads settings at start, so a live session keeps its theme.
    // A sentence beats an attempt to hot-swap another program's settings.
    expect(agentThemeNote({ running: true, modeAtSpawn: 'dark', mode: 'light' })).toContain(
      'restart',
    )
  })
})

describe('agentIndicator', () => {
  const idle = { state: 'idle' as const, configStale: false, themeNote: null }

  it('is green while a session is live and nothing is happening', () => {
    const live = agentIndicator(idle)
    expect(live.dot).toContain('bg-green-500')
    expect(live.state).toBe('running')
  })

  it('pulses amber while a turn is open', () => {
    const working = agentIndicator({ ...idle, state: 'working' })
    expect(working.dot).toContain('motion-pulse')
    expect(working.dot).toContain('bg-amber-400')
    expect(working.state).toBe('working…')
  })

  it('says what a session is waiting for, because the reason is the whole point', () => {
    // 'needs you' without a reason is a dot that sends you to the terminal to
    // find out. The listing carries it, so the card can print it.
    const waiting = agentIndicator({
      ...idle,
      state: 'needs-you',
      waitingFor: 'permission prompt',
    })
    expect(waiting.state).toBe('needs you')
    expect(waiting.title).toContain('permission prompt')
  })

  it('still says needs you when the listing gives no reason', () => {
    const waiting = agentIndicator({ ...idle, state: 'needs-you' })
    expect(waiting.state).toBe('needs you')
    expect(waiting.title).toContain('waiting for you')
  })

  it('turns amber without pulsing when a live session needs a restart', () => {
    const stale = agentIndicator({ ...idle, configStale: true })
    expect(stale.dot).toContain('bg-amber-400')
    expect(stale.dot).not.toContain('motion-pulse')
    expect(stale.state).toBe('needs restart')
    expect(stale.title).toContain('shared config changed')
  })

  it('carries the theme note as a restart reason too', () => {
    const themed = agentIndicator({ ...idle, themeNote: "restart to change Claude's theme" })
    expect(themed.state).toBe('needs restart')
    expect(themed.title).toContain("Claude's theme")
  })

  it('says both reasons when both apply', () => {
    const both = agentIndicator({
      ...idle,
      configStale: true,
      themeNote: "restart to change Claude's theme",
    })
    expect(both.title).toContain('shared config changed')
    expect(both.title).toContain("Claude's theme")
  })

  // An open turn is the louder, more transient thing; the restart nudge is still
  // true when it ends, and comes back then. A session waiting on YOU outranks
  // both, because nothing moves at all until it is answered.
  it('lets an open turn outrank a restart nudge', () => {
    expect(agentIndicator({ ...idle, state: 'working', configStale: true }).state).toBe('working…')
  })

  it('lets needs-you outrank an open turn', () => {
    expect(agentIndicator({ ...idle, state: 'needs-you', configStale: true }).state).toBe(
      'needs you',
    )
  })

  // Nothing about being out of date means anything once the PTY is gone: the
  // tab is a record of a session that ended, not a thing to restart.
  it('says only that an exited session ended', () => {
    const dead = agentIndicator({ ...idle, exited: true, configStale: true, state: 'working' })
    expect(dead.state).toBe('ended')
    expect(dead.dot).toContain('bg-muted-foreground')
  })

  it('never uses an em dash, which is barred from UI copy', () => {
    const cases = [
      idle,
      { ...idle, state: 'working' as const },
      { ...idle, state: 'needs-you' as const, waitingFor: 'permission prompt' },
      { ...idle, configStale: true },
      { ...idle, exited: true },
    ]
    for (const args of cases) expect(agentIndicator(args).title).not.toContain('—')
  })
})

describe('sessionsWorthAsking', () => {
  const live = (state: 'needs-you' | 'working' | 'idle', exited = false) => ({
    state,
    configStale: false,
    exited,
  })

  it('is empty when every session is idle', () => {
    // A switch still ends them. An idle conversation ends quietly and comes
    // back with Resume, so there is nothing to stop for.
    expect(sessionsWorthAsking([live('idle'), live('idle')])).toEqual([])
  })

  it('keeps a session that is mid-turn', () => {
    expect(sessionsWorthAsking([live('idle'), live('working')])).toHaveLength(1)
  })

  it('keeps a session that is waiting on you', () => {
    expect(sessionsWorthAsking([live('needs-you')])).toHaveLength(1)
  })

  it('ignores one that has already exited, whatever it was doing', () => {
    expect(sessionsWorthAsking([live('working', true)])).toEqual([])
  })
})
