/**
 * `holi plugin <id> <verb> …` (docs/features/community-plugins.md): the verbs
 * a running plugin gives Holi's own command. Main reads only the plugin and
 * the verb, and refuses before anything runs when either is not there; every
 * word after the verb is the plugin's own grammar, handed to its `cli.run` as
 * typed. The `holi` script then runs it in its own place (`CliRun`), so the
 * plugin's stdin, output and exit code are the caller's.
 *
 * Nothing may come before the verb: an ask or allow rule reads
 * `Bash(holi plugin <id> <verb>:*)`, which matches only while the verb is the
 * third word.
 *
 * No `electron` import: this loads under plain Node in the tests.
 */
import type { PluginCli } from '@holi/shared'
import { CapabilityError, type CliRun } from '../../../main/plugin-api'
import { expandCommand } from './setup'

/** A plugin that runs in the vault, with its verbs if it has any. */
export interface RunningPlugin {
  id: string
  name: string
  cli?: PluginCli
  /** The plugin's code on this machine, where its verbs run. */
  codeDir: string
}

export type VerbAnswer = { kind: 'text'; text: string } | { kind: 'run'; run: CliRun }

const HELP = new Set(['--help', '-h'])

const LISTED = 'holi plugin <id> <verb> [arguments]: a running community plugin, by its verbs.'
const FOOTER = 'Each verb reads its own arguments: holi plugin <id> <verb> --help.'

function block(plugin: RunningPlugin & { cli: PluginCli }): string[] {
  const lines = Object.entries(plugin.cli.verbs).map(([verb, summary]) => [
    `holi plugin ${plugin.id} ${verb}`,
    summary,
  ])
  const width = Math.max(...lines.map(([line]) => line!.length))
  return [
    `${plugin.id} (${plugin.name})`,
    ...lines.map(([line, summary]) => `  ${line!.padEnd(width)}  ${summary}`),
  ]
}

const hasVerbs = (p: RunningPlugin): p is RunningPlugin & { cli: PluginCli } => p.cli !== undefined

/** Read `argv`, the words after `holi plugin`, against the plugins that run
 *  in the vault at `root`. */
export function resolveVerb(
  argv: readonly string[],
  running: readonly RunningPlugin[],
  root: string,
): VerbAnswer {
  const [id, verb, ...rest] = argv
  if (id === undefined || HELP.has(id)) {
    const listed = running.filter(hasVerbs).sort((a, b) => a.id.localeCompare(b.id))
    const text =
      listed.length === 0
        ? 'No community plugin with verbs runs in this vault here.'
        : [LISTED, '', ...listed.flatMap((p) => [...block(p), '']), FOOTER].join('\n')
    return { kind: 'text', text }
  }
  if (id.startsWith('-'))
    throw new CapabilityError('BAD_REQUEST', `say the plugin first: holi plugin <id> <verb>`)
  const plugin = running.find((p) => p.id === id)
  if (plugin === undefined)
    throw new CapabilityError(
      'NOT_FOUND',
      `${id} does not run in this vault here`,
      'run holi plugin for the plugins that do, or turn it on in Settings → Plugins',
    )
  if (!hasVerbs(plugin))
    throw new CapabilityError(
      'NOT_FOUND',
      `${id} gives Holi no verbs`,
      'use the commands its skill names instead',
    )
  if (verb === undefined || HELP.has(verb))
    return { kind: 'text', text: [...block(plugin), '', FOOTER].join('\n') }
  if (verb.startsWith('-'))
    throw new CapabilityError(
      'BAD_REQUEST',
      `say the verb before any option: holi plugin ${id} <verb>`,
    )
  if (!Object.hasOwn(plugin.cli.verbs, verb))
    throw new CapabilityError(
      'NOT_FOUND',
      `${id} has no verb ${verb}`,
      `run holi plugin ${id} for its verbs`,
    )
  return {
    kind: 'run',
    run: {
      cwd: plugin.codeDir,
      argv: [...expandCommand(plugin.cli.run, { vault: root }), verb, ...rest],
      env: { HOLI_VAULT_ROOT: root },
    },
  }
}
