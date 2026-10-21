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
import { appHost, appName } from '../shared/bundle'
import {
  activeModeAtom,
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
export function runInFrame(
  store: PluginStore,
  remote: string,
  bundle: string,
  command: string,
  input: CommandInput,
  inFlight: Set<() => void>,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const frame = document.createElement('iframe')
    // The same sandbox as the app's tab, less popups: a command has no page
    // to put a link on.
    frame.setAttribute('sandbox', 'allow-scripts')
    frame.setAttribute('aria-hidden', 'true')
    frame.tabIndex = -1
    frame.style.display = 'none'
    const mode = store.get(activeModeAtom)
    frame.src = `holi-app://${appHost(bundle)}/?${COMMAND_PARAM}=${encodeURIComponent(command)}&mode=${mode}`

    const done = (): void => {
      clearTimeout(timer)
      inFlight.delete(cancel)
      window.removeEventListener('message', onMessage)
      frame.remove()
    }
    const cancel = (): void => {
      done()
      reject(new Error('the vault was left'))
    }
    inFlight.add(cancel)
    const timer = setTimeout(() => {
      done()
      reject(new Error(`took longer than ${COMMAND_TIMEOUT_MS / 1000} s`))
    }, COMMAND_TIMEOUT_MS)

    const onMessage = (event: MessageEvent): void => {
      if (event.source !== frame.contentWindow) return
      const data = event.data as { command?: CommandOutcome } | null
      if (data !== null && typeof data === 'object' && typeof data.command === 'object') {
        const outcome = data.command
        done()
        if (outcome?.ok === true) resolve(outcome.value)
        else reject(new Error(String(outcome?.error ?? 'the command failed')))
        return
      }
      hostBridgeMessage(event.data, {
        store,
        remote,
        bundle,
        reply: (response) => frame.contentWindow?.postMessage(response, '*'),
      })
    }
    window.addEventListener('message', onMessage)
    // Classic scripts have run by `load`, so the command has registered.
    frame.addEventListener('load', () => frame.contentWindow?.postMessage({ run: input }, '*'))
    document.body.append(frame)
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
): Promise<SlashResult> {
  try {
    // The editor does not offer it there; refused here as well, because what
    // the frame is given is the note's text, and what it answers is written
    // into the note.
    if (isAppFencedPath(input.path)) throw new Error(`no app may read ${input.path}`)
    if (!isAppWritablePath(input.path)) throw new Error(`no app may write ${input.path}`)
    const action = commandActionOf(
      await runInFrame(store, remote, command.bundle, command.name, input, inFlight),
    )
    if (action !== null && 'error' in action) throw new Error(action.error)
    if (action !== null && 'open' in action) {
      openTarget(store, { target: action.open })
      return null
    }
    return action
  } catch (err) {
    const text = `/${command.name}: ${(err as Error).message}`
    console.warn(`[apps] ${text}`)
    appsCap.log(remote, { bundle: command.bundle, level: 'error', text }).catch(() => {})
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
            run: (input) => runAppCommand(store, remote, command, input, inFlight),
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
