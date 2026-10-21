/**
 * What wakes a scheduled agent besides the clock: a schedule file's `on:`
 * (docs/features/scheduled-agents.md, Triggers), and the events the vault's
 * plugins tell each other so a trigger can fire.
 *
 * ```yaml
 * on:
 *   - file: inbox/**            # a file added under inbox/
 *   - file: clients/*\/brief.md
 *     changed: true             # added or changed
 *   - task: overdue             # an open task's due moment has passed
 *   - task: due
 *     before: 60                # an hour before an open task is due
 *   - calendar: 30              # 30 minutes before each timed event
 *   - mail: 'from:@acme.com'    # a new mail in a thread the query finds
 * ```
 *
 * **An event never carries third-party text.** What reaches a run is the one
 * line Holi adds, which the trigger router builds from an event's structured
 * fields (source, kind, identifiers), each quoted; no source writes any of it
 * as text. The run reads the content itself, through `holi` commands.
 *
 * Pure and browser-safe: the settings tab reads `on:` the way main runs it.
 */

export type TriggerSource = 'file' | 'task' | 'calendar' | 'mail'

export type Trigger =
  /** A file under `glob` added, or with `changed` also changed. */
  | { source: 'file'; glob: string; changed: boolean }
  /** `due`: `before` minutes before an open task is due. `overdue`: once its
   *  due moment has passed. */
  | { source: 'task'; when: 'due' | 'overdue'; before: number }
  /** `before` minutes before each timed event on the vault's calendars. */
  | { source: 'calendar'; before: number }
  /** A new message, not one of yours, in a thread the Gmail `query` finds. */
  | { source: 'mail'; query: string }

/** The longest lead a trigger may name: a day. The sources publish no
 *  further ahead. */
export const MAX_TRIGGER_LEAD_MINUTES = 24 * 60

export type TriggersParse = { ok: true; triggers: Trigger[] } | { ok: false; error: string }

/** One line of text fit for an identifier: no line breaks, not empty. */
const oneLine = (v: unknown): v is string =>
  typeof v === 'string' && v.trim() !== '' && !/[\n\r]/.test(v)

function lead(v: unknown, what: string): number | string {
  if (v === undefined) return 0
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v > MAX_TRIGGER_LEAD_MINUTES) {
    return `${what}: \`before\` is whole minutes, 0 to ${MAX_TRIGGER_LEAD_MINUTES}`
  }
  return v
}

function parseOne(raw: unknown): Trigger | string {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return 'each `on` item is a map, like `- file: inbox/**`'
  }
  const item = raw as Record<string, unknown>
  const sources = (['file', 'task', 'calendar', 'mail'] as const).filter((s) => s in item)
  if (sources.length !== 1) {
    return 'each `on` item names one of `file`, `task`, `calendar` or `mail`'
  }
  const source = sources[0]!
  const allowed: Record<TriggerSource, string[]> = {
    file: ['file', 'changed'],
    task: ['task', 'before'],
    calendar: ['calendar'],
    mail: ['mail'],
  }
  const extra = Object.keys(item).find((k) => !allowed[source].includes(k))
  if (extra !== undefined) return `${source}: unknown key \`${extra}\``

  switch (source) {
    case 'file': {
      const glob = item['file']
      if (!oneLine(glob) || glob.startsWith('/') || glob.split('/').includes('..')) {
        return 'file: a glob inside the vault, like `inbox/**`'
      }
      const changed = item['changed'] ?? false
      if (typeof changed !== 'boolean') return 'file: `changed` is true or false'
      return { source, glob: glob.trim(), changed }
    }
    case 'task': {
      const when = item['task']
      if (when !== 'due' && when !== 'overdue') return 'task: `due` or `overdue`'
      if (when === 'overdue' && item['before'] !== undefined) {
        return 'task: `before` goes with `due`, not `overdue`'
      }
      const before = lead(item['before'], 'task')
      return typeof before === 'string' ? before : { source, when, before }
    }
    case 'calendar': {
      const before = lead(item['calendar'], 'calendar')
      if (typeof before === 'string') return 'calendar: minutes before the event, like `30`'
      return { source, before }
    }
    case 'mail': {
      const query = item['mail']
      if (!oneLine(query)) return 'mail: a Gmail search, like `from:@acme.com`'
      return { source, query: query.trim() }
    }
  }
}

/** Read a schedule's `on:`. Absent is no triggers. */
export function parseTriggers(raw: unknown): TriggersParse {
  if (raw === undefined) return { ok: true, triggers: [] }
  if (!Array.isArray(raw) || raw.length === 0) {
    return { ok: false, error: '`on` is a list of triggers, like `- file: inbox/**`' }
  }
  const triggers: Trigger[] = []
  for (const item of raw) {
    const t = parseOne(item)
    if (typeof t === 'string') return { ok: false, error: `on: ${t}` }
    triggers.push(t)
  }
  return { ok: true, triggers }
}

