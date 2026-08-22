/**
 * `.holi/icons.json` — the vault's per-path icon map, and the **only** place an
 * icon lives (D82).
 *
 * A note's own frontmatter was tried first and dropped: `icon:` in a note
 * travels with the file, which is genuinely better for a note, but it can only
 * serve things that HAVE frontmatter — not a folder, not a PDF, and not
 * `CLAUDE.md`/`AGENTS.md`, which are read verbatim as the agent's instructions,
 * so frontmatter there becomes prompt text. Local-only markdown could not carry
 * one either, since the scan files it outside `docs`. Two mechanisms with a
 * precedence rule between them cost more to explain than the travelling
 * property was worth, so there is one.
 *
 * Its layering is the theme's (D64): `.holi/icons.json` is committed and shared
 * with everyone who clones the vault, and a gitignored `.holi/icons.local.json`
 * overrides it **per key**, so a one-line personal file changes one entry and
 * inherits the rest.
 *
 * **A path-keyed map can rot**, and that is accepted rather than answered: a
 * file moved by an agent or a terminal leaves an entry behind, but it degrades
 * to "no icon", never to lost content — and refusing to let anyone icon a
 * folder to avoid a cosmetic staleness is the worse trade.
 */
import { vaultRelPath } from './path-safety'

/** The committed icon map — rides the normal watcher/snapshot path. */
export const ICONS_FILE = '.holi/icons.json'
/** The personal override — gitignored (`*.local.*`), like `theme.local.json`. */
export const ICONS_LOCAL_FILE = '.holi/icons.local.json'

/**
 * Exactly one emoji, in the forms a keyboard or picker actually produces:
 * `RGI_Emoji` covers ZWJ sequences (👩‍💻), skin-tone modifiers (👍🏽), regional
 * indicator pairs (🇩🇰) and keycaps (#️⃣) as single units, where a plain
 * `\p{Emoji}` would match the bare digit in `1` and split the rest.
 *
 * Built with `new RegExp` rather than a literal on purpose: the `v` flag is
 * ES2024 and this package targets ES2022, so TypeScript rejects the literal
 * form. Every runtime that loads this — Node 24 for the main process and tests,
 * Chromium 140 in Electron 43 for the renderer — supports it.
 */
const ONE_EMOJI = new RegExp('^\\p{RGI_Emoji}$', 'v')

/**
 * A lone pictograph, with or without a selector after it.
 *
 * RGI is strictly correct that a bare text-presentation character (❤, ⚙)
 * is not an emoji — but it is one to whoever typed it, and copying a symbol
 * out of a web page is enough to produce the bare form. Refusing it in
 * silence is the same failure as refusing the picker's star, so the bar here
 * is what the person meant rather than what the registry ratified.
 *
 * `Extended_Pictographic` is the safe way to say that: it holds no letter,
 * digit or punctuation, so this widens the rule without letting a word in.
 * The single-character anchor is what keeps a sentence out.
 */
const ONE_PICTOGRAPH = /^\p{Extended_Pictographic}\ufe0f?$/u

/**
 * Whether a value is a single emoji, in either spelling a keyboard produces.
 *
 * Emoji split in two here, and RGI holds exactly one spelling of each:
 *
 *   - **emoji-presentation by default** (⭐ ✅ ⚡ and every pictograph): RGI has
 *     the bare form, and `U+2B50 U+FE0F` is NOT in the set, the selector being
 *     redundant. The macOS picker emits it anyway.
 *   - **text-presentation by default** (❤️ ▶️ ☑️): RGI has the `…U+FE0F` form,
 *     and the bare character is a dingbat rather than an emoji.
 *
 * So one test cannot cover both, and testing only the literal value is what
 * made picking a star from the palette leave the note on its markdown glyph.
 * Trying the value with its selectors stripped catches the first class without
 * loosening anything: stripping cannot turn a non-emoji into an emoji, since
 * what is left still has to match RGI on its own.
 */
export function isOneEmoji(value: string): boolean {
  return (
    ONE_EMOJI.test(value) ||
    ONE_EMOJI.test(value.replace(/\ufe0f/g, '')) ||
    ONE_PICTOGRAPH.test(value)
  )
}


export interface ResolvedIconMap {
  /** Vault-relative path → a single emoji. Only valid entries survive. */
  icons: Record<string, string>
  /** What was dropped and why. Surfaced rather than swallowed: an icon that
   *  silently does not appear is the bug this feature already shipped once. */
  warnings: string[]
}

/** Parse one file. Anything that is not a JSON object reads as "no entries" —
 *  a half-written file must not throw a vault scan. */
function parseMap(json: string | null): Record<string, unknown> {
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

/** Resolve the committed map under its personal override. Never throws. */
export function resolveIconMap(
  committedJson: string | null,
  localJson: string | null,
): ResolvedIconMap {
  const warnings: string[] = []
  const icons: Record<string, string> = {}

  // Local last, so it overrides the shared map key by key rather than replacing
  // it wholesale.
  for (const raw of [parseMap(committedJson), parseMap(localJson)]) {
    for (const [key, value] of Object.entries(raw)) {
      // The same normalization every other vault path gets: a trailing slash on
      // a folder and a leading `./` both name the thing they look like, and a
      // key reaching outside the vault is refused rather than resolved.
      let path: string
      try {
        path = vaultRelPath(key)
      } catch {
        warnings.push(`dropped unusable path "${key}"`)
        continue
      }
      if (typeof value !== 'string' || !isOneEmoji(value)) {
        warnings.push(`dropped "${key}": not a single emoji`)
        continue
      }
      icons[path] = value
    }
  }

  return { icons, warnings }
}

/**
 * The committed map with one path set or cleared, as JSON text ready to write.
 *
 * Pure so the "Edit icon" gesture is testable without a filesystem: the caller
 * reads `.holi/icons.json`, hands the text here, and writes what comes back.
 *
 * Keys come out **normalized and sorted**. Sorted because this file is
 * committed and a map whose order followed the order things were iconed would
 * churn the diff for no reason; normalized because two spellings of one path
 * (`Clients` and `Clients/`) must not both sit in the file claiming the same
 * folder. A key that cannot be normalized is left exactly as it is rather than
 * dropped — this function edits one entry, and silently deleting a line
 * someone hand-wrote is not editing.
 */
export function withIcon(json: string | null, path: string, emoji: string | null): string {
  const raw = parseMap(json)
  const rel = vaultRelPath(path)

  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(raw)) {
    let normalized: string
    try {
      normalized = vaultRelPath(key)
    } catch {
      out[key] = value
      continue
    }
    if (normalized !== rel) out[normalized] = value
  }

  if (emoji !== null) {
    if (!isOneEmoji(emoji)) throw new Error(`not a single emoji: ${JSON.stringify(emoji)}`)
    out[rel] = emoji
  }

  const sorted: Record<string, unknown> = {}
  for (const key of Object.keys(out).sort()) sorted[key] = out[key]
  return `${JSON.stringify(sorted, null, 2)}\n`
}
