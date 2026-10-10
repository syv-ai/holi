/**
 * The vault's own settings: the pure core (parse → merge → validate → default).
 * See docs/features/settings.md.
 *
 * Two files, both optional: `.holi/settings/app.yaml` (committed, shared with
 * everyone who clones the vault) and `.holi/settings/app.local.yaml` (gitignored,
 * this machine only), the second overriding the first **per key**. Same layering
 * as `theme.ts` and `icon-map.ts`: you can disagree with the vault on your own
 * laptop without touching what your collaborators see.
 *
 * **This is a trust boundary.** In a shared vault the committed file was written
 * by somebody else. Every field is checked and a fresh narrow object is built
 * per kind; the parsed value is never returned, so nothing else in it rides
 * through.
 *
 * **Nothing here throws.** A missing or corrupt file, an unknown `kind`, a
 * value of the wrong type: each resolves to the default and appends a warning,
 * because a typo must never break the commit path or stop a vault opening.
 *
 * **Unknown top-level keys are ignored without a warning.** The local file
 * legitimately carries siblings this module knows nothing about (the reminder
 * watermark writes `reminders` there, `main/reminders/delivered-log.ts`).
 *
 * This module is pure and browser-safe (no fs). The main process reads the two
 * files off disk and hands their text to `resolveVaultSettings`.
 */

import { parse as parseYaml } from 'yaml'
import { vaultRelPath } from './path-safety'
import { isSurfaceName } from './surfaces'
import { isPluginId, type PluginSettings } from './plugins'

/** A pre-commit transform's name: kebab-case, and the key it is switched by
 *  in `hooks`, so there is no mapping table between them. Core's are
 *  `CORE_TRANSFORMS`; a plugin adds its own (`PluginInfo.transforms`). */
export type TransformName = string

/** How a transform is switched in the settings tab, and its default. */
export interface TransformToggle {
  name: TransformName
  label: string
  explanation: string
  default: boolean
}

/** Core's transforms, in the order a commit runs them, `relink` first because
 *  plugins' transforms run right after it (`knownTransforms`). `archive-done`
 *  is the tasks core part's, listed here until tasks is a plugin. */
export const CORE_TRANSFORMS: readonly TransformToggle[] = [
  {
    name: 'relink',
    label: 'Fix links when a file moves',
    explanation:
      'When git or the agent moves a file, rewrites the links pointing at it. Moves made in Holi fix their links already.',
    default: true,
  },
  {
    // Off: a transform that rearranges someone's work is opt-in.
    name: 'archive-done',
    label: 'File finished tasks away',
    explanation:
      'Moves tasks finished more than two weeks ago into archive/, links and all. Off by default, because it changes what your board shows.',
    default: false,
  },
  {
    name: 'normalize-md',
    label: 'Tidy markdown',
    explanation:
      'Trailing spaces and blank lines at the end of a file, and a task’s fields in their usual order.',
    default: true,
  },
  {
    name: 'shrink-images',
    label: 'Keep images small',
    explanation:
      'Shrinks a large PNG or JPEG as it is committed, in place: at most 4K, and to 256 colours only where that cannot be seen. Every version of an image stays in the history, so it is kept small from the start.',
    default: true,
  },
  {
    name: 'memory-index',
    label: 'Keep the memory index current',
    explanation:
      'Rebuilds .holi/memory/index.md so what the vault knows stays listed in one place.',
    default: true,
  },
]

const TRANSFORM_NAME = /^[a-z][a-z0-9-]*$/

/** Could `value` name a transform? A name no transform in this build has is
 *  kept in the file and ignored, so a vault can carry a plugin's switch on a
 *  machine without that plugin. */
export const isTransformName = (value: string): boolean => TRANSFORM_NAME.test(value)

/** Answers for every core transform, and whatever other names the files
 *  switch. A plugin transform the files do not name runs as its own default
 *  says (`transformDefaults`). */
export type VaultHooks = Record<TransformName, boolean>

/** Each toggle's default, by name. */
export const transformDefaults = (toggles: readonly TransformToggle[]): VaultHooks =>
  Object.fromEntries(toggles.map((t) => [t.name, t.default]))

/** The transforms this build knows, in the order a commit runs them: `relink`,
 *  each installed plugin's, then the rest of core's (`vaultTransforms` in main).
 *  The settings tab lists them in this order, so it shows what runs when. */
