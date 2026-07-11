import { useAtomValue, useSetAtom } from 'jotai'
import { useEffect } from 'react'
import { SignIn } from './components/SignIn'
import { Shell } from './components/Shell'
import { loadSessionAtom, sessionAtom } from './state/session'

export function App() {
  const session = useAtomValue(sessionAtom)
  const loadSession = useSetAtom(loadSessionAtom)
  useEffect(() => {
    void loadSession()
  }, [loadSession])

  if (session === undefined) return null // loading keychain
  if (session === null) return <SignIn />
  return <Shell />
}
