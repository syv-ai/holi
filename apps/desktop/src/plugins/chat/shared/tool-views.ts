/**
 * What a tool step can open into: the result of one tool call as the
 * transcript draws it (docs/features/chat.md, What the transcript draws).
 *
 * Built from the call's input, and refined by Claude Code's structured result
 * (`tool_use_result` on the `user` record) once the call is done: a command's
 * output and exit status, the lines a read returned, the paths a search found,
 * an edit's hunks with their line numbers. Everything is capped here, so a
 * transcript kept on disk stays small and the renderer stays dumb.
 *
 * The diff and the shapes are after MonoCode's tool previews
 * (`integrations/harness/core/preview.ts`, MIT, Copyright (c) 2026 Nick; see
 * NOTICE.md).
 *
 * Pure and browser-safe: no Node, no Electron, no React.
 */

export type DiffLineKind = 'add' | 'del' | 'ctx' | 'gap'

/** One line of a diff. `old` and `new` are line numbers, when known. */
export interface DiffLine {
  kind: DiffLineKind
  text: string
  old?: number
  new?: number
}

/** One file's change, as hunks of lines, `gap` between hunks. */
export interface FileDiff {
  path: string
  lines: DiffLine[]
  added: number
  removed: number
  /** The file is new: every line is an addition. */
  created?: boolean
  /** Lines kept out of the transcript past the cap. */
  omitted?: number
}

export interface PathMatch {
  path: string
  line?: number
  text?: string
}

export type ToolView =
  | {
      type: 'shell'
      command: string
      stdout?: string
      stderr?: string
      /** Absent while running; 0 once it succeeded. */
      exitCode?: number
      interrupted?: boolean
      /** Started in the background: its output comes later. */
      background?: boolean
      /** Characters kept out past the cap. */
      omitted?: number
    }
  | {
      type: 'read'
      path: string
      startLine: number
      lines: string[]
      totalLines?: number
      omitted?: number
    }
  | { type: 'paths'; pattern?: string; matches: PathMatch[]; total?: number; omitted?: number }
  | { type: 'diff'; files: FileDiff[] }
  | {
      type: 'web'
      url?: string
      query?: string
      /** "200 OK" */
      status?: string
      summary?: string
      links?: { title: string; url: string }[]
    }
  | { type: 'mcp'; server: string; tool: string; input?: string; result?: string }
  | {
      type: 'agent'
      agentType?: string
      prompt?: string
      result?: string
      toolCount?: number
      durationMs?: number
    }
  | { type: 'raw'; input?: string; output?: string }

/** Caps: what a step keeps of a result. */
export const CAP = {
  outputChars: 20_000,
  readLines: 400,
  lineChars: 400,
  diffLines: 400,
  paths: 200,
  jsonChars: 12_000,
  textChars: 8_000,
}

type JsonRecord = Record<string, unknown>

const rec = (value: unknown): JsonRecord | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as JsonRecord)
    : null

const text = (r: JsonRecord | null | undefined, ...keys: string[]): string | undefined => {
  for (const key of keys) {
    const v = r?.[key]
    if (typeof v === 'string') return v
  }
  return undefined
}

const int = (r: JsonRecord | null | undefined, key: string): number | undefined => {
  const v = r?.[key]
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined
}

/** A path as the person knows it: relative to the vault when inside it. */
export function vaultPath(root: string, path: string): string {
  if (root === '') return path
  const prefix = root.endsWith('/') ? root : `${root}/`
  return path.startsWith(prefix) ? path.slice(prefix.length) : path
}

function capText(value: string, max: number): { text: string; omitted?: number } {
  if (value.length <= max) return { text: value }
  return { text: value.slice(0, max), omitted: value.length - max }
}

const capLine = (line: string): string =>
  line.length > CAP.lineChars ? `${line.slice(0, CAP.lineChars - 1)}…` : line

function splitLines(value: string): string[] {
  if (value === '') return []
  const lines = value.replace(/\r\n/g, '\n').split('\n')
  if (lines.at(-1) === '') lines.pop()
  return lines
}

