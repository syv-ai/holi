/**
 * The vault's chosen agent by name (Settings, General, Agents), as a sent
 * task's labels say it: "Send to Claude Code", "Sent to Codex". Main's name
 * for it, asked once per vault; "the agent" until it is known.
 */
import { useAtomValue } from 'jotai'
import { agentProviderSettingAtom, useAgentLabel } from '@/plugin-api'

/** What a label calls the agent until main has named it. */
const UNKNOWN = 'the agent'

export function useAgentName(): string {
  return useAgentLabel(useAtomValue(agentProviderSettingAtom)) ?? UNKNOWN
}
