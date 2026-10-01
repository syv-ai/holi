/**
 * One capability call through one door, the same way for every door: the
 * vault's clone, its snapshot (the open vault's live cache, a fresh scan for
 * any other), the core services, and a rescan of the open vault after a write
 * so the very next read sees it. The doors differ only in how they hand a
 * refusal back: the app bridge and the UI door as a tRPC error, the CLI as a
 * line on stderr.
 *
 * A plugin's capability is refused as "no such method" in a vault that has
 * the plugin off, whatever this process has loaded.
 *
 * **The app door has one opener.** `dispatch` serves the UI and CLI doors.
 * The app door is opened once, by the vault apps code, which supplies the
 * consent check for entries with an `appGrant`. With no opener the app door
 * does not exist, and nothing else can reach an entry through it.
 *
 * No `electron` import: this loads under plain Node in the tests.
 */
import type { VaultSnapshot } from '@holi/shared'
import { scanVault } from '../vault/vault-store'
import { CapabilityError } from './error'
import type { Admit, CapabilityRegistry, CapabilityResult, Door } from './registry'
import type { CoreServices } from './services'

export interface CapabilityHostDeps {
  registry: CapabilityRegistry
  /** The vault's clone on this machine, or null for a vault Holi does not have. */
  rootFor(remote: string): Promise<string | null>
  /** The open vault, or null with none open. */
  active(): {
    remote: string
    snapshot(): VaultSnapshot
    refresh(): Promise<unknown>
  } | null
  core(remote: string, root: string): CoreServices
  /** Whether the vault cloned at `root` runs this plugin. */
  pluginEnabled(plugin: string, root: string): Promise<boolean>
}

/** A call through the UI or the CLI door. */
export interface CapabilityCall {
  door: Exclude<Door, 'app'>
  remote: string
  name: string
  params: unknown
}

export type Dispatch = (call: CapabilityCall) => Promise<CapabilityResult>

/** What opens the app door: the consent check for entries with an `appGrant`. */
export interface AppDoorOpener {
  admit: Admit
}

/** The app door, once opened: one call from the frame mounted for `bundle`. */
export interface AppDoor {
  call(remote: string, bundle: string, name: string, params: unknown): Promise<CapabilityResult>
}

export interface CapabilityHost {
  dispatch: Dispatch
  /** The names open at `door` in the vault at `remote`: core's, and those of
   *  the plugins it runs. What `has('tasks.create')` asks. */
  names(remote: string, door: Door): Promise<string[]>
  /** Open the app door. Once per process: a second opener throws. */
  openAppDoor(opener: AppDoorOpener): AppDoor
}

export function createCapabilityHost(deps: CapabilityHostDeps): CapabilityHost {
  async function rootOf(remote: string): Promise<string> {
    const root = await deps.rootFor(remote)
    if (root === null) throw new CapabilityError('NOT_FOUND', `no such vault: ${remote}`)
    return root
  }

  async function enabled(name: string, root: string): Promise<boolean> {
    const plugin = deps.registry.pluginOf(name)
    return plugin === null || (await deps.pluginEnabled(plugin, root))
  }

  async function run(
    door: Door,
    remote: string,
    bundle: string | null,
    name: string,
    params: unknown,
    admit?: Admit,
  ): Promise<CapabilityResult> {
    const root = await rootOf(remote)
    if (!(await enabled(name, root))) {
      throw new CapabilityError('BAD_REQUEST', `no such method: ${name}`)
    }
    const result = await deps.registry.run(
      name,
      door,
      {
        remote,
        root,
        bundle,
        snapshot: async () => {
          const active = deps.active()
          return active?.remote === remote ? active.snapshot() : scanVault(root)
        },
        core: deps.core(remote, root),
      },
      params,
      admit,
    )
    if (result.writes) {
      const active = deps.active()
      if (active?.remote === remote) {
        await active.refresh().catch((e) => console.error('[capabilities] post-write rescan:', e))
      }
    }
    return result
  }

  let opened = false

  return {
    dispatch: ({ door, remote, name, params }) => run(door, remote, null, name, params),

    async names(remote, door) {
      const root = await rootOf(remote)
      const names = deps.registry.names(door)
      const on = await Promise.all(names.map((name) => enabled(name, root)))
      return names.filter((_, i) => on[i])
    },

    openAppDoor({ admit }) {
      if (opened) throw new Error('the app door is already open')
      opened = true
      return {
        call: (remote, bundle, name, params) => run('app', remote, bundle, name, params, admit),
      }
    },
  }
}
