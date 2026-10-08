/**
 * A scheduled agent's definition: one markdown file in `.holi/schedules/`
 * whose frontmatter says when and with what, and whose body is the prompt
 * (docs/features/scheduled-agents.md).
 *
 * ```markdown
 * ---
 * name: Inbox triage
 * cron: "*\/30 7-18 * * 1-5"
 * model: sonnet
 * allow:
 *   - Bash(holi google search:*)
 *   - Bash(holi google read:*)
 * ---
 * Look through my unread mail since the previous run…
 * ```
 *
 * `cron` (repeating) or `at` (once, a local `YYYY-MM-DDTHH:MM`), never both.
 * `allow` is Claude Code permission rules the run may use without asking;
 * every other permission prompt still asks. Times are this machine's local
 * time.
 *
 * Pure and browser-safe: the renderer shows what main runs from the same
 * reading.
 */
import { parse as parseYaml } from 'yaml'
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
  | { kind: 'cron'; cron: Cron }
  /** `stamp` as written; `local` the same minute as a local `Date`. */
  | { kind: 'at'; stamp: string; local: Date }

export interface ScheduleDef {
  name: string
  when: ScheduleWhen
  /** A Claude Code model alias or id, for `--model`. */
  model?: string
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
    if (typeof cronText !== 'string') return { ok: false, error: '`cron` must be quoted text' }
    let cron: Cron
    try {
      cron = parseCron(cronText)
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
    when = { kind: 'cron', cron }
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
      ...(typeof rawModel === 'string' ? { model: rawModel } : {}),
      allow,
      prompt: body,
    },
  }
}

/**
 * What turning a schedule on approves: the prompt, the model and the rules it
 * may run without asking. A change to any of them is a schedule nobody has
 * approved yet. When it runs is not here: moving a time grants nothing.
 *
 * The prompt is read in its commit-time tidy form, so the whitespace the
 * pre-commit transform settles is not a change anyone has to approve again.
 */
export function scheduleApprovalText(def: ScheduleDef): string {
  const prompt = normalizeText(def.prompt, '', []).trim()
  return JSON.stringify({ prompt, model: def.model ?? null, allow: def.allow })
}

/** When it runs, in words. */
export function describeScheduleWhen(when: ScheduleWhen): string {
  return when.kind === 'cron' ? describeCron(when.cron) : `Once, at ${when.stamp.replace('T', ' ')}`
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
      : nextCronTime(when.cron, since)
  return next !== null && next.getTime() <= now.getTime() ? next : null
}

/** The next moment after `now` the schedule names, or null for none (an `at`
 *  in the past). */
export function nextRun(when: ScheduleWhen, now: Date): Date | null {
  if (when.kind === 'at') return when.local.getTime() > now.getTime() ? when.local : null
  return nextCronTime(when.cron, now)
}
