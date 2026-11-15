/**
 * Apps' slash commands in the notes editor (docs/features/vault-apps.md).
 *
 * Which there are: every finished app's `commands:`, read by main from the
 * manifests and read again when one of them changes in the snapshot. How one
 * runs: a hidden frame on its app's own `holi-app:` origin, sandboxed like the
 * app's tab (`allow-scripts`, never `allow-same-origin`), answering its bridge
 * calls as the tab does (`bridge-host.ts`), and removed once it answers,
 * times out, or its vault is left. Never in a note no app may read
 * (`isAppFencedPath`) or write (`isAppWritablePath`). What went wrong goes to
 * the app's log, which is where the agent that wrote the command looks; the
 * note is left as it was.
 */
import { atom } from 'jotai'
import { appBundleOf, isAppFencedPath, isAppWritablePath } from '@holi/shared'
import {
  COMMAND_PARAM,
  COMMAND_TIMEOUT_MS,
  commandActionOf,
  type CommandInput,
  type CommandOutcome,
} from '../shared/commands'
import { APP_MANIFEST_FILE } from '../shared/manifest'
import { appName, leasedAppHost } from '../shared/bundle'
import {
  activeModeAtom,
  activeRemoteAtom,
  snapshotAtom,
  type PluginStore,
  type SlashCommand,
  type SlashResult,
} from '@/plugin-api'
import { appPathsAtom } from './apps'
import { appsCap } from './apps-cap'
import { hostBridgeMessage, openTarget } from './bridge-host'

/** One command an app declares, as main reads it. */
interface AppCommand {
  bundle: string
  name: string
  description?: string
}

/** The commands the slash menu lists while the apps plugin runs. */
export const appSlashCommandsAtom = atom<readonly SlashCommand[]>([])

/** Bumped by main's `commands-changed`: the vault's `apps.commands` is
 *  answering, so the list is read again. */
export const commandsChangedAtom = atom(0)

/** Changes when an app is finished, removed, or its manifest is edited. */
const manifestsSignatureAtom = atom((get) => {
  const apps = new Set(get(appPathsAtom))
  return get(snapshotAtom)
    .files.filter((f) => {
      const bundle = appBundleOf(f.path)
      return bundle !== null && apps.has(bundle) && f.path === `${bundle}/${APP_MANIFEST_FILE}`
    })
    .map((f) => `${f.path}@${f.updatedAt}`)
    .join('\n')
})

/**
 * Run `command` of `bundle` on `input` in a hidden frame and answer what it
 * returned, unchecked. Rejects when it failed, threw or took too long.
 */
function runInFrame(
  store: PluginStore,
  remote: string,
  bundle: string,
  command: string,
  input: CommandInput,
  inFlight: Set<() => void>,
  isCurrent: () => boolean,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let frame: HTMLIFrameElement | null = null
    let lease: { token: string; nonce: string } | null = null
    let settled = false
    let cleaned = false
    let handedInput = false
    let cleanupFallback: ReturnType<typeof setTimeout> | null = null
    const done = (): void => {
      if (cleaned) return
      cleaned = true
      clearTimeout(timer)
      if (cleanupFallback !== null) clearTimeout(cleanupFallback)
      inFlight.delete(cancel)
      window.removeEventListener('message', onMessage)
      frame?.remove()
      if (lease !== null) {
        void appsCap.releaseFrameLease(remote, { bundle, token: lease.token }).catch(() => {})
        lease = null
      }
    }
    const finish = (value: unknown, error?: Error): void => {
      if (settled) return
      settled = true
      done()
      if (error) reject(error)
      else resolve(value)
    }
    const failWithLog = (error: Error): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      window.removeEventListener('message', onMessage)
      reject(error)
      const logLease = lease
      if (logLease === null || !isCurrent()) {
        done()
        return
      }
      // Main batches log entries for one second; retain authority beyond that flush.
      cleanupFallback = setTimeout(done, 5_000)
      void appsCap
        .log(remote, {
          bundle,
          level: 'error',
          text: `/${command}: ${error.message}`,
          token: logLease.token,
          nonce: logLease.nonce,
        })
        .catch(() => {})
        .finally(done)
    }
    const cancel = (): void => {
      if (settled) done()
      else finish(undefined, new Error('the vault was left'))
    }
    const timer = setTimeout(() => {
      const error = new Error(`took longer than ${COMMAND_TIMEOUT_MS / 1000} s`)
      if (lease === null || settled || !isCurrent()) {
        finish(undefined, error)
        return
      }
      failWithLog(error)
    }, COMMAND_TIMEOUT_MS)
    const onMessage = (event: MessageEvent): void => {
      if (frame === null || lease === null || event.source !== frame.contentWindow || !isCurrent())
        return
      const data = event.data as {
        nonce?: unknown
        ready?: unknown
        command?: CommandOutcome
      } | null
      if (data?.nonce !== lease.nonce) return
      void appsCap
        .frameLeaseValid(remote, { bundle, token: lease.token, nonce: lease.nonce })
        .then((valid) => {
          if (!valid || settled || !isCurrent() || frame === null || lease === null) return
          if (data.ready === true && !handedInput) {
            handedInput = true
            frame.contentWindow?.postMessage({ run: input, nonce: lease.nonce }, '*')
            return
          }
          if (typeof data.command === 'object') {
            const outcome = data.command
            if (outcome?.ok !== true) {
              const error = new Error(String(outcome?.error ?? 'the command failed'))
              if (!isCurrent()) {
                finish(undefined, error)
                return
              }
              failWithLog(error)
              return
            }
            const action = commandActionOf(outcome.value)
            if (action !== null && 'error' in action) {
              const error = new Error(action.error)
              if (!isCurrent()) {
                finish(undefined, error)
                return
              }
              failWithLog(error)
              return
            }
            finish(action)
            return
          }
          hostBridgeMessage(event.data, {
            store,
            remote,
            bundle,
            token: lease.token,
            nonce: lease.nonce,
            current: () => !settled && isCurrent() && store.get(activeRemoteAtom) === remote,
            authorize: async () =>
              !settled &&
              isCurrent() &&
              store.get(activeRemoteAtom) === remote &&
              (await appsCap.frameLeaseValid(remote, {
                bundle,
                token: lease!.token,
                nonce: lease!.nonce,
              })),
            reply: (response) => {
              if (!settled && isCurrent() && store.get(activeRemoteAtom) === remote) {
                frame?.contentWindow?.postMessage(response, '*')
              }
            },
          })
        })
        .catch(() => {})
    }
    inFlight.add(cancel)
    window.addEventListener('message', onMessage)
    void appsCap.frameLease(remote, { bundle }).then(
      (issued) => {
        if (settled || !isCurrent() || store.get(activeRemoteAtom) !== remote) {
          void appsCap.releaseFrameLease(remote, { bundle, token: issued.token }).catch(() => {})
          finish(undefined, new Error('the vault was left'))
          return
        }
        lease = issued
        frame = document.createElement('iframe')
        frame.setAttribute('sandbox', 'allow-scripts')
        frame.setAttribute('aria-hidden', 'true')
        frame.tabIndex = -1
        frame.style.display = 'none'
        const mode = store.get(activeModeAtom)
        frame.src = `holi-app://${leasedAppHost(bundle, lease.token)}/?${COMMAND_PARAM}=${encodeURIComponent(command)}&mode=${mode}`
        document.body.append(frame)
      },
      (error: unknown) =>
        finish(undefined, error instanceof Error ? error : new Error(String(error))),
    )
  })
}

