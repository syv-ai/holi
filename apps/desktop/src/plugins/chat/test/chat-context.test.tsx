/**
 * An app as a chat's context: a chip above the composer's text, put there by
 * an app card's Ask about this app (in split view beside the Apps page) or
 * picked from `@`, and sent to Claude Code as an `@` reference to its
 * bundle, as a vault document is.
 */
import userEvent from "@testing-library/user-event"
import { createStore, Provider } from "jotai"
import { beforeEach, expect, test, vi } from "vitest"
import { emptyVaultSnapshot, type VaultSnapshot } from "@holi/shared"

import { TooltipProvider } from "@/components/ui/tooltip"
import {
  activeRemoteAtom,
  agentsSelectionAtom,
  snapshotAtom,
  vaultsAtom,
} from "@/plugin-api"
import { render, screen, within } from "@/test/render"
import { ChatMain } from "../renderer/ChatMain"
import { contextLine, withContext } from "../renderer/context"
import { contextsAtom, startChatAtom } from "../renderer/state/chats"

const cap = vi.hoisted(() => ({
  commands: vi.fn(),
  where: vi.fn(),
  start: vi.fn(),
  send: vi.fn(),
  transcript: vi.fn(),
  list: vi.fn(),
}))
// The vault's apps, as the registry's `app` surface lists them: what the
// apps plugin registers, stood in for here.
const surfaces = vi.hoisted(() => ({ atom: null as unknown }))
vi.mock("@/plugin-api", async (original) => {
  const api = await original<typeof import("@/plugin-api")>()
  const { atom } = await import("jotai")
  surfaces.atom = atom(
    new Map([
      [
        "app",
        {
          kind: "app",
          label: (id?: string) =>
            (id ?? "App").replace(/^.*\//, "").replace(/\.app$/, ""),
          icon: () => <svg data-testid="app-icon" />,
          render: () => null,
          instances: atom(["Finance/Budget.app"]),
        },
      ],
    ])
  )
  return { ...api, surfacesAtom: surfaces.atom }
})
vi.mock("../renderer/chat-cap", () => ({
  chatCap: cap,
  agentTurnsCap: { turns: async () => [] },
}))

beforeEach(() => {
  cap.commands.mockReset().mockResolvedValue([])
  cap.where.mockReset().mockResolvedValue({ branch: "main" })
  cap.start.mockReset().mockResolvedValue({ ok: true, id: "c1" })
  cap.transcript.mockReset().mockResolvedValue([])
  cap.list.mockReset().mockResolvedValue([])
})

const BUDGET = {
  kind: "app" as const,
  path: "Finance/Budget.app",
  name: "Budget",
}

function vaultStore() {
  const store = createStore()
  store.set(activeRemoteAtom, "mara/notes")
  store.set(vaultsAtom, [
    { remote: "mara/notes", path: "/v", name: "notes", lastOpenedAt: "" },
  ] as never)
  const files = ["index.html", "app.yaml"].map((f) => ({
    path: `${BUDGET.path}/${f}`,
    updatedAt: "2026-10-01T00:00:00Z",
  }))
  store.set(snapshotAtom, {
    ...emptyVaultSnapshot(),
    docs: [
      {
        path: "Ideas.md",
        updatedAt: "2026-10-21T10:00:00Z",
        kind: "note",
      },
    ],
    files,
  } as unknown as VaultSnapshot)
  return store
}

function mountNew(store = vaultStore()) {
  render(
    <Provider store={store}>
      <TooltipProvider>
        <ChatMain id="new" />
      </TooltipProvider>
    </Provider>
  )
  return store
}

test("an app goes to Claude Code as a line naming its bundle, ahead of the message", () => {
  expect(contextLine(BUDGET)).toBe(
    "This is about the vault app “Budget”, the folder @Finance/Budget.app (its page is index.html, its manifest app.yaml)."
  )
  expect(withContext("What does it show?", [BUDGET])).toBe(
    `${contextLine(BUDGET)}\n\nWhat does it show?`
  )
  // A path with a space is quoted the way Claude Code reads it.
  expect(contextLine({ ...BUDGET, path: "My Apps/Budget.app" })).toContain(
    '@"My Apps/Budget.app"'
  )
  expect(withContext("Hi", [])).toBe("Hi")
})

test("a start with no text opens the new-session page with the app as a chip", async () => {
  const store = vaultStore()
  const res = await store.set(startChatAtom, { text: "", context: [BUDGET] })
  expect(res).toEqual({ ok: true })
  expect(cap.start).not.toHaveBeenCalled()
  expect(store.get(agentsSelectionAtom)).toMatchObject({
    owner: "chat",
    id: "new",
  })

  const user = userEvent.setup()
  mountNew(store)
  const chips = screen.getByRole("list", { name: "Context" })
  expect(within(chips).getByText("Budget")).toBeInTheDocument()
  expect(within(chips).getByTestId("app-icon")).toBeInTheDocument()

  const box = screen.getByRole("textbox", { name: "Message Claude Code" })
  await user.type(box, "What does it show?{Enter}")
  expect(cap.start).toHaveBeenCalledWith("mara/notes", {
    text: `${contextLine(BUDGET)}\n\nWhat does it show?`,
    mode: "default",
  })
  // Sent: the chip goes with the draft.
  await vi.waitFor(() =>
    expect(screen.queryByRole("list", { name: "Context" })).toBeNull()
  )
})

test("a chip's Remove takes the app out of the message", async () => {
  const user = userEvent.setup()
  const store = vaultStore()
  store.set(contextsAtom, { new: [BUDGET] })
  mountNew(store)
  await user.click(screen.getByRole("button", { name: "Remove Budget" }))
  expect(screen.queryByRole("list", { name: "Context" })).toBeNull()
  await user.type(
    screen.getByRole("textbox", { name: "Message Claude Code" }),
    "Hi{Enter}"
  )
  expect(cap.start).toHaveBeenCalledWith("mara/notes", {
    text: "Hi",
    mode: "default",
  })
})

test("@ lists the vault's apps beside its documents, and picking one makes a chip", async () => {
  const user = userEvent.setup()
  mountNew()
  const box = screen.getByRole("textbox", { name: "Message Claude Code" })
  await user.type(box, "Fix @bud")
  const menu = screen.getByRole("listbox", { name: "Vault documents" })
  expect(within(menu).getByRole("option").textContent).toContain("Budget.app")
  await user.keyboard("{Enter}")
  // The typed `@bud` goes; the app is a chip instead.
  expect((box as HTMLTextAreaElement).value).toBe("Fix ")
  expect(
    within(screen.getByRole("list", { name: "Context" })).getByText("Budget")
  ).toBeInTheDocument()
})
