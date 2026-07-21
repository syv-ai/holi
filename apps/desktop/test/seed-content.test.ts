import { spawn } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { ensureSeeded, SEED_FILES } from '../src/main/agent/seed-content'

// no __dirname under vitest's ESM transform
const HOOKS_DIR = fileURLToPath(new URL('../src/main/agent/hooks/', import.meta.url))

const dirs: string[] = []
const servers: Server[] = []

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'holi-seed-'))
  dirs.push(dir)
  return dir
}

afterEach(async () => {
  for (const s of servers.splice(0)) await new Promise((r) => s.close(r))
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })))
})

interface HookRun {
  stdout: string
  code: number | null
}

/** Bare `node` is broken in this environment — spawn the running interpreter. */
function runHook(name: string, opts: { env?: Record<string, string>; cwd?: string; stdin?: string }): Promise<HookRun> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(HOOKS_DIR, `${name}.mjs`)], {
      cwd: opts.cwd ?? process.cwd(),
      env: { PATH: process.env.PATH ?? '', ...opts.env },
    })
    let stdout = ''
    child.stdout.on('data', (d) => (stdout += d))
    child.on('error', reject)
    child.on('close', (code) => resolve({ stdout, code }))
    child.stdin.end(opts.stdin ?? '')
  })
}

/** Capture server standing in for the McpServer's hook routes. */
async function captureServer(): Promise<{
  endpoint: string
  calls: Array<{ path: string; auth?: string; body: any }>
}> {
  const calls: Array<{ path: string; auth?: string; body: any }> = []
  const server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      calls.push({
        path: req.url ?? '',
        auth: req.headers.authorization,
        body: raw ? JSON.parse(raw) : null,
      })
      res.writeHead(204).end()
    })
  })
  servers.push(server)
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('no port')
  return { endpoint: `http://127.0.0.1:${address.port}`, calls }
}

describe('SEED_FILES', () => {
  it('covers exactly the spec\'s managed set (USER.md is machine-local, never seeded)', () => {
    expect(Object.keys(SEED_FILES).sort()).toEqual([
      '.claude/hooks/user-prompt-submit.mjs',
      '.claude/settings.json',
      'AGENTS.md',
      'CLAUDE.md',
      'MEMORY.md',
    ])
  })

  it('CLAUDE.md is exactly the AGENTS.md import shim', () => {
    expect(SEED_FILES['CLAUDE.md']).toBe('<rules>\n@AGENTS.md\n</rules>\n')
  })

  it('settings.json wires the one surviving hook and gates network egress', () => {
    const settings = JSON.parse(SEED_FILES['.claude/settings.json']!)
    expect(settings.hooks.UserPromptSubmit[0].hooks[0].command).toContain(
      '.claude/hooks/user-prompt-submit.mjs',
    )
    // PreToolUse/Stop bracketed the bridge's turn protocol; there is no turn (D60)
    expect(Object.keys(settings.hooks)).toEqual(['UserPromptSubmit'])
    expect(settings.permissions.ask).toEqual(['Bash(curl:*)', 'Bash(wget:*)'])
  })

  it('every hook script has its shebang on line 1', () => {
    for (const rel of Object.keys(SEED_FILES).filter((p) => p.endsWith('.mjs'))) {
      expect(SEED_FILES[rel]!.split('\n')[0]).toBe('#!/usr/bin/env node')
    }
  })
})

describe('ensureSeeded', () => {
  it('seeds every managed file into a fresh working dir', async () => {
    const root = await tempDir()
    const written = await ensureSeeded(root, new Set())
    expect(written.sort()).toEqual(Object.keys(SEED_FILES).sort())
    expect(await readFile(join(root, 'CLAUDE.md'), 'utf8')).toBe(SEED_FILES['CLAUDE.md'])
    expect(await readFile(join(root, '.claude/hooks/user-prompt-submit.mjs'), 'utf8')).toBe(
      SEED_FILES['.claude/hooks/user-prompt-submit.mjs'],
    )
  })

  it('skips files that are already vault docs', async () => {
    const root = await tempDir()
    const written = await ensureSeeded(root, new Set(['CLAUDE.md', 'AGENTS.md']))
    expect(written).not.toContain('CLAUDE.md')
    expect(written).not.toContain('AGENTS.md')
    expect(written).toContain('MEMORY.md')
  })

  it('never overwrites an existing file, and is idempotent', async () => {
    const root = await tempDir()
    await mkdir(root, { recursive: true })
    await writeFile(join(root, 'AGENTS.md'), '# my rules\n')

    const first = await ensureSeeded(root, new Set())
    expect(first).not.toContain('AGENTS.md')
    expect(await readFile(join(root, 'AGENTS.md'), 'utf8')).toBe('# my rules\n')

    const second = await ensureSeeded(root, new Set())
    expect(second).toEqual([]) // everything is on disk now
  })
})

describe('hook scripts', () => {
  it('exits silently outside a vault (bare claude keeps working)', async () => {
    const cwd = await tempDir()
    const run = await runHook('user-prompt-submit', { cwd, stdin: '{}' })
    expect(run.code).toBe(0)
  })

  it('user-prompt-submit renders fill indicators and the focused-note context', async () => {
    const root = await tempDir()
    await writeFile(join(root, 'USER.md'), 'x'.repeat(1240))
    await mkdir(join(root, '.holi'), { recursive: true })
    await writeFile(
      join(root, '.holi/context.local.json'),
      JSON.stringify({
        focusedPath: 'notes/plan.md',
        openPaths: ['notes/plan.md', 'notes/other.md'],
        relatedTasks: [
          { id: 't1', title: 'Draft proposal', status: 'todo', due: '2026-07-20' },
          { id: 't2', title: 'Review', status: 'doing' },
        ],
        backrefPaths: ['notes/other.md'],
      }),
    )

    const run = await runHook('user-prompt-submit', { cwd: root, env: { CLAUDE_PROJECT_DIR: root } })
    expect(run.code).toBe(0)
    expect(run.stdout).toContain('## Memory of the user (`USER.md`) [31% — 1,240/4,000 chars]')
    expect(run.stdout).toContain('## Memory (`MEMORY.md`) [0% — empty]')
    expect(run.stdout).toContain('Active notes:\n- notes/plan.md\n- notes/other.md')
    expect(run.stdout).toContain('Focused note: `notes/plan.md` (use `Read` to view its contents)')
    expect(run.stdout).toContain('# Related non-complete tasks')
    expect(run.stdout).toContain('- [todo] Draft proposal (id=t1, due=2026-07-20)')
    expect(run.stdout).toContain('- [doing] Review (id=t2)')
    expect(run.stdout).toContain('# Related notes (backreferences)\n- [[notes/other.md]]')
    expect(run.stdout).toContain('\n\n***\n\n')
  })

  it('user-prompt-submit prints memory only when nothing is focused', async () => {
    const root = await tempDir()
    await writeFile(join(root, 'MEMORY.md'), 'Vault uses British English.')

    const run = await runHook('user-prompt-submit', { cwd: root, env: { CLAUDE_PROJECT_DIR: root } })
    expect(run.stdout).toContain('## Memory of the user (`USER.md`) [0% — empty]')
    expect(run.stdout).toContain('## Memory (`MEMORY.md`) [0% — 27/5,000 chars]')
    expect(run.stdout).toContain('Vault uses British English.')
    expect(run.stdout).not.toContain('Focused note:')
    expect(run.stdout).not.toContain('# Related non-complete tasks')
  })
})
