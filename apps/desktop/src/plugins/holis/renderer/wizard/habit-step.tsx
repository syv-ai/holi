/** The wizard's optional habit step: an automation the Holi carries out. */
import { Clock, ShieldCheck } from 'lucide-react'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { DAYS, habitCron, nextHabitRun, TIMES, type WizardDraft } from './draft'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { FormField } from './step-parts'

export const KINDS = [
  { value: 'weekdays', label: 'Every weekday' },
  { value: 'daily', label: 'Every day' },
  { value: 'weekly', label: 'Every week' },
] as const

const nextLabel = new Intl.DateTimeFormat(undefined, {
  weekday: 'short',
  hour: '2-digit',
  minute: '2-digit',
})

export function HabitStep({
  draft,
  set,
}: {
  draft: WizardDraft
  set: (patch: Partial<WizardDraft>) => void
}): React.JSX.Element {
  const habit = draft.habit
  const put = (patch: Partial<WizardDraft['habit']>) => set({ habit: { ...habit, ...patch } })
  const next = habit.on ? nextHabitRun(habitCron(habit)) : null
  return (
    <div className="flex flex-col gap-6">
      <FormField label="Give it a habit" orientation="horizontal">
        <Switch
          aria-label="Give it a habit"
          checked={habit.on}
          onCheckedChange={(on) => put({ on })}
        />
      </FormField>
      {habit.on ? (
        <>
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <Clock className="size-3.5 text-muted-foreground" />
            <Select
              value={habit.kind}
              onValueChange={(k) => put({ kind: k as WizardDraft['habit']['kind'] })}
            >
              <SelectTrigger size="sm" className="w-auto" aria-label="How often">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {KINDS.map((k) => (
                  <SelectItem key={k.value} value={k.value}>
                    {k.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {habit.kind === 'weekly' && (
              <>
                on
                <Select value={String(habit.day)} onValueChange={(d) => put({ day: Number(d) })}>
                  <SelectTrigger size="sm" className="w-auto" aria-label="Day">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {DAYS.map((d, i) => (
                      <SelectItem key={d} value={String(i)}>
                        {d}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </>
            )}
            at
            <Select value={habit.time} onValueChange={(time) => put({ time })}>
              <SelectTrigger size="sm" className="w-auto" aria-label="Time">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {TIMES.map((t) => (
                  <SelectItem key={t} value={t}>
                    {t}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {next !== null && (
              <span className="text-xs text-muted-foreground tabular-nums">
                Next: {nextLabel.format(next)}
              </span>
            )}
          </div>
          <FormField label="What it does each time" required>
            <Textarea
              aria-label="What it does each time"
              className="min-h-28 text-sm"
              placeholder="Look through what changed in kunder/ since the previous run and write a short digest to Notes/digest.md."
              value={habit.prompt}
              onChange={(e) => put({ prompt: e.target.value })}
            />
          </FormField>
          <Alert>
            <ShieldCheck className="size-3.5" />
            <AlertTitle>Written switched off</AlertTitle>
            <AlertDescription>
              Turn it on in Automations on the machine that should run it: that approves the habit
              and this Holi there. Every machine that turns it on runs it.
            </AlertDescription>
          </Alert>
        </>
      ) : (
        <p className="text-sm text-pretty text-muted-foreground">
          No habit: it works when someone sends it a document. You can add habits later from its
          page.
        </p>
      )}
    </div>
  )
}

// ── 7. Review and create ──────────────────────────────────────────────────
