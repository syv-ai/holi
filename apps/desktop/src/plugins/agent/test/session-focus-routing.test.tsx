import { act, cleanup, render, renderHook, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createStore, Provider, useAtomValue } from 'jotai'
import type { ReactNode } from 'react'
import { afterEach, expect, test, vi } from 'vitest'
import { activeRemoteAtom } from '@/plugin-api'
import type { CapabilityContext } from '../../../main/plugin-api'
import { agentCapabilities } from '../main/host/capabilities'
import type { PtyProcess } from '../main/host/pty'
import { createPtySessions } from '../main/host/pty-sessions'
import { createAgentTerminals } from '../main/host/terminals'
import type { AgentProvider } from '../main/provider'
import { AGENT_INFO } from '../info'
import { NewSessionButton } from '../renderer/sessions/new-session-button'
import { AGENT_SERVICE } from '../renderer/service'
import { newSessionAtom } from '../renderer/state/session-list'
import { loadProvidersAtom, pickedProviderAtom } from '../renderer/state/providers'
import { agentEvents } from '../renderer/state/sessions'

const mutate = vi.hoisted(() => vi.fn())
vi.mock('@/lib/trpc', () => ({ trpc: { cap: { run: { mutate } } } }))

// Core's consumers use the same registered source and shell selection as the app.
const { useAgentService } = await import('@/state/agent-service')
const { installedPluginsAtom } = await import('@/state/plugins')
const { useSessionTabs } = await import('@/hooks/use-session-tabs')
const { shellWorkspaceAtom } = await import('@/state/shell-tabs')
const { activeSplit, allTabs, focusMember, focusedTab, openInSplit, selectEntry } =
  await import('@/state/shell-workspace')
const { sessionKey } = await import('@/state/tab-descriptor')

const REMOTE = 'review/focused-session'
const disposals: Array<() => Promise<void>> = []

afterEach(async () => {
  cleanup()
  for (const dispose of disposals.splice(0)) await dispose()
  mutate.mockReset()
})

class FixturePty implements PtyProcess {
  readonly writes: string[] = []
  private output: ((data: string) => void) | undefined
  private exited: ((event: { exitCode: number }) => void) | undefined

  constructor(readonly pid: number) {}

  onData(callback: (data: string) => void) {
    this.output = callback
  }

  onExit(callback: (event: { exitCode: number }) => void) {
    this.exited = callback
  }

  write(data: string) {
    this.writes.push(data)
  }

  resize() {}

  kill() {
    this.exited?.({ exitCode: 0 })
  }

  ready() {
    this.output?.('Ready for a prompt')
  }
}

