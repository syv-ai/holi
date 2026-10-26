/**
 * The planning view against a vault held in a store: the board draws the
 * vault's statuses as columns, shows a task whose status the vault does not
 * list, and every tab reaches the same tasks.
 */
import {
  DEFAULT_STATUSES,
  emptyVaultSnapshot,
  type Task,
  type VaultSnapshot,
} from "@holi/shared"
import userEvent from "@testing-library/user-event"
import { createStore, Provider } from "jotai"
import { afterEach, expect, test, vi } from "vitest"
import { render, screen, waitFor, within } from "@/test/render"
import { nowAtom } from "@/state/clock"
import {
  planningTabAtom,
  projectFileAtom,
  statusesFileAtom,
} from "@/state/planning"
import { activeRemoteAtom, snapshotAtom, vaultsAtom } from "@/state/vaults"
import { PlanningView } from "../planning-view"

// Base UI's scroll area asks the viewport for its running animations, which
// jsdom does not implement.
Element.prototype.getAnimations ??= () => []

const activity = vi.fn()
const update = vi.fn()

vi.mock("@/lib/trpc", () => ({
  trpc: {
    history: { activity: { query: () => activity() } },
    // The tasks plugin's verbs, as `capClient` sends them.
    cap: {
      run: {
        mutate: ({ remote, name, paramsJson }: { remote: string; name: string; paramsJson?: string }) => {
          const params = paramsJson === undefined ? {} : JSON.parse(paramsJson)
          return name === "tasks.update" ? update({ remote, ...params }) : Promise.resolve(null)
        },
      },
    },
    vaults: { snapshot: { query: () => Promise.resolve(snapshotOf(TASKS)) } },
    github: {
      collaborators: { query: () => Promise.resolve({ collaborators: [] }) },
    },
  },
}))

const task = (path: string, fields: Partial<Task>): Task => ({
  path,
  title: path.replace(/^.*task\.|\.md$/g, ""),
  status: "todo",
  tags: [],
  assignees: [],
  description: "",
  ...fields,
})

const TASKS: Task[] = [
  task("task.write-brief.md", {
    title: "Write the brief",
    status: "doing",
    priority: "urgent",
    due: "2026-10-20",
    estimate: "2d",
    tags: ["copy"],
    assignees: ["ada"],
  }),
  task("task.ship.md", { title: "Ship it", status: "done" }),
  task("task.blocked.md", { title: "Waiting on legal", status: "blocked" }),
]

function snapshotOf(tasks: Task[]): VaultSnapshot {
  return {
    ...emptyVaultSnapshot(),
    claimed: { tasks: { items: tasks, broken: [] } },
  }
}

function setup(tab: "board" | "list" | "overview" = "board") {
  const store = createStore()
  store.set(activeRemoteAtom, "syv-ai/site")
  store.set(vaultsAtom, [
    {
      remote: "syv-ai/site",
      path: "/v",
      name: "site",
      lastOpenedAt: "2026-10-01",
    },
  ])
  store.set(snapshotAtom, snapshotOf(TASKS))
  store.set(nowAtom, "2026-10-23T12:00")
  store.set(statusesFileAtom, {
    state: "ready",
    value: [...DEFAULT_STATUSES],
    warnings: [],
  })
  store.set(projectFileAtom, {
    state: "ready",
    value: {
      name: "Website relaunch",
      status: "active",
      lead: "ada",
      due: "2026-12-15",
      milestones: [{ name: "Launch", date: "2026-12-01" }],
      about: "Rebuild the site.",
    },
    warnings: [],
  })
  store.set(planningTabAtom, tab)
  const onOpenTask = vi.fn()
  render(
    <Provider store={store}>
      <PlanningView onOpenTask={onOpenTask} />
    </Provider>
  )
  return { store, onOpenTask }
}

afterEach(() => {
  activity.mockReset()
  update.mockReset()
})

