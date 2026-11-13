import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

const maxOutputBytes = 256 * 1024
const maxDiagnosticChars = 1000
const timeoutMs = 10_000

function boundedDiagnostic(value) {
  const text = String(value).trim()
  return text.length > maxDiagnosticChars ? `${text.slice(0, maxDiagnosticChars)}…` : text
}

function run(bin, args, options) {
  const result = spawnSync(bin, args, {
    ...options,
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: maxOutputBytes,
    windowsHide: true,
  })
  if (result.error) throw new Error(`${args[0]} failed: ${result.error.message}`)
  if (result.status !== 0)
    throw new Error(`${args[0]} exited ${result.status}: ${boundedDiagnostic(result.stderr)}`)
  if (result.stderr.trim())
    throw new Error(`${args[0]} wrote unexpected stderr: ${boundedDiagnostic(result.stderr)}`)
  return result.stdout.trim()
}

export function checkPiCli({ bin, expectedVersion }) {
  if (!bin || !expectedVersion) throw new Error('Pi binary and exact expected version are required')
  const root = mkdtempSync(join(tmpdir(), 'holi-pi-contract-'))
  const home = join(root, 'home')
  const workdir = join(root, 'workdir')
  const config = join(root, 'config')
  const data = join(root, 'data')
  const temp = join(root, 'tmp')
  for (const directory of [home, workdir, config, data, temp]) mkdirSync(directory)
  const executable = resolve(bin)
  const env = {
    HOME: home,
    XDG_CONFIG_HOME: config,
    XDG_DATA_HOME: data,
    TMPDIR: temp,
    PATH: `${dirname(executable)}:${dirname(process.execPath)}:/usr/bin:/bin`,
    PI_OFFLINE: '1',
  }
  const options = { cwd: workdir, env }
  try {
    const version = run(executable, ['--version'], options)
    if (version !== expectedVersion) {
      return {
        outcome: 'mismatch',
        detail: `Pi --version returned ${version}; npm registry observation was ${expectedVersion}.`,
      }
    }
    const help = run(executable, ['--help'], options)
    const required = [
      '--session <path|id>',
      '--continue',
      '--resume',
      '--fork <path|id>',
      '--model <pattern>',
      '--provider <name>',
      '--mode <mode>',
      '--append-system-prompt <text>',
      '--no-tools',
      '--no-extensions',
      '--no-skills',
      '--no-prompt-templates',
      '--no-context-files',
      '--no-mcp',
      '--no-approve',
    ]
    const missing = required.filter((flag) => !help.includes(flag))
    if (missing.length)
      return {
        outcome: 'mismatch',
        detail: `Pi ${version} --help is missing required options: ${missing.join(', ')}.`,
      }
    return {
      outcome: 'pass',
      detail: `Pi ${version} --version and --help verified in a disposable offline home; options: ${required.join(', ')}.`,
    }
  } catch (error) {
    return {
      outcome: 'mismatch',
      detail: `Pi CLI contract check failed: ${error instanceof Error ? error.message : String(error)}`,
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) {
  const [, , bin, expectedVersion] = process.argv
  try {
    process.stdout.write(`${JSON.stringify(checkPiCli({ bin, expectedVersion }))}\n`)
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  }
}
