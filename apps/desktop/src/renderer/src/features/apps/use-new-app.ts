/**
 * New app, as the Apps page and the command menu offer it: the apps plugin's
 * create (`claim.create`, the Files menu's own) at the vault root, under the
 * first free `Untitled` name, then the app opened.
 */
import { useAtomValue } from 'jotai'
import { useState } from 'react'

import { claimsAtom } from '@/state/plugins'
import { useAgentService } from '@/state/agent-service'
import { activeRemoteAtom } from '@/state/vaults'

/** `create` is undefined while the apps plugin is off or no vault is open. */
export function useNewApp(): {
  create: (() => Promise<void>) | undefined
  creating: boolean
} {
  const remote = useAtomValue(activeRemoteAtom)
  const claim = useAtomValue(claimsAtom).find((c) => c.create?.id === 'app')
  const agent = useAgentService()
  const [creating, setCreating] = useState(false)

  if (remote === null || claim?.create === undefined || agent === null) {
    return { create: undefined, creating }
  }
  const vaultRemote = remote
  const run = claim.create.run

  async function create() {
    setCreating(true)
    try {
      await run({
        remote: vaultRemote,
        parent: '',
        name: 'a useful app for this vault',
        agent,
      })
    } finally {
      setCreating(false)
    }
  }
  return { create, creating }
}
