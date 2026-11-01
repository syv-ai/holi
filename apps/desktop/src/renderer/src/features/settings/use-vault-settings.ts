/**
 * The settings pages' read and write of the open vault's settings files.
 *
 * **On the cache, not on local state** (`vaultSettingsAtom`): only one page
 * is mounted at a time, and a local copy would be re-read on every nav click.
 * The write is `settings.write`, the onboarding ritual's writer too, so a
 * value the page sends meets the same validator a teammate's committed file
 * does. Optimistic, because a control that lags its click reads as broken;
 * the forced re-read after it is what makes it true.
 *
 * **Which file is the setting's own answer** (`target` in `VAULT_SETTINGS`),
 * never the caller's: an override of how Holi looks or behaves for you goes
 * to the local file, the vault's content and sync settings to the committed
 * one (docs/features/settings.md).
 */
import { useAtomValue, useSetAtom } from 'jotai'
import { useCallback, useEffect } from 'react'
import { toast } from 'sonner'
import {
  VAULT_SETTING_DESCRIPTORS,
  type ResolvedVaultSettings,
  type VaultSettingKey,
} from '@holi/shared'

import { trpc } from '@/lib/trpc'
import { activeVaultSettingsAtom, loadVaultSettingsAtom, vaultSettingsAtom } from '@/state/settings'
import { activeRemoteAtom } from '@/state/vaults'

export type SettingsWrite = (key: VaultSettingKey | 'plugins', value: unknown) => Promise<void>

export function useVaultSettings(): {
  /** `null` until the open vault's settings are read, never another vault's. */
  resolved: ResolvedVaultSettings | null
  write: SettingsWrite
} {
  const remote = useAtomValue(activeRemoteAtom)
  const resolved = useAtomValue(activeVaultSettingsAtom)
  const setCached = useSetAtom(vaultSettingsAtom)
  const load = useSetAtom(loadVaultSettingsAtom)

  useEffect(() => {
    load().catch((error: unknown) => console.warn('[settings] read failed:', error))
  }, [load, remote])

  const write = useCallback<SettingsWrite>(
    async (key, value) => {
      if (remote === null || resolved === null) return
      const target = VAULT_SETTING_DESCRIPTORS.find((d) => d.key === key)?.target ?? 'committed'
      // The plugins row answers for the vault's half of its resolved value.
      const optimistic =
        key === 'plugins' ? { ...resolved.plugins, vault: value as Record<string, boolean> } : value
      setCached({ remote, settings: { ...resolved, [key]: optimistic } })
      const patch = JSON.stringify({ [key]: value })
      try {
        const result = await trpc.settings.write.mutate({
          remote,
          ...(target === 'committed' ? { committedJson: patch } : { localJson: patch }),
        })
        if (result.warnings.length > 0) {
          toast.error('That setting did not stick.', {
            description: result.warnings.join(' '),
          })
        }
      } catch (error) {
        toast.error("Couldn't save the setting.", {
          description:
            error instanceof Error ? error.message : 'The settings file could not be written.',
        })
      }
      await load({ force: true }).catch(() => undefined)
    },
    [remote, resolved, setCached, load],
  )

  return { resolved, write }
}
