/**
 * A Holi: an agent that belongs to the vault, with a name and a face, a soul
 * and a memory (docs/features/holis.md, after MonoCode's Monos). It runs when
 * someone sends it a document, or when an automation it carries out comes due
 * on a machine that turned that automation on; either way Claude Code asks the
 * person what its `allow` does not cover.
 *
 * A Holi is a folder, `.holi/holis/<id>/`, committed and synced like a note:
 *
 * ```
 * .holi/holis/proposal/
 *   holi.yaml   name, mascot, colour, model, accepts, allow
 *   SOUL.md     who it is: its standing instructions
 *   MEMORY.md   what it has learned, one dated fact a line (`holi-memory.ts`)
 *   memory/     topic notes read on demand, and archive.md
 * ```
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
 * ```
 *
 * An older Holi is one file, `.holi/holis/<id>.yaml` (`<id>.local.yaml` keeps
 * one on this machine), whose `instructions` key is its soul. It still reads.
 *
 * YAML rather than markdown with frontmatter, so it can carry settings as it
 * grows: a key this build does not know is kept on write and ignored on read,
 * with a warning, never an error. A write from Holi edits the file in place
 * (`editHoliText`), keeping a person's comments and key order.
 *
 * Pure and browser-safe: the renderer reads a file the way main runs it.
 */
import { Document, parse as parseYaml, parseDocument } from 'yaml'
import { HOLIS_SURFACE_DIR } from './path-safety'

/** Where Holi definitions live: one file each, directly inside. */
export const HOLIS_DIR = HOLIS_SURFACE_DIR

/** A folder Holi's files, by name inside its folder. */
export const HOLI_FILE = 'holi.yaml'
export const SOUL_FILE = 'SOUL.md'

/** The soul a new Holi starts with, after MonoCode's: a heading and one
 *  placeholder line for the person to replace. */
export const SOUL_SEED = `# Soul

## Standing instructions

- (Add anything it should always keep in mind.)
`

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
  /** Claude Code permission rules a run may use without asking. */
  allow: string[]
  /** An older single-file Holi's `instructions`: its soul. A folder Holi's
   *  soul is its `SOUL.md`, and this is ''. */
  instructions: string
  /** Whether it is a folder (`<id>/holi.yaml`, with a soul and a memory) or
   *  an older single file. */
  folder: boolean
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
  'allow',
  'instructions',
])

/**
 * A key that would choose how Claude Code asks. A run keeps Claude Code's own
 * prompts and `allow` is the one way past one: a permission mode, or a bypass,
 * is refused rather than ignored, so nobody believes it applies.
 */
const PERMISSION_KEY = /permission|bypass|skip|danger|dontask|yolo/i

/** A rule that would let a run write anywhere: the agent's surface included,
 *  so a run could be talked into changing every later one. */
const BARE_WRITE = /^(?:Edit|Write|MultiEdit)(?:\(\s*(?:\*\*?(?:\/\*\*?)*)?\s*\))?$/

/** Whether a vault path is a Holi's file: `<id>/holi.yaml`, or an older
 *  single `<id>.yaml` directly inside `HOLIS_DIR` (`.local.yaml` is a Holi only
 *  this machine has). */
export function isHoliFilePath(path: string): boolean {
  if (!path.startsWith(`${HOLIS_DIR}/`)) return false
  const rest = path.slice(HOLIS_DIR.length + 1)
  const parts = rest.split('/')
  if (parts.length === 2) return parts[0] !== '' && parts[1] === HOLI_FILE
  return parts.length === 1 && rest.endsWith('.yaml') && rest !== '.yaml'
}

/** Whether a Holi file is the folder form, `<id>/holi.yaml`. */
export function isHoliFolderFile(path: string): boolean {
  return path.endsWith(`/${HOLI_FILE}`) && isHoliFilePath(path)
}

/** `ada` for `.holi/holis/ada/holi.yaml`, `.holi/holis/ada.yaml` and
 *  `.holi/holis/ada.local.yaml`. */
export function holiIdOf(path: string): string {
  if (isHoliFolderFile(path)) {
    const dir = path.slice(0, -HOLI_FILE.length - 1)
    return dir.slice(dir.lastIndexOf('/') + 1)
  }
  const base = path.slice(path.lastIndexOf('/') + 1)
  return base.replace(/\.yaml$/, '').replace(/\.local$/, '')
}

