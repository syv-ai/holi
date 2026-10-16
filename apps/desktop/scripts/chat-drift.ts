/**
 * Has Claude Code's transcript format moved past what the chat reader knows?
 * Streams real transcripts through the reader's own classifier and reports
 * what it has no rule for (docs/features/agent-sessions.md, The chat, "Drift").
 *
 *   pnpm --filter @holi/desktop run chat:drift [paths...]
 *       [--json] [--max-files N] [--since-days N] [--strict-version]
 *
 * Paths are transcript files or directories (searched for `*.jsonl`). With
 * none it reads `~/.claude/projects` and the Holi agent-config `projects`
 * directories. `--max-files N` keeps the N most recently modified files;
 * `--since-days N` only files modified in the last N days (cheap enough for a
 * daily run). Files under a `/subagents/` directory are read as sub-agents'.
 *
 * Output is counts, shape signatures, Claude Code versions and `file:line`
 * examples: never a line's content, so a report can be pasted into an issue.
 * Nothing leaves the machine; the only process run is `claude --version`.
 *
 * Exit code 1 when any line has a shape the reader has no rule for (or, with
 * `--strict-version`, when the installed `claude` is outside the verified
 * range); 2 when no transcript was found or the arguments are wrong.
 */
import { spawnSync } from 'node:child_process'
import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { basename } from 'node:path'
import { createInterface } from 'node:readline'
import {
  classifyLine,
  isVerifiedVersion,
  VERIFIED_CLAUDE_VERSIONS,
} from '../src/plugins/agent/main/claude/transcript'
import { MAX_LINE_BYTES, oversizeLine } from '../src/plugins/agent/main/claude/transcript/classify'
import { defaultRoots, jsonlFiles } from './scrub-transcript'

interface Options {
  roots: string[]
  json: boolean
  maxFiles: number
  sinceDays: number | null
  strictVersion: boolean
}

interface UnknownShape {
  shape: string
  count: number
  firstVersion?: string
  lastVersion?: string
  /** `basename:lineNo`: where to look, never what is there. */
  example: string
}

export interface DriftSummary {
  files: number
  lines: number
  rendered: number
  hidden: Record<string, number>
  unknown: UnknownShape[]
  oversize: number
  unparseable: number
  firstVersion?: string
  lastVersion?: string
  /** Versions outside the verified range, with how many lines each wrote. */
  unverifiedVersions: Record<string, number>
  claude: { installed?: string; verified: string; inRange?: boolean; note: string }
}

const HELP = `usage: chat:drift [paths...] [--json] [--max-files N] [--since-days N] [--strict-version]
Classifies real Claude Code transcripts with the chat reader and reports the line shapes it has no rule for.
Exit 1 if there are any.`

function parseArgs(argv: string[]): Options | null {
  const options: Options = {
    roots: [],
    json: false,
    maxFiles: Number.POSITIVE_INFINITY,
    sinceDays: null,
    strictVersion: false,
  }
  const number = (flag: string, value: string | undefined): number => {
    const n = Number(value)
    if (value === undefined || !Number.isFinite(n) || n < 0) {
      throw new Error(`${flag} needs a number`)
    }
    return n
  }
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i] ?? ''
    if (a === '--help' || a === '-h') return null
    else if (a === '--json') options.json = true
    else if (a === '--strict-version') options.strictVersion = true
    else if (a === '--max-files') options.maxFiles = number(a, argv[(i += 1)])
    else if (a === '--since-days') options.sinceDays = number(a, argv[(i += 1)])
    else if (a.startsWith('--')) throw new Error(`unknown flag ${a}`)
    else options.roots.push(a)
  }
  return options
}

/** `a.b.c` as numbers, or null. */
function triple(version: string): [number, number, number] | null {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(version)
  return m === null ? null : [Number(m[1]), Number(m[2]), Number(m[3])]
}

/** Negative when `a` is older than `b`. Unreadable versions sort first. */
function compareVersions(a: string, b: string): number {
  const x = triple(a)
  const y = triple(b)
  if (x === null || y === null) return x === null ? (y === null ? 0 : -1) : 1
  for (let i = 0; i < 3; i += 1) {
    if (x[i] !== y[i]) return (x[i] ?? 0) - (y[i] ?? 0)
  }
  return 0
}

