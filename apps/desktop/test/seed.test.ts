import { parse as parseYaml } from 'yaml'
import { THEME_TOKENS, resolveTheme } from '@holi/shared'
import { execFile, spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { LOCAL_ONLY_IGNORE_LINES, MEMORY_INDEX_EMPTY, VAULT_MARKER_FILE } from '@holi/shared'
import { afterEach, describe, expect, it } from 'vitest'
import type { SettingsFragment } from '../src/main/agent/seed/claude-settings'
import { agentSeed, agentSettings } from '../src/main/agent/seed/seed'
import { googleSeed } from '../src/plugins/google/main/seed'
import { pdfSeed } from '../src/plugins/pdf/main/seed'
import { coreSeed, GITIGNORE } from '../src/main/vault/seed/core'
import { ensureSeeded as ensureSeededWith } from '../src/main/vault/seed/seed'
import { stagedPath, updateShipped as updateWith } from '../src/main/vault/seed/update'
import { readSeedState, recordSeeded, sha256, SEED_STATE_FILE } from '../src/main/vault/seed/state'
import { SEED_CONTRIBUTIONS, seedVault as ensureSeeded } from './helpers/seed'

const exec = promisify(execFile)

// no __dirname under vitest's ESM transform
const HOOKS_DIR = fileURLToPath(
  new URL('../src/main/agent/seed/vault/shipped/.claude/hooks/', import.meta.url),
)

const updateShipped = (root: string) => updateWith(root, SEED_CONTRIBUTIONS)

/** Every contribution's text tables, by vault path. */
const SHIPPED_FILES: Record<string, string> = Object.assign(
  {},
  ...SEED_CONTRIBUTIONS.map((c) => c.shipped),
)
const ONCE_ALL: Record<string, string | Uint8Array> = Object.assign(
  {},
  ...SEED_CONTRIBUTIONS.map((c) => c.once),
)
const isText = (v: string | Uint8Array): v is string => typeof v === 'string'
const ONCE_FILES: Record<string, string> = Object.fromEntries(
  Object.entries(ONCE_ALL).filter((e): e is [string, string] => isText(e[1])),
)
const BINARIES: Record<string, Uint8Array> = Object.fromEntries(
  Object.entries(ONCE_ALL).filter((e): e is [string, Uint8Array] => !isText(e[1])),
)
/** The agent's settings merge over every contribution's fragments, with the
 *  hook scripts the vault has named by script (`turn-signal`). */
const SETTINGS_FRAGMENTS = SEED_CONTRIBUTIONS.flatMap(
  (c) => c.fragments?.['.claude/settings.json'] ?? [],
) as SettingsFragment[]
const mergedSettings = (existing: string | null, hasHook: (name: string) => boolean = () => true) =>
  agentSettings(existing, SETTINGS_FRAGMENTS, (rel) =>
    hasHook(rel.replace(/^\.claude\/hooks\/(.*)\.mjs$/, '$1')),
  )
const hookEntry = (script: string) => ({
  type: 'command',
  command: `node "$CLAUDE_PROJECT_DIR/.claude/hooks/${script}.mjs"`,
})
const gateOf = (pre: { matcher?: string }[]) => pre.find((e) => e.matcher === 'Bash') as any

/** The merged `.claude/settings.json` a vault gets when it has none. */
const SETTINGS_SEED = mergedSettings(null)!
const SEED_FILES: Record<string, string> = {
  ...ONCE_FILES,
  ...SHIPPED_FILES,
  '.claude/settings.json': SETTINGS_SEED,
}

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
function runHook(
  name: string,
  opts: { env?: Record<string, string>; cwd?: string; stdin?: string },
): Promise<HookRun> {
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

describe('the seed tables', () => {
  const keys = (t: Record<string, unknown>) => Object.keys(t).sort()

  it('core seeds the vault marker, AGENTS.md, settings, theme, icons and memory', () => {
    expect(keys(coreSeed([]).once)).toEqual([
      '.holi/settings/app.local.yaml',
      '.holi/settings/app.yaml',
      '.holi/settings/icons.yaml',
      '.holi/settings/theme.css',
      '.holi/settings/theme.local.css',
      '.holi/vault',
      'AGENTS.md',
      'memory/index.md',
    ])
    expect(keys(coreSeed([]).shipped)).toEqual([])
    expect(keys(coreSeed([]).merge!)).toEqual(['.gitignore'])
  })

  it('the agent ships its hooks and skills and merges .claude/settings.json', () => {
    expect(keys(agentSeed.once)).toEqual([])
    expect(keys(agentSeed.shipped)).toEqual([
      '.claude/hooks/memory-index-guard.mjs',
      '.claude/hooks/memory-overview.mjs',
      '.claude/hooks/turn-signal.mjs',
      '.claude/hooks/user-prompt-submit.mjs',
      '.claude/hooks/vault-app-check.mjs',
      '.claude/skills/holi-feedback/SKILL.md',
      '.claude/skills/memory/SKILL.md',
      '.claude/skills/theme/SKILL.md',
      '.claude/skills/using-tasks/SKILL.md',
      '.claude/skills/vault-apps/SKILL.md',
    ])
    expect(keys(agentSeed.merge!)).toEqual(['.claude/settings.json'])
  })

  it('Google ships its send gate and its skill, and nothing once', () => {
    expect(keys(googleSeed.once)).toEqual([])
    expect(keys(googleSeed.shipped)).toEqual([
      '.claude/hooks/google-send-gate.mjs',
      '.claude/skills/gmail-calendar/SKILL.md',
    ])
  })

  it('PDF seeds its templates once, with the brand binaries as bytes, and ships two skills', () => {
    expect(keys(pdfSeed.once)).toEqual([
      '.holi/document-templates/_brand/brand.typ',
      '.holi/document-templates/_brand/figures.typ',
      '.holi/document-templates/_brand/fonts/Raleway-bold.ttf',
      '.holi/document-templates/_brand/fonts/Raleway-boldItalic.ttf',
      '.holi/document-templates/_brand/fonts/Raleway-italic.ttf',
      '.holi/document-templates/_brand/fonts/Raleway-regular.ttf',
      '.holi/document-templates/_brand/logo.png',
      '.holi/document-templates/contract/template.json',
      '.holi/document-templates/contract/template.typ',
      '.holi/document-templates/letter/template.json',
      '.holi/document-templates/letter/template.typ',
      '.holi/document-templates/memo/template.json',
      '.holi/document-templates/memo/template.typ',
      '.holi/document-templates/plain/template.json',
      '.holi/document-templates/plain/template.typ',
      '.holi/document-templates/proposal/template.json',
      '.holi/document-templates/proposal/template.typ',
      '.holi/document-templates/report/template.json',
      '.holi/document-templates/report/template.typ',
    ])
    expect(keys(BINARIES)).toEqual(
      keys(pdfSeed.once).filter((k) => k.endsWith('.ttf') || k.endsWith('.png')),
    )
    expect(keys(pdfSeed.shipped)).toEqual([
      '.claude/skills/md-to-pdf/SKILL.md',
      '.claude/skills/pdf-comments/SKILL.md',
    ])
  })

  it('seeds a theme.css pair that parses, sets nothing, and names every token', () => {
    for (const key of ['.holi/settings/theme.css', '.holi/settings/theme.local.css'] as const) {
      const text = SEED_FILES[key]!
      // Parsed by the reader that reads it for real, not by a second opinion.
      expect(resolveTheme(text, null)).toEqual({ dark: {}, light: {}, warnings: [] })
      expect(text).toContain("[data-theme='dark'] {")
      // The vocabulary is the point of the file: a token Holi knows and this
      // vault has not set is a commented-out declaration, not an absence.
      for (const slug of THEME_TOKENS) {
        expect(text, slug).toContain(`/* --${slug}: ; */`)
      }
    }
  })

  it('seeds the md-to-pdf skill with the Typst render recipe', () => {
    const skill = SEED_FILES['.claude/skills/md-to-pdf/SKILL.md']!
    expect(skill).toContain('name: md-to-pdf')
    expect(skill).toContain('holi pdf typst')
    expect(skill).toContain('doc(') // the template contract
    expect(skill).toContain('--root /') // the compile recipe
  })

  it('seeds the gmail-calendar skill with the command and the linking rule', () => {
    const skill = SEED_FILES['.claude/skills/gmail-calendar/SKILL.md']!
    expect(skill).toContain('name: gmail-calendar')
    expect(skill).toContain('holi google')
    // The two things the agent gets wrong without being told: that a link is a
    // body markdown link (not frontmatter, not a wiki-link), and that a Gmail
    // URL must not be hand-assembled.
    expect(skill).toContain('markdown link')
    expect(skill).toContain('rfc822msgid')
    // The agent's boundary, stated as what is true rather than what used to be.
    // This has now been wrong twice, in opposite directions, which is why it is
    // pinned at all: it asserted 'read-only' until the scope became
    // gmail.modify, and asserted 'no subcommand that writes' until sending added
    // nine of them. A false invariant in a prompt the agent reasons from is
    // worse than none, because it reasons *from* it.
    expect(skill).not.toContain('scopes are read-only')
    expect(skill).not.toContain('no subcommand that writes')
    expect(skill).not.toContain('You have no write commands')

    // What is true now: the line is reversibility, drafting is preferred over
    // sending, and sending prompts the user every time.
    expect(skill).toContain('undo')
    expect(skill).toContain('draft')
    expect(skill).toMatch(/asks? the user every time|every time/)
    // And the structural bound the agent cannot talk its way around.
    expect(skill).toContain('attendees')
  })

  it('seeds the theme skill documenting the colour/chrome vocabulary', () => {
    const skill = SEED_FILES['.claude/skills/theme/SKILL.md']!
    expect(skill).toContain('name: theme')
    expect(skill).toContain('.holi/settings/theme.css') // the file it authors
    expect(skill).toContain('primary') // a token from the whitelist
  })

  it('seeds the using-tasks skill documenting the task file format', () => {
    const skill = SEED_FILES['.claude/skills/using-tasks/SKILL.md']!
    expect(skill).toContain('name: using-tasks')
    // The two facts an agent gets WRONG rather than merely misses: a
    // reminder is a moment, and a value that is not a stamp fires nothing.
    expect(skill).toContain('absolute moment')
    expect(skill).toContain('inert')
    expect(skill).toContain('YYYY-MM-DD'.replace('YYYY-MM-DD', '2026-08-25T18:00'))
  })

  it('seeds a pdf-comments skill naming the command and its flag', () => {
    const skill = SHIPPED_FILES['.claude/skills/pdf-comments/SKILL.md']!
    expect(skill).toMatch(/^---\nname: pdf-comments\n/)
    expect(skill).toContain('holi pdf comments <path> --json')
  })

  it('.holi/vault is the durable vault marker, and not a document', () => {
    // Its EXISTENCE is the signal — `isVaultClone` asks only whether it reads —
    // so the JSON it used to hold was a shape nothing ever parsed. One line, the
    // format version, so a future migration has something to branch on.
    expect(SEED_FILES[VAULT_MARKER_FILE]).toBe('1\n')
    expect(VAULT_MARKER_FILE).toBe('.holi/vault')
    expect(VAULT_MARKER_FILE.includes('.json')).toBe(false)
  })

  it('seeds no CLAUDE.md: Claude Code reads AGENTS.md itself', () => {
    expect(SEED_FILES['CLAUDE.md']).toBeUndefined()
  })

  it('settings.json wires the focus + turn hooks and gates network egress', () => {
    const settings = JSON.parse(SETTINGS_SEED)
    expect(settings.hooks.UserPromptSubmit[0].hooks[0].command).toContain(
      '.claude/hooks/user-prompt-submit.mjs',
      '.claude/hooks/vault-app-check.mjs',
    )
    // UserPromptSubmit + Stop bracket a turn for git coexistence (hook-server
    // signal); PreToolUse is the send gate and is unrelated to the bracket.
    expect(Object.keys(settings.hooks).sort()).toEqual([
      'PostToolUse',
      'PreToolUse',
      'SessionStart',
      'Stop',
      'UserPromptSubmit',
    ])
    expect(settings.permissions.ask).toEqual([
      'Bash(curl:*)',
      'Bash(wget:*)',
      'Bash(holi google archive:*)',
      'Bash(holi google trash:*)',
      'Bash(holi google unschedule:*)',
      'Bash(holi google send:*)',
      'Bash(holi google reply:*)',
    ])
  })

  /**
   * The gate is the only thing between the agent and a sent email, so its
   * wiring is pinned rather than assumed.
   *
   * `matcher: 'Bash'` with **no `if` condition** is deliberate. An `if` keyed on
   * one spelling of the command would miss the other two the agent can produce,
   * and a gate that misses fails OPEN while still reading like protection —
   * which is exactly what the originally planned `Bash(holi google send:*)` rule did.
   */
  it('wires the send gate to every Bash call, deciding in the hook rather than in a matcher', () => {
    const settings = JSON.parse(SETTINGS_SEED)
    const gate = gateOf(settings.hooks.PreToolUse)

    expect(gate.matcher).toBe('Bash')
    expect(gate.hooks[0].command).toContain('.claude/hooks/google-send-gate.mjs')
    expect(gate.hooks[0].if).toBeUndefined()
  })

  it('the send gate returns ask rather than deny, so the user still decides', () => {
    // `deny` would take the choice away; `ask` overrides permissions.allow and
    // a prior "don't ask again", which is the property the wall needs.
    const gate = SEED_FILES['.claude/hooks/google-send-gate.mjs']!

    expect(gate).toContain("'ask'")
    expect(gate).not.toMatch(/permissionDecision:\s*'deny'/)
  })

  it('the turn hooks run the turn-signal script with their edge', () => {
    const settings = JSON.parse(SETTINGS_SEED)
    expect(settings.hooks.UserPromptSubmit[1].hooks[0].command).toBe(
      'node "$CLAUDE_PROJECT_DIR/.claude/hooks/turn-signal.mjs" start',
    )
    expect(settings.hooks.Stop[0].hooks[0].command).toBe(
      'node "$CLAUDE_PROJECT_DIR/.claude/hooks/turn-signal.mjs" end',
    )
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
    const { written } = await ensureSeeded(root)
    // The .gitignore is written too: it is merged line-wise rather than
    // created-if-missing.
    expect(written.sort()).toEqual(
      [GITIGNORE, ...Object.keys(SEED_FILES), ...Object.keys(BINARIES)].sort(),
    )
    expect(await readFile(join(root, 'AGENTS.md'), 'utf8')).toBe(SEED_FILES['AGENTS.md'])
    expect(await readFile(join(root, '.claude/hooks/user-prompt-submit.mjs'), 'utf8')).toBe(
      SEED_FILES['.claude/hooks/user-prompt-submit.mjs'],
    )
  })

  it('seeds the brand foundation: brand.typ text and the Raleway/logo binaries verbatim', async () => {
    const root = await tempDir()
    await ensureSeeded(root)

    // Text: brand.typ + the two branded templates land as their source.
    const brand = await readFile(join(root, '.holi/document-templates/_brand/brand.typ'), 'utf8')
    expect(brand).toContain('with-brand')
    expect(brand).toContain('Raleway')
    expect(
      await readFile(join(root, '.holi/document-templates/proposal/template.typ'), 'utf8'),
    ).toContain('render-body')

    // Binaries: the bytes of the source file, and a font is a real TrueType file.
    const font = await readFile(
      join(root, '.holi/document-templates/_brand/fonts/Raleway-regular.ttf'),
    )
    const source = await readFile(
      fileURLToPath(
        new URL(
          '../src/plugins/pdf/main/vault/once/.holi/document-templates/_brand/fonts/Raleway-regular.ttf',
          import.meta.url,
        ),
      ),
    )
    expect(font.equals(source)).toBe(true)
    expect(font.length).toBeGreaterThan(50_000) // a real font, not a stub
    const logo = await readFile(join(root, '.holi/document-templates/_brand/logo.png'))
    expect(logo.subarray(1, 4).toString('latin1')).toBe('PNG') // PNG magic
  })

  it('never overwrites an existing file, and is idempotent', async () => {
    const root = await tempDir()
    await mkdir(root, { recursive: true })
    await writeFile(join(root, 'AGENTS.md'), '# my rules\n')

    const { written: first } = await ensureSeeded(root)
    expect(first).not.toContain('AGENTS.md')
    expect(await readFile(join(root, 'AGENTS.md'), 'utf8')).toBe('# my rules\n')

    const { written: second } = await ensureSeeded(root)
    expect(second).toEqual([]) // everything is on disk now
  })

  it('does not seed USER.local.md — it is machine-local', async () => {
    const root = await tempDir()
    await ensureSeeded(root)
    await expect(readFile(join(root, 'USER.local.md'), 'utf8')).rejects.toThrow()
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
    // The reason .gitignore is not create-if-missing
    // like the rest. An adopted repo usually already has one, so ours would
    // never be written — and `commitAll` runs `git add -A`, which means a
    // `*.local.*` file reaches the shared history on the very first commit.
    const root = await tempDir()
    await writeFile(join(root, '.gitignore'), 'node_modules\ndist\n')

    const { written } = await ensureSeeded(root)

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
    expect((await ensureSeeded(root)).written).not.toContain('.gitignore')
  })

  it('does not join onto a file with no trailing newline', async () => {
    // `node_modules*.local.*` ignores nothing and looks like it ignores something.
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
    await writeFile(join(root, 'USER.local.md'), 'private notes about the user\n')
    await mkdir(join(root, '.holi/state'), { recursive: true })
    await mkdir(join(root, '.holi/settings'), { recursive: true })
    await writeFile(join(root, '.holi/settings/app.local.yaml'), '{"machine":"local"}\n')
    await writeFile(join(root, 'shared.md'), 'this one should travel\n')
    // A bare USER.md is ordinary content now — the name has no `.local.`, so it
    // is NOT ignored and MUST travel. This is the honesty guarantee: locality is
    // legible from the name, never a special case.
    await writeFile(join(root, 'USER.md'), 'a synced-looking name is synced\n')

    await exec('git', ['-C', root, 'add', '-A'])
    await exec('git', ['-C', root, 'commit', '-m', 'first'])
    const { stdout } = await exec('git', ['-C', root, 'show', '--name-only', '--format=', 'HEAD'])
    const committed = stdout.split('\n').filter(Boolean)

    expect(committed).toContain('shared.md')
    expect(committed).toContain('AGENTS.md')
    expect(committed).toContain('USER.md') // no longer special-cased — it travels
    expect(committed).toContain('.holi/settings/theme.css') // seeded + committed (shared theme)
    expect(committed).not.toContain('USER.local.md')
    expect(committed).not.toContain('.holi/settings/app.local.yaml')
    expect(committed).not.toContain('.holi/settings/theme.local.css') // seeded but gitignored
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
    await mkdir(join(root, '.holi/state'), { recursive: true })
    await writeFile(
      join(root, '.holi/state/context.local.json'),
      JSON.stringify({
        focusedPath: 'notes/plan.md',
        openPaths: ['notes/plan.md', 'notes/other.md'],
      }),
    )

    const run = await runHook('user-prompt-submit', {
      cwd: root,
      env: { CLAUDE_PROJECT_DIR: root },
    })
    expect(run.code).toBe(0)
    // The one piece of state the agent cannot discover itself (features/agent-config.md);
    // everything else it finds natively, so nothing else is injected.
    expect(run.stdout).toBe('Focused note: `notes/plan.md` (use `Read` to view its contents)')
    expect(run.stdout).not.toContain('## Memory') // no fill indicators
    expect(run.stdout).not.toContain('# Related') // no tasks/backrefs
  })

  it('user-prompt-submit prints nothing when nothing is focused', async () => {
    const root = await tempDir()
    await writeFile(join(root, 'MEMORY.md'), 'Vault uses British English.')
    // no .holi/state/context.local.json → nothing focused → nothing to inject

    const run = await runHook('user-prompt-submit', {
      cwd: root,
      env: { CLAUDE_PROJECT_DIR: root },
    })
    expect(run.code).toBe(0)
    expect(run.stdout).toBe('')
  })
})

/**
 * `.claude/settings.json` is **merged, not skipped** — the gate depends on it.
 *
 * The seed loop is write-if-absent, and every established vault already has a
 * `settings.json`. So the send gate's `PreToolUse` hook would have been written as a
 * *file* and never wired: the hook script present, nothing invoking it, and
 * `send` reaching a real mailbox with no confirmation at all. That is the same
 * shape as the stale Gmail grant — a capability widened in code while the stored
 * artifact still reflects the old one.
 *
 * `.gitignore` already had this problem and already solved it line-wise. This is
 * the same contract, key-wise: add what Holi requires, keep everything the user
 * put there, and return `null` when there is nothing to do.
 */
describe('mergedSettings', () => {
  const parse = (s: string | null) => JSON.parse(s!) as Record<string, any>

  it('adds the gate to a settings.json that predates it', () => {
    const before = JSON.stringify({
      hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'x' }] }] },
      permissions: { ask: ['Bash(curl:*)'] },
    })

    const after = parse(mergedSettings(before))

    expect(gateOf(after.hooks.PreToolUse).hooks[0].command).toContain('google-send-gate.mjs')
    expect(after.permissions.ask).toContain('Bash(holi google send:*)')
    expect(after.permissions.deny).toContain('SendFeedback')
    expect(after.skillOverrides['code-review']).toBe('off')
  })

  it('keeps the user’s own hooks and permissions', () => {
    const before = JSON.stringify({
      hooks: {
        UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'mine' }] }],
        PostToolUse: [{ matcher: 'Write', hooks: [{ type: 'command', command: 'format' }] }],
      },
      permissions: { ask: ['Bash(rm:*)'], allow: ['Bash(ls:*)'], deny: ['Bash(sudo:*)'] },
      skillOverrides: { init: 'on' },
      model: 'opus',
    })

    const after = parse(mergedSettings(before))

    // Untouched
    expect(after.hooks.PostToolUse[0].hooks[0].command).toBe('format')
    expect(after.hooks.UserPromptSubmit[0].hooks[0].command).toBe('mine')
    expect(after.permissions.allow).toEqual([
      'Bash(ls:*)',
      'Bash(holi pdf comments:*)',
      'Bash(holi pdf typst:*)',
    ])
    expect(after.permissions.deny[0]).toBe('Bash(sudo:*)')
    expect(after.skillOverrides.init).toBe('on')
    expect(after.model).toBe('opus')
    // Added, not replaced
    expect(after.permissions.ask).toContain('Bash(rm:*)')
    expect(after.permissions.ask).toContain('Bash(holi google send:*)')
  })

  it('allows the read-only holi pdf commands without a prompt, in a vault that predates them', () => {
    const before = JSON.parse(SETTINGS_SEED) as Record<string, any>
    delete before.permissions.allow
    const after = parse(mergedSettings(JSON.stringify(before)))
    expect(after.permissions.allow).toEqual(['Bash(holi pdf comments:*)', 'Bash(holi pdf typst:*)'])
    expect(after.permissions.ask).toEqual(before.permissions.ask)
  })

  it('is null when the gate is already wired — no pointless rewrite', () => {
    expect(mergedSettings(SETTINGS_SEED)).toBeNull()
  })

  it('writes the full seed when there is no settings.json at all', () => {
    expect(mergedSettings(null)).toBe(SETTINGS_SEED)
  })

  it('does not add a second copy of a gate the user already has', () => {
    const once = mergedSettings(JSON.stringify({ hooks: {}, permissions: {} }))
    const twice = mergedSettings(once)

    expect(twice).toBeNull()
    // The memory index guard, then two gate matchers, not two copies: `Bash`
    // for the CLI and `mcp__…Gmail…` for the claude.ai connector, which a Bash
    // matcher cannot see. Seeding again adds none of them.
    expect(parse(once).hooks.PreToolUse.map((e: { matcher: string }) => e.matcher)).toEqual([
      'Write|Edit|MultiEdit',
      'Bash',
      'mcp__.*[Gg]mail.*',
    ])
  })

  it('opts the vault out of claude.ai cloud connectors', () => {
    // The agent reached for a claude.ai Gmail connector in preference to
    // `holi google`, routing around main-as-sole-token-authority, the send gate
    // and the cache. `true` in any scope wins, so this checked-in file settles it.
    const seeded = mergedSettings(JSON.stringify({ hooks: {}, permissions: {} }))

    expect(parse(seeded).disableClaudeAiConnectors).toBe(true)
  })

  // Their file, and unparseable JSON is not something to "fix" by overwriting.
  // The cost is an ungated vault, which the caller reports rather than hides.
  it('leaves a malformed settings.json alone rather than destroying it', () => {
    expect(mergedSettings('{ not json')).toBeNull()
  })
})

