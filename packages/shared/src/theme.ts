/**
 * Per-vault theming — the pure core (parse → merge → whitelist → validate).
 *
 * A vault contributes a set of *token values* that re-cascade the app's semantic
 * design tokens (see the renderer's `index.css`). The vocabulary is a fixed
 * whitelist of **colours and chrome only** — there is deliberately no token that
 * can express spacing, size, or position, so a theme (whoever or whatever wrote
 * it) is *structurally* incapable of changing layout. That guarantee is the
 * whole point, and it lives here: nothing outside this whitelist ever reaches
 * the DOM.
 *
 * This module is pure and browser-safe (no fs, no DOM). The main process reads
 * the two theme files off disk and hands their text to `resolveTheme`; the
 * renderer turns a resolved block into custom properties with `themeBlockToVars`
 * and writes them onto `document.documentElement`.
 *
 * Precedence: `.holi/settings/theme.json` (committed, shared) is the base; a personal
 * `.holi/settings/theme.local.json` (gitignored) overrides it **per key within each
 * mode**, so a one-line local file can recolour just `primary` and inherit the
 * rest. See the handoff/design notes for the decision trail.
 */

/**
 * The two files a theme lives in, beside the settings they belong with.
 *
 * Declared here rather than in main, because the renderer names them too (the
 * settings pane offers both as an escape hatch) and main writes them. Three
 * copies of a path is three chances to move two of them.
 */
export const THEME_FILE = '.holi/settings/theme.json'
export const THEME_LOCAL_FILE = '.holi/settings/theme.local.json'

/** The light/dark scheme a block applies to. */
export type ThemeMode = 'light' | 'dark'

/** A map of token slug → CSS value. Slugs are the whitelist names below, without
 *  the `--` prefix (the prefix is added in `themeBlockToVars`). */
export type ThemeBlock = Record<string, string>

/** A vault theme file, once parsed. Both blocks are optional. */
export interface VaultTheme {
  light?: ThemeBlock
  dark?: ThemeBlock
}

/** The validated, whitelist-filtered result handed to the renderer. */
export interface ResolvedTheme {
  light: ThemeBlock
  dark: ThemeBlock
  /** Human-readable notes about dropped keys/values — surfaced to the agent/user
   *  so a typo is diagnosable rather than silent. */
  warnings: string[]
}

/**
 * The colour tokens — exactly shadcn's semantic vocabulary as mapped in
 * `index.css`. Setting `--primary` (etc.) re-cascades every `--color-*` utility
 * because those are `var()` pointers exposed via `@theme inline`.
 */
export const THEME_COLOR_TOKENS = [
  'background',
  'foreground',
  'card',
  'card-foreground',
  'popover',
  'popover-foreground',
  'primary',
  'primary-foreground',
  // The brand as TEXT. Separate from `primary`, which is the brand as a FILL:
  // a fill dark enough to carry near-white text is too dark to be text itself
  // on a dark background. A vault recolouring the brand should set both.
  'brand',
  'secondary',
  'secondary-foreground',
  'muted',
  'muted-foreground',
  'accent',
  'accent-foreground',
  'destructive',
  'destructive-foreground',
  'border',
  // The chrome hairline — pane splits, the sidebar's edge, panel-header rules —
  // as opposed to `border`, which is the edge of an object (card, chip,
  // popover). Defaults to `border` faded toward `background`, so a vault that
  // recolours either gets a matching divider without setting this at all.
  'divider',
  'input',
  'ring',
  // Chrome colours that live on their own tokens (see index.css).
  'scrollbar-thumb',
  'scrollbar-thumb-hover',
  'selection',
  // Editor wiki-link chips + task-status orbs (consumed by the CodeMirror theme).
  'link',
  'link-missing',
  'task',
  'task-todo',
  'task-doing',
  'task-done',
] as const

/** Length-valued chrome tokens (corner rounding). */
export const THEME_LENGTH_TOKENS = ['radius'] as const

/** Shadow-valued chrome tokens (paint-only elevation). These are consumed by the
 *  `.shadow-popover` / `.shadow-dialog` classes in `index.css`; there is no
 *  `shadow-card` token because no surface consumes one today. */
