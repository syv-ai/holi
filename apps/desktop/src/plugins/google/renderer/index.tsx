/**
 * Google's renderer side (docs/features/google.md): the Mail and Agenda tabs,
 * their nav items once an account is connected, and the Connections section
 * of the settings tab.
 */
import { CalendarDays, Mail } from 'lucide-react'
import type { RendererPlugin } from '@/plugin-api'
import { GOOGLE_INFO } from '../info'
import { googleConnectedAtom } from './account'
import { AgendaView } from './AgendaView'
import { ConnectionsSection } from './ConnectionsSection'
import { MailView } from './MailView'

export const googleRenderer: RendererPlugin = {
  info: GOOGLE_INFO,
  surfaces: [
    { kind: 'mail', label: 'Mail', icon: Mail, render: MailView, homeable: true },
    { kind: 'agenda', label: 'Agenda', icon: CalendarDays, render: AgendaView, homeable: true },
  ],
  rail: [
    { surface: 'mail', order: 40, visible: googleConnectedAtom },
    { surface: 'agenda', order: 50, visible: googleConnectedAtom },
  ],
  settingsSections: [
    {
      id: 'connections',
      label: 'Connections',
      headings: [],
      // Nothing on disk in the vault: a Google grant is the machine's, held by
      // main's credential storage, and the renderer never sees a token.
      files: [],
      Component: () => <ConnectionsSection />,
    },
  ],
}
