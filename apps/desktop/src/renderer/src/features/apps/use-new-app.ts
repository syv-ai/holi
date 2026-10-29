/**
 * New app, as the Apps page and the command menu offer it: the apps plugin's
 * create (`claim.create`, the Files menu's own) at the vault root, under the
 * first free `Untitled` name, then the app opened.
 */
import { useAtomValue } from 'jotai'
import { useState } from 'react'
import { toast } from 'sonner'

import { claimsAtom } from '@/state/plugins'
import { activeRemoteAtom, snapshotAtom } from '@/state/vaults'

/** The first `Untitled`, `Untitled 2`, … that no vault path takes, as an
 *  app's name at the vault root. */
function freeAppName(taken: ReadonlySet<string>): string {
  for (let n = 1; ; n++) {
    const name = n === 1 ? 'Untitled' : `Untitled ${n}`
    if (!taken.has(`${name}.app`)) return name
  }
}

/** `create` is undefined while the apps plugin is off or no vault is open. */
export function useNewApp(onOpen: (path: string) => void): {
  create: (() => Promise<void>) | undefined
  creating: boolean
} {
  const remote = useAtomValue(activeRemoteAtom)
  const snapshot = useAtomValue(snapshotAtom)
  const claim = useAtomValue(claimsAtom).find((c) => c.create?.id === 'app')
  const [creating, setCreating] = useState(false)

  if (remote === null || claim?.create === undefined) {
    return { create: undefined, creating }
  }
  const run = claim.create.run
  const entryFile = claim.folder?.entry ?? 'index.html'

  async function create() {
    const taken = new Set([...snapshot.dirs, ...snapshot.files.map((file) => file.path)])
    setCreating(true)
    try {
      const entry = await run({
        remote: remote!,
        parent: '',
        name: freeAppName(taken),
      })
      if (entry === null) {
        toast.error("Couldn't create the app. Try again.")
        return
      }
      const suffix = `/${entryFile}`
      onOpen(entry.endsWith(suffix) ? entry.slice(0, -suffix.length) : entry)
    } finally {
      setCreating(false)
    }
  }
  return { create, creating }
}
