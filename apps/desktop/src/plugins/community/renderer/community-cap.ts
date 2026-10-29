/**
 * The community plugin's capabilities, as the renderer calls them
 * (`../main/capabilities.ts`), and the one core call its settings tab makes:
 * the vault's `plugins.<id>` switches.
 */
import { capClient, trpc } from '@/plugin-api'
import type { communityCapabilities } from '../main/capabilities'

export const communityCap = capClient<ReturnType<typeof communityCapabilities>>('community')

/** Turn a plugin's `plugins.<id>` switch on or off in the vault's committed
 *  settings, beside the other plugins'. */
export async function setPluginSwitch(remote: string, id: string, on: boolean): Promise<void> {
  const settings = await trpc.settings.read.query({ remote })
  await trpc.settings.write.mutate({
    remote,
    committedJson: JSON.stringify({ plugins: { ...settings.plugins.vault, [id]: on } }),
  })
}