export const knownTransforms = (
  plugins: readonly { transforms?: readonly TransformToggle[] }[],
): TransformToggle[] => {
  const [first, ...rest] = CORE_TRANSFORMS
  return [first!, ...plugins.flatMap((p) => p.transforms ?? []), ...rest]
}

/** What the app's appearance follows. `system` tracks `prefers-color-scheme`. */
export type ColorScheme = 'dark' | 'light' | 'system'

export const COLOR_SCHEMES: readonly ColorScheme[] = ['dark', 'light', 'system']

/**
 * The font the **notes editor** sets prose in. Code, frontmatter and the
 * plain/code editor are never affected — see `notesFontTheme`.
 *
 * **A name, never a CSS string.** `.holi/settings/app.yaml` is committed, so in a
 * shared vault this value was written by somebody else; a `font-family` taken
 * from it verbatim would be arbitrary CSS crossing a trust boundary (the theme
 * whitelist argument). Three names resolve to three stacks this file owns, so
 * no sanitizer is needed.
 */
export type EditorFont = 'mono' | 'sans' | 'serif'

export const EDITOR_FONTS: readonly EditorFont[] = ['mono', 'sans', 'serif']

/**
 * What each name means, and the only place it means anything.
 *
 * **System stacks, deliberately.** Holi bundles no web fonts for the editor, so
 * a family that is not installed would fall back silently and the setting would
 * appear to do nothing. Every family here ships with the OS or is a generic.
 */
export const EDITOR_FONT_STACKS: Readonly<Record<EditorFont, string>> = Object.freeze({
  mono: 'ui-monospace, "SF Mono", Menlo, monospace',
  sans: 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif',
  serif: 'ui-serif, Georgia, Cambria, "Times New Roman", serif',
})

/**
 * What Home can be besides a surface, an app or a file: one of core's own
 * views. `recents` is what you opened recently, shown in the Home tab itself.
 */
export type HomeView = 'recents' | 'daily'

export const HOME_VIEWS: readonly HomeView[] = ['recents', 'daily']

/**
 * What Home is, classified. The file holds one string (`homeTargetOf` reads
 * it): a core view's name, a surface's name (`board`, `mail`), or a vault
 * path. A path may be a directory that is one document, such as a vault app:
 * the renderer's claims decide that, since they depend on the plugins too.
 *
 * **`daily` is a view, not a path.** `22-08-2026.md` would rot overnight;
 * naming the daily by kind keeps Home on it as the days turn.
 *
 * A surface is named by its spelling alone. Whether it exists, and may be
 * Home, is the renderer's registry's answer, since it depends on the plugins
 * the vault runs.
 */
export type HomeTarget =
  | { kind: 'recents' }
  | { kind: 'daily' }
  | { kind: 'surface'; surface: string }
  | { kind: 'file'; path: string }

/** What Home is, from its setting. Never throws: a validated value. */
export function homeTargetOf(home: string): HomeTarget {
  if ((HOME_VIEWS as readonly string[]).includes(home)) return { kind: home as HomeView }
  if (isSurfaceName(home)) return { kind: 'surface', surface: home }
  return { kind: 'file', path: home }
}

/**
 * An untrusted value as a `home`, or `null`: a view's name, or a path inside
 * the vault (an app bundle, or any file), normalised. A bare name with no
 * slash or dot is a view's name, never a file at the vault's root.
 */
export function parseHome(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (isSurfaceName(trimmed)) return trimmed
  try {
    return vaultRelPath(trimmed.replace(/\/+$/, ''))
  } catch {
    return null
  }
}

export interface ResolvedVaultSettings {
  /** What Home is, and what the vault opens on: see `homeTargetOf`. */
  home: string
  dailyNotes: boolean
  colorScheme: ColorScheme
  editorFont: EditorFont
  hooks: VaultHooks
  maxCommittedFileBytes: number
  /** Which plugins the vault declares, and which this machine turned off:
   *  `enabledPlugins` turns it into the set that runs. */
  plugins: PluginSettings
  /** Human-readable notes about dropped keys/values, surfaced so a typo is
   *  diagnosable rather than silent. Mirrors `ResolvedTheme.warnings`. */
  warnings: string[]
}

/**
 * Parse one file. Anything that is not a mapping reads as "no settings": a
 * half-written file must not stop a vault opening. YAML is a superset of JSON,
 * so this also reads a legacy `app.json` and the renderer's JSON patches.
 */
