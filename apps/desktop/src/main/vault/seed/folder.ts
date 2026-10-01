/**
 * A contribution's seed folder, turned into its `once` and `shipped` tables.
 *
 * A contributor keeps the files it seeds as real files under `vault/once/**`
 * and `vault/shipped/**` beside its module, at the path they get in the vault,
 * and hands this function two eager `import.meta.glob`s over that folder: the
 * text files as `?raw`, the binaries as `?inline`. The globs must be written
 * in the contributor's own module, because Vite resolves them statically and
 * relative to the file they are in:
 *
 * ```ts
 * seedFolder(
 *   import.meta.glob(['./vault/**', '!**\/*.{ttf,png}', '!**\/.DS_Store'],
 *     { query: '?raw', import: 'default', eager: true, exhaustive: true }),
 *   import.meta.glob('./vault/**\/*.{ttf,png}',
 *     { query: '?inline', import: 'default', eager: true, exhaustive: true }),
 * )
 * ```
 *
 * `exhaustive: true` is what lets the glob see `.holi/` and `.claude/`, which
 * it skips otherwise. `?inline` is a base64 data URL in both the build and
 * the tests, decoded here to the file's exact bytes.
 */
export function seedFolder(
  raw: Record<string, unknown>,
  inline: Record<string, unknown> = {},
): { once: Record<string, string | Uint8Array>; shipped: Record<string, string> } {
  const once: Record<string, string | Uint8Array> = {}
  const shipped: Record<string, string> = {}

  for (const [key, text] of Object.entries(raw)) {
    if (typeof text !== 'string') throw new Error(`seed file ${key} is not text`)
    const { kind, rel } = place(key)
    if (kind === 'once') once[rel] = text
    else shipped[rel] = text
  }
  for (const [key, url] of Object.entries(inline)) {
    const { kind, rel } = place(key)
    // A shipped file is 3-way merged on update, which only text can be.
    if (kind === 'shipped') throw new Error(`shipped seed file ${key} must be text`)
    once[rel] = decodeDataUrl(key, url)
  }
  return { once, shipped }
}

/** `./vault/once/.holi/vault` -> once, `.holi/vault`. */
function place(key: string): { kind: 'once' | 'shipped'; rel: string } {
  const match = /^\.\/vault\/(once|shipped)\/(.+)$/.exec(key)
  if (!match) throw new Error(`seed file ${key} is not under vault/once/ or vault/shipped/`)
  return { kind: match[1] as 'once' | 'shipped', rel: match[2]! }
}

function decodeDataUrl(key: string, url: unknown): Uint8Array {
  const comma = typeof url === 'string' ? url.indexOf(',') : -1
  if (typeof url !== 'string' || !url.startsWith('data:') || comma < 0) {
    throw new Error(`seed file ${key} did not inline as a data URL`)
  }
  if (!url.slice(0, comma).endsWith(';base64')) {
    throw new Error(`seed file ${key} inlined as text, not base64`)
  }
  return Buffer.from(url.slice(comma + 1), 'base64')
}
