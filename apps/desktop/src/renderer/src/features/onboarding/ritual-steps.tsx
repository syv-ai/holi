import {
  Stepper,
  StepperIndicator,
  StepperItem,
  StepperNav,
  StepperSeparator,
  StepperTitle,
} from '@/components/ui/stepper'
import type { Act } from '@/state/onboarding-flow'

/** The acts the stepper counts, and each one's name on it. */
const STEPPED: ReadonlySet<Act> = new Set<Act>(['naming', 'plugins', 'settings'])
const STEP_TITLES: Partial<Record<Act, string>> = {
  naming: 'Name',
  plugins: 'Plugins',
  settings: 'Choices',
}

/**
 * Where the ritual is, above the act: the step count, then a numbered step
 * per act with its name, the rule between two filling as the first is done
 * (`components/ui/stepper.tsx`). It counts only the acts that ask something
 * (`STEPPED`): the greeting is the door in and the threshold is the result,
 * so on those the stepper fades out, keeping its height so the act does not
 * jump. Progress only: the acts are gated by what each one needs, so there
 * are no triggers and nothing here reads as a way to jump ahead.
 */
export function RitualSteps({
  acts,
  current,
  hidden = false,
}: {
  acts: readonly Act[]
  current: Act
  hidden?: boolean
}) {
  const steps = acts.filter((act) => STEPPED.has(act))
  const shown = STEPPED.has(current) && !hidden
  // On the threshold every step is done; on the greeting none has started.
  const at = shown ? steps.indexOf(current) + 1 : current === 'threshold' ? steps.length + 1 : 0
  return (
    <div className="obrit-progress" data-shown={shown || undefined} aria-hidden={!shown}>
      <p className="text-xs text-muted-foreground tabular-nums">
        Step {Math.min(Math.max(at, 1), steps.length)} of {steps.length}
      </p>
      <Stepper
        value={at}
        role="progressbar"
        aria-label="Setup progress"
        aria-valuemin={1}
        aria-valuemax={steps.length}
        aria-valuenow={Math.min(Math.max(at, 1), steps.length)}
        aria-valuetext={`Step ${Math.min(Math.max(at, 1), steps.length)} of ${steps.length}: ${STEP_TITLES[current] ?? ''}`}
        className="w-full max-w-md"
      >
        {/* The nav is what lays the steps in a row (`components/ui/stepper.tsx`):
            without it they stack. */}
        <StepperNav>
          {steps.map((act, i) => {
            const step = i + 1
            return (
              <StepperItem key={act} step={step} className="relative flex-1 flex-col!">
                <div className="flex flex-col items-center gap-2">
                  <StepperIndicator />
                  <StepperTitle className="text-xs group-data-[state=inactive]/step:text-muted-foreground">
                    {STEP_TITLES[act]}
                  </StepperTitle>
                </div>
                {step < steps.length && (
                  // From this step's dot to the next one's, filled once this
                  // step is done.
                  <StepperSeparator className="absolute start-(--step-line-start) top-3 m-0 w-(--step-line-width) -translate-y-1/2 group-data-[orientation=horizontal]/stepper-nav:flex-none data-[state=completed]:bg-foreground" />
                )}
              </StepperItem>
            )
          })}
        </StepperNav>
      </Stepper>
    </div>
  )
}
