/**
 * Getting a community plugin to run, wherever it starts from (the settings
 * tab, or the notice a vault's pin raises): fetch the release, show what it
 * is and what it will run, and only on "Allow" consent to that commit and run
 * its setup. Nothing of a plugin runs before the dialog is answered.
 */
import { useAtomValue } from 'jotai'
import { useEffect, useRef, useState } from 'react'
import { activeRemoteAtom, type PluginStore } from '@/plugin-api'
import { Button, Dialog } from '@/primitives'
import { communityCap, refreshRows, setupLogsAtom, type PluginRow } from './state'

/** The command as a person would type it. */
const shown = (argv: readonly string[]) =>
  argv.map((a) => (/[\s"'$]/.test(a) ? JSON.stringify(a) : a)).join(' ')

type Step =
  { kind: 'ask' } | { kind: 'setup' } | { kind: 'done' } | { kind: 'failed'; message: string }

/**
 * The dialog for one fetched release: what it is, from where, at which commit,
 * and the two commands it runs. "Allow and set up" consents and runs setup,
 * its output shown as it comes.
 */
export function ConsentDialog({
  row,
  store,
  onClose,
}: {
  row: PluginRow
  store: PluginStore
  onClose: () => void
}): React.JSX.Element {
  const remote = useAtomValue(activeRemoteAtom)
  const log = useAtomValue(setupLogsAtom)[row.id] ?? []
  const [step, setStep] = useState<Step>({ kind: 'ask' })
  const logEnd = useRef<HTMLDivElement>(null)
  const install = row.install

  // Braced: Chromium's scrollIntoView now returns a promise, and an effect
  // that returns anything but a cleanup function breaks the tree.
  useEffect(() => {
    void logEnd.current?.scrollIntoView({ block: 'end' })
  }, [log.length])

  const allow = async () => {
    if (remote === null || install === null) return
    try {
      if (install.kind === 'release')
        await communityCap.consent(remote, { id: row.id, commit: install.commit })
      setStep({ kind: 'setup' })
      const ok = await communityCap.setup(remote, { id: row.id })
      setStep(ok ? { kind: 'done' } : { kind: 'failed', message: 'Setup did not finish.' })
    } catch (err) {
      setStep({ kind: 'failed', message: err instanceof Error ? err.message : String(err) })
    } finally {
      await refreshRows(remote, store)
    }
  }

  return (
    <>
      <Dialog.Header>
        {step.kind === 'ask' ? `Run ${row.name} on this machine?` : `Setting up ${row.name}`}
      </Dialog.Header>
      <Dialog.Body>
        {step.kind === 'ask' ? (
          <div className="grid gap-3 text-xs leading-relaxed text-muted-foreground">
            <p>
              {install?.kind === 'release' ? (
                <>
                  Version {install.version} of{' '}
                  <span className="font-mono text-foreground">{install.repo}</span>, at commit{' '}
                  <span className="font-mono text-foreground">{install.commit.slice(0, 12)}</span>.
                </>
              ) : (
                <>
                  The folder <span className="font-mono text-foreground">{install?.folder}</span>.
                </>
              )}{' '}
              It runs as a program on this machine, with your permissions: it can read and change
              your files, not only this vault&rsquo;s. Allow it if you trust where it comes from.
            </p>
            {row.setup !== null && (
              <div>
                <p>Once now, to set it up:</p>
                <pre className="mt-1 whitespace-pre-wrap rounded-md bg-muted p-2 font-mono text-[11px] text-foreground">
                  {shown(row.setup)}
                </pre>
              </div>
            )}
            <div>
              <p>
                Each time you open{' '}
                {[
                  ...row.opens,
                  ...(row.folder === undefined ? [] : [`a ${row.folder.suffix} folder`]),
                ].join(' or ')}
                :
              </p>
              <pre className="mt-1 whitespace-pre-wrap rounded-md bg-muted p-2 font-mono text-[11px] text-foreground">
                {shown(row.serve)}
              </pre>
            </div>
            <p>Holi asks again when the vault moves to another version.</p>
          </div>
        ) : (
          <div className="grid gap-2">
            <p className="text-xs text-muted-foreground">
              {step.kind === 'setup' && 'Running setup…'}
              {step.kind === 'done' && `${row.name} is ready.`}
              {step.kind === 'failed' && step.message}
            </p>
            {log.length > 0 && (
              <pre className="max-h-72 overflow-auto whitespace-pre-wrap rounded-md bg-muted p-2 font-mono text-[11px] leading-relaxed text-muted-foreground">
                {log.join('\n')}
                <div ref={logEnd} />
              </pre>
            )}
          </div>
        )}
      </Dialog.Body>
      <Dialog.Footer>
        {step.kind === 'ask' ? (
          <>
            <Button variant="ghost" size="sm" onClick={onClose}>
              Not now
            </Button>
            <Button size="sm" onClick={() => void allow()}>
              Allow and set up
            </Button>
          </>
        ) : (
          <Button size="sm" disabled={step.kind === 'setup'} onClick={onClose}>
            {step.kind === 'failed' ? 'Close' : 'Done'}
          </Button>
        )}
      </Dialog.Footer>
    </>
  )
}

/** What the install flow needs from its caller. */
export interface InstallFlow {
  remote: string
  store: PluginStore
  openDialog(render: (close: () => void) => React.JSX.Element): void
}

/** Fetch `repo` at `version` (the newest when absent), then ask. Resolves to
 *  an error message, or null when the dialog is up. */
export async function installAndAsk(
  flow: InstallFlow,
  args: { repo: string; version?: string; id?: string },
): Promise<string | null> {
  try {
    const version =
      args.version ?? (await communityCap.versions(flow.remote, { repo: args.repo }))[0]
    if (version === undefined) return `${args.repo} has no released version (a tag like v1.0.0).`
    const row = await communityCap.install(flow.remote, {
      repo: args.repo,
      version,
      ...(args.id === undefined ? {} : { expectId: args.id }),
    })
    await refreshRows(flow.remote, flow.store)
    askToRun(flow, row)
    return null
  } catch (err) {
    return err instanceof Error ? err.message : String(err)
  }
}

/** Open the consent dialog for an installed row. */
export function askToRun(flow: InstallFlow, row: PluginRow): void {
  flow.openDialog((close) => <ConsentDialog row={row} store={flow.store} onClose={close} />)
}
