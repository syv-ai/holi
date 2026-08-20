import { execFile, spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { LOCAL_ONLY_IGNORE_LINES } from '@holi/shared'
import { afterEach, describe, expect, it } from 'vitest'
import { BRAND_BINARIES } from '../src/main/agent/templates/_brand/binary-assets.generated'
import {
  GITIGNORE,
  MANAGED_FILES,
  ONCE_FILES,
  SEED_FILES,
  ensureSeeded,
  refreshManaged,
  settingsWithRequired,
} from '../src/main/agent/seed-content'
import { mayRefresh, recordSeeded } from '../src/main/agent/seed-state'

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
  it('covers exactly the spec\'s managed set (USER.local.md is machine-local, never seeded)', () => {
    expect(Object.keys(SEED_FILES).sort()).toEqual([
      '.claude/hooks/google-send-gate.mjs',
      '.claude/hooks/user-prompt-submit.mjs',
      '.claude/hooks/vault-app-check.mjs',
      '.claude/settings.json',
      '.claude/skills/gmail-calendar/SKILL.md',
      '.claude/skills/md-to-pdf/SKILL.md',
      '.claude/skills/theme/SKILL.md',
      '.claude/skills/vault-apps/SKILL.md',
      '.holi/document-templates/_brand/brand.typ',
      '.holi/document-templates/_brand/figures.typ',
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
      '.holi/settings.json',
      '.holi/theme.json',
      '.holi/theme.local.json',
      '.holi/vault.json',
      'AGENTS.md',
      'CLAUDE.md',
      'MEMORY.md',
    ])
  })

  it('carries only the brand text; the brand binaries seed from BRAND_BINARIES', () => {
    // The 4 Raleway TTFs + logo are binary, base64 in the generated module, not
    // strings in SEED_FILES. brand.typ imports Raleway by family name only.
    expect(Object.keys(SEED_FILES).filter((k) => k.endsWith('.ttf') || k.endsWith('.png'))).toEqual([])
    expect(Object.keys(BRAND_BINARIES).sort()).toEqual([
      '.holi/document-templates/_brand/fonts/Raleway-bold.ttf',
      '.holi/document-templates/_brand/fonts/Raleway-boldItalic.ttf',
      '.holi/document-templates/_brand/fonts/Raleway-italic.ttf',
      '.holi/document-templates/_brand/fonts/Raleway-regular.ttf',
      '.holi/document-templates/_brand/logo.png',
    ])
  })

  it('seeds an empty, valid theme.json and a blank theme.local.json', () => {
    for (const key of ['.holi/theme.json', '.holi/theme.local.json'] as const) {
      expect(JSON.parse(SEED_FILES[key]!)).toMatchObject({ dark: {}, light: {} })
    }
  })

  it('seeds the md-to-pdf skill with the Typst render recipe', () => {
    const skill = SEED_FILES['.claude/skills/md-to-pdf/SKILL.md']!
    expect(skill).toContain('name: md-to-pdf')
    expect(skill).toContain('$TYPST_BIN')
    expect(skill).toContain('doc(') // the template contract
    expect(skill).toContain('--root /') // the compile recipe
  })

  it('seeds the gmail-calendar skill with the command and the linking rule (D67)', () => {
    const skill = SEED_FILES['.claude/skills/gmail-calendar/SKILL.md']!
    expect(skill).toContain('name: gmail-calendar')
    expect(skill).toContain('$HOLI_GOOGLE_BIN')
    // The two things the agent gets wrong without being told: that a link is a
    // body markdown link (not frontmatter, not a wiki-link), and that a Gmail
    // URL must not be hand-assembled.
    expect(skill).toContain('markdown link')
    expect(skill).toContain('rfc822msgid')
    // The agent's boundary, stated as what is true rather than what used to be.
    // This has now been wrong twice, in opposite directions, which is why it is
    // pinned at all: it asserted 'read-only' until D68 made the scope
    // gmail.modify, and asserted 'no subcommand that writes' until D70 added
    // nine of them. A false invariant in a prompt the agent reasons from is
    // worse than none, because it reasons *from* it.
    expect(skill).not.toContain('scopes are read-only')
    expect(skill).not.toContain('no subcommand that writes')
    expect(skill).not.toContain('You have no write commands')

    // What is true now: the line is reversibility, drafting is preferred over
    // sending, and sending prompts the user every time (D70).
    expect(skill).toContain('undo')
    expect(skill).toContain('draft')
    expect(skill).toMatch(/asks? the user every time|every time/)
    // And the structural bound the agent cannot talk its way around.
    expect(skill).toContain('attendees')
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
    expect(agents).toContain('Run git freely')
    expect(agents).toContain('pauses its own commit/pull loop')
    expect(agents).not.toContain('Do not run') // the pre-coexistence prohibition
  })

  it('AGENTS.md names the machine-local user file by its real name', () => {
    // A plain `USER.md` is NOT gitignored — the ignore glob is `*.local.*`
    // (D65) — so telling the agent to keep personal detail there would publish
    // it to every collaborator on the next auto-commit. It is also absent from
    // AGENT_SURFACE_FILES under that name, so a vault app could read it.
    const agents = SEED_FILES['AGENTS.md']!
    expect(agents).toContain('USER.local.md')
    expect(agents).not.toMatch(/\`USER\.md\`/)
  })

  it('settings.json wires the focus + turn hooks and gates network egress', () => {
    const settings = JSON.parse(SEED_FILES['.claude/settings.json']!)
    expect(settings.hooks.UserPromptSubmit[0].hooks[0].command).toContain(
      '.claude/hooks/user-prompt-submit.mjs',
      '.claude/hooks/vault-app-check.mjs',
    )
    // UserPromptSubmit + Stop bracket a turn for git coexistence (hook-server
    // signal); PreToolUse is the send gate (D70) and is unrelated to the bracket.
    expect(Object.keys(settings.hooks)).toEqual([
      'UserPromptSubmit',
      'Stop',
      'PostToolUse',
      'PreToolUse',
    ])
    expect(settings.permissions.ask).toEqual([
      'Bash(curl:*)',
      'Bash(wget:*)',
      'Bash(holi-google archive:*)',
      'Bash(holi-google trash:*)',
      'Bash(holi-google unschedule:*)',
      'Bash(holi-google send:*)',
      'Bash(holi-google reply:*)',
    ])
  })

  /**
   * The gate is the only thing between the agent and a sent email, so its
   * wiring is pinned rather than assumed.
   *
   * `matcher: 'Bash'` with **no `if` condition** is deliberate. An `if` keyed on
   * one spelling of the command would miss the other two the agent can produce,
   * and a gate that misses fails OPEN while still reading like protection —
   * which is exactly what D67 §5's `Bash(holi-google send:*)` rule did.
   */
  it('wires the send gate to every Bash call, deciding in the hook rather than in a matcher', () => {
    const settings = JSON.parse(SEED_FILES['.claude/settings.json']!)
    const gate = settings.hooks.PreToolUse[0]

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
    const { written } = await ensureSeeded(root)
    // The .gitignore is written too, but it is not in SEED_FILES: it is the one
    // managed file that is merged line-wise rather than created-if-missing. The
    // brand binaries seed alongside the text files, from BRAND_BINARIES.
    expect(written.sort()).toEqual(
      [GITIGNORE, ...Object.keys(SEED_FILES), ...Object.keys(BRAND_BINARIES)].sort(),
    )
    expect(await readFile(join(root, 'CLAUDE.md'), 'utf8')).toBe(SEED_FILES['CLAUDE.md'])
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
    expect(await readFile(join(root, '.holi/document-templates/proposal/template.typ'), 'utf8')).toContain(
      'render-body',
    )

    // Binaries: bytes match the decoded base64, and a font is a real TrueType file.
    const font = await readFile(join(root, '.holi/document-templates/_brand/fonts/Raleway-regular.ttf'))
    const expected = Buffer.from(
      BRAND_BINARIES['.holi/document-templates/_brand/fonts/Raleway-regular.ttf']!,
      'base64',
    )
    expect(font.equals(expected)).toBe(true)
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
    // Decision 10's hole, and the reason .gitignore is not create-if-missing
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
    await mkdir(join(root, '.holi'), { recursive: true })
    await writeFile(join(root, '.holi/settings.local.json'), '{"machine":"local"}\n')
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
    expect(committed).toContain('.holi/theme.json') // seeded + committed (shared theme)
    expect(committed).not.toContain('USER.local.md')
    expect(committed).not.toContain('.holi/settings.local.json')
    expect(committed).not.toContain('.holi/theme.local.json') // seeded but gitignored
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

/**
 * `.claude/settings.json` is **merged, not skipped** — the gate depends on it.
 *
 * The seed loop is write-if-absent, and every established vault already has a
 * `settings.json`. So the D70 `PreToolUse` gate would have been written as a
 * *file* and never wired: the hook script present, nothing invoking it, and
 * `send` reaching a real mailbox with no confirmation at all. That is the same
 * shape as D68's stale grant — a capability widened in code while the stored
 * artifact still reflects the old one.
 *
 * `.gitignore` already had this problem and already solved it line-wise. This is
 * the same contract, key-wise: add what Holi requires, keep everything the user
 * put there, and return `null` when there is nothing to do.
 */
describe('settingsWithRequired', () => {
  const parse = (s: string | null) => JSON.parse(s!) as Record<string, any>

  it('adds the gate to a settings.json that predates it', () => {
    const before = JSON.stringify({
      hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'x' }] }] },
      permissions: { ask: ['Bash(curl:*)'] },
    })

    const after = parse(settingsWithRequired(before))

    expect(after.hooks.PreToolUse[0].hooks[0].command).toContain('google-send-gate.mjs')
    expect(after.permissions.ask).toContain('Bash(holi-google send:*)')
  })

  it('keeps the user’s own hooks and permissions', () => {
    const before = JSON.stringify({
      hooks: {
        UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'mine' }] }],
        PostToolUse: [{ matcher: 'Write', hooks: [{ type: 'command', command: 'format' }] }],
      },
      permissions: { ask: ['Bash(rm:*)'], allow: ['Bash(ls:*)'], deny: ['Bash(sudo:*)'] },
      model: 'opus',
    })

    const after = parse(settingsWithRequired(before))

    // Untouched
    expect(after.hooks.PostToolUse[0].hooks[0].command).toBe('format')
    expect(after.hooks.UserPromptSubmit[0].hooks[0].command).toBe('mine')
    expect(after.permissions.allow).toEqual(['Bash(ls:*)'])
    expect(after.permissions.deny).toEqual(['Bash(sudo:*)'])
    expect(after.model).toBe('opus')
    // Added, not replaced
    expect(after.permissions.ask).toContain('Bash(rm:*)')
    expect(after.permissions.ask).toContain('Bash(holi-google send:*)')
  })

  it('is null when the gate is already wired — no pointless rewrite', () => {
    expect(settingsWithRequired(SEED_FILES['.claude/settings.json']!)).toBeNull()
  })

  it('writes the full seed when there is no settings.json at all', () => {
    expect(settingsWithRequired(null)).toBe(SEED_FILES['.claude/settings.json'])
  })

  it('does not add a second copy of a gate the user already has', () => {
    const once = settingsWithRequired(JSON.stringify({ hooks: {}, permissions: {} }))
    const twice = settingsWithRequired(once)

    expect(twice).toBeNull()
    // Two matchers, not two copies: `Bash` for the CLI and `mcp__…Gmail…` for
    // the claude.ai connector, which a Bash matcher cannot see. Seeding again
    // adds neither.
    expect(parse(once).hooks.PreToolUse).toHaveLength(2)
    expect(parse(once).hooks.PreToolUse.map((e: { matcher: string }) => e.matcher)).toEqual([
      'Bash',
      'mcp__.*[Gg]mail.*',
    ])
  })

  it('opts the vault out of claude.ai cloud connectors', () => {
    // The agent reached for a claude.ai Gmail connector in preference to
    // `holi-google`, routing around main-as-sole-token-authority, the send gate
    // and the cache. `true` in any scope wins, so this checked-in file settles it.
    const seeded = settingsWithRequired(JSON.stringify({ hooks: {}, permissions: {} }))

    expect(parse(seeded).disableClaudeAiConnectors).toBe(true)
  })

  // Their file, and unparseable JSON is not something to "fix" by overwriting.
  // The cost is an ungated vault, which the caller reports rather than hides.
  it('leaves a malformed settings.json alone rather than destroying it', () => {
    expect(settingsWithRequired('{ not json')).toBeNull()
  })
})

describe('ensureSeeded — settings.json', () => {
  it('wires the gate into an existing settings.json on an established vault', async () => {
    const root = await mkdtemp(join(tmpdir(), 'holi-seed-settings-'))
    await mkdir(join(root, '.claude'), { recursive: true })
    // Exactly what a vault seeded before D70 looks like.
    await writeFile(
      join(root, '.claude/settings.json'),
      JSON.stringify({
        hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'x' }] }] },
        permissions: { ask: ['Bash(curl:*)', 'Bash(wget:*)'] },
      }),
      'utf8',
    )

    const { written } = await ensureSeeded(root)

    const settings = JSON.parse(await readFile(join(root, '.claude/settings.json'), 'utf8'))
    expect(settings.hooks.PreToolUse[0].hooks[0].command).toContain('google-send-gate.mjs')
    expect(written).toContain('.claude/settings.json')
    // And the hook it invokes actually landed, or the wiring points at nothing.
    expect(await readFile(join(root, '.claude/hooks/google-send-gate.mjs'), 'utf8')).toBe(
      SEED_FILES['.claude/hooks/google-send-gate.mjs'],
    )
    await rm(root, { recursive: true, force: true })
  })
})

describe('the connector opt-out reaches vaults that already exist', () => {
  // D70's own lesson, applied to itself: a seed that only runs at creation is a
  // migration that never happens. Every vault that exists today already has a
  // settings.json, so the creation path reaches none of them.
  it('adds the opt-out to an established vault on the merge path', () => {
    const before = JSON.stringify({
      hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ command: 'google-send-gate' }] }] },
      permissions: { ask: [] },
    })

    const after = settingsWithRequired(before)

    expect(JSON.parse(after!).disableClaudeAiConnectors).toBe(true)
  })

  it('does not argue with a user who deliberately set it false', () => {
    // Re-asserting it every vault open would be Holi overruling a stated choice
    // once a session. The vault is theirs.
    const before = JSON.stringify({
      hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ command: 'google-send-gate' }] }] },
      permissions: {
        ask: [
          'Bash(curl:*)',
          'Bash(wget:*)',
          'Bash(holi-google archive:*)',
          'Bash(holi-google trash:*)',
          'Bash(holi-google unschedule:*)',
          'Bash(holi-google send:*)',
          'Bash(holi-google reply:*)',
        ],
      },
      disableClaudeAiConnectors: false,
    })

    // It still merges the vault-app validator in, which this fixture predates —
    // so assert the stated choice survives rather than that nothing changed.
    const after = JSON.parse(settingsWithRequired(before)!)
    expect(after.disableClaudeAiConnectors).toBe(false)
    expect(JSON.stringify(after.hooks.PostToolUse)).toContain('vault-app-check')
  })
})

describe('ensureSeeded — the vault-apps skill', () => {
  it('writes the authoring contract into a vault that never had it', async () => {
    // This is what makes a new skill reach EXISTING vaults with no migration:
    // ensureSeeded runs on vault open (D70), and create-if-missing means a
    // brand-new seed file is the only thing it writes on that pass.
    const root = await tempDir()
    const { written } = await ensureSeeded(root)
    expect(written).toContain('.claude/skills/vault-apps/SKILL.md')
    const skill = await readFile(join(root, '.claude/skills/vault-apps/SKILL.md'), 'utf8')
    // The three facts an app author cannot discover by reading the app's own
    // code: where it goes, what the bridge offers, and that nothing persists.
    expect(skill).toContain('.holi/apps/')
    expect(skill).toContain('holi.docs.list()')
    expect(skill).toContain('holi.docs.read(')
    expect(skill).toContain('holi.tasks.list()')
    expect(skill).toContain('holi.open(')
    expect(skill).toMatch(/localStorage/)
    // The three facts an agent gets WRONG rather than misses, each learned by
    // reading the skill back as a reader who knows nothing about Holi:
    // the status union (it guesses `done: true`), that an open tab does not
    // pick up an edit, and that opening the app is not the same as seeing it.
    // Matched against whitespace-normalized text: the file is hand-wrapped at
    // 80 columns, so any phrase long enough to be worth asserting is wrapped.
    const prose = skill.replace(/\s+/g, ' ')
    expect(prose).toContain("'todo' | 'doing' | 'done'")
    expect(prose).toMatch(/reload/i)
    expect(prose).toMatch(/no console, no screenshot/i)
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

describe('the managed / once split (D75)', () => {
  it('classifies every seed file exactly once', () => {
    const managed = Object.keys(MANAGED_FILES).sort()
    const once = Object.keys(ONCE_FILES).sort()
    // Disjoint, and together exactly SEED_FILES: a new seed file has to be
    // classified deliberately rather than defaulting into a class.
    expect(managed.filter((k) => once.includes(k))).toEqual([])
    expect([...managed, ...once].sort()).toEqual(Object.keys(SEED_FILES).sort())
  })

  it('manages exactly the code and documentation Holi ships', () => {
    expect(Object.keys(MANAGED_FILES).sort()).toEqual([
      '.claude/hooks/google-send-gate.mjs',
      '.claude/hooks/user-prompt-submit.mjs',
      '.claude/hooks/vault-app-check.mjs',
      '.claude/skills/gmail-calendar/SKILL.md',
      '.claude/skills/md-to-pdf/SKILL.md',
      '.claude/skills/theme/SKILL.md',
      '.claude/skills/vault-apps/SKILL.md',
    ])
  })

  it('leaves the files that become the user\'s in the once class', () => {
    for (const rel of ['AGENTS.md', 'CLAUDE.md', 'MEMORY.md', '.holi/theme.json']) {
      expect(ONCE_FILES[rel]).toBeDefined()
      expect(MANAGED_FILES[rel]).toBeUndefined()
    }
  })
})

describe('ensureSeeded — refreshing a managed file', () => {
  const SKILL = '.claude/skills/vault-apps/SKILL.md'

  it('rewrites a managed file Holi wrote and nobody edited', async () => {
    const root = await tempDir()
    await ensureSeeded(root)

    // Stand in for "the shipped content changed": put something else on disk
    // and record it as ours, so the file is untouched from Holi's point of view.
    const stale = '# an older version of this skill\n'
    await writeFile(join(root, SKILL), stale)
    await recordSeeded(root, SKILL, stale)

    const result = await ensureSeeded(root)
    expect(result.refreshed).toContain(SKILL)
    expect(await readFile(join(root, SKILL), 'utf8')).toBe(SEED_FILES[SKILL])
    // And the new content is now the recorded one, so the next version refreshes too.
    expect(await mayRefresh(root, SKILL, SEED_FILES[SKILL]!)).toBe(true)
  })

  it('leaves an edited managed file alone and names it as skipped', async () => {
    const root = await tempDir()
    await ensureSeeded(root)

    const mine = `${SEED_FILES[SKILL]}\n## my own section\n`
    await writeFile(join(root, SKILL), mine)

    const result = await ensureSeeded(root)
    expect(await readFile(join(root, SKILL), 'utf8')).toBe(mine)
    expect(result.refreshed).not.toContain(SKILL)
    expect(result.skipped.map((s) => s.path)).toContain(SKILL)
  })

  it('leaves a managed file alone in a vault that predates the hashes', async () => {
    // The state every existing vault is in: the file is there, edited, and Holi
    // has no record of writing it. This is the case that must not regress.
    const root = await tempDir()
    await mkdir(join(root, '.claude/skills/vault-apps'), { recursive: true })
    const mine = '# my own skill, written before Holi tracked hashes\n'
    await writeFile(join(root, SKILL), mine)

    const result = await ensureSeeded(root)
    expect(await readFile(join(root, SKILL), 'utf8')).toBe(mine)
    expect(result.refreshed).not.toContain(SKILL)
    expect(result.skipped.map((s) => s.path)).toContain(SKILL)
  })

  it('adopts an unrecorded managed file whose content is already ours', async () => {
    // Byte-identical to what we ship, so it IS ours however it got there.
    // Recording it is what lets the NEXT version reach this vault.
    const root = await tempDir()
    await mkdir(join(root, '.claude/skills/vault-apps'), { recursive: true })
    await writeFile(join(root, SKILL), SEED_FILES[SKILL]!)

    const result = await ensureSeeded(root)
    expect(result.refreshed).not.toContain(SKILL)
    expect(result.skipped.map((s) => s.path)).not.toContain(SKILL)
    expect(await mayRefresh(root, SKILL, SEED_FILES[SKILL]!)).toBe(true)
  })

  it('never rewrites a once-file, even when the hash says it could', async () => {
    // AGENTS.md becomes the user's the moment it exists, and no hash, no flag
    // and no version bump changes that.
    const root = await tempDir()
    await ensureSeeded(root)

    const mine = '# my rules\n'
    await writeFile(join(root, 'AGENTS.md'), mine)
    await recordSeeded(root, 'AGENTS.md', mine)

    const result = await ensureSeeded(root)
    expect(await readFile(join(root, 'AGENTS.md'), 'utf8')).toBe(mine)
    expect(result.refreshed).not.toContain('AGENTS.md')
  })

  it('is still idempotent: a settled vault reports no work at all', async () => {
    const root = await tempDir()
    await ensureSeeded(root)
    const second = await ensureSeeded(root)
    expect(second.written).toEqual([])
    expect(second.refreshed).toEqual([])
    expect(second.skipped).toEqual([])
  })
})

