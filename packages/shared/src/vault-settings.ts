/**
 * The vault's own settings — the pure core (parse → merge → validate → default).
 *
 * Two files, both optional: `.holi/settings.json` (committed, shared with
 * everyone who clones the vault) and `.holi/settings.local.json` (gitignored,
 * this machine only), the second overriding the first **per key**. Same layering
 * as `theme.ts` and `icon-map.ts`, for the same reason: a vault can say how it
 * behaves, and you can disagree with it on your own laptop without touching what
 * your collaborators see.
 *
 * **This is a trust boundary.** The committed file is written by whoever wrote
 * the vault — which, in a shared one, is not you. Every field is checked and a
 * fresh narrow object is built per kind; the parsed value is never returned.
 * Same rule as `parseTabPayload` in the renderer's `lib/tab-drop.ts`, and for
 * the same reason: whatever else was in that JSON must not ride through.
 *
 * **Nothing here throws.** A missing file, corrupt JSON, an unknown `kind`, a
 * value of the wrong type — each resolves to the default and appends a warning,
 * because a typo in an unrelated key must never break the commit path or stop a
 * vault opening. The warnings exist so that degrading is *diagnosable* rather
 * than silent.
 *
 * **Unknown top-level keys are ignored without a warning.** The local file
 * legitimately carries siblings this module knows nothing about — the reminder
 * delivery watermark writes `reminders` there (`main/reminders/delivered-log.ts`)
 * — and warning about them would fire on every launch of every vault that has
 * ever fired a reminder.
 *
 * This module is pure and browser-safe (no fs). The main process reads the two
 * files off disk and hands their text to `resolveVaultSettings`.
 */

/** The pre-commit transforms a vault can enable (D76). Kebab, matching the
 *  transform names themselves — a camelCase settings key beside a kebab
 *  transform name is a mapping table that exists only to be got wrong once. */
export type TransformName =
  | 'relink'
  | 'archive-done'
  | 'normalize-md'
  | 'scaffold-md'
  | 'memory-index'

export const TRANSFORM_NAMES: readonly TransformName[] = [
  'relink',
  'archive-done',
  'normalize-md',
  'scaffold-md',
  'memory-index',
]

/** Fully populated, unlike main's `HookSettings` — the resolver's job is to
 *  answer for every transform, so nothing downstream re-applies a default. */
export type VaultHooks = Record<TransformName, boolean>

/** What the app's appearance follows. `system` tracks `prefers-color-scheme`. */
export type ColorScheme = 'dark' | 'light' | 'system'

export const COLOR_SCHEMES: readonly ColorScheme[] = ['dark', 'light', 'system']

/**
 * The font the **notes editor** sets prose in. Code, frontmatter and the
 * plain/code editor are never affected — see `notesFontTheme`.
 *
 * **A name, never a CSS string.** `.holi/settings.json` is committed, so in a
 * shared vault this value was written by somebody else; a `font-family` taken
 * from it verbatim is arbitrary CSS crossing a trust boundary, which is the
 * whitelist argument D64 makes about theme tokens, with a different filename.
 * Three names resolve to three stacks this file owns and nothing else gets
 * through — so no sanitizer, and no amendment to D64's promise that a vault
 * cannot re-space anything, because a vault cannot name a font either.
 *
 * `mono` is the default because it is what the editor has always been.
 */
export type EditorFont = 'mono' | 'sans' | 'serif'

export const EDITOR_FONTS: readonly EditorFont[] = ['mono', 'sans', 'serif']

/**
 * What each name means, and the only place it means anything.
 *
 * **System stacks, deliberately.** Holi bundles no web fonts — there is no
 * `@font-face` anywhere in the renderer — so a name resolving to a family that
 * happens not to be installed would fall back silently, and a setting that
 * appears to do nothing is worse than one that is not offered. Every family
 * here either ships with the OS or is a generic.
 */
export const EDITOR_FONT_STACKS: Readonly<Record<EditorFont, string>> = Object.freeze({
  mono: 'ui-monospace, "SF Mono", Menlo, monospace',
  sans: 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif',
  serif: 'ui-serif, Georgia, Cambria, "Times New Roman", serif',
})

/** The unique surfaces a vault can land on. Mirrors the renderer's
 *  `SingletonTab` deliberately rather than importing it — see `LandingTarget`. */
