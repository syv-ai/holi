/**
 * An agent tab's own actions, in its pane's tab bar where a note keeps its
 * version history: a new overview (Claude Code's agent list; ⌘J and the agent
 * icon focus the one already open instead), or another session in a tab of its
 * own.
 */
import { useSetAtom } from 'jotai'
import { LayoutList, Plus } from 'lucide-react'
import { IconButton } from '@/primitives'
import { openOverviewAtom, startSessionAtom } from '@/state/agent-send'

export function SessionActions(): React.JSX.Element {
  const startSession = useSetAtom(startSessionAtom)
  const openOverview = useSetAtom(openOverviewAtom)
  return (
    <>
      <IconButton
        icon={LayoutList}
        label="Open overview"
        className="ml-1"
        data-session-overview=""
        onClick={() => void openOverview()}
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
