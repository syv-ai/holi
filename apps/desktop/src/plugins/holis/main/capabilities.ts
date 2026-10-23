/**
 * The `holis.*` capabilities (docs/features/holis.md): list a vault's Holis,
 * approve one on this machine, send one a document, make, edit and remove
 * one, read and save its soul and memory; from a run, say what came of it and
 * keep its memory; and, for an automation, how to run one.
 *
 * Writing a Holi is writing its files, which the agent may do with its own
 * tools. **Approving one is the UI door's alone**: it approves what will run
 * with the person's credentials and rules, and an approval the agent could
 * give, however a permission rule is worded, would be none. The dialog sends
 * back the fingerprint it showed, so it approves exactly that text and not
 * whatever a pull or a run wrote since.
 *
 * No `electron` import: this loads under plain Node in the tests.
 */
import { holiMascotOf, type HoliDraft, type HoliMascot, type MemoryHit } from '@holi/shared'
import {
  cap,
  CapabilityError,
  flagParam,
  noParams,
  optionalStringParam,
  paramsObject,
  stringParam,
  type CapabilityContext,
} from '../../../main/plugin-api'
import type { HoliContext, HoliEdits, HoliRun, Holis, HoliSummary } from './holis'
import {
  forget,
  readFiles,
  recall,
  remember,
  revise,
  saveFile,
  search,
  type HoliFiles,
} from './memory'

export const HOLI_NAMESPACES = ['holis'] as const

export interface HoliCapabilitiesDeps {
  holis: Holis
  /** Tell the renderer a Holi's files moved: its page reads them again. */
  changed(remote: string): void
  now?: () => Date
}

const vaultOf = (ctx: CapabilityContext) => ({ remote: ctx.remote, root: ctx.root })

const line = (s: HoliSummary): string =>
  [
    s.status,
    s.id,
    s.name,
    s.error ?? ((s.accepts ?? []).length === 0 ? 'any document' : (s.accepts ?? []).join(', ')),
  ].join('\t')

const strings = (raw: unknown, key: string): string[] | undefined => {
  if (raw === undefined) return undefined
  if (!Array.isArray(raw) || raw.some((r) => typeof r !== 'string')) {
    throw new CapabilityError('BAD_REQUEST', `${key} must be a list of text`)
  }
  return raw as string[]
}

const mascotParam = (v: unknown): HoliMascot | undefined => {
  if (v === undefined || v === null || v === '') return undefined
  // An older arcade name still reads, as the character that stands in for it.
  const mascot = holiMascotOf(v)
  if (mascot === undefined) throw new CapabilityError('BAD_REQUEST', 'unknown mascot')
  return mascot
}

function draftParam(raw: unknown): Partial<HoliDraft> {
  const p = raw === undefined ? {} : paramsObject(raw)
  const out: Partial<HoliDraft> = {}
  const mascot = mascotParam(p['mascot'])
  if (mascot !== undefined) out.mascot = mascot
  for (const key of ['name', 'color', 'description', 'model', 'soul'] as const) {
    const v = optionalStringParam(p, key)
    if (v !== undefined) out[key] = v
  }
  const accepts = strings(p['accepts'], 'accepts')
  const allow = strings(p['allow'], 'allow')
  if (accepts !== undefined) out.accepts = accepts
  if (allow !== undefined) out.allow = allow
  return out
}

function editsParam(raw: unknown): { holi: string; edits: HoliEdits } {
  const p = paramsObject(raw)
  const e = paramsObject(p['edits'])
  const edits: HoliEdits = {}
  if ('name' in e) edits.name = optionalStringParam(e, 'name') ?? ''
  if ('mascot' in e) {
    const mascot = mascotParam(e['mascot'])
    if (mascot !== undefined) edits.mascot = mascot
  }
  if ('color' in e) {
    const color = optionalStringParam(e, 'color')
    if (color !== undefined) edits.color = color
  }
  if ('description' in e) edits.description = optionalStringParam(e, 'description') ?? ''
  if ('model' in e) edits.model = optionalStringParam(e, 'model') ?? null
  if ('accepts' in e) edits.accepts = strings(e['accepts'], 'accepts') ?? []
  if ('allow' in e) edits.allow = strings(e['allow'], 'allow') ?? []
  return { holi: stringParam(p, 'holi'), edits }
}

/** The Holi a memory command names, as its folder. */
async function dirOf(holis: Holis, ctx: CapabilityContext, ref: string): Promise<string> {
  const found = (await holis.list(vaultOf(ctx))).filter((h) => h.id === ref || h.path === ref)
  if (found.length !== 1) throw new CapabilityError('NOT_FOUND', `No Holi ${ref}`)
  return found[0]!.dir
}

const hitLine = (h: MemoryHit): string => `${h.file}\t${h.line}`

