/**
 * An automation's definition (a scheduled agent): one markdown file in
 * `.holi/schedules/` whose frontmatter says when and with what, and whose body
 * is the prompt (docs/features/scheduled-agents.md).
 *
 * ```markdown
 * ---
 * name: Inbox triage
 * cron: "*\/30 7-18 * * 1-5"
 * holi: assistant
 * model: sonnet
 * allow:
 *   - Bash(holi google search:*)
 *   - Bash(holi google read:*)
 * catch-up: 2h
 * ---
 * Look through my unread mail since the previous run…
 * ```
 *
 * `cron` (repeating; one expression, or a list of them, each a trigger) or
 * `at` (once, a local `YYYY-MM-DDTHH:MM`), never both. `holi` names the Holi
 * that carries it out, whose soul, memory, model and rules a run gets.
 * `allow` is Claude Code permission rules the run may use without asking;
 * every other permission prompt still asks. `catch-up` is how late a missed
 * moment may still run (`none`, `30m`, `2h`…); absent, it always does. Times
 * are this machine's local time.
 *
 * Pure and browser-safe: the renderer shows what main runs from the same
 * reading.
 */
import { Document, parse as parseYaml, parseDocument } from 'yaml'
import {
  CronError,
  describeCron,
  nextCronTime,
  parseCron,
  shortestGapMinutes,
  type Cron,
} from './cron'
import { parseDateTime } from './dates'
import { splitFrontmatter } from './frontmatter'
import { normalizeText } from './normalize-md'
import { SCHEDULES_SURFACE_DIR } from './path-safety'

/** Where schedule files live. Root-anchored, one level: a schedule is a file
 *  directly inside. */
export const SCHEDULES_DIR = SCHEDULES_SURFACE_DIR

/** A run every few minutes is a bill, not a schedule: anything denser is
 *  refused, so a typo like `* * * * *` cannot start one session a minute. */
export const MIN_SCHEDULE_GAP_MINUTES = 5

export type ScheduleWhen =
  /** Each cron is one trigger; the schedule runs at the first that comes. */
  | { kind: 'cron'; crons: Cron[] }
  /** `stamp` as written; `local` the same minute as a local `Date`. */
  | { kind: 'at'; stamp: string; local: Date }

export interface ScheduleDef {
  name: string
  when: ScheduleWhen
  /** The id of the Holi that carries it out. */
  holi?: string
  /** A Claude Code model alias or id, for `--model`. */
  model?: string
  /** How late a missed moment may still run, in minutes: 0 never. Absent, a
   *  missed moment always runs, once. */
  catchUpMinutes?: number
  /** Claude Code permission rules, each one `--allowedTools` value. */
  allow: string[]
  prompt: string
}

export type ScheduleParse = { ok: true; def: ScheduleDef } | { ok: false; error: string }

/** Whether a vault path is a schedule file: a markdown file directly inside
 *  `SCHEDULES_DIR`, `.local.md` included. */
export function isScheduleFilePath(path: string): boolean {
  if (!path.startsWith(`${SCHEDULES_DIR}/`)) return false
  const rest = path.slice(SCHEDULES_DIR.length + 1)
  return !rest.includes('/') && rest.endsWith('.md') && rest !== '.md'
}

/** The file's own name for itself, `inbox-triage` for
 *  `.holi/schedules/inbox-triage.local.md`: what the CLI accepts and a name
 *  falls back to. */
export function scheduleSlug(path: string): string {
  const base = path.slice(path.lastIndexOf('/') + 1)
  return base.replace(/\.md$/, '').replace(/\.local$/, '')
}

/** A model name fit for argv: no spaces, no flags. */
const MODEL_RE = /^[A-Za-z0-9][\w.:[\]-]*$/

/** A Holi's id, as `holi.ts` names its files. */
const HOLI_ID_RE = /^[a-z0-9][a-z0-9-]{0,47}$/

