import { mkdir, mkdtemp, readFile, readdir, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { APP_LOG_FILE } from '@holi/shared'
import { writeAppLog } from '../main/log'

let root: string
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'holi-app-log-'))
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

test('writes every report, however many arrive at once', async () => {
  await mkdir(join(root, 'Weather.app'))
  await Promise.all(
    Array.from({ length: 10 }, (_, i) =>
      writeAppLog(root, 'Weather.app', { level: 'error', text: `e${i}` }),
    ),
  )
  const log = await readFile(join(root, 'Weather.app', APP_LOG_FILE), 'utf8')
  expect(log.trimEnd().split('\n')).toHaveLength(10)
})

test('never recreates a deleted app, and never writes through a link', async () => {
  await writeAppLog(root, 'Gone.app', { level: 'error', text: 'late' })
  expect(await readdir(root)).toEqual([])

  await mkdir(join(root, 'memory'))
  await symlink('../memory', join(root, 'Linked.app'))
  await writeAppLog(root, 'Linked.app', { level: 'error', text: 'x' })
  expect(await readdir(join(root, 'memory'))).toEqual([])
})
