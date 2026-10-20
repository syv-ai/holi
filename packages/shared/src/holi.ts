/**
 * A Holi: an agent that belongs to the vault, with a face, that a person sends
 * work to (docs/features/holis.md). A Holi is **triggered**: it runs when
 * someone sends it something, today a document, with the person there to
 * answer Claude Code's prompts. It never runs on a clock on a member's machine;
 * local schedules are scheduled agents (`schedule.ts`).
 *
 * One YAML file, `.holi/holis/<id>.yaml` (`<id>.local.yaml` keeps one on this
 * machine), committed and synced like a note:
 *
 * ```yaml
 * name: Proposal
 * mascot: rocket
 * description: Turns a customer note into a PDF proposal
 * model: sonnet
 * accepts:
 *   - kunder/**\/*.md
 * allow:
 *   - Edit(tilbud/**)
 * instructions: |
 *   Write a proposal for the customer in the note, laid out as
 *   Templates/proposal.typ, and export it as a PDF to tilbud/.
 * ```
 *
 * A file with a `cron` or `at` is a **scheduled Holi** instead: shared vault
 * work that runs once per moment in Claude Code's cloud against the vault's
 * repository, never on a member's machine. It takes no document (`accepts`),
 * and may name nothing only a machine has (`holi` commands, `.local.` files).
 *
 * YAML rather than markdown with frontmatter, so it can carry settings as it
 * grows: a key this build does not know is kept on write and ignored on read,
 * with a warning, never an error. A write from Holi edits the file in place
 * (`editHoliText`), keeping a person's comments and key order.
 *
 * Pure and browser-safe: the renderer reads a file the way main runs it.
 */
import { Document, parse as parseYaml, parseDocument, Scalar } from 'yaml'
import { CronError, parseCron, shortestGapMinutes } from './cron'
import { parseDateTime } from './dates'
import { HOLIS_SURFACE_DIR } from './path-safety'
import { MIN_SCHEDULE_GAP_MINUTES, type ScheduleWhen } from './schedule'

/** Where Holi definitions live: one file each, directly inside. */
export const HOLIS_DIR = HOLIS_SURFACE_DIR

/**
 * The pixel figures a Holi can be drawn as (after MonoCode's project mascots).
 * The sprites themselves are the renderer's; the names are the file's grammar.
 */
export const HOLI_MASCOTS = [
  'invader',
  'ghost',
  'robot',
  'cat',
  'skull',
  'crab',
  'mushroom',
  'rocket',
  'dino',
  'frog',
] as const
export type HoliMascot = (typeof HOLI_MASCOTS)[number]

/** Soft identity colours a new Holi is given in turn: categorical, the one
 *  place hue is a Holi's own. */
export const HOLI_COLOURS = [
  '#a5a1ff',
  '#7ee0b5',
  '#f0b46a',
  '#f28fb1',
  '#7cc4f2',
  '#d6c36b',
] as const

export interface HoliDef {
  /** The file's own name: `ada` for `.holi/holis/ada.yaml`. */
  id: string
  name: string
  mascot: HoliMascot
  /** `#rrggbb`. */
  color: string
  description: string
  /** A Claude Code model alias or id, for `--model`. */
  model?: string
  /** Vault-path globs of the documents it takes. Empty: any document. */
  accepts: string[]
  /** Its `cron` or `at`: a scheduled Holi, run in the cloud. Absent: one a
   *  person sends work to. */
  when?: ScheduleWhen
  /** Claude Code permission rules a run may use without asking. */
  allow: string[]
  /** What a run carries out. */
  instructions: string
  /** Keys this build does not know: kept in the file, ignored here, shown as
   *  a warning. */
  unknownKeys: string[]
}

export type HoliParse = { ok: true; def: HoliDef } | { ok: false; error: string }

const ID_RE = /^[a-z0-9][a-z0-9-]{0,47}$/
const MODEL_RE = /^[A-Za-z0-9][\w.:[\]-]*$/
const COLOR_RE = /^#[0-9a-f]{6}$/i

