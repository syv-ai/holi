/**
 * The Home tab when it has no app to show: Home is the setting `home`, and
 * PaneView shows its app whenever the vault has it. Here it says what Home is
 * and why it is not showing. A missing app can be created with the default
 * Home app; nothing is written unasked. A view, a file or today's note opens
 * as itself (`state/home.ts`), so reaching this with one means it was not
 * there, or Home changed while the tab was open: going there is one click.
 */
import { appName, type HomeTarget } from '@holi/shared'
import { useAtomValue, useSetAtom } from 'jotai'
import { useState } from 'react'
import { trpc } from '@/lib/trpc'
import { Button } from '@/primitives'
import { openHomeAtom } from '@/state/home'
import { activeRemoteAtom } from '@/state/vaults'

const VIEW_NAMES = { board: 'the board', agenda: 'your agenda', mail: 'mail' } as const

export function HomeView({ target }: { target: HomeTarget }): React.JSX.Element {
  const remote = useAtomValue(activeRemoteAtom)
  const openHome = useSetAtom(openHomeAtom)
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

  const name = (text: string) => <span className="text-foreground">{text}</span>
  let says: React.ReactNode
  let action: React.ReactNode = null
  switch (target.kind) {
    case 'app':
      says = <>Home is the {name(appName(target.path))} app, and this vault has none yet.</>
      action = (
        <Button variant="secondary" size="sm" disabled={busy} onClick={create}>
          Create Home app
        </Button>
      )
      break
    case 'file':
      says = <>Home is {name(target.path)}, which is not in this vault.</>
      break
    case 'daily':
      says = <>Home is today’s note, and this vault keeps no daily note.</>
      break
    default:
      says = <>Home is {VIEW_NAMES[target.kind]}.</>
      action = (
        <Button variant="secondary" size="sm" onClick={() => void openHome()}>
          Go there
        </Button>
      )
  }

  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 text-sm">
      <p className="text-muted-foreground">{says}</p>
      {action}
      {error !== null && <p className="text-xs text-destructive">{error}</p>}
    </div>
  )
}