describe('ensureSeeded — settings.json', () => {
  it('wires the gate into an existing settings.json on an established vault', async () => {
    const root = await mkdtemp(join(tmpdir(), 'holi-seed-settings-'))
    await mkdir(join(root, '.claude'), { recursive: true })
    // Exactly what a vault seeded before the send gate looks like.
    await writeFile(
      join(root, '.claude/settings.json'),
      JSON.stringify({
        hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'x' }] }] },
        permissions: { ask: ['Bash(curl:*)', 'Bash(wget:*)'] },
      }),
      'utf8',
    )

    const { written } = await ensureSeeded(root)

    const settings = parseYaml(await readFile(join(root, '.claude/settings.json'), 'utf8'))
    expect(gateOf(settings.hooks.PreToolUse).hooks[0].command).toContain('google-send-gate.mjs')
    expect(written).toContain('.claude/settings.json')
    // A fragment from a contribution that does not own the file reaches it.
    expect(settings.permissions.allow).toContain('Bash(holi pdf comments:*)')
    // And the hook it invokes actually landed, or the wiring points at nothing.
    expect(await readFile(join(root, '.claude/hooks/google-send-gate.mjs'), 'utf8')).toBe(
      SEED_FILES['.claude/hooks/google-send-gate.mjs'],
    )
    await rm(root, { recursive: true, force: true })
  })
})

