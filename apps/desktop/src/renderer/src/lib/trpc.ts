import { createTRPCClient } from '@trpc/client'
import type { AppRouter } from '../../../main/router'
import { ipcLink } from './ipc-link'

export const trpc = createTRPCClient<AppRouter>({
  links: [ipcLink((op) => window.holi.trpc(op))],
})