export type SingletonLanding = 'board' | 'agenda' | 'mail'

const SINGLETON_LANDINGS: readonly SingletonLanding[] = ['board', 'agenda', 'mail']

/**
 * What a vault opens on.
 *
 * **`daily` is a kind, not a path.** `{kind:'note', path:'22-08-2026.md'}` would
 * rot overnight; naming the daily by kind means the target keeps pointing at it
 * as the daily note grows into a dashboard.
 *
 * **Not the renderer's `Tab` union**, though it covers the same ground. `Tab`
 * lives in the renderer, and its `SingletonTab` is a *named* literal rather than
 * a derived one precisely so `openSingleton(w, 'app')` cannot typecheck
 * (`state/panes.ts:38-44`). Parse to this, then dispatch per kind, and that
 * property survives the crossing.
 */
export type LandingTarget =
  | { kind: 'daily' }
  | { kind: 'note'; path: string }
  | { kind: 'app'; appId: string }
  | { kind: SingletonLanding }

export interface ResolvedVaultSettings {
  landing: LandingTarget
  dailyNotes: boolean
  colorScheme: ColorScheme
  editorFont: EditorFont
  hooks: VaultHooks
  maxCommittedFileBytes: number
  /** Human-readable notes about dropped keys/values, surfaced so a typo is
   *  diagnosable rather than silent. Mirrors `ResolvedTheme.warnings`. */
  warnings: string[]
}

/**
 * What a vault does when it says nothing.
 *
 * One object, read by the resolver, by the onboarding descriptors and by the
 * seed — so "what a vault defaults to" is stated once. Deep-frozen because it is
 * shared; the resolver always builds fresh objects from it.
 *
 * `archive-done` is off: it moves task files, which changes what the board
 * shows, and a transform that rearranges someone's work is opt-in (D76).
 * `memory-index` is on, with `relink` and `normalize-md`, for their reason: it
 * only ever rewrites `memory/index.md`, a file it generated and that says so on
 * its first line, so it cannot make a change the author would notice making.
 * The 10 MB cap mirrors `main/vault/large-files.ts` — notes-vault assets sit
 * well under it, and GitHub warns at 50.
 */
export const VAULT_SETTING_DEFAULTS = Object.freeze({
  landing: Object.freeze({ kind: 'daily' }) as LandingTarget,
  dailyNotes: true,
  colorScheme: 'system' as ColorScheme,
  editorFont: 'mono' as EditorFont,
  hooks: Object.freeze({
    relink: true,
    'archive-done': false,
    'normalize-md': true,
    'scaffold-md': true,
    'memory-index': true,
  }) as VaultHooks,
  maxCommittedFileBytes: 10 * 1024 * 1024,
})

/** Parse one file. Anything that is not a JSON object reads as "no settings" —
 *  a half-written file must not stop a vault opening. */
function parseFile(json: string | null): Record<string, unknown> {
  if (json === null || json.trim() === '') return {}
  try {
    const parsed: unknown = JSON.parse(json)
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {}
  } catch {
    return {}
  }
}

/**
 * Read an untrusted value as a landing target, or `null`.
 *
 * Exported because a *write* has to cross the same boundary a read does: the
 * renderer's onboarding act sends its answers to main as JSON, and main runs
 * them through here before merging, so nothing can reach the file by a route
 * that skips this check.
 */
export function parseLandingTarget(value: unknown): LandingTarget | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null

  const { kind, path, appId } = value as Record<string, unknown>
  if (kind === 'daily') return { kind: 'daily' }
  if (kind === 'note') {
    return typeof path === 'string' && path !== '' ? { kind: 'note', path } : null
  }
  if (kind === 'app') {
    return typeof appId === 'string' && appId !== '' ? { kind: 'app', appId } : null
  }
  if (SINGLETON_LANDINGS.includes(kind as SingletonLanding)) {
    return { kind: kind as SingletonLanding }
  }
  return null
}

/** Pick the last file that mentions `key` at all, so an override is per key and
 *  a file that stays quiet about something inherits it. */
function pick(files: Record<string, unknown>[], key: string): unknown {
  let value: unknown
  for (const file of files) {
    if (key in file) value = file[key]
  }
  return value
}