describe('the connector opt-out reaches vaults that already exist', () => {
  // The send gate's own lesson, applied to itself: a seed that only runs at creation is a
  // migration that never happens. Every vault that exists today already has a
  // settings.json, so the creation path reaches none of them.
  it('adds the opt-out to an established vault on the merge path', () => {
    const before = JSON.stringify({
      hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [hookEntry('google-send-gate')] }] },
      permissions: { ask: [] },
    })

    const after = mergedSettings(before)

    expect(JSON.parse(after!).disableClaudeAiConnectors).toBe(true)
  })

  it('does not argue with a user who deliberately set it false', () => {
    // Re-asserting it every vault open would be Holi overruling a stated choice
    // once a session. The vault is theirs.
    const before = JSON.stringify({
      hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [hookEntry('google-send-gate')] }] },
      permissions: {
        ask: [
          'Bash(curl:*)',
          'Bash(wget:*)',
          'Bash(holi google archive:*)',
          'Bash(holi google trash:*)',
          'Bash(holi google unschedule:*)',
          'Bash(holi google send:*)',
          'Bash(holi google reply:*)',
        ],
      },
      disableClaudeAiConnectors: false,
    })

    // It still merges the vault-app validator in, which this fixture predates —
    // so assert the stated choice survives rather than that nothing changed.
    const after = JSON.parse(mergedSettings(before)!)
    expect(after.disableClaudeAiConnectors).toBe(false)
    expect(JSON.stringify(after.hooks.PostToolUse)).toContain('vault-app-check')
  })
})

