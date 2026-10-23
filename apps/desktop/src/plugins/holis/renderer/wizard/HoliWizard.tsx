/**
 * The new-Holi wizard (docs/features/holis.md, The wizard), on ReUI's
 * `onboarding-2` block: its rail of numbered steps on the left, which jumps
 * back to any step already reached, and on the right one step at a time in a
 * ghost Frame, its heading, its body and a Continue under it.
 *
 * It explains first (what a Holi is, how it gets work), then makes one: who it
 * is, what it does, what it may do without asking, an optional habit, and a
 * review. Create goes through the one create path (`createHoliAtom`, i.e.
 * `holis.create` and, for a habit, the automations' `schedules.save`), and
 * then the approval as for any new Holi: nothing here approves anything.
 *
 * `learn` is only the two explaining steps, ending in "Create a Holi". A
 * person who already has Holis starts making one at once, the explaining
 * steps a click back on the rail.
 */
import { useAtomValue, useSetAtom } from 'jotai'
import { ArrowLeft, Sparkles } from 'lucide-react'
import { useState } from 'react'
import { Button, Dialog, Frame, FramePanel, Icon, toast } from '@/primitives'
import { useHasCapability } from '@/plugin-api'
import { createHoliAtom, holisAtom, holiWizardAtom } from '../state'
import { initialDraft, stepProblem, toHabit, toHoliDraft, type WizardDraft } from './draft'
import {
  DoesStep,
  HabitStep,
  MayStep,
  ReviewStep,
  StepHeading,
  WhatStep,
  WhoStep,
  WorkStep,
} from './steps'
import { WizardRail, type RailStep } from './WizardRail'

type StepId = 'what' | 'work' | 'who' | 'does' | 'may' | 'habit' | 'review'

interface StepMeta extends RailStep {
  id: StepId
  title: string
  description: string
}

const STEPS: readonly StepMeta[] = [
  {
    id: 'what',
    label: 'What a Holi is',
    blurb: 'An agent of this vault.',
    title: 'Meet the Holis',
    description:
      'A Holi is an agent that belongs to the vault, with a name, a face, a soul and a memory.',
  },
  {
    id: 'work',
    label: 'How it gets work',
    blurb: 'Sent, or on a clock.',
    title: 'How a Holi gets work',
    description: 'Someone sends it a document, or it carries out its habits on a clock.',
  },
  {
    id: 'who',
    label: 'Who it is',
    blurb: 'Name, face, colour.',
    title: 'Who it is',
    description: 'How it is called and how it looks, here and in the arcade.',
  },
  {
    id: 'does',
    label: 'What it does',
    blurb: 'Its soul and documents.',
    title: 'What it does',
    description: 'Its standing instructions, and the documents it can be sent.',
  },
  {
    id: 'may',
    label: 'What it may do',
    blurb: 'Without asking you.',
    title: 'What it may do without asking',
    description: 'Claude Code permission rules, named by folder. Everything else asks you first.',
  },
  {
    id: 'habit',
    label: 'Habits',
    blurb: 'Optional schedule.',
    title: 'A habit, if it should have one',
    description: 'An automation on a clock that this Holi carries out.',
  },
  {
    id: 'review',
    label: 'Review and create',
    blurb: 'Then approve it here.',
    title: 'Review and create',
    description:
      'This is what goes into its folder. You can change any of it later in its settings.',
  },
]

const EXPLAINING: readonly StepId[] = ['what', 'work']

