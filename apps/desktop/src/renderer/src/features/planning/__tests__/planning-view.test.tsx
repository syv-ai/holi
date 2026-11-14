/**
 * The planning view against a vault held in a store: the board draws the
 * vault's statuses as columns, shows a task whose status the vault does not
 * list, and every tab reaches the same tasks.
 */
import { DEFAULT_STATUSES, emptyVaultSnapshot, type Task, type VaultSnapshot } from '@holi/shared'
import userEvent from '@testing-library/user-event'
import { createStore, Provider } from 'jotai'
import { afterEach, expect, test, vi } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@/test/render'
import type { KanbanCommitMeta } from '@/components/ui/kanban'
import { nowAtom } from '@/state/clock'
import { planningTabAtom, projectFileAtom, statusesFileAtom } from '@/state/planning'
import { activeRemoteAtom, snapshotAtom, vaultsAtom } from '@/state/vaults'
import { PlanningView } from '../planning-view'
import { PlanningVisibilityContext } from '../planning-visibility'
import { usePlanningBoardDrag } from '../use-planning-board-drag'

// Base UI's scroll area asks the viewport for its running animations, which
// jsdom does not implement.
Element.prototype.getAnimations ??= () => []

const activity = vi.fn()
const update = vi.fn()
let createRequest = () => Promise.resolve({ path: 'task.new.md' })
let projectWrite = () => Promise.resolve(null)
let snapshotTasks: Task[] = []

vi.mock('@/lib/trpc', () => ({
  trpc: {
    history: { activity: { query: () => activity() } },
    // The tasks plugin's verbs, as `capClient` sends them.
    cap: {
      run: {
        mutate: ({
          remote,
          name,
          paramsJson,
        }: {
          remote: string
          name: string
          paramsJson?: string
        }) => {
          const params = paramsJson === undefined ? {} : JSON.parse(paramsJson)
          if (name === 'tasks.update') return update({ remote, ...params })
          if (name === 'tasks.create') return createRequest()
          return Promise.resolve(null)
        },
      },
    },
    notes: { write: { mutate: () => projectWrite() } },
    vaults: { snapshot: { query: () => Promise.resolve(snapshotOf(snapshotTasks)) } },
    github: {
      collaborators: { query: () => Promise.resolve({ collaborators: [] }) },
    },
  },
}))

const task = (path: string, fields: Partial<Task>): Task => ({
  path,
  title: path.replace(/^.*task\.|\.md$/g, ''),
  status: 'todo',
  tags: [],
  assignees: [],
  description: '',
  ...fields,
})

const TASKS: Task[] = [
  task('task.write-brief.md', {
    title: 'Write the brief',
    status: 'doing',
    priority: 'urgent',
    due: '2026-10-20',
    estimate: '2d',
    tags: ['copy'],
    assignees: ['ada'],
  }),
  task('task.ship.md', { title: 'Ship it', status: 'done' }),
  task('task.blocked.md', { title: 'Waiting on legal', status: 'blocked' }),
]

function snapshotOf(tasks: Task[]): VaultSnapshot {
  return {
    ...emptyVaultSnapshot(),
    claimed: { tasks: { items: tasks, broken: [] } },
  }
}

