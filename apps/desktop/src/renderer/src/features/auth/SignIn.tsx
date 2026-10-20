/**
 * The device flow: press once, read a code, type it into a browser that is
 * already signed in to GitHub. One centred column on the plain page, the
 * same ground as the app it opens into; the code replaces the button in
 * place, with a fade as its one entrance.
 *
 * **Two phases, one screen.** `auth.signIn` returns the code to show and opens
 * the browser itself (the URI GitHub handed back, never a hardcoded one).
 * `auth.awaitSignIn` then holds its request open until GitHub answers, so this
 * component makes one call and waits rather than polling `auth.status`.
 *
 * The token never arrives here. `awaitSignIn` resolves with the viewer and
 * nothing else; the credential stops in main and goes to the keychain.
 */
import { SiGithub } from '@icons-pack/react-simple-icons'
import { useSetAtom } from 'jotai'
import { Check, Copy } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { BrandMark } from '@/composites'
import {
  Button,
  Icon,
  IconButton,
  InputOTP,
  InputOTPGroup,
  InputOTPSeparator,
  InputOTPSlot,
} from '@/primitives'
import { trpc } from '@/lib/trpc'
import { sessionAtom } from '@/state/session'

type Phase =
  | { kind: 'idle' }
  | { kind: 'starting' }
  | { kind: 'waiting'; userCode: string; verificationUri: string }
  /** `denied` is the user pressing Cancel on github.com: a normal outcome, and
   *  worded as one. `expired` is the code timing out. Both, like `failed`,
   *  put the button back as "Try again". */
  | { kind: 'denied' }
  | { kind: 'expired' }
  | { kind: 'failed'; message: string }

const FINE_GRAINED_TOKEN_DOCS =
  'https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens#creating-a-fine-grained-personal-access-token'

export function SignIn() {
  const setSession = useSetAtom(sessionAtom)
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' })
  const [copied, setCopied] = useState(false)
  const running = useRef(false)
  /** Which press of the button is current. Cancel returns to the button at
   *  once, but main only notices at its next poll, so the older flow's
   *  `cancelled` can land after a new press; it must not overwrite that one. */
  const attempt = useRef(0)
  /** Held so the "Copied" tick reverts even if the flow resolves first, and is
   *  cleared on unmount rather than firing setState into a dead component. */
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // A flow left running holds a polling loop in main against a code nobody is
  // going to type, so cancel on unmount.
  useEffect(
    () => () => {
      if (running.current) void trpc.auth.cancelSignIn.mutate()
      if (copiedTimer.current) clearTimeout(copiedTimer.current)
    },
    [],
  )

  // The clipboard write can reject (no permission, headless). That must never
  // escape into the sign-in flow; the code is on screen to type by hand.
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
    const mine = ++attempt.current
    setPhase({ kind: 'starting' })
    running.current = true
    try {
      const code = await trpc.auth.signIn.mutate()
      if (mine !== attempt.current) return
      setPhase({ kind: 'waiting', userCode: code.userCode, verificationUri: code.verificationUri })
      const result = await trpc.auth.awaitSignIn.mutate()
      if (mine !== attempt.current) return
      running.current = false
      if (result.kind === 'granted') setSession(result.viewer)
      // `cancelled` is US stopping (an unmount, or a second sign-in
      // superseding this one), so it goes quietly back to the button.
      else if (result.kind === 'cancelled') setPhase({ kind: 'idle' })
      else setPhase({ kind: result.kind })
    } catch (err) {
      if (mine !== attempt.current) return
      running.current = false
      setPhase({ kind: 'failed', message: err instanceof Error ? err.message : String(err) })
    }
  }

  function cancel() {
    attempt.current++
    running.current = false
    setPhase({ kind: 'idle' })
    void trpc.auth.cancelSignIn.mutate()
  }

  return (
    <div className="flex h-screen w-full flex-col overflow-y-auto bg-background text-foreground">
      <header className="flex shrink-0 items-center px-6 py-5">
        <BrandMark />
      </header>

      <main className="flex flex-1 items-center justify-center px-6 py-12">
        <div className="flex w-full max-w-sm flex-col items-center gap-8 text-center">
          <div className="flex flex-col gap-2">
            <h1 className="text-xl font-semibold tracking-tight">Sign in to Holi</h1>
            <p className="text-sm text-balance text-muted-foreground">
              {phase.kind === 'waiting'
                ? 'Enter this code on GitHub to finish signing in.'
                : 'Holi keeps your notes, tasks and agent in a GitHub repository on this computer. Sign in with GitHub to start.'}
            </p>
          </div>

          {phase.kind === 'waiting' ? (
            <Waiting
              userCode={phase.userCode}
              verificationUri={phase.verificationUri}
              copied={copied}
              onCopy={() => void copyCode(phase.userCode)}
              onCancel={cancel}
            />
          ) : (
            <div className="flex w-full flex-col items-center gap-3">
              <Button
                size="lg"
                className="w-full"
                disabled={phase.kind === 'starting'}
                onClick={() => void start()}
              >
                <Icon icon={SiGithub} size="sm" />
                {phase.kind === 'starting'
                  ? 'Opening GitHub…'
                  : phase.kind === 'idle'
                    ? 'Continue with GitHub'
                    : 'Try again'}
              </Button>
              <Outcome phase={phase} />
            </div>
          )}

          {/* Sign-in grants a broad `repo` token (docs/features/auth.md); a
              fine-grained PAT is the tighter option, so the screen says so.
              Informational only: the device flow is the sole sign-in path. */}
          <p className="text-xs text-pretty text-muted-foreground">
            Holi requests broad repo access.{' '}
            <Button
              variant="link"
              className="h-auto p-0 text-xs"
              onClick={() => void window.holi.openExternal(FINE_GRAINED_TOKEN_DOCS)}
            >
              Prefer a fine-grained token?
            </Button>
          </p>
        </div>
      </main>

      <footer className="shrink-0 px-6 pt-4 pb-6">
        <p className="text-center text-xs text-muted-foreground">
          Holi has no server. Your GitHub token is encrypted on this computer and used only to talk
          to GitHub.
        </p>
      </footer>
    </div>
  )
}

