/**
 * `holi`: the command the agent (or a person, in a vault's terminal) types to
 * ask Holi something. `holi <namespace> <verb> [arguments]`.
 *
 * **The script is generic.** It posts its argv to the bridge's `/cli` route
 * and prints what comes back; every command is a capability open at the CLI
 * door, and `resolveArgv` below reads argv against the `cli` spec each one
 * declares. A feature adds a command by registering a capability, never shell.
 *
 * A generated shell script rather than a shipped binary: no build step or
 * packaging entry, readable by the person whose machine it is on, and it finds
 * the running Holi afresh at every invocation, so it survives an app restart,
 * which moves the ephemeral port.
 *
 * **Nothing here is gated.** Almost every command is reversible or read-only
 * (opening a tab, scaffolding a directory, a record write that is a file
 * change in git history). Those that reach another person, `holi google
 * send|reply|respond` and any `holi google api` that is not a GET, are asked
 * about by the agent's send gate, a hook that matches the command line;
 * `resolveArgv` refuses any word before the verb, and a `positionalOnly`
 * command's arguments given as options, so that match stays sound.
 *
 * No `electron` import: this loads under plain Node in the tests.
 */
import { chmod, mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { CapabilityError, NEXT_STEP } from '../capabilities/error'
import type { CliCommand } from '../capabilities/registry'
import { isRemote } from '@holi/shared'
import { shellJobId } from './env-file'

/** What argv asks for. */
export type CliRequest =
  /** Run `name`; a refusal is printed after `label`, and a BAD_REQUEST one
   *  with `usage`, the command's line. */
  | {
      kind: 'run'
      name: string
      label: string
      usage: string
      /** A `many` param is a list; every other is one string. */
      params: Record<string, string | string[]>
      json: boolean
      /** Selected own-property paths for JSON output, when requested. */
      fields?: readonly (readonly string[])[]
      vault: string | null
    }
  /** Not a command: the text says why and what is (exit 2). */
  | { kind: 'usage'; text: string }
  /** Asked for usage, bare or with --help: the text is the answer (exit 0). */
  | { kind: 'help'; text: string; vault: string | null }
  /** The command reads a param from stdin and it was not given: ask the
   *  script for stdin, and run nothing yet. */
  | { kind: 'stdin'; vault: string | null }

/** `--name`: a param's name, as a capability spells it. */
const OPTION_NAME = /^[a-zA-Z][a-zA-Z0-9_-]*$/

const argName = (arg: string): string => arg.replace(/\?$/, '')

/** One command's line: `holi store put <bundle> <collection> <value> [<id>]`. */
function commandLine({ name, cli }: CliCommand): string {
  const words = [
    `holi ${cli.standalone === true ? name.slice(0, name.indexOf('.')) : name.replace('.', ' ')}`,
  ]
  for (const arg of cli.args) {
    words.push(arg.endsWith('?') ? `[<${argName(arg)}>]` : `<${arg}>`)
  }
  for (const flag of cli.flags ?? []) words.push(`[--${flag}]`)
  for (const value of cli.values ?? []) words.push(`[--${value} <${value}>]`)
  for (const name of cli.many ?? []) words.push(`[--${name} <${name}>]...`)
  return words.join(' ')
}

/** `--help` or `-h`: asks for usage, whichever command it follows. */
const HELP = new Set(['--help', '-h'])

/** Every command and its summary, for bare `holi`. */
function usageText(commands: readonly CliCommand[]): string {
  return [
    'usage: holi <namespace> <verb> [arguments] [--vault owner/repo] [--json]',
    '',
    ...commands.flatMap((c) => [`  ${commandLine(c)}`, `      ${c.cli.summary}`]),
    '',
    'Most arguments can also be given as --name value. --json prints the result as JSON.',
    '--fields <paths> selects comma-separated dotted fields from the JSON result and requires --json.',
    'Example: holi google search --json --fields threads.id,threads.subject,nextPageToken',
    'Use --vault owner/repo after the command to target a managed vault from any directory.',
  ].join('\n')
}

/**
 * Read argv against the commands. The namespace and the verb come first, and
 * nothing may come before the verb: a gate that matches `holi <ns> <verb>`
 * stays sound only if no option can sit in front of it.
 *
 * `stdin` is what the script sent on its second leg, or null on the first.
 * `job` is the calling session's job id, or null outside a background one.
 */
export function resolveArgv(
  argv: readonly string[],
  commands: readonly CliCommand[],
  stdin: string | null,
  job: string | null = null,
): CliRequest {
  const usage = (why: string): CliRequest => ({
    kind: 'usage',
    text: `${why}\n\n${usageText(commands)}`,
  })
  // Asking for usage is not an error: bare `holi` and any `--help` before a
  // `--` answer it and run nothing, the one command's line when one is named.
  const standalone = commands.filter((c) => c.cli.standalone === true)
  const standaloneByNamespace = new Map<string, CliCommand>()
  for (const command of standalone) {
    const namespace = command.name.slice(0, command.name.indexOf('.'))
    if (standaloneByNamespace.has(namespace)) {
      throw new Error(`multiple standalone CLI commands for namespace ${namespace}`)
    }
    standaloneByNamespace.set(namespace, command)
  }
  const end = argv.indexOf('--')
  if (argv.length === 0 || (end < 0 ? argv : argv.slice(0, end)).some((w) => HELP.has(w))) {
    const named = commands.find((c) => c.name === `${argv[0]}.${argv[1]}`)
    const root = argv[0] === undefined ? undefined : standaloneByNamespace.get(argv[0])
    const text =
      named !== undefined
        ? `usage: ${commandLine(named)} [--json] [--fields <paths>]\n${named.cli.summary}\n--fields selects comma-separated dotted fields and requires --json.`
        : root !== undefined
          ? `usage: ${commandLine(root)} [--json] [--fields <paths>]\n${root.cli.summary}\n--fields selects comma-separated dotted fields and requires --json.`
          : usageText(commands)
    const target = named ?? root
    let vault: string | null = null
    if (target !== undefined) {
      const rest = argv.slice(named === undefined ? 1 : 2)
      let options = true
      for (let i = 0; i < rest.length; i++) {
        const word = rest[i]!
        if (options && word === '--') {
          options = false
          continue
        }
        if (!options || HELP.has(word) || !word.startsWith('--')) continue
        const eq = word.indexOf('=')
        const name = eq < 0 ? word.slice(2) : word.slice(2, eq)
        const takesValue =
          name === 'fields' ||
          target.cli.values?.includes(name) === true ||
          target.cli.many?.includes(name) === true ||
          target.cli.args.some((arg) => argName(arg) === name) ||
          name === target.cli.stdin ||
          name === target.cli.stdinUnless ||
          name === target.cli.job ||
          (target.cli.values === undefined && !target.cli.flags?.includes(name))
        if (name === 'vault') {
          const value = eq < 0 ? rest[++i] : word.slice(eq + 1)
          if (value && isRemote(value)) vault = value
        } else if (eq < 0 && name !== 'json' && takesValue) {
          i++
        }
      }
    }
    return { kind: 'help', text, vault }
  }
  const ns = argv[0]
  const standaloneCommand = ns === undefined ? undefined : standaloneByNamespace.get(ns)
  const bare =
    standaloneCommand !== undefined && (argv[1] === undefined || argv[1]!.startsWith('-'))
  const verb = bare
    ? standaloneCommand!.name.slice(standaloneCommand!.name.indexOf('.') + 1)
    : argv[1]
  if (ns === undefined || ns.startsWith('-') || verb === undefined || verb.startsWith('-')) {
    return usage('holi: say the command first: holi <namespace> <verb>')
  }
  const command = bare ? standaloneCommand : commands.find((c) => c.name === `${ns}.${verb}`)
  if (command === undefined) return usage(`holi: no such command: ${ns} ${verb}`)

  const label = `holi ${ns}${bare ? '' : ` ${verb}`}`
  const wrong = (why: string): CliRequest => ({
    kind: 'usage',
    text: `${label}: ${why}\nusage: ${commandLine(command)}`,
  })
  const { cli } = command
  const params: Record<string, string | string[]> = {}
  const positionals: string[] = []
  let json = false
  let fields: readonly (readonly string[])[] | undefined
  let fieldsGiven = false
  let vault: string | null = null
  let options = true
  const rest = argv.slice(bare ? 1 : 2)
  for (let i = 0; i < rest.length; i++) {
    const word = rest[i]!
    if (options && word === '--') {
      options = false
    } else if (options && word.startsWith('--')) {
      const eq = word.indexOf('=')
      const name = eq < 0 ? word.slice(2) : word.slice(2, eq)
      if (!OPTION_NAME.test(name)) return wrong(`not an option: ${word}`)
      if (name === 'vault') {
        if (vault !== null) return wrong('--vault is given twice')
        const value = eq >= 0 ? word.slice(eq + 1) : rest[++i]
        if (!value) return wrong('--vault needs a non-empty owner/repo')
        if (!isRemote(value)) return wrong('--vault must be owner/repo')
        vault = value
        continue
      }
      if (name === 'json' && eq < 0) {
        json = true
        continue
      }
      if (name === 'fields') {
        if (fieldsGiven) return wrong('--fields is given twice')
        fieldsGiven = true
        const value = eq >= 0 ? word.slice(eq + 1) : rest[++i]
        if (value === undefined) return wrong('--fields needs a value')
        const parsed = parseFieldPaths(value)
        if (typeof parsed === 'string') return wrong(parsed)
        fields = parsed
        continue
      }
      if (cli.many?.includes(name)) {
        const value = eq >= 0 ? word.slice(eq + 1) : rest[++i]
        if (value === undefined) return wrong(`--${name} needs a value`)
        const prior = params[name]
        params[name] = [...(Array.isArray(prior) ? prior : []), value]
        continue
      }
      const isFlag = cli.flags?.includes(name) === true
      const takesValue =
        cli.values?.includes(name) === true ||
        cli.many?.includes(name) === true ||
        cli.args.some((arg) => argName(arg) === name) ||
        name === cli.stdin ||
        name === cli.stdinUnless ||
        name === cli.job
      // `values` opts a command into strict option validation. Older commands
      // rely on undeclared named values, so leave their grammar unchanged.
      if (cli.values !== undefined && !isFlag && !takesValue)
        return wrong(`unknown option --${name}`)
      if (Object.hasOwn(params, name) && !cli.many?.includes(name))
        return wrong(`--${name} is given twice`)
      if (cli.positionalOnly === true && cli.args.some((arg) => argName(arg) === name)) {
        return wrong(`give ${name} in its place, not as --${name}`)
      }
      if (isFlag && eq >= 0 && cli.values !== undefined)
        return wrong(`--${name} does not take a value`)
      if (isFlag && eq < 0) {
        params[name] = 'true'
      } else {
        const value = eq >= 0 ? word.slice(eq + 1) : rest[++i]
        if (value === undefined || (eq < 0 && cli.values !== undefined && value.startsWith('--')))
          return wrong(`--${name} needs a value`)
        if (cli.many?.includes(name)) {
          const prior = params[name]
          params[name] = [...(Array.isArray(prior) ? prior : []), value]
        } else params[name] = value
      }
    } else if (options && word.startsWith('-') && word !== '-') {
      return wrong(`unknown option ${word}`)
    } else {
      positionals.push(word)
    }
  }

  for (const arg of cli.args) {
    const name = argName(arg)
    const value = positionals.shift()
    if (value !== undefined) {
      if (Object.hasOwn(params, name)) return wrong(`${name} is given twice`)
      params[name] = value
    } else if (!arg.endsWith('?') && !Object.hasOwn(params, name) && name !== cli.stdin) {
      return wrong(`${name} is missing`)
    }
  }
  if (positionals.length > 0) return wrong(`unexpected argument: ${positionals[0]}`)
  if (fieldsGiven && !json) return wrong('--fields requires --json')
  if (cli.job !== undefined && job !== null && job !== '') {
    // Inside a session, the command is that session's: naming another one
    // would let any session act as the one a verb trusts (a meeting's
    // scribe). The flag is for a person at a terminal outside any session.
    if (Object.hasOwn(params, cli.job) && params[cli.job] !== job) {
      return wrong(
        `--${cli.job} names another session; run inside one, this command is always its own`,
      )
    }
    params[cli.job] = job
  }

  const bodyless = cli.stdinUnless !== undefined && Object.hasOwn(params, cli.stdinUnless)
  const wantsStdin =
    cli.stdin !== undefined &&
    (cli.stdinOnDash === true ? params[cli.stdin] === '-' : !Object.hasOwn(params, cli.stdin))
  if (cli.stdin !== undefined && !bodyless && wantsStdin) {
    if (stdin === null) return { kind: 'stdin', vault }
    params[cli.stdin] = stdin
  }
  return {
    kind: 'run',
    name: command.name,
    label,
    usage: commandLine(command),
    params,
    json,
    ...(fields === undefined ? {} : { fields }),
    vault,
  }
}

const FIELD_SEGMENT = /^[A-Za-z_$][A-Za-z0-9_$-]*$/
const FORBIDDEN_FIELD_SEGMENTS = new Set(['__proto__', 'constructor', 'prototype'])

/** Parse a deliberately small field selector grammar: comma-separated dotted own keys. */
function parseFieldPaths(raw: string): readonly (readonly string[])[] | string {
  const entries = raw.split(',').map((entry) => entry.trim())
  if (entries.some((entry) => entry.length === 0)) return '--fields contains an empty path'
  const paths: string[][] = []
  for (const entry of entries) {
    const segments = entry.split('.')
    if (
      segments.some(
        (segment) => !FIELD_SEGMENT.test(segment) || FORBIDDEN_FIELD_SEGMENTS.has(segment),
      )
    ) {
      return `invalid --fields path: ${entry}`
    }
    paths.push(segments)
  }
  return paths
}

/**
 * A failed command, as the agent reads it on stderr. A refusal names its code
 * and the next step, since that step is what the agent acts on:
 *
 *     holi google search: UNAUTHORIZED: Google needs reconnecting
 *     next: ask the person to press Reconnect for Google in Holi's vault settings
 *
 * Anything else that throws is a failure inside Holi, with no step to name, so
 * it prints its message alone.
 */
export function refusalText(request: { label: string; usage: string }, error: unknown): string {
  if (!(error instanceof CapabilityError)) {
    return `${request.label}: ${error instanceof Error ? error.message : String(error)}`
  }
  const lines = [
    `${request.label}: ${error.code}: ${error.message}`,
    `next: ${error.next ?? NEXT_STEP[error.code]}`,
  ]
  if (error.code === 'BAD_REQUEST') lines.push(`usage: ${request.usage}`)
  return lines.join('\n')
}

const shellQuote = (value: string): string => `'${value.replace(/'/g, "'\\''")}'`

const SCRIPT = (descriptorPath: string, platform: NodeJS.Platform) => {
  const regexQuote = platform === 'win32' ? '"' : '\\"'
  const jobField =
    platform === 'win32'
      ? `${shellJobId(platform)}\n[ -n "$job" ] && set -- "$@" --data-urlencode "job=$job"`
      : `if [ -n "\${CLAUDE_JOB_DIR:-}" ]; then
  set -- "$@" --data-urlencode "job=\${CLAUDE_JOB_DIR##*/}"
fi`
  return `#!/bin/sh
# holi: ask the running Holi app something. Run it bare for every command.
# Generated by Holi. Talks to the running app via a private machine credential.
# A vault-local hook separately gates commands that reach other people.
set -eu

endpoint=${shellQuote(descriptorPath)}
if [ -L "\$endpoint" ] || [ ! -f "\$endpoint" ]; then
  echo "holi: Holi is not running (CLI endpoint descriptor is missing or unsafe)." >&2
  exit 1
fi

# Accept only the canonical descriptor written by Holi, in exact field order.
# Parsing as data avoids ever evaluating content from a file.
parsed=\$(awk '
  NR == 1 && \$0 == "{" { next }
  NR == 2 && \$0 == "  \\"host\\": \\"127.0.0.1\\"," { host=1; next }
  NR == 3 && \$0 ~ /^  ${regexQuote}port${regexQuote}: [0-9]+,\$/ { port=\$0; sub(/^  ${regexQuote}port${regexQuote}: /, "", port); sub(/,\$/, "", port); next }
  NR == 4 && \$0 ~ /^  ${regexQuote}token${regexQuote}: ${regexQuote}[0-9a-f]+${regexQuote}\$/ { token=\$0; sub(/^  ${regexQuote}token${regexQuote}: ${regexQuote}/, "", token); sub(/${regexQuote}\$/, "", token); next }
  NR == 5 && \$0 == "}" { closed=1; next }
  { bad=1 }
  END {
    if (NR != 5 || !host || !closed || bad || port !~ /^[0-9]+\$/ || length(token) != 64) exit 1
    if (port < 1 || port > 65535) exit 1
    print port " " token
  }
' "\$endpoint") || {
  echo "holi: Holi is not running (CLI endpoint descriptor is malformed)." >&2
  exit 1
}
port=\${parsed%% *}
token=\${parsed#* }

umask 077
out=\$(mktemp) || { echo "holi: cannot create a private response file." >&2; exit 1; }
config=\$(mktemp) || { rm -f "\$out"; echo "holi: cannot create a private credential file." >&2; exit 1; }
cleanup() { rm -f "\$out" "\$config"; }
trap cleanup EXIT
trap 'cleanup; exit 1' HUP INT TERM
printf 'header = "x-holi-cli-token: %s"\\n' "\$token" > "\$config"
unset token parsed

cwd=\$(pwd -P) || { echo "holi: cannot determine physical working directory." >&2; exit 1; }
# Build form fields without losing spaces, Unicode, --, or empty arguments.
for a in "\$@"; do
  shift
  set -- "\$@" --data-urlencode "argv=\$a"
done
set -- "\$@" --data-urlencode "cwd=\$cwd"
${jobField}

send() {
  curl -q --noproxy '*' -sS --config "\$config" -X POST -o "\$out" -w '%{http_code}' \\
    "http://127.0.0.1:\$port/cli" "\$@"
}
code=\$(send "\$@") || { echo "holi: could not reach the running Holi app." >&2; exit 1; }
if [ "\$code" = 428 ]; then
  code=\$(send "\$@" --data-urlencode "stdin@-") || { echo "holi: could not reach the running Holi app." >&2; exit 1; }
fi
case "\$code" in
  200) cat "\$out"; echo ;;
  400) cat "\$out" >&2; echo >&2; exit 2 ;;
  422) cat "\$out" >&2; echo >&2; exit 1 ;;
  401|403) echo "holi: this CLI endpoint rejected the request." >&2; exit 1 ;;
  *) echo "holi: Holi answered \$code" >&2; exit 1 ;;
esac
`
}

/**
 * Write the script and make it executable. Returns its absolute path, which
 * becomes `$HOLI_BIN` in the agent's env.
 *
 * Rewritten on every launch rather than written once: it is generated content,
 * so an app update must not leave an older copy in place.
 */
export async function installHoliCli(
  userDataDir: string,
  platform: NodeJS.Platform = process.platform,
): Promise<string> {
  const path = join(userDataDir, 'bin', 'holi')
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, SCRIPT(join(userDataDir, 'cli-endpoint.json'), platform), { mode: 0o755 })
  // `writeFile`'s mode is ignored when the file already exists.
  await chmod(path, 0o755)
  return path
}
