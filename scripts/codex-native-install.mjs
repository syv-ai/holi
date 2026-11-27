import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

const clean = (text) =>
  text
    .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g, '')
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')

export async function installPinnedCodex({ root, own }) {
  const install = await own(
    'npm',
    [
      'install',
      '--prefix',
      join(root, 'install'),
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      '@openai/codex@0.169.0',
    ],
    'install',
    {
      npm_config_userconfig: join(root, 'user-npmrc'),
      npm_config_globalconfig: join(root, 'global-npmrc'),
      npm_config_cache: join(root, 'cache'),
    },
    90000,
  )
  if ((await install.waitForExit()).code !== 0)
    throw Error(`Pinned installation failed: ${clean(install.output.toString()).slice(-4000)}`)
  await install.close()
  const pkg = JSON.parse(
    await readFile(join(root, 'install/node_modules/@openai/codex/package.json'), 'utf8'),
  )
  if (pkg.name !== '@openai/codex' || pkg.version !== '0.169.0')
    throw Error('Package identity mismatch')
  return {
    bin: join(root, 'install/node_modules/@openai/codex/bin/codex.js'),
    package: { name: pkg.name, version: pkg.version },
  }
}
