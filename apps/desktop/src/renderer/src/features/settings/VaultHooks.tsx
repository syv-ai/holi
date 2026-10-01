/**
 * The vault's own commit hooks, under Holi's transforms in the commits row:
 * what its `.pre-commit-config.yaml` runs, in order, and whether it runs on
 * this machine. The config is code a teammate committed, so it runs only once
 * this person allows it, and asks again when it changes (main keeps the
 * allowance: `vault/hooks/pre-commit.ts`).
 */
import { useAtomValue } from 'jotai'
import { useCallback, useEffect, useState } from 'react'
import { PRE_COMMIT_CONFIG, type PreCommitHook, type PreCommitStatus } from '@holi/shared'
import { Button, Checkbox } from '@/primitives'
import { trpc } from '@/lib/trpc'
import { activeRemoteAtom } from '@/state/vaults'

const PRE_COMMIT_SITE = 'https://pre-commit.com'

/** `github.com/owner/repo` as `owner/repo`; `local` and `meta` as they are. */
function repoLabel(repo: string): string {
  const github = /^https?:\/\/github\.com\/([^/]+\/[^/]+?)(?:\.git)?\/?$/.exec(repo)
  return github !== null ? github[1]! : repo
}

function HookLine({ hook }: { hook: PreCommitHook }): React.JSX.Element {
  return (
    <li className="flex items-baseline gap-1.5">
      <span className="text-xs">{hook.name}</span>
      <span className="text-[11px] text-muted-foreground">{repoLabel(hook.repo)}</span>
    </li>
  )
}

export function VaultHooks(): React.JSX.Element | null {
  const remote = useAtomValue(activeRemoteAtom)
  const [status, setStatus] = useState<PreCommitStatus | null>(null)
  const [asking, setAsking] = useState(false)

  const refresh = useCallback(async () => {
    if (remote === null) return
    // A status that cannot be read shows nothing: the built-ins above still
    // say what runs, and nothing of the vault's runs without an allowance.
    try {
      setStatus(await trpc.settings.preCommit.query({ remote }))
    } catch {
      setStatus(null)
    }
  }, [remote])

  useEffect(() => {
    void refresh()
    // A save made since the tab opened has a newer last run to show.
    const onFocus = () => void refresh()
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [refresh])

  if (remote === null || status === null) return null

  if (status.config === 'absent') {
    return (
      <p className="text-[11px] text-muted-foreground">
        Your own hooks go in {PRE_COMMIT_CONFIG} and run after these, with{' '}
        <Button
          variant="link"
          className="h-auto p-0 text-[11px] font-normal"
          onClick={() => void window.holi.openExternal(PRE_COMMIT_SITE)}
        >
          pre-commit
        </Button>
        .
      </p>
    )
  }

  if (status.config === 'invalid') {
    return (
      <p className="text-[11px] text-destructive">
        {PRE_COMMIT_CONFIG} is not valid, so it does not run: {status.error}
      </p>
    )
  }

  const allowed = status.allowed === 'yes'
  const allow = async () => {
    if (status.hash === null) return
    const { ok } = await trpc.settings.allowPreCommit.mutate({ remote, hash: status.hash })
    setAsking(false)
    // Not ok: the file changed while the question was up, so the fresh status
    // asks about what is there now.
    await refresh()
    if (!ok) setAsking(true)
  }
  const disallow = async () => {
    await trpc.settings.disallowPreCommit.mutate({ remote })
    await refresh()
  }

  return (
    <div className="flex flex-col gap-1.5" data-vault-hooks="">
      <label className="flex items-start gap-2.5">
        <Checkbox
          className="mt-0.5"
          checked={allowed}
          disabled={status.tool === null}
          onCheckedChange={(next) => (next === true ? setAsking(true) : void disallow())}
          aria-label={`Run this vault's ${PRE_COMMIT_CONFIG} on this machine`}
        />
        <span className="min-w-0">
          <span className="text-xs">Run {PRE_COMMIT_CONFIG}</span>
          <span className="ml-1.5 text-[11px] text-muted-foreground">
            {status.tool === null
              ? 'pre-commit is not installed on this machine.'
              : status.allowed === 'changed'
                ? 'Changed since you allowed it, so it is off until you allow it again.'
                : 'On this machine only, once you allow it. A failing hook never stops a save.'}
          </span>
        </span>
      </label>

      <ol className="ml-6 flex flex-col gap-0.5">
        {status.hooks.map((hook, i) => (
          <HookLine key={`${hook.repo}#${hook.id}#${i}`} hook={hook} />
        ))}
      </ol>

      {asking && (
        <div className="ml-6 flex flex-wrap items-center gap-2 rounded-md bg-muted px-3 py-2">
          <span className="text-[11px]">
            These run commands from this vault on this machine, at every save. Allow them?
          </span>
          <Button size="xs" variant="default" onClick={() => void allow()}>
            Allow
          </Button>
          <Button size="xs" variant="ghost" onClick={() => setAsking(false)}>
            Not now
          </Button>
        </div>
      )}

      {allowed && status.lastRun !== null && (
        <div className="ml-6 flex flex-col gap-0.5">
          <span
            className={
              status.lastRun.ok
                ? 'text-[11px] text-muted-foreground'
                : 'text-[11px] text-destructive'
            }
          >
            Last save: {status.lastRun.ok ? 'fine' : 'a hook reported a problem'}
          </span>
          {status.lastRun.summary !== '' && (
            <pre className="font-mono text-[10px] whitespace-pre-wrap text-muted-foreground">
              {status.lastRun.summary}
            </pre>
          )}
        </div>
      )}
    </div>
  )
}