export const THEME_SHADOW_TOKENS = ['shadow-popover', 'shadow-dialog'] as const

/** Every themeable token slug. There is no layout token here, by design. */
export const THEME_TOKENS: readonly string[] = [
  ...THEME_COLOR_TOKENS,
  ...THEME_LENGTH_TOKENS,
  ...THEME_SHADOW_TOKENS,
]

const COLOR_SET = new Set<string>(THEME_COLOR_TOKENS)
const LENGTH_SET = new Set<string>(THEME_LENGTH_TOKENS)
const SHADOW_SET = new Set<string>(THEME_SHADOW_TOKENS)

/**
 * The security gate every value must pass. A themed value only ever ends up as
 * the *value* of a CSS custom property consumed through `var(...)`, and CSS
 * custom-property substitution cannot open a new declaration or rule — but we
 * still refuse anything that looks like an injection or an external fetch, so a
 * hostile theme can't smuggle `url()`, comments, or rule-breaking punctuation
 * past validation (and the value stays readable for humans debugging it).
 */
function isSafeCssValue(v: string): boolean {
  if (typeof v !== 'string') return false
  const trimmed = v.trim()
  if (trimmed === '' || trimmed.length > 200) return false
  if (/[;{}<>@\\]/.test(trimmed)) return false
  if (/url\s*\(/i.test(trimmed)) return false
  if (/expression\s*\(/i.test(trimmed)) return false
  if (trimmed.includes('/*') || trimmed.includes('*/')) return false
  if (/[\n\r\t]/.test(trimmed)) return false
  return true
}

const COLOR_FUNCS = /^(rgb|rgba|hsl|hsla|hwb|lab|lch|oklab|oklch|color)\s*\([^)]*\)$/i
const HEX = /^#([0-9a-fA-F]{3,8})$/
const KEYWORD = /^[a-zA-Z]+$/ // transparent, currentColor, named colours

function isColorLike(v: string): boolean {
  const t = v.trim()
  return HEX.test(t) || COLOR_FUNCS.test(t) || KEYWORD.test(t)
}

const LENGTH = /^(0|-?(\d+\.?\d*|\.\d+)(px|rem|em|%|vh|vw|vmin|vmax))$/

function isLengthLike(v: string): boolean {
  return LENGTH.test(v.trim())
}

/** Whether `value` is a legal value for token `slug`. Assumes `slug` is a known
 *  token. Shadows are only gated by `isSafeCssValue` — box-shadow syntax is broad
 *  and paint-only, so we don't police its grammar, only its safety. */
function isValidTokenValue(slug: string, value: string): boolean {
  if (!isSafeCssValue(value)) return false
  if (COLOR_SET.has(slug)) return isColorLike(value)
  if (LENGTH_SET.has(slug)) return isLengthLike(value)
  if (SHADOW_SET.has(slug)) return true
  return false
}

/**
 * Parse a theme file's text into a `VaultTheme`, or `null` if it is not a
 * JSON object. Never throws — a broken file must degrade to "no theme", not
 * crash the read.
 */
export function parseVaultTheme(json: string): VaultTheme | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    return null
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  return parsed as VaultTheme
}

function blockOf(theme: VaultTheme | null, mode: ThemeMode): ThemeBlock {
  const block = theme?.[mode]
  if (block === null || typeof block !== 'object' || Array.isArray(block)) return {}
  return block as ThemeBlock
}

/** Merge → whitelist → validate one mode's block, appending any drops to `warnings`. */
function resolveBlock(
  committed: ThemeBlock,
  local: ThemeBlock,
  mode: ThemeMode,
  warnings: string[],
): ThemeBlock {
  // Per-key deep merge: local wins key-by-key over committed.
  const merged: ThemeBlock = { ...committed, ...local }
  const out: ThemeBlock = {}
  for (const [key, value] of Object.entries(merged)) {
    if (!THEME_TOKENS.includes(key)) {
      warnings.push(`dropped unknown token "${key}" (${mode})`)
      continue
    }
    if (typeof value !== 'string' || !isValidTokenValue(key, value)) {
      warnings.push(`dropped invalid value for "${key}" (${mode}): ${JSON.stringify(value)}`)
      continue
    }
    out[key] = value.trim()
  }
  return out
}

