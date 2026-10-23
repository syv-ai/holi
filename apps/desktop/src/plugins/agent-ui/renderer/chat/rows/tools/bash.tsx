/**
 * Bash: the command, then what it printed. The split into stdout and stderr
 * exists only in the structured result; on failure the text is one flattened
 * string that starts "Exit code N", so the exit code is read from there.
 */
import { SquareTerminal } from 'lucide-react'
import type { ToolRenderer } from '../registry'
import {
  argsOf,
  dataOf,
  firstLine,
  firstStr,
  flag,
  get,
  isRec,
  num,
  textOf,
  unwrap,
} from './coerce'
import { CodeBlock, Stack } from './parts'
import { stateOf, verb, type CardView } from './view'

const NO_OUTPUT = '(Bash completed with no output)'

/** "Exit code 2\nrest" into the code and the rest. */
function splitExit(text: string): { code: number | null; rest: string } {
  const m = /^\s*Exit code (-?\d+)\n?/.exec(text)
  if (m === null) return { code: null, rest: text }
  return { code: Number(m[1]), rest: text.slice(m[0].length) }
}

function gitChip(git: unknown): string | undefined {
  if (!isRec(git)) return undefined
  const commit = get(git, 'commit')
  if (isRec(commit)) {
    const sha = firstStr(commit, ['sha'])
    return sha === undefined ? 'commit' : `commit ${sha.slice(0, 7)}`
  }
  const pr = get(git, 'pr')
  if (isRec(pr)) {
    const n = num(pr.number)
    return n === undefined ? 'pull request' : `PR #${n}`
  }
  const push = get(git, 'push')
  if (isRec(push)) {
    const branch = firstStr(push, ['branch'])
    return branch === undefined ? 'push' : `push ${branch}`
  }
  return undefined
}

export const bashRenderer: ToolRenderer = (item) => {
  const args = argsOf(item)
  const data = dataOf(item)
  const command = firstStr(args, ['command', 'cmd'])
  if (command === undefined && item.summary === '') return null
  const description = firstStr(args, ['description'])
  const state = stateOf(item)
  const background = flag(args.run_in_background)

  const raw = unwrap(textOf(item))
  const { code, rest } = splitExit(raw)
  const stdoutData = typeof data.stdout === 'string' ? data.stdout : undefined
  const stderrData = typeof data.stderr === 'string' ? data.stderr : undefined
  // Structured output when the result has it; else the one combined string.
  const out = (stdoutData ?? (state === 'rejected' ? '' : rest)).replace(/^\n+/, '')
  const stdout = out.trim() === NO_OUTPUT ? '' : out
  const stderr = stderrData !== undefined && stderrData.trim() !== '' ? stderrData : ''

  const chips: string[] = []
  if (state === 'error' && code !== null) chips.push(`exit ${code}`)
  else if (state === 'error') chips.push('failed')
  const interpretation = firstStr(data, ['returnCodeInterpretation'])
  if (interpretation !== undefined) chips.push(interpretation)
  if (background || firstStr(data, ['backgroundTaskId']) !== undefined) chips.push('background')
  if (flag(data.interrupted)) chips.push('interrupted')
  const git = gitChip(data.gitOperation)
  if (git !== undefined) chips.push(git)
  if (firstStr(data, ['persistedOutputPath']) !== undefined) chips.push('output saved to a file')

  const body = (
    <Stack>
      {command !== undefined && (
        <CodeBlock text={command} lines={20} chars={4000} label="Command" />
      )}
      {state !== 'rejected' && state !== 'pending' && stdout !== '' && (
        <CodeBlock
          text={stdout}
          lines={40}
          chars={4000}
          label="Output"
          tone={state === 'error' && stdoutData === undefined ? 'error' : 'default'}
        />
      )}
      {state !== 'rejected' && stderr !== '' && (
        <CodeBlock text={stderr} lines={20} chars={2000} label="Errors" tone="error" />
      )}
      {state === 'done' && stdout === '' && stderr === '' && (
        <p className="text-xs text-muted-foreground">No output.</p>
      )}
    </Stack>
  )

  const view: CardView = {
    label: background ? verb(item, 'Starting', 'Started') : verb(item, 'Running', 'Ran'),
    icon: SquareTerminal,
    summary: description ?? (command !== undefined ? firstLine(command) : item.summary),
    chips,
    body,
    defaultOpen: state === 'error',
  }
  return view
}
