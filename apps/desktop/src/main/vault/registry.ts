/**
 * The vault registry: which repos this machine has cloned, and where.
 *
 * Machine-local by design (auth PRD FR-9). It is not an account fact and must
 * never be synced — a second laptop starts empty and adds its own vaults. The
 * identity of a vault is its `remote`; `path` is just where this machine put it.
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { VaultEntry } from '@holi/shared'

/**
 * The managed vault root: `~/Holi`, and every clone sits at `<root>/owner/repo`.
 *
 * `homedir()` rather than Electron's `app.getPath('home')` — they agree, and
 * this module is reached by the test suite, which must never load Electron.
 *
 * `HOLI_VAULT_ROOT` overrides it, and that is a necessity rather than a feature:
 * without it every `electron-vite dev` run and every headless test would clone
 * into the user's real `~/Holi`, beside their real vaults.
 */
export function vaultRoot(): string {
  // An empty override is treated as absent. `join('', 'syv/notes')` is a
  // relative path, which would put vaults wherever the process happens to be.
  return process.env['HOLI_VAULT_ROOT'] || join(homedir(), 'Holi')
}

/** `owner/repo`, the form the GitHub API and `git clone` both speak. */
const REMOTE_RE = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/

export function isRemote(value: string): boolean {
  // Guard the separator cases the regex would otherwise wave through: a leading,
  // trailing or doubled slash still has two non-empty-looking sides to a lazy
  // check, and the value ends up in a filesystem path.
  return REMOTE_RE.test(value) && !value.includes('..')
}

export function repoName(remote: string): string {
  return remote.slice(remote.indexOf('/') + 1)
}

/** Where a remote is cloned under the managed root. */
export function clonePathFor(root: string, remote: string): string {
  if (!isRemote(remote)) throw new Error(`not an owner/repo remote: ${remote}`)
  return join(root, ...remote.split('/'))
}

export class VaultRegistry {
  #file: string
  #entries: VaultEntry[] | null = null

  constructor(file: string) {
    this.#file = file
  }

  async list(): Promise<VaultEntry[]> {
    if (this.#entries === null) this.#entries = await this.#read()
    // Most-recently-opened first: the switcher's order, and "your last vault" on
    // launch is just the head of this list.
    return [...this.#entries].sort((a, b) => b.lastOpenedAt.localeCompare(a.lastOpenedAt))
  }

  async add(entry: VaultEntry): Promise<VaultEntry[]> {
    const entries = (await this.list()).filter((e) => e.remote !== entry.remote)
    this.#entries = [...entries, entry]
    await this.#write()
    return this.list()
  }

  async remove(remote: string): Promise<VaultEntry[]> {
    this.#entries = (await this.list()).filter((e) => e.remote !== remote)
    await this.#write()
    return this.list()
  }

  async touch(remote: string, at: string): Promise<void> {
    const entries = await this.list()
    const entry = entries.find((e) => e.remote === remote)
    if (!entry) return
    this.#entries = entries.map((e) => (e.remote === remote ? { ...e, lastOpenedAt: at } : e))
    await this.#write()
  }

  async #read(): Promise<VaultEntry[]> {
    const text = await readFile(this.#file, 'utf8').catch(() => null)
    if (text === null) return []
    try {
      const raw: unknown = JSON.parse(text)
      // A corrupt registry must not brick the app into a blank vault list with
      // no way back: drop what does not parse and keep what does.
      return Array.isArray(raw) ? raw.filter(isEntry) : []
    } catch {
      return []
    }
  }

  async #write(): Promise<void> {
    await mkdir(dirname(this.#file), { recursive: true })
    const tmp = `${this.#file}.tmp`
    await writeFile(tmp, JSON.stringify(this.#entries ?? [], null, 2) + '\n', 'utf8')
    await rename(tmp, this.#file)
  }
}

function isEntry(value: unknown): value is VaultEntry {
  if (value === null || typeof value !== 'object') return false
  const e = value as Record<string, unknown>
  return (
    typeof e.remote === 'string' &&
    isRemote(e.remote) &&
    typeof e.path === 'string' &&
    typeof e.name === 'string' &&
    typeof e.lastOpenedAt === 'string'
  )
}
