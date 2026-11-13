import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { checkProbe, exactVersion, isolatedEnvironment } from './claude-compatibility-checks.mjs'

const bounded = (value, max = 3000) =>
  String(value ?? '')
    .slice(0, max)
    .replace(/[\r\n]+/g, ' ')
    .trim()
const probes = [
  ['agents', ['agents', '--help'], ['agents', '--json', '--all']],
  ['attach', ['attach', '--help'], ['attach']],
  ['stop', ['stop', '--help'], ['stop']],
  ['respawn', ['respawn', '--help'], ['respawn']],
  ['rm', ['rm', '--help'], ['rm']],
  [
    'root options',
    ['--help'],
    [
      '--bg',
      '--name',
      '--resume',
      '--fork-session',
      '--model',
      '--append-system-prompt',
      '--mcp-config',
      '--allowedTools',
      '--disallowedTools',
    ],
  ],
]

export async function runCompatibility(
  version,
  { npm = 'npm', timeout = 10_000, installTimeout = 180_000 } = {},
) {
  if (!/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(version ?? ''))
    throw new Error('Expected exact Claude Code npm version')
  const root = await mkdtemp(join(tmpdir(), 'holi-claude-check-'))
  const install = join(root, 'package')
  const bin = join(install, 'node_modules', '.bin', 'claude')
  const env = isolatedEnvironment(root)
  const failures = []
  try {
    execFileSync(
      npm,
      [
        'install',
        '--prefix',
        install,
        '--no-save',
        '--ignore-scripts',
        `@anthropic-ai/claude-code@${version}`,
      ],
      {
        env,
        cwd: root,
        stdio: ['ignore', 'ignore', 'ignore'],
        timeout: installTimeout,
        maxBuffer: 64 * 1024,
      },
    )
    const versionProbe = spawnSync(bin, ['--version'], {
      env,
      cwd: root,
      encoding: 'utf8',
      timeout,
      maxBuffer: 64 * 1024,
    })
    const versionOutput = `${versionProbe.stdout ?? ''}\n${versionProbe.stderr ?? ''}`
    if (versionProbe.status !== 0 || !exactVersion(versionOutput, version))
      failures.push(
        `version: expected ${version}, got ${bounded(versionOutput)}; ${versionProbe.error?.code ?? `status=${versionProbe.status}`}`,
      )
    for (const [name, args, expected] of probes) {
      const result = spawnSync(bin, args, {
        env,
        cwd: root,
        encoding: 'utf8',
        timeout,
        maxBuffer: 64 * 1024,
      })
      const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`
      const mismatch = checkProbe(result, expected, output)
      if (mismatch) failures.push(`${name}: ${mismatch}; evidence=${bounded(output)}`)
    }
    return {
      failed: failures.length > 0,
      checks: [
        {
          name: 'CLI surface',
          outcome: failures.length ? 'mismatch' : 'pass',
          detail:
            failures.join('; ') ||
            `Claude Code ${version}: consumed CLI commands/options verified.`,
        },
        ...[
          'fixture consumers',
          'historical-session inclusion',
          'actual hook emission',
          'permissions',
          'messaging',
        ].map((name) => ({
          name,
          outcome: 'unverified',
          detail: 'Not verified by the credential-free CLI probe.',
        })),
      ],
    }
  } catch (error) {
    return {
      failed: true,
      checks: [
        {
          name: 'CLI surface',
          outcome: 'mismatch',
          detail: `install/probe failed: ${bounded(error.message)}`,
        },
      ],
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = await runCompatibility(process.argv[2])
  process.stdout.write(JSON.stringify({ checks: result.checks }))
  if (result.failed) process.exitCode = 1
}
