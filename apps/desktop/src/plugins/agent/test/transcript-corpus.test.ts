/**
 * The transcript drift net, in tests (docs/features/agent-sessions.md, The
 * chat, "Drift"). Claude Code's transcript is private and changes with every
 * release, so the reader is checked against a corpus: scrubbed fixtures of
 * every line shape seen in real sessions (`fixtures/transcripts/`, made by
 * `pnpm chat:fixtures`, read its README), replayed line by line.
 *
 * - Every fixture line classifies: no throw, nothing unknown, every hidden
 *   line names a reason, ids are stable and unique.
 * - A summary of entry kinds per line shape is a committed snapshot: a
 *   classifier change shows as a diff of what the chat draws.
 * - A canary of invented shapes proves the opposite direction: what the reader
 *   does not know is counted and shown, never dropped, never thrown.
 * - The fixtures are audited for private content on every run.
 * - Opt in with HOLI_CHAT_CORPUS=<dir of real transcripts> to replay your own
 *   sessions locally (`pnpm chat:drift` does the same with a report).
 */
import { createReadStream, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createInterface } from 'node:readline'
import { describe, expect, it } from 'vitest'
import {
  classifyLine,
  readTranscript,
  resetToldShapes,
  setTranscriptLogger,
  shapeKey,
  type ChatEntry,
  type LineResult,
} from '../main/claude/transcript'
import { summarise } from '../../../../scripts/chat-drift'
import { McpNames, scrubLine, scrubText } from '../../../../scripts/scrub-transcript'

const DIR = fileURLToPath(new URL('./fixtures/transcripts/', import.meta.url))
const CANARY = 'canary.jsonl'

const fixtureFiles = (): string[] =>
  readdirSync(DIR)
    .filter((f) => f.endsWith('.jsonl'))
    .sort()
const corpusFiles = (): string[] => fixtureFiles().filter((f) => f !== CANARY)
const isSidechainFile = (file: string): boolean => file === 'subagent.jsonl'

function rawLines(file: string): string[] {
  return readFileSync(join(DIR, file), 'utf8')
    .split('\n')
    .filter((l) => l !== '')
}

/** Every line of a file, classified the way the reader does (with its place). */
function replay(file: string): { raw: string; result: LineResult }[] {
  let at = 0
  return rawLines(file).map((raw) => {
    const result = classifyLine(raw, { at, sidechain: isSidechainFile(file) })
    at += Buffer.byteLength(raw) + 1
    return { raw, result }
  })
}

describe('transcript fixtures: shape of the corpus', () => {
  it('has one file per area, small enough to commit', () => {
    expect(fixtureFiles()).toEqual([
      'attachments.jsonl',
      'canary.jsonl',
      'compaction.jsonl',
      'messages.jsonl',
      'metadata.jsonl',
      'subagent.jsonl',
      'system.jsonl',
      'tools.jsonl',
      'wrappers.jsonl',
    ])
    const bytes = fixtureFiles().reduce((n, f) => n + statSync(join(DIR, f)).size, 0)
    expect(bytes).toBeLessThan(450 * 1024)
    expect(bytes).toBeGreaterThan(20 * 1024)
  })

  it('is JSON object lines, one conversation id, ending in a newline', () => {
    for (const file of fixtureFiles()) {
      const text = readFileSync(join(DIR, file), 'utf8')
      expect(text.endsWith('\n'), file).toBe(true)
      for (const line of rawLines(file)) {
        const row: unknown = JSON.parse(line)
        expect(row !== null && typeof row === 'object' && !Array.isArray(row), file).toBe(true)
      }
    }
  })
})

// ---- the audit -------------------------------------------------------------

/** The author's own names, lower case, as substrings of anything. */
const DENYLIST = ['nmeineche', 'meineche', 'nikolaj', 'syv', 'holi']

