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
 * Precedence: `.holi/settings/theme.yaml` (committed, shared) is the base; a personal
 * `.holi/settings/theme.local.yaml` (gitignored) overrides it **per key within each
 * mode**, so a one-line local file can recolour just `primary` and inherit the
 * rest. See the handoff/design notes for the decision trail.
 */

import { parse as parseYaml } from 'yaml'

/**
 * The two files a theme lives in, beside the settings they belong with.
 *
 * Declared here rather than in main, because the renderer names them too (the
 * settings pane offers both as an escape hatch) and main writes them. Three
 * copies of a path is three chances to move two of them.
 */
export const THEME_FILE = '.holi/settings/theme.css'
export const THEME_LOCAL_FILE = '.holi/settings/theme.local.css'

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
 * The two selectors a theme file may use, and the mode each names.
 *
 * **Exactly two, matched whole.** The file is real CSS and would behave as a
 * stylesheet if you pasted it into one, but this is a parser, not a cascade: it
 * has no business resolving specificity, so a block it does not recognise is
 * dropped with a warning rather than guessed at.
 */
const SELECTORS: Readonly<Record<string, ThemeMode>> = Object.freeze({
  "[data-theme='dark']": 'dark',
  '[data-theme="dark"]': 'dark',
  "[data-theme='light']": 'light',
  '[data-theme="light"]': 'light',
})

/** `/* … *\/` anywhere, including the generated vocabulary. Stripped before the
 *  blocks are read so a commented-out declaration stays commented out. */
const COMMENTS = /\/\*[\s\S]*?\*\//g

/** One `selector { … }`. Braces do not nest in a file this shape, and a nested
 *  one (`@media`, a nested rule) simply fails to match — which is the right
 *  answer, because the whitelist would refuse whatever was inside it anyway. */
const BLOCK = /([^{}]+)\{([^{}]*)\}/g

/** `--slug: value` — the only declaration shape a theme may carry. A plain
 *  property (`color: red`) does not match, which is the structural half of
 *  D64's promise surviving the move from YAML to CSS. */
const DECLARATION = /^\s*--([A-Za-z][A-Za-z0-9-]*)\s*:\s*(.+?)\s*$/

/**
 * Parse a theme file's text into a `VaultTheme`, or `null` if it holds no
 * recognisable block. Never throws — a broken file must degrade to "no theme",
 * not crash the read.
 *
 * **CSS, because a theme is a set of custom properties and always was.**
 * `themeBlockToVars` has always produced `--primary: #8b5cf6`; the file now says
 * the same thing in the same words. It also means the editor's colour picker —
 * `@replit/codemirror-css-color-picker`, which finds colours through the CSS
 * grammar and only the CSS grammar — works here without anything of ours.
 *
 * **This is a parser and NOT a stylesheet loader. The file is never injected.**
 * Every declaration is read, whitelisted and validated exactly as the YAML keys
 * were, and only the survivors reach the DOM. That was structurally obvious
 * when the file was data; in a file that looks like CSS it is a rule, so it is
 * written here in capitals: nothing in this module ever hands this text to the
 * document.
 */
export function parseVaultTheme(text: string): VaultTheme | null {
  const out: VaultTheme = {}
  let found = false
  const withoutComments = text.replace(COMMENTS, '')
  for (const [, selector, body] of withoutComments.matchAll(BLOCK)) {
    const mode = SELECTORS[selector!.trim()]
    if (mode === undefined) continue
    found = true
    const block: ThemeBlock = { ...(out[mode] ?? {}) }
    for (const line of body!.split(';')) {
      const m = DECLARATION.exec(line)
      if (m === null) continue
      block[m[1]!] = m[2]!
    }
    out[mode] = block
  }
  return found ? out : null
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
/** The renderer's patch object, or `null` if it is not one. Never throws. */
function parsePatchJson(json: string): VaultTheme | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    return null
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  return parsed as VaultTheme
}

