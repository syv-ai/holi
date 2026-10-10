/**
 * The threshold: the vault exists. Its remote to copy, a few keys worth
 * knowing, and the way in.
 *
 * **The keys are read off the commands**, core's and those of the plugins kept
 * on, so a hint cannot name a key nothing binds or a plugin this vault does
 * not run. Which few are worth a first look is the one thing written here.
 */
import { useState } from 'react'
import { useAtomValue } from 'jotai'
import { Button, Tooltip } from '@/primitives'
import { STATIC_COMMANDS, type Command } from '@/state/commands'
import { installedPluginsAtom } from '@/state/plugins'

/** The keys a new vault is worth meeting with, in the order they show. */
const FIRST_KEYS = ['palette.open', 'task.new', 'agent.show'] as const

interface Props {
  slug: string
  owner: string
  /** `owner/repo`, once the repo exists. */
  remote: string | null
  /** The plugins this vault runs, by id. */
  running: ReadonlySet<string>
  error: string | null
  onOpen: () => void
}

export function ThresholdAct({ slug, owner, remote, running, error, onOpen }: Props) {
  const installed = useAtomValue(installedPluginsAtom)
  const [copied, setCopied] = useState(false)

  const commands = new Map<string, Command>(
    [
      ...STATIC_COMMANDS,
      ...installed.filter((p) => running.has(p.info.id)).flatMap((p) => p.commands ?? []),
    ].map((c) => [c.id, c]),
  )
  const keys = FIRST_KEYS.flatMap((id) => {
    const command = commands.get(id)
    return command?.hotkey === undefined
      ? []
      : [{ id, hotkey: command.hotkey, label: command.label }]
  })

  const copy = () => {
    if (remote === null) return
    void navigator.clipboard.writeText(`https://github.com/${remote}`).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1600)
    })
  }

  return (
    <>
      <div className="obrit-thresh-rule" />
      <div className="obrit-eyebrow">YOUR VAULT IS READY</div>
      <h1 className="obrit-display">
        Welcome to <span className="obrit-vault-name">{slug || '…'}</span>.
      </h1>
      <p className="obrit-lede">Created under {owner}. Your team can clone it now.</p>

      {remote !== null && (
        <Tooltip content="copy the repo URL">
          <Button
            variant="ghost"
            className="mt-6 h-auto gap-4 rounded-[9px] bg-card px-4 py-2.5 font-normal hover:bg-secondary"
            onClick={copy}
          >
            <span className="obrit-repo-url-text">github.com/{remote}</span>
            <span className="obrit-repo-url-copy">{copied ? 'copied' : 'copy'}</span>
          </Button>
        </Tooltip>
      )}

      <div className="obrit-cta-row">
        <Button variant="ceremony" onClick={onOpen}>
          Open vault
          <span aria-hidden>→</span>
        </Button>
      </div>

      {keys.length > 0 && (
        <div className="obrit-hotkeys">
          {keys.map((k) => (
            <div key={k.id} className="obrit-hotkey">
              <kbd className="obrit-kbd">{k.hotkey}</kbd>
              <span className="obrit-hotkey-label">{k.label.toLowerCase()}</span>
            </div>
          ))}
        </div>
      )}

      {error && <div className="obrit-error">{error}</div>}
    </>
  )
}
