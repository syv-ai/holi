/**
 * The planning view (docs/features/planning.md): the vault as one ongoing
 * project, after gr8r's project page. A header with the project's name,
 * status and people over four tabs: Overview, Board, List and Table.
 *
 * Tasks are the vault's task files and the columns are its statuses
 * (`.holi/statuses.yaml`); every write goes through the same task writes the
 * rest of Holi uses, then the vault is re-read. Nothing here keeps a copy of
 * a task: a drag keeps its arrangement only until its write lands.
 */
import { useMemo, useRef, useState } from "react"
import { columnFor, isOverdue, openingStatus, type Task } from "@holi/shared"
import { useAtom, useAtomValue, useSetAtom } from "jotai"
import {
  FileWarningIcon,
  LayoutGridIcon,
  ListIcon,
  ListTodoIcon,
  PencilIcon,
  PlusIcon,
  SquareKanbanIcon,
  TableIcon,
  TriangleAlertIcon,
} from "lucide-react"
import { toast } from "sonner"

import type { KanbanCommitMeta } from "@/components/reui/kanban"
import {
  Alert,
  AlertAction,
  AlertDescription,
  AlertTitle,
} from "@/components/reui/alert"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { TabsContent } from "@/components/ui/tabs"
import { rankAt } from "@/lib/board-order"
import {
  EMPTY_PLANNING_FILTER,
  groupByStatus,
  matchesPlanningFilter,
} from "@/lib/planning"
import { nowAtom, todayAtom } from "@/state/clock"
import { memberLoginsAtom } from "@/state/members"
import {
  planningFilterAtom,
  planningSortAtom,
  planningTabAtom,
  projectFileAtom,
  retryPlanningFilesAtom,
  saveProjectAtom,
  statusesAtom,
  statusesFileAtom,
  type PlanningTab,
} from "@/state/planning"
import {
  brokenTasksAtom,
  createTaskAtom,
  patchTaskAtom,
  rankTasksAtom,
  setTaskStatusAtom,
  taskTagsAtom,
  tasksAtom,
} from "@/state/tasks"
import {
  activeRemoteAtom,
  loadSnapshotAtom,
  snapshotLoadedAtom,
  vaultsAtom,
} from "@/state/vaults"
import { TaskGridView } from "./grid/task-grid-view"
import { KanbanBoard } from "./board/kanban-board"
import { Navbar } from "./navbar/planning-navbar"
import { EditProjectDialog } from "./edit-project-dialog"
import { NewTaskDialog, type NewTaskInput } from "./new-task-dialog"
import { Overview, ProjectStatusBadge, type ProjectState } from "./overview"
import { NoMatches, RegionEmpty } from "./states"
import { PanelBody, PlanningToolbar } from "./planning-toolbar"

type Columns = Record<string, Task[]>

const TABS: { value: PlanningTab; label: string; icon: React.ReactNode }[] = [
  {
    value: "overview",
    label: "Overview",
    icon: <LayoutGridIcon aria-hidden="true" />,
  },
  {
    value: "board",
    label: "Board",
    icon: <SquareKanbanIcon aria-hidden="true" />,
  },
  { value: "list", label: "List", icon: <ListIcon aria-hidden="true" /> },
  { value: "table", label: "Table", icon: <TableIcon aria-hidden="true" /> },
]

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function BoardSkeleton() {
  return (
    <div className="flex gap-3" role="status" aria-label="Loading tasks">
      {Array.from({ length: 4 }, (_, i) => (
        <div key={i} className="flex w-72 shrink-0 flex-col gap-2">
          <Skeleton className="h-8 w-1/2" />
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-24 w-full" />
        </div>
      ))}
    </div>
  )
}

function GridSkeleton() {
  return (
    <div
      className="flex flex-col gap-2"
      role="status"
      aria-label="Loading tasks"
    >
      {Array.from({ length: 6 }, (_, i) => (
        <Skeleton key={i} className="h-9 w-full" />
      ))}
    </div>
  )
}

