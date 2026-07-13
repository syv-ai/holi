import { describe, expect, it } from 'vitest'
import {
  clampPanelWidth,
  MIN_AGENT_PANEL_WIDTH,
  MIN_EDITOR_WIDTH,
} from '../src/renderer/src/lib/agent-panel-geometry'

describe('clampPanelWidth', () => {
  const VIEWPORT = 1600

  it('passes a comfortable width through (rounded)', () => {
    expect(clampPanelWidth(800.4, VIEWPORT)).toBe(800)
  })

  it('never goes below the 80-column minimum', () => {
    expect(clampPanelWidth(200, VIEWPORT)).toBe(MIN_AGENT_PANEL_WIDTH)
    expect(clampPanelWidth(-50, VIEWPORT)).toBe(MIN_AGENT_PANEL_WIDTH)
  })

  it('leaves room for the editor', () => {
    expect(clampPanelWidth(1_500, VIEWPORT)).toBe(VIEWPORT - MIN_EDITOR_WIDTH)
  })

  it('on a cramped viewport the terminal minimum wins over editor room', () => {
    // 900px viewport can't fit both — an unwrapped terminal is the priority
    expect(clampPanelWidth(900, 900)).toBe(MIN_AGENT_PANEL_WIDTH)
  })
})
