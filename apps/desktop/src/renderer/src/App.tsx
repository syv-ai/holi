import { useAtomValue, useSetAtom } from 'jotai'
import { useEffect } from 'react'
import { OnboardingRitual } from './components/OnboardingRitual'
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

  if (session === undefined) return null // loading keychain
  if (session === null) return <SignIn />
  if (!vaultsLoaded) return null // loading vault list
  if (vaults.length === 0) return <OnboardingRitual mode="first-run" />
  return <Shell />
}
