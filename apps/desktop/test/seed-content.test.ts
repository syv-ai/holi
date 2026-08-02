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
      '.claude/skills/md-to-pdf/SKILL.md',
      '.claude/skills/theme/SKILL.md',
      '.holi/templates/plain/template.json',
      '.holi/templates/plain/template.typ',
      '.holi/vault.json',
      'AGENTS.md',
      'CLAUDE.md',
      'MEMORY.md',
    ])
  })

  it('seeds the md-to-pdf skill with the Typst render recipe', () => {
    const skill = SEED_FILES['.claude/skills/md-to-pdf/SKILL.md']!
    expect(skill).toContain('name: md-to-pdf')
    expect(skill).toContain('$TYPST_BIN')
    expect(skill).toContain('doc(') // the template contract
    expect(skill).toContain('--root /') // the compile recipe
  })

  it('seeds the theme skill documenting the colour/chrome vocabulary', () => {
    const skill = SEED_FILES['.claude/skills/theme/SKILL.md']!
    expect(skill).toContain('name: theme')
    expect(skill).toContain('.holi/theme.json') // the file it authors
    expect(skill).toContain('primary') // a token from the whitelist
  })

  it('.holi/vault.json is the durable vault marker', () => {
    expect(JSON.parse(SEED_FILES['.holi/vault.json']!)).toEqual({ version: 1 })
  })

  it('CLAUDE.md is exactly the AGENTS.md import shim', () => {
    expect(SEED_FILES['CLAUDE.md']).toBe('<rules>\n@AGENTS.md\n</rules>\n')
  })

  it('AGENTS.md grants the agent git (coexistence), not the old prohibition', () => {
    const agents = SEED_FILES['AGENTS.md']!
    expect(agents).toContain('Git is yours')
    expect(agents).not.toContain('Do not run') // the pre-coexistence prohibition
  })

  it('settings.json wires the focus + turn hooks and gates network egress', () => {
    const settings = JSON.parse(SEED_FILES['.claude/settings.json']!)
    expect(settings.hooks.UserPromptSubmit[0].hooks[0].command).toContain(
      '.claude/hooks/user-prompt-submit.mjs',
    )
    // UserPromptSubmit + Stop bracket a turn for git coexistence (hook-server signal)
    expect(Object.keys(settings.hooks)).toEqual(['UserPromptSubmit', 'Stop'])
    expect(settings.permissions.ask).toEqual(['Bash(curl:*)', 'Bash(wget:*)'])
  })

  it('the turn hooks POST to the local hook server, guarded so they no-op outside Holi', () => {
    const settings = JSON.parse(SEED_FILES['.claude/settings.json']!)
    const startCmd = settings.hooks.UserPromptSubmit[0].hooks[1].command
    const endCmd = settings.hooks.Stop[0].hooks[0].command
    expect(startCmd).toContain('/turn/start')
    expect(endCmd).toContain('/turn/end')
    for (const cmd of [startCmd, endCmd]) {
      expect(cmd).toContain('[ -n "$HOLI_HOOK_PORT" ]') // the no-op-outside-Holi guard
      expect(cmd).toContain('$HOLI_HOOK_TOKEN')
    }
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

  it('user-prompt-submit emits only the focused-note line from context.local.json', async () => {
    const root = await tempDir()
    await mkdir(join(root, '.holi'), { recursive: true })
    await writeFile(
      join(root, '.holi/context.local.json'),
      JSON.stringify({ focusedPath: 'notes/plan.md', openPaths: ['notes/plan.md', 'notes/other.md'] }),
    )

    const run = await runHook('user-prompt-submit', { cwd: root, env: { CLAUDE_PROJECT_DIR: root } })
    expect(run.code).toBe(0)
    // The one piece of state the agent cannot discover itself (prd/agent.md
    // §Per-turn); everything else it finds natively, so nothing else is injected.
    expect(run.stdout).toBe('Focused note: `notes/plan.md` (use `Read` to view its contents)')
    expect(run.stdout).not.toContain('## Memory') // no fill indicators (D60)
    expect(run.stdout).not.toContain('# Related') // no tasks/backrefs (D60)
  })

  it('user-prompt-submit prints nothing when nothing is focused', async () => {
    const root = await tempDir()
    await writeFile(join(root, 'MEMORY.md'), 'Vault uses British English.')
    // no .holi/context.local.json → nothing focused → nothing to inject

    const run = await runHook('user-prompt-submit', { cwd: root, env: { CLAUDE_PROJECT_DIR: root } })
    expect(run.code).toBe(0)
    expect(run.stdout).toBe('')
  })
})
