/**
 * A `holi` answer too long to print goes to a file, and the command prints
 * where it is and what is in it (`spillNotice`). The agent then reads only the part it needs
 * (jq, grep, Read with a range) instead of carrying a whole page of mail in its
 * context for the rest of the session.
 *
 * The files go to `.holi/state/out/` (`vault/out-files.ts`), which keeps the
 * newest few.
 *
 * No `electron` import: this loads under plain Node in the tests.
 */
import { writeOut } from '../vault/out-files'

/**
 * Past this many bytes an answer is spilled. About 4k tokens: enough for any
 * single record, a task list or an agenda week to print as it is, and well
 * under Claude Code's own cut of a command's output (30,000 characters), past
 * which the agent would see a truncated answer and not know what it lost.
 */
export const SPILL_BYTES = 16 * 1024

/** At most this many keys are named in a summary. */
const MAX_KEYS = 12

const kb = (bytes: number): string => `${(bytes / 1024).toFixed(1)} KB`

const keyList = (value: object): string => {
  const keys = Object.keys(value)
  const shown = keys.slice(0, MAX_KEYS).join(', ')
  return keys.length > MAX_KEYS ? `${shown} and ${keys.length - MAX_KEYS} more` : shown
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const NOT_JSON = Symbol('not JSON')

/** The output read as JSON, or `NOT_JSON`. */
function parsed(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return NOT_JSON
  }
}

/** What the output is, in a line: its JSON shape, or its length as text.
 *  `value` is the text `parsed`. */
function describe(text: string, value: unknown): string {
  if (value === NOT_JSON) return `${text.split('\n').length} lines of text`
  if (Array.isArray(value)) {
    const first = value[0]
    const each = isRecord(first) ? `, each with keys ${keyList(first)}` : ''
    return `a JSON array of ${value.length} items${each}`
  }
  if (isRecord(value)) {
    const counted = Object.entries(value)
      .filter(([, v]) => Array.isArray(v))
      .map(([k, v]) => `${k} has ${(v as unknown[]).length}`)
    const counts = counted.length > 0 ? ` (${counted.join(', ')})` : ''
    return `a JSON object with keys ${keyList(value)}${counts}`
  }
  return 'a JSON value'
}

/** Where an answer was spilled: its vault-relative path, its size in bytes
 *  and its shape in a line. */
export interface Spill {
  path: string
  bytes: number
  shape: string
}

/**
 * Write `text` to a new spill file under the vault at `root`. `label` is the
 * command (`holi google search`), which names the file.
 */
export async function spillOutput(root: string, label: string, text: string): Promise<Spill> {
  const value = parsed(text)
  const json = value !== NOT_JSON
  const command = label.replace(/^holi /, '').replace(/\s+/g, '-')
  return {
    path: await writeOut(root, text, { ext: json ? 'json' : 'txt', tag: command }),
    bytes: Buffer.byteLength(text),
    shape: describe(text, value),
  }
}

/**
 * What the command prints instead of a spilled answer. Asked for `--json`, it
 * stays JSON (`{"spilled", "bytes", "shape"}`), so `holi ... --json | jq` still
 * parses; otherwise it is the same in prose, with how to read the file.
 */
export function spillNotice(label: string, spill: Spill, json: boolean): string {
  if (json) return JSON.stringify({ spilled: spill.path, bytes: spill.bytes, shape: spill.shape })
  return [
    `${label}: ${kb(spill.bytes)}, too long to print, written to`,
    `  ${spill.path}`,
    `It is ${spill.shape}.`,
    'Read only the part you need from it (jq, grep, or Read with an offset and limit).',
  ].join('\n')
}
