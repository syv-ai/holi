import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { taskDoneOp } from '../src/main/vault/task-done'

let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'holi-task-done-'))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('taskDoneOp', () => {
  it('rolls a recurring task forward instead of finishing it', async () => {
    await writeFile(
      join(root, 'task.pay-rent.md'),
      '---\ndue: 2026-09-01\nrecurrence:\n  frequency: monthly\n  interval: 1\n---\n\n# Pay rent\n',
    )
    expect(await taskDoneOp(root, 'task.pay-rent.md', '2026-09-02')).toEqual({
      ok: true,
      path: 'task.pay-rent.md',
      status: 'todo',
      due: '2026-10-01',
    })
    const text = await readFile(join(root, 'task.pay-rent.md'), 'utf8')
    expect(text).toContain('due: 2026-10-01')
    expect(text).toContain('# Pay rent')
  })

  it('finishes a task that does not repeat', async () => {
    await writeFile(join(root, 'task.call-bank.md'), '---\nstatus: todo\n---\n\n# Call the bank\n')
    expect(await taskDoneOp(root, './task.call-bank.md', '2026-09-02')).toEqual({
      ok: true,
      path: 'task.call-bank.md',
      status: 'done',
    })
    expect(await readFile(join(root, 'task.call-bank.md'), 'utf8')).toContain('status: done')
  })

  it('refuses what is not a task inside the vault', async () => {
    await writeFile(join(root, 'notes.md'), '# Notes\n')
    expect(await taskDoneOp(root, 'notes.md', '2026-09-02')).toMatchObject({ ok: false })
    expect(await taskDoneOp(root, '../task.x.md', '2026-09-02')).toMatchObject({ ok: false })
    expect(await taskDoneOp(root, 'task.missing.md', '2026-09-02')).toMatchObject({ ok: false })
  })
})
