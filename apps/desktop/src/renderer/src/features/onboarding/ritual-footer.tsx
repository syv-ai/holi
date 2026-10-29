import { ArrowLeft, ArrowRight } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Kbd } from '@/components/ui/kbd'
import { cn } from '@/lib/cn'
import type { Act } from '@/state/onboarding-flow'

/** What the footer's right-hand button does on an act, and what Enter does. */
export interface RitualPrimary {
  label: string
  run: () => void
  disabled?: boolean
}

/** The ritual's foot: Back or Dismiss on the left, the act's primary action on the right. */
export function RitualFooter({
  act,
  view,
  atFloor,
  dismissible,
  naming,
  submitting,
  waking,
  primary,
  onBack,
}: {
  act: Act
  view: 'form' | 'join'
  atFloor: boolean
  dismissible: boolean
  naming: boolean
  submitting: boolean
  /** The one-time awakening of "Create vault". */
  waking: boolean
  primary: RitualPrimary | undefined
  onBack: () => void
}) {
  return (
    <footer className="obrit-foot">
      <div className="obrit-foot-side">
        {view === 'form' && act !== 'threshold' && (!atFloor || dismissible) && (
          <Button variant="ghost" onClick={onBack}>
            <ArrowLeft aria-hidden className="size-3.5" />
            {atFloor ? 'Dismiss' : 'Back'}
          </Button>
        )}
      </div>
      <div className="obrit-foot-side obrit-foot-right">
        {act === 'naming' && naming && !submitting && (
          <span className="obrit-keyhint">
            Press <Kbd>Enter</Kbd>
          </span>
        )}
        {primary !== undefined && (
          <span className={cn('rounded-lg', act === 'naming' && waking && 'obrit-wake')}>
            <Button size="lg" onClick={primary.run} disabled={primary.disabled}>
              {primary.label}
              <ArrowRight aria-hidden className="size-3.5" />
            </Button>
          </span>
        )}
      </div>
    </footer>
  )
}