export function parseThemePatch(json: string | null): { patch: ThemePatch; warnings: string[] } {
  const warnings: string[] = []
  const patch: ThemePatch = {}
  if (json === null || json.trim() === '') return { patch, warnings }

  // **JSON, not the file's own format.** This reads the patch the RENDERER
  // sends over IPC — `{dark: {primary: '#fff'}}` — which has nothing to do with
  // how the theme is stored. When the file became CSS, `parseVaultTheme` became
  // a CSS parser, and leaving this pointed at it would have made every write
  // from the settings pane parse as nothing: a pane whose controls silently did
  // nothing at all.
  const parsed = parsePatchJson(json)
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
 * Read a theme written in the OLD shape — `{light: {...}, dark: {...}}` as JSON
 * or YAML — and return it as `theme.css`.
 *
 * **Only the migration calls this, and it exists because the reader moved.**
 * `parseVaultTheme` speaks CSS now, so pointing the migration at it would have
 * read every pre-existing theme as empty and written a file full of commented
 * defaults — a vault silently losing its colours, with no error anywhere. The
 * old parse is nine lines; keeping them is cheaper than the bug.
 *
 * Whitelisting happens on the way through, so a token that was never valid is
 * dropped here rather than surviving the move.
 */
export function themeFromLegacy(text: string): string {
  let parsed: unknown
  try {
    parsed = parseYaml(text)
  } catch {
    parsed = null
  }
  const values: Record<string, unknown> = { $schema: undefined }
  for (const mode of ['light', 'dark'] as const) {
    const block =
      parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)[mode]
        : null
    const out: ThemeBlock = {}
    if (block !== null && typeof block === 'object' && !Array.isArray(block)) {
      for (const [slug, value] of Object.entries(block as Record<string, unknown>)) {
        if (
          typeof value === 'string' &&
          THEME_TOKENS.includes(slug) &&
          isValidTokenValue(slug, value)
        )
          out[slug] = value.trim()
      }
    }
    values[mode] = out
  }
  return writeThemeText(values)
}

/**
 * Apply a patch to a theme file's text, returning the new text.
 *
 * Per key per mode, never a replace: the file may carry tokens this pane did
 * not touch, and a vault's theme is as likely to have been written by hand or
 * by the agent as by these controls.
 */
/**
 * The theme file's text, written out in full every time.
 *
 * **The file lists every token, whether or not this vault sets one.** An empty
 * file was honest and useless: the vocabulary is forty tokens and the file named
 * none of them, so knowing what you could write meant opening the Appearance
 * pane or the `theme` skill. A token this vault has not set is a commented-out
 * declaration, in the group the pane puts it in.
 *
 * **Generated, not merged, and that is a deliberate reversal** of the rule
 * `app.yaml` still follows. A comment inside a block cannot survive a
 * round trip through a writer that rebuilds the block, and the commented
 * vocabulary IS comments — so re-emitting is what keeps the list complete and
 * current, including tokens added to the whitelist after this vault was made.
 * The cost is that a note written inside this file does not survive a write.
 *
 * A declaration that is not a known token is kept rather than dropped: the
 * resolver already warns about it, and silently deleting somebody's line
 * because we do not recognise it is a worse answer than leaving it alone.
 */
function writeThemeText(values: Record<string, unknown>): string {
  const lines: string[] = [
    '/*',
    ...PREAMBLE.map((line) => (line === '' ? ' *' : ` * ${line}`)),
    ' */',
  ]

  for (const mode of ['dark', 'light'] as const) {
    const block = (values[mode] ?? {}) as Record<string, string>
    lines.push('', `[data-theme='${mode}'] {`)
    for (const group of THEME_TOKEN_GROUPS) {
      lines.push('', `  /* ${group.title} — ${group.blurb} */`)
      for (const slug of group.tokens) {
        const note = THEME_TOKEN_NOTES[slug]
        if (note !== undefined) lines.push(`  /* ${note} */`)
        const value = block[slug]
        // Set and unset differ by the comment wrapper and nothing else, so
        // taking a token over is uncommenting the line.
        //
        // **Nothing written into a comment may contain a comment marker.**
        // The preamble first said "delete the slash-star and the star-slash"
        // using the characters themselves, which closed the comment early and
        // left the rest of the paragraph sitting in the file as CSS.
        lines.push(value === undefined ? `  /* --${slug}: ; */` : `  --${slug}: ${value};`)
      }
    }
    const unknown = Object.keys(block).filter((slug) => !THEME_TOKENS.includes(slug))
    if (unknown.length > 0) {
      lines.push('', '  /* Not tokens Holi knows. Kept as you wrote them; see the warnings. */')
      for (const slug of unknown) lines.push(`  --${slug}: ${block[slug]!};`)
    }
    lines.push('}')
  }
  return lines.join('\n') + '\n'
}

/** What the file says about itself, above the blocks. */
const PREAMBLE = [
  'This vault\u2019s theme.',
  '',
  'Every colour and chrome token it can set, grouped the way the Appearance',
  'pane groups them. A COMMENTED-OUT declaration is not set: Holi\u2019s own value',
  'is in force. Uncomment one to take it over.',
  '',
  'Real CSS, and the app reads it as DATA: every declaration is checked against',
  'a fixed whitelist before anything reaches the screen. That is why there is no',
  'token for spacing, size or position, and why a rule you add here for anything',
  'else has no effect \u2014 a theme cannot move or resize anything, by construction.',
  '',
  'Two blocks, one per colour scheme. Holi rewrites this file when a setting',
  'changes and regenerates these notes, so a comment of your own will not last.',
]

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
  // **The document, not the values.** A theme file carries the notes explaining
  // what each token paints, and a person or the agent may have added their own;
  // stringifying `next` would delete every one of them on the first swatch
  // anybody touched.
  return writeThemeText(next)
}
