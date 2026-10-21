/**
 * The Holi dialogs, mounted with the app (as one of the plugin's drawers) so a
 * document's Agent menu, which closes as a row is picked, can open them: the
 * approval, and a Holi's settings.
 */
import { ApproveHoliDialog } from './ApproveHoliDialog'
import { HoliSettings } from './HoliSettings'

export function HoliDialogs(): React.JSX.Element {
  return (
    <>
      <ApproveHoliDialog />
      <HoliSettings />
    </>
  )
}
