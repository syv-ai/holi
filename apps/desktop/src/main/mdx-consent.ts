import { randomUUID } from 'node:crypto'
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises'
import { dirname } from 'node:path'

const VERSION = 1
const PURPOSE = 'mdx-dependency-diagnostics' as const

export interface MdxConsentScope {
  origin: string
  root: string
  remote: string
  accountId: string
}

export interface MdxConsentStore {
  allows(scope: MdxConsentScope): Promise<boolean>
  grant(scope: MdxConsentScope): Promise<void>
  revoke(scope: MdxConsentScope): Promise<void>
}

type State = { version: 1; grants: MdxConsentScope[] }

/** Machine-local, fail-closed grants for one canonical HTTPS origin and Holi identity. */
export function createMdxConsentStore(file: string): MdxConsentStore {
  let queue = Promise.resolve()
  let denied = new Set<string>()
  const key = (scope: MdxConsentScope) =>
    JSON.stringify([scope.origin, PURPOSE, scope.root, scope.remote, scope.accountId])

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
    if (
      grants.some(
        (g) =>
          !g ||
          typeof g.origin !== 'string' ||
          typeof g.root !== 'string' ||
          typeof g.remote !== 'string' ||
          typeof g.accountId !== 'string',
      )
    )
      throw new Error('MDX consent state is corrupt')
    return { version: VERSION, grants }
  }
  const persist = async (state: State) => {
    await mkdir(dirname(file), { recursive: true })
    const temp = `${file}.${randomUUID()}.tmp`
    try {
      const handle = await open(temp, 'wx', 0o600)
      try {
        await handle.writeFile(JSON.stringify(state))
        await handle.sync()
      } finally {
        await handle.close()
      }
      await rename(temp, file)
    } finally {
      await rm(temp, { force: true })
    }
  }
  return {
    allows: (scope) =>
      transact(async () => {
        if (denied.has(key(scope))) return false
        try {
          return (await read()).grants.some((grant) => key(grant) === key(scope))
        } catch {
          return false
        }
      }),
    grant: (scope) =>
      transact(async () => {
        if (
          scope.origin !== new URL(scope.origin).origin ||
          new URL(scope.origin).protocol !== 'https:' ||
          !scope.accountId ||
          !scope.root ||
          !scope.remote
        )
          throw new Error('Invalid MDX consent scope')
        const id = key(scope)
        denied.add(id)
        const state = await read()
        if (!state.grants.some((grant) => key(grant) === id)) state.grants.push(scope)
        await persist(state)
        denied.delete(id)
      }),
    revoke: (scope) => {
      denied.add(key(scope))
      return transact(async () => {
        const state = await read()
        state.grants = state.grants.filter((grant) => key(grant) !== key(scope))
        await persist(state)
      })
    },
  }
}
