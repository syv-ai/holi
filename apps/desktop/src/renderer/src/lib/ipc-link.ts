/**
 * tRPC terminating link that ships ops over the preload bridge to main, where
 * the router executes them against the vault clone. Queries and mutations only.
 *
 * The link is unchanged by D60 and that is the point: main used to proxy these
 * ops to the Syv server and now serves them from the filesystem, while the
 * renderer keeps calling one typed router either way. `AppRouter` is a
 * **type-only** import from main — erased at compile time, so no main-process
 * module is ever bundled into the renderer.
 */
import { TRPCClientError, type TRPCLink } from '@trpc/client'
import { observable } from '@trpc/server/observable'
import type { AppRouter } from '../../../main/router'

export interface TrpcOpWire {
  path: string
  type: 'query' | 'mutation' | 'subscription'
  input: unknown
}

export type TrpcEnvelope = { ok: true; data: unknown } | { ok: false; message: string; code?: string }

export type TrpcInvoke = (op: TrpcOpWire) => Promise<TrpcEnvelope>

/**
 * Rebuild a `TRPCClientError` that still knows *which* refusal this was.
 *
 * Carrying the code is the entire reason `trpc-call.ts` encodes failures as data
 * instead of letting the promise reject — and this side used to throw it away,
 * rebuilding the error from the message alone. Every caller was then left
 * matching on prose: the vault settings panel blamed a missing sign-in for what
 * was really a 404 on a vault that is not a GitHub repo at all.
 *
 * Shaped as a `TRPCErrorResponse` so the code lands on `err.data.code`, where
 * tRPC's own callers already look for it, rather than on a property of ours that
 * only this codebase would know to read. An envelope with no code stays a plain
 * error — it never had a meaning to preserve.
 */
function errorFrom(envelope: { message: string; code?: string }): TRPCClientError<AppRouter> {
  if (envelope.code === undefined) return TRPCClientError.from(new Error(envelope.message))
  return TRPCClientError.from({
    error: {
      code: TRPC_ERROR_CODE,
      message: envelope.message,
      data: { code: envelope.code },
    },
  } as never)
}

/** JSON-RPC's `INTERNAL_SERVER_ERROR`. The numeric code is what makes the object
 *  above a well-formed `TRPCErrorResponse`; the meaning the UI reads is the
 *  string in `data.code`, which is main's actual verdict. */
const TRPC_ERROR_CODE = -32603

export function ipcLink(invoke: TrpcInvoke): TRPCLink<AppRouter> {
  return () =>
    ({ op }) =>
      observable((observer) => {
        invoke({ path: op.path, type: op.type, input: op.input }).then(
          (envelope) => {
            if (envelope.ok) {
              observer.next({ result: { data: envelope.data } })
              observer.complete()
            } else {
              observer.error(errorFrom(envelope))
            }
          },
          (err) => observer.error(TRPCClientError.from(err as Error)),
        )
      })
}
