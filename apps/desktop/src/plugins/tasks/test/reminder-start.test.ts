import { SETTINGS_LOCAL_FILE, STATUSES_FILE, type Task, type VaultSnapshot } from '@holi/shared'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { AppCtx } from '../../../main/plugin-api'
import { createDeliveredLog } from '../main/reminders/delivered-log'
import { startReminders } from '../main/reminders/start'

vi.mock('../../../main/plugin-api', async () => {
  const { readVaultStatuses } = await import('../../../main/vault/statuses')
  return { installedInfos: () => [], readVaultStatuses }
})

let root: string
let stop: (() => void) | undefined

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'holi-reminder-start-'))
  vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] })
  vi.setSystemTime(new Date(2026, 10, 12, 12, 1))
})

afterEach(async () => {
  stop?.()
  stop = undefined
  vi.useRealTimers()
  await rm(root, { recursive: true, force: true })
})

const task = (path: string, extra: Partial<Task> = {}): Task => ({
  path,
  title: path,
  status: 'todo',
  tags: [],
  assignees: [],
  description: '',
  due: '2026-11-11',
  ...extra,
})

it.each(['default', 'custom', 'unreadable'] as const)(
  'wires %s vault statuses, durable receipts and owning-vault notification clicks',
  async (mode) => {
    const first = join(root, 'first')
    const second = join(root, 'second')
    await mkdir(join(first, '.holi'), { recursive: true })
    await mkdir(second)
    const statusPath = join(first, STATUSES_FILE)
    if (mode === 'custom') {
      await writeFile(
        statusPath,
        JSON.stringify({
          statuses: [
            { id: 'todo', name: 'To do', category: 'unstarted' },
            { id: 'shipped', name: 'Shipped', category: 'completed' },
          ],
        }),
      )
    } else if (mode === 'unreadable') {
      await mkdir(statusPath)
    }
    const snapshots = new Map<string, VaultSnapshot>([
      [
        first,
        {
          docs: [],
          files: [],
          dirs: [],
          icons: {},
          ignored: [],
          claimed: {
            tasks: {
              broken: [],
              items: [
                task('task.late.md'),
                task('task.complete.md', { status: mode === 'custom' ? 'shipped' : 'done' }),
                task('task.explicit.md', { reminder: '2026-11-11T09:00' }),
              ],
            },
          },
        },
      ],
      [
        second,
        {
          docs: [],
          files: [],
          dirs: [],
          icons: {},
          ignored: [],
          claimed: { tasks: { broken: [], items: [task('task.late.md')] } },
        },
      ],
    ])
    const notify = vi.fn<AppCtx['notify']>()
    const open = vi.fn<AppCtx['open']>()
    const ctx: AppCtx = {
      userData: root,
      vaults: async () => [
        { remote: 'fixture/first', root: first },
        { remote: 'fixture/second', root: second },
      ],
      scan: async (path) => snapshots.get(path)!,
      viewerLogin: () => null,
      notify,
      open,
    }
    stop = startReminders(ctx)
    await vi.waitFor(() => expect(notify).toHaveBeenCalledTimes(mode === 'unreadable' ? 2 : 3))
    expect(notify.mock.calls.map(([notice]) => notice.title)).toEqual(
      mode === 'unreadable'
        ? ['task.explicit.md', 'Overdue: task.late.md']
        : ['Overdue: task.late.md', 'task.explicit.md', 'Overdue: task.late.md'],
    )
    expect(open).not.toHaveBeenCalled()
    notify.mock.calls.at(-1)![0].onClick!()
    expect(open).toHaveBeenLastCalledWith('fixture/second', 'task.late.md')
    if (mode !== 'unreadable') {
      notify.mock.calls[0]![0].onClick!()
      expect(open).toHaveBeenLastCalledWith('fixture/first', 'task.late.md')
    }
    const log = createDeliveredLog((remote) => (remote === 'fixture/first' ? first : second))
    expect(log.read('fixture/first')).toEqual({ 'task.explicit.md': '2026-11-11T09:00' })
    expect(log.fallbackReceipts().has('fixture/first', 'task.late.md', '2026-11-11')).toBe(
      mode !== 'unreadable',
    )
    expect(log.fallbackReceipts().has('fixture/second', 'task.late.md', '2026-11-11')).toBe(true)
    expect(await readFile(join(second, SETTINGS_LOCAL_FILE), 'utf8')).toContain(
      'overdueTaskReceipts',
    )
  },
)

it('does not scan or notify for a vault excluded by the plugin host', async () => {
  const scan = vi.fn<AppCtx['scan']>()
  const notify = vi.fn<AppCtx['notify']>()
  stop = startReminders({
    userData: root,
    vaults: async () => [],
    scan,
    notify,
    open: vi.fn(),
    viewerLogin: () => null,
  })
  await new Promise<void>((resolve) => setImmediate(resolve))
  expect(scan).not.toHaveBeenCalled()
  expect(notify).not.toHaveBeenCalled()
})