/** Pretty JSON when it parses, else the text as it is. */
export function prettyJson(value: unknown, max = CAP.jsonChars): string {
  let out: string
  if (typeof value === 'string') {
    try {
      out = JSON.stringify(JSON.parse(value), null, 2)
    } catch {
      out = value
    }
  } else {
    try {
      out = JSON.stringify(value, null, 2) ?? ''
    } catch {
      out = String(value)
    }
  }
  const capped = capText(out, max)
  return capped.omitted === undefined ? capped.text : `${capped.text}\n…`
}

// ------------------------------------------------------------------ diffs

/**
 * Lines of `before` and `after` as a diff: a longest common subsequence, so
 * a moved line reads as removed and added. Past a size where that is too dear
 * it is every old line removed, then every new one added.
 */
export function diffLines(before: string, after: string, startOld = 1, startNew = 1): DiffLine[] {
  const a = splitLines(before)
  const b = splitLines(after)
  const out: DiffLine[] = []
  if (a.length * b.length > 250_000) {
    a.forEach((t, i) => out.push({ kind: 'del', text: t, old: startOld + i }))
    b.forEach((t, j) => out.push({ kind: 'add', text: t, new: startNew + j }))
    return out
  }
  // lcs[i][j]: the common run of a[i..] and b[j..].
  const lcs: Uint32Array[] = Array.from(
    { length: a.length + 1 },
    () => new Uint32Array(b.length + 1),
  )
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i]![j] =
        a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!)
    }
  }
  let i = 0
  let j = 0
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      out.push({ kind: 'ctx', text: a[i]!, old: startOld + i, new: startNew + j })
      i++
      j++
    } else if (j < b.length && (i === a.length || lcs[i]![j + 1]! > lcs[i + 1]![j]!)) {
      out.push({ kind: 'add', text: b[j]!, new: startNew + j })
      j++
    } else {
      out.push({ kind: 'del', text: a[i]!, old: startOld + i })
      i++
    }
  }
  return out
}

/** Claude Code's `structuredPatch`: hunks of `" ctx"`, `"-old"`, `"+new"`. */
function fromPatch(patch: unknown): DiffLine[] | null {
  if (!Array.isArray(patch) || patch.length === 0) return null
  const out: DiffLine[] = []
  for (const raw of patch) {
    const hunk = rec(raw)
    const lines = Array.isArray(hunk?.['lines']) ? (hunk['lines'] as unknown[]) : null
    if (hunk === null || lines === null) return null
    let old = int(hunk, 'oldStart') ?? 1
    let neu = int(hunk, 'newStart') ?? 1
    if (out.length > 0) out.push({ kind: 'gap', text: '' })
    for (const l of lines) {
      if (typeof l !== 'string') continue
      const body = l.slice(1)
      if (l.startsWith('+')) out.push({ kind: 'add', text: body, new: neu++ })
      else if (l.startsWith('-')) out.push({ kind: 'del', text: body, old: old++ })
      else if (l.startsWith('\\')) continue
      else out.push({ kind: 'ctx', text: body, old: old++, new: neu++ })
    }
  }
  return out
}

/** A diff's lines with the unchanged run around each change cut to `margin`. */
function trimContext(lines: DiffLine[], margin = 3): DiffLine[] {
  const keep = new Array<boolean>(lines.length).fill(false)
  lines.forEach((l, i) => {
    if (l.kind === 'add' || l.kind === 'del' || l.kind === 'gap') {
      for (let k = Math.max(0, i - margin); k <= Math.min(lines.length - 1, i + margin); k++) {
        keep[k] = true
      }
    }
  })
  const out: DiffLine[] = []
  let skipped = false
  lines.forEach((l, i) => {
    if (keep[i]) {
      if (skipped && out.length > 0 && out.at(-1)!.kind !== 'gap' && l.kind !== 'gap') {
        out.push({ kind: 'gap', text: '' })
      }
      skipped = false
      out.push(l)
    } else skipped = true
  })
  return out
}

function fileDiff(path: string, lines: DiffLine[], created = false): FileDiff {
  const trimmed = created ? lines : trimContext(lines)
  const added = lines.filter((l) => l.kind === 'add').length
  const removed = lines.filter((l) => l.kind === 'del').length
  const kept = trimmed.slice(0, CAP.diffLines).map((l) => ({ ...l, text: capLine(l.text) }))
  return {
    path,
    lines: kept,
    added,
    removed,
    ...(created ? { created: true } : {}),
    ...(trimmed.length > kept.length ? { omitted: trimmed.length - kept.length } : {}),
  }
}

