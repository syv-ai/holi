/**
 * Where this machine lists the vault's sessions (`sessionList`, a local
 * setting of the plugin): the stack of bubbles over every tab, or rows in the
 * sidebar. The notices float in the top right either way.
 */
import { usePluginSetting } from '@/plugin-api'
import { AGENT_UI_INFO, type SessionList } from '../../info'

export function useSessionList(): SessionList {
  return usePluginSetting(AGENT_UI_INFO, 'sessionList') === 'sidebar' ? 'sidebar' : 'bubbles'
}
