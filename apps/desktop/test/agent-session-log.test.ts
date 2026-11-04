/** The agent's lines in the activity log: starts, ends and turns, not ticks. */
import { describe, expect, it } from 'vitest'
import { createSessionLog } from '../src/plugins/agent/main/host/session-log'
import type { SessionSummary } from '../src/plugins/agent/main/claude/listing'

const s = (id: string, name: string, state: SessionSummary['state'] = 'idle'): SessionSummary => ({
  id,
  name,
  state,
})

describe('agent session log', () => {
  it('says nothing about what was running at open, then names each start and end', () => {
    const lines: string[] = []
    const log = createSessionLog((level, message) => lines.push(`${level}:${message}`))
    log.sessions([s('a', 'Old one')])
    log.sessions([s('a', 'Old one', 'working')])
    log.sessions([s('a', 'Old one'), s('b', 'Fix links')])
    log.turnEnd('b')
    log.sessions([s('b', 'Fix links')])
    expect(lines).toEqual([
      'info:Session started: Fix links',
      'info:Turn ended: Fix links',
      'info:Session ended: Old one',
    ])
  })
})
