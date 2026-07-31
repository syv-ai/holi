import { useAtomValue, useSetAtom } from 'jotai'
import { CreateTask } from '@/features/tasks/CreateTask'
import { Dialog } from '@/primitives'
import { activeDialogAtom, closeDialogAtom } from '@/state/dialogs'

/**
 * The one dialog mount. Reads the registry atom and dispatches `id` → block
 * (Strategy) inside a `Dialog` sized by the entry. Mounted once in the shell, so
 * the summon is state-through-the-store — not a global mutable singleton.
 */
export function DialogHost(): React.JSX.Element | null {
  const active = useAtomValue(activeDialogAtom)
  const close = useSetAtom(closeDialogAtom)
  if (active === null) return null
  return (
    <Dialog open size={active.size} onClose={() => close()}>
      {active.id === 'create-task' && <CreateTask mode={active.mode} onClose={() => close()} />}
    </Dialog>
  )
}
