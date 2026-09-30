/**
 * Home, when the app it shows is not there: the vault's `home` setting names
 * an app (`Home.app` unless it says otherwise) and PaneView renders that app
 * whenever it exists. A vault made before Home was an app has none, so this
 * says so and offers to write the default one. Nothing is written unasked.
 */
import { appName } from '@holi/shared'
import { useAtomValue } from 'jotai'
import { useState } from 'react'
import { trpc } from '@/lib/trpc'
import { Button } from '@/primitives'
import { activeRemoteAtom } from '@/state/vaults'

export function HomeView({ path }: { path: string }): React.JSX.Element {
  const remote = useAtomValue(activeRemoteAtom)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const create = (): void => {
    if (remote === null) return
    setBusy(true)
    setError(null)
    // The app appears through the vault's own rescan, and PaneView swaps it in.
    trpc.apps.createHome.mutate({ remote }).then(
      () => setBusy(false),
      (e: unknown) => {
        setBusy(false)
        setError((e as Error).message)
      },
    )
  }

  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 text-sm">
      <p className="text-muted-foreground">
        Home shows the <span className="text-foreground">{appName(path)}</span> app, and this vault
        has none yet.
      </p>
      <Button variant="secondary" size="sm" disabled={busy} onClick={create}>
        Create Home app
      </Button>
      {error !== null && <p className="text-xs text-destructive">{error}</p>}
    </div>
  )
}
