/**
 * Plugin events (docs/architecture.md, Plugins): one channel per plugin,
 * `plugin:<id>`, carrying `{remote, name, payload}` both ways.
 *
 * Main to renderer is `emit`; renderer to main is `on`. Both keep their
 * order, because a terminal's bytes and keystrokes are events, and both are
 * gated: an event about a vault that does not run the plugin never leaves
 * main, and a message about a vault that is not the displayed one is dropped.
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
  /** The displayed vault's remote, or null with none displayed. */
  liveRemote(): string | null
}

export interface PluginEvents {
  emit(remote: string, name: string, payload: unknown): void
  on(name: string, handler: (remote: string, payload: unknown) => void): () => void
  /** Cancel queued delivery without letting an old gate block fresh work. */
  cancelPending(): void
  /** Finish current outbound delivery before releasing its activation. */
  drain(): Promise<void>
}

type EventQueue = {
  run(step: () => Promise<void>): void
  drain(): Promise<void>
}

function checkName(name: string): void {
  if (!EVENT_NAME.test(name)) throw new Error(`event name ${name} is not kebab-case`)
}

function isEvent(message: unknown): message is PluginEvent {
  if (typeof message !== 'object' || message === null) return false
  const m = message as Record<string, unknown>
  return typeof m['remote'] === 'string' && typeof m['name'] === 'string'
}

/** A rejected gate is logged without breaking subsequent delivery. */
function queue(label: string): EventQueue {
  let tail: Promise<void> = Promise.resolve()
  return {
    run(step) {
      tail = tail.then(step).catch((err) => console.error(`[plugins] ${label}:`, err))
    },
    drain: () => tail,
  }
}

/**
 * One activation's events, ordered separately for each remote. `runs` is
 * checked on every delivery, including disposal output. Cancellation starts
 * fresh queues: an abandoned gate cannot hold up a disposer or replacement.
 * Core code that is not a plugin yet passes no enablement gate.
 */
export function pluginEvents(
  deps: PluginEventsDeps,
  id: string,
  runs?: (remote: string) => Promise<boolean>,
  generation?: () => number,
  allowed: () => boolean = () => true,
): PluginEvents {
  const channel = `plugin:${id}`
  const outboundByRemote = new Map<string, EventQueue>()
  const inboundByRemote = new Map<string, EventQueue>()
  let epoch = {}
  const channelQueue = (queues: Map<string, EventQueue>, remote: string, label: string) => {
    let run = queues.get(remote)
    if (run === undefined) {
      run = queue(`${id} ${label} ${remote}`)
      queues.set(remote, run)
    }
    return run
  }
  return {
    cancelPending() {
      epoch = {}
      outboundByRemote.clear()
      inboundByRemote.clear()
    },
    async drain() {
      await Promise.all([...outboundByRemote.values()].map((work) => work.drain()))
    },
    emit(remote, name, payload) {
      checkName(name)
      if (!allowed()) return
      const event = { remote, name, payload }
      if (runs === undefined) return deps.send(channel, event)
      const owner = epoch
      const at = generation?.()
      const current = () =>
        epoch === owner && allowed() && (generation === undefined || generation() === at)
      channelQueue(outboundByRemote, remote, 'event').run(async () => {
        if (current() && (await runs(remote)) && current()) deps.send(channel, event)
      })
    },
    on(name, handler) {
      checkName(name)
      let listening = true
      const undo = deps.listen(channel, (message) => {
        if (!isEvent(message) || message.name !== name) return
        if (message.remote !== deps.liveRemote()) return
        const owner = epoch
        const at = generation?.()
        const current = () =>
          listening &&
          epoch === owner &&
          allowed() &&
          message.remote === deps.liveRemote() &&
          (generation === undefined || generation() === at)
        channelQueue(inboundByRemote, message.remote, 'message').run(async () => {
          if (current() && (runs === undefined || (await runs(message.remote))) && current())
            handler(message.remote, message.payload)
        })
      })
      return () => {
        listening = false
        undo()
      }
    },
  }
}
