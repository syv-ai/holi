import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { checkProbe, exactVersion, isolatedEnvironment } from './codex-compatibility-checks.mjs'

export async function runCompatibility(version, { npm = 'npm', timeout = 10_000 } = {}) {
  if (!/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(version ?? ''))
    throw new Error('Expected exact Codex npm version')
  const root = await mkdtemp(join(tmpdir(), 'holi-codex-check-'))
  const install = join(root, 'package')
  const bin = join(install, 'node_modules', '.bin', 'codex')
  const env = isolatedEnvironment(root)
  const failures = []
  try {
    execFileSync(
      npm,
      ['install', '--prefix', install, '--no-save', '--ignore-scripts', `@openai/codex@${version}`],
      { env, cwd: root, stdio: ['ignore', 'ignore', 'inherit'], timeout: 180_000 },
    )
    const versionProbe = spawnSync(bin, ['--version'], {
      env,
      cwd: root,
      encoding: 'utf8',
      timeout,
    })
    if (versionProbe.status !== 0 || !exactVersion(versionProbe.stdout ?? '', version))
      failures.push(
        `version: expected ${version}, got ${(versionProbe.stdout ?? '').trim()}; status=${versionProbe.status}`,
      )

    const probes = [
      [
        'terminal',
        [
          '-c',
          'notify=["sh","-c","hook"]',
          '-c',
          'tui.notifications=["approval-requested"]',
          '--help',
        ],
        ['-c', 'notify', 'tui.notifications'],
      ],
      [
        'terminal resume',
        [
          '-c',
          'notify=["sh","-c","hook"]',
          '-c',
          'tui.notifications=["approval-requested"]',
          'resume',
          '--help',
        ],
        ['-c', 'notify', 'tui.notifications', 'resume'],
      ],
      [
        'job exec',
        [
          'exec',
          '--json',
          '--skip-git-repo-check',
          '-C',
          root,
          '--sandbox',
          'workspace-write',
          '-c',
          'approval_policy="never"',
          '-c',
          'sandbox_workspace_write.network_access=false',
          '-c',
          'web_search="disabled"',
          '-c',
          'tools.web_search=false',
          '-m',
          'gpt-5',
          '--help',
        ],
        ['exec', '--json', '--skip-git-repo-check', '-C', '--sandbox', '-c', '-m'],
      ],
      [
        'job exec resume',
        [
          'exec',
          '--json',
          '--skip-git-repo-check',
          '-C',
          root,
          '--sandbox',
          'workspace-write',
          '-c',
          'approval_policy="never"',
          '-c',
          'sandbox_workspace_write.network_access=false',
          '-c',
          'web_search="disabled"',
          '-c',
          'tools.web_search=false',
          '-m',
          'gpt-5',
          'resume',
          '--help',
        ],
        ['exec', '--json', '--skip-git-repo-check', '-C', '--sandbox', '-c', '-m', 'resume'],
      ],
      [
        'fenced terminal',
        [
          '-C',
          root,
          '--sandbox',
          'workspace-write',
          '-c',
          'approval_policy="on-request"',
          '-c',
          'sandbox_workspace_write.network_access=false',
          '-c',
          'web_search="disabled"',
          '-c',
          'tools.web_search=false',
          '--help',
        ],
        ['-C', '--sandbox', '-c'],
      ],
    ]
    for (const [name, args, expected] of probes) {
      const result = spawnSync(bin, args, { env, cwd: root, encoding: 'utf8', timeout })
      const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`
      const issue = checkProbe(result, expected, output)
      if (issue) failures.push(`${name}: ${issue}`)
    }
    return {
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
      failed: failures.length > 0,
    }
  } catch (error) {
    return {
      checks: [
        { name: 'CLI surface', outcome: 'mismatch', detail: `probe failed: ${error.message}` },
      ],
      failed: true,
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
