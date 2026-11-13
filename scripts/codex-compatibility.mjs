import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checkProbe, exactVersion, isolatedEnvironment } from './codex-compatibility-checks.mjs'

const version = process.argv[2]
if (!/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(version ?? ''))
  throw new Error('Expected exact Codex npm version')
const root = await mkdtemp(join(tmpdir(), 'holi-codex-check-'))
const install = join(root, 'package')
const bin = join(install, 'node_modules', '.bin', 'codex')
const env = isolatedEnvironment(root)
const failures = []
try {
  execFileSync(
    'npm',
    ['install', '--prefix', install, '--no-save', '--ignore-scripts', `@openai/codex@${version}`],
    { env, cwd: root, stdio: ['ignore', 'ignore', 'inherit'], timeout: 180_000 },
  )
  const versionProbe = spawnSync(bin, ['--version'], {
    env,
    cwd: root,
    encoding: 'utf8',
    timeout: 10_000,
  })
  if (versionProbe.status !== 0 || !exactVersion(versionProbe.stdout, version))
    failures.push(
      `version: expected ${version}, got ${versionProbe.stdout.trim()}; status=${versionProbe.status}`,
    )

  const probes = [
    ['terminal help', ['--help'], ['--model', '--sandbox', '-c']],
    [
      'terminal resume help',
      ['-c', 'tui.notifications=[\"approval-requested\"]', 'resume', '--help'],
      ['-c'],
    ],
    [
      'exec help',
      ['exec', '--help'],
      ['--json', '--skip-git-repo-check', '-C', '--sandbox', '-c', '-m'],
    ],
    [
      'exec resume help',
      [
        'exec',
        '--json',
        '--skip-git-repo-check',
        '-C',
        root,
        '--sandbox',
        'workspace-write',
        '-c',
        'approval_policy=\"never\"',
        '-m',
        'gpt-5',
        'resume',
        '--help',
      ],
      ['--json', '--skip-git-repo-check', '-c', '-m'],
    ],
  ]
  for (const [name, args, expected] of probes) {
    const result = spawnSync(bin, args, { env, cwd: root, encoding: 'utf8', timeout: 10_000 })
    const output = `${result.stdout}\n${result.stderr}`
    const issue = checkProbe(result, expected, output)
    if (issue) failures.push(`${name}: ${issue}`)
  }
  process.stdout.write(
    JSON.stringify({
      checks: [
        {
          name: 'CLI surface',
          outcome: failures.length ? 'mismatch' : 'pass',
          detail: failures.join('; ') || `Codex ${version}: CLI help verified.`,
        },
        ...[
          'actual notify emission',
          'approval notifications',
          'inference events',
          'sandbox enforcement',
        ].map((name) => ({
          name,
          outcome: 'unverified',
          detail: 'Not exercised: no credentials or inference run.',
        })),
      ],
    }),
  )
  if (failures.length) process.exitCode = 1
} catch (error) {
  process.stdout.write(
    JSON.stringify({
      checks: [
        { name: 'CLI surface', outcome: 'mismatch', detail: `probe failed: ${error.message}` },
      ],
    }),
  )
  process.exitCode = 1
} finally {
  await rm(root, { recursive: true, force: true })
}