describe('mergedSettings — the memory index guard', () => {
  it('seeds a PreToolUse guard on memory/index.md for the writing tools', () => {
    const pre = JSON.parse(SETTINGS_SEED).hooks.PreToolUse
    const guard = pre.find((e: { hooks: { command: string }[] }) =>
      e.hooks[0]!.command.includes('memory-index-guard'),
    )
    expect(guard.matcher).toBe('Write|Edit|MultiEdit')
  })

  it('merges it into a vault that already has the send gate', () => {
    const before = JSON.stringify({
      hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [hookEntry('google-send-gate')] }] },
    })
    const pre = JSON.parse(mergedSettings(before)!).hooks.PreToolUse
    const text = JSON.stringify(pre)
    expect(text).toContain('memory-index-guard')
    // The gate is not added twice.
    expect(text.match(/google-send-gate/g)).toHaveLength(pre.length - 1)
  })

  it('leaves settings that already carry it alone', () => {
    const seeded = SETTINGS_SEED
    expect(mergedSettings(seeded)).toBeNull()
  })
})

describe('ensureSeeded — the vault-apps skill', () => {
  it('writes the authoring contract into a vault that never had it', async () => {
    // This is what makes a new skill reach EXISTING vaults with no migration:
    // ensureSeeded runs on vault open, and create-if-missing means a
    // brand-new seed file is the only thing it writes on that pass.
    const root = await tempDir()
    const { written } = await ensureSeeded(root)
    expect(written).toContain('.claude/skills/vault-apps/SKILL.md')
    const skill = await readFile(join(root, '.claude/skills/vault-apps/SKILL.md'), 'utf8')
    // The three facts an app author cannot discover by reading the app's own
    // code: where it goes, what the bridge offers, and that nothing persists.
    expect(skill).toContain('.app/')
    expect(skill).toContain('holi.docs.list()')
    expect(skill).toContain('holi.docs.read(')
    expect(skill).toContain('holi.tasks.list()')
    expect(skill).toContain('holi.open(')
    expect(skill).toMatch(/localStorage/)
    // The facts an agent gets WRONG rather than misses, each learned by
    // reading the skill back as a reader who knows nothing about Holi:
    // the status union (it guesses `done: true`), and that an open tab does not
    // pick up an edit.
    // Matched against whitespace-normalized text: the file is hand-wrapped at
    // 80 columns, so any phrase long enough to be worth asserting is wrapped.
    const prose = skill.replace(/\s+/g, ' ')
    expect(prose).toContain("'todo' | 'doing' | 'done'")
    expect(prose).toMatch(/reload/i)
  })

  it('never rewrites one the user has edited', async () => {
    const root = await tempDir()
    await ensureSeeded(root)
    const rel = '.claude/skills/vault-apps/SKILL.md'
    await writeFile(join(root, rel), '# mine\n', 'utf8')
    expect((await ensureSeeded(root)).written).not.toContain(rel)
    expect(await readFile(join(root, rel), 'utf8')).toBe('# mine\n')
  })
})