function parseFile(text: string | null): Record<string, unknown> {
  if (text === null || text.trim() === '') return {}
  try {
    const parsed: unknown = parseYaml(text)
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {}
  } catch {
    return {}
  }
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

/**
 * Resolve the committed + local settings files into one validated shape.
 *
 * Either argument may be `null` (file absent). Local is applied last so it wins
 * key by key. Never throws; every field is answered.
 *
 * **One loop over the schema**: a setting added to the list is read here
 * without this function being touched, by exactly the check that a write to
 * the same key has to pass.
 */
export function resolveVaultSettings(
  committedJson: string | null,
  localJson: string | null,
): ResolvedVaultSettings {
  // Order is the precedence: committed first, local last.
  const files = [parseFile(committedJson), parseFile(localJson)]
  const warnings: string[] = []
  const out: Record<string, unknown> = {}

  for (const setting of VAULT_SETTINGS) {
    if (setting.type.kind === 'flags') {
      out[setting.key] = mergeFlags(setting, files, warnings)
      continue
    }
    if (setting.type.kind === 'plugins') {
      out[setting.key] = mergePlugins(setting.key, files[0]!, files[1]!, warnings)
      continue
    }
    const raw = pick(files, setting.key)
    if (raw === undefined) {
      // A fresh object per read: the defaults are frozen and shared, and a
      // caller that mutated what it was handed would change every later read.
      out[setting.key] = clone(setting.default)
      continue
    }
    const read = readValue(setting, raw)
    if (read.ok) {
      out[setting.key] = read.value
    } else {
      warnings.push(
        `dropped "${setting.key}": expected ${read.expected}, got ${JSON.stringify(raw)}`,
      )
      out[setting.key] = clone(setting.default)
    }
  }

  return { ...(out as Omit<ResolvedVaultSettings, 'warnings'>), warnings }
}

/** A default, detached from the frozen shared object. Only the flags block is
 *  an object, one level deep, so a shallow copy is enough. */
function clone(value: unknown): unknown {
  return typeof value === 'object' && value !== null ? { ...(value as object) } : value
}

// ─────────────────────────────────────────────────────────────────────────────
// What a vault is asked at birth
// ─────────────────────────────────────────────────────────────────────────────

/** Which of the two files a row's answer is written to. */
export type SettingTarget = 'committed' | 'local'

/** One option in a `choice`. `value` is whatever the key holds (a `home` string
 *  for `home`, a `ColorScheme` for `colorScheme`) and is written verbatim. */
export interface VaultSettingOption {
  value: unknown
  label: string
  hint?: string
  /** Only offered while another answer holds. Data rather than a predicate, so
   *  the rule stays readable in the list and survives being serialised. */
  requires?: { key: VaultSettingKey; equals: unknown }
}

/**
 * The shape of a choice: a switch, a pick-one, or a set of switches that read
 * as one decision.
 */
export type VaultSettingControl =
  | { kind: 'toggle' }
  | {
      kind: 'choice'
      options: readonly VaultSettingOption[]
      /** It takes answers beyond `options` (Home's views, folder documents
       *  and files), which the settings tab lists beside them. */
      openEnded?: true
    }
  | {
      kind: 'group'
      toggles: readonly { key: TransformName; label: string; explanation: string }[]
    }
  /** A switch per installed plugin, which only the renderer knows. */
  | { kind: 'plugins' }

/** A key a descriptor can describe: every setting the resolver answers, each
 *  with a row in the settings tab. A superset of what the ritual asks
 *  (`askedAtBirth`). */
export type VaultSettingKey =
  | 'dailyNotes'
  | 'home'
  | 'hooks'
  | 'colorScheme'
  | 'editorFont'
  | 'maxCommittedFileBytes'
  | 'plugins'

export interface VaultSettingDescriptor {
  key: VaultSettingKey
  label: string
  explanation: string
  control: VaultSettingControl
  /** The setting's own default, never restated. */
  default: unknown
  target: SettingTarget
  /** See `VaultSetting.askedAtBirth`. */
  askedAtBirth: boolean
  /** See `VaultSetting.whereToChange`. */
  whereToChange: string
  /** See `VaultSetting.section`. */
  section: string
}

/**
 * The two files a setting can live in.
 *
 * Everything a person chooses about a vault lives in `.holi/settings/`. `app`
 * says what it holds: how the app behaves here, as opposed to how it looks
 * (`theme.css`) or what it labels things with (`icons.yaml`).
 *
 * Named here and imported everywhere, including by main and the renderer.
 */
export const SETTINGS_FILE = '.holi/settings/app.yaml'
export const SETTINGS_LOCAL_FILE = '.holi/settings/app.local.yaml'

const SETTINGS_FILE_HINT = `Change it any time in ${SETTINGS_FILE}`
const LOCAL_FILE_HINT = `Change it any time in ${SETTINGS_LOCAL_FILE}, which stays on this machine`

/**
 * What a setting's value IS: its validation and, because the two are the same
 * question, the options a control needs.
 *
 * **One field, not two.** A `type` and a separate `control` could disagree: a
 * boolean with a pick-one control, or a choice offering a value the validator
 * refuses. Here the kind decides the control (`toggle`, `choice`, `group`) and
 * the entry supplies only the labels, so that class of bug cannot be written.
 *
 * `home` and `plugins` each exist for exactly one setting.
 */
export type SettingType =
  | { kind: 'boolean' }
  /** Pick one of these values, and these are also the only legal ones. */
  | { kind: 'enum'; options: readonly VaultSettingOption[] }
  /**
   * A positive number. `options` are what the pane OFFERS, not the whole legal
   * range: a hand-edited file naming a size the pane does not list is a good
   * answer.
   */
  | { kind: 'number'; options: readonly VaultSettingOption[] }
  /**
   * A fixed set of named switches, merged **per flag** across the two files
   * rather than wholesale, so a local file naming one flag cannot silently
   * answer for the others.
   */
  | {
      kind: 'flags'
      flags: readonly { key: TransformName; label: string; explanation: string }[]
    }
  /**
   * What Home is: one of `options`, a view's name, or any app or file in the
   * vault by its path (`parseHome`). The settings tab adds the views that can
   * be Home and the vault's apps to the options.
   */
  | { kind: 'home'; options: readonly VaultSettingOption[] }
  /**
   * Plugin id to on or off. The only setting both files answer differently:
   * the committed file declares the vault's plugins, and the local file can
   * only turn one off on this machine (`mergePlugins`). The ids are whatever
   * plugins the build has, so shared validates their shape, not their names.
   */
  | { kind: 'plugins' }

/**
 * One setting, declared once.
 *
 * Everything about a setting lives here and everything else is derived: the
 * defaults object, the reader, the writer's validator, and the row the settings
 * tab renders.
 */
export interface VaultSetting {
  key: VaultSettingKey
  label: string
  explanation: string
  /** Validation and control in one, see `SettingType`. */
  type: SettingType
  /** The value this key holds when no file mentions it. */
  default: unknown
  target: SettingTarget
  /**
   * Whether the onboarding ritual asks this at a vault's birth, and the seed
   * therefore writes it.
   *
   * **Not every setting is a question for a stranger.** Every row in the ritual
   * is one more thing between somebody and their first note, so a preference
   * with a good default and no consequence at birth stays out of it. The
   * settings pane renders the whole list regardless.
   *
   * It also keeps a default a default: a value the seed does not write
   * can still be raised later for existing vaults.
   */
  askedAtBirth: boolean
  /** Where this lives once the ritual is over. Carried as **data** so a row
   *  structurally cannot ship without one. */
  whereToChange: string
  /**
   * Which section of the settings tab this row appears under. Carried here
   * rather than in a renderer registry, so adding a setting is adding one entry.
   *
   * A plain string, not a union of the section ids: the ids live in the
   * renderer. A renderer test asserts every value here names a real section.
   */
  section: string
}

/**
 * Every setting, in the order the settings tab and the onboarding step render
 * them, and the source the seed writes the settings files from.
 *
 * **One list, every reader.** Adding a setting is adding a row here. The ritual
 * and the seed read only the `askedAtBirth` subset.
 */
export const VAULT_SETTINGS: readonly VaultSetting[] = [
  {
    key: 'dailyNotes',
    label: 'Keep a daily note',
    // The shared-vault warning lives here: the answer is asked, never guessed
    // from the GitHub collaborator count (docs/features/daily-notes.md).
    explanation:
      'A fresh note each morning, with yesterday’s filed away automatically. In a vault you share, everyone writes the same file, which gets messy fast.',
    type: { kind: 'boolean' },
    default: true,
    target: 'committed',
    askedAtBirth: true,
    whereToChange: SETTINGS_FILE_HINT,
    section: 'general',
  },
  {
    key: 'home',
    label: 'Home is',
    explanation: 'What Home shows, and what you see when you open this vault.',
    type: {
      kind: 'home',
      options: [
        { value: 'recents', label: 'Recently opened' },
        // Only on offer while the vault actually keeps one: a Home on a daily
        // note the vault does not make would read as a broken choice.
        {
          value: 'daily',
          label: 'Today’s note',
          requires: { key: 'dailyNotes', equals: true },
        },
      ],
    },
    // One of Holi's own views, so Home works in a vault with no apps.
    default: 'recents',
    target: 'committed',
    askedAtBirth: true,
    whereToChange: `${SETTINGS_FILE_HINT}, where it can also name any view, app or file. A home of your own goes in ${SETTINGS_LOCAL_FILE}`,
    section: 'general',
  },
  {
    key: 'hooks',
    label: 'Run on every commit',
    explanation:
      'In this order, each time your work is saved. None of them can stop a save; each fix lands in the same commit.',
    type: {
      kind: 'flags',
      // **Merged per flag across the two files, not wholesale**: a local file
      // naming one transform must not silently disable the others.
      // Core's; `vaultSettingDescriptors` adds the installed plugins'.
      flags: CORE_TRANSFORMS.map(({ name, label, explanation }) => ({
        key: name,
        label,
        explanation,
      })),
    },
    default: transformDefaults(CORE_TRANSFORMS),
    target: 'committed',
    askedAtBirth: true,
    whereToChange: SETTINGS_FILE_HINT,
    section: 'commits',
  },
  {
    key: 'maxCommittedFileBytes',
    label: 'Largest file to commit',
    // This is the vault's ONE veto: every other pre-commit transform lets the
    // commit through, but git history is permanent and push is automatic, so an
    // oversized blob committed once is published forever.
    explanation:
      'Anything bigger is left out of the commit and reported, rather than pushed to everyone. GitHub itself warns at 50 MB and refuses at 100.',
    type: {
      // **Any positive number is legal; the options are only what is OFFERED.**
      kind: 'number',
      options: [
        { value: 5 * 1024 * 1024, label: '5 MB' },
        { value: 10 * 1024 * 1024, label: '10 MB' },
        { value: 25 * 1024 * 1024, label: '25 MB' },
        { value: 100 * 1024 * 1024, label: '100 MB', hint: 'GitHub’s own hard limit' },
      ],
    },
    default: 10 * 1024 * 1024,
    target: 'committed',
    // **Not asked at birth:** a number written into every vault at
    // creation is a default that can never be raised for those vaults.
    askedAtBirth: false,
    whereToChange: SETTINGS_FILE_HINT,
    section: 'commits',
  },
  {
    key: 'colorScheme',
    label: 'Appearance',
    explanation: 'Light, dark, or whatever your Mac is set to.',
    type: {
      kind: 'enum',
      options: [
        { value: 'system', label: 'Match my system' },
        { value: 'light', label: 'Light' },
        { value: 'dark', label: 'Dark' },
      ],
    },
    default: 'system' as ColorScheme,
    // Machine-local, and the only row that is: a teammate's committed choice
    // must not flip your app to light mode.
    target: 'local',
    askedAtBirth: true,
    whereToChange: LOCAL_FILE_HINT,
    section: 'appearance',
  },
  {
    key: 'editorFont',
    label: 'Notes are set in',
    explanation:
      'Prose only. Code, frontmatter and the plain editor stay monospaced whatever this says.',
    type: {
      kind: 'enum',
      options: [
        { value: 'mono', label: 'Monospace' },
        { value: 'sans', label: 'Sans' },
        { value: 'serif', label: 'Serif' },
      ],
    },
    default: 'serif' as EditorFont,
    target: 'committed',
    // Not asked at birth, deliberately: it has a good default and no
    // consequence at a vault's first moment.
    askedAtBirth: false,
    whereToChange: SETTINGS_FILE_HINT,
    section: 'editor',
  },
  {
    key: 'plugins',
    label: 'Plugins',
    explanation:
      'What this vault runs beyond the core. Everyone who clones it gets the same plugins, and any of them can be turned off on one machine.',
    type: { kind: 'plugins' },
    // Every plugin's own default: see `enabledPlugins`.
    default: Object.freeze({ vault: Object.freeze({}), localOff: Object.freeze([]) }),
    // The vault declares them; the local file can only turn one off.
    target: 'committed',
    askedAtBirth: false,
    whereToChange: `${SETTINGS_FILE_HINT}. Turn one off on this machine alone in ${SETTINGS_LOCAL_FILE}`,
    section: 'plugins',
  },
]

/**
 * What a vault does when it says nothing.
 *
 * **Derived from `VAULT_SETTINGS`, not written out**, so a setting is one entry.
 * Typed by `ResolvedVaultSettings` rather than by inference, so consumers get
 * `ColorScheme` and not `unknown`.
 *
 * `archive-done` is off: it moves task files, which changes what the board
 * shows, and a transform that rearranges someone's work is opt-in.
 * `memory-index` is on: it only ever rewrites `.holi/memory/index.md`, a file it
 * generated. The 10 MB cap is read by `main/vault/large-files.ts`; notes-vault
 * assets sit well under it, and GitHub warns at 50.
 */
export const VAULT_SETTING_DEFAULTS: Omit<ResolvedVaultSettings, 'warnings'> = Object.freeze(
  Object.fromEntries(VAULT_SETTINGS.map((s) => [s.key, s.default])),
) as Omit<ResolvedVaultSettings, 'warnings'>

/**
 * The schema and the resolved shape must name exactly the same keys.
 *
 * A compile-time check in **both** directions, because each miss is silent in
 * its own way: a key in the interface that no entry declares resolves to
 * `undefined` at runtime, and an entry for a key the interface lacks is a
 * setting nothing can ever read.
 */
type _SchemaCoversSettings =
  Exclude<keyof ResolvedVaultSettings, 'warnings'> extends VaultSettingKey
    ? VaultSettingKey extends Exclude<keyof ResolvedVaultSettings, 'warnings'>
      ? true
      : ['schema declares a key ResolvedVaultSettings does not have']
    : ['ResolvedVaultSettings has a key no schema entry declares']
const _keysAgree: _SchemaCoversSettings = true
void _keysAgree

/**
 * The rows the settings tab and the onboarding act render.
 *
 * A **view** of the schema rather than a second list: `control` is computed
 * from `type`, so a control cannot offer a value its validator refuses.
 */
export const VAULT_SETTING_DESCRIPTORS: readonly VaultSettingDescriptor[] = VAULT_SETTINGS.map(
  (s) => ({ ...s, control: controlFor(s.type) }),
)

function controlFor(type: SettingType): VaultSettingControl {
  switch (type.kind) {
    case 'boolean':
      return { kind: 'toggle' }
    case 'flags':
      return { kind: 'group', toggles: type.flags }
    case 'home':
      return { kind: 'choice', options: type.options, openEnded: true }
    case 'plugins':
      return { kind: 'plugins' }
    // enum and number are both "pick one of these", and differ only in
    // what ELSE is legal, which is the validator's business, not the control's.
    default:
      return { kind: 'choice', options: type.options }
  }
}

/**
 * Read one untrusted value for one setting.
 *
 * **The single check the reader and the writer share**, so the file can never
 * hold a value the pane could not write, or the reverse.
 *
 * `flags` is absent here on purpose: it is the one kind whose answer depends on
 * the layers below it, so it is merged rather than validated in isolation. See
 * `mergeFlags`.
 */
function readValue(
  setting: VaultSetting,
  value: unknown,
): { ok: true; value: unknown } | { ok: false; expected: string } {
  const type = setting.type
  switch (type.kind) {
    case 'boolean':
      return typeof value === 'boolean'
        ? { ok: true, value }
        : { ok: false, expected: 'true or false' }
    case 'enum':
      return type.options.some((o) => o.value === value)
        ? { ok: true, value }
        : { ok: false, expected: `one of ${type.options.map((o) => String(o.value)).join(', ')}` }
    case 'number':
      return typeof value === 'number' && Number.isFinite(value) && value > 0
        ? { ok: true, value }
        : { ok: false, expected: 'a positive number' }
    case 'flags':
    case 'plugins':
      return typeof value === 'object' && value !== null && !Array.isArray(value)
        ? { ok: true, value }
        : { ok: false, expected: 'an object' }
    case 'home': {
      const home = parseHome(value)
      return home === null
        ? { ok: false, expected: "recents, daily, a view's name, or a path in the vault" }
        : { ok: true, value: home }
    }
  }
}

/**
 * Merge a flags block across the layers, one flag at a time.
 *
 * A local file naming one transform must not silently disable the others, which
 * is what a whole-block override would do.
 */
function mergeFlags(
  setting: VaultSetting,
  files: Record<string, unknown>[],
  warnings: string[],
): Record<string, boolean> {
  const type = setting.type
  if (type.kind !== 'flags') return {}
  const out: Record<string, boolean> = { ...(setting.default as Record<string, boolean>) }
  for (const file of files) {
    if (!(setting.key in file)) continue
    const block = file[setting.key]
    if (typeof block !== 'object' || block === null || Array.isArray(block)) {
      warnings.push(`dropped "${setting.key}": expected an object, got ${JSON.stringify(block)}`)
      continue
    }
    // A name no transform here has is kept: it may be a plugin's this build
    // does not have, and the runner ignores it.
    for (const [name, value] of Object.entries(block as Record<string, unknown>)) {
      if (!isTransformName(name)) {
        warnings.push(`dropped "${setting.key}.${name}": not a transform name`)
      } else if (typeof value !== 'boolean') {
        warnings.push(
          `dropped "${setting.key}.${name}": expected true or false, got ${JSON.stringify(value)}`,
        )
      } else {
        out[name] = value
      }
    }
  }
  return out
}

/**
 * One file's `plugins` block as a map of plugin id to on or off, dropping
 * what is not one, with a warning per drop. Null when the file says nothing.
 */
function pluginBlock(
  key: string,
  file: Record<string, unknown>,
  warnings: string[],
  verb: 'dropped' | 'refused',
): Record<string, boolean> | null {
  if (!(key in file)) return null
  const block = file[key]
  if (typeof block !== 'object' || block === null || Array.isArray(block)) {
    warnings.push(`${verb} "${key}": expected an object, got ${JSON.stringify(block)}`)
    return null
  }
  const out: Record<string, boolean> = {}
  for (const [id, on] of Object.entries(block as Record<string, unknown>)) {
    if (!isPluginId(id)) warnings.push(`${verb} "${key}.${id}": not a plugin id`)
    else if (typeof on !== 'boolean') {
      warnings.push(`${verb} "${key}.${id}": expected true or false, got ${JSON.stringify(on)}`)
    } else out[id] = on
  }
  return out
}

/**
 * The `plugins` setting across the two files, which do different jobs: the
 * committed file's answers are the vault's, and the local file contributes
 * only its `false`s. A local `true` would turn on a plugin the vault has
 * off, which only the vault decides, so it is dropped with a warning.
 */
function mergePlugins(
  key: string,
  committed: Record<string, unknown>,
  local: Record<string, unknown>,
  warnings: string[],
): PluginSettings {
  const vault = pluginBlock(key, committed, warnings, 'dropped') ?? {}
  const localOff: string[] = []
  for (const [id, on] of Object.entries(pluginBlock(key, local, warnings, 'dropped') ?? {})) {
    if (on) {
      warnings.push(
        `dropped "${key}.${id}" in ${SETTINGS_LOCAL_FILE}: this machine can only turn a plugin off`,
      )
    } else localOff.push(id)
  }
  return { vault, localOff }
}

/** The subset the ritual asks and the seed writes: see `askedAtBirth`. */
export const RITUAL_SETTING_DESCRIPTORS: readonly VaultSettingDescriptor[] =
  VAULT_SETTING_DESCRIPTORS.filter((d) => d.askedAtBirth)

/**
 * The descriptors with `known` as the transforms the `hooks` row switches:
 * what the settings tab and the onboarding act render, given the plugins
 * this build has (`knownTransforms`).
 */
export function vaultSettingDescriptors(
  known: readonly TransformToggle[],
): VaultSettingDescriptor[] {
  return VAULT_SETTING_DESCRIPTORS.map((d) =>
    d.control.kind !== 'group'
      ? d
      : {
          ...d,
          control: {
            kind: 'group',
            toggles: known.map(({ name, label, explanation }) => ({
              key: name,
              label,
              explanation,
            })),
          },
          default: transformDefaults(known),
        },
  )
}

/**
 * The settings a freshly created vault is born with, for one of the two files.
 *
 * Built from the descriptors rather than hand-written, so the file a vault is
 * seeded with and the questions it was asked cannot drift apart. Round-trips
 * through `resolveVaultSettings` to exactly `VAULT_SETTING_DEFAULTS`: a seeded
 * vault behaves identically to one with no settings files at all.
 */
export function seedSettings(target: SettingTarget): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  // The ritual's list, not every setting: a vault is born declaring the answers
  // it was asked for, and inherits the rest (see `askedAtBirth`).
  for (const d of RITUAL_SETTING_DESCRIPTORS) {
    if (d.target === target) out[d.key] = d.default
  }
  return out
}

