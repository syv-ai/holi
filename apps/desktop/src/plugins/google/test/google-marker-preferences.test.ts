import { describe, expect, it } from 'vitest'
import {
  DEFAULT_MAIL_MARKER_PREFERENCES,
  MAIL_MARKERS,
  normalizeMailMarkerPreferences,
} from '../shared/mail-markers'

describe('mail marker preferences', () => {
  it('keeps the existing marker catalogue and normalizes the empty choice to the default', () => {
    expect(MAIL_MARKERS).toEqual(['yellow-star', 'red-star', 'blue-question'])
    expect(DEFAULT_MAIL_MARKER_PREFERENCES).toEqual({ enabledOrder: ['yellow-star'] })
    expect(normalizeMailMarkerPreferences({ enabledOrder: [] })).toEqual({
      enabledOrder: ['yellow-star'],
    })
  })

  it('rejects unknown, duplicate, and malformed preferences', () => {
    expect(() => normalizeMailMarkerPreferences({ enabledOrder: ['purple-star'] })).toThrow()
    expect(() =>
      normalizeMailMarkerPreferences({ enabledOrder: ['red-star', 'red-star'] }),
    ).toThrow()
    expect(() => normalizeMailMarkerPreferences({ enabledOrder: 'red-star' })).toThrow()
  })
})