describe('the shipped / once split', () => {
  it('refuses two contributions seeding one path', async () => {
    const root = await tempDir()
    const twin = { id: 'twin', once: { 'AGENTS.md': '# twin\n' }, shipped: {} }
    await expect(ensureSeededWith(root, [...SEED_CONTRIBUTIONS, twin])).rejects.toThrow(
      /AGENTS\.md is seeded by both core and twin/,
    )
  })

  it("leaves the files that become the user's in the once class", () => {
    // `memory/index.md` is regenerated by the memory-index transform on every
    // commit that touches a memory, so an update merging a stub into it would
    // fight that transform.
    for (const rel of ['AGENTS.md', 'memory/index.md', '.holi/settings/theme.css']) {
      expect(ONCE_FILES[rel]).toBeDefined()
      expect(SHIPPED_FILES[rel]).toBeUndefined()
    }
  })
})

describe('ensureSeeded: skills and hooks only at creation', () => {
  const SKILL = '.claude/skills/vault-apps/SKILL.md'
  const GATE = '.claude/hooks/google-send-gate.mjs'

  it('records what it seeded, as the base a later update merges against', async () => {
    const root = await tempDir()
    await ensureSeeded(root)
    const state = await readSeedState(root)
    expect(state.files[SKILL]).toEqual({
      sha: sha256(SHIPPED_FILES[SKILL]!),
      text: SHIPPED_FILES[SKILL],
    })
  })

  it('never writes one on a later open: a deleted skill stays deleted', async () => {
    const root = await tempDir()
    await ensureSeeded(root)
    await rm(join(root, SKILL))

    expect((await ensureSeeded(root)).written).toEqual([])
    await expect(readFile(join(root, SKILL), 'utf8')).rejects.toThrow()
  })

  it('leaves a changed one exactly as the vault has it', async () => {
    const root = await tempDir()
    await ensureSeeded(root)
    await writeFile(join(root, SKILL), '# mine\n')

    await ensureSeeded(root)
    expect(await readFile(join(root, SKILL), 'utf8')).toBe('# mine\n')
  })

  it('wires a hook only where its script is', async () => {
    // A hook a later release adds reaches the vault with `holi skills update`,
    // and must not be wired on an open before that: it would fail every prompt.
    const root = await tempDir()
    await ensureSeeded(root)
    await rm(join(root, GATE))
    const settings = JSON.parse(await readFile(join(root, '.claude/settings.json'), 'utf8'))
    settings.hooks.PreToolUse = settings.hooks.PreToolUse.filter(
      (e: unknown) => !JSON.stringify(e).includes('google-send-gate'),
    )
    await writeFile(join(root, '.claude/settings.json'), JSON.stringify(settings))

    await ensureSeeded(root)
    const after = await readFile(join(root, '.claude/settings.json'), 'utf8')
    expect(after).not.toContain('google-send-gate')
  })

  it('is idempotent: a settled vault reports no work at all', async () => {
    const root = await tempDir()
    await ensureSeeded(root)
    expect((await ensureSeeded(root)).written).toEqual([])
  })
})

