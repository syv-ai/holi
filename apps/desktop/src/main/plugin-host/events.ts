/**
 * Plugin events (docs/architecture.md, Plugins): one channel per plugin,
 * `plugin:<id>`, carrying `{remote, name, payload}` both ways.
 *
 * Main to renderer is `emit`; renderer to main is `on`. Both keep their
 * order, because a terminal's bytes and keystrokes are events, and both are
 * gated: an event about a vault that does not run the plugin never leaves
 * main, and a message about a vault that is not the open one is dropped.
 *
 * No `electron` import: the composition root supplies the window and
 * `ipcMain` as closures, so this loads under plain Node in the tests.
 */

/** An event's name: lowercase letters, digits and dashes. */
const EVENT_NAME = /^[a-z][a-z0-9-]*$/

export interface PluginEvent {
  remote: string
  name: string
  payload: unknown
}

export interface PluginEventsDeps {
  /** Send to the window, if there is one. */
  send(channel: string, event: PluginEvent): void
  /** Hear what the renderer sends on `channel`. Returns the undo. */
  listen(channel: string, handler: (message: unknown) => void): () => void
  /** The open vault's remote, or null with none open. */
  liveRemote(): string | null
}

export interface PluginEvents {
  emit(remote: string, name: string, payload: unknown): void
  on(name: string, handler: (remote: string, payload: unknown) => void): () => void
}

function checkName(name: string): void {
  if (!EVENT_NAME.test(name)) throw new Error(`event name ${name} is not kebab-case`)
}

function isEvent(message: unknown): message is PluginEvent {
  if (typeof message !== 'object' || message === null) return false
  const m = message as Record<string, unknown>
  return typeof m['remote'] === 'string' && typeof m['name'] === 'string'
}

/**
 * Runs steps one after another, so an async gate cannot reorder them. A step
 * that throws is logged and the queue carries on.
 */
function queue(label: string): (step: () => Promise<void>) => void {
  let tail: Promise<void> = Promise.resolve()
  return (step) => {
    tail = tail.then(step).catch((err) => console.error(`[plugins] ${label}:`, err))
  }
}

/**
 * The events of the plugin `id`. `runs(remote)` says whether that vault runs
 * the plugin; it is asked on every event, so it must answer from a cache for
 * the open vault. Core code that is not a plugin yet passes none.
 */
export function pluginEvents(
  deps: PluginEventsDeps,
  id: string,
  runs?: (remote: string) => Promise<boolean>,
): PluginEvents {
  const channel = `plugin:${id}`
  const outbound = queue(`${id} event`)
  const inbound = queue(`${id} message`)
  return {
    emit(remote, name, payload) {
      checkName(name)
      const event = { remote, name, payload }
      if (runs === undefined) return deps.send(channel, event)
      outbound(async () => {
        if (await runs(remote)) deps.send(channel, event)
      })
    },
    on(name, handler) {
      checkName(name)
      return deps.listen(channel, (message) => {
        if (!isEvent(message) || message.name !== name) return
        // Checked on arrival: a keystroke typed before a vault switch must
        // not reach the vault that replaced it.
        if (message.remote !== deps.liveRemote()) return
        inbound(async () => {
          if (runs === undefined || (await runs(message.remote))) {
            handler(message.remote, message.payload)
          }
        })
      })
    },
  }
}