test("the board has a column per status, and a card in each task’s column", () => {
  activity.mockResolvedValue([])
  setup("board")
  expect(
    screen.getByRole("heading", { level: 1, name: "Board" })
  ).toBeInTheDocument()
  for (const name of ["Backlog", "To do", "In progress", "Review", "Done"]) {
    expect(
      screen.getByRole("region", { name: `${name} tasks` })
    ).toBeInTheDocument()
  }
  const doing = screen.getByRole("region", { name: "In progress tasks" })
  expect(within(doing).getByText("Write the brief")).toBeInTheDocument()
  expect(within(doing).getByText("Urgent")).toBeInTheDocument()
  expect(within(doing).getByText("2d")).toBeInTheDocument()
  // Overdue: due the 20th, and it is the 23rd.
  expect(within(doing).getByLabelText(/Due .*overdue/)).toBeInTheDocument()
  // A status the vault does not list shows in the first unstarted column.
  const todo = screen.getByRole("region", { name: "To do tasks" })
  expect(within(todo).getByText("Waiting on legal")).toBeInTheDocument()
})

test("a card’s title opens the task", async () => {
  activity.mockResolvedValue([])
  const { onOpenTask } = setup("board")
  await userEvent.click(screen.getByText("Ship it"))
  expect(onOpenTask).toHaveBeenCalledWith("task.ship.md")
})

test("search narrows the board", async () => {
  activity.mockResolvedValue([])
  setup("board")
  await userEvent.type(
    screen.getByRole("textbox", { name: "Search tasks" }),
    "legal"
  )
  expect(screen.queryByText("Write the brief")).not.toBeInTheDocument()
  expect(screen.getByText("Waiting on legal")).toBeInTheDocument()
})

test("a search that hides every task says so, and clears", async () => {
  activity.mockResolvedValue([])
  setup("list")
  const search = screen.getByRole("textbox", { name: "Search tasks" })
  await userEvent.type(search, "zebra")
  expect(screen.getByText("No matching tasks")).toBeInTheDocument()
  expect(screen.getByText(/Nothing matches “zebra”/)).toBeInTheDocument()
  await userEvent.click(screen.getByRole("button", { name: "Clear filters" }))
  expect(search).toHaveValue("")
  expect(screen.getByText("Write the brief")).toBeInTheDocument()
})

test("the list groups by status, and a status menu moves a task", async () => {
  activity.mockResolvedValue([])
  update.mockResolvedValue({})
  setup("list")
  expect(
    screen.getByRole("button", { name: "Collapse In progress" })
  ).toBeInTheDocument()
  await userEvent.click(
    screen.getByRole("button", {
      name: "Status of Write the brief: In progress",
    })
  )
  await userEvent.click(
    await screen.findByRole("menuitemradio", { name: /Review/ })
  )
  await waitFor(() =>
    expect(update).toHaveBeenCalledWith({
      remote: "syv-ai/site",
      path: "task.write-brief.md",
      patch: { status: "review" },
    })
  )
})

test("the overview counts progress by status and lists recent activity", async () => {
  activity.mockResolvedValue([
    {
      commit: {
        sha: "a",
        subject: "Update task.ship.md",
        date: "2026-10-22T10:00:00Z",
        author: "Ada Holm",
        added: 1,
        removed: 0,
      },
      files: ["task.ship.md", "notes/x.md"],
      total: 2,
    },
  ])
  setup("overview")
  expect(screen.getByText("Rebuild the site.")).toBeInTheDocument()
  // One of three tasks is done.
  expect(screen.getByText("33%")).toBeInTheDocument()
  expect(screen.getByText("1 overdue")).toBeInTheDocument()
  expect(screen.getByText("Launch")).toBeInTheDocument()
  expect(await screen.findByText("Ada Holm")).toBeInTheDocument()
  expect(screen.getByRole("button", { name: "Ship it" })).toBeInTheDocument()
})

test("without the project file the overview still renders, and a load error offers Retry", () => {
  activity.mockReturnValue(new Promise(() => {}))
  const { store } = setup("overview")
  store.set(projectFileAtom, { state: "error", message: "EACCES" })
  return waitFor(() => {
    expect(
      screen.getAllByText("The project file could not be read").length
    ).toBeGreaterThan(0)
    expect(
      screen.getAllByRole("button", { name: "Retry" }).length
    ).toBeGreaterThan(0)
  })
})