function resolveBoolean(
  files: Record<string, unknown>[],
  key: string,
  fallback: boolean,
  warnings: string[],
): boolean {
  const value = pick(files, key)
  if (value === undefined) return fallback
  if (typeof value !== 'boolean') {
    warnings.push(`dropped "${key}": expected true or false, got ${JSON.stringify(value)}`)
    return fallback
  }
  return value
}

function resolveColorScheme(files: Record<string, unknown>[], warnings: string[]): ColorScheme {
  const value = pick(files, 'colorScheme')
  if (value === undefined) return VAULT_SETTING_DEFAULTS.colorScheme
  if (typeof value !== 'string' || !COLOR_SCHEMES.includes(value as ColorScheme)) {
    warnings.push(
      `dropped "colorScheme": expected one of ${COLOR_SCHEMES.join(', ')}, got ${JSON.stringify(value)}`,
    )
    return VAULT_SETTING_DEFAULTS.colorScheme
  }
  return value as ColorScheme
}

function resolveEditorFont(files: Record<string, unknown>[], warnings: string[]): EditorFont {
  const value = pick(files, 'editorFont')
  if (value === undefined) return VAULT_SETTING_DEFAULTS.editorFont
  if (typeof value !== 'string' || !EDITOR_FONTS.includes(value as EditorFont)) {
    warnings.push(
      `dropped "editorFont": expected one of ${EDITOR_FONTS.join(', ')}, got ${JSON.stringify(value)}`,
    )
    return VAULT_SETTING_DEFAULTS.editorFont
  }
  return value as EditorFont
}

function resolveLandingSetting(
  files: Record<string, unknown>[],
  warnings: string[],
): LandingTarget {
  const value = pick(files, 'landing')
  if (value === undefined) return { ...VAULT_SETTING_DEFAULTS.landing }
  const parsed = parseLandingTarget(value)
  if (parsed === null) {
    warnings.push(`dropped "landing": not a usable target, ${JSON.stringify(value)}`)
    return { ...VAULT_SETTING_DEFAULTS.landing }
  }
  return parsed
}

/**
 * Merge the hooks block **per transform**, not wholesale.
 *
 * A local file naming one transform must not silently disable the other two —
 * which is what a whole-block override would do, and the failure would look like
 * "link rewriting randomly stopped working on my laptop".
 */
function resolveHooks(files: Record<string, unknown>[], warnings: string[]): VaultHooks {
  const hooks: VaultHooks = { ...VAULT_SETTING_DEFAULTS.hooks }
  for (const file of files) {
    if (!('hooks' in file)) continue
    const block = file.hooks
    if (typeof block !== 'object' || block === null || Array.isArray(block)) {
      warnings.push(`dropped "hooks": expected an object, got ${JSON.stringify(block)}`)
      continue
    }
    for (const [name, value] of Object.entries(block as Record<string, unknown>)) {
      if (!TRANSFORM_NAMES.includes(name as TransformName)) {
        warnings.push(`dropped unknown transform "${name}"`)
        continue
      }
      if (typeof value !== 'boolean') {
        warnings.push(
          `dropped "hooks.${name}": expected true or false, got ${JSON.stringify(value)}`,
        )
        continue
      }
      hooks[name as TransformName] = value
    }
  }
  return hooks
}

function resolveMaxBytes(files: Record<string, unknown>[], warnings: string[]): number {
  const value = pick(files, 'maxCommittedFileBytes')
  if (value === undefined) return VAULT_SETTING_DEFAULTS.maxCommittedFileBytes
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    warnings.push(
      `dropped "maxCommittedFileBytes": expected a positive number, got ${JSON.stringify(value)}`,
    )
    return VAULT_SETTING_DEFAULTS.maxCommittedFileBytes
  }
  return value
}

/**
 * Resolve the committed + local settings files into one validated shape.
 *
 * Either argument may be `null` (file absent). Local is applied last so it wins
 * key by key. Never throws; every field is answered.
 */
