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
import { useMemo, useState } from 'react'
import { columnFor, isOverdue, openingStatus, type Task } from '@holi/shared'
import { useAtom, useAtomValue, useSetAtom } from 'jotai'
import {
  LayoutGridIcon,
  ListIcon,
  ListTodoIcon,
  PencilIcon,
  PlusIcon,
  SquareKanbanIcon,
  TableIcon,
} from 'lucide-react'

import { Button } from '@/components/ui/button'
import { TabsContent } from '@/components/ui/tabs'
import { EMPTY_PLANNING_FILTER, groupByStatus, matchesPlanningFilter } from '@/lib/planning'
import { nowAtom, todayAtom } from '@/state/clock'
import { memberLoginsAtom } from '@/state/members'
import {
  planningFilterAtom,
  planningSortAtom,
  planningTabAtom,
  projectFileAtom,
  retryPlanningFilesAtom,
  saveProjectAtom,
  statusesAtom,
  type PlanningTab,
} from '@/state/planning'
import { createTaskAtom, setTaskStatusAtom, taskTagsAtom, tasksAtom } from '@/state/tasks'
import { activeRemoteAtom, snapshotLoadedAtom, vaultsAtom } from '@/state/vaults'
import { TaskGridView } from './grid/task-grid-view'
import { KanbanBoard } from './board/kanban-board'
import { Navbar } from './navbar/planning-navbar'
import { EditProjectDialog } from './edit-project-dialog'
import { NewTaskDialog, type NewTaskInput } from './new-task-dialog'
import { Overview, type ProjectState } from './overview'
import { ProjectStatusBadge } from './task-bits'
import { usePlanningNotices } from './planning-notices'
import { reportError } from './report-error'
import { NoMatches, RegionEmpty, TasksSkeleton } from './states'
import { usePlanningBoardDrag } from './use-planning-board-drag'
import { PanelBody } from './panel-body'
import { PlanningToolbar } from './planning-toolbar'

const TABS: { value: PlanningTab; label: string; icon: React.ReactNode }[] = [
  {
    value: 'overview',
    label: 'Overview',
    icon: <LayoutGridIcon aria-hidden="true" />,
  },
  {
    value: 'board',
    label: 'Board',
    icon: <SquareKanbanIcon aria-hidden="true" />,
  },
  { value: 'list', label: 'List', icon: <ListIcon aria-hidden="true" /> },
  { value: 'table', label: 'Table', icon: <TableIcon aria-hidden="true" /> },
]

export function PlanningView({
  onOpenTask,
}: {
  /** Opens a vault path the way the shell opens a document. */
  onOpenTask: (path: string) => void
}) {
  const remote = useAtomValue(activeRemoteAtom)
  const vaults = useAtomValue(vaultsAtom)
  const taskMap = useAtomValue(tasksAtom)
  const loaded = useAtomValue(snapshotLoadedAtom)
  const statuses = useAtomValue(statusesAtom)
  const projectFile = useAtomValue(projectFileAtom)
  const people = useAtomValue(memberLoginsAtom)
  const tags = useAtomValue(taskTagsAtom)
  const now = useAtomValue(nowAtom)
  const today = useAtomValue(todayAtom)
  const [tab, setTab] = useAtom(planningTabAtom)
  const [filter, setFilter] = useAtom(planningFilterAtom)
  const [sort, setSort] = useAtom(planningSortAtom)
  const createTask = useSetAtom(createTaskAtom)
  const setStatus = useSetAtom(setTaskStatusAtom)
  const saveProject = useSetAtom(saveProjectAtom)
  const retryFiles = useSetAtom(retryPlanningFilesAtom)

  const [newTask, setNewTask] = useState<{ status: string } | null>(null)
  const [editingProject, setEditingProject] = useState(false)

  const vaultName =
    vaults.find((v) => v.remote === remote)?.name ?? remote?.split('/').at(-1) ?? 'Vault'
  const project = projectFile.state === 'ready' ? projectFile.value : undefined
  const projectState: ProjectState =
    projectFile.state === 'ready' ? { state: 'ready', project: projectFile.value } : projectFile

  const tasks = useMemo(() => [...taskMap.values()], [taskMap])
  const shown = useMemo(
    () => tasks.filter((t) => matchesPlanningFilter(t, filter)),
    [tasks, filter],
  )
  const resting = useMemo(() => groupByStatus(shown, statuses, sort), [shown, statuses, sort])
  const board = usePlanningBoardDrag({ taskMap, statuses, sort, resting })
  const assigned = useMemo(() => [...new Set(tasks.flatMap((t) => t.assignees))], [tasks])
  const overdue = (task: Task) =>
    task.due !== undefined &&
    columnFor(statuses, task.status).category !== 'completed' &&
    isOverdue(task.due, now)

  const addTask = async (status: string, title: string) => {
    try {
      await createTask({ title, status, folder: '' })
    } catch (err) {
      reportError('The task could not be created')(err)
      throw err
    }
  }

  const createFromDialog = async (input: NewTaskInput) => {
    const path = await createTask(input)
    if (path) onOpenTask(path)
  }

  const moveTo = (task: Task, status: string) => {
    setStatus(task.path, status).catch(reportError('The task could not be moved'))
  }

  const openNewTask = (status = openingStatus(statuses).id) => setNewTask({ status })

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

  const notices = usePlanningNotices()

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
    <NoMatches search={filter.search} onClear={() => setFilter(EMPTY_PLANNING_FILTER)} />
  )

  const panel = 'flex min-h-0 flex-1 flex-col'

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col" data-planning-view>
      <Navbar
        title="Board"
        status={project !== undefined ? <ProjectStatusBadge status={project.status} /> : null}
        actions={
          <Button variant="ghost" size="sm" onClick={() => setEditingProject(true)}>
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
              onShowStatus={() => setTab('list')}
              onNewTask={() => openNewTask()}
            />
          </PanelBody>
        </TabsContent>

        <TabsContent value="board" className={panel}>
          {toolbar()}
          <PanelBody>
            {notices}
            {!loaded ? (
              <TasksSkeleton variant="board" />
            ) : noTasks ? (
              noTasksYet
            ) : noMatches ? (
              nothingMatches
            ) : (
              <KanbanBoard
                statuses={statuses}
                {...board}
                context={{ today, isOverdue: overdue, onOpenTask }}
                onAddTask={addTask}
              />
            )}
          </PanelBody>
        </TabsContent>

        {(['list', 'table'] as const).map((variant) => (
          <TabsContent key={variant} value={variant} className={panel}>
            {!loaded || noTasks ? (
              <>
                {toolbar()}
                <PanelBody>
                  {loaded ? notices : null}
                  {loaded ? noTasksYet : <TasksSkeleton variant="rows" />}
                </PanelBody>
              </>
            ) : (
              <TaskGridView
                variant={variant}
                groups={resting}
                toolbar={toolbar}
                notices={notices ?? undefined}
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
          project={project ?? { status: 'planning', milestones: [], about: '' }}
          fallbackName={vaultName}
          people={people}
          onSave={saveProject}
        />
      ) : null}
    </div>
  )
}
