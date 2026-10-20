/** The first-run greeting: what Holi is, before anything is asked. */
import { ArrowRight } from 'lucide-react'
import { Button, Icon, Kbd } from '@/primitives'
import { ActHeading } from './ActHeading'

export function GreetingAct({ onBegin }: { onBegin: () => void }) {
  return (
    <div className="flex flex-col items-center gap-6">
      <ActHeading
        center
        title="A vault for notes and tasks."
        description="It is a private GitHub repo, cloned to this machine and kept in sync. Mail, calendar and an agent are plugins: keep the ones you want."
      />
      <div className="flex flex-col items-center gap-3">
        <Button onClick={onBegin}>
          Begin
          <Icon icon={ArrowRight} size="sm" />
        </Button>
        <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
          or press <Kbd>Space</Kbd>
        </span>
      </div>
    </div>
  )
}
