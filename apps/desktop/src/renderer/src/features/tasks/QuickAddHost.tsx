/**
 * Quick add away from the board (⌘T): centred at the top, on the palette's
 * morphing surface (`MorphDialog`). Mounted once in the shell. On the board
 * the dock shows quick add instead, and this stays closed.
 */
import { useAtom } from 'jotai'
import { MorphDialog } from '@/primitives'
import { quickAddAtom } from '@/state/tasks'
import { QuickAdd } from './QuickAdd'

export function QuickAddHost(): React.JSX.Element {
  const [quickAdd, setQuickAdd] = useAtom(quickAddAtom)
  return (
    <MorphDialog
      open={quickAdd?.where === 'centre'}
      onOpenChange={(open) => !open && setQuickAdd(null)}
      title="New task"
      description="Write the task; Tab walks its fields; Enter adds it"
      width="w-fit"
      // An open token folds first; only then does Escape close quick add.
      onEscapeKeyDown={(event) => {
        if (document.activeElement?.matches('[data-token][aria-expanded="true"]'))
          event.preventDefault()
      }}
    >
      <QuickAdd />
    </MorphDialog>
  )
}
