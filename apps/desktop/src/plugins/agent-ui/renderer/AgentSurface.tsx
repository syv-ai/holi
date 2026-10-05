/**
 * The agents page, kept mounted while hidden (`Surface.keepMounted`): a chat
 * keeps its draft and its place in the conversation, and the terminal behind
 * it its scrollback, for the moment a dialog needs it.
 */
import { AgentOverview } from './AgentOverview'

export function AgentSurface({ visible }: { id?: string; visible: boolean }): React.JSX.Element {
  return <AgentOverview visible={visible} />
}
