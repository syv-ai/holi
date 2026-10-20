/**
 * Quick add (⌘T, the board's New task, a lane's +): a dialog anchored near the
 * top, as the palette is. Mounted once in the shell.
 */
import { useAtom } from 'jotai'
import { Dialog } from '@/primitives'
import { quickAddAtom } from '@/state/tasks'
import { QuickAdd } from './QuickAdd'

export function QuickAddHost(): React.JSX.Element {
  const [open, setOpen] = useAtom(quickAddAtom)
  return (
    <Dialog
      open={open}
      onClose={() => setOpen(false)}
      size="bare"
      placement="top"
      closable={false}
      title="New task"
      description="Write the task; Tab walks its fields; Enter adds it"
      className="max-w-[30rem]"
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
      <QuickAdd onAdded={() => setOpen(false)} />
    </Dialog>
  )
}