const minutes = (n: number): string => (n % 60 === 0 && n > 0 ? `${n / 60} h` : `${n} min`)

/** One trigger, in words. */
export function describeTrigger(t: Trigger): string {
  switch (t.source) {
    case 'file':
      return `a file ${t.changed ? 'added or changed' : 'added'} in ${t.glob}`
    case 'task':
      if (t.when === 'overdue') return 'a task overdue'
      return t.before === 0 ? 'a task due' : `${minutes(t.before)} before a task is due`
    case 'calendar':
      return t.before === 0 ? 'an event starting' : `${minutes(t.before)} before an event`
    case 'mail':
      return `new mail matching ${t.query}`
  }
}

/** Every trigger of a schedule, in words: "On a file added in inbox/**, or a
 *  task overdue". */
export function describeTriggers(triggers: readonly Trigger[]): string {
  return `On ${triggers.map(describeTrigger).join(', or ')}`
}

/** Whether a vault path matches a trigger's glob: `*` and `?` stay within a
 *  folder, `**` crosses them, and `dir/**` matches everything under `dir`. */
export function matchesGlob(glob: string, path: string): boolean {
  let re = ''
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!
    if (c === '*' && glob[i + 1] === '*') {
      // `**/` is any number of folders, none included.
      if (glob[i + 2] === '/') {
        re += '(?:.*/)?'
        i += 2
      } else {
        re += '.*'
        i += 1
      }
    } else if (c === '*') re += '[^/]*'
    else if (c === '?') re += '[^/]'
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp(`^${re}$`).test(path)
}

/**
 * What one source says happened or will happen, told to every plugin started
 * in the vault (`PluginCtx.events`). Two kinds:
 *
 * - **`happened`**: an occurrence, heard once, deduped by `id` and `version`
 *   (a file's path and its new mtime, a thread and its latest message).
 * - **`upcoming`**: the whole current list of a timed source's moments (a
 *   task's due moment, an event's start), replacing the last list. A trigger
 *   fires at a moment minus its `before`, once.
 *
 * The agent plugin tells the sources what it listens for with **`interest`**,
 * again at every check, so a source started later hears it too and a source
 * with nothing listening does no work (Google polls nothing).
 */
export type VaultEvent =
  | {
      type: 'happened'
      source: 'file' | 'mail'
      /** `added`/`changed` for a file, `new` for mail. */
      kind: 'added' | 'changed' | 'new'
      /** The file's path; the thread's id. */
      id: string
      version: string
      /** A mail's query, which is what a trigger matches on. */
      query?: string
      /** A mail's sender address. The router names it only when it passes a
       *  strict address check. */
      from?: string
    }
  | { type: 'upcoming'; source: 'task' | 'calendar'; moments: Moment[] }
  | { type: 'interest'; interest: TriggerInterest }

/**
 * A timed source's moment. Structured fields only: the run's line is built
 * from them by the trigger router, never from text a source wrote.
 */
export interface Moment {
  /** The task's path, the event's id. */
  id: string
  /** `due`/`overdue` for a task, `starts` for an event. */
  kind: 'due' | 'overdue' | 'starts'
  /** ISO instant. */
  at: string
}

/** What the approved schedules listen for, so a source does only that work. */
export interface TriggerInterest {
  task: boolean
  calendar: boolean
  /** The Gmail queries to watch. */
  mail: string[]
}

export const NO_INTEREST: TriggerInterest = { task: false, calendar: false, mail: [] }

/** What a set of schedules' triggers listen for, together. */
export function interestOf(triggers: readonly Trigger[]): TriggerInterest {
  const mail = new Set<string>()
  let task = false
  let calendar = false
  for (const t of triggers) {
    if (t.source === 'task') task = true
    else if (t.source === 'calendar') calendar = true
    else if (t.source === 'mail') mail.add(t.query)
  }
  return { task, calendar, mail: [...mail].sort() }
}

/** Whether `event` is something `t` fires on. Moments are `upcoming`, and the
 *  router times those (`momentFireAt`). */
export function triggerHears(t: Trigger, event: VaultEvent & { type: 'happened' }): boolean {
  if (t.source === 'file' && event.source === 'file') {
    return (
      (event.kind === 'added' || (t.changed && event.kind === 'changed')) &&
      matchesGlob(t.glob, event.id)
    )
  }
  if (t.source === 'mail' && event.source === 'mail') return event.query === t.query
  return false
}

/** When `t` fires for `moment`, or null when it does not listen for it. */
export function momentFireAt(
  t: Trigger,
  source: 'task' | 'calendar',
  moment: Moment,
): number | null {
  const at = Date.parse(moment.at)
  if (Number.isNaN(at)) return null
  if (t.source === 'task' && source === 'task' && t.when === moment.kind) {
    return at - t.before * 60_000
  }
  if (t.source === 'calendar' && source === 'calendar') return at - t.before * 60_000
  return null
}
