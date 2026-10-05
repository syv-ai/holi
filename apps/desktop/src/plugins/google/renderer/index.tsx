/**
 * Google's renderer side (docs/features/google.md): the Mail and Agenda tabs,
 * their nav items once an account is connected, and the Connections section
 * of the settings tab.
 */
import { CalendarDays, Mail } from 'lucide-react'
import { useAtomValue } from 'jotai'
import { headingId } from '@/composites'
import type { RendererPlugin } from '@/plugin-api'
import { GOOGLE_INFO } from '../info'
import { googleConnectedAtom } from './account'
import { agendaMonthAtom } from './agenda-prefs'
import { AgendaSection } from './AgendaSection'
import { AgendaView } from './AgendaView'
import { ConnectionsSection } from './ConnectionsSection'
import { MailView } from './MailView'

/** The Agenda tab, opened on the view the settings ask for. */
function AgendaSurface(): React.JSX.Element {
  const month = useAtomValue(agendaMonthAtom)
  return <AgendaView initialView={month ? 'month' : 'list'} />
}

export const googleRenderer: RendererPlugin = {
  info: GOOGLE_INFO,
  surfaces: [
    { kind: 'mail', label: 'Mail', icon: Mail, render: MailView, homeable: true },
    { kind: 'agenda', label: 'Agenda', icon: CalendarDays, render: AgendaSurface, homeable: true },
  ],
  rail: [
    { surface: 'mail', order: 40, visible: googleConnectedAtom },
    { surface: 'agenda', order: 50, visible: googleConnectedAtom },
  ],
  settingsSections: [
    {
      id: 'agenda',
      label: 'Agenda',
      headings: [{ id: headingId('Calendar view'), title: 'Calendar view' }],
      files: [],
      Component: () => <AgendaSection />,
    },
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
