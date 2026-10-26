/**
 * The device flow, as a ritual: press once, read a code, type it into a browser
 * that is already signed in to GitHub. Laid out after ReUI's `auth-5`: a pitch
 * on the left, the one act on the right, over the ambient light. No card: the
 * plain page is already the quiet surface a card would add. Once the flow
 * starts the pitch steps aside and the act glides to the middle of the window,
 * because from then on the code is all that matters.
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
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import { useEffect, useRef, useState } from 'react'
import { BrandMark } from '@/composites/brand-mark'
import { ScreenArcade } from '@/composites/arcade/screen-arcade'
import { Button } from '@/components/ui/button'
import { InputOTP, InputOTPGroup, InputOTPSeparator, InputOTPSlot } from '@/components/ui/input-otp'
import { IconButton } from '@/composites/icon-button'
import { RevealButton } from './reveal-button'
import { cn } from '@/lib/cn'
import { trpc } from '@/lib/trpc'
import { sessionAtom } from '@/state/session'

/** A layout change settling: restrained, a hint of bounce and never a wobble. */
const settle = { type: 'spring', duration: 0.4, bounce: 0.15 } as const
/** What reduced motion swaps in: the change, without the travel. */
const instant = { duration: 0 } as const

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

  const reduced = useReducedMotion() ?? false
  const focused = phase.kind === 'starting' || phase.kind === 'waiting'

  return (
    // The window's own tint (index.css, Glass), with the arcade running
    // under it, as on the New tab.
    <div
      data-glass-ground=""
      className="relative isolate h-screen w-full overflow-hidden bg-background text-foreground"
    >
      <ScreenArcade />

      {/* Only the content scrolls: a scroller reserves its gutter inside
          itself, and the backdrop and grain must reach under it. */}
      <div className="relative h-full overflow-y-auto">
        <div className="flex min-h-full flex-col px-6 py-7 sm:px-12 sm:py-10 lg:px-14 lg:py-12">
          <header className="flex items-center justify-between">
            <BrandMark />
          </header>

          <main
            data-arcade-keepout=""
            className="mx-auto flex w-full max-w-6xl flex-1 items-center py-16 sm:py-20 lg:py-24"
          >
            <div
              className={cn(
                'relative grid w-full grid-cols-1 items-center justify-items-center gap-14 sm:gap-16 lg:gap-24',
                !focused && 'lg:grid-cols-[minmax(0,1fr)_minmax(0,420px)] lg:justify-items-stretch',
              )}
            >
              {/* popLayout takes the leaving pitch out of the grid at once, so
                the pane starts for the middle while the pitch fades. */}
              <AnimatePresence mode="popLayout" initial={false}>
                {!focused && (
                  <motion.div
                    key="pitch"
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    transition={reduced ? instant : settle}
                  >
                    <Pitch />
                  </motion.div>
                )}
              </AnimatePresence>
              <motion.div
                layout="position"
                transition={reduced ? instant : settle}
                className="w-full max-w-[420px]"
              >
                <div className="flex w-full flex-col items-center gap-7 text-center sm:gap-8">
                  <div className="flex flex-col gap-2">
                    <h2 className="text-xl font-semibold tracking-tight">Sign in to Holi</h2>
                    <p className="text-sm text-balance text-muted-foreground">
                      {phase.kind === 'waiting'
                        ? 'Enter this code on GitHub to finish signing in.'
                        : 'Use your GitHub account. Holi opens GitHub in your browser to confirm.'}
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
                    <div className="flex flex-col items-center gap-3">
                      {/* The mark at rest, the words on hover. Anything but the
                        first offer stays open, because a status or "Try again"
                        must be read without reaching for it. */}
                      <RevealButton
                        icon={SiGithub}
                        open={phase.kind !== 'idle'}
                        disabled={phase.kind === 'starting'}
                        onClick={() => void start()}
                        label={
                          phase.kind === 'starting'
                            ? 'Opening GitHub…'
                            : phase.kind === 'idle'
                              ? 'Continue with GitHub'
                              : 'Try again'
                        }
                      />
                      <Outcome phase={phase} />
                    </div>
                  )}

                  {/* Sign-in grants a broad `repo` token (docs/features/auth.md); a
                    fine-grained PAT is the tighter option, so the screen says so.
                    Informational only: the device flow is the sole sign-in path. */}
                  <p className="text-center text-xs text-pretty text-muted-foreground">
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
              </motion.div>
            </div>
          </main>

          <footer className="mx-auto w-full max-w-6xl pt-10 pb-6 sm:pt-14">
            <p className="text-center text-xs text-muted-foreground">
              Holi has no server. Your GitHub token is encrypted on this computer and used only to
              talk to GitHub.
            </p>
          </footer>
        </div>
      </div>
    </div>
  )
}

function Pitch() {
  return (
    <div className="flex max-w-xl flex-col gap-7 sm:gap-8">
      <div className="inline-flex w-fit items-center gap-2 rounded-full border border-border/60 bg-background/80 px-3 py-1 text-sm font-medium tracking-tight text-foreground/70 backdrop-blur-sm">
        <span className="size-1.5 rounded-full bg-primary" aria-hidden="true" />
        <span>Local-first notes on GitHub</span>
      </div>
      <h1 className="text-4xl leading-[1.02] font-semibold tracking-[-0.02em] text-balance sm:text-5xl lg:text-[56px]">
        Your notes, in a repo you{' '}
        <span className="bg-linear-to-r from-orange-500 via-pink-500 to-violet-500 bg-clip-text text-transparent">
          own
        </span>
        .
      </h1>
      <p className="max-w-xl text-base leading-relaxed text-pretty text-muted-foreground sm:text-lg">
        Holi keeps your notes, tasks and agent in a markdown vault: a GitHub repository cloned to
        this computer. It works offline and syncs when you are back.
      </p>
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
        <IconButton label="Copy code" tooltip={copied ? 'Copied' : 'Copy code'} onClick={onCopy}>
          {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
        </IconButton>
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
