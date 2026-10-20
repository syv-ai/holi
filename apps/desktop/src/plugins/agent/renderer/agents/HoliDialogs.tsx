/**
 * The Holi dialogs, mounted with the app (as one of the agent's drawers) so a
 * document's Agent menu, which closes as a row is picked, can open them.
 */
import { useAtomValue, useSetAtom } from 'jotai'
import { newHoliAtom } from '../state/holis'
import { ApproveHoliDialog } from './ApproveHoliDialog'
import { NewHoliDialog } from './NewHoliDialog'

export function HoliDialogs(): React.JSX.Element {
  const making = useAtomValue(newHoliAtom)
  const setMaking = useSetAtom(newHoliAtom)
  return (
    <>
      <ApproveHoliDialog />
      {making !== null && (
        <NewHoliDialog
          {...(making.accepts === undefined ? {} : { accepts: making.accepts })}
          onClose={() => setMaking(null)}
        />
      )}
    </>
  )
}
