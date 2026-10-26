/**
 * What the wizard collects, and how it becomes the existing create path's
 * draft (`holis.create`) and a habit for the automations' `schedules.save`.
 * The grammar stays the shared package's: the file's parse in main is the last
 * word, and these only shape what is sent.
 */
import {
  cronOfTrigger,
  HOLI_COLOURS,
  HOLI_MASCOTS,
  HOLI_MASCOT_LABELS,
  holiRuleError,
  holiSlug,
  nextCronTime,
  parseCron,
  type HoliDraft,
  type HoliMascot,
  type ScheduleTrigger,
} from '@holi/shared'
import type { HoliSummary } from '../holis-cap'

export interface WizardHabit {
  on: boolean
  kind: 'daily' | 'weekdays' | 'weekly'
  /** 0 Sunday … 6 Saturday, for `weekly`. */
  day: number
  /** `HH:MM`, this machine's local time. */
  time: string
  prompt: string
}

export interface WizardDraft {
  /** Undefined until typed: the name follows the face until then. */
  name?: string
  mascot: HoliMascot
  color: string
  description: string
  soul: string
  /** Globs, one a line. */
  accepts: string
  /** `default`, or a Claude Code model alias. */
  model: string
  allow: string[]
  habit: WizardHabit
}

const pad = (n: number): string => String(n).padStart(2, '0')
export const TIMES = Array.from(
  { length: 48 },
  (_, i) => `${pad(Math.floor(i / 2))}:${i % 2 ? '30' : '00'}`,
)
export const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

/** A new draft: the first face and colour no other Holi has, as main's
 *  create picks them, over whatever the caller started it from. */
export function initialDraft(
  holis: readonly HoliSummary[],
  from: Partial<HoliDraft> = {},
): WizardDraft {
  const faces = new Set(holis.map((h) => h.mascot))
  const colours = new Set(holis.map((h) => h.color))
  return {
    ...(from.name === undefined ? {} : { name: from.name }),
    mascot: from.mascot ?? HOLI_MASCOTS.find((m) => !faces.has(m)) ?? HOLI_MASCOTS[0],
    color: from.color ?? HOLI_COLOURS.find((c) => !colours.has(c)) ?? HOLI_COLOURS[0],
    description: from.description ?? '',
    soul: from.soul ?? '',
    accepts: (from.accepts ?? []).join('\n'),
    model: from.model ?? 'default',
    allow: from.allow ?? [],
    habit: { on: false, kind: 'weekdays', day: 1, time: '08:00', prompt: '' },
  }
}

const list = (text: string): string[] =>
  text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '')

function draftName(d: WizardDraft): string {
  return (d.name ?? HOLI_MASCOT_LABELS[d.mascot]).trim()
}

/** The draft as `holis.create` takes it. */
export function toHoliDraft(d: WizardDraft): Partial<HoliDraft> {
  const accepts = list(d.accepts)
  return {
    name: draftName(d),
    mascot: d.mascot,
    color: d.color,
    ...(d.description.trim() === '' ? {} : { description: d.description.trim() }),
    ...(d.model === 'default' ? {} : { model: d.model }),
    ...(accepts.length === 0 ? {} : { accepts }),
    ...(d.allow.length === 0 ? {} : { allow: d.allow }),
    ...(d.soul.trim() === '' ? {} : { soul: d.soul }),
  }
}

export function habitCron(h: WizardHabit): string {
  const trigger: ScheduleTrigger =
    h.kind === 'weekly'
      ? { kind: 'weekly', day: h.day, time: h.time }
      : { kind: h.kind, time: h.time }
  return cronOfTrigger(trigger)
}

export function nextHabitRun(cron: string, now = new Date()): Date | null {
  try {
    return nextCronTime(parseCron(cron), now)
  } catch {
    return null
  }
}

/** The habit as `schedules.save` takes it, less the Holi it names. */
export function toHabit(d: WizardDraft): { name: string; crons: string[]; prompt: string } {
  return {
    name: `${draftName(d)} habit`,
    crons: [habitCron(d.habit)],
    prompt: d.habit.prompt.trim(),
  }
}

/** Why a step cannot be left forward yet, or null. */
export function stepProblem(step: string, d: WizardDraft): string | null {
  if (step === 'who' && holiSlug(draftName(d)) === '') {
    return 'Give it a name with a letter or a digit in it.'
  }
  if (step === 'may') {
    for (const rule of d.allow) {
      const refused = holiRuleError(rule)
      if (refused !== null) return refused
    }
  }
  if (step === 'habit' && d.habit.on && d.habit.prompt.trim() === '') {
    return 'Say what it does each time, or turn the habit off.'
  }
  return null
}
