import { TextDecoder } from 'node:util'
import { createRequire } from 'node:module'

const { startOwnedPty } = createRequire(import.meta.url)(
  '../../../../../../../scripts/pi-native-tui-process.mjs',
) as { startOwnedPty(options: Record<string, unknown>): Promise<Handle> }
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
type Session = {
  args: OpenArgs; start: Promise<void>; handle?: Handle; closeWork?: Promise<void>; offset: number
  output: string; inputs: string[]; decoder: TextDecoder; query: string; replyTail: Promise<void>
  receipt?: Receipt; timer?: ReturnType<typeof setInterval>; retired?: boolean
}
export interface CodexTuiTerminals {
  open(args: OpenArgs): { ok: true; id: string } | { ok: false; message: string }
  close(id: string): Promise<void>
  paste(id: string, text: string): boolean
  list(): Array<{ id: string; launchedFor: string | null; title: string }>
  write(id: string, bytes: string): Promise<void>
  snapshot(id: string): { output: string; inputs: string[]; receipt?: Receipt }
}

export function createCodexTuiTerminals({ launch }: { launch?: Launch } = {}): CodexTuiTerminals {
  const sessions = new Map<string, Session>()
  let serial = 0
  const deliver = (s: Session, text: string) => {
    s.output = (s.output + text).slice(-MAX_CAPTURE)
    s.args.onOutput?.(text)
    s.query = (s.query + text).slice(-64)
    for (;;) {
      const found = REPLIES.find(([query]) => s.query.includes(query))
      if (!found) break
      s.query = s.query.slice(s.query.indexOf(found[0]) + found[0].length)
      s.replyTail = s.replyTail.then(() => s.handle?.write(found[1]))
    }
  }
  const stop = (id: string, s: Session): Promise<void> => {
    s.closeWork ??= (async () => {
      try {
        await s.start
        if (!s.handle) return
        const physical = s.handle.close()
        s.args.onDraining?.(physical.then(() => {}))
        const receipt = await physical
        if (!receipt.drained) throw new Error('PTY drainage is unconfirmed')
        s.receipt = receipt
        if (s.timer) clearInterval(s.timer)
        s.timer = undefined
        const trailing = s.handle.output.subarray(s.offset)
        s.offset += trailing.length
        const final = s.decoder.decode(trailing, { stream: true }) + s.decoder.decode()
        if (final) deliver(s, final)
        s.retired = true
        await s.args.onExit?.()
        s.args.onRetired?.()
      } catch (error) {
        s.closeWork = undefined
        throw error
      }
    })()
    return s.closeWork
  }
  return {
    open(args) {
      const id = `codex-${++serial}`
      const s: Session = { args, start: Promise.resolve(), offset: 0, output: '', inputs: [], decoder: new TextDecoder(), query: '', replyTail: Promise.resolve() }
      sessions.set(id, s)
      const make = launch ?? (async (openArgs: OpenArgs) => {
        const command = openArgs.command
        if (!command) throw new Error(openArgs.notInstalled)
        return startOwnedPty({ command: command.bin, args: command.args, cwd: openArgs.cwd, env: command.env, stateDirectory: `${openArgs.cwd}/.holi-codex-tui-${id}`, timeoutMs: 45_000 })
      })
      s.start = make(args).then((handle) => {
        s.handle = handle
        s.timer = setInterval(() => {
          const fresh = handle.output.subarray(s.offset)
          s.offset = handle.output.length
          if (fresh.length) deliver(s, s.decoder.decode(fresh, { stream: true }))
        }, 10)
        void handle.waitForExit().then(() => stop(id, s), () => stop(id, s)).catch(() => {})
      }).catch((error: unknown) => {
        if (s.timer) clearInterval(s.timer)
        s.retired = true
        args.onStartupCleanup?.(Promise.reject(error).catch(() => {}))
        throw error
      })
      void s.start.catch(() => {})
      return { ok: true, id }
    },
    close(id) { const s = sessions.get(id); return s ? stop(id, s) : Promise.resolve() },
    paste(id, text) { void this.write(id, `\x1b[200~${text}\x1b[201~`); return sessions.has(id) },
    list: () => [...sessions].filter(([, s]) => !s.retired).map(([id, s]) => ({ id, launchedFor: s.args.attach ?? null, title: '' })),
    async write(id, bytes) {
      const s = sessions.get(id)
      if (!s || s.retired) return
      await s.start
      if (!s.handle) return
      s.inputs.push(bytes)
      s.args.onInput?.(bytes)
      await s.handle.write(bytes)
    },
    snapshot(id) {
      const s = sessions.get(id)
      return s ? { output: s.output, inputs: [...s.inputs], ...(s.receipt ? { receipt: s.receipt } : {}) } : { output: '', inputs: [] }
    },
  }
}
