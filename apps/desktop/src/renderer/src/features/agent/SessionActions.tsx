/**
 * An assistant tab's own actions, in its pane's tab bar where a note keeps its
 * version history: another session beside this one, or the overview, Claude
 * Code's own picker of the vault's past sessions, in a new tab.
 */
import { useSetAtom } from 'jotai'
import { LayoutList, Plus } from 'lucide-react'
import { IconButton } from '@/primitives'
import { startSessionAtom } from '@/state/agent-send'

export function SessionActions(): React.JSX.Element {
  const startSession = useSetAtom(startSessionAtom)
  return (
    <>
      <IconButton
        icon={LayoutList}
        label="Open overview"
        className="ml-1"
        data-session-overview=""
        onClick={() => void startSession({ resume: true })}
      />
      <IconButton
        icon={Plus}
        label="Start another session"
        className="ml-1"
        data-session-new=""
        onClick={() => void startSession()}
      />
    </>
  )
}