const PATTERNS: { rule: string; test: RegExp }[] = [
  { rule: 'email address', test: /[\w.+-]+@[\w-]+(\.[\w-]+)+/ },
  { rule: 'home path', test: /(\/Users\/|\/home\/|[A-Za-z]:\\Users\\)/ },
  { rule: 'openai-style key', test: /\bsk-[A-Za-z0-9_-]{6,}/ },
  { rule: 'github token', test: /\b(ghp_|gho_|ghs_|github_pat_)[A-Za-z0-9_]{6,}/ },
  { rule: 'bearer token', test: /\bBearer\s+\S+/ },
  { rule: 'aws or slack key', test: /\b(AKIA[0-9A-Z]{12,}|xox[abprs]-[A-Za-z0-9-]{6,})/ },
  { rule: 'private key block', test: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { rule: 'long base64 run', test: /[A-Za-z0-9+/]{128,}={0,2}/ },
  { rule: 'url off example.test', test: /\bhttps?:\/\/(?!example\.test)/i },
]

function* strings(value: unknown): Generator<string> {
  if (typeof value === 'string') yield value
  else if (Array.isArray(value)) for (const x of value) yield* strings(x)
  else if (value !== null && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      yield k
      yield* strings(v)
    }
  }
}

/** The audit's findings: where and which rule, never the matched text (a failing
 *  run prints into logs that outlive the fixture). */
function audit(file: string, line: string, lineNo: number): string[] {
  const found: string[] = []
  for (const s of strings(JSON.parse(line))) {
    const lower = s.toLowerCase()
    for (const word of DENYLIST) {
      if (lower.includes(word))
        found.push(`${file}:${lineNo} contains a denied name (#${DENYLIST.indexOf(word)})`)
    }
    for (const { rule, test } of PATTERNS) {
      if (test.test(s)) found.push(`${file}:${lineNo} ${rule}`)
    }
  }
  return found
}

describe('transcript fixtures: privacy audit', () => {
  it('holds no address, home path, token, base64 run or private name', () => {
    const findings: string[] = []
    for (const file of fixtureFiles()) {
      rawLines(file).forEach((line, i) => findings.push(...audit(file, line, i + 1)))
    }
    expect(findings).toEqual([])
  })

  it('the audit itself catches what it is for', () => {
    const bad = JSON.stringify({
      a: 'mail jane@example.org',
      b: '/Users/jane/x',
      c: 'sk-abcdef123456',
      d: 'Bearer abc.def',
      e: 'A'.repeat(200),
      f: 'ghp_abcdef123456',
      g: 'xHOLIx',
      h: 'https://acme.example.com/x',
    })
    expect(audit('t', bad, 1)).toHaveLength(8)
  })
})

