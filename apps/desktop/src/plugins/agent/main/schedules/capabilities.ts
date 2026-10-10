/**
 * The `schedules.*` capabilities (docs/features/scheduled-agents.md): list a
 * vault's scheduled agents, turn one on or off on this machine, run one now.
 * The renderer's Schedules section and the agent's `holi schedules` reach the
 * same entries.
 *
 * Writing a schedule is writing its file, which the agent does with its own
 * tools; so there is no `create`. Turning one on approves what it will run
 * unattended, and the agent's settings ask the person before `holi schedules
 * enable` and `run` (`claude/seed.ts`).
 *
 * No `electron` import: this loads under plain Node in the tests.
 */
import {
  cap,
  CapabilityError,
  noParams,
  paramsObject,
  stringParam,
  type CapabilityContext,
} from '../../../../main/plugin-api'
import type { RunRecord, Scheduler, ScheduleSummary } from './scheduler'

export const SCHEDULE_NAMESPACES = ['schedules'] as const

export interface ScheduleCapabilitiesDeps {
  scheduler: Pick<Scheduler, 'list' | 'enable' | 'disable' | 'run'>
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
      all.length === 0 ? 'No schedules in .holi/schedules/.' : all.map(line).join('\n'),
  }),

  'schedules.enable': cap({
    doors: ['ui', 'cli'],
    cli: {
      args: ['schedule'],
      summary: 'turn a schedule on here, approving its prompt and allowed tools',
    },
    params: refParams,
    run: (ctx, { schedule }): Promise<ScheduleSummary> =>
      deps.scheduler.enable(vaultOf(ctx), schedule),
    text: (s) => `${line(s)}\n`,
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
