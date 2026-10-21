/** The first-run greeting: what Holi is, before anything is asked. */
import { Button } from '@/primitives'

export function GreetingAct({ onBegin }: { onBegin: () => void }) {
  return (
    <>
      <div className="obrit-eyebrow">HOLI</div>
      <h1 className="obrit-display">A vault for notes and tasks.</h1>
      <p className="obrit-lede">
        It is a private GitHub repo, cloned to this machine and kept in sync. Mail, calendar and an
        agent are plugins: keep the ones you want.
      </p>
      <div className="obrit-cta-row">
        <Button variant="ceremony" onClick={onBegin}>
          Begin
          <span aria-hidden>→</span>
        </Button>
      </div>
      <div className="obrit-keyhint">
        <span>or press</span>
        <span className="obrit-kbd-inline">space</span>
      </div>
    </>
  )
}
