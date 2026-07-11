/**
 * Main-process tRPC client to the Syv server. The bearer token is injected
 * here from the session store — the renderer's calls arrive over IPC as
 * {path, type, input} ops and are executed against this client, so the token
 * never crosses the context bridge for API calls (auth PRD §Flows).
 */
import { createTRPCClient, httpBatchLink } from '@trpc/client'
import type { AppRouter } from '@holi/server/router'

export const API_URL = process.env.HOLI_API_URL ?? 'http://127.0.0.1:4000'
export const RELAY_URL = process.env.HOLI_RELAY_URL ?? 'ws://127.0.0.1:4444'

export function createServerClient(getToken: () => string | null, url = API_URL) {
  return createTRPCClient<AppRouter>({
    links: [
      httpBatchLink({
        url,
        headers() {
          const token = getToken()
          return token ? { authorization: `Bearer ${token}` } : {}
        },
      }),
    ],
  })
}

export type ServerClient = ReturnType<typeof createServerClient>

export interface TrpcOp {
  path: string
  type: 'query' | 'mutation' | 'subscription'
  input: unknown
}

export type TrpcEnvelope = { ok: true; data: unknown } | { ok: false; message: string; code?: string }

/** Execute an IPC op against the (proxy) client: walk the path, call query/mutate. */
export async function callProcedure(client: unknown, op: TrpcOp): Promise<unknown> {
  if (op.type === 'subscription') {
    throw new Error('subscriptions are not supported over the IPC link (plan decision #5)')
  }
  const node = op.path.split('.').reduce<unknown>((acc, key) => {
    if (acc == null || typeof acc !== 'object') return undefined
    return (acc as Record<string, unknown>)[key]
  }, client)
  const method = op.type === 'query' ? 'query' : 'mutate'
  const fn = node && (node as Record<string, unknown>)[method]
  if (typeof fn !== 'function') throw new Error(`unknown procedure: ${op.path}`)
  return (fn as (input: unknown) => Promise<unknown>)(op.input)
}

export async function toEnvelope(promise: Promise<unknown>): Promise<TrpcEnvelope> {
  try {
    return { ok: true, data: await promise }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    const code = (err as { data?: { code?: string } }).data?.code
    return { ok: false, message, ...(code ? { code } : {}) }
  }
}
