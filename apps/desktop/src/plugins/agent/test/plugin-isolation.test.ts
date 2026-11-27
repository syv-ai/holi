import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parseTaskFile, vaultRelPath, type Task } from '@holi/shared'
import { expect, it, vi } from 'vitest'
import { A, B, rig } from './activation-fixture'
import { tasksMain } from '../../tasks/main'
import { linksMain } from '../../links/main'
import { pdfMain } from '../../pdf/main'

vi.mock('../../pdf/main/typst-bin', async (original) => ({
  ...(await original<typeof import('../../pdf/main/typst-bin')>()),
  sharedTypst: () => async () => null,
}))
vi.mock('../../links/main/unfurl', async (original) => ({
  ...(await original<typeof import('../../links/main/unfurl')>()),
  fetchPreview: async (url: string) => ({ preview: { url, title: 'Same link' }, keep: true }),
}))

async function fixture() {
  const f = await rig(undefined, undefined, true, {
    plugins: [tasksMain, linksMain, pdfMain],
    retainedContexts: true,
    realSnapshots: true,
  })
  for (const remote of [A, B] as const) {
    await writeFile(
      join(f.roots[remote], '.holi/settings/plugins.yaml'),
      'plugins:\n  automations: true\n  holis: true\n  tasks: true\n  links: true\n  pdf: true\n',
    )
    await f.enter(remote)
    const template = join(f.roots[remote], '.holi/document-templates/shared')
    await mkdir(template, { recursive: true })
    await writeFile(
      join(template, 'template.json'),
      JSON.stringify({ name: `Template ${remote}`, description: remote, fields: [] }),
    )
    await writeFile(join(template, 'template.typ'), '#let doc(body) = body')
  }
  return f
}

it('keeps real task, link and PDF operations owned across stop and restart', async () => {
  const f = await fixture()
  const created = await Promise.all(
    ([A, B] as const).map(async (remote) => {
      const task = (await f.call(remote, 'tasks.create', {
        title: 'Same task',
        description: `Owned by ${remote}`,
      })) as { path: string }
      const link = (await f.call(remote, 'links.create', {
        url: `https://example.invalid/${remote}`,
      })) as { path: string }
      expect(await f.call(remote, 'pdf.templates')).toContainEqual(
        expect.objectContaining({ slug: 'shared', description: remote }),
      )
      return { task: task.path, link: link.path }
    }),
  )
  const a = created[0]!
  const b = created[1]!
  expect(a).toEqual(b)
  for (const remote of [A, B] as const) {
    const other = remote === A ? B : A
    const taskText = await readFile(join(f.roots[remote], a.task), 'utf8')
    expect(taskText).toContain(`Owned by ${remote}`)
    expect(taskText).not.toContain(`Owned by ${other}`)
    const linkText = await readFile(join(f.roots[remote], a.link), 'utf8')
    expect(linkText).toContain(`https://example.invalid/${remote}`)
    expect(linkText).not.toContain(`https://example.invalid/${other}`)
    const listed = await f.capabilities.dispatch({
      door: 'cli',
      remote,
      name: 'tasks.list',
      params: {},
    })
    expect(listed.value).toMatchObject([{ path: a.task, status: 'todo' }])
  }
  await f.capabilities.dispatch({
    door: 'cli',
    remote: A,
    name: 'tasks.complete',
    params: { path: a.task },
  })
  const readTask = async (remote: typeof A | typeof B) =>
    parseTaskFile(await readFile(join(f.roots[remote], a.task), 'utf8'), vaultRelPath(a.task))
  expect((await readTask(A)).status).toBe('done')
  expect((await readTask(B)).status).toBe('todo')

  await f.stopRemote(A)
  await f.capabilities.dispatch({
    door: 'cli',
    remote: B,
    name: 'tasks.complete',
    params: { path: b.task },
  })
  expect((await readTask(B)).status).toBe('done')
  const next = (await f.call(B, 'tasks.create', {
    title: 'Same task',
    description: 'B after stopping A',
  })) as { path: string }
  expect(next.path).not.toBe(b.task)
  await f.call(B, 'links.create', { url: 'https://example.invalid/b-after-stop' })
  expect(await f.call(B, 'pdf.templates')).toContainEqual(
    expect.objectContaining({ slug: 'shared', description: B }),
  )
  await f.enter(A)
  expect((await readTask(A)).status).toBe('done')
  const restored = await f.capabilities.dispatch({
    door: 'cli',
    remote: A,
    name: 'tasks.list',
    params: {},
  })
  expect((restored.value as Task[]).map((task) => task.path)).toEqual([a.task])
  expect(await f.call(A, 'pdf.templates')).toContainEqual(
    expect.objectContaining({ slug: 'shared', description: A }),
  )
  expect(await readFile(join(f.roots[B], next.path), 'utf8')).toContain('B after stopping A')
  // Keep one machine userData lifetime: Links' shared preview cache intentionally
  // belongs to the app process, not to each vault activation.
  const before = created.map(({ task }) => ({ path: task }))
  await writeFile(
    join(f.roots[A], '.holi/settings/plugins.yaml'),
    'plugins:\n  automations: true\n  holis: true\n  tasks: false\n  links: false\n  pdf: false\n',
  )
  await f.reconcileSettings(A)
  for (const [name, params] of [
    ['tasks.create', { title: 'While disabled', description: 'only B' }],
    ['links.create', { url: 'https://example.invalid/while-disabled' }],
    ['pdf.templates', {}],
  ] as const) {
    await expect(f.call(A, name, params)).rejects.toThrow()
    await expect(f.call(B, name, params)).resolves.toBeDefined()
  }
  await writeFile(
    join(f.roots[A], '.holi/settings/plugins.yaml'),
    'plugins:\n  automations: true\n  holis: true\n  tasks: true\n  links: true\n  pdf: true\n',
  )
  await f.reconcileSettings(A)
  for (const remote of [A, B] as const) {
    const listed = await f.capabilities.dispatch({
      door: 'cli',
      remote,
      name: 'tasks.list',
      params: {},
    })
    const tasks = listed.value as Task[]
    expect(tasks).toContainEqual(expect.objectContaining({ path: before[0]!.path }))
    expect(tasks.some((task) => task.description.includes('only B'))).toBe(remote === B)
    expect(await f.call(remote, 'pdf.templates')).toContainEqual(
      expect.objectContaining({ slug: 'shared', description: remote }),
    )
    await f.call(remote, 'links.create', { url: `https://example.invalid/restored/${remote}` })
  }
})
