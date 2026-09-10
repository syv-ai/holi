/**
 * The settings tab's shared read and write, for whichever section is on screen.
 *
 * **On the atom, not on local state.** The tab used to be one component holding
 * one `useState` of the resolved settings; with a rail there are several section
 * components and only one is mounted at a time, so a local copy would be re-read
 * from scratch on every rail click and two sections could disagree about the
 * same value. `vaultSettingsAtom` already exists, already caches per vault, and
 * already has the forced re-read the pane needs to see its own write.
 *
 * The write is still `settings.write` — the onboarding ritual's only writer — so
 * the two surfaces cannot drift into writing different shapes.
 */
import { useCallback, useEffect, useState } from 'react'
import { useAtomValue, useSetAtom } from 'jotai'
import {
  VAULT_SETTING_DESCRIPTORS,
  type ResolvedVaultSettings,
  type VaultSettingDescriptor,
} from '@holi/shared'
import { trpc } from '@/lib/trpc'
import { loadVaultSettingsAtom, vaultSettingsAtom } from '@/state/settings'
import { activeRemoteAtom } from '@/state/vaults'

export interface VaultSettingsHandle {
  /** `null` until the first read lands, or while the cache still holds another
   *  vault's answer — never the previous vault's settings. */
  resolved: ResolvedVaultSettings | null
  /** The same object, indexable by descriptor key. */
  values: Record<string, unknown>
  /** The last write's refusal, if it was refused. */
  error: string | null
  change: (descriptor: VaultSettingDescriptor, value: unknown) => Promise<void>
  /** The resolver's warnings that name this key. */
  warningsFor: (key: string) => string[]
  /** Warnings naming no descriptor at all, which would otherwise be dropped. */
  unattributed: string[]
}

export function useVaultSettings(): VaultSettingsHandle {
  const remote = useAtomValue(activeRemoteAtom)
  const cached = useAtomValue(vaultSettingsAtom)
  const setCached = useSetAtom(vaultSettingsAtom)
  const load = useSetAtom(loadVaultSettingsAtom)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    void load()
  }, [load, remote])

  // The guard that makes a vault switch safe: the cache is keyed by remote, so a
  // mismatch means "not read yet" rather than "here is the last vault's answer".
  const resolved = cached !== null && cached.remote === remote ? cached.settings : null

  const change = useCallback(
    async (descriptor: VaultSettingDescriptor, value: unknown): Promise<void> => {
      if (remote === null || resolved === null) return
      setError(null)
      // Optimistic, because a control that lags a click reads as a broken
      // control. The forced re-read below is what makes it true.
      setCached({ remote, settings: { ...resolved, [descriptor.key]: value } })
      const patch = JSON.stringify({ [descriptor.key]: value })
      try {
        // `fields` validates strings and booleans only, so the patch travels as
        // text and is parsed in main through the same validator that guards a
        // committed file a teammate wrote.
        const result = await trpc.settings.write.mutate({
          remote,
          ...(descriptor.target === 'committed' ? { committedJson: patch } : { localJson: patch }),
        })
        if (result.warnings.length > 0) setError(result.warnings.join('; '))
      } catch (err) {
        setError(err instanceof Error ? err.message : 'could not write the settings file')
      }
      // Force, not read: the point of the pane is to see your own write, and
      // everything reading the atom re-renders with it — which is what makes
      // appearance and the editor font apply as you click.
      await load({ force: true })
    },
    [remote, resolved, setCached, load],
  )

  const warningsFor = useCallback(
    (key: string): string[] => (resolved?.warnings ?? []).filter((w) => w.includes(`"${key}"`)),
    [resolved],
  )

  return {
    resolved,
    values: (resolved ?? {}) as unknown as Record<string, unknown>,
    error,
    change,
    warningsFor,
    unattributed: (resolved?.warnings ?? []).filter(
      (w) => !VAULT_SETTING_DESCRIPTORS.some((d) => w.includes(`"${d.key}"`)),
    ),
  }
}
