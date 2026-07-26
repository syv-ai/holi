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

  it('never goes below the panel minimum', () => {
    expect(clampPanelWidth(200, VIEWPORT)).toBe(MIN_AGENT_PANEL_WIDTH)
    expect(clampPanelWidth(-50, VIEWPORT)).toBe(MIN_AGENT_PANEL_WIDTH)
  })

  it('leaves room for the editor', () => {
    expect(clampPanelWidth(1_500, VIEWPORT)).toBe(VIEWPORT - MIN_EDITOR_WIDTH)
  })

  it('on a cramped viewport the panel minimum wins over editor room', () => {
    // 800px can't fit panel (360) + editor (480) — the panel minimum is the floor
    expect(clampPanelWidth(800, 800)).toBe(MIN_AGENT_PANEL_WIDTH)
  })
})
