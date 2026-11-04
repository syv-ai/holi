/**
 * The dock icon the window sends (docs/ui-system.md, Motion): only a PNG data
 * URL of a sane size reaches the dock.
 */
import { describe, expect, it } from 'vitest'
import { isDockIconPng, MAX_DOCK_ICON } from '../src/main/dock-icon'

describe('dock icon', () => {
  it('takes a PNG data URL', () => {
    expect(isDockIconPng('data:image/png;base64,iVBORw0KGgo=')).toBe(true)
  })

  it('refuses anything else', () => {
    expect(isDockIconPng(undefined)).toBe(false)
    expect(isDockIconPng(42)).toBe(false)
    expect(isDockIconPng('data:image/svg+xml;base64,PHN2Zz4=')).toBe(false)
    expect(isDockIconPng('file:///etc/passwd')).toBe(false)
    expect(isDockIconPng('data:image/png;base64,' + 'A'.repeat(MAX_DOCK_ICON))).toBe(false)
  })
})