/** The code GitHub issued, shown one character per slot. Read-only: the code
 *  is typed on github.com, never here, so the slots are a display that keeps
 *  the code selectable and copyable. GitHub's codes are `XXXX-XXXX`; each
 *  hyphen-separated group becomes a slot group. */
function Waiting({
  userCode,
  verificationUri,
  copied,
  onCopy,
  onCancel,
}: {
  userCode: string
  verificationUri: string
  copied: boolean
  onCopy: () => void
  onCancel: () => void
}) {
  const parts = userCode.split('-')
  const chars = parts.join('')
  const groups = parts.map((text, i) => ({ text, start: parts.slice(0, i).join('').length }))

  return (
    <div className="flex flex-col items-center gap-4 motion-in-fade">
      <div className="flex items-center gap-2">
        <InputOTP
          aria-label="GitHub device code"
          value={chars}
          maxLength={chars.length}
          readOnly
          containerClassName="font-mono"
        >
          {groups.map(({ text, start }, g) => (
            <div key={g} className="contents">
              {g > 0 && <InputOTPSeparator />}
              <InputOTPGroup>
                {[...text].map((_, i) => (
                  <InputOTPSlot key={i} index={start + i} />
                ))}
              </InputOTPGroup>
            </div>
          ))}
        </InputOTP>
        <IconButton
          icon={copied ? Check : Copy}
          label="Copy code"
          tooltip={copied ? 'Copied' : 'Copy code'}
          size="md"
          onClick={onCopy}
        />
      </div>
      <Button
        variant="link"
        className="h-auto p-0 text-xs"
        onClick={() => void window.holi.openExternal(verificationUri)}
      >
        Open {verificationUri.replace(/^https?:\/\//, '')}
      </Button>
      <div className="flex w-full items-center justify-between gap-2">
        <p className="flex items-center gap-2 text-xs text-muted-foreground">
          <span className="size-1.5 rounded-full bg-primary motion-pulse" aria-hidden="true" />
          Waiting for you to approve…
        </p>
        <Button variant="ghost" size="sm" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  )
}

function Outcome({ phase }: { phase: Phase }) {
  if (phase.kind === 'denied')
    return (
      <p className="text-center text-xs text-muted-foreground">Sign-in was cancelled on GitHub.</p>
    )
  if (phase.kind === 'expired')
    return (
      <p className="text-center text-xs text-muted-foreground">
        That code expired. Try again for a new one.
      </p>
    )
  if (phase.kind === 'failed')
    return (
      <p role="alert" className="text-center text-xs text-destructive">
        {phase.message}
      </p>
    )
  return null
}