/**
 * Read an untrusted object as a **patch**: only the keys it actually answered,
 * each validated, and nothing else.
 *
 * **Not `resolveVaultSettings`, and the difference matters.** A read *resolves*:
 * every key answered, defaults filled in. Writing that back would stamp defaults
 * over keys the user never touched, so a write carries only what was answered.
 *
 * **Asymmetric with the read on unknown keys, on purpose.** A read *tolerates*
 * siblings it does not own (`reminders` lives in the local file). A write must
 * not be able to *create* one, or this becomes a route for the renderer to put
 * arbitrary data into a committed, synced file. Existing siblings survive
 * because the caller merges the patch into the file it read.
 */
export function parseSettingsPatch(
  json: string | null,
  /** The transforms this build has (`knownTransforms`): a write may switch
   *  only those, though a read keeps any name it finds. */
  known: readonly TransformToggle[],
): {
  patch: Record<string, unknown>
  warnings: string[]
} {
  const raw = parseFile(json)
  const patch: Record<string, unknown> = {}
  const warnings: string[] = []

  for (const setting of VAULT_SETTINGS) {
    if (!(setting.key in raw)) continue
    const value = raw[setting.key]

    if (setting.type.kind === 'flags') {
      // Validated flag by flag, like the read, but NOT merged with anything: a
      // patch says only what it was told, and the caller merges it into the
      // file it read.
      if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        warnings.push(`refused "${setting.key}": ${JSON.stringify(value)}`)
        continue
      }
      const block: Record<string, boolean> = {}
      for (const [name, flag] of Object.entries(value as Record<string, unknown>)) {
        if (!known.some((t) => t.name === name))
          warnings.push(`refused unknown transform "${name}"`)
        else if (typeof flag !== 'boolean')
          warnings.push(`refused "${setting.key}.${name}": ${JSON.stringify(flag)}`)
        else block[name] = flag
      }
      // A block that survived nothing is not written: `{}` would say nothing.
      if (Object.keys(block).length > 0) patch[setting.key] = block
      continue
    }

    if (setting.type.kind === 'plugins') {
      // Which file it is going to is the writer's business: a local `true`
      // is written as asked, and the read ignores it.
      const block = pluginBlock(setting.key, raw, warnings, 'refused')
      if (block !== null && Object.keys(block).length > 0) patch[setting.key] = block
      continue
    }

    const read = readValue(setting, value)
    if (read.ok) patch[setting.key] = read.value
    else warnings.push(`refused "${setting.key}": ${JSON.stringify(value)}`)
  }

  return { patch, warnings }
}

