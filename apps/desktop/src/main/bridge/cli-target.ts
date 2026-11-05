/** Registry-only CLI discovery; the displayed vault never supplies a default target. */
import { realpath } from 'node:fs/promises'
import { isAbsolute, relative, sep } from 'node:path'
import { isRemote, type VaultEntry } from '@holi/shared'
import type { VaultRegistry } from '../vault/registry'

interface CliTarget {
  /** The registry identity with its canonical clone path. */
  readonly entry: VaultEntry
  readonly live: boolean
}

interface CliTargetResolver {
  resolve(selector: string | null, cwd: string | null): Promise<CliTarget | null>
  list(): Promise<readonly { remote: string; name: string; live: boolean }[]>
}

function contains(root: string, path: string): boolean {
  const rest = relative(root, path)
  return rest === '' || (!isAbsolute(rest) && rest !== '..' && !rest.startsWith(`..${sep}`))
}

async function canonical(path: string): Promise<string | null> {
  if (!isAbsolute(path)) return null
  return realpath(path).catch(() => null)
}

/** Canonical paths preserve case on case-sensitive filesystems. */
export function createCliTargetResolver(
  registry: Pick<VaultRegistry, 'list'>,
  isLive: (remote: string, root: string) => boolean | Promise<boolean>,
): CliTargetResolver {
  async function entries() {
    return Promise.all(
      (await registry.list()).map(async (entry) => ({ entry, root: await canonical(entry.path) })),
    )
  }

  return {
    async resolve(selector, cwd) {
      if (selector !== null && !isRemote(selector))
        throw new Error('invalid vault selector; use owner/repo')
      const all = await entries()
      let matches: typeof all
      if (selector !== null) {
        matches = all.filter(({ entry }) => entry.remote.toLowerCase() === selector.toLowerCase())
      } else {
        if (cwd === null || !isAbsolute(cwd))
          throw new Error('physical cwd must be absolute; pass --vault owner/repo')
        const path = await canonical(cwd)
        if (path === null) throw new Error('physical cwd is unavailable; pass --vault owner/repo')
        matches = all.filter(({ root }) => root !== null && contains(root, path))
      }
      if (matches.length === 0) return null
      if (matches.length !== 1) throw new Error('ambiguous managed vault target')
      const { entry, root } = matches[0]!
      if (
        all.filter(({ entry: other }) => other.remote.toLowerCase() === entry.remote.toLowerCase())
          .length !== 1
      ) {
        throw new Error('ambiguous case-folded vault identities')
      }
      if (root === null) throw new Error('managed vault clone is unavailable')
      if (all.filter((other) => other.root === root).length !== 1)
        throw new Error('ambiguous canonical vault roots')
      return { entry: { ...entry, path: root }, live: await isLive(entry.remote, root) }
    },
    async list() {
      return Promise.all(
        (await entries()).map(async ({ entry, root }) => ({
          remote: entry.remote,
          name: entry.name,
          live: root !== null && (await isLive(entry.remote, root)),
        })),
      )
    },
  }
}
