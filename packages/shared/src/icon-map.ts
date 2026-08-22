/**
 * `.holi/icons.json` — the vault's per-path icon map.
 *
 * The note-level mechanism (`noteIcon`, D82) puts an icon in the note's own
 * frontmatter, which is right because it travels with the file. But it can only
 * serve things that *have* frontmatter, and three kinds of thing do not: the
 * agent-surface files, where frontmatter would become prompt text
 * (`CLAUDE.md`/`AGENTS.md` are read verbatim as instructions); local-only
 * markdown like `USER.local.md`, which the scan keeps out of `docs` entirely so
 * there is no `DocMeta` to carry a field; and everything that is not markdown
 * at all — folders, PDFs, images.
 *
 * So this map is the second home, and **frontmatter wins where a note has one**:
 * the note stays the owner of its own icon, and the map is the fallback for
 * everything that cannot own one.
 *
 * Its layering is the theme's (D64), for the same reason: `.holi/icons.json` is
 * committed and shared with everyone who clones the vault, and a gitignored
 * `.holi/icons.local.json` overrides it **per key**, so a one-line personal file
 * changes one entry and inherits the rest.
 *
 * **A path-keyed map can rot** — that is exactly why it was rejected for notes,
 * which get moved by agents and terminals that never tell Holi. The map is
 * allowed to name anything anyway: an entry whose file moved degrades to "no
 * icon", never to lost content, and refusing to let someone icon a folder to
 * avoid a cosmetic staleness is the worse trade.
 */
import { isOneEmoji } from './note-icon'
import { vaultRelPath } from './path-safety'

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
