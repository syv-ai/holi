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
import { shellReadBridgeEnv } from './env-file'

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
    }
  /** Not a command: the text says why and what is (exit 2). */
  | { kind: 'usage'; text: string }
  /** Asked for usage, bare or with --help: the text is the answer (exit 0). */
  | { kind: 'help'; text: string }
  /** The command reads a param from stdin and it was not given: ask the
   *  script for stdin, and run nothing yet. */
  | { kind: 'stdin' }

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
    'usage: holi <namespace> <verb> [arguments] [--json]',
    '',
    ...commands.flatMap((c) => [`  ${commandLine(c)}`, `      ${c.cli.summary}`]),
    '',
    'Most arguments can also be given as --name value. --json prints the result as JSON.',
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
        ? `usage: ${commandLine(named)}\n${named.cli.summary}`
        : root !== undefined
          ? `usage: ${commandLine(root)}\n${root.cli.summary}`
          : usageText(commands)
    return { kind: 'help', text }
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
      if (name === 'json' && eq < 0) {
        json = true
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
        if (value === undefined || (cli.values !== undefined && value.startsWith('--')))
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
    if (stdin === null) return { kind: 'stdin' }
    params[cli.stdin] = stdin
  }
  return { kind: 'run', name: command.name, label, usage: commandLine(command), params, json }
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

const SCRIPT = `#!/bin/sh
# holi: ask the running Holi app something. Run it bare for every command.
# Generated by Holi. Talks to the app over 127.0.0.1 and holds no secret of
# yours: the port and the token come from the vault you are in.
#
# Nearly every command is reversible or read-only. Those that reach other
# people (sending mail, answering an invite) are asked about before they run,
# by a hook in the vault, not here. If this says Holi is not running, it is not running, or you are not inside one of
# its vaults.
set -eu

# The port and token are in .holi/state/bridge.local.env at the vault's root,
# found by walking up from here to the folder holding .holi/vault. Holi writes
# it when it opens the vault and deletes it when it leaves. Read key by key
# and checked, never sourced: a file in a synced folder is not code to run.
${shellReadBridgeEnv(['HOLI_BRIDGE_PORT', 'HOLI_BRIDGE_TOKEN']).join('\n')}

if [ -z "\$HOLI_BRIDGE_PORT" ] || [ -z "\$HOLI_BRIDGE_TOKEN" ]; then
  echo "holi: Holi is not running, or this is not inside one of its vaults." >&2
  exit 1
fi

out=\$(mktemp)
trap 'rm -f "\$out"' EXIT

# Every word rides in the body so curl encodes it: hand-rolling
# percent-encoding in POSIX sh is how a path with a space silently becomes a
# different path. The list \`for\` walks is fixed when it starts, so
# rebuilding "\$@" inside it is safe.
for a in "\$@"; do
  shift
  set -- "\$@" --data-urlencode "argv=\$a"
done

# Inside a background Claude Code session, its job id: a command that
# points back at the session (holi agent notify) needs no flag for it.
if [ -n "\${CLAUDE_JOB_DIR:-}" ]; then
  set -- "\$@" --data-urlencode "job=\${CLAUDE_JOB_DIR##*/}"
fi

send() {
  curl -sS -X POST -o "\$out" -w '%{http_code}' \\
    "http://127.0.0.1:\$HOLI_BRIDGE_PORT/cli?t=\$HOLI_BRIDGE_TOKEN" "\$@"
}

code=\$(send "\$@") || exit 1
if [ "\$code" = 428 ]; then
  # The command reads its body from stdin and none was given as an
  # argument. Holi ran nothing; send stdin, once.
  code=\$(send "\$@" --data-urlencode "stdin@-") || exit 1
fi

# The status decides where the answer goes: 200 to stdout, a refusal (422)
# to stderr and exit 1, a usage error (400) to stderr and exit 2. The body
# goes through a file so that nothing about it, a trailing newline included,
# is lost on the way.
case "\$code" in
  200) cat "\$out"; echo ;;
  400) cat "\$out" >&2; echo >&2; exit 2 ;;
  422) cat "\$out" >&2; echo >&2; exit 1 ;;
  *) echo "holi: Holi answered \$code" >&2; exit 1 ;;
esac
`

/**
 * Write the script and make it executable. Returns its absolute path, which
 * becomes `$HOLI_BIN` in the agent's env.
 *
 * Rewritten on every launch rather than written once: it is generated content,
 * so an app update must not leave an older copy in place.
 */
export async function installHoliCli(userDataDir: string): Promise<string> {
  const path = join(userDataDir, 'bin', 'holi')
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, SCRIPT, { mode: 0o755 })
  // `writeFile`'s mode is ignored when the file already exists.
  await chmod(path, 0o755)
  return path
}
