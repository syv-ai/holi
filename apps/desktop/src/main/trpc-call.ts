/**
 * Calling the router from an IPC message, and turning the result into something
 * that survives `structuredClone`.
 *
 * **Why an envelope rather than letting the promise reject.** An Error thrown
 * across Electron's IPC boundary arrives at the renderer as a string with
 * `Error invoking remote method` glued to the front and every property gone —
 * so a `NOT_FOUND` and a genuine crash become indistinguishable at exactly the
 * point the UI has to tell them apart. Encoding the failure as data keeps the
 * code, and `ipcLink` on the other side turns it back into a `TRPCClientError`.
 *
 * Deliberately free of Electron imports: this is the half worth testing.
 */
import type { AnyRouter } from '@trpc/server'

export interface TrpcOp {
  path: string
  type: 'query' | 'mutation' | 'subscription'
  input: unknown
}

export type TrpcEnvelope =
  | { ok: true; data: unknown }
  | { ok: false; message: string; code?: string }

type Caller = Record<string, unknown>

/**
 * Resolve `vaults.open` against the router's caller and invoke it.
 *
 * Subscriptions are refused rather than attempted: `ipcMain.handle` is
 * request/response, so a subscription would resolve once and silently never
 * emit again. Push goes over its own channels.
 */
export async function callProcedure(router: AnyRouter, op: TrpcOp): Promise<unknown> {
  if (op.type === 'subscription') {
    throw new Error(`subscriptions do not cross the IPC seam: ${op.path}`)
  }
  const caller = router.createCaller({}) as unknown as Caller
  const target = op.path.split('.').reduce<unknown>((node, key) => {
    if (node === null || node === undefined) return undefined
    return (node as Caller)[key]
  }, caller)

  if (typeof target !== 'function') throw new Error(`no such procedure: ${op.path}`)
  return (target as (input: unknown) => Promise<unknown>)(op.input)
}

export async function toEnvelope(work: Promise<unknown>): Promise<TrpcEnvelope> {
  try {
    return { ok: true, data: await work }
  } catch (err) {
    // tRPC hangs its code on the error; anything else is an ordinary crash and
    // is reported as one rather than being given a code it does not have.
    const code = (err as { code?: unknown }).code
    return {
      ok: false,
      message: err instanceof Error ? err.message : String(err),
      ...(typeof code === 'string' ? { code } : {}),
    }
  }
}
