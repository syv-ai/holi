/**
 * Who said yes to running which code (docs/features/community-plugins.md).
 *
 * A community plugin runs with the person's own permissions on this machine,
 * so nothing of a release is set up or served until they have agreed to that
 * commit of it, after a dialog naming the repository, the commit and the
 * commands. A different commit (an update, or a teammate's newer pin) has no
 * record and asks again. There is no expiry: an installed plugin is installed.
 * A dev folder is the person's own checkout and asks nothing.
 *
 * No `electron` import: this loads under plain Node in the tests.
 */
import { jsonFileStore } from '../../../main/plugin-api'

export interface ConsentStore {
  has(id: string, commit: string): Promise<boolean>
  grant(id: string, commit: string): Promise<void>
  /** Forget every commit of `id`, when it is removed from this machine. */
  forget(id: string): Promise<void>
}

const keyOf = (id: string, commit: string) => `${id}@${commit}`

export function createConsentStore(path: string, now = () => Date.now()): ConsentStore {
  const file = jsonFileStore(path, (raw): Record<string, number> =>
    typeof raw === 'object' && raw !== null && !Array.isArray(raw)
      ? Object.fromEntries(
          Object.entries(raw).filter((e): e is [string, number] => typeof e[1] === 'number'),
        )
      : {},
  )
  return {
    has: async (id, commit) => keyOf(id, commit) in (await file.read()),
    grant: async (id, commit) => {
      await file.update((all) => ({ ...all, [keyOf(id, commit)]: now() }))
    },
    forget: async (id) => {
      await file.update((all) =>
        Object.fromEntries(Object.entries(all).filter(([k]) => !k.startsWith(`${id}@`))),
      )
    },
  }
}
