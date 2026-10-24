/**
 * Replays a captured stream-json run the way `chats.ts` drives a process:
 * what Holi wrote to stdin (`{"__stdin": …}` lines) brackets the turns and
 * answers the cards, and every stdout record goes through the reader and the
 * reducer. Fixture in, transcript items out.
 *
 * The fixtures under `fixtures/` were captured from Claude Code 2.1.310
 * (`claude -p --input-format stream-json --output-format stream-json
 * --include-partial-messages --verbose --permission-prompt-tool stdio`, with
 * `--model haiku`) in a scratch repo, then rewritten to a neutral root
 * (`/vault`, `/home/user`) with signatures and session lists dropped. The
 * `synth-*` ones are written by hand to the shapes older versions sent, for
 * the tools 2.1.310 no longer runs in print mode (TodoWrite, Glob, Grep,
 * MultiEdit) and the events no run produced (retries, thinking text).
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  newClaudeReader,
  parseLine,
  readClaudeRecord,
  type JsonRecord,
} from '../main/claude-stream'
import { applyChatEvent, type ChatEvent, type TranscriptItem } from '../shared/chat'

export const FIXTURE_ROOT = '/vault'

export function fixtureLines(name: string): JsonRecord[] {
  const text = readFileSync(join(__dirname, 'fixtures', `${name}.jsonl`), 'utf8')
  return text
    .split('\n')
    .map((l) => parseLine(l))
    .filter((r): r is JsonRecord => r !== null)
}

export interface Replay {
  items: TranscriptItem[]
  events: ChatEvent[]
  modes: string[]
  info: ReturnType<typeof readClaudeRecord>['info'][]
}

export function replay(name: string): Replay {
  let clock = 1_000_000
  const reader = newClaudeReader(() => (clock += 1_000))
  let items: TranscriptItem[] = []
  const events: ChatEvent[] = []
  const modes: string[] = []
  const info: Replay['info'] = []
  let turnOpen = false
  let n = 0
  const apply = (e: ChatEvent) => {
    events.push(e)
    items = applyChatEvent(items, e, FIXTURE_ROOT).items
  }
  for (const r of fixtureLines(name)) {
    const stdin = r['__stdin'] as JsonRecord | undefined
    if (stdin !== undefined) {
      if (stdin['type'] === 'user') {
        const content = ((stdin['message'] as JsonRecord)['content'] as JsonRecord[]) ?? []
        const text = content
          .filter((b) => b['type'] === 'text')
          .map((b) => String(b['text']))
          .join('')
        n++
        apply({ type: 'user', id: `u${n}`, text, at: clock })
        apply({ type: 'turn-start', id: `t${n}`, at: clock })
        turnOpen = true
      } else if (stdin['type'] === 'control_request') {
        reader.interrupting = true
      } else if (stdin['type'] === 'control_response') {
        const response = stdin['response'] as JsonRecord
        const body = response['response'] as JsonRecord
        const requestId = String(response['request_id'])
        if (body['behavior'] === 'allow') apply({ type: 'resolved', requestId, status: 'allowed' })
        if (body['behavior'] === 'deny') apply({ type: 'resolved', requestId, status: 'denied' })
      }
      continue
    }
    const res = readClaudeRecord(reader, r)
    for (const e of res.events) apply(e)
    if (res.mode !== undefined) modes.push(res.mode)
    if (res.info !== undefined) info.push(res.info)
    if (res.turnEnded !== undefined && turnOpen) {
      turnOpen = false
      apply({
        type: 'turn-end',
        at: clock,
        ...(res.turnEnded.failed ? { failed: true } : {}),
        ...(res.turnEnded.interrupted ? { interrupted: true } : {}),
        ...(res.turnEnded.model === undefined ? {} : { model: res.turnEnded.model }),
      })
    }
  }
  return { items, events, modes, info }
}

export const ofKind = <K extends TranscriptItem['kind']>(
  items: readonly TranscriptItem[],
  kind: K,
): Extract<TranscriptItem, { kind: K }>[] =>
  items.filter((i): i is Extract<TranscriptItem, { kind: K }> => i.kind === kind)