/** `none`, `30m` or `12h` in minutes; null for anything else. Up to 30 days. */
export function catchUpOf(text: string): number | null {
  const t = text.trim().toLowerCase()
  if (t === 'none' || t === '0') return 0
  const m = /^(\d{1,5})\s*([mh])$/.exec(t)
  if (m === null) return null
  const minutes = Number(m[1]) * (m[2] === 'h' ? 60 : 1)
  return minutes <= 43_200 ? minutes : null
}

/** Minutes as `catch-up` writes them. */
export function catchUpText(minutes: number): string {
  if (minutes === 0) return 'none'
  return minutes % 60 === 0 ? `${minutes / 60}h` : `${minutes}m`
}

/** A local `YYYY-MM-DDTHH:MM` as the `Date` of that wall-clock minute. */
function localStamp(stamp: string): Date | null {
  const naive = parseDateTime(stamp)
  if (naive === null) return null
  const d = new Date(naive)
  return new Date(
    d.getUTCFullYear(),
    d.getUTCMonth(),
    d.getUTCDate(),
    d.getUTCHours(),
    d.getUTCMinutes(),
  )
}

/**
 * Read a schedule file. Never throws: a file that does not parse is a schedule
 * that does not run, and says why.
 */
export function parseScheduleFile(text: string, path: string): ScheduleParse {
  let yaml: string | null
  let body: string
  try {
    ;({ yaml, body } = splitFrontmatter(text))
  } catch (err) {
    return { ok: false, error: (err as Error).message }
  }
  if (yaml === null) return { ok: false, error: 'no frontmatter: it needs a `cron` or an `at`' }
  let fm: unknown
  try {
    fm = parseYaml(yaml)
  } catch (err) {
    return { ok: false, error: `the frontmatter is not YAML: ${(err as Error).message}` }
  }
  if (fm === null || typeof fm !== 'object' || Array.isArray(fm)) {
    return { ok: false, error: 'the frontmatter is not a map' }
  }
  const f = fm as Record<string, unknown>

  const rawName = f['name']
  if (rawName !== undefined && (typeof rawName !== 'string' || rawName.trim() === '')) {
    return { ok: false, error: '`name` must be text' }
  }
  const name = typeof rawName === 'string' ? rawName.trim() : scheduleSlug(path)

  const cronText = f['cron']
  const atText = f['at']
  if (cronText !== undefined && atText !== undefined) {
    return { ok: false, error: 'give a `cron` or an `at`, not both' }
  }
  let when: ScheduleWhen
  if (cronText !== undefined) {
    const texts = Array.isArray(cronText) ? cronText : [cronText]
    if (texts.length === 0) return { ok: false, error: '`cron` names no time' }
    const crons: Cron[] = []
    for (const text of texts) {
      if (typeof text !== 'string') return { ok: false, error: '`cron` must be quoted text' }
      let cron: Cron
      try {
        cron = parseCron(text)
      } catch (err) {
        if (err instanceof CronError) return { ok: false, error: `cron: ${err.message}` }
        throw err
      }
      if (shortestGapMinutes(cron) < MIN_SCHEDULE_GAP_MINUTES) {
        return {
          ok: false,
          error: `cron: runs more often than every ${MIN_SCHEDULE_GAP_MINUTES} minutes`,
        }
      }
      crons.push(cron)
    }
    when = { kind: 'cron', crons }
  } else if (atText !== undefined) {
    // YAML reads an unquoted timestamp as a Date; the stamp is wall-clock
    // text, so only the quoted form is unambiguous.
    const stamp = typeof atText === 'string' ? atText.trim() : null
    const local = stamp === null ? null : localStamp(stamp)
    if (stamp === null || local === null) {
      return { ok: false, error: '`at` must be a quoted local time, "YYYY-MM-DDTHH:MM"' }
    }
    when = { kind: 'at', stamp, local }
  } else {
    return { ok: false, error: 'it needs a `cron` or an `at`' }
  }

  const rawHoli = f['holi']
  if (rawHoli !== undefined && (typeof rawHoli !== 'string' || !HOLI_ID_RE.test(rawHoli))) {
    return { ok: false, error: '`holi` is the id of a Holi, like `assistant`' }
  }

  const rawCatchUp = f['catch-up']
  let catchUpMinutes: number | undefined
  if (rawCatchUp !== undefined) {
    const minutes = typeof rawCatchUp === 'string' ? catchUpOf(rawCatchUp) : null
    if (minutes === null) {
      return { ok: false, error: '`catch-up` is `none` or a time like `30m` or `12h`' }
    }
    catchUpMinutes = minutes
  }

  const rawModel = f['model']
  if (rawModel !== undefined && (typeof rawModel !== 'string' || !MODEL_RE.test(rawModel))) {
    return { ok: false, error: '`model` must be one model name, like `sonnet`' }
  }

  const rawAllow = f['allow'] ?? []
  if (!Array.isArray(rawAllow)) return { ok: false, error: '`allow` must be a list of rules' }
  const allow: string[] = []
  for (const rule of rawAllow) {
    if (typeof rule !== 'string' || rule.trim() === '' || /[\n\r]/.test(rule)) {
      return { ok: false, error: '`allow` holds one permission rule per item, as text' }
    }
    allow.push(rule.trim())
  }

  if (body === '')
    return { ok: false, error: 'the prompt (the body under the frontmatter) is empty' }
  return {
    ok: true,
    def: {
      name,
      when,
      ...(typeof rawHoli === 'string' ? { holi: rawHoli } : {}),
      ...(typeof rawModel === 'string' ? { model: rawModel } : {}),
      ...(catchUpMinutes === undefined ? {} : { catchUpMinutes }),
      allow,
      prompt: body,
    },
  }
}

