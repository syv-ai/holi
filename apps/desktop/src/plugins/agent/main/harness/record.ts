/**
 * An agent harness, as this machine keeps it (docs/features/agent-sessions.md,
 * Harnesses): what Holi runs for an agent's terminal, and the few other
 * command lines it needs for what that agent supports.
 *
 * The record is `<userData>/agent-harnesses.json`, this machine's alone: which
 * CLIs are installed is the machine's, never the vault's. The three built-in
 * agents are presets in it, shown and editable in their command fields,
 * keeping their real integrations (`integration`); one a person adds has no
 * integration and is a basic terminal agent.
 *
 * **Nothing here is a shell string.** A command is a program and its
 * arguments, handed to the PTY as they are; `{prompt}` and `{id}` fill a whole
 * argument and nothing else; the program must be one file on disk or a bare
 * name looked up on `PATH`; the environment may not move `PATH`, Holi's own
 * variables or the bridge's.
 *
 * Pure but for `resolveHarnessBin`: no `electron` import.
 */
import { accessSync, constants, statSync } from 'node:fs'
import { AGENT_ID } from '@holi/shared'
import { resolveBin } from '../../../../main/plugin-api'

/** The built-in agents whose integration a preset keeps. */
export const INTEGRATIONS = ['claude', 'codex', 'pi'] as const
export type HarnessIntegration = (typeof INTEGRATIONS)[number]

/** Is `id` a built-in agent's? */
export const isIntegration = (id: string): id is HarnessIntegration =>
  (INTEGRATIONS as readonly string[]).includes(id)

export interface Harness {
  id: string
  label: string
  /** A built-in agent's real integration. Absent: a basic terminal agent. */
  integration?: HarnessIntegration
  /** What a terminal runs. For Codex's and Pi's presets, `args` go before
   *  their own; Claude Code's preset takes none (its sessions are its
   *  supervisor's, which reads no arguments or environment of Holi's). */
  command: { bin: string; args: string[] }
  /** Starting on a first message: arguments after the command's, one of them
   *  exactly `{prompt}`. */
  prompt?: { args: string[] }
  /** Picking up a conversation: the CLI's own picker (`pick`), or one by its
   *  id (`byId`, one argument exactly `{id}`). */
  resume?: { pick?: string[]; byId?: string[] }
  /** Set for its terminals, and for Codex's and Pi's jobs too. */
  env?: Record<string, string>
  /** What Test runs: arguments after the program, `--version` when absent. */
  test?: string[]
}

export interface HarnessFile {
  version: 1
  harnesses: Harness[]
  /** Read, never written: entries in the file that did not read as a
   *  harness, left out. */
  ignored?: number
  /** Read, never written: why the file as a whole could not be read. While
   *  it is set, Holi writes nothing over the file until it is reset. */
  unreadable?: string
}

const PROMPT = '{prompt}'
const CONVERSATION = '{id}'

/** The built-in agents, as presets. */
export const PRESETS: readonly Harness[] = [
  {
    id: 'claude',
    label: 'Claude Code',
    integration: 'claude',
    command: { bin: 'claude', args: [] },
  },
  { id: 'codex', label: 'Codex', integration: 'codex', command: { bin: 'codex', args: [] } },
  { id: 'pi', label: 'Pi', integration: 'pi', command: { bin: 'pi', args: [] } },
]

export const presetOf = (id: string): Harness | undefined => PRESETS.find((p) => p.id === id)

/** A program by its bare name, which `PATH` finds: no path, no shell. */
const BARE_BIN = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/
/** An environment variable's name. */
const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/
/** Control characters, which no argument, label or value carries. */
const CONTROL = /[\u0000-\u0008\u000a-\u001f\u007f]/
const MAX_ARGS = 64
const MAX_ARG = 4096
const MAX_LABEL = 60

