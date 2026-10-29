/**
 * The settings pages' read and write of the open vault's settings files.
 *
 * **On the cache, not on local state** (`vaultSettingsAtom`): only one page
 * is mounted at a time, and a local copy would be re-read on every nav click.
 * The write is `settings.write`, the onboarding ritual's writer too, so a
 * value the page sends meets the same validator a teammate's committed file
 * does. Optimistic, because a control that lags its click reads as broken;
 * the forced re-read after it is what makes it true.
 */
import { useAtomValue, useSetAtom } from 'jotai'
import { useCallback, useEffect } from 'react'
import { toast } from 'sonner'
import type { ResolvedVaultSettings, SettingTarget, VaultSettingKey } from '@holi/shared'

import { trpc } from '@/lib/trpc'
import { loadVaultSettingsAtom, vaultSettingsAtom } from '@/state/settings'
import { activeRemoteAtom } from '@/state/vaults'

export type SettingsWrite = (
  key: VaultSettingKey | 'plugins',
  value: unknown,
  target: SettingTarget,
) => Promise<void>

export function useVaultSettings(): {
  /** `null` until the open vault's settings are read, never another vault's. */
  resolved: ResolvedVaultSettings | null
  write: SettingsWrite
} {
  const remote = useAtomValue(activeRemoteAtom)
  const cached = useAtomValue(vaultSettingsAtom)
  const setCached = useSetAtom(vaultSettingsAtom)
  const load = useSetAtom(loadVaultSettingsAtom)

  useEffect(() => {
    load().catch((error: unknown) => console.warn('[settings] read failed:', error))
  }, [load, remote])

  const resolved = cached !== null && cached.remote === remote ? cached.settings : null

  const write = useCallback<SettingsWrite>(
    async (key, value, target) => {
      if (remote === null || resolved === null) return
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
