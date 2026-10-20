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
import { Button, Icon, Kbd, Tooltip } from '@/primitives'
import { cn } from '@/lib/cn'
import { STATIC_COMMANDS, type Command } from '@/state/commands'
import { installedPluginsAtom } from '@/state/plugins'
import { ActHeading } from './ActHeading'

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
      <div className="flex flex-col items-center gap-6">
        <ActHeading center title={`Making ${slug}`} description="Building your vault." />
        <ol className="flex flex-col gap-3" aria-live="polite">
          {steps.map((label, i) => {
            const state = i < built ? 'done' : i === built ? 'now' : 'next'
            return (
              <li
                key={label}
                data-state={state}
                className={cn(
                  'flex items-center gap-3 text-sm',
                  state === 'next' ? 'text-muted-foreground' : 'text-foreground',
                )}
              >
                <span
                  className="flex size-6 items-center justify-center rounded-full bg-secondary text-secondary-foreground"
                  aria-hidden="true"
                >
                  {state === 'done' ? (
                    <Icon icon={Check} size="sm" />
                  ) : state === 'now' ? (
                    <Icon icon={LoaderCircle} size="sm" className="motion-orbit" />
                  ) : null}
                </span>
                <span>{label}</span>
              </li>
            )
          })}
        </ol>
      </div>
    )
  }

  return (
    <div className="flex flex-col items-center gap-6">
      <ActHeading
        center
        title={`Welcome to ${slug || '…'}`}
        description={`${owner ? `Created under ${owner}. ` : ''}Your vault is ready, and your team can clone it now.`}
      />

      {remote !== null && (
        <Tooltip content="Copy the repo URL">
          <Button variant="outline" onClick={copy}>
            <span className="font-mono">github.com/{remote}</span>
            <span className="text-xs text-muted-foreground">{copied ? 'Copied' : 'Copy'}</span>
          </Button>
        </Tooltip>
      )}

      <Button onClick={onOpen}>
        Open vault
        <Icon icon={ArrowRight} size="sm" />
      </Button>

      {keys.length > 0 && (
        <div className="flex flex-wrap items-center justify-center gap-6">
          {keys.map((k) => (
            <div key={k.id} className="flex items-center gap-2 text-xs text-muted-foreground">
              <Kbd>{k.hotkey}</Kbd>
              {k.label}
            </div>
          ))}
        </div>
      )}

      {error && (
        <p role="alert" className="text-center text-sm text-destructive">
          {error}
        </p>
      )}
    </div>
  )
}
