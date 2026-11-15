import { renameSync } from 'node:fs'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

const VERSION = 1 as const

interface MdxTrustOwner {
  accountId: string
  remote: string
}

export interface MdxTrustStore {
  status(owner: MdxTrustOwner): Promise<boolean>
  approve(owner: MdxTrustOwner, stillOwned?: () => boolean): Promise<void>
  revoke(owner: MdxTrustOwner, stillOwned?: () => boolean): Promise<void>
}

type State = { version: typeof VERSION; grants: string[] }

/** Canonicalize GitHub HTTPS/SSH remotes and owner/repo spellings to one key. */
export function canonicalGitHubRemote(value: string): string {
  const match =
    /^(?:(?:https?:\/\/github\.com\/)|(?:git@github\.com:))?([^/]+)\/([^/]+?)(?:\.git)?\/?$/i.exec(
      value.trim(),
    )
  if (!match || !/^[a-z0-9-]+$/i.test(match[1]!) || !/^[a-z0-9_.-]+$/i.test(match[2]!))
    throw new Error('Invalid GitHub vault remote')
  return `${match[1]!.toLowerCase()}/${match[2]!.replace(/\.git$/i, '').toLowerCase()}`
}

function ownerKey(owner: MdxTrustOwner): string {
  if (!/^[1-9]\d*$/.test(owner.accountId) || !Number.isSafeInteger(Number(owner.accountId)))
    throw new Error('Verified GitHub identity is required')
  return `${owner.accountId}:${canonicalGitHubRemote(owner.remote)}`
}

function validGrant(value: unknown): value is string {
  if (typeof value !== 'string') return false
  const [accountId, remote, extra] = value.split(':')
  if (accountId === undefined || remote === undefined || extra !== undefined) return false
  try {
    return ownerKey({ accountId, remote }) === value
  } catch {
    return false
  }
}

function parseState(value: unknown): State {
  if (
    typeof value !== 'object' ||
    value === null ||
    (value as { version?: unknown }).version !== VERSION ||
    !Array.isArray((value as { grants?: unknown }).grants) ||
    !(value as { grants: unknown[] }).grants.every(validGrant)
  )
    throw new Error('MDX trust state is unreadable or unsupported')
  return { version: VERSION, grants: [...new Set((value as { grants: string[] }).grants)] }
}

/** Machine-local, fail-closed grants. Mutations serialize and atomically replace state. */
export function createMdxTrustStore(file: string): MdxTrustStore {
  let queue: Promise<unknown> = Promise.resolve()
  async function read(): Promise<State> {
    let text: string
    try {
      text = await readFile(file, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT')
        return { version: VERSION, grants: [] }
      throw error
    }
    try {
      return parseState(JSON.parse(text) as unknown)
    } catch {
      throw new Error('MDX trust state is unreadable or unsupported')
    }
  }
  async function update(
    owner: MdxTrustOwner,
    add: boolean,
    stillOwned: () => boolean = () => true,
  ): Promise<void> {
    const key = ownerKey(owner)
    const run = async () => {
      const state = await read()
      const grants = new Set(state.grants)
      if (add) grants.add(key)
      else grants.delete(key)
      const next: State = { version: VERSION, grants: [...grants].sort() }
      await mkdir(dirname(file), { recursive: true })
      const temporary = `${file}.tmp`
      try {
        await writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
        if (!stillOwned()) throw new Error('MDX trust context changed')
        // Do not yield between the final ownership guard and the atomic commit.
        // An async rename can still be waiting in libuv after ownership expires.
        renameSync(temporary, file)
      } finally {
        await rm(temporary, { force: true }).catch(() => undefined)
      }
    }
    const pending = queue.then(run, run)
    queue = pending.catch(() => undefined)
    await pending
  }
  return {
    async status(owner) {
      return (await read()).grants.includes(ownerKey(owner))
    },
    approve: (owner, stillOwned) => update(owner, true, stillOwned),
    revoke: (owner, stillOwned) => update(owner, false, stillOwned),
  }
}