export const holiCapabilities = (deps: HoliCapabilitiesDeps) => {
  const now = deps.now ?? (() => new Date())
  return {
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
        return { holi: stringParam(p, 'holi'), path: stringParam(p, 'path') }
      },
      run: (ctx, { holi, path }): Promise<{ sessionId: string }> =>
        deps.holis.send(vaultOf(ctx), holi, path),
    }),

    /** What came of this run, in the Holi's own words: its entry on the
     *  Holi's page. `--needs-you` asks the person to act. */
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

    'holis.update': cap({
      doors: ['ui'],
      writes: true,
      params: editsParam,
      run: (ctx, { holi, edits }): Promise<HoliSummary> =>
        deps.holis.update(vaultOf(ctx), holi, edits),
    }),

    'holis.remove': cap({
      doors: ['ui'],
      writes: true,
      params: (raw) => ({ holi: stringParam(paramsObject(raw), 'holi') }),
      run: async (ctx, { holi }): Promise<{ ok: true }> => {
        await deps.holis.remove(vaultOf(ctx), holi)
        return { ok: true }
      },
    }),

    /** How an automation runs the Holi: from the automations plugin's main
     *  side, through `ctx.call`. */
    'holis.context': cap({
      doors: ['ui'],
      params: (raw) => ({ holi: stringParam(paramsObject(raw), 'holi') }),
      run: (ctx, { holi }): Promise<HoliContext> => deps.holis.context(vaultOf(ctx), holi),
    }),

    /** Its soul and memory, for its page. */
    'holis.files': cap({
      doors: ['ui'],
      params: (raw) => ({ holi: stringParam(paramsObject(raw), 'holi') }),
      run: async (ctx, { holi }): Promise<HoliFiles> =>
        readFiles(ctx.root, await dirOf(deps.holis, ctx, holi)),
    }),

    /** The page's soul or memory, saved over the text it opened only. */
    'holis.save': cap({
      doors: ['ui'],
      writes: true,
      params: (raw) => {
        const p = paramsObject(raw)
        const file = stringParam(p, 'file')
        if (file !== 'soul' && file !== 'memory') {
          throw new CapabilityError('BAD_REQUEST', 'file is soul or memory')
        }
        return {
          holi: stringParam(p, 'holi'),
          file: file as 'soul' | 'memory',
          text: typeof p['text'] === 'string' ? p['text'] : stringParam(p, 'text'),
          expected: stringParam(p, 'expected'),
        }
      },
      run: async (ctx, { holi, file, text, expected }) => {
        const res = await saveFile(
          ctx.root,
          await dirOf(deps.holis, ctx, holi),
          file,
          text,
          expected,
        )
        if (res.ok) deps.changed(ctx.remote)
        return res
      },
    }),

    'holis.remember': cap({
      doors: ['cli'],
      writes: true,
      cli: {
        args: ['holi', 'fact'],
        summary: 'remember a fact for next time; --until <date>, --topic <name>',
      },
      params: (raw) => {
        const p = paramsObject(raw)
        const until = optionalStringParam(p, 'until')
        const topic = optionalStringParam(p, 'topic')
        return {
          holi: stringParam(p, 'holi'),
          fact: stringParam(p, 'fact'),
          ...(until === undefined ? {} : { until }),
          ...(topic === undefined ? {} : { topic }),
        }
      },
      run: async (ctx, { holi, ...args }): Promise<string> => {
        const out = await remember(ctx.root, await dirOf(deps.holis, ctx, holi), args, now())
        deps.changed(ctx.remote)
        return out
      },
      text: (s: string) => s,
    }),

    'holis.revise': cap({
      doors: ['cli'],
      writes: true,
      cli: {
        args: ['holi', 'find', 'fact'],
        summary: 'replace the remembered line containing <find> with a new fact',
      },
      params: (raw) => {
        const p = paramsObject(raw)
        const topic = optionalStringParam(p, 'topic')
        return {
          holi: stringParam(p, 'holi'),
          find: stringParam(p, 'find'),
          fact: stringParam(p, 'fact'),
          ...(topic === undefined ? {} : { topic }),
        }
      },
      run: async (ctx, { holi, ...args }): Promise<string> => {
        const out = await revise(ctx.root, await dirOf(deps.holis, ctx, holi), args, now())
        deps.changed(ctx.remote)
        return out
      },
      text: (s: string) => s,
    }),

    'holis.forget': cap({
      doors: ['cli'],
      writes: true,
      cli: { args: ['holi', 'find'], summary: 'forget the remembered line containing <find>' },
      params: (raw) => {
        const p = paramsObject(raw)
        const topic = optionalStringParam(p, 'topic')
        return {
          holi: stringParam(p, 'holi'),
          find: stringParam(p, 'find'),
          ...(topic === undefined ? {} : { topic }),
        }
      },
      run: async (ctx, { holi, ...args }): Promise<string> => {
        const out = await forget(ctx.root, await dirOf(deps.holis, ctx, holi), args)
        deps.changed(ctx.remote)
        return out
      },
      text: (s: string) => s,
    }),

    'holis.recall': cap({
      doors: ['cli'],
      cli: { args: ['holi', 'topic?'], summary: "read the Holi's memory, or one topic note" },
      params: (raw) => {
        const p = paramsObject(raw)
        const topic = optionalStringParam(p, 'topic')
        return { holi: stringParam(p, 'holi'), ...(topic === undefined ? {} : { topic }) }
      },
      run: async (ctx, { holi, topic }): Promise<string> =>
        recall(ctx.root, await dirOf(deps.holis, ctx, holi), topic),
      text: (s: string) => s,
    }),

    'holis.search': cap({
      doors: ['cli'],
      cli: { args: ['holi', 'query'], summary: "search the Holi's memory; --since 7d or a date" },
      params: (raw) => {
        const p = paramsObject(raw)
        const since = optionalStringParam(p, 'since')
        return {
          holi: stringParam(p, 'holi'),
          query: stringParam(p, 'query'),
          ...(since === undefined ? {} : { since }),
        }
      },
      run: async (ctx, { holi, ...args }): Promise<MemoryHit[]> =>
        search(ctx.root, await dirOf(deps.holis, ctx, holi), args, now()),
      text: (hits: MemoryHit[]) =>
        hits.length === 0 ? 'nothing found' : hits.map(hitLine).join('\n'),
    }),
  }
}
