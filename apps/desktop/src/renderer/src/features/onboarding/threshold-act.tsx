/**
 * The threshold: first the vault being built, then the vault. While building
 * it lists the steps as they land (the repo, then the answers in it), each
 * one a spinner until it is done and a tick after; then it is the vault's
 * remote to copy, a few keys worth knowing, and the way in.
 *
 * **The keys are read off the commands**, core's and those of the plugins kept
 * on, so a hint cannot name a key nothing binds or a plugin this vault does
 * not run. Which few are worth a first look each command says itself
 * (`firstKey`), so this act names no plugin.
 */
import { useState } from 'react'
import { useAtomValue } from 'jotai'
import { ArrowRight, Check, LoaderCircle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Kbd } from '@/components/ui/kbd'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { STATIC_COMMANDS, type Command } from '@/state/commands'
import { installedPluginsAtom } from '@/state/plugins'

interface Props {
  slug: string
  owner: string
  /** `owner/repo`, once the repo exists. */
  remote: string | null
  /** The plugins this vault runs, by id. */
  running: ReadonlySet<string>
  /** True while the vault is being made. */
  building: boolean
  /** How many build steps have landed. */
  built: number
  error: string | null
  onOpen: () => void
}

export function ThresholdAct({
  slug,
  owner,
  remote,
  running,
  building,
  built,
  error,
  onOpen,
}: Props) {
  const installed = useAtomValue(installedPluginsAtom)
  const [copied, setCopied] = useState(false)

  // The keys a new vault is worth meeting with, in the order they show.
  const keys = [
    ...STATIC_COMMANDS,
    ...installed.filter((p) => running.has(p.info.id)).flatMap((p) => p.commands ?? []),
  ]
    .flatMap((c: Command) =>
      c.firstKey === undefined || c.hotkey === undefined
        ? []
        : [{ id: c.id, hotkey: c.hotkey, label: c.label, at: c.firstKey }],
    )
    .sort((a, b) => a.at - b.at)

  const copy = () => {
    if (remote === null) return
    void navigator.clipboard.writeText(`https://github.com/${remote}`).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1600)
    })
  }

  if (building) {
    const steps = [
      owner ? `Creating github.com/${owner}/${slug}` : `Creating ${slug} on GitHub`,
      'Setting up your plugins and choices',
    ]
    return (
      <>
        <div className="obrit-eyebrow">Building your vault</div>
        <h1 className="obrit-display">
          Making <span className="obrit-vault-name">{slug}</span>.
        </h1>
        <ol className="obrit-build" aria-live="polite">
          {steps.map((label, i) => {
            const state = i < built ? 'done' : i === built ? 'now' : 'next'
            return (
              <li key={label} className="obrit-build-step" data-state={state}>
                <span className="obrit-build-mark" aria-hidden="true">
                  {state === 'done' ? (
                    <Check aria-hidden className="size-3.5" />
                  ) : state === 'now' ? (
                    <LoaderCircle aria-hidden className="size-3.5 motion-orbit" />
                  ) : null}
                </span>
                <span>{label}</span>
              </li>
            )
          })}
        </ol>
      </>
    )
  }

  return (
    <>
      <div className="obrit-thresh-rule" />
      <div className="obrit-eyebrow">Your vault is ready</div>
      <h1 className="obrit-display">
        Welcome to <span className="obrit-vault-name">{slug || '…'}</span>.
      </h1>
      <p className="obrit-lede">
        {owner ? `Created under ${owner}. ` : ''}Your team can clone it now.
      </p>

      {remote !== null && (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="outline" className="obrit-repo-url" onClick={copy}>
              <span className="obrit-repo-url-text">github.com/{remote}</span>
              <span className="obrit-repo-url-copy">{copied ? 'Copied' : 'Copy'}</span>
            </Button>
          </TooltipTrigger>
          <TooltipContent>Copy the repo URL</TooltipContent>
        </Tooltip>
      )}

      <div className="obrit-cta-row">
        <Button size="lg" onClick={onOpen}>
          Open vault
          <ArrowRight aria-hidden className="size-3.5" />
        </Button>
      </div>

      {keys.length > 0 && (
        <div className="obrit-hotkeys">
          {keys.map((k) => (
            <div key={k.id} className="obrit-hotkey">
              <Kbd className="obrit-kbd">{k.hotkey}</Kbd>
              <span className="obrit-hotkey-label">{k.label}</span>
            </div>
          ))}
        </div>
      )}

      {error && <div className="obrit-error">{error}</div>}
    </>
  )
}
