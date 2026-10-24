/**
 * An open task's chips write its file: a field is a patch, saved after the
 * editor's pending write, and a project is a move whose new path is reported.
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
import { render, screen, waitFor } from "@/test/render"
import { nowAtom } from "@/state/clock"
import { statusesFileAtom } from "@/state/planning"
import { activeRemoteAtom, snapshotAtom } from "@/state/vaults"
import { TaskProperties } from "../task-properties"

const update = vi.fn()
const move = vi.fn()

const TASK: Task = {
  path: "task.write-brief.md",
  title: "Write the brief",
  status: "todo",
  tags: [],
  assignees: [],
  description: "",
}

function snapshotOf(tasks: Task[]): VaultSnapshot {
  return {
    ...emptyVaultSnapshot(),
    dirs: ["web", ".holi"],
    claimed: { tasks: { items: tasks, broken: [] } },
  }
}

vi.mock("@/lib/trpc", () => ({
  trpc: {
    tasks: {
      update: { mutate: (input: unknown) => update(input) },
      move: { mutate: (input: unknown) => move(input) },
    },
    vaults: { snapshot: { query: () => Promise.resolve(snapshotOf([TASK])) } },
    github: {
      collaborators: { query: () => Promise.resolve({ collaborators: [] }) },
    },
  },
}))

afterEach(() => {
  update.mockReset()
  move.mockReset()
})

function setup() {
  const store = createStore()
  store.set(activeRemoteAtom, "syv-ai/site")
  store.set(snapshotAtom, snapshotOf([TASK]))
  store.set(nowAtom, "2026-10-23T12:00")
  store.set(statusesFileAtom, {
    state: "ready",
    value: [...DEFAULT_STATUSES],
    warnings: [],
  })
  const beforeWrite = vi.fn(() => Promise.resolve())
  const onMoved = vi.fn()
  render(
    <Provider store={store}>
      <TaskProperties
        path={TASK.path}
        beforeWrite={beforeWrite}
        onMoved={onMoved}
      />
    </Provider>
  )
  return { beforeWrite, onMoved }
}

test("a priority picked is written, after the editor's pending save", async () => {
  update.mockResolvedValue({})
  const { beforeWrite } = setup()
  await userEvent.click(screen.getByRole("button", { name: "Priority" }))
  await userEvent.click(
    await screen.findByRole("menuitemradio", { name: "High" })
  )
  await waitFor(() =>
    expect(update).toHaveBeenCalledWith({
      remote: "syv-ai/site",
      path: TASK.path,
      patch: { priority: "high" },
    })
  )
  expect(beforeWrite).toHaveBeenCalled()
})

test("a project moves the file into its folder and reports the new path", async () => {
  move.mockResolvedValue({ ...TASK, path: "web/task.write-brief.md" })
  const { onMoved } = setup()
  await userEvent.click(screen.getByRole("button", { name: "Project" }))
  // Dot-folders are Holi's and git's, never a project.
  expect(screen.queryByText(".holi")).not.toBeInTheDocument()
  await userEvent.click(await screen.findByRole("option", { name: "web" }))
  await waitFor(() =>
    expect(move).toHaveBeenCalledWith(
      expect.objectContaining({ path: TASK.path, folder: "web" })
    )
  )
  await waitFor(() =>
    expect(onMoved).toHaveBeenCalledWith(TASK.path, "web/task.write-brief.md")
  )
})

test("a document that is not a task draws no fields", () => {
  const store = createStore()
  store.set(snapshotAtom, snapshotOf([TASK]))
  render(
    <Provider store={store}>
      <TaskProperties
        path="notes/plan.md"
        beforeWrite={() => Promise.resolve()}
      />
    </Provider>
  )
  expect(screen.queryByRole("group", { name: "Task fields" })).toBeNull()
})
