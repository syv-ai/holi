import { join } from 'node:path'
import { createConsentStore } from './consent'
import { createSupervisor, type ServerState, type Supervisor } from './supervisor'
import { createInstallStore, type InstallStore } from './store'

/** Machine-owned community-plugin state shared by every open vault. */
export interface CommunityOwner {
  store: InstallStore
  consent: ReturnType<typeof createConsentStore>
  supervisor: Supervisor
  attach(
    root: string,
    remote: string,
    adapters: {
      emit(remote: string, name: string, payload: unknown): void
      frameOrigin(origin: string): () => void
    },
  ): () => Promise<void>
  mutate<T>(work: () => Promise<T>): Promise<T>
}

const owners = new Map<string, CommunityOwner>()

/** One installation, consent record, and server/port owner per machine profile. */
export function communityOwner(args: { userData: string }): CommunityOwner {
  const existing = owners.get(args.userData)
  if (existing) return existing
  // Kept explicit rather than derived from renderer state: a server's key names
  // the vault that started it, and its events/origin belong to that attachment.
  const attached = new Map<
    string,
    {
      remote: string
      emit: (remote: string, name: string, payload: unknown) => void
      frameOrigin(origin: string): () => void
    }
  >()
  let queue: Promise<unknown> = Promise.resolve()
  const owner: CommunityOwner = {
    store: createInstallStore(args.userData),
    consent: createConsentStore(join(args.userData, 'plugin-consent.json')),
    supervisor: createSupervisor({
      onState(key, state: ServerState) {
        const root = key.split('\0', 1)[0]!
        const attachment = attached.get(root)
        if (attachment) {
          const [, id, path] = key.split('\0')
          attachment.emit(attachment.remote, 'server', { id, path, state })
        }
      },
      frameOrigin(origin, key) {
        const root = key?.split('\0', 1)[0]
        const attachment = root === undefined ? undefined : attached.get(root)
        return attachment?.frameOrigin(origin) ?? (() => {})
      },
    }),
    attach(root, remote, adapters) {
      const attachment = { remote, ...adapters }
      attached.set(root, attachment)
      let detached = false
      return async () => {
        if (detached) return
        detached = true
        // Do not remove a newer attachment for the same root.
        if (attached.get(root) === attachment) attached.delete(root)
        await owner.supervisor.stopAll((key) => key.startsWith(`${root}\0`))
      }
    },
    mutate<T>(work: () => Promise<T>): Promise<T> {
      const result = queue.then(work)
      queue = result.catch(() => undefined)
      return result
    },
  }
  owners.set(args.userData, owner)
  return owner
}
