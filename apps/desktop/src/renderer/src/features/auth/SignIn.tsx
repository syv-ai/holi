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
import { Check, Copy } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { Button, Tooltip } from '@/primitives'
import { trpc } from '@/lib/trpc'
import { sessionAtom } from '@/state/session'

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
  const [copied, setCopied] = useState(false)
  const running = useRef(false)
  /** Held so the "Copied" tick reverts even if the flow resolves first, and is
   *  cleared on unmount rather than firing setState into a dead component. */
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // A flow left running holds a polling loop in main against a code nobody is
  // going to type. Cancelling is cheap; leaking one costs a request every few
  // seconds until it expires.
  useEffect(
    () => () => {
      if (running.current) void trpc.auth.cancelSignIn.mutate()
      if (copiedTimer.current) clearTimeout(copiedTimer.current)
    },
    [],
  )

  // The clipboard write can reject (no permission, headless) — that must never
  // escape into the sign-in flow, so it stays local and silent; the code is on
  // screen to type by hand regardless.
  async function copyCode(code: string) {
    try {
      await navigator.clipboard.writeText(code)
      setCopied(true)
      if (copiedTimer.current) clearTimeout(copiedTimer.current)
      copiedTimer.current = setTimeout(() => setCopied(false), 1500)
    } catch {
      // no-op: the visible code is the fallback
    }
  }

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
    <div className="flex h-screen flex-col items-center justify-center gap-6 bg-background text-foreground">
      <h1 className="text-3xl font-semibold tracking-tight">Holi</h1>

      {phase.kind === 'waiting' ? (
        <div className="flex flex-col items-center gap-3">
          <p className="text-sm text-muted-foreground">Enter this code on GitHub</p>
          <div className="flex items-center gap-2">
            <code className="rounded border border-border bg-muted px-4 py-2 font-mono text-2xl tracking-[0.3em]">
              {phase.userCode}
            </code>
            <Tooltip content={copied ? 'Copied' : 'Copy code'}>
              <Button
                variant="ghost"
                size="icon"
                aria-label="Copy code"
                onClick={() => void copyCode(phase.userCode)}
              >
                {copied ? <Check className="text-brand" /> : <Copy />}
              </Button>
            </Tooltip>
          </div>
          <Button
            variant="link"
            className="h-auto p-0 text-xs text-muted-foreground hover:text-foreground"
            onClick={() => void window.holi.openExternal(phase.verificationUri)}
          >
            {phase.verificationUri}
          </Button>
          <p className="text-xs text-muted-foreground">Waiting for you to approve…</p>
        </div>
      ) : (
        <div className="flex flex-col items-center gap-3">
          {/* The GitHub-style white CTA, kept deliberately (there is no inverse/white
              token; bg-white/neutral are named utilities, so the colour gate allows them). */}
          <Button
            className="bg-white text-neutral-900 hover:bg-neutral-200"
            disabled={phase.kind === 'starting'}
            onClick={() => void start()}
          >
            {phase.kind === 'starting' ? 'Opening GitHub…' : 'Sign in with GitHub'}
          </Button>
          {/* Sign-in grants a broad `repo` token (auth-identity.md §176); a
              fine-grained PAT scoped to selected repos is the tighter option, so
              the screen says so. Informational only — there is no PAT-paste flow;
              the device flow is the sole sign-in path. */}
          <p className="max-w-xs text-center text-xs text-muted-foreground">
            Holi requests broad repo access.{' '}
            <Button
              variant="link"
              className="h-auto p-0 text-xs"
              onClick={() =>
                void window.holi.openExternal(
                  'https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens#creating-a-fine-grained-personal-access-token',
                )
              }
            >
              Prefer a fine-grained token?
            </Button>
          </p>
        </div>
      )}

      {phase.kind === 'denied' && (
        <p className="text-xs text-muted-foreground">Sign-in was cancelled on GitHub.</p>
      )}
      {phase.kind === 'expired' && (
        <p className="text-xs text-muted-foreground">That code expired. Press the button for a new one.</p>
      )}
      {phase.kind === 'failed' && (
        <p className="max-w-md text-center text-xs text-destructive">{phase.message}</p>
      )}
    </div>
  )
}