describe('updateShipped: what `holi skills update` does', () => {
  const SKILL = '.claude/skills/vault-apps/SKILL.md'
  const shipped = () => SHIPPED_FILES[SKILL]!

  /** A vault seeded with an older version of SKILL: `old` on disk and recorded. */
  async function seededWith(old: string): Promise<string> {
    const root = await tempDir()
    await ensureSeeded(root)
    await writeFile(join(root, SKILL), old)
    await recordSeeded(root, SKILL, old)
    return root
  }

  /** The shipped skill with its first line swapped, and that first line. */
  const olderHead = () => {
    const [, ...rest] = shipped().split('\n')
    return ['# an older first line', ...rest].join('\n')
  }

  it('replaces a file the vault never touched', async () => {
    const root = await seededWith('# an older version\n')
    const report = await updateShipped(root)
    expect(report.updated).toEqual([SKILL])
    expect(await readFile(join(root, SKILL), 'utf8')).toBe(shipped())
  })

  it("merges when both changed it in different places, keeping the vault's", async () => {
    const root = await seededWith(olderHead())
    // The vault's own section, at the other end of the file from Holi's change.
    await writeFile(join(root, SKILL), `${olderHead()}\n## Ours\n`)

    const report = await updateShipped(root)
    expect(report.merged).toEqual([SKILL])
    expect(await readFile(join(root, SKILL), 'utf8')).toBe(`${shipped()}\n## Ours\n`)
  })

  it('hands a same-line conflict to an agent, touching nothing', async () => {
    const root = await seededWith(olderHead())
    const [, ...rest] = shipped().split('\n')
    const mine = ['# our first line', ...rest].join('\n')
    await writeFile(join(root, SKILL), mine)

    const report = await updateShipped(root)
    expect(report.conflicts).toEqual([SKILL])
    expect(await readFile(join(root, SKILL), 'utf8')).toBe(mine)
    expect(await readFile(join(root, stagedPath(SKILL, 'shipped')), 'utf8')).toBe(shipped())
    expect(await readFile(join(root, stagedPath(SKILL, 'base')), 'utf8')).toBe(olderHead())
  })

  it('keeps a handed-off file a conflict until the agent clears what it staged', async () => {
    const root = await seededWith(olderHead())
    const [, ...rest] = shipped().split('\n')
    await writeFile(join(root, SKILL), ['# our first line', ...rest].join('\n'))
    await updateShipped(root)

    // Run again with nothing resolved: still the agent's, never merged away.
    expect((await updateShipped(root)).conflicts).toEqual([SKILL])
  })

  it("takes the agent's resolution as the vault's own once it clears what it staged", async () => {
    const root = await seededWith(olderHead())
    const [, ...rest] = shipped().split('\n')
    await writeFile(join(root, SKILL), ['# our first line', ...rest].join('\n'))
    await updateShipped(root)

    // The agent keeps the vault's line, then deletes the staged files.
    const resolved = ['# our first line', ...rest].join('\n')
    await writeFile(join(root, SKILL), resolved)
    await rm(join(root, stagedPath(SKILL, 'shipped')))
    await rm(join(root, stagedPath(SKILL, 'base')))

    const report = await updateShipped(root)
    expect(report.conflicts).toEqual([])
    expect(report.current).toContain(SKILL)
    expect(await readFile(join(root, SKILL), 'utf8')).toBe(resolved)
  })

  it('hands a changed file with no base to an agent: a machine that never seeded it', async () => {
    const root = await tempDir()
    await ensureSeeded(root)
    await writeFile(join(root, SKILL), '# changed\n')
    await rm(join(root, SEED_STATE_FILE))

    const report = await updateShipped(root)
    expect(report.conflicts).toEqual([SKILL])
    await expect(readFile(join(root, stagedPath(SKILL, 'base')), 'utf8')).rejects.toThrow()
  })

  it('leaves a skill the vault deleted deleted, and adds one it never had', async () => {
    const root = await tempDir()
    await ensureSeeded(root)
    await rm(join(root, SKILL))
    const THEME = '.claude/skills/theme/SKILL.md'
    await rm(join(root, THEME))
    const state = JSON.parse(await readFile(join(root, SEED_STATE_FILE), 'utf8'))
    delete state.files[THEME] // never seeded here: new in this release
    await writeFile(join(root, SEED_STATE_FILE), JSON.stringify(state))

    const report = await updateShipped(root)
    expect(report.deleted).toEqual([SKILL])
    expect(report.added).toEqual([THEME])
    await expect(readFile(join(root, SKILL), 'utf8')).rejects.toThrow()
  })

  it('reports a settled vault as current', async () => {
    const root = await tempDir()
    await ensureSeeded(root)
    const report = await updateShipped(root)
    expect(report.current.sort()).toEqual(Object.keys(SHIPPED_FILES).sort())
  })
})