/**
 * Resolve the committed + local theme files into a clean, validated theme.
 * Either argument may be `null` (file absent). Malformed JSON degrades to
 * "no theme" for that file. The result contains only whitelisted, validated
 * tokens — it is safe to write straight onto the DOM.
 */
export function resolveTheme(
  committedJson: string | null,
  localJson: string | null,
): ResolvedTheme {
  const committed = committedJson === null ? null : parseVaultTheme(committedJson)
  const local = localJson === null ? null : parseVaultTheme(localJson)
  const warnings: string[] = []
  return {
    light: resolveBlock(blockOf(committed, 'light'), blockOf(local, 'light'), 'light', warnings),
    dark: resolveBlock(blockOf(committed, 'dark'), blockOf(local, 'dark'), 'dark', warnings),
    warnings,
  }
}

/**
 * Turn a resolved block into `{ '--slug': value }` custom properties for the
 * renderer to write onto `document.documentElement`.
 */
export function themeBlockToVars(block: ThemeBlock): Record<string, string> {
  const vars: Record<string, string> = {}
  for (const [slug, value] of Object.entries(block)) {
    vars[`--${slug}`] = value
  }
  return vars
}

/**
 * The groups the settings tab renders the tokens in, and the order it renders
 * them.
 *
 * **Grouping is the only thing hand-written here.** A label is derived from the
 * slug (`card-foreground` → "Card foreground") rather than restated: thirty
 * hand-written strings that repeat their own key are thirty chances for one to
 * drift, and the slugs were chosen to be read. A `note` is written only where
 * the name genuinely is not enough — where two tokens sound interchangeable and
 * are not.
 *
 * Every token appears exactly once, which `theme.test.ts` pins against
 * `THEME_TOKENS`: a token added to the whitelist and forgotten here would be
 * settable in the file and invisible in the pane.
 */
export interface ThemeTokenGroup {
  title: string
  /** What this group is for, in the pane. */
  blurb: string
  tokens: readonly string[]
}

export const THEME_TOKEN_GROUPS: readonly ThemeTokenGroup[] = [
  {
    title: 'Surfaces',
    blurb: 'The page and the things that sit on it.',
    tokens: [
      'background',
      'foreground',
      'card',
      'card-foreground',
      'popover',
      'popover-foreground',
    ],
  },
  {
    title: 'Brand and action',
    blurb: 'The colour this vault is, and the things you can press.',
    tokens: ['primary', 'primary-foreground', 'brand', 'ring', 'selection'],
  },
  {
    title: 'Supporting',
    blurb: 'Quieter fills: a hover, a secondary button, text that is not the point.',
    tokens: [
      'secondary',
      'secondary-foreground',
      'muted',
      'muted-foreground',
      'accent',
      'accent-foreground',
    ],
  },
  {
    title: 'Warnings',
    blurb: 'Destructive actions, and anything that has gone wrong.',
    tokens: ['destructive', 'destructive-foreground'],
  },
  {
    title: 'Edges',
    blurb: 'What separates one thing from another.',
    tokens: ['border', 'divider', 'input'],
  },
  {
    title: 'Scrollbars',
    blurb: 'The thumb, at rest and under the pointer.',
    tokens: ['scrollbar-thumb', 'scrollbar-thumb-hover'],
  },
  {
    title: 'In a note',
    blurb: 'Wiki-link chips and task orbs, inside the editor.',
    tokens: ['link', 'link-missing', 'task', 'task-todo', 'task-doing', 'task-done'],
  },
  {
    title: 'Chrome',
    blurb: 'Shape and depth rather than colour.',
    tokens: ['radius', 'shadow-popover', 'shadow-dialog'],
  },
]

/** The handful of tokens whose name is genuinely not enough, because a
 *  neighbouring token sounds like it means the same thing. */
export const THEME_TOKEN_NOTES: Readonly<Record<string, string>> = Object.freeze({
  primary: 'The brand as a FILL, with primary-foreground on top of it.',
  brand: 'The same brand as TEXT. A fill dark enough to carry pale text is too dark to be text.',
  accent: 'The subtle hover surface, not the brand.',
  divider: 'The seam between two panes. `border` is the edge of an object.',
  selection: 'Highlighted text. Follows the brand unless you set it.',
})

