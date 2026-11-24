import { execFile } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'
import { createUpgradeProviders } from '../scripts/connection-upgrade-provider.mjs'

it('routes native Node HTTPS to synthetic accounts and refuses revoked grants and account writes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'holi-565-provider-test-'))
  let providers
  try {
    providers = await createUpgradeProviders(root)
    const { stdout } = await promisify(execFile)(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `
      const viewer = await fetch('https://api.github.com/user');
      const revoked = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST', body: new URLSearchParams({ grant_type: 'refresh_token', client_id: 'synthetic-test.apps.googleusercontent.com', refresh_token: 'revoked-fixture' })
      });
      const refresh = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST', body: new URLSearchParams({ grant_type: 'refresh_token', client_id: 'synthetic-test.apps.googleusercontent.com', refresh_token: 'holi-upgrade-fixture-refresh-never-valid' })
      });
      const write = await fetch('https://api.github.com/user/repos', { method: 'POST', body: '{}' });
      console.log(JSON.stringify({ viewer: (await viewer.json()).id, revoked: revoked.status, error: (await revoked.json()).error, refresh: refresh.status, write: write.status }));
    `,
      ],
      {
        env: { PATH: process.env.PATH, HOME: root, ...providers.env },
        timeout: 15_000,
      },
    )
    expect(JSON.parse(stdout)).toEqual({
      viewer: 565,
      revoked: 400,
      error: 'invalid_grant',
      refresh: 200,
      write: 405,
    })
  } finally {
    try {
      await providers?.close()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }
}, 30_000)
