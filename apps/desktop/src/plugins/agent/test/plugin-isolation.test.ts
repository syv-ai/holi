import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { A, B, rig } from './activation-fixture'
import { tasksMain } from '../../tasks/main'
import { linksMain } from '../../links/main'
import { pdfMain } from '../../pdf/main'

vi.mock('../../pdf/main/typst-bin', async (original) => ({
  ...(await original<typeof import('../../pdf/main/typst-bin')>()),
  sharedTypst: async () => null,
}))
vi.mock('../../links/main/unfurl', async (original) => {
  const actual = await original<typeof import('../../links/main/unfurl')>()
  return { ...actual, fetchPreview: async (url: string) => ({ title: `Preview ${url}` }) }
})

const plugins = [tasksMain, linksMain, pdfMain]
const templateJson = JSON.stringify({ name: 'Shared title', description: 'Fixture', fields: [] })
const templateTyp = '#let doc(p, meta: (:), assets: "") = []'

it('keeps real capability data scoped to each activated vault across lifecycle changes', async () => {
  const f = await rig(undefined, undefined, false, {
    plugins,
    retainedContexts: true,
    realSnapshots: true,
  })
  for (const remote of [A, B]) {
    await f.enter(remote)
    await f.call(remote, 'tasks.create', { title: 'Same task', description: remote })
    await f.call(remote, 'links.create', { title: 'Same link', url: `https://${remote}.example` })
    const template = join(f.roots[remote], '.holi/document-templates/shared')
    await mkdir(template, { recursive: true })
    await writeFile(join(template, 'template.json'), templateJson)
    await writeFile(join(template, 'template.typ'), templateTyp)
    await f.capabilities.dispatch({ door: 'ui', remote, name: 'pdf.templates', params: {} })
  }
  const taskPath = '.holi/tasks/same-task.md'
  expect(await readFile(join(f.roots[A], taskPath), 'utf8')).toContain(A)
  expect(await readFile(join(f.roots[B], taskPath), 'utf8')).toContain(B)
  await f.stopRemote(A)
  await f.call(B, 'tasks.create', { title: 'After stop', description: B })
  await f.call(B, 'links.create', { title: 'After stop', url: 'https://b.example' })
  await f.enter(A)
  expect(await readFile(join(f.roots[A], taskPath), 'utf8')).toContain(A)
})

it('reconciles capability disablement in one vault without affecting the other', async () => {
  const f = await rig(undefined, undefined, false, {
    plugins,
    retainedContexts: true,
    realSnapshots: true,
  })
  for (const remote of [A, B]) await f.enter(remote)
  await writeFile(
    join(f.roots[A], '.holi/settings/plugins.yaml'),
    'plugins:\n  tasks: false\n  links: false\n  pdf: false\n',
  )
  await f.reconcileSettings(A)
  await expect(f.call(A, 'tasks.create', { title: 'Denied' })).rejects.toThrow()
  await expect(f.call(B, 'tasks.create', { title: 'Allowed' })).resolves.toBeDefined()
  await writeFile(
    join(f.roots[A], '.holi/settings/plugins.yaml'),
    'plugins:\n  tasks: true\n  links: true\n  pdf: true\n',
  )
  await f.reconcileSettings(A)
  await expect(f.call(A, 'tasks.create', { title: 'Restored' })).resolves.toBeDefined()
})