/** An excerpt diff from a replacement: its lines are not numbered from the file's top. */
const unnumbered = (lines: DiffLine[]): DiffLine[] =>
  lines.map(({ kind, text }) => ({ kind, text }))

function editDiff(
  name: string,
  input: JsonRecord,
  root: string,
  result: JsonRecord | null,
): FileDiff | null {
  const rawPath = text(input, 'file_path', 'notebook_path', 'path') ?? text(result, 'filePath')
  if (rawPath === undefined) return null
  const path = vaultPath(root, rawPath)
  const patched = fromPatch(result?.['structuredPatch'])
  if (patched !== null) return fileDiff(path, patched)
  if (name === 'write') {
    const content = text(input, 'content') ?? text(result, 'content') ?? ''
    const original = result === null ? undefined : result['originalFile']
    if (typeof original === 'string' && original !== '') {
      return fileDiff(path, diffLines(original, content))
    }
    // A new file, or one whose old text Claude Code did not send: every line added.
    return fileDiff(path, diffLines('', content), true)
  }
  if (name === 'notebookedit') {
    const after = text(input, 'new_source') ?? text(result, 'new_source') ?? ''
    const before = text(result, 'old_source', 'original_source') ?? ''
    return fileDiff(path, unnumbered(diffLines(before, after)), before === '')
  }
  if (name === 'multiedit') {
    const edits = Array.isArray(input['edits']) ? (input['edits'] as unknown[]) : []
    const lines: DiffLine[] = []
    for (const raw of edits) {
      const e = rec(raw)
      const before = text(e, 'old_string')
      const after = text(e, 'new_string')
      if (before === undefined || after === undefined) continue
      if (lines.length > 0) lines.push({ kind: 'gap', text: '' })
      lines.push(...unnumbered(diffLines(before, after)))
    }
    return lines.length === 0 ? null : fileDiff(path, lines)
  }
  const before = text(input, 'old_string') ?? text(result, 'oldString')
  const after = text(input, 'new_string') ?? text(result, 'newString')
  if (before === undefined || after === undefined) return null
  return fileDiff(path, unnumbered(diffLines(before, after)))
}

// ------------------------------------------------------------- the views

/** The text of a tool result's content, a string or a list of blocks. */
export function resultText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((block) => {
      const r = rec(block)
      return text(r, 'type') === 'text' ? (text(r, 'text') ?? '') : ''
    })
    .join('')
}

/** "Exit code 2\n…": a failed command's status, as Claude Code words it. */
function exitCodeOf(output: string | undefined): number | undefined {
  const m = /^(?:Error: )?Exit code (\d+)/.exec(output ?? '')
  return m === null ? undefined : Number(m[1])
}

function shellView(
  input: JsonRecord,
  result: JsonRecord | null,
  output: string | undefined,
  done: boolean,
  ok: boolean,
): ToolView {
  const command = text(input, 'command') ?? ''
  let stdout = text(result, 'stdout')
  let stderr = text(result, 'stderr')
  let exitCode: number | undefined
  if (done) {
    exitCode = ok ? 0 : (exitCodeOf(output) ?? 1)
    if (stdout === undefined && stderr === undefined && output !== undefined) {
      // A failure arrives as text only: its first line is the status.
      const body = ok ? output : output.replace(/^(?:Error: )?Exit code \d+\n?/, '')
      if (ok) stdout = body
      else stderr = body
    }
  }
  const out = capText(stdout ?? '', CAP.outputChars)
  const err = capText(stderr ?? '', CAP.outputChars)
  const omitted = (out.omitted ?? 0) + (err.omitted ?? 0)
  const background =
    text(result, 'backgroundTaskId') !== undefined || input['run_in_background'] === true
  return {
    type: 'shell',
    command,
    ...(out.text === '' ? {} : { stdout: out.text }),
    ...(err.text === '' ? {} : { stderr: err.text }),
    ...(exitCode === undefined ? {} : { exitCode }),
    ...(result?.['interrupted'] === true ? { interrupted: true } : {}),
    ...(background ? { background: true } : {}),
    ...(omitted > 0 ? { omitted } : {}),
  }
}