describe('the vault-apps skill teaches the loop that now exists', () => {
  const SKILL = SEED_FILES['.claude/skills/vault-apps/SKILL.md']!
  /** The file is hand-wrapped at 80 columns, so every assertion about a
   *  sentence has to ignore where the wrap happens to fall. */
  const flat = SKILL.replace(/\s+/g, ' ')

  it('names the manifest as required, and as the last file to write', () => {
    expect(flat).toContain('app.yaml')
    expect(flat).toMatch(/app\.yaml[\s\S]{0,400}?\bLAST\b/i)
  })

  it('tells the agent it can open the app itself', () => {
    expect(flat).toContain('holi apps open <path>')
  })

  it('says a check is reported back on write', () => {
    expect(flat).toMatch(/vault-app check/i)
  })

  it('no longer claims the agent cannot open the app', () => {
    // False as of the holi CLI, and a skill that is wrong in the direction of
    // learned helplessness is worse than one that is merely incomplete.
    expect(flat).not.toMatch(/no way for you to open the app yourself/i)
    expect(flat).not.toMatch(/You cannot open it yourself/i)
    expect(flat).not.toMatch(/Ask the user to open it/i)
  })

  it('still teaches the boundaries the validator enforces', () => {
    // The hook reports these; the skill is where the reason lives. If one drifts
    // the agent gets a rule with no argument behind it.
    for (const rule of ['localStorage', 'holi.store', 'opaque origin']) {
      expect(flat).toContain(rule)
    }
  })
})

/**
 * Vault memory — one memory surface, seeded and migrated.
 *
 * The two settings keys are the whole of what item 13 was reaching for, in place
 * of surfacing Claude Code's own memory directory (which lives outside the
 * vault, needs a second tree source and a read/write path outside path-safety
 * containment, and would have left the vault with TWO memory surfaces — the
 * problem item 13 names).
 */
