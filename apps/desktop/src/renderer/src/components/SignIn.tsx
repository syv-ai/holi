/**
 * The device flow, as a ritual: press once, read a code, type it into a browser
 * that is already signed in to GitHub.
 *
 * **Two phases, one screen.** `auth.signIn` returns the code to show and opens
 * the browser itself — the URI GitHub handed back, never a hardcoded one.
 * `auth.awaitSignIn` then holds its request open until GitHub answers, so this
 * component makes one call and waits rather than polling `auth.status` and
 * guessing when to stop. The comment above `signInFlow` in `main/router.ts`
 * explains why the router is shaped that way.
 *
 * The token never arrives here. `awaitSignIn` resolves with the viewer and
 * nothing else; the credential stops in main and goes to the keychain.
 */
import { useSetAtom } from 'jotai'
import { useEffect, useRef, useState } from 'react'
import { trpc } from '../lib/trpc'
import { sessionAtom } from '../state/session'

type Phase =
  | { kind: 'idle' }
  | { kind: 'starting' }
  | { kind: 'waiting'; userCode: string; verificationUri: string }
  /** `denied` is the user pressing Cancel on github.com — a normal outcome, and
   *  worded as one. `expired` is the code timing out, and only that one offers
   *  to start again, because only that one is worth repeating unchanged. */
  | { kind: 'denied' }
  | { kind: 'expired' }
  | { kind: 'failed'; message: string }

export function SignIn() {
  const setSession = useSetAtom(sessionAtom)
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' })
  const running = useRef(false)

  // A flow left running holds a polling loop in main against a code nobody is
  // going to type. Cancelling is cheap; leaking one costs a request every few
  // seconds until it expires.
  useEffect(
    () => () => {
      if (running.current) void trpc.auth.cancelSignIn.mutate()
    },
    [],
  )

  async function start() {
    setPhase({ kind: 'starting' })
    running.current = true
    try {
      const code = await trpc.auth.signIn.mutate()
      setPhase({ kind: 'waiting', userCode: code.userCode, verificationUri: code.verificationUri })
      const result = await trpc.auth.awaitSignIn.mutate()
      running.current = false
      if (result.kind === 'granted') setSession(result.viewer)
      // `cancelled` is US stopping — an unmount, or a second sign-in
      // superseding this one. The user did nothing and is owed no message, so
      // it goes quietly back to the button rather than reporting a refusal
      // they never made.
      else if (result.kind === 'cancelled') setPhase({ kind: 'idle' })
      else setPhase({ kind: result.kind })
    } catch (err) {
      running.current = false
      setPhase({ kind: 'failed', message: err instanceof Error ? err.message : String(err) })
    }
  }

  return (
    <div className="flex h-screen flex-col items-center justify-center gap-6 bg-neutral-950 text-neutral-100">
      <h1 className="text-3xl font-semibold tracking-tight">Holi</h1>

      {phase.kind === 'waiting' ? (
        <div className="flex flex-col items-center gap-3">
          <p className="text-sm text-neutral-400">Enter this code on GitHub</p>
          <code className="rounded border border-neutral-700 bg-neutral-900 px-4 py-2 font-mono text-2xl tracking-[0.3em]">
            {phase.userCode}
          </code>
          <button
            className="text-xs text-neutral-500 underline hover:text-neutral-300"
            onClick={() => void window.holi.openExternal(phase.verificationUri)}
          >
            {phase.verificationUri}
          </button>
          <p className="text-xs text-neutral-600">Waiting for you to approve…</p>
        </div>
      ) : (
        <button
          className="rounded bg-white px-4 py-2 text-sm font-medium text-neutral-900 hover:bg-neutral-200 disabled:opacity-50"
          disabled={phase.kind === 'starting'}
          onClick={() => void start()}
        >
          {phase.kind === 'starting' ? 'Opening GitHub…' : 'Sign in with GitHub'}
        </button>
      )}

      {phase.kind === 'denied' && (
        <p className="text-xs text-neutral-400">Sign-in was cancelled on GitHub.</p>
      )}
      {phase.kind === 'expired' && (
        <p className="text-xs text-neutral-400">That code expired. Press the button for a new one.</p>
      )}
      {phase.kind === 'failed' && (
        <p className="max-w-md text-center text-xs text-red-400">{phase.message}</p>
      )}
    </div>
  )
}
