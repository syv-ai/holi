/**
 * The transcript draws what the reducer folded from captured Claude Code
 * runs: steps that open into their results, inline diffs, the todo list,
 * the plan card with Claude Code's own approval, a subagent's steps under
 * its call, thinking, and images in a reply.
 */
import userEvent from "@testing-library/user-event"
import { Provider, createStore } from "jotai"
import { beforeEach, expect, test, vi } from "vitest"

import { TooltipProvider } from "@/components/ui/tooltip"
import { activeRemoteAtom } from "@/plugin-api"
import { render, screen, within } from "@/test/render"
import type { TranscriptItem } from "../shared/chat"
import { Markdown } from "../renderer/Markdown"
import { ConversationView } from "../renderer/ConversationView"
import { Transcript } from "../renderer/Transcript"
import { replay } from "./replay"

const cap = vi.hoisted(() => ({ answer: vi.fn(), conversation: vi.fn() }))
vi.mock("../renderer/chat-cap", () => ({
  chatCap: cap,
  agentTurnsCap: { turns: async () => [] },
}))

beforeEach(() => {
  cap.answer.mockReset().mockResolvedValue({ ok: true, id: "c1" })
})

function mount(items: TranscriptItem[], readOnly = false) {
  const store = createStore()
  store.set(activeRemoteAtom, "mara/notes")
  render(
    <Provider store={store}>
      <TooltipProvider>
        <Transcript
          chatId="c1"
          title="A chat"
          items={items}
          readOnly={readOnly}
        />
      </TooltipProvider>
    </Provider>
  )
}

test("a command opens into its output; a failed one is open already", async () => {
  const user = userEvent.setup()
  const { items } = replay("tools")
  mount(items)
  const ls = screen.getByRole("button", {
    name: /List files in the repo directory/,
  })
  expect(ls.getAttribute("aria-expanded")).toBe("false")
  expect(screen.queryByText(/drwxr-xr-x/)).toBeNull()
  await user.click(ls)
  expect(ls.getAttribute("aria-expanded")).toBe("true")
  expect(screen.getByLabelText("Output").textContent).toContain("calc.py")
  expect(screen.getByText("$ ls -la")).toBeTruthy()

  const failed = screen.getByRole("button", {
    name: /Attempt to read a missing file/,
  })
  expect(failed.getAttribute("aria-expanded")).toBe("true")
  expect(screen.getByText("Exit 1")).toBeTruthy()
})

test("an edit shows its diff under the step, a new file as all added", () => {
  const { items } = replay("tools")
  mount(items)
  const edit = within(
    screen.getByRole("group", { name: "Changes to notes.md" })
  )
  expect(
    edit
      .getByText("Beta line", { selector: "span" })
      .closest("[data-diff-line]")
      ?.getAttribute("data-diff-line")
  ).toBe("del")
  const created = screen.getByRole("group", { name: "Changes to hello.txt" })
  expect(
    [...created.querySelectorAll("[data-diff-line]")].map((l) =>
      l.getAttribute("data-diff-line")
    )
  ).toEqual(["add", "add"])
  expect(screen.getByText("New file")).toBeTruthy()
})

test("a read opens into its numbered lines", async () => {
  const user = userEvent.setup()
  const { items } = replay("tools")
  mount(items)
  await user.click(screen.getByRole("button", { name: /^Read notes\.md/ }))
  const lines = screen.getByRole("group", { name: "Lines read from notes.md" })
  expect(lines.textContent).toContain("4Beta line")
  expect(screen.getByText("Lines 1–10 of 11")).toBeTruthy()
})

test("the todo list is one card, its count on the turn's header", () => {
  const { items } = replay("synth-todos")
  mount(items)
  expect(document.querySelectorAll("[data-todos]")).toHaveLength(1)
  const list = screen.getByRole("list", { name: "Todo list" })
  expect(within(list).getAllByRole("listitem")).toHaveLength(3)
  expect(screen.getByLabelText("Todo list: All done")).toBeTruthy()
})

test("a pending plan offers Approve and Keep planning, answered as Claude Code's prompt", async () => {
  const user = userEvent.setup()
  const items = replay("plan").items.map((i) =>
    i.kind === "plan" ? { ...i, status: "pending" as const } : i
  )
  const plan = items.find((i) => i.kind === "plan")!
  mount(items)
  const card = screen.getByLabelText("Plan")
  expect(within(card).getByText("Waiting for you")).toBeTruthy()
  expect(card.textContent).toContain("Plan: add divide to calc.py")
  // Claude Code offered no mode switch, so there is none to take.
  expect(
    within(card).queryByRole("button", { name: "Approve and accept edits" })
  ).toBeNull()

  await user.click(within(card).getByRole("button", { name: "Keep planning" }))
  await user.type(
    within(card).getByRole("textbox", { name: "A note for Claude Code" }),
    "Add tests first"
  )
  await user.click(within(card).getByRole("button", { name: "Keep planning" }))
  expect(cap.answer).toHaveBeenCalledWith("mara/notes", {
    id: "c1",
    requestId: plan.kind === "plan" ? plan.requestId : "",
    answer: { kind: "deny", message: "Add tests first" },
  })
})