const older = (a: string | undefined, b: string): string =>
  a === undefined || compareVersions(b, a) < 0 ? b : a
const newer = (a: string | undefined, b: string): string =>
  a === undefined || compareVersions(b, a) > 0 ? b : a

/** The installed `claude`'s version, from `claude --version` (local, no network). */
function installedClaude(): { version?: string; note: string } {
  const run = spawnSync('claude', ['--version'], { encoding: 'utf8', timeout: 15_000 })
  if (run.error !== undefined || run.status !== 0) {
    return { note: 'claude is not on PATH (or did not answer --version): version check skipped' }
  }
  const version = /(\d+\.\d+\.\d+)/.exec(run.stdout)?.[1]
  return version === undefined
    ? { note: 'claude --version gave no version number: version check skipped' }
    : { version, note: '' }
}

async function collectFiles(options: Options): Promise<string[]> {
  const roots = options.roots.length > 0 ? options.roots : await defaultRoots()
  const found: { path: string; mtime: number }[] = []
  const cutoff = options.sinceDays === null ? 0 : Date.now() - options.sinceDays * 86_400_000
  for (const root of roots) {
    for await (const path of jsonlFiles(root)) {
      const info = await stat(path).catch(() => null)
      if (info === null || info.mtimeMs < cutoff) continue
      found.push({ path, mtime: info.mtimeMs })
    }
  }
  found.sort((a, b) => b.mtime - a.mtime || (a.path < b.path ? -1 : 1))
  return found.slice(0, options.maxFiles).map((f) => f.path)
}

export async function summarise(files: string[]): Promise<DriftSummary> {
  const summary: DriftSummary = {
    files: files.length,
    lines: 0,
    rendered: 0,
    hidden: {},
    unknown: [],
    oversize: 0,
    unparseable: 0,
    unverifiedVersions: {},
    claude: {
      verified: `${VERIFIED_CLAUDE_VERSIONS.min} - ${VERIFIED_CLAUDE_VERSIONS.max}`,
      note: '',
    },
  }
  const unknown = new Map<string, UnknownShape>()
  for (const path of files) {
    const sidechain = /[\\/]subagents[\\/]/.test(path)
    const name = basename(path)
    const reader = createInterface({ input: createReadStream(path), crlfDelay: Infinity })
    let lineNo = 0
    for await (const line of reader) {
      lineNo += 1
      if (line === '') continue
      summary.lines += 1
      const result =
        Buffer.byteLength(line) > MAX_LINE_BYTES
          ? oversizeLine(Buffer.byteLength(line))
          : classifyLine(line, { sidechain })
      const { version, disposition } = result
      if (version !== undefined) {
        summary.firstVersion = older(summary.firstVersion, version)
        summary.lastVersion = newer(summary.lastVersion, version)
        if (!isVerifiedVersion(version)) {
          summary.unverifiedVersions[version] = (summary.unverifiedVersions[version] ?? 0) + 1
        }
      }
      if (disposition.kind === 'rendered') summary.rendered += 1
      else if (disposition.kind === 'hidden') {
        summary.hidden[disposition.reason] = (summary.hidden[disposition.reason] ?? 0) + 1
      } else if (disposition.shape === 'oversize') summary.oversize += 1
      else if (disposition.shape === 'unparseable') summary.unparseable += 1
      else {
        const seen = unknown.get(disposition.shape)
        if (seen === undefined) {
          unknown.set(disposition.shape, {
            shape: disposition.shape,
            count: 1,
            ...(version === undefined ? {} : { firstVersion: version, lastVersion: version }),
            example: `${name}:${lineNo}`,
          })
        } else {
          seen.count += 1
          if (version !== undefined) {
            seen.firstVersion = older(seen.firstVersion, version)
            seen.lastVersion = newer(seen.lastVersion, version)
          }
        }
      }
    }
  }
  summary.unknown = [...unknown.values()].sort((a, b) => b.count - a.count)
  return summary
}

const n = (value: number): string => value.toLocaleString('en-US')

