/**
 * The `schedules.*` capabilities (docs/features/scheduled-agents.md): list a
 * vault's automations, write one from the editor, turn one on or off on this
 * machine, run one now.
 * The renderer's Schedules section and the agent's `holi schedules` reach the
 * same entries, all but `enable`.
 *
 * Writing a schedule is writing its file, which the agent does with its own
 * tools; so there is no `create`. **Turning one on is the UI door's alone**: it
 * approves what will run unattended, and an approval the agent could give,
 * however a permission rule is worded, would be none. So `enable` is a switch
 * in Settings, beside the prompt it approves, and no `holi` command. The switch
 * sends back the fingerprint the row showed, so it approves exactly that text
 * and not whatever a pull or the agent wrote since. Running
 * one that is already on, or turning one off, approves nothing new: the agent
 * may (`run` asks the person first, `claude/seed.ts`).
 *
 * No `electron` import: this loads under plain Node in the tests.
 */
import { parseTriggers, triggerYaml, type ScheduleDraft, type Trigger } from '@holi/shared'
import {
  cap,
  CapabilityError,
  noParams,
  optionalStringParam,
  paramsObject,
  stringParam,
  type CapabilityContext,
} from '../../../main/plugin-api'
import type { RunRecord, Scheduler, ScheduleSummary } from './scheduler'

export const SCHEDULE_NAMESPACES = ['schedules'] as const

export interface ScheduleCapabilitiesDeps {
  scheduler: Pick<Scheduler, 'list' | 'enable' | 'disable' | 'run' | 'save' | 'remove'>
}

const texts = (raw: unknown, key: string): string[] => {
  if (raw === undefined || raw === null) return []
  if (!Array.isArray(raw) || raw.some((r) => typeof r !== 'string')) {
    throw new CapabilityError('BAD_REQUEST', `${key} must be a list of text`)
  }
  return raw as string[]
}

/** The editor's draft, read as untrusted: the file's own parse is the last
 *  word on what it says. */
function draftParam(raw: unknown): ScheduleDraft {
  const p = paramsObject(raw)
  const holi = optionalStringParam(p, 'holi')
  const model = optionalStringParam(p, 'model')
  const catchUp = p['catchUpMinutes']
  if (catchUp !== undefined && catchUp !== null && (typeof catchUp !== 'number' || catchUp < 0)) {
    throw new CapabilityError('BAD_REQUEST', 'catchUpMinutes must be a number of minutes')
  }
  // `on` comes as the editor holds it, and is read the way the file is:
  // written out, then parsed, so a malformed item is refused like a hand
  // edit's.
  let on: Trigger[] | undefined
  if (Array.isArray(p['on'])) {
    if (p['on'].length === 0) on = []
    else {
      const parsed = parseTriggers(
        p['on'].map((item: unknown) =>
          item !== null && typeof item === 'object' ? triggerYaml(item as Trigger) : item,
        ),
      )
      if (!parsed.ok) throw new CapabilityError('BAD_REQUEST', parsed.error)
      on = parsed.triggers
    }
  } else if (p['on'] !== undefined) {
    throw new CapabilityError('BAD_REQUEST', 'on must be a list of triggers')
  }
  return {
    ...(on === undefined ? {} : { on }),
    name: stringParam(p, 'name'),
    crons: texts(p['crons'], 'crons'),
    prompt: stringParam(p, 'prompt'),
    allow: texts(p['allow'], 'allow'),
    ...(holi === undefined ? {} : { holi }),
    ...(model === undefined ? {} : { model }),
    ...(typeof catchUp === 'number' ? { catchUpMinutes: catchUp } : {}),
  }
}

const refParams = (raw: unknown): { schedule: string } => ({
  schedule: stringParam(paramsObject(raw), 'schedule'),
})

const vaultOf = (ctx: CapabilityContext) => ({ remote: ctx.remote, root: ctx.root })

/** A local minute, for the CLI's one-line rows. */
function short(iso: string | undefined): string {
  if (iso === undefined) return '-'
  const d = new Date(iso)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

const line = (s: ScheduleSummary): string =>
  [
    s.status,
    s.slug,
    s.name,
    s.error ?? s.when ?? '',
    `next ${short(s.nextRun)}`,
    `last ${short(s.lastRun)}`,
  ].join('\t')

export const scheduleCapabilities = (deps: ScheduleCapabilitiesDeps) => ({
  'schedules.list': cap({
    doors: ['ui', 'cli'],
    cli: { args: [], summary: "the vault's scheduled agents, and whether each runs here" },
    params: noParams,
    run: (ctx): Promise<ScheduleSummary[]> => deps.scheduler.list(vaultOf(ctx)),
    text: (all) =>
      all.length === 0
        ? 'No schedules: a schedule is a .holi/schedules/<name>.local.md file.'
        : all.map(line).join('\n'),
  }),

  'schedules.enable': cap({
    doors: ['ui'],
    params: (raw) => {
      const p = paramsObject(raw)
      return { schedule: stringParam(p, 'schedule'), fingerprint: stringParam(p, 'fingerprint') }
    },
    run: (ctx, { schedule, fingerprint }): Promise<ScheduleSummary> =>
      deps.scheduler.enable(vaultOf(ctx), schedule, fingerprint),
  }),

  /** The automation editor's Create and Save: the file, written from the
   *  draft. Writing approves nothing: turning it on is `enable`, with the
   *  fingerprint of what was written. */
  'schedules.save': cap({
    doors: ['ui'],
    writes: true,
    params: (raw) => {
      const p = paramsObject(raw)
      const path = optionalStringParam(p, 'path')
      return { draft: draftParam(p['draft']), ...(path === undefined ? {} : { path }) }
    },
    run: (ctx, { draft, path }): Promise<ScheduleSummary> =>
      deps.scheduler.save(vaultOf(ctx), draft, path),
  }),

  'schedules.remove': cap({
    doors: ['ui'],
    writes: true,
    params: refParams,
    run: async (ctx, { schedule }): Promise<{ ok: true }> => {
      await deps.scheduler.remove(vaultOf(ctx), schedule)
      return { ok: true }
    },
  }),

  'schedules.disable': cap({
    doors: ['ui', 'cli'],
    cli: { args: ['schedule'], summary: 'turn a schedule off on this machine' },
    params: refParams,
    run: (ctx, { schedule }): Promise<ScheduleSummary> =>
      deps.scheduler.disable(vaultOf(ctx), schedule),
    text: (s) => `${line(s)}\n`,
  }),

  'schedules.run': cap({
    doors: ['ui', 'cli'],
    cli: { args: ['schedule'], summary: 'start a run of a schedule that is on, now' },
    params: refParams,
    run: async (ctx, { schedule }): Promise<RunRecord> => {
      const record = await deps.scheduler.run(vaultOf(ctx), schedule)
      if (record.outcome === 'failed') {
        throw new CapabilityError('UNAVAILABLE', record.message ?? 'The run did not start.')
      }
      return record
    },
    text: (r) =>
      r.outcome === 'started' ? `started session ${r.jobId}` : `skipped: ${r.message ?? ''}`,
  }),
})
