import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { expect } from 'vitest'
import { createBridgeServer } from '../../../../main/bridge/server'
import { createCapabilityHost } from '../../../../main/capabilities/dispatch'
import { createCapabilityRegistry } from '../../../../main/capabilities/registry'
import { noCoreServices } from '../../../../main/capabilities/services'
import type { PluginEvent } from '../../../../main/plugin-host/events'
import { createPluginHost } from '../../../../main/plugin-host/host'
import { agentMain } from '../../main/index'
import type { SessionSummary } from '../../main/claude/listing'

export function activationHosts(
  userData: string,
  route: Parameters<typeof createPluginHost>[0]['route'] = () => () => {},
  commit?: (root: string) => void,
) {
  const roots = { 'fixture/a': join(userData, 'vault-a'), 'fixture/b': join(userData, 'vault-b') }
  type Remote = keyof typeof roots
  const A: Remote = 'fixture/a'
  const B: Remote = 'fixture/b'
  const events: PluginEvent[] = []
  const publications: PluginEvent[] = []
  const syncHolds = new Set<Remote>()
  const pending = new Set<Promise<unknown>>()
  const registry = createCapabilityRegistry()
  const agentListeners = new Set<(message: unknown) => void>()
  const host = createPluginHost({
    plugins: [
      agentMain,
      {
        info: {
          id: 'fixture-observer',
          label: 'Fixture observer',
          description: 'Records agent publication',
          default: true,
          builtIn: true,
          requires: ['agent'],
        },
        activate(ctx) {
          for (const name of ['sessions', 'turn-end'])
            ctx.hear('agent', name, (payload) =>
              publications.push({ remote: ctx.remote, name, payload }),
            )
          return () => {}
        },
      },
    ],
    registry,
    userData,
    coreSeeds: [],
    active: () => null,
    rootFor: async (remote) => roots[remote as Remote] ?? null,
    events: {
      send: (_channel, event) => events.push(event),
      listen(channel, handler) {
        if (channel !== 'plugin:agent') return () => {}
        agentListeners.add(handler)
        return () => void agentListeners.delete(handler)
      },
      liveRemote: () => host.displayed(),
    },
    openAppDoor: () => {
      throw new Error('unused')
    },
    route,
    binDir: () => userData,
    githubToken: () => null,
    frameOrigin: () => () => {},
    notify: () => false,
    focused: () => false,
    call: async (remote, name, params, beforeInvoke) =>
      (await capabilities.dispatch({ door: 'ui', remote, name, params, beforeInvoke })).value,
  })
  const capabilities = createCapabilityHost({
    registry,
    rootFor: async (remote) => roots[remote as Remote] ?? null,
    active: () => null,
    core: noCoreServices,
    pluginEnabled: async (plugin, root) => (await host.serving(root)).has(plugin),
    claims: (root) => host.scanClaimsFor(root),
  })
  const call = async (remote: Remote, name: string, params: unknown = {}) => {
    const work = capabilities.dispatch({ door: 'ui', remote, name, params })
    pending.add(work)
    try {
      return (await work).value
    } finally {
      pending.delete(work)
    }
  }
  const stop = (remote: Remote) => {
    const work = host.stop(remote)
    pending.add(work)
    void work.then(
      () => pending.delete(work),
      () => pending.delete(work),
    )
    return work
  }
  const quiet = (remote: Remote) => {
    const sent = events.filter((event) => event.remote === remote)
    const published = publications.filter((event) => event.remote === remote)
    return () => {
      expect(events.filter((event) => event.remote === remote)).toEqual(sent)
      expect(publications.filter((event) => event.remote === remote)).toEqual(published)
    }
  }
  const enter = (remote: Remote) => {
    const work = host.reconcile(
      {
        remote,
        root: roots[remote],
        pause: () => void syncHolds.add(remote),
        resume: () => void syncHolds.delete(remote),
        drainSync: async () => {},
        commitNow: async () => {
          commit?.(roots[remote])
          return execFileSync('git', ['-C', roots[remote], 'rev-parse', 'HEAD'], {
            encoding: 'utf8',
          }).trim()
        },
        repo: {
          head: async () =>
            execFileSync('git', ['-C', roots[remote], 'rev-parse', 'HEAD'], {
              encoding: 'utf8',
            }).trim(),
        },
      },
      'open',
    )
    pending.add(work)
    void work.then(
      () => pending.delete(work),
      () => pending.delete(work),
    )
    return work
  }
  const rows = async (remote: Remote) => (await call(remote, 'agent.sessions')) as SessionSummary[]
  return {
    roots,
    syncHeld: (remote: Remote) => syncHolds.has(remote),
    A,
    B,
    host,
    capabilities,
    registry,
    call,
    stop,
    quiet,
    enter,
    rows,
    pending,
    events,
    publications,
    write(remote: Remote, id: string, data: string) {
      for (const handler of agentListeners)
        handler({ remote, name: 'pty-write', payload: { id, data } })
    },
    listenerCount: () => agentListeners.size,
  }
}

export function activationHttp(h: ReturnType<typeof activationHosts>) {
  type Remote = keyof typeof h.roots
  const bridge = createBridgeServer({
    log: () => {},
    cli: {
      dispatch: h.capabilities.dispatch,
      commands: (remote) => h.registry.commands(remote),
      rootFor: async (remote) => h.roots[remote as Remote] ?? null,
    },
  })
  const request = async (
    remote: Remote,
    path: string,
    body: string,
    params: Record<string, string> = {},
  ) => {
    const url = new URL(path, `http://127.0.0.1:${bridge.port()}`)
    url.search = new URLSearchParams({ ...params, t: bridge.tokenForVault(remote) }).toString()
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 3000)
    try {
      const response = await fetch(url, {
        method: 'POST',
        body,
        headers: { connection: 'close' },
        signal: controller.signal,
      })
      return { status: response.status, text: await response.text() }
    } finally {
      clearTimeout(timer)
    }
  }
  return {
    route: bridge.route,
    start: bridge.start,
    async stop() {
      await bridge.stop()
      expect(bridge.port()).toBeNull()
    },
    cli(remote: Remote, ...argv: string[]) {
      return request(
        remote,
        '/cli',
        new URLSearchParams(argv.map((word) => ['argv', word])).toString(),
      )
    },
    hook(remote: Remote, session: string, thread = '12345678-1234-4234-8234-123456789abc') {
      return request(
        remote,
        '/codex/turn-end',
        JSON.stringify({ type: 'agent-turn-complete', 'thread-id': thread }),
        { session },
      )
    },
  }
}
