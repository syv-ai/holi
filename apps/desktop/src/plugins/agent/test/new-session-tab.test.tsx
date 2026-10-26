/**
 * The sidebar's +, ⌘N and the tab strip's + on the Agents side start a
 * session in this machine's default agent at once, and its tab comes forward
 * from anywhere, a document in front included.
 */
import { act, renderHook } from '@testing-library/react'
import { createStore, Provider, useAtomValue, type WritableAtom } from 'jotai'
import type { ReactNode } from 'react'
import { beforeEach, expect, test, vi } from 'vitest'
import { activeRemoteAtom, type RendererPlugin } from '@/plugin-api'
import { agentCap } from '../renderer/agent-cap'
import { AGENT_INFO } from '../info'
import { newSessionAtom } from '../renderer/state/session-list'

vi.mock('../renderer/agent-cap', () => ({
  agentCap: {
    start: vi.fn(async () => ({ ok: true, sessionId: 'p0123456789ab', terminalId: 't1' })),
  },
}))

// The shell's side, reached as modules (a dynamic import: a plugin's code
// imports core only through @/plugin-api).
type Settable<T> = WritableAtom<T, [T], void>
const { useSessionTabs } = await import('@/hooks/use-session-tabs')
const { newAgentSessionAtom } = (await import('@/state/agents-slots')) as unknown as {
  newAgentSessionAtom: WritableAtom<null, [beside?: boolean], boolean>
}
const { installedPluginsAtom } = (await import('@/state/plugins')) as unknown as {
  installedPluginsAtom: Settable<readonly RendererPlugin[]>
}
const { shellWorkspaceAtom } = await import('@/state/shell-tabs')
const { focusedTab, openTab } = await import('@/state/shell-workspace')
const { sessionKey } = await import('@/state/tab-descriptor')

const SESSION = sessionKey({ owner: 'agent', id: 'session:p0123456789ab' })

beforeEach(() => vi.mocked(agentCap.start).mockClear())

function setup() {
  const store = createStore()
  store.set(activeRemoteAtom, 'o/r')
  store.set(installedPluginsAtom, [
    {
      info: AGENT_INFO,
      agentsMode: {
        sidebar: () => null,
        main: () => null,
        status: { read: () => ({}) } as never,
        newSession: newSessionAtom,
      },
    },
  ])
  const wrapper = ({ children }: { children: ReactNode }) => (
    <Provider store={store}>{children}</Provider>
  )
  renderHook(
    () => {
      const ws = useAtomValue(shellWorkspaceAtom)
      useSessionTabs(focusedTab(ws))
    },
    { wrapper },
  )
  return store
}

test('a new session starts in the default agent and its tab comes forward', async () => {
  const store = setup()
  act(() => store.set(shellWorkspaceAtom, (ws) => openTab(ws, 'Notes/A.md')))
  await act(async () => {
    await store.set(newSessionAtom)
  })
  expect(agentCap.start).toHaveBeenCalledWith('o/r', expect.objectContaining({ provider: 'claude' }))
  expect(focusedTab(store.get(shellWorkspaceAtom))).toBe(SESSION)
})

test("core's new session goes through the mode", async () => {
  const store = setup()
  let handled = false
  await act(async () => {
    handled = store.set(newAgentSessionAtom)
    await vi.waitFor(() => expect(agentCap.start).toHaveBeenCalled())
  })
  expect(handled).toBe(true)
})
