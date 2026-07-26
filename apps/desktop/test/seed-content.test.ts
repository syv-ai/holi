import { execFile, spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { LOCAL_ONLY_IGNORE_LINES } from '@holi/shared'
import { afterEach, describe, expect, it } from 'vitest'
import { GITIGNORE, ensureSeeded, SEED_FILES } from '../src/main/agent/seed-content'

const exec = promisify(execFile)

// no __dirname under vitest's ESM transform
const HOOKS_DIR = fileURLToPath(new URL('../src/main/agent/hooks/', import.meta.url))

const dirs: string[] = []

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'holi-seed-'))
  dirs.push(dir)
  return dir
}

afterEach(async () => {
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

describe('SEED_FILES', () => {
  it('covers exactly the spec\'s managed set (USER.md is machine-local, never seeded)', () => {
    expect(Object.keys(SEED_FILES).sort()).toEqual([
      '.claude/hooks/user-prompt-submit.mjs',
      '.claude/settings.json',
      '.holi/templates/plain/template.json',
      '.holi/templates/plain/template.typ',
      '.holi/vault.json',
      'AGENTS.md',
      'CLAUDE.md',
      'MEMORY.md',
    ])
  })

  it('.holi/vault.json is the durable vault marker', () => {
    expect(JSON.parse(SEED_FILES['.holi/vault.json']!)).toEqual({ version: 1 })
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
    const written = await ensureSeeded(root)
    // The .gitignore is written too, but it is not in SEED_FILES: it is the one
    // managed file that is merged line-wise rather than created-if-missing.
    expect(written.sort()).toEqual([GITIGNORE, ...Object.keys(SEED_FILES)].sort())
    expect(await readFile(join(root, 'CLAUDE.md'), 'utf8')).toBe(SEED_FILES['CLAUDE.md'])
    expect(await readFile(join(root, '.claude/hooks/user-prompt-submit.mjs'), 'utf8')).toBe(
      SEED_FILES['.claude/hooks/user-prompt-submit.mjs'],
    )
  })

  it('never overwrites an existing file, and is idempotent', async () => {
    const root = await tempDir()
    await mkdir(root, { recursive: true })
    await writeFile(join(root, 'AGENTS.md'), '# my rules\n')

    const first = await ensureSeeded(root)
    expect(first).not.toContain('AGENTS.md')
    expect(await readFile(join(root, 'AGENTS.md'), 'utf8')).toBe('# my rules\n')

    const second = await ensureSeeded(root)
    expect(second).toEqual([]) // everything is on disk now
  })

  it('does not seed USER.md — it is machine-local', async () => {
    const root = await tempDir()
    await ensureSeeded(root)
    await expect(readFile(join(root, 'USER.md'), 'utf8')).rejects.toThrow()
  })
})

describe('ensureSeeded — the .gitignore', () => {
  const lines = async (root: string) =>
    (await readFile(join(root, '.gitignore'), 'utf8')).split('\n').filter(Boolean)

  it('creates one carrying every local-only line', async () => {
    const root = await tempDir()
    await ensureSeeded(root)
    for (const line of LOCAL_ONLY_IGNORE_LINES) expect(await lines(root)).toContain(line)
  })

  it('APPENDS to a .gitignore that already exists, keeping what was there', async () => {
    // Decision 10's hole, and the reason .gitignore is not create-if-missing
    // like the rest. An adopted repo usually already has one, so ours would
    // never be written — and `commitAll` runs `git add -A`, which means USER.md
    // reaches the shared history on the very first commit.
    const root = await tempDir()
    await writeFile(join(root, '.gitignore'), 'node_modules\ndist\n')

    const written = await ensureSeeded(root)

    expect(written).toContain('.gitignore')
    expect(await lines(root)).toContain('node_modules')
    expect(await lines(root)).toContain('dist')
    for (const line of LOCAL_ONLY_IGNORE_LINES) expect(await lines(root)).toContain(line)
  })

  it('does not duplicate lines that are already there', async () => {
    const root = await tempDir()
    await ensureSeeded(root)
    await ensureSeeded(root)

    const all = await lines(root)
    for (const line of LOCAL_ONLY_IGNORE_LINES) {
      expect(all.filter((l) => l === line)).toHaveLength(1)
    }
  })

  it('reports nothing to write when the lines are already present', async () => {
    const root = await tempDir()
    await writeFile(join(root, '.gitignore'), `${LOCAL_ONLY_IGNORE_LINES.join('\n')}\n`)
    expect(await ensureSeeded(root)).not.toContain('.gitignore')
  })

  it('does not join onto a file with no trailing newline', async () => {
    // `USER.mdnode_modules` ignores nothing and looks like it ignores something.
    const root = await tempDir()
    await writeFile(join(root, '.gitignore'), 'node_modules')

    await ensureSeeded(root)

    expect(await lines(root)).toContain('node_modules')
    for (const line of LOCAL_ONLY_IGNORE_LINES) expect(await lines(root)).toContain(line)
  })

  it('keeps a machine-local file out of a commit — the leak this exists to stop', async () => {
    // The assertion the whole task is for. Everything else here is mechanism.
    const root = await tempDir()
    await exec('git', ['init', '-b', 'main', root])
    await exec('git', ['-C', root, 'config', 'user.email', 'test@holi.invalid'])
    await exec('git', ['-C', root, 'config', 'user.name', 'Holi Test'])

    await ensureSeeded(root)
    await writeFile(join(root, 'USER.md'), 'private notes about the user\n')
    await mkdir(join(root, '.holi'), { recursive: true })
    await writeFile(join(root, '.holi/settings.local.json'), '{"machine":"local"}\n')
    await writeFile(join(root, 'shared.md'), 'this one should travel\n')

    await exec('git', ['-C', root, 'add', '-A'])
    await exec('git', ['-C', root, 'commit', '-m', 'first'])
    const { stdout } = await exec('git', ['-C', root, 'show', '--name-only', '--format=', 'HEAD'])
    const committed = stdout.split('\n').filter(Boolean)

    expect(committed).toContain('shared.md')
    expect(committed).toContain('AGENTS.md')
    expect(committed).not.toContain('USER.md')
    expect(committed).not.toContain('.holi/settings.local.json')
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
          { path: 'projects/task.draft-proposal.md', title: 'Draft proposal', status: 'todo', due: '2026-07-20' },
          { path: 'task.review.md', title: 'Review', status: 'doing' },
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
    expect(run.stdout).toContain(
      '- [todo] Draft proposal ([[projects/task.draft-proposal.md]], due=2026-07-20)',
    )
    expect(run.stdout).toContain('- [doing] Review ([[task.review.md]])')
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