/** The keys a Holi file has today. Any other is a later setting: kept. */
const HOLI_KEYS = new Set([
  'name',
  'mascot',
  'color',
  'description',
  'model',
  'accepts',
  'cron',
  'at',
  'allow',
  'instructions',
])

/**
 * A key that would choose how Claude Code asks. A run keeps Claude Code's own
 * prompts and `allow` is the one way past one: a permission mode, or a bypass,
 * is refused rather than ignored, so nobody believes it applies.
 */
const PERMISSION_KEY = /permission|bypass|skip|danger|dontask|yolo/i

/** A `holi` command, or a machine-local file: what only a member's machine
 *  has, and a cloud run cannot reach. */
const MACHINE_ONLY = /(?:^|[\s(`'"])holi\s+[a-z]|\.local\./i

/** A rule that would let a run write anywhere: the agent's surface included,
 *  so a run could be talked into changing every later one. */
const BARE_WRITE = /^(?:Edit|Write|MultiEdit)(?:\(\s*(?:\*\*?(?:\/\*\*?)*)?\s*\))?$/

/** Whether a vault path is a Holi file: a YAML file directly inside
 *  `HOLIS_DIR`. A `.local.yaml` one is a Holi only this machine has. */
export function isHoliFilePath(path: string): boolean {
  if (!path.startsWith(`${HOLIS_DIR}/`)) return false
  const rest = path.slice(HOLIS_DIR.length + 1)
  return !rest.includes('/') && rest.endsWith('.yaml') && rest !== '.yaml'
}

/** `ada` for `.holi/holis/ada.yaml` and `.holi/holis/ada.local.yaml`. */
export function holiIdOf(path: string): string {
  const base = path.slice(path.lastIndexOf('/') + 1)
  return base.replace(/\.yaml$/, '').replace(/\.local$/, '')
}

/** A name as an id: lowercase words joined by dashes. Empty for a name with
 *  no letters or digits. */
export function holiSlug(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
}

/** A stable pick from a list by a string, so an unset mascot or colour does
 *  not change between reads. */
function pick<T>(list: readonly T[], seed: string): T {
  let hash = 0
  for (let i = 0; i < seed.length; i++) hash = (hash * 131 + seed.charCodeAt(i)) >>> 0
  return list[hash % list.length]!
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

/** `cron` or `at`, never both; undefined for neither; an error in words. */
function readWhen(cronText: unknown, atText: unknown): ScheduleWhen | undefined | string {
  if (cronText !== undefined && atText !== undefined) return 'give a `cron` or an `at`, not both'
  if (cronText !== undefined) {
    if (typeof cronText !== 'string') return '`cron` must be quoted text'
    try {
      const cron = parseCron(cronText)
      if (shortestGapMinutes(cron) < MIN_SCHEDULE_GAP_MINUTES) {
        return `cron: runs more often than every ${MIN_SCHEDULE_GAP_MINUTES} minutes`
      }
      return { kind: 'cron', cron }
    } catch (err) {
      if (err instanceof CronError) return `cron: ${err.message}`
      throw err
    }
  }
  if (atText !== undefined) {
    // YAML reads an unquoted timestamp as a Date; the stamp is wall-clock
    // text, so only the quoted form is unambiguous.
    const stamp = typeof atText === 'string' ? atText.trim() : null
    const local = stamp === null ? null : localStamp(stamp)
    if (stamp === null || local === null) {
      return '`at` must be a quoted local time, "YYYY-MM-DDTHH:MM"'
    }
    return { kind: 'at', stamp, local }
  }
  return undefined
}

/**
 * Read a Holi file. Never throws: a file that does not parse is a Holi that
 * does not run, and says why.
 */
export function parseHoliFile(text: string, path: string): HoliParse {
  const id = holiIdOf(path)
  if (!ID_RE.test(id)) {
    return { ok: false, error: 'the file name must be lowercase letters, digits and dashes' }
  }
  let raw: unknown
  try {
    raw = parseYaml(text)
  } catch (err) {
    return { ok: false, error: `it is not YAML: ${(err as Error).message}` }
  }
  if (raw === null || raw === undefined) return { ok: false, error: 'it is empty' }
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: 'it is not a map of settings' }
  }
  const f = raw as Record<string, unknown>

  const asking = Object.keys(f).find((k) => PERMISSION_KEY.test(k))
  if (asking !== undefined) {
    return {
      ok: false,
      error: `\`${asking}\`: a Holi runs with Claude Code's own prompts. \`allow\` names what it may do without asking; nothing turns the prompts off.`,
    }
  }

  const rawName = f['name']
  if (rawName !== undefined && (typeof rawName !== 'string' || rawName.trim() === '')) {
    return { ok: false, error: '`name` must be text' }
  }
  const rawMascot = f['mascot']
  if (rawMascot !== undefined && !(HOLI_MASCOTS as readonly unknown[]).includes(rawMascot)) {
    return { ok: false, error: `\`mascot\` is one of ${HOLI_MASCOTS.join(', ')}` }
  }
  const rawColor = f['color']
  if (rawColor !== undefined && (typeof rawColor !== 'string' || !COLOR_RE.test(rawColor))) {
    return { ok: false, error: '`color` must be a quoted `#rrggbb`' }
  }
  const rawDescription = f['description']
  if (rawDescription !== undefined && typeof rawDescription !== 'string') {
    return { ok: false, error: '`description` must be text' }
  }
  const rawModel = f['model']
  if (rawModel !== undefined && (typeof rawModel !== 'string' || !MODEL_RE.test(rawModel))) {
    return { ok: false, error: '`model` must be one model name, like `sonnet`' }
  }
  const when = readWhen(f['cron'], f['at'])
  if (typeof when === 'string') return { ok: false, error: when }
  const rawAccepts = f['accepts'] ?? []
  const acceptsList = typeof rawAccepts === 'string' ? [rawAccepts] : rawAccepts
  if (
    !Array.isArray(acceptsList) ||
    acceptsList.some((g) => typeof g !== 'string' || g.trim() === '')
  ) {
    return { ok: false, error: '`accepts` is a list of vault paths, like `kunder/**/*.md`' }
  }
  const accepts = (acceptsList as string[]).map((g) => g.trim())
  if (when !== undefined && accepts.length > 0) {
    return {
      ok: false,
      error: 'a scheduled Holi (`cron` or `at`) takes no document, so no `accepts`',
    }
  }

  const rawAllow = f['allow'] ?? []
  if (!Array.isArray(rawAllow)) return { ok: false, error: '`allow` must be a list of rules' }
  const allow: string[] = []
  for (const rule of rawAllow) {
    if (typeof rule !== 'string' || rule.trim() === '' || /[\n\r]/.test(rule)) {
      return { ok: false, error: '`allow` holds one permission rule per item, as text' }
    }
    if (BARE_WRITE.test(rule.trim())) {
      return {
        ok: false,
        error: `\`${rule.trim()}\` lets a run write anywhere, its own instructions included. Name the folders it writes: \`Edit(tilbud/**)\`.`,
      }
    }
    allow.push(rule.trim())
  }
  const rawInstructions = f['instructions']
  if (typeof rawInstructions !== 'string' || rawInstructions.trim() === '') {
    return { ok: false, error: '`instructions` (what a run carries out) is empty' }
  }
  const instructions = rawInstructions.trim()
  if (when !== undefined && [...allow, instructions].some((x) => MACHINE_ONLY.test(x))) {
    return {
      ok: false,
      error:
        'a scheduled Holi runs in the cloud, on the vault alone: it has no `holi` commands (mail, agenda) and no `.local.` files. A schedule that needs this machine is a scheduled agent (`.holi/schedules/`).',
    }
  }

  return {
    ok: true,
    def: {
      id,
      name: typeof rawName === 'string' ? rawName.trim() : id,
      mascot: (rawMascot as HoliMascot | undefined) ?? pick(HOLI_MASCOTS, id),
      color: typeof rawColor === 'string' ? rawColor.toLowerCase() : pick(HOLI_COLOURS, id),
      description: typeof rawDescription === 'string' ? rawDescription.trim() : '',
      ...(typeof rawModel === 'string' ? { model: rawModel } : {}),
      accepts,
      ...(when === undefined ? {} : { when }),
      allow,
      instructions,
      unknownKeys: Object.keys(f).filter((k) => !HOLI_KEYS.has(k)),
    },
  }
}