describe('refreshManaged — what `holi seed refresh` does', () => {
  const SKILL = '.claude/skills/vault-apps/SKILL.md'
  const GATE = '.claude/hooks/google-send-gate.mjs'

  /** Seed, then make `rel` look like an older shipped version Holi still owns. */
  async function stale(root: string, rel: string): Promise<void> {
    const old = `# an older version\n`
    await writeFile(join(root, rel), old)
    await recordSeeded(root, rel, old)
  }

  it('with no path, refreshes every managed file Holi still owns', async () => {
    const root = await tempDir()
    await ensureSeeded(root)
    await stale(root, SKILL)
    await stale(root, GATE)

    const result = await refreshManaged(root, {})
    expect(result.refreshed.sort()).toEqual([GATE, SKILL].sort())
    expect(await readFile(join(root, SKILL), 'utf8')).toBe(SEED_FILES[SKILL])
  })

  it('reports each skip with its reason rather than failing', async () => {
    const root = await tempDir()
    await ensureSeeded(root)
    await stale(root, SKILL)
    await writeFile(join(root, GATE), '// mine now\n')

    const result = await refreshManaged(root, {})
    expect(result.refreshed).toEqual([SKILL])
    expect(result.skipped).toEqual([{ path: GATE, reason: 'edited' }])
  })

  it('takes a single path', async () => {
    const root = await tempDir()
    await ensureSeeded(root)
    await stale(root, SKILL)
    await stale(root, GATE)

    const result = await refreshManaged(root, { path: SKILL })
    expect(result.refreshed).toEqual([SKILL])
    expect(await readFile(join(root, GATE), 'utf8')).toBe('# an older version\n')
  })

  it('--force overwrites a managed file somebody edited', async () => {
    const root = await tempDir()
    await ensureSeeded(root)
    await writeFile(join(root, SKILL), '# mine\n')

    expect((await refreshManaged(root, { path: SKILL })).skipped).toEqual([
      { path: SKILL, reason: 'edited' },
    ])
    const forced = await refreshManaged(root, { path: SKILL, force: true })
    expect(forced.refreshed).toEqual([SKILL])
    expect(await readFile(join(root, SKILL), 'utf8')).toBe(SEED_FILES[SKILL])
  })

  it('--force does NOT reach a once-file — AGENTS.md is the user\'s', async () => {
    const root = await tempDir()
    await ensureSeeded(root)
    await writeFile(join(root, 'AGENTS.md'), '# my rules\n')

    const result = await refreshManaged(root, { path: 'AGENTS.md', force: true })
    expect(result.refreshed).toEqual([])
    expect(result.skipped).toEqual([{ path: 'AGENTS.md', reason: 'not managed' }])
    expect(await readFile(join(root, 'AGENTS.md'), 'utf8')).toBe('# my rules\n')
  })

  it('refuses a path Holi does not ship at all', async () => {
    const root = await tempDir()
    await ensureSeeded(root)
    const result = await refreshManaged(root, { path: 'notes/mine.md', force: true })
    expect(result.skipped).toEqual([{ path: 'notes/mine.md', reason: 'not managed' }])
  })

  it('recreates a managed file that was deleted', async () => {
    const root = await tempDir()
    await ensureSeeded(root)
    await rm(join(root, SKILL))

    const result = await refreshManaged(root, { path: SKILL })
    expect(result.refreshed).toEqual([SKILL])
    expect(await readFile(join(root, SKILL), 'utf8')).toBe(SEED_FILES[SKILL])
  })

  it('says nothing at all when everything is already current', async () => {
    const root = await tempDir()
    await ensureSeeded(root)
    expect(await refreshManaged(root, {})).toEqual({ refreshed: [], skipped: [] })
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
    expect(flat).toContain('holi app open <id>')
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
    for (const rule of ['localStorage', 'holi.data', 'opaque origin']) {
      expect(flat).toContain(rule)
    }
  })
})
