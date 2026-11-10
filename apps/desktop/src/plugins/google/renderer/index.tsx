/**
 * Google's renderer side (docs/features/google.md): Mail and Calendar, their
 * nav items once an account is connected, and the Connections section of the
 * settings tab.
 */
import { Cable, CalendarDays, Mail } from 'lucide-react'
import { PLUGINS_FILE, PLUGINS_LOCAL_FILE } from '@holi/shared'
import { type RendererPlugin } from '@/plugin-api'
import { GOOGLE_INFO } from '../info'
import { googleConnectedAtom } from './account'
import { ConnectionsSection } from './connections-section'
import { MailView } from './mail-view'
import { CalendarView } from './calendar/calendar-view'
import { CalendarSettingsSection } from './calendar/calendar-settings-section'
import { MailShell } from './mail/mail-shell'

export const googleRenderer: RendererPlugin = {
  info: GOOGLE_INFO,
  surfaces: [{ kind: 'mail', label: 'Mail', icon: Mail, render: MailView }],
  sidebarApps: [
    {
      id: 'mail',
      label: 'Mail',
      icon: Mail,
      order: 10,
      render: MailShell,
      visible: googleConnectedAtom,
    },
    {
      id: 'calendar',
      label: 'Calendar',
      icon: CalendarDays,
      order: 20,
      render: CalendarView,
      visible: googleConnectedAtom,
    },
  ],
  rail: [{ surface: 'mail', order: 40, visible: googleConnectedAtom }],
  settingsSections: [
    {
      id: 'connections',
      label: 'Connections',
      icon: Cable,
      description: 'The accounts this vault reads mail and calendar from.',
      headings: [],
      // Nothing on disk in the vault: a Google grant is the machine's, held by
      // main's credential storage, and the renderer never sees a token.
      files: [],
      Component: ConnectionsSection,
    },
    {
      id: 'google-calendar',
      label: 'Calendar',
      icon: CalendarDays,
      description: 'How the Calendar writes times and weeks, for everyone in this vault.',
      headings: [],
      files: [PLUGINS_FILE, PLUGINS_LOCAL_FILE],
      Component: CalendarSettingsSection,
    },
  ],
}
