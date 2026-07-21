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