function readView(
  input: JsonRecord,
  root: string,
  result: JsonRecord | null,
  output: string | undefined,
): ToolView | undefined {
  const rawPath = text(input, 'file_path', 'path')
  // An image or a PDF read has no lines to show.
  if (rawPath === undefined || text(result, 'type') === 'image' || text(result, 'type') === 'pdf') {
    return undefined
  }
  const path = vaultPath(root, rawPath)
  const file = rec(result?.['file'])
  let lines: string[] = []
  let startLine = int(file, 'startLine') ?? int(input, 'offset') ?? 1
  const content = text(file, 'content')
  if (content !== undefined) lines = splitLines(content)
  else if (output !== undefined) {
    // `cat -n` as Claude Code prints it: "  12\tline", or "12→line".
    const numbered = splitLines(output).map((l) => /^\s*(\d+)(?:\t|→)(.*)$/.exec(l))
    if (numbered.length > 0 && numbered.every((m) => m !== null)) {
      startLine = Number(numbered[0]![1])
      lines = numbered.map((m) => m![2]!)
    }
  }
  const kept = lines.slice(0, CAP.readLines).map(capLine)
  const totalLines = int(file, 'totalLines')
  return {
    type: 'read',
    path,
    startLine,
    lines: kept,
    ...(totalLines === undefined ? {} : { totalLines }),
    ...(lines.length > kept.length ? { omitted: lines.length - kept.length } : {}),
  }
}

/** "path:12:text" lines of a content search, or bare paths. */
function matchesOf(root: string, lines: string[]): PathMatch[] {
  return lines
    .filter((l) => l.trim() !== '')
    .map((l) => {
      const m = /^(.+?):(\d+):(.*)$/.exec(l)
      if (m !== null)
        return { path: vaultPath(root, m[1]!), line: Number(m[2]), text: capLine(m[3]!) }
      return { path: vaultPath(root, l.trim()) }
    })
}

function pathsView(
  input: JsonRecord,
  root: string,
  result: JsonRecord | null,
  output: string | undefined,
): ToolView | undefined {
  const pattern = text(input, 'pattern')
  const names = Array.isArray(result?.['filenames'])
    ? (result['filenames'] as unknown[]).filter((f): f is string => typeof f === 'string')
    : null
  let matches: PathMatch[]
  if (text(result, 'content') !== undefined)
    matches = matchesOf(root, splitLines(text(result, 'content')!))
  else if (names !== null) matches = names.map((f) => ({ path: vaultPath(root, f) }))
  else if (output !== undefined && !/^No (files|matches) found/i.test(output.trim())) {
    matches = matchesOf(
      root,
      splitLines(output).filter((l) => !/^Found \d+ (files?|lines?)/.test(l)),
    )
  } else matches = []
  const kept = matches.slice(0, CAP.paths)
  const total = int(result, 'numFiles') ?? int(result, 'numLines')
  return {
    type: 'paths',
    ...(pattern === undefined ? {} : { pattern }),
    matches: kept,
    ...(total === undefined ? {} : { total }),
    ...(matches.length > kept.length ? { omitted: matches.length - kept.length } : {}),
  }
}

function webView(
  name: string,
  input: JsonRecord,
  result: JsonRecord | null,
  output: string | undefined,
): ToolView {
  const links: { title: string; url: string }[] = []
  if (Array.isArray(result?.['results'])) {
    for (const entry of result['results'] as unknown[]) {
      const content = rec(entry)?.['content']
      if (!Array.isArray(content)) continue
      for (const hit of content) {
        const h = rec(hit)
        const url = text(h, 'url')
        if (url !== undefined) links.push({ title: text(h, 'title') ?? url, url })
      }
    }
  }
  const code = int(result, 'code')
  const status = code === undefined ? undefined : `${code} ${text(result, 'codeText') ?? ''}`.trim()
  const summarySource =
    text(result, 'result') ??
    (Array.isArray(result?.['results'])
      ? (result['results'] as unknown[])
          .filter((r): r is string => typeof r === 'string')
          .join('\n\n')
      : undefined) ??
    output
  const summary =
    summarySource === undefined ? undefined : capText(summarySource.trim(), CAP.textChars).text
  const url = text(input, 'url') ?? text(result, 'url')
  const query = name === 'websearch' ? (text(input, 'query') ?? text(result, 'query')) : undefined
  return {
    type: 'web',
    ...(url === undefined ? {} : { url }),
    ...(query === undefined ? {} : { query }),
    ...(status === undefined ? {} : { status }),
    ...(summary === undefined || summary === '' ? {} : { summary }),
    ...(links.length === 0 ? {} : { links: links.slice(0, 20) }),
  }
}