function setup(
  tab: 'board' | 'list' | 'overview' = 'board',
  options: { visible?: boolean; focused?: boolean; tasks?: Task[] } = {},
  statuses = [...DEFAULT_STATUSES],
) {
  snapshotTasks = options.tasks ?? TASKS
  const store = createStore()
  store.set(activeRemoteAtom, 'syv-ai/site')
  store.set(vaultsAtom, [
    {
      remote: 'syv-ai/site',
      path: '/v',
      name: 'site',
      lastOpenedAt: '2026-10-01',
    },
  ])
  store.set(snapshotAtom, snapshotOf(snapshotTasks))
  store.set(nowAtom, '2026-10-23T12:00')
  store.set(statusesFileAtom, {
    state: 'ready',
    value: statuses,
    warnings: [],
  })
  store.set(projectFileAtom, {
    state: 'ready',
    value: {
      name: 'Website relaunch',
      status: 'active',
      lead: 'ada',
      due: '2026-12-15',
      milestones: [{ name: 'Launch', date: '2026-12-01' }],
      about: 'Rebuild the site.',
    },
    warnings: [],
  })
  store.set(planningTabAtom, tab)
  const onOpenTask = vi.fn()
  const view = render(
    <Provider store={store}>
      <input aria-label="Foreground input" />
      <PlanningView onOpenTask={onOpenTask} visible={options.visible} focused={options.focused} />
    </Provider>,
  )
  return { store, onOpenTask, view }
}

afterEach(() => {
  activity.mockReset()
  update.mockReset()
  createRequest = () => Promise.resolve({ path: 'task.new.md' })
  projectWrite = () => Promise.resolve(null)
})

test('the board has a column per status, and a card in each task’s column', () => {
  activity.mockResolvedValue([])
  setup('board')
  expect(screen.getByRole('heading', { level: 1, name: 'Board' })).toBeInTheDocument()
  for (const name of ['Backlog', 'To do', 'In progress', 'Review', 'Done']) {
    expect(screen.getByRole('region', { name: `${name} tasks` })).toBeInTheDocument()
  }
  const doing = screen.getByRole('region', { name: 'In progress tasks' })
  expect(within(doing).getByText('Write the brief')).toBeInTheDocument()
  expect(within(doing).getByText('Urgent')).toBeInTheDocument()
  expect(within(doing).getByText('2d')).toBeInTheDocument()
  // Overdue: due the 20th, and it is the 23rd.
  expect(within(doing).getByLabelText(/Due .*overdue/)).toBeInTheDocument()
  // A status the vault does not list shows in the first unstarted column.
  const todo = screen.getByRole('region', { name: 'To do tasks' })
  expect(within(todo).getByText('Waiting on legal')).toBeInTheDocument()
})

test('due chips distinguish today, exact-minute urgency, invalid dates and completion', async () => {
  activity.mockResolvedValue([])
  const { store } = setup(
    'board',
    {
      tasks: [
        ...TASKS.slice(0, 3),
        task('task.today.md', { title: 'Due today', due: '2026-10-23' }),
        task('task.minute.md', { title: 'Due this minute', due: '2026-10-23T12:00' }),
        task('task.minute-past.md', { title: 'Minute overdue', due: '2026-10-23T11:59' }),
        task('task.tomorrow.md', { title: 'Check the schedule', due: '2026-10-24' }),
        task('task.invalid-due.md', { title: 'Invalid due', due: 'not-a-date' }),
        task('task.done-due.md', { title: 'Completed due', status: 'archived', due: '2026-10-20' }),
      ],
    },
    [...DEFAULT_STATUSES, { id: 'archived', name: 'Archived', category: 'completed' }],
  )

  expect(screen.getAllByLabelText(/Due today/)).toHaveLength(2)
  expect(screen.getByLabelText(/Due today.*12:00/)).toBeInTheDocument()
  expect(screen.getByLabelText(/11:59, overdue/)).toBeInTheDocument()
  expect(screen.getByLabelText('Due not-a-date')).toBeInTheDocument()
  expect(screen.getByLabelText(/Was due/)).toBeInTheDocument()
  const todayChip = screen.getByLabelText(/^Due today, Oct 23$/)
  expect(within(todayChip).getByText('Due today')).toBeVisible()
  expect(todayChip.closest('[data-task]')).toHaveClass('border-warning/40')
  expect(within(screen.getByLabelText(/11:59, overdue/)).getByText('Overdue')).toBeVisible()
  expect(within(screen.getByLabelText('Due not-a-date')).queryByText('Overdue')).toBeNull()
  expect(document.querySelector('[data-task="task.ship.md"] [aria-label^="Due"]')).toBeNull()
  expect(screen.getByLabelText(/Due Oct 24, soon/)).not.toHaveTextContent('Due today')

  store.set(nowAtom, '2026-10-23T12:01')
  await waitFor(() =>
    expect(within(screen.getByLabelText(/12:00, overdue/)).getByText('Overdue')).toBeVisible(),
  )
  expect(todayChip).toHaveTextContent('Due today')
  expect(update).not.toHaveBeenCalled()

  store.set(
    snapshotAtom,
    snapshotOf(
      snapshotTasks.map((item) =>
        item.path === 'task.minute.md' ? { ...item, status: 'archived' } : item,
      ),
    ),
  )
  await waitFor(() => expect(screen.getByLabelText(/Was due.*12:00/)).toBeInTheDocument())
  expect(screen.getByLabelText(/Was due.*12:00/)).not.toHaveTextContent('Overdue')

  store.set(nowAtom, '2026-10-24T00:00')
  await waitFor(() =>
    expect(document.querySelector('[data-task="task.today.md"]')).toHaveTextContent('Overdue'),
  )
  expect(within(screen.getByLabelText(/^Due today, Oct 24$/)).getByText('Due today')).toBeVisible()
  const completedCard = document.querySelector('[data-task="task.done-due.md"]')
  expect(completedCard).toHaveTextContent('Completed due')
  expect(within(completedCard as HTMLElement).getByLabelText(/Was due/)).toBeInTheDocument()
  expect(within(completedCard as HTMLElement).queryByText('Overdue')).not.toBeInTheDocument()
  expect(within(completedCard as HTMLElement).queryByText('Due today')).not.toBeInTheDocument()
})