/** `card-foreground` → `Card foreground`. */
export function themeTokenLabel(slug: string): string {
  const words = slug.replace(/-/g, ' ')
  return words.charAt(0).toUpperCase() + words.slice(1)
}

/** Which control a token wants: a colour needs a swatch and a picker, a length
 *  and a shadow are typed. Derived from the same three lists the validator
 *  uses, so a control can never disagree with what will be accepted. */
export function themeTokenKind(slug: string): 'color' | 'length' | 'shadow' | null {
  if (COLOR_SET.has(slug)) return 'color'
  if (LENGTH_SET.has(slug)) return 'length'
  if (SHADOW_SET.has(slug)) return 'shadow'
  return null
}

/** A theme edit: a token set to a value, or to `null` to clear it and fall back
 *  to Holi's default. Both modes are optional — a pane edits one at a time. */
export interface ThemePatch {
  light?: Record<string, string | null>
  dark?: Record<string, string | null>
}

/**
 * Read an untrusted object as a theme **patch** — only the tokens it names,
 * each validated, and nothing else.
 *
 * The settings pane's counterpart to `parseSettingsPatch`, and it exists for
 * that function's reason: a write must not reach these files by a route that
 * skips the check a hand-written file gets. The same `isValidTokenValue` guards
 * both, so the pane cannot store a value the resolver would later drop —
 * which would read as a control that does nothing.
 *
 * **`null` is a legal value and means "clear it".** Resetting a token to
 * Holi's default is deleting the key, not writing an empty string, which would
 * be dropped as invalid and leave the old value in place.
 */
export function parseThemePatch(json: string | null): { patch: ThemePatch; warnings: string[] } {
  const warnings: string[] = []
  const patch: ThemePatch = {}
  if (json === null || json.trim() === '') return { patch, warnings }

  const parsed = parseVaultTheme(json)
  if (parsed === null) {
    warnings.push('refused a theme patch that is not a JSON object')
    return { patch, warnings }
  }

  for (const mode of ['light', 'dark'] as const) {
    const block: unknown = parsed[mode]
    if (block === undefined) continue
    if (block === null || typeof block !== 'object' || Array.isArray(block)) {
      warnings.push(`refused "${mode}": expected an object`)
      continue
    }
    const out: Record<string, string | null> = {}
    for (const [slug, value] of Object.entries(block as Record<string, unknown>)) {
      if (!THEME_TOKENS.includes(slug)) {
        warnings.push(`refused unknown token "${slug}" (${mode})`)
        continue
      }
      if (value === null) {
        out[slug] = null
        continue
      }
      if (typeof value !== 'string' || !isValidTokenValue(slug, value)) {
        warnings.push(`refused "${slug}" (${mode}): ${JSON.stringify(value)}`)
        continue
      }
      out[slug] = value.trim()
    }
    if (Object.keys(out).length > 0) patch[mode] = out
  }
  return { patch, warnings }
}

/**
 * Apply a patch to a theme file's text, returning the new text.
 *
 * Per key per mode, never a replace: the file may carry tokens this pane did
 * not touch, and a vault's theme is as likely to have been written by hand or
 * by the agent as by these controls.
 */
export function applyThemePatch(json: string | null, patch: ThemePatch): string {
  const current = json === null ? null : parseVaultTheme(json)
  const next: Record<string, unknown> = { ...(current ?? {}) }
  next.$schema ??= 'holi-theme/v1'

  for (const mode of ['light', 'dark'] as const) {
    const edits = patch[mode]
    if (edits === undefined) continue
    const existing = next[mode]
    const block: Record<string, string> =
      existing !== null && typeof existing === 'object' && !Array.isArray(existing)
        ? { ...(existing as Record<string, string>) }
        : {}
    for (const [slug, value] of Object.entries(edits)) {
      if (value === null) delete block[slug]
      else block[slug] = value
    }
    next[mode] = block
  }

  // Both blocks always present, even when empty: the seeded skeleton has them,
  // the schema implies them, and a file that loses one reads as half-written.
  next.light ??= {}
  next.dark ??= {}
  return `${JSON.stringify(next, null, 2)}\n`
}