/**
 * What turning a schedule on approves: the prompt, the model and the rules it
 * may run without asking. A change to any of them is a schedule nobody has
 * approved yet. When it runs is not here: moving a time grants nothing. Nor is
 * the `name`, which labels the run's session and the settings row and is
 * never part of what the run reads, so renaming grants nothing either.
 *
 * The prompt is read in its commit-time tidy form, so the whitespace the
 * pre-commit transform settles is not a change anyone has to approve again.
 */
export function scheduleApprovalText(def: ScheduleDef): string {
  const prompt = normalizeText(def.prompt, '', []).trim()
  // Which Holi carries it out is approved too; what that Holi is (its soul,
  // model and rules) the caller adds, read from the Holi's own files.
  return JSON.stringify({
    prompt,
    model: def.model ?? null,
    allow: def.allow,
    ...(def.holi === undefined ? {} : { holi: def.holi }),
  })
}

/** When it runs, in words. */
export function describeScheduleWhen(when: ScheduleWhen): string {
  return when.kind === 'cron'
    ? when.crons.map(describeCron).join(' · ')
    : `Once, at ${when.stamp.replace('T', ' ')}`
}

/** The first moment after `after` any of the crons names. */
function nextOfCrons(crons: readonly Cron[], after: Date): Date | null {
  let best: Date | null = null
  for (const cron of crons) {
    const next = nextCronTime(cron, after)
    if (next !== null && (best === null || next.getTime() < best.getTime())) best = next
  }
  return best
}

/**
 * The run due now, if any: the first moment the schedule names after `since`,
 * when it is not after `now`. Missed moments collapse into that one run, since
 * the caller moves `since` to now once it runs: a laptop that slept through
 * six half-hours runs once on waking, not six times. Null when nothing has
 * come due.
 */
export function dueRun(when: ScheduleWhen, since: Date, now: Date): Date | null {
  const next =
    when.kind === 'at'
      ? when.local.getTime() > since.getTime()
        ? when.local
        : null
      : nextOfCrons(when.crons, since)
  return next !== null && next.getTime() <= now.getTime() ? next : null
}

/** The next moment after `now` the schedule names, or null for none (an `at`
 *  in the past). */
