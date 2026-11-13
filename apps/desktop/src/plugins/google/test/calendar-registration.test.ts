import { describe, expect, test } from 'vitest'

import { googleRenderer } from '../renderer'
import { CalendarView } from '../renderer/calendar/calendar-view'

describe('Google Calendar shell registration', () => {
  test('offers one Calendar app, not a parallel Agenda surface or launcher', () => {
    expect(googleRenderer.sidebarApps?.map(({ id }) => id)).toContain('calendar')
    expect(googleRenderer.sidebarApps?.find(({ id }) => id === 'calendar')?.render).toBe(
      CalendarView,
    )
    expect(googleRenderer.surfaces?.map(({ kind }) => kind)).not.toContain('agenda')
    expect(googleRenderer.rail?.map(({ surface }) => surface)).not.toContain('agenda')
    expect(googleRenderer.info.settings?.map(({ key }) => key)).not.toContain('agendaView')
  })
})
