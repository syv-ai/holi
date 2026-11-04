/**
 * Overview: the project at a glance, after gr8r's project page. About,
 * Progress and Coming up on the left; Details, Milestones and Recent
 * activity on the right. Everything is read from the vault: the project file,
 * the task files, and git's log.
 */
import { useEffect, useState, type ReactNode } from 'react'
import { columnFor, isOverdue, type Project, type StatusDef, type Task } from '@holi/shared'
import { useAtomValue } from 'jotai'
import {
  CalendarCheckIcon,
  CalendarIcon,
  CircleDotIcon,
  FlagIcon,
  PencilIcon,
  PlusIcon,
  UserIcon,
  UsersIcon,
} from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Frame, FrameHeader, FramePanel, FrameTitle } from '@/components/ui/frame'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { cn } from '@/lib/cn'
import { CATEGORY_DOT, comingUp, daysUntil, progressSummary, shortDate } from '@/lib/planning'
import { relativeTime } from '@/lib/relative-time'
import { trpc } from '@/lib/trpc'
import { historyEpochsAtom } from '@/state/vaults'
import { OverviewStats } from './overview-stats'
import { ActivityTimeline } from './activity-timeline'
import type { ActivityItem } from './activity-data'
import { RegionEmpty, RegionError } from './states'
import { PeopleStack, PersonAvatar } from '@/composites/person-avatar'
import { DateBadge, PriorityBadge, ProjectStatusBadge, StatusBadge } from './task-bits'

/** A titled panel: the Overview's one container. */
function Section({
  title,
  action,
  children,
  className,
}: {
  title: string
  action?: ReactNode
  children: ReactNode
  className?: string
}) {
  return (
    <Frame className={cn('w-full', className)}>
      <FrameHeader className="min-h-9 flex-row items-center justify-between">
        <FrameTitle>{title}</FrameTitle>
        {action}
      </FrameHeader>
      <FramePanel>{children}</FramePanel>
    </Frame>
  )
}

function LinesSkeleton({ lines = 3 }: { lines?: number }) {
  return (
    <div className="flex flex-col gap-2" role="status" aria-label="Loading">
      {Array.from({ length: lines }, (_, i) => (
        <Skeleton key={i} className={cn('h-4', i === lines - 1 ? 'w-2/3' : 'w-full')} />
      ))}
    </div>
  )
}

export type ProjectState =
  { state: 'loading' } | { state: 'error'; message: string } | { state: 'ready'; project: Project }

export interface OverviewProps {
  projectState: ProjectState
  /** The project's name when it has none of its own. */
  fallbackName: string
  tasks: readonly Task[]
  tasksLoading: boolean
  statuses: readonly StatusDef[]
  now: string
  today: string
  /** Everyone some task is assigned to. */
  members: readonly string[]
  onEditProject: () => void
  onRetryProject: () => void
  onOpenTask: (path: string) => void
  onShowStatus: (status: string) => void
  onNewTask: () => void
}

