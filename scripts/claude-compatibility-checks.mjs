import {
  checkProbe as checkSharedProbe,
  isolatedEnvironment as isolatedSharedEnvironment,
} from './compatibility-checks.mjs'

export function isolatedEnvironment(root, path = process.env.PATH ?? '/usr/bin:/bin') {
  return isolatedSharedEnvironment(root, 'CLAUDE_CONFIG_DIR', path)
}

export function exactVersion(output, version) {
  if (!/^\d+\.\d+\.\d+$/.test(version ?? '')) return false
  const escaped = version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`^(?:claude(?:-code)?\\s+)?${escaped}(?:\\s+\\(Claude Code\\))?$`, 'i').test(
    String(output ?? '').trim(),
  )
}

export function checkProbe(result, expected, output) {
  return checkSharedProbe(result, expected, output, { label: 'commands/options', separators: ',=' })
}