export function resolveVaultSettings(
  committedJson: string | null,
  localJson: string | null,
): ResolvedVaultSettings {
  // Order is the precedence: committed first, local last.
  const files = [parseFile(committedJson), parseFile(localJson)]
  const warnings: string[] = []

  return {
    landing: resolveLandingSetting(files, warnings),
    dailyNotes: resolveBoolean(files, 'dailyNotes', VAULT_SETTING_DEFAULTS.dailyNotes, warnings),
    colorScheme: resolveColorScheme(files, warnings),
    editorFont: resolveEditorFont(files, warnings),
    hooks: resolveHooks(files, warnings),
    maxCommittedFileBytes: resolveMaxBytes(files, warnings),
    warnings,
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// What a vault is asked at birth
// ─────────────────────────────────────────────────────────────────────────────

/** Which of the two files a row's answer is written to. */
export type SettingTarget = 'committed' | 'local'

/** One option in a `choice`. `value` is whatever the key holds — a `LandingTarget`
 *  for `landing`, a `ColorScheme` for `colorScheme` — and is written verbatim. */
export interface VaultSettingOption {
  value: unknown
  label: string
  hint?: string
  /** Only offered while another answer holds. Data rather than a predicate, so
   *  the rule stays readable in the list and survives being serialised. */
  requires?: { key: VaultSettingKey; equals: unknown }
}

/**
 * The shape of a choice. Three, because the four rows need three:
 * a switch, a pick-one, and a set of switches that read as one decision.
 */
export type VaultSettingControl =
  | { kind: 'toggle' }
  | { kind: 'choice'; options: readonly VaultSettingOption[] }
  | {
      kind: 'group'
      toggles: readonly { key: TransformName; label: string; explanation: string }[]
    }

/** A key a descriptor can describe — every setting with a control, which the
 *  settings tab renders and which is a superset of what the ritual asks
 *  (`askedAtBirth`).
 *
 *  Every key the resolver answers now has a row. `maxCommittedFileBytes` was
 *  the holdout, and the distinction that let it in is `askedAtBirth`: D85's
 *  argument was about the SEED — freezing a number into every vault means
 *  raising the default later reaches none of them — and a pane is one person
 *  choosing for one vault, which is a different act. Its descriptor is not in
 *  the ritual, so the seed still writes nothing. */
export type VaultSettingKey =
  | 'dailyNotes'
  | 'landing'
  | 'hooks'
  | 'colorScheme'
  | 'editorFont'
  | 'maxCommittedFileBytes'

export interface VaultSettingDescriptor {
  key: VaultSettingKey
  label: string
  explanation: string
  control: VaultSettingControl
  /** Read from `VAULT_SETTING_DEFAULTS`, never restated — a second literal is a
   *  second thing to keep in step. */
  default: unknown
  target: SettingTarget
  /**
   * Whether the onboarding ritual asks this at a vault's birth, and the seed
   * therefore writes it.
   *
   * **Not every setting is a question for a stranger.** The ritual is four acts
   * long and every row in it is one more thing between somebody and their first
   * note, so a preference with a good default and no consequence at birth stays
   * out of it — `editorFont` is the case that forced the flag (D87 deliberately
   * gave it no row). The settings pane renders the whole list regardless, which
   * is the difference between "every setting" and "every question".
   */
  askedAtBirth: boolean
  /** Where this lives once the ritual is over. Carried as **data** so a row
   *  structurally cannot ship without one: a step that changes something and
   *  does not say where to change it later is a dead end for anyone who wants
   *  to change their mind. */
  whereToChange: string
}


/** The two files a setting can live in. Named here because the settings pane
 *  offers both as an escape hatch and the hint below names one of them — three
 *  string literals agreeing is a coincidence that expires. */
export const SETTINGS_FILE = '.holi/settings.json'
export const SETTINGS_LOCAL_FILE = '.holi/settings.local.json'

const SETTINGS_FILE_HINT = `Change it any time in ${SETTINGS_FILE}`
const LOCAL_FILE_HINT =
  'Change it any time in .holi/settings.local.json, which stays on this machine'

/**
 * The four rows the onboarding step renders, in order — and the source the seed
 * writes `.holi/settings.json` from.
 *
 * **One list, two readers.** The act and the seed agreeing is not a convention
 * anyone has to remember; adding a setting later is adding a row here, and both
 * pick it up. The seed reads only the `askedAtBirth` subset, which is what lets
 * a setting have a pane row without being frozen into every new vault —
 * `maxCommittedFileBytes` is the one that needs that and the reason the
 * distinction exists.
 */
export const VAULT_SETTING_DESCRIPTORS: readonly VaultSettingDescriptor[] = [
  {
    key: 'dailyNotes',
    label: 'Keep a daily note',
    // The shared-vault warning lives here, and it is the whole reason this row
    // exists: Holi used to guess the answer from the GitHub collaborator count.
    explanation:
      'A fresh note each morning, with yesterday’s filed away automatically. In a vault you share, everyone writes the same file, which gets messy fast.',
    control: { kind: 'toggle' },
    default: VAULT_SETTING_DEFAULTS.dailyNotes,
    target: 'committed',
    askedAtBirth: true,
    whereToChange: SETTINGS_FILE_HINT,
  },
  {
    key: 'landing',
    label: 'Open on',
    explanation: 'What you see when you open this vault.',
    control: {
      kind: 'choice',
      // Only what a brand-new vault can express: it holds no notes and no apps
      // yet. Pointing `landing` at either stays a file edit, which is where
      // authoring belongs.
      options: [
        // Only on offer while the vault actually keeps one. Landing on a daily
        // note a vault does not make would resolve to an empty pane, which is
        // coherent but reads as a broken choice.
        {
          value: { kind: 'daily' },
          label: 'Today’s note',
          requires: { key: 'dailyNotes', equals: true },
        },
        { value: { kind: 'board' }, label: 'The board' },
        { value: { kind: 'agenda' }, label: 'Your agenda' },
        { value: { kind: 'mail' }, label: 'Mail' },
      ],
    },
    default: VAULT_SETTING_DEFAULTS.landing,
    target: 'committed',
    askedAtBirth: true,
    whereToChange: `${SETTINGS_FILE_HINT}, including pointing it at a note or an app`,
  },
  {
    key: 'hooks',
    label: 'Tidy up on every commit',
    explanation: 'Small fixes Holi makes for you when your work is saved.',
    control: {
      kind: 'group',
      toggles: [
        {
          key: 'relink',
          label: 'Fix links when a file moves',
          explanation: 'Rewrites the links pointing at it, so nothing breaks.',
        },
        {
          key: 'normalize-md',
          label: 'Tidy markdown',
          explanation: 'Trailing spaces and stray blank lines, quietly cleaned.',
        },
        {
          key: 'scaffold-md',
          label: 'Give a new note its frontmatter',
          explanation: 'A created date and empty tags, however the note arrived.',
        },
        {
          key: 'memory-index',
          label: 'Keep the memory index current',
          explanation: 'Rebuilds memory/index.md so what the vault knows stays listed in one place.',
        },
        {
          key: 'archive-done',
          label: 'File finished tasks away',
          explanation: 'Off by default. It moves files, which changes what your board shows.',
        },
      ],
    },
    default: VAULT_SETTING_DEFAULTS.hooks,
    target: 'committed',
    askedAtBirth: true,
    whereToChange: SETTINGS_FILE_HINT,
  },
  {
    key: 'maxCommittedFileBytes',
    label: 'Largest file to commit',
    // Why there is a cap at all, in the terms the refusal will use. This is the
    // vault's ONE veto (FR-9): every other pre-commit transform is an opinion
    // and lets the commit through, because git history is permanent and push is
    // automatic, so an oversized blob committed once is published forever.
    explanation:
      'Anything bigger is left out of the commit and reported, rather than pushed to everyone. GitHub itself warns at 50 MB and refuses at 100.',
    control: {
      kind: 'choice',
      options: [
        { value: 5 * 1024 * 1024, label: '5 MB' },
        { value: 10 * 1024 * 1024, label: '10 MB' },
        { value: 25 * 1024 * 1024, label: '25 MB' },
        { value: 100 * 1024 * 1024, label: '100 MB', hint: 'GitHub’s own hard limit' },
      ],
    },
    default: VAULT_SETTING_DEFAULTS.maxCommittedFileBytes,
    target: 'committed',
    // **Not asked at birth, and that is the whole of D85's argument surviving.**
    // The ritual asks what a vault must decide to exist; a size cap is not that,
    // and a number written into every vault at creation is a default that can
    // never be raised for the vaults that already have one.
    askedAtBirth: false,
    whereToChange: SETTINGS_FILE_HINT,
  },
  {
    key: 'colorScheme',
    label: 'Appearance',
    explanation: 'Light, dark, or whatever your Mac is set to.',
    control: {
      kind: 'choice',
      options: [
        { value: 'system', label: 'Match my system' },
        { value: 'light', label: 'Light' },
        { value: 'dark', label: 'Dark' },
      ],
    },
    default: VAULT_SETTING_DEFAULTS.colorScheme,
    // Machine-local, and the only row that is: a teammate's committed choice
    // flipping your app to light mode is exactly the failure the `.local` layer
    // exists to prevent.
    target: 'local',
    askedAtBirth: true,
    whereToChange: LOCAL_FILE_HINT,
  },
  {
    key: 'editorFont',
    label: 'Notes are set in',
    explanation:
      'Prose only. Code, frontmatter and the plain editor stay monospaced whatever this says.',
    control: {
      kind: 'choice',
      options: [
        { value: 'mono', label: 'Monospace' },
        { value: 'sans', label: 'Sans' },
        { value: 'serif', label: 'Serif' },
      ],
    },
    default: VAULT_SETTING_DEFAULTS.editorFont,
    target: 'committed',
    // Not asked at birth, deliberately (D87): it has a good default, no
    // consequence at a vault's first moment, and the ritual is already four acts
    // long. The settings pane is where a preference like this belongs.
    askedAtBirth: false,
    whereToChange: SETTINGS_FILE_HINT,
  },
]

/** The subset the ritual asks and the seed writes — see `askedAtBirth`. */
export const RITUAL_SETTING_DESCRIPTORS: readonly VaultSettingDescriptor[] =
  VAULT_SETTING_DESCRIPTORS.filter((d) => d.askedAtBirth)

/**
 * The settings a freshly created vault is born with, for one of the two files.
 *
 * Built from the descriptors rather than hand-written, so the file a vault is
 * seeded with and the questions it was asked cannot drift apart. Round-trips
 * through `resolveVaultSettings` to exactly `VAULT_SETTING_DEFAULTS` — a seeded
 * vault behaves identically to one with no settings files at all, which is what
 * makes seeding safe to change.
 */
export function seedSettings(target: SettingTarget): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  // The ritual's list, not every setting: a vault should be born declaring the
  // answers it was asked for, and inherit the rest. Freezing a preference nobody
  // was asked about into every vault means raising its default later reaches none
  // of them.
  for (const d of RITUAL_SETTING_DESCRIPTORS) {
    if (d.target === target) out[d.key] = d.default
  }
  return out
}

/**
 * Read an untrusted object as a **patch** — only the keys it actually answered,
 * each validated, and nothing else.
 *
 * **Not `resolveVaultSettings`, and the difference matters.** A read *resolves*:
 * every key answered, defaults filled in. Writing that back would stamp defaults
 * over keys the user never touched, so a write carries only what was answered.
 *
 * **Asymmetric with the read on unknown keys, on purpose.** A read *tolerates*
 * siblings it does not own — `reminders` lives in the local file and has to
 * survive. A write must not be able to *create* one, or this becomes a route for
 * the renderer to put arbitrary JSON into a committed, synced file. Existing
 * siblings survive because the caller merges the patch into the file it read,
 * not because the patch carries them.
 */
export function parseSettingsPatch(json: string | null): {
  patch: Record<string, unknown>
  warnings: string[]
} {
  const raw = parseFile(json)
  const patch: Record<string, unknown> = {}
  const warnings: string[] = []

  if ('landing' in raw) {
    const landing = parseLandingTarget(raw.landing)
    if (landing === null) warnings.push(`refused "landing": ${JSON.stringify(raw.landing)}`)
    else patch.landing = landing
  }

  if ('dailyNotes' in raw) {
    if (typeof raw.dailyNotes === 'boolean') patch.dailyNotes = raw.dailyNotes
    else warnings.push(`refused "dailyNotes": ${JSON.stringify(raw.dailyNotes)}`)
  }

  if ('colorScheme' in raw) {
    if (
      typeof raw.colorScheme === 'string' &&
      COLOR_SCHEMES.includes(raw.colorScheme as ColorScheme)
    ) {
      patch.colorScheme = raw.colorScheme
    } else {
      warnings.push(`refused "colorScheme": ${JSON.stringify(raw.colorScheme)}`)
    }
  }

  if ('maxCommittedFileBytes' in raw) {
    const value = raw.maxCommittedFileBytes
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
      patch.maxCommittedFileBytes = value
    } else {
      warnings.push(`refused "maxCommittedFileBytes": ${JSON.stringify(value)}`)
    }
  }

  if ('hooks' in raw) {
    const block = raw.hooks
    if (typeof block !== 'object' || block === null || Array.isArray(block)) {
      warnings.push(`refused "hooks": ${JSON.stringify(block)}`)
    } else {
      const hooks: Partial<VaultHooks> = {}
      for (const [name, value] of Object.entries(block as Record<string, unknown>)) {
        if (!TRANSFORM_NAMES.includes(name as TransformName)) {
          warnings.push(`refused unknown transform "${name}"`)
        } else if (typeof value !== 'boolean') {
          warnings.push(`refused "hooks.${name}": ${JSON.stringify(value)}`)
        } else {
          hooks[name as TransformName] = value
        }
      }
      // A block that survived nothing is not a block: writing `{}` would be a
      // change to the file that says nothing.
      if (Object.keys(hooks).length > 0) patch.hooks = hooks
    }
  }

  return { patch, warnings }
}