/** Run an app's command and turn its answer into what the editor applies;
 *  `open` is done here, as the app's own `holi.open` would. */
async function runAppCommand(
  store: PluginStore,
  remote: string,
  command: AppCommand,
  input: CommandInput,
  inFlight: Set<() => void>,
  isCurrent: () => boolean = () => true,
): Promise<SlashResult> {
  try {
    // The editor does not offer it there; refused here as well, because what
    // the frame is given is the note's text, and what it answers is written
    // into the note.
    if (isAppFencedPath(input.path)) throw new Error(`no app may read ${input.path}`)
    if (!isAppWritablePath(input.path)) throw new Error(`no app may write ${input.path}`)
    const action = (await runInFrame(
      store,
      remote,
      command.bundle,
      command.name,
      input,
      inFlight,
      isCurrent,
    )) as ReturnType<typeof commandActionOf>
    if (!isCurrent() || store.get(activeRemoteAtom) !== remote) return null
    if (action !== null && 'error' in action) throw new Error(action.error)
    if (action !== null && 'open' in action) {
      openTarget(store, { target: action.open })
      return null
    }
    return action
  } catch (err) {
    if (isCurrent()) console.warn(`[apps] /${command.name}: ${(err as Error).message}`)
    throw err
  }
}

/**
 * While `remote` is open: keep `appSlashCommandsAtom` to the vault's apps'
 * commands, read again whenever a finished app's manifest changes, and when
 * main says `apps.commands` answers (it starts the vault's plugins alongside
 * the renderer, so the first read can come too early). Leaving the vault
 * removes its commands' frames.
 */
export function followAppCommands(remote: string, store: PluginStore): () => void {
  let live = true
  let asked = 0
  const inFlight = new Set<() => void>()
  const load = (): void => {
    const ask = ++asked
    appsCap
      .commands(remote, { bundles: [...store.get(appPathsAtom)] })
      .then((commands) => {
        if (!live || ask !== asked) return
        store.set(
          appSlashCommandsAtom,
          commands.map((command): SlashCommand => ({
            name: command.name,
            ...(command.description === undefined ? {} : { detail: command.description }),
            meta: appName(command.bundle),
            // Given the note's text, and may write into it: only in a note an
            // app may both read and write (docs/features/vault-apps.md).
            offeredIn: (path) => !isAppFencedPath(path) && isAppWritablePath(path),
            run: (input, isCurrent) =>
              runAppCommand(store, remote, command, input, inFlight, isCurrent),
          })),
        )
      })
      .catch((err: unknown) => {
        if (live && ask === asked) console.warn('[apps] commands:', err)
      })
  }
  const offManifests = store.sub(manifestsSignatureAtom, load)
  const offReady = store.sub(commandsChangedAtom, load)
  load()
  return () => {
    live = false
    offManifests()
    offReady()
    for (const cancel of [...inFlight]) cancel()
    store.set(appSlashCommandsAtom, [])
  }
}
