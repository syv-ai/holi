/**
 * The vault's sync state as one of the nav menu's items (docs/features/vaults-sync.md):
 * the footer's words turned into a glyph that says it at a glance. Quiet when
 * nothing is wrong, the brand and turning while a pull runs, amber when it
 * wants you, turning amber while a reconcile holds the files.
 *
 * It opens a panel rather than acting: the state in words, what to do about
 * it when there is something, and the vault's history. A conflict can always
 * be tried again; a config conflict's reconcile stays with its banner, which
 * outranks this.
 */
import { useAtomValue, useSetAtom } from 'jotai'
import {
  Cloud,
  CloudAlert,
  CloudCheck,
  CloudOff,
  GitMerge,
  History,
  RefreshCw,
  RotateCw,
  Undo2,
} from 'lucide-react'
import { useMemo } from 'react'
import { isVaultConfigPath } from '@holi/shared'
import type { SyncState } from '../../../../main/vault/active-vault'
import {
  Button,
  Icon,
  type IconGlyph,
  type IconMotion,
  type IconTone,
  type MorphingMenuItem,
} from '@/primitives'
import { cn } from '@/lib/cn'
import { syncLabel } from '@/lib/sync-label'
import { useAgentService } from '@/state/agent-service'
import { reconcileAtom } from '@/state/reconcile'
import { openSurface, workspaceAtom } from '@/state/panes'
import { abandonReconcileAtom, retrySyncAtom, syncStateAtom } from '@/state/vaults'

type Glyph = { icon: IconGlyph; tone?: IconTone; motion?: IconMotion }

/** How each state looks in the dock. A loop only while something is in flight. */
function glyphOf(state: SyncState): Glyph {
  switch (state.kind) {
    case 'up-to-date':
      return { icon: CloudCheck }
    case 'pulling':
      return { icon: RefreshCw, tone: 'busy', motion: 'orbit' }
    case 'offline':
      return { icon: CloudOff, tone: 'warn' }
    case 'no-access':
    case 'conflict':
      return { icon: CloudAlert, tone: 'warn' }
    case 'reconciling':
      return { icon: RefreshCw, tone: 'warn', motion: 'orbit' }
    case 'paused':
      return state.manual ? { icon: Cloud } : { icon: CloudAlert, tone: 'warn' }
  }
}

/** The label's colour in the panel: coloured text on no background. */
const TEXT_TONE = { quiet: 'text-muted-foreground', busy: 'text-brand', warn: 'text-amber-400' }

const ROW = 'h-auto min-h-8 w-full justify-start gap-2 rounded-xl px-2.5 py-1.5 text-sm font-normal'

function SyncPanel({ close }: { close: () => void }): React.JSX.Element {
  const state = useAtomValue(syncStateAtom)
  const setWorkspace = useSetAtom(workspaceAtom)
  const reconcile = useSetAtom(reconcileAtom)
  const agent = useAgentService()
  const abandon = useSetAtom(abandonReconcileAtom)
  const retry = useSetAtom(retrySyncAtom)
  const label = syncLabel(state)
  // Content conflicts only: a config conflict's banner owns the action.
  const contentConflict =
    state.kind === 'conflict' && !state.paths.some((path) => isVaultConfigPath(path))

  return (
    <div className="flex w-72 flex-col gap-0.5 p-1">
      <p data-morph-row="" className={cn('px-2.5 py-1.5 text-sm', TEXT_TONE[label.tone])}>
        {label.text}
      </p>
      {state.kind === 'conflict' && (
        <ul data-morph-row="" className="px-2.5 pb-1 text-xs text-muted-foreground">
          {state.paths.map((path) => (
            <li key={path} className="truncate font-mono">
              {path}
            </li>
          ))}
        </ul>
      )}
      {/* Without anyone to reconcile it, a conflict that has since been
          resolved would otherwise hold sync forever. */}
      {state.kind === 'conflict' && (
        <Button
          variant="ghost"
          data-morph-row=""
          className={ROW}
          onClick={() => {
            close()
            void retry()
          }}
        >
          <Icon icon={RotateCw} />
          Try again
        </Button>
      )}
      {contentConflict && agent !== null && (
        <Button
          variant="ghost"
          data-morph-row=""
          className={ROW}
          onClick={() => {
            close()
            void reconcile()
          }}
        >
          <Icon icon={GitMerge} />
          Ask {agent.name} to reconcile
        </Button>
      )}
      {/* While a reconcile runs its files are read-only: the way out, which
          keeps the conflict and loses nothing. */}
      {state.kind === 'reconciling' && (
        <Button
          variant="ghost"
          data-morph-row=""
          className={ROW}
          onClick={() => {
            close()
            void abandon()
          }}
        >
          <Icon icon={Undo2} />
          Abandon the merge
        </Button>
      )}
      <Button
        variant="ghost"
        data-morph-row=""
        className={ROW}
        onClick={() => {
          close()
          setWorkspace((w) => openSurface(w, 'history'))
        }}
      >
        <Icon icon={History} />
        Open history
      </Button>
    </div>
  )
}

/** The nav menu's sync item, rebuilt only when the state changes. */
export function useSyncItem(): MorphingMenuItem {
  const state = useAtomValue(syncStateAtom)
  return useMemo(() => {
    const glyph = glyphOf(state)
    return {
      id: 'sync',
      label: `Sync: ${syncLabel(state).text}`,
      icon: glyph.icon,
      tone: glyph.tone,
      motion: glyph.motion,
      panel: (close) => <SyncPanel close={close} />,
    }
  }, [state])
}
