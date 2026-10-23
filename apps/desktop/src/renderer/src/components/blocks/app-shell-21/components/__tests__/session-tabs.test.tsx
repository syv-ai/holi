import { act, renderHook } from "@testing-library/react"
import { createStore, Provider, useAtomValue } from "jotai"
import type { ReactNode } from "react"
import { expect, test } from "vitest"

import { agentsSelectionAtom } from "@/state/agents-slots"
import { shellWorkspaceAtom } from "@/state/shell-tabs"
import { allTabs, focusedPane, openTab } from "@/state/shell-workspace"
import { AGENTS_HOME_KEY, sessionKey } from "@/state/tab-descriptor"

import { useSessionTabs } from "../use-session-tabs"

/** The hook as the shell mounts it: fed the focused tab. */
function useShellSide() {
  const ws = useAtomValue(shellWorkspaceAtom)
  useSessionTabs(focusedPane(ws).active)
  return ws
}

function setup() {
  const store = createStore()
  const wrapper = ({ children }: { children: ReactNode }) => (
    <Provider store={store}>{children}</Provider>
  )
  const hook = renderHook(useShellSide, { wrapper })
  return { store, hook }
}

const ONE = { owner: "chat", id: "one" }

test("picking a session opens it as a tab", () => {
  const { store } = setup()
  act(() => store.set(agentsSelectionAtom, { ...ONE }))
  const ws = store.get(shellWorkspaceAtom)
  expect(focusedPane(ws).active).toBe(sessionKey(ONE))
})

test("picking it again after looking elsewhere focuses its tab, not a copy", () => {
  const { store } = setup()
  act(() => store.set(agentsSelectionAtom, { ...ONE }))
  act(() => store.set(shellWorkspaceAtom, (ws) => openTab(ws, "Notes/A.md")))
  // The focused document clears the selection, so the row reads as unopened.
  expect(store.get(agentsSelectionAtom)).toBeNull()
  act(() => store.set(agentsSelectionAtom, { ...ONE }))
  const ws = store.get(shellWorkspaceAtom)
  expect(focusedPane(ws).active).toBe(sessionKey(ONE))
  expect(allTabs(ws).filter((t) => t === sessionKey(ONE))).toHaveLength(1)
})

test("the focused session tab is the selection the sidebar marks", () => {
  const { store } = setup()
  act(() => store.set(shellWorkspaceAtom, (ws) => openTab(ws, sessionKey(ONE))))
  expect(store.get(agentsSelectionAtom)).toEqual(ONE)
})

test("a new chat from the Agents home takes the home tab's place", () => {
  const { store } = setup()
  act(() => store.set(agentsSelectionAtom, { owner: "chat", id: "new" }))
  expect(focusedPane(store.get(shellWorkspaceAtom)).active).toBe(
    AGENTS_HOME_KEY
  )
  act(() => store.set(agentsSelectionAtom, { ...ONE }))
  expect(focusedPane(store.get(shellWorkspaceAtom)).tabs).toEqual([
    sessionKey(ONE),
  ])
})
