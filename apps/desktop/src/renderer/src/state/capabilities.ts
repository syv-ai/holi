/**
 * Which capabilities the open vault offers at the UI door
 * (docs/architecture.md, Plugins): what a plugin asks before offering a call
 * into another plugin, such as `useHasCapability('tasks.create')` hiding a
 * "Make a task" button in a vault with tasks off.
 *
 * Asked once per vault and per set of enabled plugins, so turning a plugin on
 * or off asks again, and nothing else does.
 */
import { atom, useAtomValue } from 'jotai'
import { loadable } from 'jotai/utils'
import { trpc } from '@/lib/trpc'
import { enabledPluginsAtom } from './plugins'
import { activeRemoteAtom } from './vaults'

/** The enabled set as one string, so an equal set is an equal value and the
 *  names are not fetched again when the settings are re-read unchanged. */
const enabledKeyAtom = atom((get) => [...get(enabledPluginsAtom)].sort().join(','))

const NONE: ReadonlySet<string> = new Set()

const capabilityNamesAtom = atom(async (get): Promise<ReadonlySet<string>> => {
  const remote = get(activeRemoteAtom)
  get(enabledKeyAtom)
  if (remote === null) return NONE
  return new Set(await trpc.cap.names.query({ remote }))
})

const loadedNamesAtom = loadable(capabilityNamesAtom)

/** Whether the open vault offers `name` at the UI door. False until known,
 *  and when the question fails. */
export function useHasCapability(name: string): boolean {
  return useCapabilityAvailability(name) === 'available'
}

/** Preserve the distinction between a confirmed refusal and a capability
 *  lookup that has not completed (or failed), for flows that can degrade. */
export function useCapabilityAvailability(name: string): 'available' | 'unavailable' | 'unknown' {
  const names = useAtomValue(loadedNamesAtom)
  if (names.state !== 'hasData') return 'unknown'
  return names.data.has(name) ? 'available' : 'unavailable'
}