export function Overview({
  projectState,
  tasks,
  tasksLoading,
  statuses,
  now,
  today,
  members,
  onEditProject,
  onRetryProject,
  onOpenTask,
  onShowStatus,
  onNewTask,
}: OverviewProps) {
  const project = projectState.state === 'ready' ? projectState.project : null
  const summary = progressSummary(tasks, statuses, now)
  const soon = comingUp(tasks, statuses)
  const daysLeft = project?.due !== undefined ? daysUntil(today, project.due) : null
  const editButton = (
    <Button variant="ghost" size="sm" onClick={onEditProject}>
      <PencilIcon data-icon="inline-start" aria-hidden="true" />
      Edit
    </Button>
  )

  const projectRegion = (body: (project: Project) => ReactNode, lines = 3) =>
    projectState.state === 'loading' ? (
      <LinesSkeleton lines={lines} />
    ) : projectState.state === 'error' ? (
      <RegionError
        title="The project file could not be read"
        message={projectState.message}
        onRetry={onRetryProject}
      />
    ) : (
      body(projectState.project)
    )

  return (
    <div className="grid w-full max-w-6xl grid-cols-1 gap-6 lg:grid-cols-3">
      <div className="flex min-w-0 flex-col gap-6 lg:col-span-2">
        <Section title="About" action={editButton}>
          {projectRegion((p) =>
            p.about.trim() === '' ? (
              <Quiet>No description yet. Say what this project is for.</Quiet>
            ) : (
              <p className="text-sm leading-relaxed whitespace-pre-wrap">{p.about.trim()}</p>
            ),
          )}
        </Section>

        {tasksLoading ? (
          <Section title="Progress">
            <LinesSkeleton lines={4} />
          </Section>
        ) : (
          <OverviewStats
            title="Progress"
            doneLabel="Tasks done"
            done={summary.done}
            total={summary.total}
            percent={summary.percent}
            meta={
              <>
                {daysLeft !== null && project?.due !== undefined ? (
                  <span className="text-muted-foreground text-sm">
                    {daysLeft >= 0
                      ? `${daysLeft} ${daysLeft === 1 ? 'day' : 'days'} until ${shortDate(project.due, today)}`
                      : `Due ${shortDate(project.due, today)}, ${-daysLeft} ${daysLeft === -1 ? 'day' : 'days'} ago`}
                  </span>
                ) : null}
                {summary.overdue > 0 ? (
                  <Badge variant="destructive-light">{summary.overdue} overdue</Badge>
                ) : null}
              </>
            }
            buckets={summary.byStatus.map(({ status, count }) => ({
              id: status.id,
              label: status.name,
              value: count,
              dotClassName: CATEGORY_DOT[status.category],
            }))}
            onSelectBucket={onShowStatus}
          />
        )}

        <Section title="Coming up">
          {tasksLoading ? (
            <LinesSkeleton />
          ) : soon.length === 0 ? (
            <RegionEmpty
              icon={CalendarCheckIcon}
              title="Nothing scheduled"
              description="Open tasks with a due date show up here, soonest first."
              action={
                <Button variant="outline" size="sm" onClick={onNewTask}>
                  <PlusIcon data-icon="inline-start" aria-hidden="true" />
                  New task
                </Button>
              }
            />
          ) : (
            <ul className="-my-1 flex flex-col">
              {soon.map((task) => (
                <ComingUpRow
                  key={task.path}
                  task={task}
                  statuses={statuses}
                  now={now}
                  today={today}
                  onOpen={() => onOpenTask(task.path)}
                />
              ))}
            </ul>
          )}
        </Section>
      </div>

      <div className="flex min-w-0 flex-col gap-6">
        <Section title="Details">
          {projectRegion(
            (p) => (
              <DetailRows project={p} today={today} members={members} />
            ),
            5,
          )}
        </Section>

        <Section
          title="Milestones"
          action={
            <Button variant="ghost" size="sm" onClick={onEditProject}>
              <PlusIcon data-icon="inline-start" aria-hidden="true" />
              Add
            </Button>
          }
        >
          {projectRegion((p) =>
            p.milestones.length === 0 ? (
              <Quiet>No milestones yet.</Quiet>
            ) : (
              <ul className="flex flex-col gap-2">
                {p.milestones.map((m) => {
                  const passed = m.date < today
                  return (
                    <li key={`${m.date}-${m.name}`} className="flex h-8 items-center gap-3 text-sm">
                      <span
                        aria-hidden="true"
                        className={cn(
                          'size-2.5 shrink-0 rotate-45 rounded-xs',
                          passed ? 'bg-success' : 'bg-primary',
                        )}
                      />
                      <span
                        className={cn('min-w-0 flex-1 truncate', passed && 'text-muted-foreground')}
                      >
                        {m.name}
                      </span>
                      <span className="text-muted-foreground text-xs tabular-nums">
                        {shortDate(m.date, today)}
                      </span>
                    </li>
                  )
                })}
              </ul>
            ),
          )}
        </Section>

        <RecentActivity tasks={tasks} onOpen={onOpenTask} />
      </div>
    </div>
  )
}

function ComingUpRow({
  task,
  statuses,
  now,
  today,
  onOpen,
}: {
  task: Task
  statuses: readonly StatusDef[]
  now: string
  today: string
  onOpen: () => void
}) {
  const status = columnFor(statuses, task.status)
  const overdue = task.due !== undefined && isOverdue(task.due, now)
  return (
    <li className="-mx-2">
      <Button
        type="button"
        variant="ghost"
        size="inline"
        onClick={onOpen}
        className="w-full justify-start text-left"
      >
        <span className="flex w-full min-w-0 items-center gap-3 px-2 py-1.5">
          <span className="min-w-0 flex-1 truncate text-sm font-medium">{task.title}</span>
          <span className="hidden sm:inline-flex">
            <StatusBadge status={status} />
          </span>
          {task.priority !== undefined ? (
            <span className="hidden md:inline-flex">
              <PriorityBadge priority={task.priority} />
            </span>
          ) : null}
          <PeopleStack logins={task.assignees} max={2} />
          <DateBadge stamp={task.due!} today={today} overdue={overdue} label="Due" />
        </span>
      </Button>
    </li>
  )
}

/** One line in place of an empty state, where the section's own header
 *  already holds the action. */