/** Whether a Holi takes the document at `path`: any, when it names none. */
export function holiAccepts(def: HoliDef, path: string): boolean {
  if (def.when !== undefined) return false
  return def.accepts.length === 0 || def.accepts.some((g) => globToRegExp(g).test(path))
}

/** A vault-path glob as a pattern: `**` any folders, `*` within one name,
 *  `?` one character. */
export function globToRegExp(glob: string): RegExp {
  let out = ''
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!
    if (c === '*' && glob[i + 1] === '*') {
      // `**/` is zero or more folders; a trailing `**` anything.
      if (glob[i + 2] === '/') {
        out += '(?:.*/)?'
        i += 2
      } else {
        out += '.*'
        i += 1
      }
    } else if (c === '*') out += '[^/]*'
    else if (c === '?') out += '[^/]'
    else out += c.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp(`^${out}$`)
}

/**
 * What approving a Holi on this machine approves: its instructions, model,
 * the rules it may run without asking, which documents it takes and, for a
 * scheduled one, that it is. A change to any of them is a Holi nobody here has
 * approved yet. Its look and name are not here: a label grants nothing.
 *
 * Read from the parsed fields, so a comment, a reordered key or reflowed
 * whitespace is not a change anyone has to approve.
 */
export function holiApprovalText(def: HoliDef): string {
  return JSON.stringify({
    instructions: def.instructions.replace(/[ \t]+$/gm, '').trim(),
    model: def.model ?? null,
    allow: def.allow,
    accepts: def.accepts,
    scheduled: def.when !== undefined,
  })
}

