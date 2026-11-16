import { fenceUntrusted } from '@holi/shared'
import type { ActivityEntry, ActivityLog } from '../activity/log'
import { cap, type CapabilityContext } from './registry'
import { CapabilityError } from './error'

const CHANNELS = ['git', 'sync', 'agent', 'plugins', 'app', 'google'] as const
const bad = (message: string): never => {
  throw new CapabilityError('BAD_REQUEST', message)
}

function cutoff(since: string | undefined, now: number): number | undefined {
  if (since === undefined) return undefined
  const relative = /^(\d+)(m|h|d)$/.exec(since)
  if (relative) {
    const amount = Number(relative[1])
    const scale = relative[2] === 'm' ? 60_000 : relative[2] === 'h' ? 3_600_000 : 86_400_000
    const duration = amount * scale
    if (
      !Number.isSafeInteger(amount) ||
      amount < 1 ||
      !Number.isSafeInteger(duration) ||
      duration > 100 * 365 * 86_400_000
    )
      return bad('--since must be a positive, bounded duration or timezone-qualified ISO timestamp')
    return now - duration
  }
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d(?:\.\d{1,3})?)?(?:Z|[+-]\d\d:\d\d)$/.test(since)) {
    return bad('--since must be a duration (15m, 2h, 1d) or timezone-qualified ISO timestamp')
  }
  const date = since.slice(0, 10)
  const [year, month, day] = date.split('-').map(Number)
  const check = new Date(Date.UTC(year!, month! - 1, day!))
  if (check.toISOString().slice(0, 10) !== date) return bad('--since is not a valid timestamp')
  const time = Date.parse(since)
  if (!Number.isFinite(time)) return bad('--since is not a valid timestamp')
  return time
}

export function logsCapabilities(log: ActivityLog, now: () => number = Date.now) {
  return {
    'logs.list': cap({
      doors: ['cli'],
      cli: {
        args: [],
        values: ['channel', 'since'],
        standalone: true,
        summary:
          'current-session activity (bounded, oldest first); filter with --channel git|sync|agent|plugins|app|google and --since 15m|2h|1d|ISO timestamp',
      },
      params(raw: unknown) {
        if (raw === null || typeof raw !== 'object' || Array.isArray(raw))
          return bad('invalid filters')
        const values = raw as Record<string, unknown>
        if (Object.keys(values).some((key) => key !== 'channel' && key !== 'since'))
          return bad('unknown log filter')
        const channel = values.channel
        const since = values.since
        if (
          channel !== undefined &&
          (typeof channel !== 'string' || !CHANNELS.includes(channel as (typeof CHANNELS)[number]))
        )
          return bad('--channel must be git, sync, agent, plugins, app, or google')
        if (since !== undefined && typeof since !== 'string') return bad('--since must be text')
        const from = cutoff(since as string | undefined, now())
        return { channel: channel as string | undefined, from }
      },
      async run(ctx: CapabilityContext, filter): Promise<ActivityEntry[]> {
        return log.entries().filter((entry) => {
          if (entry.remote !== ctx.remote && !(entry.global === true && entry.remote === undefined))
            return false
          if (
            filter.channel === 'google'
              ? entry.plugin !== 'google'
              : filter.channel !== undefined && entry.channel !== filter.channel
          )
            return false
          if (filter.from !== undefined && Date.parse(entry.at) < filter.from) return false
          return true
        })
      },
      cliValue(entries: ActivityEntry[]) {
        return entries.map((entry) => ({
          ...entry,
          message: fenceUntrusted(entry.message, 'web'),
          ...(entry.detail === undefined ? {} : { detail: fenceUntrusted(entry.detail, 'web') }),
        }))
      },
      text: (entries: ActivityEntry[]) =>
        entries
          .map(
            (entry) =>
              `${entry.at}\t${entry.channel}${entry.plugin ? `/${entry.plugin}` : ''}\t${entry.level}\t${entry.message}${entry.detail ? `\n${entry.detail}` : ''}`,
          )
          .join('\n'),
    }),
  }
}
