import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { migrateApps } from '../src/main/apps/migrate-apps'

let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'holi-migrate-apps-'))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

async function write(rel: string, content = ''): Promise<void> {
  await mkdir(join(root, rel, '..'), { recursive: true })
  await writeFile(join(root, rel), content)
}

const gone = (rel: string) =>
  access(join(root, rel)).then(
    () => false,
    () => true,
  )

describe('migrateApps', () => {
  it('moves each app to <id>.app at the root, nested files and all', async () => {
    await write('.holi/apps/retro/index.html', '<h1>retro</h1>')
    await write('.holi/apps/retro/app.yaml')
    await write('.holi/apps/retro/lib/chart.js', 'export const x = 1\n')
    await write('.holi/apps/burndown/index.html')

    expect(await migrateApps(root)).toEqual({
      moved: [
        { from: '.holi/apps/burndown', to: 'burndown.app' },
        { from: '.holi/apps/retro', to: 'retro.app' },
      ],
      skipped: [],
    })
    expect(await readFile(join(root, 'retro.app/lib/chart.js'), 'utf8')).toBe(
      'export const x = 1\n',
    )
    expect(await readFile(join(root, 'retro.app/index.html'), 'utf8')).toBe('<h1>retro</h1>')
    expect(await gone('.holi/apps')).toBe(true)
  })

  it('rewrites every [[link]] that pointed into an old directory', async () => {
    await write('.holi/apps/retro/index.html')
    await write('.holi/apps/retro/app.yaml')
    await write(
      'notes.md',
      'see [[.holi/apps/retro/index.html]] and [[.holi/apps/retro/app.yaml|the manifest]]\n',
    )

    await migrateApps(root)

    expect(await readFile(join(root, 'notes.md'), 'utf8')).toBe(
      'see [[retro.app/index.html]] and [[retro.app/app.yaml|the manifest]]\n',
    )
  })

  it('leaves an app whose destination exists where it is, and keeps .holi/apps for it', async () => {
    await write('.holi/apps/retro/index.html', 'old')
    await write('retro.app/index.html', 'mine')

    expect(await migrateApps(root)).toEqual({ moved: [], skipped: ['.holi/apps/retro'] })
    expect(await readFile(join(root, 'retro.app/index.html'), 'utf8')).toBe('mine')
    expect(await readFile(join(root, '.holi/apps/retro/index.html'), 'utf8')).toBe('old')
  })

  it('is a no-op the second time, and for a vault that never had apps', async () => {
    await write('.holi/apps/retro/index.html')
    await migrateApps(root)
    expect(await migrateApps(root)).toEqual({ moved: [], skipped: [] })

    const fresh = await mkdtemp(join(tmpdir(), 'holi-migrate-apps-'))
    expect(await migrateApps(fresh)).toEqual({ moved: [], skipped: [] })
    await rm(fresh, { recursive: true, force: true })
  })
})
