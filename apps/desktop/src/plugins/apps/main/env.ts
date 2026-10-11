/**
 * An app's secrets: the vault's `.env`, with `.env.local` winning, read fresh
 * on each call so a hand edit applies at once. An app gets only the names its
 * `app.yaml` lists under `env` (docs/features/vault-apps.md). Holi never
 * writes these files: they are the person's, and local (`isSecretPath`).
 *
 * No `electron` import: this loads under plain Node in the tests.
 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { CapabilityError, cap, paramsObject, stringParam } from '../../../main/plugin-api'
import { ENV_NAME } from '../shared/manifest'
import { manifestOf } from './grants'

/** The files read, later ones winning. */
const ENV_FILES = ['.env', '.env.local'] as const

/**
 * `KEY=value` lines, as dotenv writes them: blank lines and `#` comments
 * skipped, an optional `export `, a value in single or double quotes kept as
 * is (a double-quoted `\n` is a newline), an unquoted one trimmed and cut at
 * ` #`.
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

export const ENV_NAMESPACES = ['env'] as const

export const envCapabilities = () => ({
  /** One secret the calling app declared, or null when the vault has no
   *  value for it. The app door only: the agent reads files itself. */
  'env.get': cap({
    doors: ['app'],
    params: (raw) => {
      const name = stringParam(paramsObject(raw), 'name')
      if (!ENV_NAME.test(name)) throw new CapabilityError('BAD_REQUEST', `not a name: ${name}`)
      return { name }
    },
    run: async (ctx, { name }): Promise<string | null> => {
      const bundle = ctx.bundle
      if (bundle === null || bundle === undefined) {
        throw new CapabilityError('FORBIDDEN', 'only an app has secrets')
      }
      const declared = (await manifestOf(ctx.root, bundle))?.env ?? []
      if (!declared.includes(name)) {
        throw new CapabilityError('FORBIDDEN', `${name} is not in this app's env in app.yaml`)
      }
      return (await readVaultEnv(ctx.root))[name] ?? null
    },
  }),
})
