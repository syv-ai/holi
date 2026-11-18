import { join } from 'node:path'

export function isolatedEnvironment(
  root,
  providerHome,
  path = process.env.PATH ?? '/usr/bin:/bin',
) {
  const home = join(root, 'home')
  return {
    PATH: path,
    HOME: home,
    [providerHome]: join(home, providerHome === 'CLAUDE_CONFIG_DIR' ? '.claude' : '.codex'),
    npm_config_cache: join(root, 'npm-cache'),
    npm_config_userconfig: join(root, 'npmrc'),
    npm_config_globalconfig: join(root, 'global-npmrc'),
    CI: '1',
  }
}

export function checkProbe(result, expected, output, { label, separators }) {
  if (result.error) return result.error.code === 'ETIMEDOUT' ? 'timed out' : result.error.message
  if (result.status !== 0) return `exit ${result.status}`
  const missing = expected.filter((token) => {
    const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    return !new RegExp(`(^|[\\s${separators}])${escaped}([\\s${separators}=]|$)`, 'm').test(output)
  })
  return missing.length ? `missing consumed ${label} ${missing.join(', ')}` : null
}