function Wizard({
  mode,
  draft: from,
  skipIntro,
  onMode,
}: {
  mode: 'create' | 'learn'
  draft: Parameters<typeof initialDraft>[1]
  skipIntro: boolean
  onMode: (mode: 'create') => void
}): React.JSX.Element {
  const holis = useAtomValue(holisAtom)
  const close = useSetAtom(holiWizardAtom)
  const create = useSetAtom(createHoliAtom)
  const habits = useHasCapability('schedules.save')
  const steps = STEPS.filter((s) =>
    mode === 'learn' ? EXPLAINING.includes(s.id) : s.id !== 'habit' || habits,
  )
  // A person who has Holis already knows what one is: start at making it.
  const [current, setCurrent] = useState(() =>
    mode === 'create' && (skipIntro || holis.length > 0) ? 3 : 1,
  )
  const [furthest, setFurthest] = useState(current)
  const [draft, setDraft] = useState<WizardDraft>(() => initialDraft(holis, from))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const meta = steps[current - 1] ?? steps[0]!
  const set = (patch: Partial<WizardDraft>) => setDraft((d) => ({ ...d, ...patch }))
  const problem = stepProblem(meta.id, draft)
  const last = current === steps.length

  const go = (step: number) => {
    const next = Math.min(Math.max(step, 1), steps.length)
    setCurrent(next)
    setFurthest((f) => Math.max(f, next))
    setError(null)
  }
  const reached = (step: number) =>
    step <= furthest || EXPLAINING.includes(steps[step - 1]?.id ?? 'review')

  const submit = () => {
    if (busy) return
    setBusy(true)
    setError(null)
    void create({
      draft: toHoliDraft(draft),
      ...(habits && draft.habit.on ? { habit: toHabit(draft) } : {}),
    }).then((res) => {
      setBusy(false)
      // Made, but its habit failed: the wizard has closed on the Holi.
      if (res.ok) {
        if (res.warning !== undefined) toast.error(res.warning)
      } else setError(res.message)
    })
  }

  return (
    <div className="flex min-h-0 flex-1">
      <aside className="flex w-64 shrink-0 flex-col gap-4 p-6 pe-4">
        <header className="flex min-h-8 items-center justify-between gap-2">
          <span className="flex items-center gap-2 text-sm font-medium">
            <Icon icon={Sparkles} size="sm" tone="muted" />
            {mode === 'learn' ? 'How Holis work' : 'New Holi'}
          </span>
          {current > 1 ? (
            <Button variant="ghost" size="sm" onClick={() => go(current - 1)}>
              <Icon icon={ArrowLeft} size="sm" />
              Back
            </Button>
          ) : null}
        </header>
        <div className="flex flex-1 items-center">
          <WizardRail steps={steps} current={current} reached={reached} onStepChange={go} />
        </div>
      </aside>
      <section className="flex min-w-0 flex-1 p-2">
        <Frame
          variant="ghost"
          spacing="xs"
          className="flex w-full flex-1 gap-0 overflow-hidden bg-muted/60 dark:bg-muted/10"
        >
          <FramePanel className="flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-contain px-10 py-12">
            {/* The view's one entrance: each step rises in as it is shown;
                reduced motion fades it instead (the house's `motion-in-rise`). */}
            <div
              key={meta.id}
              className="mx-auto flex w-full max-w-lg flex-1 flex-col motion-in-rise"
            >
              <div className="flex flex-col gap-8">
                <StepHeading title={meta.title} description={meta.description} />
                {meta.id === 'what' && <WhatStep />}
                {meta.id === 'work' && <WorkStep />}
                {meta.id === 'who' && <WhoStep draft={draft} set={set} />}
                {meta.id === 'does' && <DoesStep draft={draft} set={set} />}
                {meta.id === 'may' && <MayStep draft={draft} set={set} />}
                {meta.id === 'habit' && <HabitStep draft={draft} set={set} />}
                {meta.id === 'review' && <ReviewStep draft={draft} habits={habits} />}
              </div>
              <div className="mt-auto flex flex-col gap-2 pt-8">
                {error !== null && (
                  <p role="alert" className="text-sm text-destructive">
                    {error}
                  </p>
                )}
                {mode === 'learn' && last ? (
                  <>
                    <Button className="w-full" onClick={() => onMode('create')}>
                      Create a Holi
                    </Button>
                    <Button variant="ghost" className="w-full" onClick={() => close(null)}>
                      Close
                    </Button>
                  </>
                ) : meta.id === 'review' ? (
                  <Button className="w-full" disabled={busy} onClick={submit}>
                    {busy ? 'Creating…' : error === null ? 'Create Holi' : 'Try again'}
                  </Button>
                ) : (
                  <Button
                    className="w-full"
                    disabled={problem !== null}
                    onClick={() => go(current + 1)}
                  >
                    Continue
                  </Button>
                )}
                {problem !== null && meta.id !== 'who' && (
                  <p className="text-xs text-muted-foreground">{problem}</p>
                )}
              </div>
            </div>
          </FramePanel>
        </Frame>
      </section>
    </div>
  )
}

export function HoliWizard(): React.JSX.Element | null {
  const open = useAtomValue(holiWizardAtom)
  const setOpen = useSetAtom(holiWizardAtom)
  if (open === null) return null
  return (
    <Dialog
      open
      size="full"
      title={open.mode === 'learn' ? 'How Holis work' : 'New Holi'}
      onClose={() => setOpen(null)}
    >
      <Wizard
        // From learning to making, the wizard starts again on making.
        key={open.mode}
        mode={open.mode}
        draft={open.draft}
        skipIntro={open.skipIntro === true}
        onMode={(mode) => setOpen({ ...open, mode, skipIntro: true })}
      />
    </Dialog>
  )
}
