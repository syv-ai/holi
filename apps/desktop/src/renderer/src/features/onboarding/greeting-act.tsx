/** The first-run greeting: what Holi is, before anything is asked. */
import { ArrowRight } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Kbd } from '@/components/ui/kbd'

export function GreetingAct({ onBegin }: { onBegin: () => void }) {
  return (
    <>
      <div className="obrit-eyebrow">Holi</div>
      <h1 className="obrit-display">A vault for notes and tasks.</h1>
      <p className="obrit-lede">
        It is a private GitHub repo, cloned to this machine and kept in sync. Mail, calendar and an
        agent are plugins: keep the ones you want.
      </p>
      <div className="obrit-cta-row">
        <Button size="lg" onClick={onBegin}>
          Begin
          <ArrowRight aria-hidden className="size-3.5" />
        </Button>
      </div>
      <div className="obrit-keyhint">
        <span>or press</span>
        <Kbd>Space</Kbd>
      </div>
    </>
  )
}
