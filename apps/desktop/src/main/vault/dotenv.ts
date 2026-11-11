/**
 * A vault's secrets: its `.env`, with `.env.local` winning, read fresh on each
 * call so a hand edit applies at once. Holi never writes these files: they
 * are the person's, and local (`isSecretPath`). Vault apps get the names
 * their `app.yaml` declares (`holi.env`); a plugin's main side reads the key
 * it needs (Transcribe's `SYV_API_KEY`).
 *
 * No `electron` import: this loads under plain Node in the tests.
 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

/** The files read, later ones winning. */
const ENV_FILES = ['.env', '.env.local'] as const

/**
 * `KEY=value` lines, as dotenv writes them: blank lines and `#` comments
 * skipped, an optional `export `, a value in single or double quotes kept as
 * is (a double-quoted `\n` is a newline), an unquoted one trimmed and cut at
 * ` #`.
 * @public exported for its test
 */
export function parseDotenv(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line)
    if (m === null) continue
    const [, key, rest] = m as unknown as [string, string, string]
    const quote = rest[0]
    if (quote === '"' || quote === "'") {
      const end = rest.indexOf(quote, 1)
      const inner = end === -1 ? rest.slice(1) : rest.slice(1, end)
      out[key] = quote === '"' ? inner.replace(/\\n/g, '\n') : inner
    } else {
      out[key] = rest.replace(/\s+#.*$/, '').trim()
    }
  }
  return out
}

/** The vault's secrets, `.env.local` over `.env`. */
export async function readVaultEnv(root: string): Promise<Record<string, string>> {
  const merged: Record<string, string> = {}
  for (const file of ENV_FILES) {
    const text = await readFile(join(root, file), 'utf8').catch(() => null)
    if (text !== null) Object.assign(merged, parseDotenv(text))
  }
  return merged
}
