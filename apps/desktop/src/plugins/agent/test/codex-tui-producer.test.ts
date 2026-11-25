import { createHash } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { stripVTControlCharacters } from 'node:util'
import { describe, expect, it } from 'vitest'
import { createBridgeServer } from '../../../main/bridge/server'
import { createCodexTuiContext, nativeUntil } from './fixtures/codex-tui-context'

type Context = Awaited<ReturnType<typeof createCodexTuiContext>>
const id = 'p0123456789ab'
const compact = (value: string) => stripVTControlCharacters(value).replace(/\s+/g, '').toLowerCase()

// The dedicated producer admits native work; ordinary collection owns no native resources.
describe.skipIf(!process.env.HOLI_CODEX_TUI_BIN)('native Codex TUI production consumers', () => {
  it('consumes success, cancellation and isolated late native deliveries with verified drainage', async () => {
    const root = process.env.HOLI_CODEX_TUI_ROOT
    const bin = process.env.HOLI_CODEX_TUI_BIN
    const output = process.env.HOLI_CODEX_TUI_PROOF_OUTPUT
    const nonce = process.env.HOLI_CODEX_TUI_NONCE
    const runId = process.env.HOLI_CODEX_TUI_RUN_ID
    if (!root || !bin || !output || !nonce || !runId)
      throw new Error('Native producer admission missing')
    const bridge = createBridgeServer()
    const scenarios: Array<{
      name: string
      status: string
      contexts: ReturnType<Context['snapshot']>[]
      error?: string
    }> = []
    const allContexts: Context[] = []
    const owners: Array<{ directory: string | null; removed: boolean; nativeDrained: boolean }> = []
    let failure: unknown
    let bridgeClosed = false
    const run = async (
      name: string,
      action: (
        create: (mode: 'success' | 'approval', suffix: string) => Promise<Context>,
      ) => Promise<void>,
    ) => {
      const contexts: Context[] = []
      const result: (typeof scenarios)[number] = { name, status: 'running', contexts: [] }
      scenarios.push(result)
      let error: unknown
      try {
        await action(async (mode, suffix) => {
          const context = await createCodexTuiContext({
            root,
            bin,
            bridge,
            remote: `fixture/${name}-${suffix}`,
            mode,
            onOwned: (owner) => owners.push(owner),
          })
          contexts.push(context)
          allContexts.push(context)
          return context
        })
        result.status = 'pass'
      } catch (caught) {
        error = caught
        result.status = 'failed'
        result.error = String(caught)
      }
      const cleanup = await Promise.allSettled(contexts.map((context) => context.close()))
      result.contexts = contexts.map((context) => context.snapshot())
      const cleanupErrors = cleanup.flatMap((settled) =>
        settled.status === 'rejected' ? [settled.reason] : [],
      )
      if (cleanupErrors.length)
        throw new AggregateError(
          [...(error ? [error] : []), ...cleanupErrors],
          'Scenario cleanup incomplete',
        )
      // A cleaned contract failure does not prevent independent ownership scenarios.
    }
    const start = async (context: Context) => {
      const started = await context.sessions.start('codex', {
        sessionId: id,
        cols: 120,
        rows: 40,
        prompt: 'Reply with a short fixture acknowledgement.',
      })
      expect(started.ok).toBe(true)
      const terminal = context.sessions.terminalOf(id)
      if (!terminal) throw new Error('Production host did not attach a terminal')
      return terminal
    }
    const completed = async (context: Context) => {
      await nativeUntil(
        () => context.received.length > 0 && context.consumed.some(({ kind }) => kind === 'turn'),
        'production notify consumption',
      )
      const payload = JSON.parse(context.received[0]!.body) as Record<string, unknown>
      expect(payload.type).toBe('agent-turn-complete')
      expect(payload.client).toBe('codex-tui')
      expect(context.sessions.sessions()[0]).toMatchObject({
        id,
        state: 'idle',
        conversationId: payload['thread-id'],
      })
      expect(context.changes.some((rows) => rows.some((row) => row.state === 'working'))).toBe(true)
      expect(context.brackets.filter(({ edge }) => edge === 'end')).toHaveLength(1)
      expect(context.model.requests.length).toBeGreaterThan(0)
      return payload
    }
    try {
      await bridge.start()
      await run('success', async (create) => {
        const context = await create('success', 'a')
        await start(context)
        await completed(context)
      })
      await run('approval-cancel', async (create) => {
        const context = await create('approval', 'a')
        const terminal = await start(context)
        await nativeUntil(() => {
          const text = compact(context.terminals.snapshot(terminal).output)
          return text.includes('wouldyouliketo') && text.includes('holi-528-fixture')
        }, 'native approval prompt')
        await delay(3000)
        const attentionBeforeCancel = context.sessions.sessions()[0]?.state
        expect(context.terminals.snapshot(terminal).output).toMatch(
          /\x1b\]9;[^\x07\x1b]*(?:\x07|\x1b\\)/,
        )
        await context.terminals.write(terminal, '\x1b')
        expect(context.sessions.sessions()[0]?.state).not.toBe('needs-you')
        await nativeUntil(
          () =>
            compact(context.terminals.snapshot(terminal).output).includes('youcanceledtherequest'),
          'native approval cancellation',
        )
        expect(context.terminals.snapshot(terminal).inputs).toEqual(['\x1b'])
        await context.sessions.stop(id)
        expect(context.sessions.sessions()).toEqual([])
        expect(attentionBeforeCancel).toBe('needs-you')
      })
      for (const name of ['closed-session-notify', 'leave-isolation']) {
        await run(name, async (create) => {
          const a = await create('success', 'a')
          const b = await create('success', 'b')
          a.holdNotify()
          b.holdNotify()
          await start(a)
          await start(b)
          await nativeUntil(
            () => a.received.length > 0 && b.received.length > 0,
            'two native-origin deferred deliveries',
          )
          expect(a.consumed).toHaveLength(0)
          expect(b.consumed).toHaveLength(0)
          const beforeB = structuredClone(b.sessions.sessions())
          const bracketB = structuredClone(b.brackets)
          if (name === 'leave-isolation') {
            await a.sessions.leave()
            a.detachRoutes()
          } else await a.sessions.stop(id)
          expect(a.sessions.sessions()).toEqual([])
          a.releaseNotify()
          await nativeUntil(
            () => a.consumed.some(({ kind }) => kind === 'turn'),
            'original closed-owner handler',
          )
          expect(a.sessions.sessions()).toEqual([])
          expect(b.sessions.sessions()).toEqual(beforeB)
          expect(b.brackets).toEqual(bracketB)
          expect(b.consumed).toHaveLength(0)
          expect(
            a.consumed.every(
              ({ before, after }) => JSON.stringify(before) === JSON.stringify(after),
            ),
          ).toBe(true)
          b.releaseNotify()
          const payloadB = await completed(b)
          expect(JSON.parse(a.received[0]!.body)['thread-id']).not.toBe(payloadB['thread-id'])
        })
      }
      expect(scenarios).toHaveLength(4)
      const failures = scenarios.filter(({ status }) => status !== 'pass')
      if (failures.length)
        throw new Error(failures.map(({ name, error }) => `${name}: ${error}`).join('\n'))
    } catch (error) {
      failure = error
    } finally {
      const cleanup = await Promise.allSettled(allContexts.map((context) => context.close()))
      const errors = cleanup.flatMap((settled) =>
        settled.status === 'rejected' ? [settled.reason] : [],
      )
      try {
        await bridge.stop()
        bridgeClosed = true
      } catch (error) {
        errors.push(error)
      }
      if (errors.length)
        failure = new AggregateError(
          [...(failure ? [failure] : []), ...errors],
          'Native proof cleanup incomplete',
        )
      for (const scenario of scenarios)
        scenario.contexts = allContexts
          .filter((context) => context.snapshot().remote.startsWith(`fixture/${scenario.name}-`))
          .map((context) => context.snapshot())
      const evidence = {
        schema: 'holi.codex-tui-producer.v1',
        runId,
        nonce,
        workerPid: process.pid,
        owners,
        classification: failure ? 'observed-contract-error' : 'pass',
        error: failure ? String(failure) : undefined,
        scenarios,
        cleanup: {
          bridgeClosed,
          contextsRemoved: owners.every((owner) => owner.removed),
          nativeDrained: owners.every((owner) => owner.nativeDrained),
        },
      }
      const bytes = JSON.stringify(evidence)
      await writeFile(output, bytes, { mode: 0o600 })
      await writeFile(
        join(root, 'tui-settlement.json'),
        JSON.stringify({
          runId,
          nonce,
          workerPid: process.pid,
          sha256: createHash('sha256').update(bytes).digest('hex'),
          settled:
            bridgeClosed && evidence.cleanup.contextsRemoved && evidence.cleanup.nativeDrained,
        }),
        { mode: 0o600 },
      )
    }
    if (failure) throw failure
  }, 150_000)
})
