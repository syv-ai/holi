/**
 * An agent tab's own actions, in its pane's tab bar where a note keeps its
 * version history: a new overview (Claude Code's agent list; ⌘J and the agent
 * icon focus the one already open instead), or another session in a tab of its
 * own.
 */
import { useSetAtom } from 'jotai'
import { LayoutList, Plus } from 'lucide-react'
import { openOverviewAtom, startSessionAtom } from './state/send'
import { IconButton } from '@/composites/icon-button'

export function SessionActions(): React.JSX.Element {
  const startSession = useSetAtom(startSessionAtom)
  const openOverview = useSetAtom(openOverviewAtom)
  return (
    <>
      <IconButton
        label="Open overview"
        className="ml-1"
        data-session-overview=""
        onClick={() => void openOverview()}
        size="icon-xs"
      >
        <LayoutList />
      </IconButton>
      <IconButton
        label="Start another session"
        className="ml-1"
        data-session-new=""
        onClick={() => void startSession()}
        size="icon-xs"
      >
        <Plus />
      </IconButton>
    </>
  )
}
