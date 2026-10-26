/**
 * Google's renderer side (docs/features/google.md): the Mail and Agenda tabs,
 * their nav items once an account is connected, and the Connections section
 * of the settings tab.
 */
import { Cable, CalendarDays, Mail } from 'lucide-react'
import { usePluginSetting, type RendererPlugin } from '@/plugin-api'
import { GOOGLE_INFO } from '../info'
import { googleConnectedAtom } from './account'
import { AgendaView } from './agenda-view'
import { ConnectionsSection } from './connections-section'
import { MailView } from './mail-view'
import { CalendarView } from './calendar/calendar-view'
import { MailShell } from './mail/mail-shell'

/** The Agenda tab, opened on the view this machine's `agendaView` asks for. */
function AgendaSurface(): React.JSX.Element {
  const view = usePluginSetting(GOOGLE_INFO, 'agendaView')
  return <AgendaView initialView={view === 'month' ? 'month' : 'list'} />
}

export const googleRenderer: RendererPlugin = {
  info: GOOGLE_INFO,
  surfaces: [
    { kind: 'mail', label: 'Mail', icon: Mail, render: MailView, homeable: true },
    { kind: 'agenda', label: 'Agenda', icon: CalendarDays, render: AgendaSurface, homeable: true },
  ],
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
  rail: [
    { surface: 'mail', order: 40, visible: googleConnectedAtom },
    { surface: 'agenda', order: 50, visible: googleConnectedAtom },
  ],
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
      Component: () => <ConnectionsSection />,
    },
  ],
}
