import { describe, expect, it } from 'vitest'
import { agentThemeNote } from '../src/renderer/src/lib/agent-notices'

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