describe('scrub-transcript: what survives', () => {
  const scrub = (row: unknown, mcp = new McpNames()): string =>
    scrubLine(JSON.stringify(row), {}, mcp) ?? ''

  it('keeps structure and drops every word, path, address and token', () => {
    const out = scrub({
      type: 'user',
      uuid: '11111111-2222-4333-8444-555555555555',
      parentUuid: null,
      timestamp: '2026-03-04T05:06:07.123Z',
      cwd: '/Users/jane.doe/secret-project',
      sessionId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
      origin: { kind: 'human' },
      message: {
        role: 'user',
        content:
          'Mail jane.doe@acme-corp.com about https://acme.internal/api?token=sk-abc123456789 using Bearer abcdef0123456789 and /home/jane/.ssh/id_rsa',
      },
    })
    for (const leak of ['jane', 'acme', '@', 'sk-', 'Bearer', 'Users', 'secret', 'ssh', '2026']) {
      expect(out, leak).not.toContain(leak)
    }
    const row = JSON.parse(out) as Record<string, any>
    expect(row.type).toBe('user')
    expect(row.parentUuid).toBeNull()
    expect(row.origin).toEqual({ kind: 'human' })
    expect(row.message.role).toBe('user')
    expect(row.timestamp.startsWith('2030-01-01')).toBe(true)
    expect(row.uuid).toMatch(/^[0-9a-f-]{36}$/)
    expect(row.uuid).not.toBe('11111111-2222-4333-8444-555555555555')
  })

  it('maps one id to one id, so links stay valid, and the same on every run', () => {
    const call = {
      type: 'assistant',
      uuid: 'a1111111-2222-4333-8444-555555555555',
      message: {
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: 'toolu_01AbCdEfGhIjKlMnOpQrStUv',
            name: 'mcp__acme-prod__delete_everything',
            input: { customerEmail: 'x@y.zz', id: 'secret' },
          },
        ],
      },
    }
    const result = {
      type: 'user',
      uuid: 'b1111111-2222-4333-8444-555555555555',
      parentUuid: call.uuid,
      toolUseResult: { rows: [{ ssn: '123-45-6789' }] },
      message: {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'toolu_01AbCdEfGhIjKlMnOpQrStUv', content: 'ok' },
        ],
      },
    }
    const mcp = new McpNames()
    const a = JSON.parse(scrub(call, mcp)) as Record<string, any>
    const b = JSON.parse(scrub(result, mcp)) as Record<string, any>
    expect(a.message.content[0].name).toBe('mcp__server1__tool1')
    expect(b.message.content[0].tool_use_id).toBe(a.message.content[0].id)
    expect(b.parentUuid).toBe(a.uuid)
    expect(a.message.content[0].id).toMatch(/^toolu_[A-Za-z0-9]{24}$/)
    expect(scrub(call, new McpNames())).toBe(scrub(call, new McpNames()))
    for (const text of [JSON.stringify(a), JSON.stringify(b)]) {
      expect(text).not.toMatch(/acme|customerEmail|ssn|123-45|secret|delete/)
    }
  })

  it('keeps the wrappers the reader depends on, with their inner text scrubbed', () => {
    const text = scrubText(
      '<command-name>/compact</command-name>\n<command-args>secret plan</command-args>' +
        '<local-command-stdout>Compacted 12 messages about Acme</local-command-stdout>' +
        '<task-notification><status>completed</status><summary>Acme report</summary></task-notification>' +
        '<system-reminder>private reminder</system-reminder>',
      400,
    )
    expect(text).toContain('<command-name>/compact</command-name>')
    expect(text).toContain('<command-args>')
    expect(text).toContain('<local-command-stdout>')
    expect(text).toContain('<status>completed</status>')
    expect(text).toContain('</system-reminder>')
    expect(text).not.toMatch(/secret|Acme|report|private/)
  })

  it('keeps the words Claude Code writes itself, and only those', () => {
    expect(scrubText('[Request interrupted by user]', 400)).toBe('[Request interrupted by user]')
    expect(scrubText('[Request interrupted by user for tool use]', 400)).toBe(
      '[Request interrupted by user for tool use]',
    )
    expect(scrubText('(Bash completed with no output)', 400)).toBe(
      '(Bash completed with no output)',
    )
    expect(scrubText('please deploy the thing', 400)).toBe('xxxxxx xxxxxx xxx xxxxx')
  })

  it('keeps a wrapper closed when its text is cut short', () => {
    const text = scrubText(`<system-reminder>${'word '.repeat(500)}</system-reminder>`, 80)
    expect(text.startsWith('<system-reminder>')).toBe(true)
    expect(text.endsWith('</system-reminder>')).toBe(true)
    expect(text.length).toBeLessThan(140)
  })

  it('replaces image bytes with a tiny valid base64 and keeps the media type', () => {
    const out = JSON.parse(
      scrub({
        type: 'user',
        message: {
          role: 'user',
          content: [
            {
              type: 'image',
              source: { type: 'base64', media_type: 'image/jpeg', data: 'QUJD'.repeat(500) },
            },
          ],
        },
      }),
    ) as Record<string, any>
    const source = out.message.content[0].source
    expect(source.media_type).toBe('image/jpeg')
    expect(source.data.length).toBeLessThan(120)
    expect(Buffer.from(source.data, 'base64').length).toBeGreaterThan(0)
  })

  it('clips long arrays and keeps JSON types', () => {
    const out = JSON.parse(
      scrub({ type: 'x', list: [1, 2, 3, 4, 5, 6], flag: true, n: 1.5, none: null, s: '' }),
    ) as Record<string, unknown>
    expect(out['list']).toEqual([1, 2, 3])
    expect(out['flag']).toBe(true)
    expect(out['n']).toBe(1.5)
    expect(out['none']).toBeNull()
    expect(out['s']).toBe('')
  })
})

