import { atom, getDefaultStore, useAtom, useAtomValue, useStore } from 'jotai'
import { useCallback, useEffect } from 'react'
import { googleCap } from './google-cap'
import { activeRemoteAtom, activeVaultSettingsAtom, loadVaultSettingsAtom } from '@/plugin-api'

/**
 * Remote-image consent has one source of truth: the loaded vault settings.
 */

/** One-off consent is per vault and message, and lasts only for this app session. */
const unblockedMessagesAtom = atom<ReadonlySet<string>>(new Set<string>())
type Policy = { senders: ReadonlySet<string>; allSenders: boolean }
const policyMutationEpochAtom = atom<Record<string, number>>({})
const vaultSwitchEpochAtom = atom(0)
const policyPendingAtom = atom<Record<string, boolean>>({})

export interface RemoteContentIdentity {
  key: string | null
  sender: string | null
}

export interface RemoteContentChoice {
  allowed: boolean
  sender: string | null
  allowOnce: () => void
  allowSenderAlways: () => Promise<void>
  allowAllSenders: () => Promise<void>
  pending: boolean
}

/** Detect A→B→A while a write is pending, not just the active remote at settle time. */
function useVaultSwitchEpoch(): void {
  const store = useStore()
  useEffect(
    () =>
      store.sub(activeRemoteAtom, () => {
        store.set(vaultSwitchEpochAtom, (epoch) => epoch + 1)
      }),
    [store],
  )
}

/** Malformed/missing settings fail closed, including malformed sender entries. */
function useBasePolicy(): { policy: Policy; ready: boolean } {
  const settings = useAtomValue(activeVaultSettingsAtom)
  const values = settings?.pluginValues.google?.imageSenders
  const all = settings?.pluginValues.google?.imagesFromAllSenders
  const rawSenders = Array.isArray(values)
    ? values.filter((sender): sender is string => typeof sender === 'string')
    : []
  const senders = new Set(rawSenders.map((sender) => sender.trim().toLowerCase()))
  return {
    policy: { senders, allSenders: all === true },
    ready: settings !== null,
  }
}

function useImagePolicy(): Policy {
  const { policy, ready } = useBasePolicy()
  const remote = useAtomValue(activeRemoteAtom)
  if (remote === null || !ready) return { senders: new Set(), allSenders: false }
  return policy
}

function beginPolicyWrite(
  store: ReturnType<typeof useStore>,
  remote: string,
): { mutation: number; vault: number } {
  if (store.get(activeRemoteAtom) !== remote) throw new Error('The selected vault changed')
  if (store.get(policyPendingAtom)[remote]) throw new Error('An image preference is being saved')
  const mutation = (store.get(policyMutationEpochAtom)[remote] ?? 0) + 1
  store.set(policyMutationEpochAtom, (previous) => ({ ...previous, [remote]: mutation }))
  store.set(policyPendingAtom, (previous) => ({ ...previous, [remote]: true }))
  return { mutation, vault: store.get(vaultSwitchEpochAtom) }
}

async function refreshPolicy(
  store: ReturnType<typeof useStore>,
  remote: string,
  epoch: { mutation: number; vault: number },
): Promise<void> {
  if (
    store.get(activeRemoteAtom) !== remote ||
    store.get(policyMutationEpochAtom)[remote] !== epoch.mutation ||
    store.get(vaultSwitchEpochAtom) !== epoch.vault
  )
    return
  await store.set(loadVaultSettingsAtom, {
    force: true,
    invalidatePluginValues: {
      plugin: 'google',
      keys: ['imageSenders', 'imagesFromAllSenders'],
    },
  })
}

function finishPolicyWrite(
  store: ReturnType<typeof useStore>,
  remote: string,
  epoch: number,
): void {
  if (store.get(policyMutationEpochAtom)[remote] !== epoch) return
  store.set(policyPendingAtom, (previous) => ({ ...previous, [remote]: false }))
}