/** Why an environment variable may not be set, or null when it may. */
function forbiddenEnv(key: string): string | null {
  if (!ENV_KEY.test(key)) return `${key} is not a variable name.`
  if (key === 'PATH') {
    return "PATH is Holi's to set: it puts its own commands first. Give the program by its full path instead."
  }
  if (key.startsWith('HOLI_')) return `${key} is Holi's own: sessions and the bridge rely on it.`
  return null
}

/** Why `bin` cannot be a program, or null when it reads as one. */
function badBin(bin: string): string | null {
  if (bin.trim() === '') return 'Name the program to run.'
  if (CONTROL.test(bin) || bin.includes('\0')) return 'The program has a control character in it.'
  if (bin.startsWith('/')) return null
  if (BARE_BIN.test(bin)) return null
  return /\s/.test(bin)
    ? `"${bin}" reads as a shell command. Give the program alone, and each argument on its own line.`
    : `"${bin}" is neither a program's name nor a full path (one that starts with /).`
}

type ArgsField = 'command' | 'prompt' | 'byId' | 'pick' | 'test'

/** The one placeholder each list may carry, as a whole argument. */
const PLACEHOLDER: Partial<Record<ArgsField, string>> = { prompt: PROMPT, byId: CONVERSATION }

const FIELD_NAME: Record<ArgsField, string> = {
  command: 'The arguments',
  prompt: 'The start-on-a-message arguments',
  byId: 'The resume-by-id arguments',
  pick: 'The resume-picker arguments',
  test: 'The test arguments',
}

function argsProblems(value: unknown, field: ArgsField): { args: string[]; problems: string[] } {
  const name = FIELD_NAME[field]
  if (!Array.isArray(value) || value.some((a) => typeof a !== 'string')) {
    return { args: [], problems: [`${name} must be a list of text.`] }
  }
  const args = value as string[]
  const problems: string[] = []
  if (args.length > MAX_ARGS) problems.push(`${name} are more than ${MAX_ARGS}.`)
  if (args.some((a) => a.length > MAX_ARG || a.includes('\0'))) {
    problems.push(`${name} have one too long, or with a NUL in it.`)
  }
  const own = PLACEHOLDER[field]
  for (const placeholder of [PROMPT, CONVERSATION]) {
    const inside = args.filter((a) => a !== placeholder && a.includes(placeholder))
    if (inside.length > 0) {
      problems.push(
        `${name} put ${placeholder} inside "${inside[0]}". It fills a whole argument: put it on a line of its own.`,
      )
    }
    if (placeholder !== own && args.includes(placeholder)) {
      problems.push(`${name} cannot take ${placeholder}.`)
    }
  }
  if (own !== undefined) {
    const count = args.filter((a) => a === own).length
    if (count !== 1) problems.push(`${name} need ${own} exactly once, as an argument of its own.`)
  }
  return { args, problems }
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v)

/**
 * A harness out of untrusted input (the Settings form, a hand-edited file),
 * or every reason it is not one, each in words a person can act on.
 * @public exported for its test
 */