test("Approve and accept edits shows only when Claude Code offers the switch", async () => {
  const user = userEvent.setup()
  const items = replay("plan").items.map((i) =>
    i.kind === "plan"
      ? { ...i, status: "pending" as const, canAcceptEdits: true }
      : i
  )
  mount(items)
  await user.click(
    screen.getByRole("button", { name: "Approve and accept edits" })
  )
  expect(cap.answer.mock.calls[0]![1].answer).toEqual({
    kind: "allow",
    mode: "acceptEdits",
  })
})

test("a read-only transcript asks nothing", () => {
  const items = replay("plan").items.map((i) =>
    i.kind === "plan" ? { ...i, status: "pending" as const } : i
  )
  mount(items, true)
  expect(screen.queryByRole("button", { name: "Approve" })).toBeNull()
})

test("a subagent's steps hang under its call, folded once it is done", async () => {
  const user = userEvent.setup()
  const { items } = replay("agent")
  mount(items)
  const agent = screen.getByRole("button", {
    name: /List function names in calc\.py/,
  })
  expect(agent.textContent).toContain("general-purpose · 2 steps")
  expect(agent.getAttribute("aria-expanded")).toBe("false")
  await user.click(agent)
  const group = document.querySelector("[data-subagent]")!
  expect(within(group as HTMLElement).getByText("add, sub, mul")).toBeTruthy()
  expect(
    within(group as HTMLElement).getByRole("button", {
      name: /Locate calc\.py/,
    })
  ).toBeTruthy()
})

test("thinking with text opens; thinking kept private is a timed line", async () => {
  const user = userEvent.setup()
  const { items } = replay("synth-events")
  mount(items)
  const thought = screen.getByRole("button", { name: /Thought for 3s/ })
  await user.click(thought)
  expect(screen.getByText(/17 \+ 25 is 42/)).toBeTruthy()
  expect(
    screen.getByText("Retrying the request (attempt 2 of 10)")
  ).toBeTruthy()
})

test("plan mode, compaction and a stop read as status lines", () => {
  mount([
    ...replay("enterplan").items,
    ...replay("thinking").items,
    ...replay("interrupt").items,
  ])
  expect(screen.getByText("Entered plan mode")).toBeTruthy()
  expect(screen.getByText("Exited plan mode")).toBeTruthy()
  expect(screen.getByText("Context compacted")).toBeTruthy()
  expect(screen.getByText("Stopped")).toBeTruthy()
})

test("a reply's vault image loads through the vault route; HTML stays text", () => {
  render(
    <Markdown
      text={
        "![chart](Assets/chart.png) ![x](file:///etc/passwd) <img src=x onerror=alert(1)>"
      }
    />
  )
  const img = screen.getByRole("img", { name: "chart" })
  expect(img.getAttribute("src")).toBe("holi-vault://vault/Assets/chart.png")
  expect(screen.queryByRole("img", { name: "x" })).toBeNull()
  expect(document.body.textContent).toContain("<img src=x onerror=alert(1)>")
})

test("a background run's conversation reads as a chat's, asking nothing", async () => {
  cap.conversation.mockResolvedValue(replay("agent").items)
  const store = createStore()
  store.set(activeRemoteAtom, "mara/notes")
  render(
    <Provider store={store}>
      <TooltipProvider>
        <ConversationView conversationId="a80e3af2" live={false} title="Run" />
      </TooltipProvider>
    </Provider>
  )
  expect(
    await screen.findByRole("button", { name: /List function names/ })
  ).toBeTruthy()
  expect(cap.conversation).toHaveBeenCalledWith("mara/notes", {
    conversationId: "a80e3af2",
    live: false,
  })
})

test("a conversation Claude Code has not written yet says so, with Retry", async () => {
  cap.conversation.mockResolvedValue(null)
  const store = createStore()
  store.set(activeRemoteAtom, "mara/notes")
  render(
    <Provider store={store}>
      <ConversationView conversationId="a80e3af2" live={false} title="Run" />
    </Provider>
  )
  expect(await screen.findByRole("alert")).toBeTruthy()
  expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy()
})
