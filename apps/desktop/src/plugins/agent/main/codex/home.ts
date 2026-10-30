/**
 * Codex's own folder for a run Holi starts unwatched or fenced
 * (`CODEX_HOME`, in the run's state folder; `index.ts` says which runs).
 *
 * **Why a folder of its own.** Codex reads its MCP servers, plugins, skills
 * and hooks out of `CODEX_HOME`, and a `-c mcp_servers={}` override does not
 * clear the servers its `config.toml` names (Codex 0.166.0 still lists them),
 * so the only way to run it without the person's tools is a home that has
 * none.
 *
 * **What it gets.** Only what signing in and choosing a model need:
 *
 * - `auth.json`, the person's, read through a symlink to what it names. Its
 *   text as handed over is kept beside the home (`AUTH_GIVEN`), so a token
 *   Codex refreshed in the run goes back afterwards (`releaseCodexHome`).
 * - a `config.toml` of the person's model and provider keys alone
 *   (`KEPT_KEYS`, `model_providers` among them), with the sign-in read from
 *   that file (`cli_auth_credentials_store = "file"`). Everything else is
 *   dropped: MCP servers, profiles, plugins, skills, hooks, `notify`, trusted
 *   projects, the sandbox and approval keys (Holi sets its own), and the
 *   global `AGENTS.md`.
 *
 * With no `auth.json` and no API key in the environment there is no sign-in
 * to hand over (Codex may keep it in the keychain, whose entry is tied to
 * the home's path), and the run does not start: the message says how to sign
 * in so it can.
 *
 * No `electron` import: this loads under plain Node in the tests.
 */
import { mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { parse, stringify } from 'smol-toml'

/** The person's Codex folder: `CODEX_HOME`, else `~/.codex`. */
export const personCodexHome = (env: NodeJS.ProcessEnv = process.env): string =>
  env.CODEX_HOME !== undefined && env.CODEX_HOME !== '' ? env.CODEX_HOME : join(homedir(), '.codex')

/** The run's Codex folder, inside its state folder. */
const HOME = 'codex-home'
/** The `auth.json` as it was handed over, beside the home, never in it. */
const AUTH_GIVEN = 'codex-auth.given.json'

/** The keys of the person's `config.toml` a run keeps: which model, on which
 *  provider, how it reasons, and how it signs in. */
const KEPT_KEYS = [
  'model',
  'model_provider',
  'model_providers',
  'model_reasoning_effort',
  'model_reasoning_summary',
  'model_verbosity',
  'model_context_window',
  'model_auto_compact_token_limit',
  'forced_login_method',
  'forced_chatgpt_workspace_id',
  'chatgpt_base_url',
] as const

/** The environment variables that sign Codex in without an `auth.json`. */
const KEY_VARS = ['OPENAI_API_KEY', 'CODEX_API_KEY'] as const

/** A file's text, or null when it is not there. Anything else throws. */
function readOrNull(path: string): string | null {
  try {
    return readFileSync(path, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw err
  }
}

/**
 * The `config.toml` a run gets, out of the person's: `KEPT_KEYS` alone, and
 * the sign-in read from `auth.json`.
 * @public exported for its test
 */
export function runConfig(personToml: string | null): string {
  let person: Record<string, unknown> = {}
  if (personToml !== null) {
    try {
      person = parse(personToml)
    } catch {
      throw new Error(
        "Codex's config.toml is not TOML Holi can read, so the run did not start. Fix it, then try again.",
      )
    }
  }
  const kept: Record<string, unknown> = {}
  for (const key of KEPT_KEYS) if (person[key] !== undefined) kept[key] = person[key]
  return stringify({ ...kept, cli_auth_credentials_store: 'file' })
}

/**
 * Make (or refresh, for a follow-up turn) the run's Codex folder in `state`,
 * and return it: the person's sign-in and model settings, nothing else. Each
 * call hands over the person's `auth.json` as it is now.
 */
export function prepareCodexHome(state: string, env: NodeJS.ProcessEnv = process.env): string {
  const person = personCodexHome(env)
  const home = join(state, HOME)
  mkdirSync(home, { recursive: true, mode: 0o700 })
  let config: string | null
  let auth: string | null
  try {
    config = readOrNull(join(person, 'config.toml'))
    auth = readOrNull(join(person, 'auth.json'))
  } catch {
    throw new Error(`Holi could not read Codex's folder (${person}), so the run did not start.`)
  }
  writeFileSync(join(home, 'config.toml'), runConfig(config), { mode: 0o600 })
  if (auth === null) {
    rmSync(join(home, 'auth.json'), { force: true })
    rmSync(join(state, AUTH_GIVEN), { force: true })
    if (!KEY_VARS.some((name) => (env[name] ?? '') !== '')) {
      throw new Error(
        `Holi runs Codex here with a folder of its own and hands it the sign-in in ${join(person, 'auth.json')}, and there is none: Codex may keep it in the keychain. Set cli_auth_credentials_store = "file" in Codex's config.toml, sign in again (codex login), then try again.`,
      )
    }
    return home
  }
  writeFileSync(join(home, 'auth.json'), auth, { mode: 0o600 })
  writeFileSync(join(state, AUTH_GIVEN), auth, { mode: 0o600 })
  return home
}

const isObject = (text: string): boolean => {
  try {
    const value: unknown = JSON.parse(text)
    return value !== null && typeof value === 'object' && !Array.isArray(value)
  } catch {
    return false
  }
}

/**
 * After a run's process exited: the sign-in Codex refreshed in it goes back
 * into the person's `auth.json` (through a symlink to what it names), but
 * only while theirs is still the one handed over. One that changed meanwhile
 * (another Codex refreshed it, or they signed in again) is newer and stands.
 * Never throws.
 */
export async function releaseCodexHome(
  state: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  try {
    const given = await readFile(join(state, AUTH_GIVEN), 'utf8').catch(() => null)
    const after = await readFile(join(state, HOME, 'auth.json'), 'utf8').catch(() => null)
    if (given === null || after === null || after === given || !isObject(after)) return
    const target = realpathSync(join(personCodexHome(env), 'auth.json'))
    if ((await readFile(target, 'utf8')) !== given) return
    const next = join(dirname(target), `.${basename(target)}.holi-${process.pid}`)
    await writeFile(next, after, { mode: 0o600 })
    await rename(next, target)
    // A follow-up turn compares against what the person's file now holds.
    await writeFile(join(state, AUTH_GIVEN), after, { mode: 0o600 })
  } catch {
    // The person's sign-in stays as it was; Codex refreshes it again.
  }
}
