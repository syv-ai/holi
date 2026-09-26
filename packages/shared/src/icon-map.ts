/**
 * `.holi/settings/icons.yaml` — the vault's per-path icon map, and the **only** place an
 * icon lives (D82).
 *
 * Rejected: `icon:` in a note's frontmatter. It can only serve things that HAVE
 * frontmatter (not a folder, not a PDF, and not `CLAUDE.md`/`AGENTS.md`, where
 * frontmatter becomes prompt text), and two mechanisms with a precedence rule
 * cost more than they were worth.
 *
 * Its layering is the theme's (D64): the committed file is shared with everyone
 * who clones the vault, and a local-only `icons.local.yaml` beside it overrides
 * it **per key**.
 *
 * **A path-keyed map can rot**, and that is accepted: a file moved by an agent
 * or a terminal leaves an entry behind, which degrades to "no icon", never to
 * lost content.
 */
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'
import { vaultRelPath } from './path-safety'

/** The committed icon map. Rides the normal watcher/snapshot path. */
export const ICONS_FILE = '.holi/settings/icons.yaml'
/** The personal override, local-only (`*.local.*`) like `theme.local.css`. */
export const ICONS_LOCAL_FILE = '.holi/settings/icons.local.yaml'

/**
 * Exactly one emoji, in the forms a keyboard or picker actually produces:
 * `RGI_Emoji` covers ZWJ sequences (👩‍💻), skin-tone modifiers (👍🏽), regional
 * indicator pairs (🇩🇰) and keycaps (#️⃣) as single units, where a plain
 * `\p{Emoji}` would match the bare digit in `1` and split the rest.
 *
 * Built with `new RegExp` rather than a literal on purpose: the `v` flag is
 * ES2024 and this package targets ES2022, so TypeScript rejects the literal
 * form. Every runtime that loads this (Node and Electron's Chromium) supports it.
 */
const ONE_EMOJI = new RegExp('^\\p{RGI_Emoji}$', 'v')

/**
 * A lone pictograph, with or without a selector after it.
 *
 * RGI says a bare text-presentation character (❤, ⚙) is not an emoji, but it
 * is one to whoever typed it, and copying a symbol out of a web page produces
 * the bare form. `Extended_Pictographic` holds no letter, digit or punctuation,
 * so this widens the rule without letting a word in; the single-character
 * anchor keeps a sentence out.
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
 * So testing only the literal value would refuse the picker's star. Trying the
 * value with its selectors stripped catches the first class without loosening
 * anything: what is left still has to match RGI on its own.
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
  /** What was dropped and why. Surfaced rather than swallowed, so an icon never
   *  silently fails to appear. */
  warnings: string[]
}

/** Parse one file. Anything that is not a YAML mapping reads as "no entries":
 *  a half-written file must not throw a vault scan. */
function parseMap(json: string | null): Record<string, unknown> {
  if (json === null || json.trim() === '') return {}
  try {
    const parsed: unknown = parseYaml(json)
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
 * The committed map with one path set or cleared, as YAML text ready to write.
 *
 * Keys come out **normalized and sorted**: sorted so the committed diff does
 * not churn, normalized so `Clients` and `Clients/` cannot both claim one
 * folder. A key that cannot be normalized is left exactly as it is rather than
 * dropped: this function edits one entry.
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
  // Rewritten whole rather than merged into the existing document, because
  // keeping the old node order would defeat the sort. Hand-written comments in
  // the file do not survive.
  return stringifyYaml(sorted, { lineWidth: 0 })
}