export function useAlwaysAllowedSenders(): Policy {
  return useImagePolicy()
}

export function useMailImagePolicyPending(): boolean {
  const remote = useAtomValue(activeRemoteAtom)
  const pendingByRemote = useAtomValue(policyPendingAtom)
  return remote !== null && pendingByRemote[remote] === true
}

export function useSetAllSenderImages(): (enabled: boolean) => Promise<void> {
  const remote = useAtomValue(activeRemoteAtom)
  const store = useStore()
  useVaultSwitchEpoch()
  return useCallback(
    async (enabled) => {
      if (remote === null) throw new Error('No active vault')
      const epoch = beginPolicyWrite(store, remote)
      try {
        await googleCap.setImagesFromAllSenders(remote, { enabled })
        await refreshPolicy(store, remote, epoch)
      } finally {
        finishPolicyWrite(store, remote, epoch.mutation)
      }
    },
    [remote, store],
  )
}

export function useForgetImageSenders(): () => Promise<void> {
  const remote = useAtomValue(activeRemoteAtom)
  const store = useStore()
  useVaultSwitchEpoch()
  return useCallback(async () => {
    if (remote === null) throw new Error('No active vault')
    const epoch = beginPolicyWrite(store, remote)
    try {
      await googleCap.forgetImageSenders(remote)
      await refreshPolicy(store, remote, epoch)
    } finally {
      finishPolicyWrite(store, remote, epoch.mutation)
    }
  }, [remote, store])
}

export function useRemoteContent(identity: RemoteContentIdentity): RemoteContentChoice {
  const [unblocked, setUnblocked] = useAtom(unblockedMessagesAtom)
  const { policy, ready } = useBasePolicy()
  useVaultSwitchEpoch()
  const remote = useAtomValue(activeRemoteAtom)
  const store = useStore()
  const { key, sender } = identity
  const normalisedSender = sender === null || sender === '' ? null : sender.trim().toLowerCase()
  const messageKey = remote === null || key === null ? null : `${remote}\0${key}`
  const effective = ready ? policy : { senders: new Set<string>(), allSenders: false }
  const pendingByRemote = useAtomValue(policyPendingAtom)
  const pending = remote !== null && pendingByRemote[remote] === true
  const allowed =
    (messageKey !== null && unblocked.has(messageKey)) ||
    (!pending &&
      (effective.allSenders ||
        (normalisedSender !== null && effective.senders.has(normalisedSender))))

  const allowOnce = useCallback(() => {
    if (messageKey !== null) setUnblocked((previous) => new Set(previous).add(messageKey))
  }, [messageKey, setUnblocked])

  const allowSenderAlways = useCallback(async () => {
    if (normalisedSender === null || remote === null) throw new Error('No sender or active vault')
    const epoch = beginPolicyWrite(store, remote)
    try {
      await googleCap.allowImagesFrom(remote, { sender: normalisedSender })
      await refreshPolicy(store, remote, epoch)
    } finally {
      finishPolicyWrite(store, remote, epoch.mutation)
    }
  }, [normalisedSender, remote, store])

  const allowAllSenders = useCallback(async () => {
    if (remote === null) throw new Error('No active vault')
    const epoch = beginPolicyWrite(store, remote)
    try {
      await googleCap.setImagesFromAllSenders(remote, { enabled: true })
      await refreshPolicy(store, remote, epoch)
    } finally {
      finishPolicyWrite(store, remote, epoch.mutation)
    }
  }, [remote, store])

  return {
    allowed,
    sender: normalisedSender,
    allowOnce,
    allowSenderAlways,
    allowAllSenders,
    pending,
  }
}

/** @public Reset session consent between tests. */
export function resetMailImagesForTests(): void {
  const store = getDefaultStore()
  store.set(unblockedMessagesAtom, new Set<string>())
  store.set(policyMutationEpochAtom, {})
  store.set(vaultSwitchEpochAtom, 0)
  store.set(policyPendingAtom, {})
}
