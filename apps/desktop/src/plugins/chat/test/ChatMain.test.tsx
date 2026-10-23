/**
 * The Agents mode's session UI: the new-session page and its composer with
 * `/` and `@`, and a conversation's turns with what they cost.
 */
import userEvent from "@testing-library/user-event"
import { Provider, createStore } from "jotai"
import { beforeEach, expect, test, vi } from "vitest"
import { emptyVaultSnapshot, type VaultSnapshot } from "@holi/shared"

import { TooltipProvider } from "@/components/ui/tooltip"
import { activeRemoteAtom, snapshotAtom, vaultsAtom } from "@/plugin-api"
import { render, screen, within } from "@/test/render"
import type { ChatCommand, TranscriptItem } from "../shared/chat"
import { ChatMain } from "../renderer/ChatMain"
import { usageLines, workedLabel } from "../renderer/Transcript"
import {
  chatsAtom,
  chatsLoadedAtom,
  transcriptsAtom,
} from "../renderer/state/chats"

const COMMANDS: ChatCommand[] = [
  {
    name: "standup",
    kind: "skill",
    scope: "vault",
    description: "Brief me on today",
  },
  {
    name: "compact",
    kind: "builtin",
    scope: "builtin",
    description: "Summarise the conversation",
  },
]

const cap = vi.hoisted(() => ({
  commands: vi.fn(),
  where: vi.fn(),
  start: vi.fn(),
  send: vi.fn(),
  transcript: vi.fn(),
}))
vi.mock("../renderer/chat-cap", () => ({
  chatCap: cap,
  agentTurnsCap: { turns: async () => [] },
}))

beforeEach(() => {
  cap.commands.mockReset().mockResolvedValue(COMMANDS)
  cap.where.mockReset().mockResolvedValue({ branch: "main" })
  cap.start.mockReset().mockResolvedValue({ ok: true, id: "c1" })
  cap.transcript.mockReset().mockResolvedValue([])
})

function snapshot(): VaultSnapshot {
  const doc = (path: string, updatedAt: string) =>
    ({ path, updatedAt, kind: "note" }) as VaultSnapshot["docs"][number]
  return {
    ...emptyVaultSnapshot(),
    docs: [
      doc("Meetings/Week kickoff.md", "2026-10-22T10:00:00Z"),
      doc("Ideas.md", "2026-10-21T10:00:00Z"),
    ],
  }
}

function mount(
  id = "new",
  prepare?: (store: ReturnType<typeof createStore>) => void
) {
  const store = createStore()
  store.set(activeRemoteAtom, "mara/notes")
  store.set(vaultsAtom, [
    { remote: "mara/notes", path: "/v", name: "notes", lastOpenedAt: "" },
  ] as never)
  store.set(snapshotAtom, snapshot())
  prepare?.(store)
  render(
    <Provider store={store}>
      <TooltipProvider>
        <ChatMain id={id} />
      </TooltipProvider>
    </Provider>
  )
  return store
}

test("the new-session page asks what to work on, over the composer", async () => {
  mount()
  expect(
    screen.getByRole("heading", { name: "What should we work on in notes?" })
  ).toBeTruthy()
  const box = screen.getByRole("textbox", { name: "Message Claude Code" })
  expect(box.getAttribute("placeholder")).toBe(
    "Ask, build, / for commands, @ for references…"
  )
  // Where it works, honestly: the vault and the clone's branch.
  expect(await screen.findByText("main")).toBeTruthy()
  expect(screen.getAllByText("notes").length).toBeGreaterThan(0)
  expect(screen.getByRole("button", { name: "Model: Default" })).toBeTruthy()
  expect(
    screen.getByRole("button", { name: "Before it acts: Ask first" })
  ).toBeTruthy()
})

test("/ lists the vault's commands and Enter picks one", async () => {
  const user = userEvent.setup()
  mount()
  const box = screen.getByRole("textbox", { name: "Message Claude Code" })
  await user.type(box, "/")
  const menu = await screen.findByRole("listbox", {
    name: "Commands and skills",
  })
  expect(
    within(menu)
      .getAllByRole("option")
      .map((o) => o.textContent)
  ).toEqual([
    expect.stringContaining("/standup"),
    expect.stringContaining("/compact"),
  ])
  await user.type(box, "com")
  expect(within(menu).getAllByRole("option")).toHaveLength(1)
  await user.keyboard("{Enter}")
  expect((box as HTMLTextAreaElement).value).toBe("/compact ")
  expect(screen.queryByRole("listbox")).toBeNull()
  expect(cap.start).not.toHaveBeenCalled()
})