test('a card’s title opens the task', async () => {
  activity.mockResolvedValue([])
  const { onOpenTask } = setup('board')
  await userEvent.click(screen.getByText('Ship it'))
  expect(onOpenTask).toHaveBeenCalledWith('task.ship.md')
})

test('search narrows the board', async () => {
  activity.mockResolvedValue([])
  setup('board')
  await userEvent.type(screen.getByRole('textbox', { name: 'Search tasks' }), 'legal')
  expect(screen.queryByText('Write the brief')).not.toBeInTheDocument()
  expect(screen.getByText('Waiting on legal')).toBeInTheDocument()
})

test('a search that hides every task says so, and clears', async () => {
  activity.mockResolvedValue([])
  setup('list')
  const search = screen.getByRole('textbox', { name: 'Search tasks' })
  await userEvent.type(search, 'zebra')
  expect(screen.getByText('No matching tasks')).toBeInTheDocument()
  expect(screen.getByText(/Nothing matches “zebra”/)).toBeInTheDocument()
  await userEvent.click(screen.getByRole('button', { name: 'Clear filters' }))
  expect(search).toHaveValue('')
  expect(screen.getByText('Write the brief')).toBeInTheDocument()
})

test('the list groups by status, and a status menu moves a task', async () => {
  activity.mockResolvedValue([])
  update.mockResolvedValue({})
  setup('list')
  expect(screen.getByRole('button', { name: 'Collapse In progress' })).toBeInTheDocument()
  await userEvent.click(
    screen.getByRole('button', {
      name: 'Status of Write the brief: In progress',
    }),
  )
  await userEvent.click(await screen.findByRole('menuitemradio', { name: /Review/ }))
  await waitFor(() =>
    expect(update).toHaveBeenCalledWith({
      remote: 'syv-ai/site',
      path: 'task.write-brief.md',
      patch: { status: 'review' },
    }),
  )
})

