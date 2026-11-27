import { app } from 'electron'
import { realpathSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { createFixtureSession } from './agent-inbox-550-session'

export async function createSession(userDataDir = app.getPath('userData')) {
  const root = process.env.HOLI_550_ROOT
  const expected = join(realpathSync(resolve(__dirname, '../..')), 'runtime')
  if (root !== expected || userDataDir !== join(expected, 'user-data'))
    throw new Error('Fixture authentication requires the build-owned profile')
  return createFixtureSession(root)
}
