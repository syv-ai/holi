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
export type TransformName = 'relink' | 'archive-done' | 'normalize-md'

export const TRANSFORM_NAMES: readonly TransformName[] = ['relink', 'archive-done', 'normalize-md']

/** Fully populated, unlike main's `HookSettings` — the resolver's job is to
 *  answer for every transform, so nothing downstream re-applies a default. */
export type VaultHooks = Record<TransformName, boolean>

/** What the app's appearance follows. `system` tracks `prefers-color-scheme`. */
export type ColorScheme = 'dark' | 'light' | 'system'

export const COLOR_SCHEMES: readonly ColorScheme[] = ['dark', 'light', 'system']

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
 * shows, and a transform that rearranges someone's work is opt-in (D76). The
 * 10 MB cap mirrors `main/vault/large-files.ts` — notes-vault assets sit well
 * under it, and GitHub warns at 50.
 */
export const VAULT_SETTING_DEFAULTS = Object.freeze({
  landing: Object.freeze({ kind: 'daily' }) as LandingTarget,
  dailyNotes: true,
  colorScheme: 'system' as ColorScheme,
  hooks: Object.freeze({
    relink: true,
    'archive-done': false,
    'normalize-md': true,
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

function resolveLandingSetting(
  files: Record<string, unknown>[],
  warnings: string[],
): LandingTarget {
  const value = pick(files, 'landing')
  if (value === undefined) return { ...VAULT_SETTING_DEFAULTS.landing }
  const parsed = parseLandingTarget(value)
  if (parsed === null) {
    warnings.push(`dropped "landing": not a usable target — ${JSON.stringify(value)}`)
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

/** A key the onboarding step asks about. Deliberately narrower than every key
 *  the resolver answers — `maxCommittedFileBytes` has no row (see below). */
export type VaultSettingKey = 'dailyNotes' | 'landing' | 'hooks' | 'colorScheme'

export interface VaultSettingDescriptor {
  key: VaultSettingKey
  label: string
  explanation: string
  control: VaultSettingControl
  /** Read from `VAULT_SETTING_DEFAULTS`, never restated — a second literal is a
   *  second thing to keep in step. */
  default: unknown
  target: SettingTarget
  /** Where this lives once the ritual is over. Carried as **data** so a row
   *  structurally cannot ship without one: a step that changes something and
   *  does not say where to change it later is a dead end for anyone who wants
   *  to change their mind. */
  whereToChange: string
}

const SETTINGS_FILE_HINT = 'Change it any time in .holi/settings.json'
const LOCAL_FILE_HINT = 'Change it any time in .holi/settings.local.json — this machine only'

/**
 * The four rows the onboarding step renders, in order — and the source the seed
 * writes `.holi/settings.json` from.
 *
 * **One list, two readers.** The act and the seed agreeing is not a convention
 * anyone has to remember; adding a setting later is adding a row here, and both
 * pick it up. `maxCommittedFileBytes` deliberately has no row: freezing it into
 * every vault at creation would mean raising the default later never reaches the
 * vaults that already exist.
 */
export const VAULT_SETTING_DESCRIPTORS: readonly VaultSettingDescriptor[] = [
  {
    key: 'dailyNotes',
    label: 'Keep a daily note',
    // The shared-vault warning lives here, and it is the whole reason this row
    // exists: Holi used to guess the answer from the GitHub collaborator count.
    explanation:
      'A fresh note each morning, with yesterday’s filed away automatically. In a vault you share, everyone writes the same file — which gets messy fast.',
    control: { kind: 'toggle' },
    default: VAULT_SETTING_DEFAULTS.dailyNotes,
    target: 'committed',
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
        { value: { kind: 'daily' }, label: 'Today’s note' },
        { value: { kind: 'board' }, label: 'The board' },
        { value: { kind: 'agenda' }, label: 'Your agenda' },
        { value: { kind: 'mail' }, label: 'Mail' },
      ],
    },
    default: VAULT_SETTING_DEFAULTS.landing,
    target: 'committed',
    whereToChange: `${SETTINGS_FILE_HINT} — including pointing it at a note or an app`,
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
          key: 'archive-done',
          label: 'File finished tasks away',
          explanation: 'Off by default: it moves files, which changes what your board shows.',
        },
      ],
    },
    default: VAULT_SETTING_DEFAULTS.hooks,
    target: 'committed',
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
    whereToChange: LOCAL_FILE_HINT,
  },
]

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
  for (const d of VAULT_SETTING_DESCRIPTORS) {
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
