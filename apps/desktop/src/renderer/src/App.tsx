import { useAtomValue, useSetAtom } from 'jotai'
import { useEffect, useState } from 'react'
import { OnboardingRitual } from '@/features/onboarding/OnboardingRitual'
import { SignIn } from './features/auth/SignIn'
import { Shell } from './components/Shell'
import { loadSessionAtom, sessionAtom } from './state/session'
import { loadVaultsAtom, vaultsAtom, vaultsLoadedAtom } from './state/vaults'

export function App() {
  const session = useAtomValue(sessionAtom)
  const vaults = useAtomValue(vaultsAtom)
  const vaultsLoaded = useAtomValue(vaultsLoadedAtom)
  const loadSession = useSetAtom(loadSessionAtom)
  const loadVaults = useSetAtom(loadVaultsAtom)

  useEffect(() => {
    void loadSession()
  }, [loadSession])
  useEffect(() => {
    if (session) void loadVaults()
  }, [session, loadVaults])

  // Developer → Test onboarding: walk the ritual against nothing. Subscribed
  // unconditionally because the channel only ever fires in a dev build — main
  // installs no Developer menu in a packaged app — which keeps the gate in one
  // place instead of two that have to agree.
  const [dryRunOnboarding, setDryRunOnboarding] = useState(false)
  useEffect(() => window.holi.dev.onTestOnboarding(() => setDryRunOnboarding(true)), [])

  if (session === undefined) return null // loading keychain
  if (session === null) return <SignIn />
  if (!vaultsLoaded) return null // loading vault list
  if (vaults.length === 0) return <OnboardingRitual mode="first-run" />
  // Over the top of a running Shell, so the ritual can be walked without
  // disturbing the vault that is open behind it.
  if (dryRunOnboarding) {
    return (
      <>
        <Shell />
        <OnboardingRitual mode="first-run" dryRun onDismiss={() => setDryRunOnboarding(false)} />
      </>
    )
  }
  return <Shell />
}