test('the overview counts progress by status and lists recent activity', async () => {
  activity.mockResolvedValue([
    {
      commit: {
        sha: 'a',
        subject: 'Update task.ship.md',
        date: '2026-10-22T10:00:00Z',
        author: 'Ada Holm',
        added: 1,
        removed: 0,
      },
      files: ['task.ship.md', 'notes/x.md'],
      total: 2,
    },
  ])
  setup('overview')
  expect(screen.getByText('Rebuild the site.')).toBeInTheDocument()
  // One of three tasks is done.
  expect(screen.getByText('33%')).toBeInTheDocument()
  expect(screen.getByText('1 overdue')).toBeInTheDocument()
  expect(screen.getByText('Launch')).toBeInTheDocument()
  expect(await screen.findByText('Ada Holm')).toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Ship it' })).toBeInTheDocument()
})

test('an unfocused displayed split opens the task dialog without taking focus', async () => {
  activity.mockResolvedValue([])
  setup('board', { visible: true, focused: false })
  await userEvent.click(screen.getByRole('button', { name: 'New task' }))
  const title = screen.getByPlaceholderText('Task title')
  expect(screen.getByRole('dialog', { name: 'New task' })).toBeInTheDocument()
  expect(document.activeElement).not.toBe(title)
  expect(title).not.toHaveFocus()
})

test('an inline board draft survives sensor disposal and does not steal focus on return', async () => {
  activity.mockResolvedValue([])
  const { view, store } = setup('board', { focused: false })
  await userEvent.click(screen.getByRole('button', { name: 'Add task to Backlog' }))
  const draft = screen.getByRole('textbox', { name: 'Add task to Backlog' })
  await userEvent.type(draft, 'Unfinished draft')
  view.rerender(
    <Provider store={store}>
      <input aria-label="Foreground input" />
      <PlanningView onOpenTask={() => {}} visible={false} focused={false} />
    </Provider>,
  )
  expect(screen.queryByRole('textbox', { name: 'Add task to Backlog' })).not.toBeInTheDocument()
  const foreground = screen.getByRole('textbox', { name: 'Foreground input' })
  foreground.focus()
  view.rerender(
    <Provider store={store}>
      <input aria-label="Foreground input" />
      <PlanningView onOpenTask={() => {}} visible focused={false} />
    </Provider>,
  )
  expect(screen.getByRole('textbox', { name: 'Add task to Backlog' })).toHaveValue(
    'Unfinished draft',
  )
  expect(screen.getByRole('textbox', { name: 'Foreground input' })).toHaveFocus()
})

test('unfocused task dialog keeps its draft when a sibling pane receives focus', async () => {
  activity.mockResolvedValue([])
  setup('board', { focused: false })
  await userEvent.click(screen.getByRole('button', { name: 'New task' }))
  const title = screen.getByPlaceholderText('Task title')
  await userEvent.type(title, 'Draft task title')
  const external = screen.getByRole('textbox', { name: 'Foreground input' })
  external.focus()
  await waitFor(() => {
    expect(external).toHaveFocus()
    expect(screen.getByRole('dialog', { name: 'New task' })).toBeInTheDocument()
    expect(title).toHaveValue('Draft task title')
  })
  await userEvent.click(external)
  expect(screen.getByRole('dialog', { name: 'New task' })).toBeInTheDocument()
  await userEvent.keyboard('{Escape}')
  await waitFor(() => expect(screen.queryByRole('dialog', { name: 'New task' })).toBeNull())
})

test('an unfocused project dialog keeps its draft when a sibling pane receives focus', async () => {
  activity.mockResolvedValue([])
  setup('board', { focused: false })
  await userEvent.click(screen.getByRole('button', { name: 'Edit project' }))
  const name = screen.getByRole('textbox', { name: 'Name' })
  await userEvent.clear(name)
  await userEvent.type(name, 'Draft project name')
  const external = screen.getByRole('textbox', { name: 'Foreground input' })
  external.focus()
  await waitFor(() => {
    expect(external).toHaveFocus()
    expect(screen.getByRole('dialog', { name: 'Edit project' })).toBeInTheDocument()
    expect(name).toHaveValue('Draft project name')
  })
  await userEvent.click(external)
  expect(screen.getByRole('dialog', { name: 'Edit project' })).toBeInTheDocument()
  await userEvent.keyboard('{Escape}')
  await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Edit project' })).toBeNull())
})

