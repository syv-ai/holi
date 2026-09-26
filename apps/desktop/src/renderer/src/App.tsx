import { useAtomValue, useSetAtom } from 'jotai'
import { useEffect, useState } from 'react'
import { OnboardingRitual } from '@/features/onboarding/OnboardingRitual'
import { SignIn } from './features/auth/SignIn'
import { Shell } from './components/Shell'
import { useColorScheme } from './state/color-scheme'
import { useEditorFont } from './state/editor-font'
import { loadSessionAtom, sessionAtom } from './state/session'
import { loadVaultsAtom, vaultsAtom, vaultsLoadedAtom } from './state/vaults'

export function App() {
  const session = useAtomValue(sessionAtom)
  const vaults = useAtomValue(vaultsAtom)
  const vaultsLoaded = useAtomValue(vaultsLoadedAtom)
  const loadSession = useSetAtom(loadSessionAtom)
  const loadVaults = useSetAtom(loadVaultsAtom)

  // Stamped from the root, not from Shell: the sign-in screen and the ritual are
  // outside Shell and should still follow the OS rather than being stuck dark.
  useColorScheme()
  useEditorFont()

  useEffect(() => {
    void loadSession()
  }, [loadSession])
  useEffect(() => {
    if (session) void loadVaults()
  }, [session, loadVaults])

  // Developer → Test onboarding. Subscribed unconditionally: main installs the
  // menu only in dev builds, so the gate lives in one place.
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
