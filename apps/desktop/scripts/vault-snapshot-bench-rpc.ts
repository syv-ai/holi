import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { VAULT_SETTING_DEFAULTS, vaultRelPath } from '@holi/shared'

export type TrpcOpWire = { path: string; type?: string; input?: unknown }
export type TrpcEnvelope = { ok: true; data: unknown } | { ok: false; message: string }

export function createBenchRpc({
  root,
  remote,
  getSnapshot,
}: {
  root: string
  remote: string
  getSnapshot: () => unknown
}): (op: TrpcOpWire) => Promise<TrpcEnvelope> {
  const vault = resolve(root)
  return async (op) => {
    try {
      if (!op || typeof op.path !== 'string') throw new Error('Malformed benchmark RPC')
      const input = (op.input ?? {}) as Record<string, unknown>
      const requireRemote = () => {
        if (input.remote !== remote) throw new Error('Unknown benchmark vault')
      }
      let data: unknown
      if (op.path === 'vaults.snapshot' || op.path === 'vaults.open') {
        requireRemote()
        data = getSnapshot()
      } else if (op.path === 'vaults.refresh') {
        requireRemote()
        data = getSnapshot()
      } else if (op.path === 'subscriptions.list') {
        requireRemote()
        data = []
      } else if (op.path === 'settings.get') {
        requireRemote()
        data = { ...VAULT_SETTING_DEFAULTS, warnings: [] }
      } else if (op.path === 'notes.read' || op.path === 'files.read') {
        requireRemote()
        if (typeof input.path !== 'string') throw new Error('File path is required')
        const rel = vaultRelPath(input.path)
        const target = resolve(vault, rel)
        if (!target.startsWith(`${vault}/`)) throw new Error('Path escapes benchmark vault')
        data =
          op.path === 'files.read'
            ? new Uint8Array(await readFile(target))
            : await readFile(target, 'utf8')
      } else throw new Error(`Unexpected benchmark RPC: ${op.path}`)
      return { ok: true, data }
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) }
    }
  }
}