/** A folder Holi's folder, `.holi/holis/<id>`. */
export const holiFolder = (id: string): string => `${HOLIS_DIR}/${id}`

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
  if (f['cron'] !== undefined || f['at'] !== undefined) {
    return {
      ok: false,
      error:
        'a Holi runs on a clock through an automation: take `cron` and `at` out, and make an automation in the Agents view that this Holi carries out.',
    }
  }
  const rawAccepts = f['accepts'] ?? []
  const acceptsList = typeof rawAccepts === 'string' ? [rawAccepts] : rawAccepts
  if (
    !Array.isArray(acceptsList) ||
    acceptsList.some((g) => typeof g !== 'string' || g.trim() === '')
  ) {
    return { ok: false, error: '`accepts` is a list of vault paths, like `kunder/**/*.md`' }
  }
  const accepts = (acceptsList as string[]).map((g) => g.trim())

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
  // A folder Holi's soul is its SOUL.md; an older file's is `instructions`.
  const folder = isHoliFolderFile(path)
  const rawInstructions = f['instructions']
  if (rawInstructions !== undefined && typeof rawInstructions !== 'string') {
    return { ok: false, error: '`instructions` must be text' }
  }
  const instructions = typeof rawInstructions === 'string' ? rawInstructions.trim() : ''
  if (!folder && instructions === '') {
    return { ok: false, error: '`instructions` (what a run carries out) is empty' }
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
      allow,
      instructions,
      folder,
      unknownKeys: Object.keys(f).filter((k) => !HOLI_KEYS.has(k)),
    },
  }
}

/** Whether a Holi takes the document at `path`: any, when it names none. */
export function holiAccepts(def: HoliDef, path: string): boolean {
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
 * A Holi's soul as a run reads it: its `SOUL.md`, or an older file's
 * `instructions`. Trailing spaces and the ends trimmed, so reflowed whitespace
 * is not a change.
 */
export function holiSoul(def: HoliDef, soulText: string | null): string {
  const text = def.folder ? (soulText ?? '') : def.instructions
  return text.replace(/[ \t]+$/gm, '').trim()
}

/**
 * What approving a Holi on this machine approves: its soul, model, the rules
 * it may run without asking and which documents it takes. A change to any of
 * them is a Holi nobody here has approved yet. Its look and name are not here:
 * a label grants nothing. Nor is its memory, which its own runs write: it goes
 * into a run as notes, never as instructions (docs/features/holis.md).
 *
 * Read from the parsed fields, so a comment, a reordered key or reflowed
 * whitespace is not a change anyone has to approve.
 */
export function holiApprovalText(def: HoliDef, soul: string): string {
  return JSON.stringify({
    instructions: soul,
    model: def.model ?? null,
    allow: def.allow,
    accepts: def.accepts,
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
  /** Its soul: the standing instructions `SOUL.md` starts with. Empty: the
   *  seed, for the person to fill in. */
  soul?: string
}

/** A new folder Holi's `holi.yaml`. Only what was given is written, so the
 *  file reads like one a person wrote. */
export function serializeHoliFile(draft: HoliDraft): string {
  const fm: Record<string, unknown> = { name: draft.name.trim() }
  if (draft.mascot !== undefined) fm['mascot'] = draft.mascot
  if (draft.color !== undefined) fm['color'] = draft.color
  if (draft.description?.trim()) fm['description'] = draft.description.trim()
  if (draft.model?.trim()) fm['model'] = draft.model.trim()
  if (draft.accepts !== undefined && draft.accepts.length > 0) fm['accepts'] = draft.accepts
  if (draft.allow !== undefined && draft.allow.length > 0) fm['allow'] = draft.allow
  return new Document(fm).toString({ lineWidth: 0 })
}

/** A new Holi's `SOUL.md`: the seed, with the draft's instructions as its
 *  standing instructions when it has some. */
export function soulText(instructions?: string): string {
  const text = instructions?.trim() ?? ''
  if (text === '') return SOUL_SEED
  return `# Soul\n\n## Standing instructions\n\n${text}\n`
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