export function readHarness(
  raw: unknown,
): { ok: true; harness: Harness } | { ok: false; problems: string[] } {
  if (!isRecord(raw)) return { ok: false, problems: ['An agent must be an object.'] }
  const problems: string[] = []
  const id = raw['id']
  if (typeof id !== 'string' || !AGENT_ID.test(id)) {
    problems.push(
      'Its id must be 2 to 32 lowercase letters, digits and dashes, starting with a letter.',
    )
  }
  const label = typeof raw['label'] === 'string' ? raw['label'].trim() : ''
  if (label === '' || label.length > MAX_LABEL || CONTROL.test(label)) {
    problems.push(`Give it a name of 1 to ${MAX_LABEL} characters.`)
  }
  let integration: HarnessIntegration | undefined
  if (raw['integration'] !== undefined) {
    const value = raw['integration']
    if (!(INTEGRATIONS as readonly unknown[]).includes(value)) {
      problems.push(`${String(value)} is not an integration Holi has: claude, codex or pi.`)
    } else {
      integration = value as HarnessIntegration
      if (id !== integration)
        problems.push(`The ${integration} integration is the ${integration} agent's alone.`)
    }
  } else if (typeof id === 'string' && presetOf(id) !== undefined) {
    problems.push(`${id} is a built-in agent's id. Choose another.`)
  }
  const command = raw['command']
  let bin = ''
  let args: string[] = []
  if (!isRecord(command) || typeof command['bin'] !== 'string') {
    problems.push('Name the program to run.')
  } else {
    bin = command['bin'].trim()
    const why = badBin(bin)
    if (why !== null) problems.push(why)
    const read = argsProblems(command['args'] ?? [], 'command')
    args = read.args
    problems.push(...read.problems)
  }
  const harness: Harness = { id: id as string, label, command: { bin, args } }
  if (integration !== undefined) harness.integration = integration

  if (integration === 'claude' && (args.length > 0 || raw['env'] !== undefined)) {
    problems.push(
      "Claude Code's sessions run in its own background supervisor, which takes no arguments or environment from Holi.",
    )
  }
  if (raw['prompt'] !== undefined || raw['resume'] !== undefined) {
    if (integration !== undefined) {
      problems.push(
        `How ${label || 'a built-in agent'} starts, resumes and reports its turns is its integration's.`,
      )
    }
  }
  if (raw['prompt'] !== undefined) {
    const prompt = raw['prompt']
    const read = argsProblems(isRecord(prompt) ? prompt['args'] : null, 'prompt')
    problems.push(...read.problems)
    harness.prompt = { args: read.args }
  }
  if (raw['resume'] !== undefined) {
    const resume = raw['resume']
    if (!isRecord(resume)) problems.push('Resume must say how: pick, by id, or both.')
    else {
      const out: NonNullable<Harness['resume']> = {}
      for (const key of ['pick', 'byId'] as const) {
        if (resume[key] === undefined) continue
        const read = argsProblems(resume[key], key)
        problems.push(...read.problems)
        out[key] = read.args
      }
      if (out.pick !== undefined || out.byId !== undefined) harness.resume = out
    }
  }
  if (raw['env'] !== undefined) {
    const env = raw['env']
    if (!isRecord(env)) problems.push('The environment must be names and their values.')
    else {
      const out: Record<string, string> = {}
      for (const [key, value] of Object.entries(env)) {
        const why = forbiddenEnv(key)
        if (why !== null) problems.push(why)
        else if (typeof value !== 'string' || value.length > MAX_ARG || value.includes('\0')) {
          problems.push(`${key}'s value must be text.`)
        } else out[key] = value
      }
      if (Object.keys(out).length > 0) harness.env = out
    }
  }
  if (raw['test'] !== undefined) {
    const read = argsProblems(raw['test'], 'test')
    problems.push(...read.problems)
    harness.test = read.args
  }
  return problems.length > 0 ? { ok: false, problems } : { ok: true, harness }
}

/**
 * The record's file: every harness that reads as one, the rest left out and
 * counted, so a hand edit gone wrong costs its own entry and says so. One
 * entry per id. A file that is not JSON, not this shape or of a version this
 * Holi does not know is `unreadable`: nothing in it is used, and nothing is
 * written over it until a person resets it. `text` is the file as it is on
 * disk, null when there is none.
 * @public exported for its test
 */
export function parseHarnessFile(raw: unknown, text: string | null = null): HarnessFile {
  const empty: HarnessFile = { version: 1, harnesses: [] }
  if (text === null) return empty
  if (raw === null) return { ...empty, unreadable: 'It is not valid JSON.' }
  if (!isRecord(raw) || !Array.isArray(raw['harnesses'])) {
    return { ...empty, unreadable: 'It is not an object with a harnesses list.' }
  }
  if (raw['version'] !== 1) {
    return {
      ...empty,
      unreadable: `It is version ${JSON.stringify(raw['version']) ?? 'none'}, which this Holi does not know.`,
    }
  }
  const harnesses: Harness[] = []
  let ignored = 0
  for (const entry of raw['harnesses']) {
    const read = readHarness(entry)
    if (read.ok && !harnesses.some((h) => h.id === read.harness.id)) harnesses.push(read.harness)
    else ignored += 1
  }
  return ignored > 0 ? { version: 1, harnesses, ignored } : { version: 1, harnesses }
}