describe('vault memory', () => {
  const settings = () => JSON.parse(SETTINGS_SEED)
  const parse = (s: string | null) => JSON.parse(s!) as Record<string, any>

  it('switches Claude Code’s own auto-memory off, so there is one surface', () => {
    // Verified live against 2.1.267, not read out of the binary: with this key
    // in a project .claude/settings.json a session reports no memory directory;
    // with `{}` it reports `~/.claude/projects/<sanitized-cwd>/memory/`.
    expect(settings().autoMemoryEnabled).toBe(false)
  })

  it('wires the session overview to SessionStart', () => {
    // Not UserPromptSubmit: memory is session state, and 3k characters injected
    // into every turn is a cost paid over and over.
    expect(settings().hooks.SessionStart[0].hooks[0].command).toContain(
      '.claude/hooks/memory-overview.mjs',
    )
  })

  it('seeds the memory directory in its empty-state form', () => {
    const index = SEED_FILES['memory/index.md']!
    expect(index).toBe(MEMORY_INDEX_EMPTY)
    // The header is what stops someone hand-editing a file the next commit will
    // silently discard their edit from.
    expect(index).toContain('Generated by Holi')
  })

  it('no longer seeds MEMORY.md, and does not move one that exists', () => {
    // Content the user wrote. Relocating it automatically is exactly the
    // unattended shared-layer edit `not-built.md` rules against.
    expect(SEED_FILES['MEMORY.md']).toBeUndefined()
  })

  it('ships a memory skill, because AGENTS.md cannot be corrected', () => {
    // The reason this is a skill and not more `AGENTS.md` prose: `AGENTS.md` is
    // a ONCE_FILE, so a vault seeded before the `.local.` convention still tells the agent that
    // `USER.md` is machine-local — a claim Holi made and then invalidated — and
    // nothing has ever been able to reach it. A skill can be updated.
    const skill = SEED_FILES['.claude/skills/memory/SKILL.md']!
    expect(SHIPPED_FILES['.claude/skills/memory/SKILL.md']).toBeDefined()

    const prose = skill.replace(/\s+/g, ' ')
    expect(prose).toContain('one fact in one file')
    // The filename is the only thing that decides privacy.
    expect(prose).toMatch(/\.local\.md.*gitignored|gitignored.*\.local\.md/)
    // The index is generated; an edit to it is discarded silently.
    expect(prose).toMatch(/Do not edit .memory\/index\.md./)
    // Never migrate someone's MEMORY.md unprompted — that is a shared-layer
    // auto-edit, which `not-built.md` rules against.
    expect(prose).toMatch(/only when the user asks/)
  })

  it('reaches a vault that already exists, both keys and the hook', () => {
    // The same lesson restated: a seed that only runs at creation is a migration
    // that never happens, and every vault that exists today has a settings.json.
    const before = JSON.stringify({ hooks: {}, permissions: { ask: [] } })
    const after = parse(mergedSettings(before))

    expect(after.autoMemoryEnabled).toBe(false)
    expect(JSON.stringify(after.hooks.SessionStart)).toContain('memory-overview')
  })

  it('does not argue with a user who turned auto-memory back on', () => {
    // Only ever set when absent. `true` here is somebody saying something.
    const before = JSON.stringify({
      hooks: { SessionStart: [{ hooks: [hookEntry('memory-overview')] }] },
      permissions: { ask: [] },
      autoMemoryEnabled: true,
    })
    const after = mergedSettings(before)

    // Something else may still be merged in, so assert the key rather than null.
    expect(parse(after ?? before).autoMemoryEnabled).toBe(true)
  })

  it('turns recaps and prompt suggestions off, unless the vault turned them on', () => {
    const merged = parse(mergedSettings(JSON.stringify({ hooks: {} })))
    expect(merged.awaySummaryEnabled).toBe(false)
    expect(merged.promptSuggestionEnabled).toBe(false)

    const chosen = JSON.stringify({ ...merged, awaySummaryEnabled: true })
    expect(parse(mergedSettings(chosen) ?? chosen).awaySummaryEnabled).toBe(true)
  })

  it('does not add a second overview hook for a user who reordered the block', () => {
    const once = mergedSettings(JSON.stringify({ hooks: {}, permissions: {} }))
    const twice = mergedSettings(once)

    expect(twice).toBeNull()
    expect(parse(once).hooks.SessionStart).toHaveLength(1)
  })
})

describe('mergedSettings — background sessions', () => {
  const commands = (entries: Array<{ hooks: Array<{ command: string }> }>) =>
    entries.flatMap((e) => e.hooks.map((h) => h.command))

  it('reaches a vault that never had the turn bracket', () => {
    const merged = JSON.parse(mergedSettings('{"hooks":{}}')!)
    expect(commands(merged.hooks.UserPromptSubmit)).toEqual([
      'node "$CLAUDE_PROJECT_DIR/.claude/hooks/user-prompt-submit.mjs"',
      'node "$CLAUDE_PROJECT_DIR/.claude/hooks/turn-signal.mjs" start',
    ])
    expect(commands(merged.hooks.Stop)).toEqual([
      'node "$CLAUDE_PROJECT_DIR/.claude/hooks/turn-signal.mjs" end',
    ])
  })

  it("reaches every vault at once, and keeps a vault's own", () => {
    const holis = JSON.parse(SETTINGS_SEED).statusLine
    expect(holis.type).toBe('command')
    // No script to wait for: an existing vault gets it on its next open.
    expect(JSON.parse(mergedSettings('{}', () => false)!).statusLine).toEqual(holis)
    const mine = { type: 'command', command: 'mine.sh' }
    const kept = mergedSettings(JSON.stringify({ statusLine: mine }))
    expect(kept === null ? mine : JSON.parse(kept).statusLine).toEqual(mine)
  })

  it('keeps background sessions in the vault itself, unless the user chose otherwise', () => {
    expect(JSON.parse(mergedSettings('{}')!).worktree).toEqual({ bgIsolation: 'none' })
    const chosen = JSON.parse(mergedSettings('{"worktree":{"bgIsolation":"worktree"}}')!)
    expect(chosen.worktree).toEqual({ bgIsolation: 'worktree' })
  })

  it('is a fixed point: a second merge changes nothing', () => {
    const once = mergedSettings(
      '{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"x"}]}]}}',
    )!
    expect(mergedSettings(once)).toBeNull()
    expect(mergedSettings(SETTINGS_SEED)).toBeNull()
  })
})