/**
 * Split the ritual's answers into one patch per file.
 *
 * Driven by each descriptor's `target`, never by a list of keys written out
 * here. An answer for a key no descriptor claims is dropped: the step can only
 * answer what it asked.
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
 * A row can depend on another row: a Home on today's note is only on offer
 * while the vault actually keeps one. Filtering rather than disabling: the
 * reason is already visible one row up.
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
 * Turning daily notes off takes "today's note" off the Home row, and the
 * answer sitting there can no longer be seen or changed. Move it to the first
 * option still on offer, visibly, rather than leaving a row with nothing
 * selected or writing a value that was silently withdrawn.
 *
 * Idempotent, and a no-op when every answer is still available.
 */
export function normaliseAnswers(answers: Record<string, unknown>): Record<string, unknown> {
  let out = answers
  for (const descriptor of VAULT_SETTING_DESCRIPTORS) {
    if (descriptor.control.kind !== 'choice') continue
    // Repair only what is there: filling in an answer nobody gave is
    // `initialState`'s job.
    if (!(descriptor.key in out)) continue
    const options = availableOptions(descriptor, out)
    if (options.length === 0) continue
    const current = JSON.stringify(out[descriptor.key])
    if (options.some((o) => JSON.stringify(o.value) === current)) continue
    // A row that takes values beyond its options (Home's views and files) is
    // repaired only when its answer was one of them and has been withdrawn.
    if (
      descriptor.control.openEnded === true &&
      !descriptor.control.options.some((o) => JSON.stringify(o.value) === current)
    ) {
      continue
    }
    // Copy on first change only, so an untouched object comes back identical.
    if (out === answers) out = { ...answers }
    out[descriptor.key] = options[0]!.value
  }
  return out
}

/**
 * The mode a `colorScheme` setting actually resolves to, right now.
 *
 * `system` is a deferral to the OS, whose answer changes while the app runs.
 * Keeping this pure leaves the renderer only to report the OS preference and
 * re-ask when it changes.
 */
export function resolveColorMode(
  scheme: ColorScheme,
  systemPrefersDark: boolean,
): 'light' | 'dark' {
  if (scheme === 'system') return systemPrefersDark ? 'dark' : 'light'
  return scheme
}
