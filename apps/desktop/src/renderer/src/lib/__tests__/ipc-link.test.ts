import { createTRPCClient } from '@trpc/client'
import { expect, it } from 'vitest'
import { ipcLink, type TrpcInvoke, type TrpcOpWire, type TrpcEnvelope } from '@/lib/ipc-link'
import type { AppRouter } from '../../../../main/router'
import { observeUpgradeUiRequests } from '../../../../../scripts/upgrade-before-panel.mjs'

it('observes a typed production vault-open request across the IPC link', async () => {
  const remote = 'fixture-upgrade-565/00000000-0000-0000-0000-000000000000'
  let invoke: TrpcInvoke = async () => {
    throw new Error('handler not registered')
  }
  const ipc = {
    handle(_channel: string, listener: (event: unknown, op: TrpcOpWire) => Promise<TrpcEnvelope>) {
      invoke = (op) => listener({}, op)
    },
  }
  const snapshot = observeUpgradeUiRequests(ipc, remote)
  ipc.handle('holi:trpc', async () => ({ ok: true, data: null }))
  const client = createTRPCClient<AppRouter>({ links: [ipcLink((op) => invoke(op))] })
  await client.vaults.open.mutate({ remote })
  expect(snapshot()).toEqual([expect.objectContaining({ event: 'vaults.open', result: 'success' })])
  expect(snapshot()[0].completionOrder).toBeGreaterThan(snapshot()[0].startOrder)
})
