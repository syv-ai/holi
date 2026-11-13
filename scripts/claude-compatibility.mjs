import { execFileSync, spawnSync } from 'node:child_process'
import { access, readFile, stat, mkdtemp, rm } from 'node:fs/promises'
import { arch, platform, tmpdir } from 'node:os'
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

export function nativePlatform(os = platform(), cpu = arch(), isMusl = detectMusl(os)) {
  if (os === 'darwin' && ['arm64', 'x64'].includes(cpu)) return `darwin-${cpu}`
  if (os === 'win32' && ['arm64', 'x64'].includes(cpu)) return `win32-${cpu}`
  if (os === 'linux' && ['arm64', 'x64'].includes(cpu))
    return `linux-${cpu}${isMusl ? '-musl' : ''}`
  return null
}

function detectMusl(os) {
  return os === 'linux' && process.report?.getReport?.().header?.glibcVersionRuntime === undefined
}

async function readManifest(path) {
  const info = await stat(path)
  if (!info.isFile() || info.size > 64 * 1024) throw new Error('invalid package manifest')
  return JSON.parse(await readFile(path, 'utf8'))
}

async function resolveNativeBinary(install, version, os = platform(), cpu = arch()) {
  const wrapper = join(install, 'node_modules', '@anthropic-ai', 'claude-code')
  const wrapperManifest = await readManifest(join(wrapper, 'package.json'))
  if (
    wrapperManifest.name !== '@anthropic-ai/claude-code' ||
    wrapperManifest.version !== version ||
    wrapperManifest.bin?.claude !== 'bin/claude.exe'
  )
    throw new Error('installed Claude wrapper manifest does not match the requested version')
  const platformKey = nativePlatform(os, cpu)
  if (!platformKey) throw new Error(`unsupported Claude platform ${os}/${cpu}`)
  const packageName = `@anthropic-ai/claude-code-${platformKey}`
  const nativeRoot = join(install, 'node_modules', '@anthropic-ai', `claude-code-${platformKey}`)
  const nativeManifest = await readManifest(join(nativeRoot, 'package.json'))
  if (
    nativeManifest.name !== packageName ||
    nativeManifest.version !== version ||
    nativeManifest.os?.length !== 1 ||
    nativeManifest.os[0] !== os ||
    nativeManifest.cpu?.length !== 1 ||
    nativeManifest.cpu[0] !== cpu
  )
    throw new Error(`installed Claude native package does not match ${version} ${os}/${cpu}`)
  const binary = join(nativeRoot, os === 'win32' ? 'claude.exe' : 'claude')
  await access(binary)
  const binaryInfo = await stat(binary)
  if (!binaryInfo.isFile() || binaryInfo.size === 0)
    throw new Error('installed Claude native binary is invalid')
  return binary
}

export async function runCompatibility(
  version,
  { npm = 'npm', timeout = 10_000, installTimeout = 180_000 } = {},
) {
  if (!/^\d+\.\d+\.\d+$/.test(version ?? ''))
    throw new Error('Expected exact Claude Code npm version')
  const root = await mkdtemp(join(tmpdir(), 'holi-claude-check-'))
  const install = join(root, 'package')
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
    const nativeBin = await resolveNativeBinary(install, version)
    const versionProbe = spawnSync(nativeBin, ['--version'], {
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
      const result = spawnSync(nativeBin, args, {
        env,
        cwd: root,
        encoding: 'utf8',
        timeout,
        maxBuffer: 64 * 1024,
      })
      const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`
      const mismatch = checkProbe(result, expected, output)
      const missingBackgroundFlag =
        name === 'root options' && !/(^|[\s,=])--(?:bg|background)([\s,=]|$)/m.test(output)
      if (mismatch || missingBackgroundFlag)
        failures.push(
          `${name}: ${mismatch ?? 'missing consumed option --bg (help may advertise --background)'}; evidence=${bounded(output)}`,
        )
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