export function nextRun(when: ScheduleWhen, now: Date): Date | null {
  if (when.kind === 'at') return when.local.getTime() > now.getTime() ? when.local : null
  return nextOfCrons(when.crons, now)
}

/**
 * One trigger as the automation editor says it: a sentence with a pill or
 * two, after MonoCode's. A cron no sentence says stays `custom`, shown as
 * written.
 */
export type ScheduleTrigger =
  | { kind: 'hourly'; minute: number }
  | { kind: 'daily'; time: string }
  | { kind: 'weekdays'; time: string }
  | { kind: 'weekly'; day: number; time: string }
  | { kind: 'custom'; cron: string }

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/

/** A cron as a trigger sentence, or `custom`. */
export function triggerOfCron(source: string): ScheduleTrigger {
  const parts = source.trim().split(/\s+/)
  const custom: ScheduleTrigger = { kind: 'custom', cron: source.trim() }
  if (parts.length !== 5) return custom
  const [min, hour, dom, mon, dow] = parts as [string, string, string, string, string]
  if (!/^\d{1,2}$/.test(min) || Number(min) > 59 || dom !== '*' || mon !== '*') return custom
  const minute = Number(min)
  if (hour === '*' && dow === '*') return { kind: 'hourly', minute }
  if (!/^\d{1,2}$/.test(hour) || Number(hour) > 23) return custom
  const time = `${hour.padStart(2, '0')}:${min.padStart(2, '0')}`
  if (dow === '*') return { kind: 'daily', time }
  if (dow === '1-5') return { kind: 'weekdays', time }
  if (/^[0-6]$/.test(dow)) return { kind: 'weekly', day: Number(dow), time }
  return custom
}

/** A trigger sentence as the cron the file keeps. */
export function cronOfTrigger(trigger: ScheduleTrigger): string {
  if (trigger.kind === 'custom') return trigger.cron.trim()
  if (trigger.kind === 'hourly') return `${trigger.minute} * * * *`
  const m = TIME_RE.exec(trigger.time)
  const [h, min] = m === null ? [9, 0] : [Number(m[1]), Number(m[2])]
  const dow =
    trigger.kind === 'daily' ? '*' : trigger.kind === 'weekdays' ? '1-5' : String(trigger.day)
  return `${min} ${h} * * ${dow}`
}

/** What the automation editor writes. */
export interface ScheduleDraft {
  name: string
  /** One cron per trigger. */
  crons: string[]
  holi?: string
  model?: string
  allow?: string[]
  catchUpMinutes?: number
  prompt: string
}

/**
 * A schedule file's text from the editor: a new file, or `text` with only the
 * keys the editor owns changed, so a person's comments and keys it does not
 * know stay. The body is the prompt.
 */
export function scheduleFileText(draft: ScheduleDraft, text?: string): string {
  let yaml = ''
  if (text !== undefined) {
    try {
      yaml = splitFrontmatter(text).yaml ?? ''
    } catch {
      yaml = ''
    }
  }
  // An empty frontmatter parses to no map; a fresh one takes the keys.
  const doc = yaml.trim() === '' ? new Document({}) : parseDocument(yaml)
  const set = (key: string, value: unknown): void => {
    if (value === undefined) doc.delete(key)
    else doc.set(key, value)
  }
  set('name', draft.name.trim())
  set('cron', draft.crons.length === 1 ? draft.crons[0] : draft.crons)
  doc.delete('at')
  set('holi', draft.holi?.trim() || undefined)
  set('model', draft.model?.trim() || undefined)
  set('allow', draft.allow !== undefined && draft.allow.length > 0 ? draft.allow : undefined)
  set(
    'catch-up',
    draft.catchUpMinutes === undefined ? undefined : catchUpText(draft.catchUpMinutes),
  )
  return `---\n${doc.toString({ lineWidth: 0 })}---\n\n${draft.prompt.trim()}\n`
}