/**
 * Split the ritual's answers into one patch per file.
 *
 * Driven by each descriptor's `target`, never by a list of keys written out
 * here — that is what makes "adding a setting is adding a descriptor" true of
 * the write as well as the view. An answer for a key no descriptor claims is
 * dropped: the step can only answer what it asked.
 */
export function splitAnswersByTarget(answers: Record<string, unknown>): {
  committed: Record<string, unknown>
  local: Record<string, unknown>
} {
  const committed: Record<string, unknown> = {}
  const local: Record<string, unknown> = {}
  for (const d of VAULT_SETTING_DESCRIPTORS) {
    if (!(d.key in answers)) continue
    const bucket = d.target === 'local' ? local : committed
    bucket[d.key] = answers[d.key]
  }
  return { committed, local }
}

/**
 * The options a choice can offer, given the answers so far.
 *
 * A row can depend on another row: landing on today's note is only on offer
 * while the vault actually keeps one. Filtering rather than disabling, because
 * a greyed-out choice invites the question "why not?" and the answer is already
 * one row up.
 *
 * Returns `[]` for anything that is not a choice.
 */
export function availableOptions(
  descriptor: VaultSettingDescriptor,
  answers: Record<string, unknown>,
): readonly VaultSettingOption[] {
  if (descriptor.control.kind !== 'choice') return []
  return descriptor.control.options.filter((option) => {
    if (option.requires === undefined) return true
    const current = answers[option.requires.key] ?? VAULT_SETTING_DEFAULTS[option.requires.key]
    return current === option.requires.equals
  })
}

