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
 * change in git history). The two that reach another person, `holi google
 * send|reply`, are asked about by the agent's send gate, a hook that matches
 * the command line; `resolveArgv` refuses any word before the verb so that
 * match stays sound.
 *
 * No `electron` import: this loads under plain Node in the tests.
 */
import { chmod, mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { CliCommand } from '../capabilities/registry'
import { shellReadBridgeEnv } from './env-file'

/** What argv asks for. */
export type CliRequest =
  /** Run `name`; a refusal is printed after `label`. */
  | { kind: 'run'; name: string; label: string; params: Record<string, string>; json: boolean }
  /** Not a command: the text says why and what is (exit 2). */
  | { kind: 'usage'; text: string }
  /** The command reads a param from stdin and it was not given: ask the
   *  script for stdin, and run nothing yet. */
  | { kind: 'stdin' }

/** `--name`: a param's name, as a capability spells it. */
const OPTION_NAME = /^[a-zA-Z][a-zA-Z0-9_-]*$/

const argName = (arg: string): string => arg.replace(/\?$/, '')

/** One command's line: `holi store put <bundle> <collection> <value> [<id>]`. */
export function commandLine({ name, cli }: CliCommand): string {
  const words = [`holi ${name.replace('.', ' ')}`]
  for (const arg of cli.args) {
    words.push(arg.endsWith('?') ? `[<${argName(arg)}>]` : `<${arg}>`)
  }
  for (const flag of cli.flags ?? []) words.push(`[--${flag}]`)
  return words.join(' ')
}

/** Every command and its summary, for bare `holi`. */
export function usageText(commands: readonly CliCommand[]): string {
  return [
    'usage: holi <namespace> <verb> [arguments] [--json]',
    '',
    ...commands.flatMap((c) => [`  ${commandLine(c)}`, `      ${c.cli.summary}`]),
    '',
    'Any argument can also be given as --name value. --json prints the result as JSON.',
  ].join('\n')
}

/**
 * Read argv against the commands. The namespace and the verb come first, and
 * nothing may come before the verb: a gate that matches `holi <ns> <verb>`
 * stays sound only if no option can sit in front of it.
 *
 * `stdin` is what the script sent on its second leg, or null on the first.
 */
export function resolveArgv(
  argv: readonly string[],
  commands: readonly CliCommand[],
  stdin: string | null,
): CliRequest {
  const usage = (why: string): CliRequest => ({
    kind: 'usage',
    text: `${why}\n\n${usageText(commands)}`,
  })
  if (argv.length === 0) return { kind: 'usage', text: usageText(commands) }
  const [ns, verb] = argv
  if (ns === undefined || ns.startsWith('-') || verb === undefined || verb.startsWith('-')) {
    return usage('holi: say the command first: holi <namespace> <verb>')
  }
  const command = commands.find((c) => c.name === `${ns}.${verb}`)
  if (command === undefined) return usage(`holi: no such command: ${ns} ${verb}`)

  const label = `holi ${ns} ${verb}`
  const wrong = (why: string): CliRequest => ({
    kind: 'usage',
    text: `${label}: ${why}\nusage: ${commandLine(command)}`,
  })
  const { cli } = command
  const params: Record<string, string> = {}
  const positionals: string[] = []
  let json = false
  let options = true
  const rest = argv.slice(2)
  for (let i = 0; i < rest.length; i++) {
    const word = rest[i]!
    if (options && word === '--') {
      options = false
    } else if (options && word.startsWith('--')) {
      const eq = word.indexOf('=')
      const name = eq < 0 ? word.slice(2) : word.slice(2, eq)
      if (!OPTION_NAME.test(name)) return wrong(`not an option: ${word}`)
      if (Object.hasOwn(params, name)) return wrong(`--${name} is given twice`)
      if (eq < 0 && name === 'json') {
        json = true
      } else if (eq < 0 && cli.flags?.includes(name)) {
        params[name] = 'true'
      } else if (eq >= 0) {
        params[name] = word.slice(eq + 1)
      } else {
        const value = rest[++i]
        if (value === undefined) return wrong(`--${name} needs a value`)
        params[name] = value
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

  const bodyless = cli.stdinUnless !== undefined && Object.hasOwn(params, cli.stdinUnless)
  if (cli.stdin !== undefined && !bodyless && !Object.hasOwn(params, cli.stdin)) {
    if (stdin === null) return { kind: 'stdin' }
    params[cli.stdin] = stdin
  }
  return { kind: 'run', name: command.name, label, params, json }
}

const SCRIPT = `#!/bin/sh
# holi: ask the running Holi app something. Run it bare for every command.
# Generated by Holi. Talks to the app over 127.0.0.1 and holds no secret of
# yours: the port and the token come from the vault you are in.
#
# Nearly every command is reversible or read-only. The two that send mail
# are asked about before they run, by a hook in the vault, not here. If this
# says Holi is not running, it is not running, or you are not inside one of
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