test("Escape closes a menu, and the arrow keys move through it", async () => {
  const user = userEvent.setup()
  mount()
  const box = screen.getByRole("textbox", { name: "Message Claude Code" })
  await user.type(box, "/")
  await screen.findByRole("listbox", { name: "Commands and skills" })
  await user.keyboard("{ArrowDown}")
  expect(screen.getByRole("option", { selected: true }).textContent).toContain(
    "/compact"
  )
  await user.keyboard("{Escape}")
  expect(screen.queryByRole("listbox")).toBeNull()
})

test("@ references a vault document as Claude Code reads it", async () => {
  const user = userEvent.setup()
  mount()
  const box = screen.getByRole("textbox", { name: "Message Claude Code" })
  await user.type(box, "Summarise @")
  const menu = screen.getByRole("listbox", { name: "Vault documents" })
  // Most recently changed first.
  expect(within(menu).getAllByRole("option")[0]!.textContent).toContain(
    "Week kickoff.md"
  )
  await user.type(box, "idea")
  await user.keyboard("{Enter}")
  expect((box as HTMLTextAreaElement).value).toBe("Summarise @Ideas.md ")
  await user.clear(box)
  await user.type(box, "@week")
  await user.keyboard("{Tab}")
  expect((box as HTMLTextAreaElement).value).toBe(
    '@"Meetings/Week kickoff.md" '
  )
})

test("Enter sends the first message, Shift+Enter is a new line", async () => {
  const user = userEvent.setup()
  mount()
  const box = screen.getByRole("textbox", { name: "Message Claude Code" })
  await user.type(box, "Brief me{Shift>}{Enter}{/Shift}on today{Enter}")
  expect(cap.start).toHaveBeenCalledWith("mara/notes", {
    text: "Brief me\non today",
    mode: "default",
  })
})

const ITEMS: TranscriptItem[] = [
  { kind: "user", id: "u1", text: "What is on today?", at: 1_000 },
  {
    kind: "turn",
    id: "t1",
    startedAt: 1_000,
    endedAt: 7_000,
    model: "claude-opus-5-5",
    usage: {
      inputTokens: 2,
      outputTokens: 22,
      cacheReadTokens: 12_700,
      cacheHitPercent: 39,
    },
  },
  {
    kind: "tool",
    id: "x1",
    tool: "Read",
    toolKind: "read",
    title: "Read",
    active: "Reading",
    subject: "Daily/2026-10-23.md",
    status: "done",
  },
  {
    kind: "assistant",
    id: "a1",
    text: "Two meetings and a **draft**.",
    streaming: false,
  },
]

test("a turn says who worked and for how long, then what to do with it", async () => {
  mount("c1", (store) => {
    store.set(chatsLoadedAtom, true)
    store.set(chatsAtom, [
      {
        id: "c1",
        title: "What is on today?",
        mode: "default",
        state: "idle",
        createdAt: 1,
        updatedAt: 1,
        endedAt: 7_000,
        archived: false,
        reviewed: true,
        alive: false,
      },
    ])
    store.set(transcriptsAtom, { c1: ITEMS })
  })
  expect(screen.getByText("Opus 5.5 worked for 6s")).toBeTruthy()
  expect(
    screen.getByText("What is on today?", { selector: "div" })
  ).toBeTruthy()
  expect(screen.getByText("Daily/2026-10-23.md")).toBeTruthy()
  expect(screen.getByRole("button", { name: "Copy reply" })).toBeTruthy()
  expect(screen.getByRole("button", { name: "Save as document" })).toBeTruthy()
  expect(
    screen.getByRole("button", {
      name: /^Turn usage: Cache hit 39% · Output 4 tok\/s/,
    })
  ).toBeTruthy()
  // The picker names the model the last turn ran on.
  expect(screen.getByRole("button", { name: "Model: Opus 5.5" })).toBeTruthy()
})

test("the usage lines read as MonoCode's", () => {
  expect(
    usageLines(
      {
        inputTokens: 2,
        outputTokens: 22,
        cacheReadTokens: 12_700,
        cacheHitPercent: 39.2,
      },
      6_000
    )
  ).toEqual({
    headline: "Cache hit 39% · Output 4 tok/s",
    detail: "2 input · 22 output · 12.7k cached",
  })
  expect(workedLabel(6_000)).toBe("Worked for 6s")
  expect(workedLabel(72_000, "claude-sonnet-4-5", false)).toBe(
    "Sonnet 4.5 working for 1m 12s"
  )
})