test('a project save completing while hidden closes its dialog', async () => {
  activity.mockResolvedValue([])
  let resolveSave!: () => void
  projectWrite = () => new Promise((resolve) => (resolveSave = () => resolve(null)))
  const { view, store } = setup('board')
  await userEvent.click(screen.getByRole('button', { name: 'Edit project' }))
  await userEvent.click(screen.getByRole('button', { name: 'Save project' }))
  await waitFor(() => expect(resolveSave).toBeDefined())

  view.rerender(
    <Provider store={store}>
      <PlanningView onOpenTask={() => {}} visible={false} focused={false} />
    </Provider>,
  )
  resolveSave()
  await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Edit project' })).toBeNull())
  view.rerender(
    <Provider store={store}>
      <PlanningView onOpenTask={() => {}} visible focused={false} />
    </Provider>,
  )
  expect(screen.queryByRole('dialog', { name: 'Edit project' })).not.toBeInTheDocument()
})

test('a task save completing while hidden closes its dialog', async () => {
  activity.mockResolvedValue([])
  let resolveCreate!: (value: { path: string }) => void
  createRequest = () => new Promise((resolve) => (resolveCreate = resolve))
  const { view, store } = setup('board')
  await userEvent.click(screen.getByRole('button', { name: 'New task' }))
  await userEvent.type(screen.getByPlaceholderText('Task title'), 'Deferred task')
  await userEvent.click(screen.getByRole('button', { name: 'Create task' }))
  await waitFor(() => expect(resolveCreate).toBeDefined())

  view.rerender(
    <Provider store={store}>
      <PlanningView onOpenTask={() => {}} visible={false} focused={false} />
    </Provider>,
  )
  resolveCreate({ path: 'task.new.md' })
  await waitFor(() => expect(screen.queryByRole('dialog', { name: 'New task' })).toBeNull())
  view.rerender(
    <Provider store={store}>
      <PlanningView onOpenTask={() => {}} visible focused={false} />
    </Provider>,
  )
  expect(screen.queryByRole('dialog', { name: 'New task' })).not.toBeInTheDocument()
})

test('project save errors clear on a new logical dialog session', async () => {
  activity.mockResolvedValue([])
  projectWrite = () => Promise.reject(new Error('Write failed'))
  setup('board')
  await userEvent.click(screen.getByRole('button', { name: 'Edit project' }))
  await userEvent.click(screen.getByRole('button', { name: 'Save project' }))
  expect(await screen.findByText('Write failed')).toBeInTheDocument()
  await userEvent.click(screen.getByRole('button', { name: 'Cancel' }))
  await userEvent.click(screen.getByRole('button', { name: 'Edit project' }))
  await waitFor(() => expect(screen.queryByText('Write failed')).not.toBeInTheDocument())
})

