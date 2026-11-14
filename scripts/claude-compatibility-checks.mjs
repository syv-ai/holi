import { join } from 'node:path'

export function isolatedEnvironment(root, path = process.env.PATH ?? '/usr/bin:/bin') {
  const home = join(root, 'home')
  return {
    PATH: path,
    HOME: home,
    CLAUDE_CONFIG_DIR: join(home, '.claude'),
    npm_config_cache: join(root, 'npm-cache'),
    npm_config_userconfig: join(root, 'npmrc'),
    npm_config_globalconfig: join(root, 'global-npmrc'),
    CI: '1',
  }
}

export function exactVersion(output, version) {
  if (!/^\d+\.\d+\.\d+$/.test(version ?? '')) return false
  const escaped = version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`^(?:claude(?:-code)?\\s+)?${escaped}(?:\\s+\\(Claude Code\\))?$`, 'i').test(
    String(output ?? '').trim(),
  )
}

export function checkProbe(result, expected, output) {
  if (result.error) return result.error.code === 'ETIMEDOUT' ? 'timed out' : result.error.message
  if (result.status !== 0) return `exit ${result.status}`
  const missing = expected.filter(
    (token) =>
      !new RegExp(
        `(^|[\\s,=])${token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([\\s,=]|$)`,
        'm',
      ).test(output),
  )
  return missing.length ? `missing consumed commands/options ${missing.join(', ')}` : null
}
