/**
 * tRPC terminating link that ships ops over the preload bridge to main,
 * where the authed HTTP client executes them (plan decision #2). Queries and
 * mutations only — subscriptions arrive with the tasks-board phase.
 */
import { TRPCClientError, type TRPCLink } from '@trpc/client'
import { observable } from '@trpc/server/observable'
import type { AppRouter } from '@holi/server/router'

export interface TrpcOpWire {
  path: string
  type: 'query' | 'mutation' | 'subscription'
  input: unknown
}

export type TrpcEnvelope = { ok: true; data: unknown } | { ok: false; message: string; code?: string }

export type TrpcInvoke = (op: TrpcOpWire) => Promise<TrpcEnvelope>

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
              observer.error(TRPCClientError.from(new Error(envelope.message)))
            }
          },
          (err) => observer.error(TRPCClientError.from(err as Error)),
        )
      })
}