test('callbacks captured before hiding cannot restore a drag preview or commit a task move', async () => {
  activity.mockResolvedValue([])
  update.mockResolvedValue({})
  const store = createStore()
  store.set(activeRemoteAtom, 'syv-ai/site')
  store.set(vaultsAtom, [
    { remote: 'syv-ai/site', path: '/v', name: 'site', lastOpenedAt: '2026-10-01' },
  ])
  store.set(snapshotAtom, snapshotOf(TASKS))
  let oldChange!: (value: Record<string, Task[]>) => void
  let oldCommit!: (value: Record<string, Task[]>, meta: KanbanCommitMeta<Task>) => void
  let oldCancelDrop!: () => boolean
  function Probe() {
    const drag = usePlanningBoardDrag({
      taskMap: new Map(TASKS.map((item) => [item.path, item])),
      statuses: [...DEFAULT_STATUSES],
      sort: 'manual',
      resting: { todo: [TASKS[0]!], doing: [TASKS[1]!], review: [], done: [], backlog: [] },
    })
    oldChange = drag.onValueChange
    oldCommit = drag.onValueCommit
    oldCancelDrop = drag.cancelDrop
    return (
      <output data-testid="preview">
        {(drag.value.todo ?? []).map((item) => item.path).join(',')}
      </output>
    )
  }
  const view = render(
    <Provider store={store}>
      <PlanningVisibilityContext.Provider value>
        <Probe />
      </PlanningVisibilityContext.Provider>
    </Provider>,
  )
  const capturedChange = oldChange
  const capturedCommit = oldCommit
  const capturedCancelDrop = oldCancelDrop
  const moved = { todo: [], doing: [TASKS[1]!, TASKS[0]!] }
  const commitMeta = {
    kind: 'item',
    overContainer: 'doing',
    overIndex: 1,
    event: { active: { id: TASKS[0]!.path } } as KanbanCommitMeta<Task>['event'],
  } as KanbanCommitMeta<Task>
  capturedCommit(moved, commitMeta)
  await waitFor(() => expect(update).toHaveBeenCalledTimes(2))
  view.rerender(
    <Provider store={store}>
      <PlanningVisibilityContext.Provider value={false}>
        <Probe />
      </PlanningVisibilityContext.Provider>
    </Provider>,
  )
  view.rerender(
    <Provider store={store}>
      <PlanningVisibilityContext.Provider value>
        <Probe />
      </PlanningVisibilityContext.Provider>
    </Provider>,
  )
  expect(capturedCancelDrop()).toBe(true)
  capturedChange(moved)
  capturedCommit(moved, commitMeta)
  expect(capturedCancelDrop()).toBe(true)
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(screen.getByTestId('preview')).toHaveTextContent('task.write-brief.md')
  expect(update).toHaveBeenCalledTimes(2)
})

test('callbacks captured before disposal cannot restore a preview or commit a task move', async () => {
  activity.mockResolvedValue([])
  update.mockResolvedValue({})
  const store = createStore()
  store.set(activeRemoteAtom, 'syv-ai/site')
  store.set(vaultsAtom, [
    { remote: 'syv-ai/site', path: '/v', name: 'site', lastOpenedAt: '2026-10-01' },
  ])
  store.set(snapshotAtom, snapshotOf(TASKS))
  let oldChange!: (value: Record<string, Task[]>) => void
  let oldCommit!: (value: Record<string, Task[]>, meta: KanbanCommitMeta<Task>) => void
  function Probe() {
    const drag = usePlanningBoardDrag({
      taskMap: new Map(TASKS.map((item) => [item.path, item])),
      statuses: [...DEFAULT_STATUSES],
      sort: 'manual',
      resting: { todo: [TASKS[0]!], doing: [], review: [], done: [], backlog: [] },
    })
    oldChange = drag.onValueChange
    oldCommit = drag.onValueCommit
    return (
      <output data-testid="preview">
        {(drag.value.todo ?? []).map((item) => item.path).join(',')}
      </output>
    )
  }
  const view = render(
    <Provider store={store}>
      <PlanningVisibilityContext.Provider value>
        <Probe />
      </PlanningVisibilityContext.Provider>
    </Provider>,
  )
  const capturedChange = oldChange
  const capturedCommit = oldCommit
  const moved = { todo: [], doing: [TASKS[0]!] }
  const commitMeta = {
    kind: 'item',
    overContainer: 'doing',
    overIndex: 0,
    event: { active: { id: TASKS[0]!.path } } as KanbanCommitMeta<Task>['event'],
  } as KanbanCommitMeta<Task>
  view.unmount()
  capturedChange(moved)
  capturedCommit(moved, commitMeta)
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(update).not.toHaveBeenCalled()
})