/** `mcp__server__tool` in its parts; null for a tool that is not MCP's. */
export function mcpName(name: string): { server: string; tool: string } | null {
  const m = /^mcp__(.+?)__(.+)$/.exec(name)
  return m === null ? null : { server: m[1]!, tool: m[2]! }
}

function agentView(
  input: JsonRecord,
  result: JsonRecord | null,
  output: string | undefined,
): ToolView {
  const agentType = text(input, 'subagent_type')
  const prompt = text(input, 'prompt')
  const content = result === null ? undefined : resultText(result['content'])
  const answer = content !== undefined && content !== '' ? content : output
  const toolCount = int(result, 'totalToolUseCount')
  const durationMs = int(result, 'totalDurationMs')
  return {
    type: 'agent',
    ...(agentType === undefined ? {} : { agentType }),
    ...(prompt === undefined ? {} : { prompt: capText(prompt, CAP.textChars).text }),
    ...(answer === undefined || answer.trim() === ''
      ? {}
      : { result: capText(answer.trim(), CAP.textChars).text }),
    ...(toolCount === undefined ? {} : { toolCount }),
    ...(durationMs === undefined ? {} : { durationMs }),
  }
}

/** A raw input, as JSON a person can read, without the bulk of a file's text. */
function rawInput(input: JsonRecord): string | undefined {
  if (Object.keys(input).length === 0) return undefined
  return prettyJson(input, CAP.textChars)
}

export interface ToolResultIn {
  ok: boolean
  /** The result's text, as the model read it. */
  output?: string
  /** Claude Code's structured result (`tool_use_result`), when it sent one. */
  result?: unknown
}

/**
 * The view of one tool call: from its input while it runs (or waits on the
 * person), and from its result once `done` is given.
 */
export function toolView(
  name: string,
  input: JsonRecord,
  root = '',
  done?: ToolResultIn,
): ToolView | undefined {
  const lower = name.toLowerCase()
  const result = rec(done?.result)
  const output = done?.output
  switch (lower) {
    case 'bash':
      return shellView(input, result, output, done !== undefined, done?.ok ?? true)
    case 'read':
    case 'notebookread':
      if (done === undefined || !done.ok) return undefined
      return readView(input, root, result, output)
    case 'glob':
    case 'grep':
    case 'ls':
      if (done === undefined) return undefined
      return pathsView(input, root, result, output)
    case 'edit':
    case 'multiedit':
    case 'write':
    case 'notebookedit': {
      const diff = editDiff(lower, input, root, done?.ok === false ? null : result)
      return diff === null ? undefined : { type: 'diff', files: [diff] }
    }
    case 'webfetch':
    case 'websearch':
      return webView(lower, input, result, output)
    case 'task':
    case 'agent':
      return agentView(input, result, output)
    default: {
      const mcp = mcpName(name)
      const shown = rawInput(input)
      if (mcp !== null) {
        const raw = done?.result
        const body =
          output !== undefined && output !== ''
            ? output
            : raw === undefined
              ? undefined
              : Array.isArray(raw)
                ? resultText(raw)
                : raw
        return {
          type: 'mcp',
          server: mcp.server,
          tool: mcp.tool,
          ...(shown === undefined ? {} : { input: shown }),
          ...(body === undefined || body === '' ? {} : { result: prettyJson(body) }),
        }
      }
      const out =
        output === undefined || output.trim() === ''
          ? undefined
          : capText(output.trim(), CAP.textChars).text
      if (shown === undefined && out === undefined) return undefined
      return {
        type: 'raw',
        ...(shown === undefined ? {} : { input: shown }),
        ...(out === undefined ? {} : { output: out }),
      }
    }
  }
}
