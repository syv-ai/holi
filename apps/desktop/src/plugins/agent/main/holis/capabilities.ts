/**
 * The `holis.*` capabilities (docs/features/holis.md): list a vault's Holis,
 * approve one on this machine, send one a document, make one, and, from a
 * run, say what came of it.
 *
 * Writing a Holi is writing its file, which the agent may do with its own
 * tools. **Approving one is the UI door's alone**: it approves what will run
 * with the person's credentials and rules, and an approval the agent could
 * give, however a permission rule is worded, would be none. The dialog sends
 * back the fingerprint it showed, so it approves exactly that text and not
 * whatever a pull or a run wrote since. Sending one work opens an agent tab,
 * which is the person's act too: the UI door's.
 *
 * No `electron` import: this loads under plain Node in the tests.
 */
import { HOLI_MASCOTS, type HoliDraft } from '@holi/shared'
import {
  cap,
  CapabilityError,
  flagParam,
  noParams,
  paramsObject,
  stringParam,
  type CapabilityContext,
} from '../../../../main/plugin-api'
import type { HoliRun, Holis, HoliSummary, SendResult } from './holis'

export const HOLI_NAMESPACES = ['holis'] as const

export interface HoliCapabilitiesDeps {
  holis: Pick<Holis, 'list' | 'approve' | 'send' | 'report' | 'create'>
}

const vaultOf = (ctx: CapabilityContext) => ({ remote: ctx.remote, root: ctx.root })

const line = (s: HoliSummary): string =>
  [
    s.status,
    s.id,
    s.name,
    s.error ??
      (s.kind === 'scheduled'
        ? `scheduled: ${s.when ?? ''}`
        : (s.accepts ?? []).length === 0
          ? 'any document'
          : (s.accepts ?? []).join(', ')),
  ].join('\t')

const strings = (raw: unknown): string[] =>
  Array.isArray(raw) ? raw.filter((r): r is string => typeof r === 'string') : []

function draftParam(raw: unknown): HoliDraft {
  const p = paramsObject(raw)
  const text = (key: string): string | undefined => {
    const v = p[key]
    if (v === undefined || v === null || v === '') return undefined
    if (typeof v !== 'string') throw new CapabilityError('BAD_REQUEST', `${key} must be text`)
    return v
  }
  const mascot = text('mascot')
  if (mascot !== undefined && !(HOLI_MASCOTS as readonly string[]).includes(mascot)) {
    throw new CapabilityError('BAD_REQUEST', 'unknown mascot')
  }
  const out: HoliDraft = {
    name: stringParam(p, 'name'),
    instructions: stringParam(p, 'instructions'),
    accepts: strings(p['accepts']),
    allow: strings(p['allow']),
  }
  if (mascot !== undefined) out.mascot = mascot as HoliDraft['mascot']
  for (const key of ['color', 'description', 'model'] as const) {
    const v = text(key)
    if (v !== undefined) out[key] = v
  }
  return out
}

const geometry = (p: Record<string, unknown>): { cols?: number; rows?: number } => ({
  ...(typeof p['cols'] === 'number' ? { cols: p['cols'] } : {}),
  ...(typeof p['rows'] === 'number' ? { rows: p['rows'] } : {}),
})

export const holiCapabilities = (deps: HoliCapabilitiesDeps) => ({
  'holis.list': cap({
    doors: ['ui', 'cli'],
    cli: { args: [], summary: "the vault's Holis, and whether each is approved here" },
    params: noParams,
    run: (ctx): Promise<HoliSummary[]> => deps.holis.list(vaultOf(ctx)),
    text: (all: HoliSummary[]) =>
      all.length === 0 ? 'No Holis in .holi/holis/.' : all.map(line).join('\n'),
  }),

  'holis.approve': cap({
    doors: ['ui'],
    params: (raw) => {
      const p = paramsObject(raw)
      return { holi: stringParam(p, 'holi'), fingerprint: stringParam(p, 'fingerprint') }
    },
    run: (ctx, { holi, fingerprint }): Promise<HoliSummary> =>
      deps.holis.approve(vaultOf(ctx), holi, fingerprint),
  }),

  'holis.send': cap({
    doors: ['ui'],
    params: (raw) => {
      const p = paramsObject(raw)
      return { holi: stringParam(p, 'holi'), path: stringParam(p, 'path'), ...geometry(p) }
    },
    run: (ctx, { holi, ...doc }): Promise<SendResult> => deps.holis.send(vaultOf(ctx), holi, doc),
  }),

  /** What came of this run, in the Holi's own words: its entry on the Holi's
   *  page. `--needs-you` asks the person to act. */
  'holis.report': cap({
    doors: ['cli'],
    cli: {
      args: ['holi', 'text'],
      summary: "say what came of this Holi's run; --needs-you when the person must act",
      flags: ['needs-you'],
      stdin: 'text',
    },
    params: (raw) => {
      const p = paramsObject(raw)
      return {
        holi: stringParam(p, 'holi'),
        text: stringParam(p, 'text'),
        needsYou: flagParam(p, 'needs-you'),
      }
    },
    run: (ctx, { holi, text, needsYou }): Promise<HoliRun> =>
      deps.holis.report(vaultOf(ctx), holi, text, needsYou),
    text: () => 'reported',
  }),

  'holis.create': cap({
    doors: ['ui'],
    writes: true,
    params: draftParam,
    run: (ctx, draft): Promise<HoliSummary> => deps.holis.create(vaultOf(ctx), draft),
  }),
})
