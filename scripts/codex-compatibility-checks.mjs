import {
  checkProbe as checkSharedProbe,
  isolatedEnvironment as isolatedSharedEnvironment,
} from './compatibility-checks.mjs'

export function isolatedEnvironment(root, path = process.env.PATH ?? '/usr/bin:/bin') {
  return isolatedSharedEnvironment(root, 'CODEX_HOME', path)
}

export function exactVersion(output, version) {
  const escaped = version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(?:^|\\b)codex(?:-cli)?\\s+${escaped}(?:\\s|$)`, 'm').test(output.trim())
}

export function checkProbe(result, expected, output) {
  return checkSharedProbe(result, expected, output, { label: 'options', separators: ',' })
}
