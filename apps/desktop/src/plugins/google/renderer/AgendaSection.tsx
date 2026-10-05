/**
 * The Agenda section of the settings tab: whether the Agenda opens as a month
 * or as a list. Either view stays one press away inside the Agenda itself.
 */
import { useAtom } from 'jotai'
import { SettingsHeading, SettingsList, SettingsRow } from '@/composites'
import { Checkbox } from '@/primitives'
import { agendaMonthAtom } from './agenda-prefs'

export function AgendaSection(): React.JSX.Element {
  const [month, setMonth] = useAtom(agendaMonthAtom)
  return (
    <>
      <SettingsHeading title="Calendar view" />
      <SettingsList>
        <SettingsRow
          label="Open the Agenda as a month"
          description="A month grid to look at and add events in, in place of the list. This machine only."
          control={
            <Checkbox
              checked={month}
              onCheckedChange={(next) => setMonth(next === true)}
              aria-label="Open the Agenda as a month"
            />
          }
        />
      </SettingsList>
    </>
  )
}
