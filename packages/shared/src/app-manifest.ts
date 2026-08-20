/**
 * `app.yaml` — the file that makes a vault app real.
 *
 * D74 rejected a manifest for slice 1 and was right to: nothing needed one, and
 * a `manifest.json` designed before a second field asked for it is a config
 * surface invented to be got wrong. This one has a different job. An app is
 * written file by file by an agent, and without a marker it registers the
 * moment its first byte lands — so a half-written app appears in the sidebar,
 * opens to a broken page, and the agent has no way to say "now". The manifest
 * is written **last**, and registration waits for it.
 *
 * YAML rather than JSON on purpose: the vault's task frontmatter is already
 * YAML, it takes comments, and it does not fail on a trailing comma — which
 * matters for a file whose only job is being written correctly, unattended, by
 * a model.
 *
 * The parser is deliberately forgiving in one direction and strict in the
 * other. A typo inside the mapping costs you the label; it never costs you the
 * app, because the failure mode slice 1 proved worst is an app that silently
 * does not appear. Only text that is not a mapping at all — a list, a number, a
 * bare scalar — is refused, and that is a file which is not a manifest.
 */
import { parse as parseYaml } from 'yaml'

/** The registration marker, at the app's own root. */
export const APP_MANIFEST_FILE = 'app.yaml'

export interface AppManifest {
  /** Display label. Defaults to the directory name at the call site; **never a
   *  second id** — the directory name is still the identity (D74). */
  name?: string
  /** A lucide icon name. Unknown or absent falls back to the default glyph. */
  icon?: string
  /** Free text, shown in the sidebar tooltip. */
  description?: string
}

const KNOWN_KEYS = ['name', 'icon', 'description'] as const

/**
 * Never throws. `{}` for an empty, comment-only, or malformed manifest; `null`
 * only when the document parses into something that is not a mapping.
 */
export function parseAppManifest(yaml: string): AppManifest | null {
  let raw: unknown
  try {
    // The same `yaml` parser `parseTaskFile` uses for frontmatter — one YAML
    // implementation in this package, not two that disagree at the margins.
    raw = parseYaml(yaml)
  } catch {
    return {}
  }
  // An empty document parses to `null`, and so does the literal `null`. Both
  // are an empty manifest: the file existing is the assertion being made.
  if (raw === null || raw === undefined) return yaml.trim() === '' || isCommentOnly(yaml) ? {} : null
  if (typeof raw !== 'object' || Array.isArray(raw)) return null

  const manifest: AppManifest = {}
  for (const key of KNOWN_KEYS) {
    const value = (raw as Record<string, unknown>)[key]
    if (typeof value === 'string') manifest[key] = value
  }
  return manifest
}

/** A file of nothing but comments parses to `null` like an empty one does, and
 *  means the same thing — the author wrote a manifest and left it blank. */
function isCommentOnly(yaml: string): boolean {
  return yaml.split('\n').every((line) => line.trim() === '' || line.trim().startsWith('#'))
}
