/**
 * The wizard's rail of steps: ReUI's `onboarding-2` block's sidebar stepper
 * (`OnboardingStepper`), installed with the shadcn CLI and kept as it ships,
 * on the ReUI Stepper (`@/components/reui/stepper`). Only its type moved up to the house
 * floor (`text-xs`, `text-nav`) and its steps are the wizard's. A step is a
 * button while it may be visited: one already reached, or one that explains.
 */
import { Check } from 'lucide-react'
import {
  Stepper,
  StepperDescription,
  StepperIndicator,
  StepperItem,
  StepperNav,
  StepperSeparator,
  StepperTitle,
  StepperTrigger,
} from '@/components/reui/stepper'
export interface RailStep {
  id: string
  label: string
  blurb: string
}

// Shared so the indicator reads the same in every state, as the block has it.
const INDICATOR_CLASSNAME =
  'bg-foreground text-background ring-border/60 data-[state=active]:bg-foreground data-[state=active]:text-background data-[state=inactive]:bg-muted-foreground/8 data-[state=inactive]:text-muted-foreground data-[state=inactive]:ring-muted-foreground/12 data-[state=completed]:bg-success dark:bg-foreground dark:text-background dark:ring-border/70 dark:data-[state=active]:bg-foreground dark:data-[state=active]:text-background dark:data-[state=inactive]:bg-muted-foreground/14 dark:data-[state=inactive]:text-muted-foreground dark:data-[state=inactive]:ring-muted-foreground/12 text-xs data-[state=completed]:text-white'

const SEPARATOR_COLOR_CLASSNAME =
  'bg-muted-foreground/12 group-data-[state=active]/step:bg-muted-foreground/12 group-data-[state=inactive]/step:bg-muted-foreground/12 group-data-[state=completed]/step:bg-success dark:bg-muted-foreground/18 dark:group-data-[state=active]/step:bg-muted-foreground/18 dark:group-data-[state=inactive]/step:bg-muted-foreground/18'

const COMPLETED_INDICATOR = <Check className="size-3" />

export function WizardRail({
  steps,
  current,
  reached,
  onStepChange,
}: {
  steps: readonly RailStep[]
  /** 1-based, as the Stepper counts. */
  current: number
  /** Whether a step may be visited now. */
  reached: (step: number) => boolean
  onStepChange: (step: number) => void
}): React.JSX.Element {
  return (
    <Stepper
      value={current}
      onValueChange={(step) => {
        if (reached(step)) onStepChange(step)
      }}
      orientation="vertical"
      className="flex w-full flex-col items-start justify-center"
      indicators={{ completed: COMPLETED_INDICATOR }}
    >
      <StepperNav aria-label="Steps" className="w-full">
        {steps.map((step, i) => {
          const n = i + 1
          return (
            <StepperItem
              key={step.id}
              step={n}
              completed={current > n}
              disabled={!reached(n)}
              className="relative items-start not-last:flex-1"
            >
              <StepperTrigger className="w-full items-start text-left">
                <StepperIndicator className={INDICATOR_CLASSNAME}>{n}</StepperIndicator>
                <div className="mt-0.5 min-w-0 flex-1 pb-4 text-left">
                  <StepperTitle className="text-nav">{step.label}</StepperTitle>
                  <StepperDescription className="mt-0.5 max-w-none text-xs">
                    {step.blurb}
                  </StepperDescription>
                </div>
              </StepperTrigger>
              {n < steps.length ? (
                <StepperSeparator
                  className={`${SEPARATOR_COLOR_CLASSNAME} absolute inset-y-0 top-6 left-2.5 -order-1 m-0 h-auto! bottom-1 -translate-x-1/2`}
                />
              ) : null}
            </StepperItem>
          )
        })}
      </StepperNav>
    </Stepper>
  )
}