// ---- the replay ------------------------------------------------------------

/** An entry's kind, with the one fact about it that a rule decides. */
function describe_(entry: ChatEntry): string {
  if (entry.kind === 'tool') return `tool(${entry.name.startsWith('mcp__') ? 'mcp' : entry.name})`
  if (entry.kind === 'tool-result') return entry.ok ? 'tool-result' : 'tool-result(failed)'
  if (entry.kind === 'notice') return `notice(${entry.source})`
  return entry.kind
}

describe.each(corpusFiles())('transcript corpus: %s', (file) => {
  const lines = replay(file)

  it('classifies every line without throwing or an unknown', () => {
    expect(lines.length).toBeGreaterThan(0)
    const unknown = lines.flatMap(({ result }, i) =>
      result.disposition.kind === 'unknown' ? [`${file}:${i + 1} ${result.disposition.shape}`] : [],
    )
    expect(unknown).toEqual([])
  })

  it('gives every hidden line a reason and every rendered line an entry', () => {
    lines.forEach(({ result }, i) => {
      const d = result.disposition
      if (d.kind === 'hidden') {
        expect(d.reason, `${file}:${i + 1}`).toMatch(
          /^(metadata|model-facing|debug-copy|machinery|empty|sidechain|duplicate)$/,
        )
        expect(result.entries, `${file}:${i + 1}`).toEqual([])
      }
      if (d.kind === 'rendered')
        expect(result.entries.length, `${file}:${i + 1}`).toBeGreaterThan(0)
    })
  })

  it('classifies every distinct shape key at least once', () => {
    const classified = new Map<string, number>()
    for (const { raw, result } of lines) {
      const key = shapeKey(JSON.parse(raw))
      classified.set(
        key,
        (classified.get(key) ?? 0) + (result.disposition.kind === 'unknown' ? 0 : 1),
      )
    }
    const missing = [...classified].filter(([, n]) => n === 0).map(([key]) => key)
    expect(missing).toEqual([])
    expect(classified.size).toBeGreaterThan(0)
  })

  it('numbers its entries uniquely: a tool call is one id, its result another kind', () => {
    const seen = new Set<string>()
    const duplicates: string[] = []
    for (const { result } of lines) {
      for (const entry of result.entries) {
        const key = `${entry.kind}:${entry.id}`
        if (seen.has(key)) duplicates.push(key)
        seen.add(key)
      }
    }
    expect(duplicates).toEqual([])
  })

  it('reads the same through readTranscript, from the start, to the end', async () => {
    const path = join(DIR, file)
    const size = statSync(path).size
    resetToldShapes()
    const chunk = await readTranscript(path, 'fixture', undefined, {
      sidechain: isSidechainFile(file),
      firstReadBytes: size + 1024,
    })
    expect(chunk.start).toBe(0)
    expect(chunk.offset).toBe(size)
    expect(chunk.drift?.unknown ?? []).toEqual([])
    expect(chunk.drift?.oversize ?? 0).toBe(0)
    expect(chunk.drift?.unparseable ?? 0).toBe(0)
    expect(chunk.drift?.lines).toBe(lines.length)
    expect(chunk.entries.map((e) => `${e.kind}:${e.id}`)).toEqual(
      lines.flatMap(({ result }) => result.entries.map((e) => `${e.kind}:${e.id}`)),
    )
  })

  it('what the chat draws, by line shape (a classifier change shows here)', () => {
    const summary = new Set<string>()
    for (const { raw, result } of lines) {
      const row = JSON.parse(raw) as Record<string, unknown>
      const d = result.disposition
      const drawn =
        d.kind === 'rendered'
          ? `rendered ${[...new Set(result.entries.map(describe_))].sort().join('+')}`
          : d.kind === 'hidden'
            ? `hidden ${d.reason}`
            : `unknown ${d.shape}`
      const flags = ['isMeta', 'isSidechain', 'isCompactSummary', 'isApiErrorMessage']
        .filter((f) => row[f] === true)
        .join(',')
      summary.add(`${shapeKey(row)}${flags === '' ? '' : ` [${flags}]`} -> ${drawn}`)
    }
    expect([...summary].sort()).toMatchSnapshot()
  })
})

