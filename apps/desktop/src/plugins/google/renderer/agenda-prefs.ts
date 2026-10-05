/**
 * What the Agenda opens on. A choice about the screen, so it is this machine's
 * and is remembered across vaults, like the nav drawer: it is not vault content
 * and is never committed.
 */
import { atomWithStorage } from 'jotai/utils'

/** On: the Agenda opens as a month grid. Off: the list of what is next. */
export const agendaMonthAtom = atomWithStorage('holi:agendaMonth', false)