export function PlanningView({
  onOpenTask,
}: {
  /** Opens a vault path the way the shell opens a document. */
  onOpenTask: (path: string) => void
}) {
  const remote = useAtomValue(activeRemoteAtom)
  const vaults = useAtomValue(vaultsAtom)
  const taskMap = useAtomValue(tasksAtom)
  const broken = useAtomValue(brokenTasksAtom)
  const loaded = useAtomValue(snapshotLoadedAtom)
  const statuses = useAtomValue(statusesAtom)
  const statusesFile = useAtomValue(statusesFileAtom)
  const projectFile = useAtomValue(projectFileAtom)
  const people = useAtomValue(memberLoginsAtom)
  const tags = useAtomValue(taskTagsAtom)
  const now = useAtomValue(nowAtom)
  const today = useAtomValue(todayAtom)
  const [tab, setTab] = useAtom(planningTabAtom)
  const [filter, setFilter] = useAtom(planningFilterAtom)
  const [sort, setSort] = useAtom(planningSortAtom)
  const createTask = useSetAtom(createTaskAtom)
  const patch = useSetAtom(patchTaskAtom)
  const rankAll = useSetAtom(rankTasksAtom)
  const setStatus = useSetAtom(setTaskStatusAtom)
  const saveProject = useSetAtom(saveProjectAtom)
  const retryFiles = useSetAtom(retryPlanningFilesAtom)
  const reload = useSetAtom(loadSnapshotAtom)

  const [newTask, setNewTask] = useState<{ status: string } | null>(null)
  const [editingProject, setEditingProject] = useState(false)
  /** The board's arrangement while a drag is on, and after a drop until its
   *  writes land; null at rest, when the board is the vault's. */
  const [preview, setPreview] = useState<Columns | null>(null)
  const committing = useRef(false)

  const vaultName =
    vaults.find((v) => v.remote === remote)?.name ??
    remote?.split("/").at(-1) ??
    "Vault"
  const project = projectFile.state === "ready" ? projectFile.value : undefined
  const projectState: ProjectState =
    projectFile.state === "ready"
      ? { state: "ready", project: projectFile.value }
      : projectFile

  const tasks = useMemo(() => [...taskMap.values()], [taskMap])
  const shown = useMemo(
    () => tasks.filter((t) => matchesPlanningFilter(t, filter)),
    [tasks, filter]
  )
  const resting = useMemo(
    () => groupByStatus(shown, statuses, sort),
    [shown, statuses, sort]
  )
  const assigned = useMemo(
    () => [...new Set(tasks.flatMap((t) => t.assignees))],
    [tasks]
  )
  const overdue = (task: Task) =>
    task.due !== undefined &&
    columnFor(statuses, task.status).category !== "completed" &&
    isOverdue(task.due, now)

  const report = (what: string) => (err: unknown) => {
    toast.error(what, { description: message(err) })
  }

  const addTask = async (status: string, title: string) => {
    try {
      await createTask({ title, status, folder: "" })
    } catch (err) {
      report("The task could not be created")(err)
      throw err
    }
  }

  const createFromDialog = async (input: NewTaskInput) => {
    const path = await createTask(input)
    if (path) onOpenTask(path)
  }

  const moveTo = (task: Task, status: string) => {
    setStatus(task.path, status).catch(report("The task could not be moved"))
  }

  /** A drop's writes: the status when the column changed, and the card's
   *  rank among the cards it was dropped between. A sort other than Manual
   *  orders the column itself, so a drop there changes only the status. */
  const commit = async (path: string, column: string, index: number) => {
    const task = taskMap.get(path)
    if (!task) return
    const from = columnFor(statuses, task.status).id
    const newStatus = column !== from ? column : undefined
    const ranks =
      sort === "manual" ? rankAt(resting[column] ?? [], path, index) : null
    const rank = ranks?.at(-1)?.order
    if (newStatus === undefined && rank === undefined) return
    if (ranks && ranks.length > 1) await rankAll(ranks.slice(0, -1))
    await patch(path, {
      ...(newStatus !== undefined ? { status: newStatus } : {}),
      ...(rank !== undefined ? { order: rank } : {}),
    })
  }

  const onCommit = (final: Columns, meta: KanbanCommitMeta<Task>) => {
    if (meta.kind !== "item") return
    committing.current = true
    const column = meta.overContainer
    const path = String(meta.event.active.id)
    const index = (final[column] ?? [])
      .slice(0, meta.overIndex)
      .filter((t) => t.path !== path).length
    void commit(path, column, index)
      .catch(report("The task could not be moved"))
      .finally(() => {
        committing.current = false
        setPreview(null)
      })
  }

  const openNewTask = (status = openingStatus(statuses).id) =>
    setNewTask({ status })

  const noTasks = loaded && tasks.length === 0
  /** Tasks exist, but the search and filters hide every one. */
  const noMatches = loaded && !noTasks && shown.length === 0
  const toolbar = (extra?: React.ReactNode) => (
    <PlanningToolbar
      filter={filter}
      onFilterChange={setFilter}
      sort={sort}
      onSortChange={setSort}
      people={people}
      tags={tags}
      onNewTask={() => openNewTask()}
      extra={extra}
    />
  )

  const hasNotices =
    statusesFile.state === "error" ||
    (statusesFile.state === "ready" && statusesFile.warnings.length > 0) ||
    broken.length > 0
  const notices = (
    <>
      {statusesFile.state === "error" ? (
        <Alert variant="warning">
          <TriangleAlertIcon aria-hidden="true" />
          <AlertTitle>The statuses file could not be read</AlertTitle>
          <AlertDescription>
            Showing the default columns. {statusesFile.message}
          </AlertDescription>
          <AlertAction>
            <Button variant="outline" size="sm" onClick={retryFiles}>
              Retry
            </Button>
          </AlertAction>
        </Alert>
      ) : statusesFile.state === "ready" && statusesFile.warnings.length > 0 ? (
        <Alert variant="warning">
          <TriangleAlertIcon aria-hidden="true" />
          <AlertTitle>
            Part of .holi/statuses.yaml was not understood
          </AlertTitle>
          <AlertDescription>{statusesFile.warnings.join(" ")}</AlertDescription>
        </Alert>
      ) : null}
      {broken.length > 0 ? (
        <Alert variant="destructive">
          <FileWarningIcon aria-hidden="true" />
          <AlertTitle>
            {broken.length} task {broken.length === 1 ? "file" : "files"} could
            not be read
          </AlertTitle>
          <AlertDescription>
            <ul className="flex flex-col gap-0.5">
              {broken.map((b) => (
                <li key={b.path} data-broken-task={b.path}>
                  <span className="font-mono">{b.path}</span>: {b.error}
                </li>
              ))}
            </ul>
          </AlertDescription>
          <AlertAction>
            <Button
              variant="outline"
              size="sm"
              onClick={() =>
                void reload().catch(report("The vault could not be read"))
              }
            >
              Retry
            </Button>
          </AlertAction>
        </Alert>
      ) : null}
    </>
  )

  const noTasksYet = (
    <RegionEmpty
      outlined
      icon={ListTodoIcon}
      title="No tasks yet"
      description="A task is a task.<name>.md file anywhere in the vault. Add the first one here."
      action={
        <Button variant="outline" size="sm" onClick={() => openNewTask()}>
          <PlusIcon data-icon="inline-start" aria-hidden="true" />
          New task
        </Button>
      }
    />
  )
  const nothingMatches = (
    <NoMatches
      search={filter.search}
      onClear={() => setFilter(EMPTY_PLANNING_FILTER)}
    />
  )

  const panel = "flex min-h-0 flex-1 flex-col"

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col" data-planning-view>
      <Navbar
        title="Board"
        status={
          project !== undefined ? (
            <ProjectStatusBadge status={project.status} />
          ) : null
        }
        actions={
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setEditingProject(true)}
          >
            <PencilIcon data-icon="inline-start" aria-hidden="true" />
            Edit project
          </Button>
        }
        tabs={TABS}
        value={tab}
        onValueChange={(value) => setTab(value as PlanningTab)}
        people={people}
      >
        <TabsContent value="overview" className={panel}>
          <PanelBody>
            <Overview
              projectState={projectState}
              fallbackName={vaultName}
              tasks={tasks}
              tasksLoading={!loaded}
              statuses={statuses}
              now={now}
              today={today}
              members={assigned}
              onEditProject={() => setEditingProject(true)}
              onRetryProject={retryFiles}
              onOpenTask={onOpenTask}
              onShowStatus={() => setTab("list")}
              onNewTask={() => openNewTask()}
            />
          </PanelBody>
        </TabsContent>

        <TabsContent value="board" className={panel}>
          {toolbar()}
          <PanelBody>
            {notices}
            {!loaded ? (
              <BoardSkeleton />
            ) : noTasks ? (
              noTasksYet
            ) : noMatches ? (
              nothingMatches
            ) : (
              <KanbanBoard
                statuses={statuses}
                value={preview ?? resting}
                onValueChange={setPreview}
                onValueCommit={onCommit}
                onDragEnd={() => {
                  // A drop that moved nothing commits nothing: back to the
                  // vault's arrangement. One that did waits for its writes.
                  setTimeout(() => {
                    if (!committing.current) setPreview(null)
                  })
                }}
                onDragCancel={() => setPreview(null)}
                context={{ today, isOverdue: overdue, onOpenTask }}
                onAddTask={addTask}
                onNewTask={openNewTask}
              />
            )}
          </PanelBody>
        </TabsContent>

        {(["list", "table"] as const).map((variant) => (
          <TabsContent key={variant} value={variant} className={panel}>
            {!loaded || noTasks ? (
              <>
                {toolbar()}
                <PanelBody>
                  {loaded ? notices : null}
                  {loaded ? noTasksYet : <GridSkeleton />}
                </PanelBody>
              </>
            ) : (
              <TaskGridView
                variant={variant}
                groups={resting}
                toolbar={toolbar}
                notices={hasNotices ? notices : undefined}
                empty={noMatches ? nothingMatches : undefined}
                emptyMessage="No task matches the search or filters."
                statuses={statuses}
                today={today}
                isOverdue={overdue}
                onOpenTask={onOpenTask}
                onSetStatus={moveTo}
                onAddTask={addTask}
              />
            )}
          </TabsContent>
        ))}
      </Navbar>

      {newTask !== null ? (
        <NewTaskDialog
          open
          onOpenChange={(open) => !open && setNewTask(null)}
          statuses={statuses}
          defaultStatus={newTask.status}
          today={today}
          onCreate={createFromDialog}
        />
      ) : null}
      {editingProject ? (
        <EditProjectDialog
          open
          onOpenChange={setEditingProject}
          project={project ?? { status: "planning", milestones: [], about: "" }}
          fallbackName={vaultName}
          people={people}
          onSave={saveProject}
        />
      ) : null}
    </div>
  )
}
