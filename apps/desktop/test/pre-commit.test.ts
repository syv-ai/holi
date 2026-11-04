import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { loadLoginPath } from '../src/main/bin'
import { createVaultPreCommit } from '../src/main/vault/hooks/pre-commit'

const directories: string[] = []

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  )
})

describe('vault pre-commit environment', () => {
  it('uses the login PATH when it resolves after the pre-commit runner is created', async () => {
    const root = await mkdtemp(join(tmpdir(), 'holi-pre-commit-'))
    directories.push(root)
    const inherited = join(root, 'inherited')
    const login = join(root, 'login')
    await mkdir(inherited)
    await mkdir(login)
    const executable = join(inherited, 'pre-commit')
    await writeFile(executable, '#!/bin/sh\nprintf "%s" "$PATH"\n')
    await chmod(executable, 0o755)

    let resolveLogin!: () => void
    const loginReady = new Promise<void>((resolve) => {
      resolveLogin = resolve
    })
    const loading = loadLoginPath({ SHELL: '/bin/sh', HOME: root, PATH: inherited }, async () => {
      await loginReady
      return '__HOLI_LOGIN_PATH__' + login + '__HOLI_LOGIN_PATH__'
    })
    const preCommit = createVaultPreCommit({
      file: join(root, 'allowances.json'),
      env: { HOME: root, PATH: inherited },
    })

    resolveLogin()
    await loading
    const status = await preCommit.status('example/repo', root)

    expect(status.tool).toContain(login)
  })
})
