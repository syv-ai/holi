/**
 * Google's renderer side (docs/features/google.md): Mail and Calendar, their
 * nav items once an account is connected, and the Connections section of the
 * settings tab.
 */
import { Cable, CalendarDays, Mail } from 'lucide-react'
import { PLUGINS_FILE, PLUGINS_LOCAL_FILE } from '@holi/shared'
import { openTabAtom, type RendererPlugin } from '@/plugin-api'
import { GOOGLE_INFO } from '../info'
import { MAIL_ATTENTION_EVENT, OPEN_MAIL_EVENT } from '../shared/types'
import { googleConnectedAtom } from './account'
import { ConnectionsSection } from './connections-section'
import { MailView } from './mail-view'
import { CalendarView } from './calendar/calendar-view'
import { CalendarSettingsSection } from './calendar/calendar-settings-section'
import { MailShell } from './mail/mail-shell'
import { mailAttentionChanged, mailUnreadAtom, startMailAttention } from './mail-attention-state'
import { requestMailNavigationAtom } from './mail-navigation'

export const googleRenderer: RendererPlugin = {
  info: GOOGLE_INFO,
  events: {
    [MAIL_ATTENTION_EVENT]: mailAttentionChanged,
    [OPEN_MAIL_EVENT]: ({ remote, payload }, store) => {
      if (
        typeof payload !== 'object' ||
        payload === null ||
        (payload as { mailbox?: unknown }).mailbox !== 'inbox'
      )
        return
      store.set(requestMailNavigationAtom, { remote, mailbox: 'inbox' })
      store.set(openTabAtom, { kind: 'app', id: 'mail' })
    },
  },
  vault: (remote, store) => startMailAttention(remote, store),
  surfaces: [
    {
      kind: 'mail',
      label: 'Mail',
      icon: Mail,
      render: MailView,
      openAs: { kind: 'app', id: 'mail' },
    },
  ],
  sidebarApps: [
    {
      id: 'mail',
      label: 'Mail',
      icon: Mail,
      order: 10,
      render: MailShell,
      keepMounted: true,
      visible: googleConnectedAtom,
      unreadAtom: mailUnreadAtom,
    },
    {
      id: 'calendar',
      label: 'Calendar',
      icon: CalendarDays,
      order: 20,
      render: CalendarView,
      keepMounted: true,
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
