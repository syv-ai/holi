/**
 * A pane with nothing open (after Obsidian's new tab): the Holi mark, large and
 * faint, and under it the few ways on, each with its key. The mark is the one
 * place inside the app it stands on its own: a quiet face for a blank pane,
 * not decoration over work.
 */
import { useSetAtom } from 'jotai'
import { FilePlus, House, Search, SquareTerminal, type LucideIcon } from 'lucide-react'
import { BrandMark } from '@/composites'
import { Button, Icon, Kbd } from '@/primitives'
import { runCommandAtom } from '@/state/commands'

const ACTIONS: { id: string; label: string; icon: LucideIcon; key?: string }[] = [
  { id: 'note.new', label: 'New note', icon: FilePlus },
  { id: 'palette.open', label: 'Go to file', icon: Search, key: '⌘P' },
  { id: 'palette.commands', label: 'Commands', icon: SquareTerminal, key: '⌘⇧P' },
  { id: 'home.open', label: 'Go home', icon: House },
]

export function EmptyPane(): React.JSX.Element {
  const run = useSetAtom(runCommandAtom)
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-8 p-8">
      <BrandMark size="lg" className="text-foreground/[0.08]" />
      <div className="flex w-56 flex-col gap-1">
        {ACTIONS.map((a) => (
          <Button
            key={a.id}
            variant="ghost"
            size="sm"
            className="h-8 justify-start gap-2.5 px-2.5 font-normal text-muted-foreground hover:bg-foreground/[0.04] hover:text-foreground"
            onClick={() => void run(a.id)}
          >
            <Icon icon={a.icon} size="sm" />
            <span className="flex-1 text-start">{a.label}</span>
            {a.key !== undefined && <Kbd>{a.key}</Kbd>}
          </Button>
        ))}
      </div>
    </div>
  )
}
