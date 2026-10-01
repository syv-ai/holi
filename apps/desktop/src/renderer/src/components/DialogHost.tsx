import { useAtomValue, useSetAtom } from 'jotai'
import { EditIcon } from '@/features/explorer/EditIcon'
import { CreateTask } from '@/features/tasks/CreateTask'
import { RemoveVault } from '@/features/vault/RemoveVault'
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
    <Dialog open size={active.size} closable={active.closable} onClose={() => close()}>
      {active.id === 'create-task' && <CreateTask onClose={() => close()} />}
      {active.id === 'edit-icon' && (
        <EditIcon
          remote={active.remote}
          path={active.path}
          current={active.current}
          onOpenMap={active.onOpenMap}
          onClose={() => close()}
        />
      )}
      {active.id === 'plugin' && active.render(() => close())}
      {active.id === 'remove-vault' && (
        <RemoveVault remote={active.remote} intent={active.intent} onClose={() => close()} />
      )}
    </Dialog>
  )
}
