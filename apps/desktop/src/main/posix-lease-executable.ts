import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

export function posixLeaseExecutable(): string {
  const name = 'holi-posix-lease'
  if (process.type === 'browser') {
    const { app } = require('electron') as typeof import('electron')
    return app.isPackaged
      ? join(process.resourcesPath, name)
      : join(app.getAppPath(), 'build', 'native', name)
  }
  return fileURLToPath(new URL(`../../build/native/${name}`, import.meta.url))
}
