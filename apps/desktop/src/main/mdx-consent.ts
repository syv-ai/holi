import { randomUUID } from 'node:crypto'
import { renameSync } from 'node:fs'
import { mkdir, open, readFile, rm } from 'node:fs/promises'
import { dirname } from 'node:path'
import { MDX_RESOURCE_PURPOSE } from '@holi/shared'

const VERSION = 1

/** The trusted main caller supplies the canonical vault root, remote and verified account. */
export interface MdxConsentScope {
  origin: string
  root: string
  remote: string
  accountId: string
}

export interface MdxConsentStore {
  allows(scope: MdxConsentScope): Promise<boolean>
  listOrigins(owner: Omit<MdxConsentScope, 'origin'>): Promise<string[]>
  /** Pass a synchronous lifetime check for a document-bound approval. A retired approval rejects. */
  grant(scope: MdxConsentScope, stillOwned?: () => boolean): Promise<void>
  revoke(scope: MdxConsentScope): Promise<void>
}

type State = { version: 1; grants: MdxConsentScope[] }

function validScope(value: unknown): value is MdxConsentScope {
  if (!value || typeof value !== 'object') return false
  const { origin, root, remote, accountId } = value as Partial<MdxConsentScope>
  if (
    typeof origin !== 'string' ||
    typeof root !== 'string' ||
    typeof remote !== 'string' ||
    typeof accountId !== 'string' ||
    !root ||
    !remote ||
    !accountId
  )
    return false
  try {
    const url = new URL(origin)
    return url.protocol === 'https:' && url.origin === origin
  } catch {
    return false
  }
}

/** Machine-local, fail-closed HTTPS grants. Main keeps one store instance per file. */
export function createMdxConsentStore(file: string): MdxConsentStore {
  let queue = Promise.resolve()
  const denied = new Set<string>()
  const revocations = new Map<string, symbol>()
  const key = (scope: MdxConsentScope) =>
    JSON.stringify([scope.origin, MDX_RESOURCE_PURPOSE, scope.root, scope.remote, scope.accountId])

  const transact = <T>(work: () => Promise<T>): Promise<T> => {
    const result = queue.then(work)
    queue = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }
  const read = async (): Promise<State> => {
    let raw: string
    try {
      raw = await readFile(file, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT')
        return { version: VERSION, grants: [] }
      throw error
    }
    let value: unknown
    try {
      value = JSON.parse(raw)
    } catch {
      throw new Error('MDX consent state is corrupt')
    }
    if (
      !value ||
      typeof value !== 'object' ||
      (value as State).version !== VERSION ||
      !Array.isArray((value as State).grants)
    )
      throw new Error('MDX consent state version is unsupported')
    const grants = (value as State).grants
    if (!grants.every(validScope)) throw new Error('MDX consent state is corrupt')
    return { version: VERSION, grants }
  }
  const persist = async (state: State, beforePublish?: () => void) => {
    await mkdir(dirname(file), { recursive: true })
    const temp = `${file}.${randomUUID()}.tmp`
    const handle = await open(temp, 'wx', 0o600)
    try {
      try {
        await handle.writeFile(JSON.stringify(state))
        await handle.sync()
      } finally {
        await handle.close()
      }
      // A queued asynchronous rename could run after ownership expires.
      beforePublish?.()
      renameSync(temp, file)
    } catch (error) {
      await rm(temp, { force: true }).catch(() => undefined)
      throw error
    }
  }
  return {
    async allows(scope) {
      if (!validScope(scope)) return false
      const id = key(scope)
      return transact(async () => {
        if (denied.has(id)) return false
        try {
          const state = await read()
          return !denied.has(id) && state.grants.some((grant) => key(grant) === id)
        } catch {
          return false
        }
      })
    },
    listOrigins(owner) {
      return transact(async () => {
        const { grants } = await read()
        return [
          ...new Set(
            grants.flatMap((grant) => {
              if (key({ ...owner, origin: grant.origin }) !== key(grant) || denied.has(key(grant)))
                return []
              return [grant.origin]
            }),
          ),
        ].sort()
      })
    },
    async grant(scope, stillOwned) {
      if (!validScope(scope)) throw new Error('Invalid MDX consent scope')
      const { origin, root, remote, accountId } = scope
      const id = key(scope)
      const revocation = revocations.get(id)
      const assertCurrent = () => {
        if (stillOwned && stillOwned() !== true) throw new Error('MDX consent owner changed')
        if (revocations.get(id) !== revocation) throw new Error('MDX consent was revoked')
      }
      return transact(async () => {
        assertCurrent()
        denied.add(id)
        const state = await read()
        if (!state.grants.some((grant) => key(grant) === id)) {
          state.grants.push({ origin, root, remote, accountId })
        }
        await persist(state, assertCurrent)
        // Revoke denies immediately, even if it arrives just after publication.
        if (revocations.get(id) === revocation) denied.delete(id)
      })
    },
    async revoke(scope) {
      if (!validScope(scope)) throw new Error('Invalid MDX consent scope')
      const id = key(scope)
      revocations.set(id, Symbol())
      denied.add(id)
      return transact(async () => {
        const state = await read()
        state.grants = state.grants.filter((grant) => key(grant) !== id)
        await persist(state)
      })
    },
  }
}
