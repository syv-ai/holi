import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const version = process.argv[2]
if (!/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(version ?? ''))
  throw new Error('Expected exact Codex npm version')
const root = await mkdtemp(join(tmpdir(), 'holi-codex-check-'))
const home = join(root, 'home')
const install = join(root, 'package')
const bin = join(install, 'node_modules', '.bin', 'codex')
const env = {
  ...process.env,
  HOME: home,
  CODEX_HOME: join(home, '.codex'),
  npm_config_cache: join(root, 'npm-cache'),
}
const failures = []
try {
  execFileSync(
    'npm',
    ['install', '--prefix', install, '--no-save', '--ignore-scripts', `@openai/codex@${version}`],
    { env, stdio: 'inherit', timeout: 180_000 },
  )
  const versionProbe = spawnSync(bin, ['--version'], { env, encoding: 'utf8', timeout: 10_000 })
  if (versionProbe.status !== 0 || !versionProbe.stdout.includes(version))
    failures.push(
      `version: expected ${version}, got ${versionProbe.stdout.trim()}; status=${versionProbe.status}`,
    )

  const probes = [
    ['terminal help', ['--help'], []],
    ['terminal resume help', ['resume', '--help'], []],
    [
      'exec help',
      ['exec', '--help'],
      ['--json', '--skip-git-repo-check', '-C', '--sandbox', '-c', '-m'],
    ],
    // Exec-level cwd/sandbox options belong before the resume verb; the resume
    // subcommand help intentionally omits them. Global config/json/model remain visible.
    ['exec resume help', ['exec', 'resume', '--help'], ['--json', '-c', '-m']],
  ]
  for (const [name, args, expected] of probes) {
    const result = spawnSync(bin, args, { env, encoding: 'utf8', timeout: 10_000 })
    const output = `${result.stdout}\n${result.stderr}`
    if (result.error || result.status !== 0)
      failures.push(`${name}: ${result.error?.message ?? `exit ${result.status}`}`)
    else {
      const missing = expected.filter(
        (option) =>
          !new RegExp(
            `(^|[\\s,])${option.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&')}([\\s,=]|$)`,
            'm',
          ).test(output),
      )
      if (missing.length) failures.push(`${name}: missing consumed options ${missing.join(', ')}`)
    }
  }
  process.stdout.write(
    JSON.stringify({
      checks: [
        {
          name: 'CLI surface',
          outcome: failures.length ? 'mismatch' : 'pass',
          detail:
            failures.join('; ') ||
            `Codex ${version}: version, terminal/resume and exec/resume help verified; no inference run.`,
        },
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
