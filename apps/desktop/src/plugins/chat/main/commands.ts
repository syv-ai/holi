/**
 * What the composer's `/` menu lists (docs/features/chat.md, The composer):
 * what Claude Code would run as `/<name>` in this vault.
 *
 * Two sources, merged by name:
 *
 * - **What Claude Code said.** A session's `init` lists its `slash_commands`
 *   (built-ins, the vault's commands and skills, its plugins') and which of
 *   them are skills. That is the authority once any session in the vault has
 *   run; the chats keep the last list (`Chats.sessionCommands`).
 * - **The files.** `.claude/commands/**.md` and `.claude/skills/<name>/SKILL.md`
 *   in the vault and in its Claude Code config directory, read for their
 *   `description`, so a row says what it does, and so a vault with no session
 *   yet still lists its own. Before any session has said, a short list of
 *   built-ins that run in a chat stands in for Claude Code's.
 *
 * After MonoCode's skill discovery (`src-tauri/src/skills.rs`, `list_skills`)
 * and its picker's ranking (MIT, Copyright (c) 2026 Nick; see NOTICE.md).
 *
 * No Electron import: this loads under plain Node in the tests.
 */
import { readdir, readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, relative, sep } from 'node:path'
import { BUILTIN_COMMANDS, type ChatCommand } from '../shared/chat'
import type { SessionCommands } from './chats'

/** How many files a scan reads at most, so a huge folder cannot stall it. */
const MAX_FILES = 2_000

/** A markdown file's frontmatter `description`, or its first prose line. */
export function describe(text: string): string | undefined {
  const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)
  if (fm !== null) {
    const line = /^description:\s*(.+)$/m.exec(fm[1]!)
    if (line !== null) {
      const value = line[1]!
        .trim()
        .replace(/^(['"])(.*)\1$/, '$2')
        .trim()
      if (value !== '' && value !== '|' && value !== '>') return value
    }
  }
  const body = fm === null ? text : text.slice(fm[0].length)
  const first = body
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l !== '' && !l.startsWith('#') && !l.startsWith('<!--'))
  if (first === undefined) return undefined
  return first.length > 140 ? `${first.slice(0, 139)}…` : first
}

/** A skill's own `name:` from its frontmatter, when it gives one. */
function frontmatterName(text: string): string | undefined {
  const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)
  const line = fm === null ? null : /^name:\s*(.+)$/m.exec(fm[1]!)
  const value = line?.[1]?.trim().replace(/^(['"])(.*)\1$/, '$2')
  return value === undefined || value === '' ? undefined : value
}

async function walk(dir: string, out: string[]): Promise<void> {
  if (out.length >= MAX_FILES) return
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
  for (const e of entries) {
    if (out.length >= MAX_FILES) return
    if (e.name.startsWith('.')) continue
    const path = join(dir, e.name)
    if (e.isDirectory()) await walk(path, out)
    else if (e.isFile() && e.name.endsWith('.md')) out.push(path)
  }
}

/** `<root>/commands/**.md`: a file in a subfolder is `folder:name`, as
 *  Claude Code names it. */
async function scanCommands(root: string, scope: ChatCommand['scope']): Promise<ChatCommand[]> {
  const base = join(root, 'commands')
  const files: string[] = []
  await walk(base, files)
  const out: ChatCommand[] = []
  for (const file of files) {
    const name = relative(base, file).replace(/\.md$/, '').split(sep).join(':')
    const text = await readFile(file, 'utf8').catch(() => '')
    const description = describe(text)
    out.push({ name, kind: 'command', scope, ...(description ? { description } : {}) })
  }
  return out
}

/** `<root>/skills/<name>/SKILL.md`. */
async function scanSkills(root: string, scope: ChatCommand['scope']): Promise<ChatCommand[]> {
  const base = join(root, 'skills')
  const entries = await readdir(base, { withFileTypes: true }).catch(() => [])
  const out: ChatCommand[] = []
  for (const e of entries.slice(0, MAX_FILES)) {
    if (!e.isDirectory() && !e.isSymbolicLink()) continue
    const text = await readFile(join(base, e.name, 'SKILL.md'), 'utf8').catch(() => null)
    if (text === null) continue
    const description = describe(text)
    out.push({
      name: frontmatterName(text) ?? e.name,
      kind: 'skill',
      scope,
      ...(description ? { description } : {}),
    })
  }
  return out
}

export interface CommandSources {
  /** The vault clone. */
  root: string
  /** Claude Code's config directory for the vault (`$CLAUDE_CONFIG_DIR`). */
  configDir: string
  /** What the vault's last session reported, or null before one has run. */
  session: SessionCommands | null
}

/** The config directory Claude Code reads in the vault: the one the agent
 *  hands every session, or the person's own. */
export const configDirOf = (env: Record<string, string>): string =>
  env['CLAUDE_CONFIG_DIR'] ?? join(homedir(), '.claude')

/** Every `/` command of the vault, sorted by name, the vault's own first
 *  among equals. */
export async function listCommands(src: CommandSources): Promise<ChatCommand[]> {
  const [vaultCommands, vaultSkills, userCommands, userSkills] = await Promise.all([
    scanCommands(join(src.root, '.claude'), 'vault'),
    scanSkills(join(src.root, '.claude'), 'vault'),
    scanCommands(src.configDir, 'user'),
    scanSkills(src.configDir, 'user'),
  ])
  const builtins: readonly ChatCommand[] = BUILTIN_COMMANDS
  // Earlier wins: the vault's own, then the person's, then Claude Code's.
  const byName = new Map<string, ChatCommand>()
  for (const c of [...vaultSkills, ...vaultCommands, ...userSkills, ...userCommands, ...builtins]) {
    if (!byName.has(c.name)) byName.set(c.name, c)
  }
  if (src.session !== null) {
    // Claude Code's list is what it will actually run: keep what it named,
    // with the description a file gave, and add what no file explains
    // (its plugins' skills, its newer built-ins).
    const skills = new Set(src.session.skills)
    const said: ChatCommand[] = []
    for (const name of src.session.names) {
      const known = byName.get(name)
      if (known !== undefined) said.push(known)
      else
        said.push({
          name,
          kind: skills.has(name) ? 'skill' : 'builtin',
          scope: name.includes(':') ? 'plugin' : skills.has(name) ? 'user' : 'builtin',
        })
    }
    // A file added since the session started is the vault's too.
    for (const c of [...vaultSkills, ...vaultCommands]) {
      if (!said.some((s) => s.name === c.name)) said.push(c)
    }
    return said.sort(byScopeThenName)
  }
  return [...byName.values()].sort(byScopeThenName)
}

const SCOPE_RANK: Record<ChatCommand['scope'], number> = {
  vault: 0,
  user: 1,
  plugin: 2,
  builtin: 3,
}

function byScopeThenName(a: ChatCommand, b: ChatCommand): number {
  return SCOPE_RANK[a.scope] - SCOPE_RANK[b.scope] || a.name.localeCompare(b.name)
}
