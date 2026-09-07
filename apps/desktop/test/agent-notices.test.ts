import { describe, expect, it } from 'vitest'
import { agentIndicator, agentThemeNote } from '../src/renderer/src/lib/agent-notices'

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
  const idle = { running: false, working: false, configStale: false, themeNote: null }

  it('is muted and says how to get a session when there is none', () => {
    const it_ = agentIndicator(idle)
    expect(it_.dot).toContain('bg-muted-foreground')
    expect(it_.state).toBe('idle')
    expect(it_.title).toContain('no session')
  })

  it('is green while a session is live and nothing is happening', () => {
    const live = agentIndicator({ ...idle, running: true })
    expect(live.dot).toContain('bg-green-500')
    expect(live.state).toBe('running')
  })

  it('pulses amber while a turn is open', () => {
    const working = agentIndicator({ ...idle, running: true, working: true })
    expect(working.dot).toContain('animate-pulse')
    expect(working.dot).toContain('bg-amber-400')
    expect(working.state).toBe('working…')
  })

  it('turns amber without pulsing when a live session needs a restart', () => {
    const stale = agentIndicator({ ...idle, running: true, configStale: true })
    expect(stale.dot).toContain('bg-amber-400')
    expect(stale.dot).not.toContain('animate-pulse')
    expect(stale.state).toBe('needs restart')
    expect(stale.title).toContain('shared config changed')
  })

  it('carries the theme note as a restart reason too', () => {
    const themed = agentIndicator({ ...idle, running: true, themeNote: "restart to change Claude's theme" })
    expect(themed.state).toBe('needs restart')
    expect(themed.title).toContain("Claude's theme")
  })

  it('says both reasons when both apply', () => {
    const both = agentIndicator({
      ...idle,
      running: true,
      configStale: true,
      themeNote: "restart to change Claude's theme",
    })
    expect(both.title).toContain('shared config changed')
    expect(both.title).toContain("Claude's theme")
  })

  // An open turn is the louder, more transient thing; the restart nudge is still
  // true when it ends, and comes back then.
  it('lets an open turn outrank a restart nudge', () => {
    const busy = agentIndicator({ ...idle, running: true, working: true, configStale: true })
    expect(busy.state).toBe('working…')
  })

  // configStale only means anything under a live session (it is about a session
  // that is now out of date), so it must not paint a dead one amber.
  it('ignores a stale config when no session is running', () => {
    expect(agentIndicator({ ...idle, configStale: true }).state).toBe('idle')
  })

  it('never uses an em dash, which is barred from UI copy', () => {
    for (const args of [idle, { ...idle, running: true }, { ...idle, running: true, working: true }]) {
      expect(agentIndicator(args).title).not.toContain('—')
    }
  })
})