/**
 * Repair answers that another answer has just invalidated.
 *
 * Turning daily notes off takes "today's note" off the landing row, and the
 * answer sitting there is now something the user cannot see or change. Move it
 * to the first option still on offer, visibly, rather than leaving a row with
 * nothing selected or writing a value that was silently withdrawn.
 *
 * Idempotent, and a no-op when every answer is still available.
 */
export function normaliseAnswers(answers: Record<string, unknown>): Record<string, unknown> {
  let out = answers
  for (const descriptor of VAULT_SETTING_DESCRIPTORS) {
    if (descriptor.control.kind !== 'choice') continue
    // Repair only what is there. Filling in an answer nobody gave is
    // `initialState`'s job, and doing it here would mean this function silently
    // invents answers whenever it is handed a partial set.
    if (!(descriptor.key in out)) continue
    const options = availableOptions(descriptor, out)
    if (options.length === 0) continue
    const current = JSON.stringify(out[descriptor.key])
    if (options.some((o) => JSON.stringify(o.value) === current)) continue
    // Copy on first change only, so an untouched object comes back identical.
    if (out === answers) out = { ...answers }
    out[descriptor.key] = options[0]!.value
  }
  return out
}

/**
 * The mode a `colorScheme` setting actually resolves to, right now.
 *
 * `system` is not a third look: it is a deferral to the OS, and the OS answer
 * changes while the app is running. Keeping the resolution pure means the
 * renderer's job is only to say what the OS currently reports and to re-ask when
 * it changes.
 */
export function resolveColorMode(
  scheme: ColorScheme,
  systemPrefersDark: boolean,
): 'light' | 'dark' {
  if (scheme === 'system') return systemPrefersDark ? 'dark' : 'light'
  return scheme
}