async function setup() {
  const store = createStore()
  store.set(activeRemoteAtom, REMOTE)
  store.set(pickedProviderAtom, 'codex')
  store.set(installedPluginsAtom, [
    {
      info: AGENT_INFO,
      agent: AGENT_SERVICE,
      agentsMode: {
        sidebar: () => null,
        main: () => null,
        status: { read: () => ({}) } as never,
        newSession: newSessionAtom,
      },
    },
  ])
  const processes: FixturePty[] = []
  const terminals = createAgentTerminals({
    emit: (remote, name, payload) => agentEvents[name]?.({ remote, payload }, store),
    spawnPty: () => {
      const pty = new FixturePty(400_000 + processes.length)
      processes.push(pty)
      return pty
    },
    // A fixture PID never reaches the operating system's signal path.
    probePid: () => 'gone',
    log: () => {},
  })
  const provider: AgentProvider = {
    id: 'codex',
    label: 'Codex',
    notInstalled: 'Fixture provider unavailable',
    installed: () => true,
    configure: async () => ({ dir: '/fixture/codex' }),
    terminal: () => ({ bin: '/fixture/codex', args: [], env: {} }),
    capabilities: {},
  }
  const own = createPtySessions({
    vault: { remote: REMOTE, root: '/fixture/vault' },
    providers: () => [provider],
    terminals,
    bracket: () => {},
    binDir: () => null,
    onChange: (payload) => agentEvents.sessions?.({ remote: REMOTE, payload }, store),
    log: () => {},
  })
  disposals.push(async () => {
    for (const process of processes) process.kill()
    await own.leave()
    await terminals.closeAll()
  })
  const unexpected = (): never => {
    throw new Error('A managed Codex ask must not use another session implementation')
  }
  const table = agentCapabilities({
    sessions: {
      ensure: async () => {},
      sessions: () => [],
      past: () => [],
      start: unexpected,
      open: unexpected,
      launch: unexpected,
      watched: () => false,
      send: unexpected,
      message: unexpected,
      stop: unexpected,
      respawn: unexpected,
      duplicate: unexpected,
    },
    own,
    jobs: {
      has: () => false,
      sessions: () => [],
      start: unexpected,
      message: unexpected,
      stop: unexpected,
    },
    fenced: { start: unexpected },
    defaultProvider: async () => 'codex',
    providers: () => [provider],
    terminals,
    liveRemote: () => REMOTE,
    commitNow: async () => {},
  })
  mutate.mockImplementation(
    async (input: { remote: string; name: string; paramsJson?: string }) => {
      expect(input.remote).toBe(REMOTE)
      const ctx = { remote: input.remote } as CapabilityContext
      const params = input.paramsJson === undefined ? undefined : JSON.parse(input.paramsJson)
      switch (input.name) {
        case 'agent.providers':
          return table['agent.providers'].run(ctx, table['agent.providers'].params(params))
        case 'agent.start':
          return table['agent.start'].run(ctx, table['agent.start'].params(params))
        case 'agent.send':
          return table['agent.send'].run(ctx, table['agent.send'].params(params))
        default:
          throw new Error(`Unexpected capability: ${input.name}`)
      }
    },
  )
  const wrapper = ({ children }: { children: ReactNode }) => (
    <Provider store={store}>{children}</Provider>
  )
  const service = renderHook(
    () => {
      const workspace = useAtomValue(shellWorkspaceAtom)
      useSessionTabs(focusedTab(workspace))
      return useAgentService()
    },
    { wrapper },
  )
  render(<NewSessionButton />, { wrapper })
  await act(async () => store.set(loadProvidersAtom))
  return { store, own, processes, terminals, service }
}

test.each([false, true])(
  'routes the actual service ask to sidebar focus (split: %s)',
  async (split) => {
    const t = await setup()
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'New Codex session' }))
    await waitFor(() => expect(t.own.sessions()).toHaveLength(1))
    const first = t.own.sessions()[0]!
    await user.click(screen.getByRole('button', { name: 'New Codex session' }))
    await waitFor(() => expect(t.own.sessions()).toHaveLength(2))
    const second = t.own.sessions().find((session) => session.id !== first.id)!
    const firstKey = sessionKey({ owner: 'agent', id: `session:${first.id}` })
    const secondKey = sessionKey({ owner: 'agent', id: `session:${second.id}` })
    await waitFor(() =>
      expect(allTabs(t.store.get(shellWorkspaceAtom))).toEqual([firstKey, secondKey]),
    )
    act(() => {
      t.store.set(shellWorkspaceAtom, (ws) => {
        if (!split) return selectEntry(ws, firstKey)
        const next = openInSplit(ws, firstKey)
        const pair = activeSplit(next)
        if (pair === null) throw new Error('Expected the two real session tabs in a split')
        return focusMember(next, pair.id, firstKey)
      })
    })
    await waitFor(() => expect(focusedTab(t.store.get(shellWorkspaceAtom))).toBe(firstKey))
    act(() => t.processes.forEach((process) => process.ready()))
    const service = t.service.result.current
    if (service === null) throw new Error('The real agent service was not registered')
    const target = t.store.get(service.targets).default
    const text = 'Review routing: this belongs in the first focused session'
    await act(async () => expect(await service.ask({ text, target })).toEqual({ ok: true }))
    const paste = `\x1b[200~${text}\x1b[201~`
    await waitFor(() =>
      expect(t.processes.some((process) => process.writes.includes(paste))).toBe(true),
    )
    expect(t.processes[0]!.writes).toContain(paste)
    expect(t.processes[1]!.writes).not.toContain(paste)
    expect(t.processes[0]!.writes.join('')).not.toMatch(/[\r\n]/)
    expect(target).toBe(first.id)
    expect(t.terminals.launchedFor(first.id)).toBe(t.own.terminalOf(first.id))
  },
)