function render(s: DriftSummary): string {
  const out: string[] = []
  const hiddenTotal = Object.values(s.hidden).reduce((a, b) => a + b, 0)
  const unknownTotal = s.unknown.reduce((a, u) => a + u.count, 0)
  out.push(`chat:drift  ${n(s.files)} files, ${n(s.lines)} lines`)
  out.push('')
  out.push('  disposition                 lines')
  out.push(`  rendered              ${n(s.rendered).padStart(10)}`)
  out.push(`  hidden                ${n(hiddenTotal).padStart(10)}`)
  for (const [reason, count] of Object.entries(s.hidden).sort((a, b) => b[1] - a[1])) {
    out.push(`    ${reason.padEnd(18)}${n(count).padStart(10)}`)
  }
  out.push(`  unknown               ${n(unknownTotal).padStart(10)}`)
  if (s.oversize > 0) out.push(`  oversize (placeholder)${n(s.oversize).padStart(10)}`)
  if (s.unparseable > 0) out.push(`  unparseable           ${n(s.unparseable).padStart(10)}`)
  out.push('')
  out.push(
    s.firstVersion === undefined
      ? 'Claude Code versions in the transcripts: none recorded'
      : `Claude Code versions in the transcripts: ${s.firstVersion} .. ${s.lastVersion}`,
  )
  const unverified = Object.entries(s.unverifiedVersions)
  if (unverified.length > 0) {
    out.push(
      `  outside the verified range (${s.claude.verified}): ` +
        unverified
          .sort((a, b) => compareVersions(a[0], b[0]))
          .map(([v, c]) => `${v} (${n(c)} lines)`)
          .join(', '),
    )
  }
  if (s.claude.installed !== undefined) {
    out.push(
      `Installed claude ${s.claude.installed}: ` +
        (s.claude.inRange === true
          ? `inside the verified range (${s.claude.verified})`
          : `WARNING outside the verified range (${s.claude.verified}); read the report below, then re-verify and update VERIFIED_CLAUDE_VERSIONS`),
    )
  } else out.push(s.claude.note)
  out.push('')
  if (s.unknown.length === 0) {
    out.push('Unknown shapes: none. The reader has a rule for every line it was shown.')
  } else {
    out.push(`UNKNOWN SHAPES (${s.unknown.length}): lines the reader has no rule for`)
    const width = Math.max(5, ...s.unknown.map((u) => u.shape.length))
    out.push(
      `  ${'shape'.padEnd(width)}  ${'lines'.padStart(8)}  ${'first'.padEnd(9)} ${'last'.padEnd(9)} example`,
    )
    for (const u of s.unknown) {
      out.push(
        `  ${u.shape.padEnd(width)}  ${n(u.count).padStart(8)}  ${(u.firstVersion ?? '-').padEnd(9)} ${(u.lastVersion ?? '-').padEnd(9)} ${u.example}`,
      )
    }
    out.push('')
    out.push(
      'Add a rule in transcript/known.ts (hide it with a reason) or classify.ts (draw it), then',
    )
    out.push('refresh the fixtures with `pnpm --filter @holi/desktop run chat:fixtures`.')
  }
  return out.join('\n')
}

export async function main(argv: string[]): Promise<number> {
  let options: Options | null
  try {
    options = parseArgs(argv)
  } catch (error) {
    console.error(`chat:drift: ${(error as Error).message}\n${HELP}`)
    return 2
  }
  if (options === null) {
    console.log(HELP)
    return 0
  }
  const files = await collectFiles(options)
  if (files.length === 0) {
    console.error('chat:drift: no transcripts found (pass a directory, or check --since-days)')
    return 2
  }
  const summary = await summarise(files)
  const installed = installedClaude()
  summary.claude.note = installed.note
  if (installed.version !== undefined) {
    summary.claude.installed = installed.version
    summary.claude.inRange = isVerifiedVersion(installed.version)
  }
  process.stdout.write(`${options.json ? JSON.stringify(summary, null, 2) : render(summary)}\n`)
  if (summary.unknown.length > 0) return 1
  if (options.strictVersion && summary.claude.inRange === false) return 1
  return 0
}