function Quiet({ children }: { children: ReactNode }) {
  return <p className="text-muted-foreground text-sm">{children}</p>
}

/** The project's facts as label and value rows: one panel, not a card each. */
function DetailRows({
  project,
  today,
  members,
}: {
  project: Project
  today: string
  members: readonly string[]
}) {
  const none = <span className="text-muted-foreground">Not set</span>
  const rows: { label: string; icon: ReactNode; value: ReactNode }[] = [
    {
      label: 'Status',
      icon: <CircleDotIcon aria-hidden="true" />,
      value: <ProjectStatusBadge status={project.status} />,
    },
    {
      label: 'Lead',
      icon: <UserIcon aria-hidden="true" />,
      value:
        project.lead !== undefined ? (
          <span className="flex min-w-0 items-center gap-2">
            <PersonAvatar login={project.lead} />
            <span className="truncate">{project.lead}</span>
          </span>
        ) : (
          none
        ),
    },
    {
      label: 'Start',
      icon: <CalendarIcon aria-hidden="true" />,
      value: project.start !== undefined ? shortDate(project.start, today) : none,
    },
    {
      label: 'Due',
      icon: <FlagIcon aria-hidden="true" />,
      value: project.due !== undefined ? shortDate(project.due, today) : none,
    },
    {
      label: 'Members',
      icon: <UsersIcon aria-hidden="true" />,
      value:
        members.length === 0 ? (
          none
        ) : (
          <span className="flex items-center gap-2">
            <PeopleStack logins={members} max={4} />
            <span className="tabular-nums">{members.length}</span>
          </span>
        ),
    },
  ]
  return (
    <dl className="flex flex-col gap-3 text-sm">
      {rows.map((row) => (
        <div key={row.label} className="flex items-center gap-6">
          <dt className="text-muted-foreground flex w-28 shrink-0 items-center gap-2 [&_svg]:size-4">
            {row.icon}
            {row.label}
          </dt>
          <dd className="flex min-h-6 min-w-0 flex-1 items-center">{row.value}</dd>
        </div>
      ))}
    </dl>
  )
}

type Activity =
  | { state: 'loading' }
  | { state: 'error'; message: string }
  | { state: 'ready'; items: ActivityItem[] }

/** What changed lately in the project: commits that touched a task file or
 *  the project file, newest first. Autosave commits name only the file, so
 *  the verb is "changed" until commits say more. */
function RecentActivity({
  tasks,
  onOpen,
}: {
  tasks: readonly Task[]
  onOpen: (path: string) => void
}) {
  const epochs = useAtomValue(historyEpochsAtom)
  const [retry, setRetry] = useState(0)
  const [activity, setActivity] = useState<Activity>({ state: 'loading' })
  const titles = new Map(tasks.map((t) => [t.path, t.title]))

  useEffect(() => {
    let live = true
    setActivity((current) => (current.state === 'ready' ? current : { state: 'loading' }))
    trpc.history.activity
      .query()
      .then((entries) => {
        if (!live) return
        const items: ActivityItem[] = []
        for (const { commit, files } of entries) {
          for (const path of files) {
            if (!/(^|\/)task\.[^/]*\.md$/.test(path) && path !== '.holi/project.md') {
              continue
            }
            items.push({
              id: items.length + 1,
              actor: commit.author,
              action: 'changed',
              target: path,
              path,
              date: relativeTime(commit.date),
              dateTime: commit.date,
            })
            if (items.length >= 8) break
          }
          if (items.length >= 8) break
        }
        setActivity({ state: 'ready', items })
      })
      .catch((err: unknown) => {
        if (live) {
          setActivity({
            state: 'error',
            message: err instanceof Error ? err.message : String(err),
          })
        }
      })
    return () => {
      live = false
    }
  }, [epochs.all, retry])

  return (
    <Section title="Recent activity">
      {activity.state === 'loading' ? (
        <LinesSkeleton lines={4} />
      ) : activity.state === 'error' ? (
        <RegionError
          title="History could not be read"
          message={activity.message}
          onRetry={() => setRetry((n) => n + 1)}
        />
      ) : activity.items.length === 0 ? (
        <Quiet>No changes to tasks or the project yet.</Quiet>
      ) : (
        <ActivityTimeline
          items={activity.items.map((item) => ({
            ...item,
            target:
              item.path === '.holi/project.md'
                ? 'the project'
                : (titles.get(item.path!) ?? item.target.split('/').at(-1)!),
            path: item.path !== undefined && titles.has(item.path) ? item.path : undefined,
          }))}
          onOpen={onOpen}
        />
      )}
    </Section>
  )
}