/** One placeholder filled: the whole argument that is it, and no other. */
const fill = (args: readonly string[], placeholder: string, value: string): string[] =>
  args.map((a) => (a === placeholder ? value : a))

/** What a basic terminal agent is asked to open on. */
export interface HarnessOpts {
  prompt?: string
  /** A conversation's id, or `'pick'` for the CLI's own picker. */
  resume?: string
}

/**
 * Why a basic terminal agent cannot open on `opts`, or null when it can.
 * @public exported for its test
 */
export function harnessRefusal(h: Harness, opts: HarnessOpts): string | null {
  if (opts.resume === 'pick' && h.resume?.pick === undefined) {
    return `${h.label} has no resume picker set. Add its arguments in Settings, General, Agents.`
  }
  if (opts.resume !== undefined && opts.resume !== 'pick' && h.resume?.byId === undefined) {
    return `${h.label} cannot pick up a conversation by its id. Add its resume arguments in Settings, General, Agents.`
  }
  const asked = opts.prompt !== undefined && opts.prompt.trim() !== ''
  if (asked && h.prompt === undefined) {
    return `${h.label} cannot start on a message. Add its start-on-a-message arguments in Settings, General, Agents.`
  }
  if (asked && opts.resume !== undefined) {
    return `${h.label} cannot take a message while it picks up a conversation.`
  }
  if (asked && opts.prompt!.startsWith('-') && !endsOptions(h)) {
    return `${h.label} would read a message that starts with - as an option. Start it with another character, or put -- on the line before {prompt} in Settings, General, Agents.`
  }
  return null
}

/** A `--` argument comes before `{prompt}`: what follows is no option. */
function endsOptions(h: Harness): boolean {
  const args = [...h.command.args, ...(h.prompt?.args ?? [])]
  const at = args.indexOf(PROMPT)
  return at !== -1 && args.slice(0, at).includes('--')
}

/**
 * A basic terminal agent's arguments: the command's, then how it starts.
 * Placeholders fill whole arguments, so a prompt is one argument, never
 * split and never read by a shell; one that starts with `-` is refused
 * unless a `--` before `{prompt}` keeps the CLI from reading it as an
 * option.
 * @public exported for its test
 */
export function harnessArgs(h: Harness, opts: HarnessOpts): string[] {
  const why = harnessRefusal(h, opts)
  if (why !== null) throw new Error(why)
  const rest =
    opts.resume === 'pick'
      ? (h.resume?.pick ?? [])
      : opts.resume !== undefined
        ? fill(h.resume?.byId ?? [], CONVERSATION, opts.resume)
        : opts.prompt !== undefined && opts.prompt.trim() !== ''
          ? fill(h.prompt?.args ?? [], PROMPT, opts.prompt)
          : []
  return [...h.command.args, ...rest]
}

function isExecutableFile(path: string): boolean {
  try {
    accessSync(path, constants.X_OK)
    return statSync(path).isFile()
  } catch {
    return false
  }
}

/** The program on disk: a full path that is an executable file, or a bare
 *  name `PATH` (and the usual install folders) finds. Null otherwise. */
export function resolveHarnessBin(
  bin: string,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  if (badBin(bin) !== null) return null
  if (bin.startsWith('/')) return isExecutableFile(bin) ? bin : null
  return resolveBin(bin, env)
}

/** Why a harness's program is not there, in words that say what to do. */
export const notFound = (h: Harness): string =>
  h.command.bin.startsWith('/')
    ? `${h.label}: ${h.command.bin} is not an executable file. Check its command in Settings, General, Agents.`
    : `${h.label}: ${h.command.bin} was not found on PATH. Install it, or give its full path in Settings, General, Agents.`
