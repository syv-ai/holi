import { TextDecoder } from 'node:util'
import { createRequire } from 'node:module'

const { startOwnedPty } = createRequire(import.meta.url)(
  '../../../../../../../scripts/pi-native-tui-process.mjs',
) as {
  startOwnedPty(options: Record<string, unknown>): Promise<Handle>
}
import type { OpenArgs } from '../../main/host/terminals'

const MAX_CAPTURE = 262_144
const REPLIES: ReadonlyArray<[string, string]> = [
  ['\x1b[6n', '\x1b[1;1R'],
  ['\x1b[?u', '\x1b[?0u'],
  ['\x1b[c', '\x1b[?1;2c'],
]

type Receipt = { drained: boolean }
type Handle = {
  output: Buffer
  failure?: Error
  nativeExit?: { code: number; signal: string | null }
  write(bytes: string): Promise<void>
  waitForExit(): Promise<unknown>
  close(): Promise<Receipt>
}
type Launch = (args: OpenArgs) => Promise<Handle>

export interface CodexTuiTerminals {
  open(args: OpenArgs): { ok: true; id: string } | { ok: false; message: string }
  close(id: string): Promise<void>
  paste(id: string, text: string): boolean
  list(): Array<{ id: string; launchedFor: string | null; title: string }>
  write(id: string, bytes: string): void
  snapshot(id: string): { output: string; inputs: string[]; receipt?: Receipt }
}

export function createCodexTuiTerminals({ launch }: { launch?: Launch } = {}): CodexTuiTerminals {
  const sessions = new Map<
    string,
    {
      args: OpenArgs
      start: Promise<void>
      handle?: Handle
      closeWork?: Promise<void>
      offset: number
      output: string
      inputs: string[]
      decoder: TextDecoder
      query: string
      replyTail: Promise<void>
      receipt?: Receipt
      timer?: ReturnType<typeof setInterval>
    }
  >()
  let serial = 0

  const stop = (id: string, s: typeof sessions extends Map<string, infer V> ? V : never) => {
    s.closeWork ??= (async () => {
      const handle = await s.start.then(() => s.handle)
      if (!handle) return
      const receipt = await handle.close()
      if (!receipt.drained) throw new Error('PTY drainage is unconfirmed')
      s.receipt = receipt
      if (s.timer) clearInterval(s.timer)
      s.timer = undefined
      const trailing = handle.output.subarray(s.offset)
      s.offset += trailing.length
      const final = s.decoder.decode(trailing, { stream: true }) + s.decoder.decode()
      if (final) deliver(s, final)
      await s.args.onExit?.()
      s.args.onRetired?.()
      sessions.delete(id)
    })()
    return s.closeWork
  }

  function deliver(s: typeof sessions extends Map<string, infer V> ? V : never, text: string) {
    s.output = (s.output + text).slice(-MAX_CAPTURE)
    s.args.onOutput?.(text)
  }

  return {
    open(args) {
      const id = `codex-${++serial}`
      const s = {
        args,
        start: Promise.resolve(),
        offset: 0,
        output: '',
        inputs: [],
        decoder: new TextDecoder(),
        query: '',
        replyTail: Promise.resolve(),
      } as typeof sessions extends Map<string, infer V> ? V : never
      sessions.set(id, s)
      const make =
        launch ??
        (async (openArgs: OpenArgs) => {
          const command = openArgs.command
          if (!command) throw new Error(openArgs.notInstalled)
          return startOwnedPty({
            command: command.bin,
            args: command.args,
            cwd: openArgs.cwd,
            env: command.env,
            stateDirectory: `${openArgs.cwd}/.holi-codex-tui-${id}`,
            timeoutMs: 45_000,
          })
        })
      s.start = make(args)
        .then((handle) => {
          s.handle = handle
          s.timer = setInterval(() => {
            const bytes = handle.output
            const fresh = bytes.subarray(s.offset)
            s.offset = bytes.length
            if (fresh.length) deliver(s, s.decoder.decode(fresh, { stream: true }))
          }, 10)
          void handle.waitForExit().then(
            () => void stop(id, s),
            () => void stop(id, s),
          )
        })
        .catch((error: unknown) => {
          if (s.timer) clearInterval(s.timer)
          sessions.delete(id)
          throw error
        })
      void s.start.catch(() => {})
      args.onStartupCleanup?.(s.start.then(() => stop(id, s)))
      return { ok: true, id }
    },
    close(id) {
      const s = sessions.get(id)
      return s ? stop(id, s) : Promise.resolve()
    },
    paste(id, text) {
      this.write(id, `\x1b[200~${text}\x1b[201~`)
      return sessions.has(id)
    },
    list: () =>
      [...sessions.keys()].map((id) => ({
        id,
        launchedFor: sessions.get(id)!.args.attach ?? null,
        title: '',
      })),
    write(id, bytes) {
      const s = sessions.get(id)
      if (!s) return
      s.query += bytes
      for (;;) {
        const entry = REPLIES.find(([query]) => s.query.includes(query))
        if (!entry) break
        const index = s.query.indexOf(entry[0])
        s.query = s.query.slice(index + entry[0].length)
        s.replyTail = s.replyTail.then(() => s.handle?.write(entry[1]))
      }
      s.inputs.push(bytes)
      s.args.onInput?.(bytes)
      void s.replyTail
      void s.handle?.write(bytes)
    },
    snapshot(id) {
      const s = sessions.get(id)
      return s
        ? { output: s.output, inputs: [...s.inputs], ...(s.receipt ? { receipt: s.receipt } : {}) }
        : { output: '', inputs: [] }
    },
  }
}