/** What the person fills in to make a Holi. */
export interface HoliDraft {
  name: string
  mascot?: HoliMascot
  color?: string
  description?: string
  model?: string
  accepts?: string[]
  allow?: string[]
  instructions: string
}

/** A new Holi file's text. Only what was given is written, so the file reads
 *  like one a person wrote, its instructions a block of lines. */
export function serializeHoliFile(draft: HoliDraft): string {
  const fm: Record<string, unknown> = { name: draft.name.trim() }
  if (draft.mascot !== undefined) fm['mascot'] = draft.mascot
  if (draft.color !== undefined) fm['color'] = draft.color
  if (draft.description?.trim()) fm['description'] = draft.description.trim()
  if (draft.model?.trim()) fm['model'] = draft.model.trim()
  if (draft.accepts !== undefined && draft.accepts.length > 0) fm['accepts'] = draft.accepts
  if (draft.allow !== undefined && draft.allow.length > 0) fm['allow'] = draft.allow
  fm['instructions'] = `${draft.instructions.trim()}\n`
  const doc = new Document(fm)
  const node = doc.get('instructions', true)
  if (node instanceof Scalar) node.type = Scalar.BLOCK_LITERAL
  return doc.toString({ lineWidth: 0 })
}

/**
 * Change some keys of a Holi file in place: a person's comments, key order and
 * the keys this build does not know all stay. `undefined` removes a key. The
 * opposite of the settings files' rewrite-on-write, on purpose: people and
 * agents edit these by hand.
 */
export function editHoliText(text: string, edits: Record<string, unknown>): string {
  const doc = parseDocument(text)
  for (const [key, value] of Object.entries(edits)) {
    if (value === undefined) doc.delete(key)
    else doc.set(key, value)
  }
  return doc.toString({ lineWidth: 0 })
}
