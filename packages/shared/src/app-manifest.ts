/**
 * `app.yaml`: the file that makes a vault app real.
 *
 * An app is written file by file by an agent, and without a marker it would
 * register the moment its first byte lands, so a half-written app would appear
 * in the sidebar and open to a broken page. The manifest is written **last**,
 * and registration waits for it.
 *
 * YAML rather than JSON: it takes comments and does not fail on a trailing
 * comma, which matters for a file written unattended by a model.
 *
 * The parser is forgiving inside the mapping: a typo costs a field, never the
 * app, because an app that silently does not appear is the worst failure. Only
 * text that is not a mapping at all (a list, a number, a bare scalar) is refused.
 */
import { parse as parseYaml } from 'yaml'

/** The registration marker, at the app's own root. */
export const APP_MANIFEST_FILE = 'app.yaml'

export interface AppManifest {
  /** Free text, for the launchers. The name is the bundle's folder name,
   *  and the icon is the vault icon map's, as for any row. */
  description?: string
}

const KNOWN_KEYS = ['description'] as const

/**
 * Never throws. `{}` for an empty, comment-only, or malformed manifest; `null`
 * only when the document parses into something that is not a mapping.
 */
export function parseAppManifest(yaml: string): AppManifest | null {
  let raw: unknown
  try {
    raw = parseYaml(yaml)
  } catch {
    return {}
  }
  // An empty document parses to `null`, and so does the literal `null`. Both
  // are an empty manifest: the file existing is the assertion being made.
  if (raw === null || raw === undefined) {
    return yaml.trim() === '' || isCommentOnly(yaml) ? {} : null
  }
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
