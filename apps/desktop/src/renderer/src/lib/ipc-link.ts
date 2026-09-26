/**
 * tRPC terminating link that ships ops over the preload bridge to main, where
 * the router executes them against the vault clone. Queries and mutations only.
 *
 * `AppRouter` is a type-only import from main, erased at compile time, so no
 * main-process module is bundled into the renderer.
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
 * Carrying the code is why `trpc-call.ts` encodes failures as data; without it
 * callers are left matching on prose. Shaped as a `TRPCErrorResponse` so the
 * code lands on `err.data.code`, where tRPC callers look. No code, plain error.
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

/** JSON-RPC's `INTERNAL_SERVER_ERROR`, for a well-formed `TRPCErrorResponse`.
 *  The UI reads main's verdict from `data.code`. */
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