// ---- the canary ------------------------------------------------------------

describe('transcript canary: shapes Claude Code has not made yet', () => {
  const lines = replay(CANARY)

  it('is five invented shapes', () => {
    expect(lines).toHaveLength(5)
  })

  it('counts every one as unknown, never throws, never drops silently', () => {
    for (const [i, { result }] of lines.entries()) {
      expect(result.disposition.kind, `canary line ${i + 1}`).toBe('unknown')
      if (result.disposition.kind === 'unknown') {
        expect(result.disposition.shape.length).toBeGreaterThan(0)
        expect(result.disposition.shape).not.toBe('internal-error')
      }
    }
  })

  it('shows an invented content block as an unknown entry, beside the text it came with', () => {
    const assistant = lines[2]?.result
    expect(assistant?.entries.map((e) => e.kind)).toContain('unknown')
    expect(assistant?.entries.map((e) => e.kind)).toContain('assistant')
    const user = lines[3]?.result
    expect(user?.entries.map((e) => e.kind)).toContain('unknown')
  })

  it('names the invented shapes without their content, in the drift report', async () => {
    resetToldShapes()
    const told: string[] = []
    setTranscriptLogger((m) => told.push(m))
    try {
      const path = join(DIR, CANARY)
      const chunk = await readTranscript(path, 'fixture', undefined, {
        firstReadBytes: statSync(path).size + 1024,
      })
      const shapes = (chunk.drift?.unknown ?? []).map((u) => u.shape).sort()
      expect(shapes).toEqual(
        [
          'assistant|block:zz_invented_block',
          'attachment|zz_invented_attachment',
          'system|zz_invented_subtype',
          'user|block:zz_invented_user_block',
          'zz-invented-top-level',
        ].sort(),
      )
      expect(told.length).toBeGreaterThan(0)
      expect(told.join('\n')).not.toContain('xxxx')
    } finally {
      setTranscriptLogger(null)
      resetToldShapes()
    }
  })
})

// ---- the drift tool ----------------------------------------------------------

describe('chat:drift over the fixtures', () => {
  it('finds nothing unknown in the corpus', async () => {
    const summary = await summarise(corpusFiles().map((f) => join(DIR, f)))
    expect(summary.unknown).toEqual([])
    expect(summary.oversize + summary.unparseable).toBe(0)
    expect(summary.lines).toBeGreaterThan(300)
    expect(summary.firstVersion).toBe('2.1.286')
  })

  it('names the canary by shape and place and nothing else', async () => {
    const summary = await summarise(fixtureFiles().map((f) => join(DIR, f)))
    expect(summary.unknown.map((u) => u.shape).sort()).toEqual([
      'assistant|block:zz_invented_block',
      'attachment|zz_invented_attachment',
      'system|zz_invented_subtype',
      'user|block:zz_invented_user_block',
      'zz-invented-top-level',
    ])
    for (const u of summary.unknown) expect(u.example).toMatch(/^canary\.jsonl:[1-5]$/)
    // Counts, shapes and places: no line's text.
    expect(JSON.stringify(summary)).not.toMatch(/xxxx/)
    expect(summary.unverifiedVersions['2.1.999']).toBe(2)
  })
})

// ---- hostile and mutated input ---------------------------------------------

