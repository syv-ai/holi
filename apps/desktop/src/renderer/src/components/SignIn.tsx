import { useSetAtom } from 'jotai'
import { useState } from 'react'
import { sessionAtom } from '../state/session'

export function SignIn() {
  const setSession = useSetAtom(sessionAtom)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [devToken, setDevToken] = useState('')

  async function run(fn: () => Promise<Awaited<ReturnType<typeof window.holi.auth.signIn>>>) {
    setBusy(true)
    setError(null)
    const res = await fn()
    setBusy(false)
    if (res.ok) setSession(res.data)
    else setError(res.message)
  }

  return (
    <div className="flex h-screen flex-col items-center justify-center gap-4 bg-neutral-950 text-neutral-100">
      <h1 className="text-3xl font-semibold tracking-tight">Holi</h1>
      <button
        className="rounded bg-white px-4 py-2 text-sm font-medium text-neutral-900 hover:bg-neutral-200 disabled:opacity-50"
        disabled={busy}
        onClick={() => run(() => window.holi.auth.signIn())}
      >
        {busy ? 'Waiting for browser…' : 'Sign in with Google'}
      </button>
      {import.meta.env.DEV && (
        <form
          className="flex items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault()
            if (devToken.trim()) void run(() => window.holi.auth.devSignIn(devToken.trim()))
          }}
        >
          <input
            className="w-72 rounded border border-neutral-700 bg-neutral-900 px-2 py-1 text-xs"
            placeholder="dev session token (scripts/seed-dev.ts)"
            value={devToken}
            onChange={(e) => setDevToken(e.target.value)}
          />
          <button className="rounded bg-neutral-800 px-2 py-1 text-xs hover:bg-neutral-700" disabled={busy}>
            dev sign-in
          </button>
        </form>
      )}
      {error && <p className="max-w-md text-center text-xs text-red-400">{error}</p>}
    </div>
  )
}
