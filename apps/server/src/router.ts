import { initTRPC } from '@trpc/server'
import type { HealthStatus } from '@holi/shared'

const t = initTRPC.create()

export const appRouter = t.router({
  health: t.procedure.query(
    (): HealthStatus => ({ ok: true, service: 'holi-server', time: new Date().toISOString() }),
  ),
})

export type AppRouter = typeof appRouter