describe('transcript reader: never throws', () => {
  it('survives text that is not a transcript line', () => {
    const hostile = [
      '',
      ' ',
      'not json',
      '{',
      'null',
      '42',
      '"string"',
      '[]',
      '[{"type":"user"}]',
      '{}',
      '{"type":null}',
      '{"type":5}',
      '{"type":"user","message":null}',
      '{"type":"user","message":{"content":5}}',
      '{"type":"assistant","message":{"content":[null,1,"x",[],{}]}}',
      '{"type":"attachment","attachment":"x"}',
      '{"type":"system","subtype":{"a":1}}',
      '{"__proto__":{"type":"user"},"type":"constructor"}',
      `{"type":"user","message":{"content":"${'x'.repeat(100_000)}"}}`,
    ]
    for (const line of hostile) {
      expect(() => classifyLine(line)).not.toThrow()
      expect(() => classifyLine(line, { sidechain: true, at: 7 })).not.toThrow()
      const result = classifyLine(line)
      expect(['rendered', 'hidden', 'unknown']).toContain(result.disposition.kind)
    }
  })

  it('survives every fixture line with one field removed, nulled or retyped', () => {
    const results = new Map<string, number>()
    const bump = (r: LineResult): void => {
      const key = r.disposition.kind
      results.set(key, (results.get(key) ?? 0) + 1)
    }
    for (const file of corpusFiles()) {
      for (const line of rawLines(file)) {
        const row = JSON.parse(line) as Record<string, unknown>
        for (const key of Object.keys(row)) {
          for (const change of ['delete', 'null', 'number', 'object', 'array'] as const) {
            const copy: Record<string, unknown> = { ...row }
            if (change === 'delete') delete copy[key]
            else
              copy[key] =
                change === 'null' ? null : change === 'number' ? 7 : change === 'object' ? {} : []
            bump(classifyLine(JSON.stringify(copy), { sidechain: isSidechainFile(file) }))
          }
        }
        // The same inside the message and the attachment.
        for (const inner of ['message', 'attachment'] as const) {
          const value = row[inner]
          if (value === null || typeof value !== 'object' || Array.isArray(value)) continue
          for (const key of Object.keys(value)) {
            for (const replacement of [null, 7, {}, [], 'x']) {
              const copy = { ...row, [inner]: { ...value, [key]: replacement } }
              bump(classifyLine(JSON.stringify(copy)))
            }
          }
        }
      }
    }
    expect(results.get('rendered')).toBeGreaterThan(0)
    expect(results.has('internal-error')).toBe(false)
  })

  it('never answers internal-error to a clean fixture line', () => {
    for (const file of corpusFiles()) {
      for (const { result } of replay(file)) {
        expect(result.disposition.kind === 'unknown' && result.disposition.shape).not.toBe(
          'internal-error',
        )
      }
    }
  })
})

// ---- your own sessions -----------------------------------------------------

const LOCAL = process.env['HOLI_CHAT_CORPUS']
const localDir = ((): string | null => {
  if (LOCAL === undefined || LOCAL === '') return null
  try {
    return statSync(LOCAL).isDirectory() ? LOCAL : null
  } catch {
    return null
  }
})()

function* jsonlUnder(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) yield* jsonlUnder(path)
    else if (entry.name.endsWith('.jsonl')) yield path
  }
}

describe.skipIf(localDir === null)(
  'transcript corpus: your own sessions (HOLI_CHAT_CORPUS)',
  () => {
    it('replays every line without a throw, and tells which shapes it has no rule for', async () => {
      const unknown = new Map<string, { count: number; example: string }>()
      let lines = 0
      let internal = 0
      for (const path of jsonlUnder(localDir ?? '.')) {
        const sidechain = path.includes('/subagents/')
        const reader = createInterface({ input: createReadStream(path), crlfDelay: Infinity })
        let lineNo = 0
        for await (const line of reader) {
          lineNo += 1
          if (line === '') continue
          lines += 1
          const { disposition } = classifyLine(line, { sidechain })
          if (disposition.kind !== 'unknown') continue
          if (disposition.shape === 'internal-error') internal += 1
          const seen = unknown.get(disposition.shape)
          if (seen === undefined) {
            unknown.set(disposition.shape, {
              count: 1,
              example: `${path.split('/').pop()}:${lineNo}`,
            })
          } else seen.count += 1
        }
      }
      // Counts and places only, never content.
      console.info(
        `HOLI_CHAT_CORPUS: ${lines} lines, ${unknown.size} unknown shapes\n` +
          [...unknown]
            .sort((a, b) => b[1].count - a[1].count)
            .map(
              ([shape, { count, example }]) =>
                `  ${String(count).padStart(7)}  ${shape}  e.g. ${example}`,
            )
            .join('\n'),
      )
      expect(internal).toBe(0)
    }, 600_000)
  },
)
