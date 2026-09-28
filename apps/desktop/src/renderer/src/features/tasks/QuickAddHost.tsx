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
      // A field's step goes back to the text first, and an open completion
      // closes first; only then does Escape close quick add.
      onEscapeKeyDown={(event) => {
        if (
          document.querySelector(
            '[data-quick-add]:not([data-step="text"]), [data-quick-add] .cm-tooltip-autocomplete',
          )
        )
          event.preventDefault()
      }}
    >
      <QuickAdd />
    </MorphDialog>
  )
}
