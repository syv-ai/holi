/**
 * An agent tab: its terminal, and under it the turn chip for the session it
 * was opened for. Kept mounted while hidden (`Surface.keepMounted`): an
 * unmounted terminal loses its scrollback and must visibly replay main's
 * mirror.
 */
import { useAtomValue, useSetAtom } from 'jotai'
import { agentGeometryAtom, agentTerminalsAtom } from './state/sessions'
import { SessionTerminal } from './SessionTerminal'
import { TurnChip } from './TurnChip'

/**
 * The turn chip for the session an agent tab was opened for. The agents list,
 * and a tab whose terminal Holi did not open for a session, have none: nothing
 * published says which session they show.
 */
function AgentTurnChip({ terminalId }: { terminalId: string }): React.JSX.Element | null {
  const terminals = useAtomValue(agentTerminalsAtom)
  const sessionId = terminals.find((t) => t.id === terminalId)?.launchedFor ?? null
  if (sessionId === null) return null
  return (
    <div className="shrink-0 border-t border-divider px-2 py-1">
      {/* Keyed, so the chip's "just landed" refs belong to one session. */}
      <TurnChip key={sessionId} sessionId={sessionId} />
    </div>
  )
}

export function AgentSurface({
  id,
  visible,
}: {
  id?: string
  visible: boolean
}): React.JSX.Element | null {
  /** The last geometry a visible terminal measured, for sessions spawned
   *  without a tab of their own to measure. */
  const setGeometry = useSetAtom(agentGeometryAtom)
  if (id === undefined) return null
  return (
    <>
      <SessionTerminal
        terminalId={id}
        visible={visible}
        onGeometry={(cols, rows) => setGeometry({ cols, rows })}
      />
      <AgentTurnChip terminalId={id} />
    </>
  )
}