test('the drag sensor cancels its live overlay without committing a task move', async () => {
  activity.mockResolvedValue([])
  update.mockResolvedValue({})
  const { view, store } = setup('board')
  const card = document.querySelector<HTMLElement>(
    '[data-slot="kanban-item"][data-value="task.write-brief.md"]',
  )!
  expect(card).toBeInTheDocument()
  const handle = card.querySelector<HTMLElement>('[data-slot="kanban-item-handle"]')!
  await userEvent.pointer([
    { keys: '[MouseLeft>]', target: handle, coords: { x: 20, y: 20 } },
    { coords: { x: 60, y: 60 } },
  ])
  await waitFor(() =>
    expect(
      document.querySelectorAll('[data-slot="kanban-item"][data-value="task.write-brief.md"]'),
    ).toHaveLength(2),
  )
  view.rerender(
    <Provider store={store}>
      <PlanningView onOpenTask={() => {}} visible={false} focused={false} />
    </Provider>,
  )
  await waitFor(() =>
    expect(
      document.querySelectorAll('[data-slot="kanban-item"][data-value="task.write-brief.md"]'),
    ).toHaveLength(0),
  )
  expect(update).not.toHaveBeenCalled()
})

test('releasing a board drag after its view is hidden does not commit a status', async () => {
  activity.mockResolvedValue([])
  update.mockResolvedValue({})
  const { view, store } = setup('board')
  const card = document.querySelector<HTMLElement>(
    '[data-slot="kanban-item"][data-value="task.write-brief.md"]',
  )!
  expect(card).toBeInTheDocument()
  const handle = card.querySelector<HTMLElement>('[data-slot="kanban-item-handle"]')!
  await userEvent.pointer([
    { keys: '[MouseLeft>]', target: handle, coords: { x: 20, y: 20 } },
    { coords: { x: 80, y: 80 } },
  ])
  expect(
    document.querySelectorAll('[data-slot="kanban-item"][data-value="task.write-brief.md"]'),
  ).toHaveLength(2)
  view.rerender(
    <Provider store={store}>
      <PlanningView onOpenTask={() => {}} visible={false} focused={false} />
    </Provider>,
  )
  fireEvent.mouseUp(document, { button: 0, clientX: 80, clientY: 80 })
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(update).not.toHaveBeenCalled()
})

test('narrow view menu and people overflow portal close when planning is hidden', async () => {
  activity.mockResolvedValue([])
  const tasks = TASKS.map((item) =>
    item.path === 'task.write-brief.md'
      ? { ...item, assignees: ['ada', 'bea', 'cy', 'dee', 'eve'] }
      : item,
  )
  const { view, store } = setup('board', { tasks })

  await userEvent.click(screen.getByRole('button', { name: 'Choose a view' }))
  expect(await screen.findByRole('menuitemradio', { name: 'Overview' })).toBeInTheDocument()
  await userEvent.keyboard('{Escape}')

  await userEvent.click(screen.getByRole('button', { name: '1 more: eve' }))
  expect(await screen.findByText('Members')).toBeInTheDocument()
  view.rerender(
    <Provider store={store}>
      <PlanningView onOpenTask={() => {}} visible={false} focused={false} />
    </Provider>,
  )
  await waitFor(() => expect(screen.queryByText('Members')).not.toBeInTheDocument())
  expect(screen.queryByRole('menuitemradio', { name: 'Overview' })).not.toBeInTheDocument()
})

test('without the project file the overview still renders, and a load error offers Retry', () => {
  activity.mockReturnValue(new Promise(() => {}))
  const { store } = setup('overview')
  store.set(projectFileAtom, { state: 'error', message: 'EACCES' })
  return waitFor(() => {
    expect(screen.getAllByText('The project file could not be read').length).toBeGreaterThan(0)
    expect(screen.getAllByRole('button', { name: 'Retry' }).length).toBeGreaterThan(0)
  })
})
