/**
 * Settings, General, Agents: this machine's agent harnesses
 * (docs/features/agent-sessions.md, Harnesses), the agent's to keep and to
 * check (`agent.harnesses` and the rest, UI door only). A row per agent with
 * Make default, Test, and Edit; one a person added can be removed, and an
 * edited built-in put back as Holi has it. The default is `agentProvider` in
 * `app.local.yaml`; one naming an agent since removed is said, never quietly
 * replaced. Making one the default that runs nothing unattended, or Pi, asks
 * first. A file Holi could not read, or entries in it that it left out, are
 * said with a way forward.
 */
import { useCallback, useEffect, useState } from 'react'
import { useAtom, useAtomValue } from 'jotai'
import { atomWithStorage } from 'jotai/utils'
import { VAULT_SETTING_DEFAULTS } from '@holi/shared'
import { EllipsisIcon, PlusIcon } from 'lucide-react'

import { Alert, AlertAction, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { ConfirmDialog } from '@/composites/confirm-dialog'
import { EmptyState } from '@/composites/empty-state'
import { IconButton } from '@/composites/icon-button'
import { AgentMark } from '@/composites/marks'
import { DropdownMenuActions, type MenuAction } from '@/composites/menu-actions'
import { trpc } from '@/lib/trpc'
import { activeRemoteAtom } from '@/state/vaults'
import { SettingsFieldRow, SettingsGroup, SettingsRowsLoading } from '../settings-kit'
import { useVaultSettings } from '../use-vault-settings'
import { HarnessDialog, type HarnessRecord } from './harness-dialog'

/** Mirrors `HarnessSummary` in the agent's main/harness/capabilities.ts. */
interface HarnessSummary {
  harness: HarnessRecord
  builtIn: boolean
  edited: boolean
  path: string | null
  /** Why Holis, automations and Create vault app cannot run on it. */
  unattended: string | null
}

/** Mirrors `HarnessListing` there. */
interface HarnessListing {
  agents: readonly HarnessSummary[]
  file: string
  ignored: number
  unreadable: string | null
}

type TestResult = { ok: true; output: string } | { ok: false; message: string; output: string }

type ListState =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; listing: HarnessListing }

/** A question before an agent becomes the default. */
interface DefaultAsk {
  id: string
  title: string
  description: string
  confirmLabel: string
}

/** What each built-in agent is, beside its row. */
const BUILT_IN_ABOUT: Readonly<Record<string, string>> = {
  claude: "Anthropic's agent. Its sessions keep running in the background.",
  codex: "OpenAI's agent, signed in as on the command line. Its sessions run while Holi is open.",
  pi: 'The open-source agent, on your own Pi models and sign-in. Its sessions run while Holi is open; its unattended runs need macOS.',
}

const CUSTOM_ABOUT =
  "Runs in its terminal while Holi is open. Holis, automations, a document's Ask AI and Create vault app do not run on it."

/** The vaults, by remote, where this machine was told that Pi runs its
 *  tools without asking. Asked once per vault, on this machine. */
const piWarnedAtom = atomWithStorage<Record<string, true>>('holi:piUnattendedWarned', {})

async function agentCall<T>(remote: string, name: string, params: unknown): Promise<T> {
  return (await trpc.cap.run.mutate({ remote, name, paramsJson: JSON.stringify(params) })) as T
}

/** What a Codex job can do, said before anyone lets one run unwatched. */
const CODEX_RISK =
  'A Codex job can read any file on this computer and write what it read into this vault’s synced folders. A note from someone you do not trust could make it publish private data to everyone this vault syncs with.'

/**
 * Whether Codex may run unattended here (Holis, automations, a document's
 * Ask AI and rewrites): this machine's answer for this vault, which main
 * enforces (`agent.job`). Off until someone turns it on, after a dialog that
 * says what it risks; off again at a click.
 */
function CodexUnattendedRow({ remote }: { remote: string }) {
  const [allowed, setAllowed] = useState<boolean | null>(null)
  const [failed, setFailed] = useState(false)
  const [asking, setAsking] = useState(false)

  const read = useCallback(() => {
    setFailed(false)
    agentCall<boolean>(remote, 'agent.unattended', { provider: 'codex' }).then(
      (on) => setAllowed(on === true),
      () => setFailed(true),
    )
  }, [remote])
  useEffect(read, [read])

  const set = async (on: boolean): Promise<void> => {
    await agentCall(remote, 'agent.allowUnattended', { provider: 'codex', on })
    setAllowed(on)
  }

  return (
    <SettingsFieldRow
      title="Let Codex run unattended in this vault"
      htmlFor="codex-unattended"
      description={
        failed ? (
          <span className="text-destructive">Holi could not read this machine’s answer.</span>
        ) : (
          'Holis, automations and a document’s Ask AI on Codex run only once this is on, on this machine. A Codex job can read any file on this computer.'
        )
      }
    >
      {failed ? (
        <Button variant="outline" size="sm" onClick={read}>
          Retry
        </Button>
      ) : (
        <Switch
          id="codex-unattended"
          checked={allowed === true}
          disabled={allowed === null}
          onCheckedChange={(on) => (on ? setAsking(true) : void set(false).catch(read))}
        />
      )}
      <ConfirmDialog
        open={asking}
        onOpenChange={setAsking}
        title="Let Codex run unattended in this vault?"
        description={CODEX_RISK}
        confirmLabel="Let it run"
        cancelLabel="Not now"
        destructive
        onConfirm={() => set(true)}
      />
    </SettingsFieldRow>
  )
}

/** The command a harness runs, as one line to read (never to run). */
const commandLine = (h: HarnessRecord): string => [h.command.bin, ...h.command.args].join(' ')

export function AgentsCard() {
  const { resolved, write } = useVaultSettings()
  const current = resolved?.agentProvider ?? VAULT_SETTING_DEFAULTS.agentProvider
  const remote = useAtomValue(activeRemoteAtom)
  const [warned, setWarned] = useAtom(piWarnedAtom)
  const [asking, setAsking] = useState<DefaultAsk | null>(null)
  const [resetting, setResetting] = useState(false)
  const [state, setState] = useState<ListState>({ kind: 'loading' })
  // The dialog mounts afresh each time it opens (`key`), so its form is
  // filled from the agent it opens on; `open` false keeps it while it closes.
  const [editing, setEditing] = useState<{
    harness: HarnessRecord | null
    open: boolean
    n: number
  }>({ harness: null, open: false, n: 0 })
  const edit = (harness: HarnessRecord | null): void =>
    setEditing((e) => ({ harness, open: true, n: e.n + 1 }))
  const [removing, setRemoving] = useState<HarnessSummary | null>(null)
  const [testing, setTesting] = useState<{
    label: string
    result: TestResult | null
  } | null>(null)

  const read = useCallback(() => {
    if (remote === null) return
    setState({ kind: 'loading' })
    agentCall<HarnessListing>(remote, 'agent.harnesses', {})
      .then((listing) =>
        setState(
          Array.isArray(listing?.agents)
            ? { kind: 'ready', listing }
            : { kind: 'error', message: 'The agent did not answer with a list.' },
        ),
      )
      .catch((err: unknown) =>
        setState({ kind: 'error', message: err instanceof Error ? err.message : String(err) }),
      )
  }, [remote])
  useEffect(read, [read])

  const makeDefault = (v: HarnessSummary): void => {
    const id = v.harness.id
    // The default is what Holis, automations and a document's Ask AI and rewrites run on:
    // one that runs nothing unattended fails them, which is said each time.
    if (v.unattended !== null) {
      setAsking({
        id,
        title: `Make ${v.harness.label} the default?`,
        description: v.unattended,
        confirmLabel: `Make ${v.harness.label} the default`,
      })
      return
    }
    // Pi there runs every tool without asking, which is said once.
    if (id === 'pi' && remote !== null && warned[remote] !== true) {
      setAsking({
        id,
        title: 'Run unattended work on Pi?',
        description:
          "Holis, automations and a document's Ask AI and rewrites will run on Pi with nobody watching. Pi asks before no tool: each run edits the files it may touch without asking you. Holi keeps it to those files, and runs it only on macOS.",
        confirmLabel: 'Make Pi the default',
      })
      return
    }
    void write('agentProvider', id, 'local')
  }

  const test = async (h: HarnessRecord): Promise<void> => {
    if (remote === null) return
    setTesting({ label: h.label, result: null })
    const result = await agentCall<TestResult>(remote, 'agent.harnessTest', { id: h.id }).catch(
      (err: unknown): TestResult => ({
        ok: false,
        message: err instanceof Error ? err.message : String(err),
        output: '',
      }),
    )
    setTesting({ label: h.label, result })
  }

  const save = async (harness: HarnessRecord, create: boolean): Promise<void> => {
    if (remote === null) return
    await agentCall(remote, 'agent.harnessSave', { harness, create })
    read()
  }

  const listing = state.kind === 'ready' ? state.listing : null
  const list = listing?.agents ?? []
  const missing =
    state.kind === 'ready' && resolved !== null && !list.some((v) => v.harness.id === current)

  const actionsOf = (v: HarnessSummary): MenuAction[] => [
    { kind: 'item', label: 'Edit', run: () => edit(v.harness) },
    ...(v.builtIn && !v.edited
      ? []
      : [
          { kind: 'separator' } as const,
          {
            kind: 'item' as const,
            label: v.builtIn ? "Put back Holi's settings" : 'Remove',
            destructive: !v.builtIn,
            run: () => setRemoving(v),
          },
        ]),
  ]

  return (
    <SettingsGroup
      title="Agents"
      description="The coding agents on this machine. A new session starts in the default one; hover the Sessions + to start another."
      action={
        <Button variant="outline" size="sm" onClick={() => edit(null)}>
          <PlusIcon data-icon="inline-start" aria-hidden="true" />
          Add agent
        </Button>
      }
    >
      {missing ? (
        <Alert variant="warning" className="my-3">
          <AlertTitle>The default agent is gone</AlertTitle>
          <AlertDescription>
            This machine's default, {current}, is not one of its agents any more. A new session asks
            which agent to start in until you make one the default.
          </AlertDescription>
        </Alert>
      ) : null}
      {listing !== null && listing.unreadable !== null ? (
        <Alert variant="destructive" className="my-3">
          <AlertTitle>Holi could not read this machine's agents file</AlertTitle>
          <AlertDescription>
            <p>
              {listing.unreadable} Until it can, Holi uses the built-in agents as it ships them and
              changes nothing in {listing.file}. Fix the file and Retry, or Reset it: a copy is kept
              beside it as .bad.
            </p>
          </AlertDescription>
          <AlertAction>
            <Button variant="outline" size="sm" onClick={read}>
              Retry
            </Button>
            <Button variant="outline" size="sm" onClick={() => setResetting(true)}>
              Reset
            </Button>
          </AlertAction>
        </Alert>
      ) : listing !== null && listing.ignored > 0 ? (
        <Alert variant="warning" className="my-3">
          <AlertTitle>
            {listing.ignored === 1 ? '1 entry ignored' : `${listing.ignored} entries ignored`}
          </AlertTitle>
          <AlertDescription>
            <p>
              {listing.file} has {listing.ignored === 1 ? 'an entry' : 'entries'} that did not read
              as an agent. Fix them there and Retry. The next change here keeps a copy of the file
              beside it as .bad, then leaves them out.
            </p>
          </AlertDescription>
          <AlertAction>
            <Button variant="outline" size="sm" onClick={read}>
              Retry
            </Button>
          </AlertAction>
        </Alert>
      ) : null}
      {resolved === null || state.kind === 'loading' ? (
        <SettingsRowsLoading rows={3} label="Reading the agents" />
      ) : state.kind === 'error' ? (
        <div className="flex items-center justify-between gap-3 py-3">
          <div className="flex min-w-0 flex-col gap-0.5">
            <span className="text-sm font-medium">Holi could not read this machine's agents.</span>
            <span className="text-muted-foreground text-xs break-words">{state.message}</span>
          </div>
          <Button variant="outline" size="sm" onClick={read}>
            Retry
          </Button>
        </div>
      ) : list.length === 0 ? (
        <EmptyState
          title="No agents"
          description="Add the command-line agent you use, and Holi runs it in the vault."
          className="h-auto"
        >
          <Button variant="outline" size="sm" onClick={() => edit(null)}>
            Add agent
          </Button>
        </EmptyState>
      ) : (
        list.map((v) => (
          <SettingsFieldRow
            key={v.harness.id}
            title={v.harness.label}
            titleAddon={v.path === null ? <Badge variant="warning-light">Not found</Badge> : null}
            description={
              <span className="flex flex-col gap-0.5">
                <span>{BUILT_IN_ABOUT[v.harness.id] ?? CUSTOM_ABOUT}</span>
                <span className="font-mono text-xs break-all">{commandLine(v.harness)}</span>
              </span>
            }
            mark={<AgentMark agent={v.harness.id} size="lg" />}
          >
            <div className="flex items-center gap-2">
              {v.harness.id === current ? (
                <Badge variant="success-light">Default</Badge>
              ) : (
                <Button variant="outline" size="sm" onClick={() => makeDefault(v)}>
                  Make default
                </Button>
              )}
              <Button variant="outline" size="sm" onClick={() => void test(v.harness)}>
                Test
              </Button>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <IconButton label={`More for ${v.harness.label}`}>
                    <EllipsisIcon aria-hidden="true" />
                  </IconButton>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuActions actions={actionsOf(v)} />
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </SettingsFieldRow>
        ))
      )}
      {remote !== null && list.some((v) => v.harness.id === 'codex') ? (
        <CodexUnattendedRow key={remote} remote={remote} />
      ) : null}
      <HarnessDialog
        key={`${editing.harness?.id ?? 'new'}-${editing.n}`}
        open={editing.open}
        onOpenChange={(open) => !open && setEditing((e) => ({ ...e, open: false }))}
        harness={editing.harness}
        onSave={save}
      />
      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(open) => !open && setRemoving(null)}
        title={
          removing?.builtIn === true
            ? `Put back ${removing.harness.label} as Holi has it?`
            : `Remove ${removing?.harness.label ?? 'this agent'}?`
        }
        description={
          removing?.builtIn === true
            ? 'Its program, arguments and environment go back to what Holi ships.'
            : 'Holi forgets how to run it. Its sessions that are open keep running until they end.'
        }
        confirmLabel={removing?.builtIn === true ? 'Put back' : 'Remove'}
        destructive={removing?.builtIn !== true}
        onConfirm={async () => {
          if (remote === null || removing === null) return
          await agentCall(remote, 'agent.harnessRemove', { id: removing.harness.id })
          read()
        }}
      />
      <Dialog open={testing !== null} onOpenChange={(open) => !open && setTesting(null)}>
        <DialogContent size="lg">
          <DialogHeader>
            <DialogTitle>Test {testing?.label}</DialogTitle>
            <DialogDescription>
              {testing?.result == null
                ? 'Running its test arguments in the vault…'
                : testing.result.ok
                  ? 'It ran and finished.'
                  : testing.result.message}
            </DialogDescription>
          </DialogHeader>
          {testing?.result != null && testing.result.output.trim() !== '' ? (
            <pre className="bg-muted max-h-80 overflow-auto rounded-md p-3 font-mono text-xs whitespace-pre-wrap">
              {testing.result.output.trim()}
            </pre>
          ) : null}
          <DialogFooter>
            <Button variant="outline" onClick={() => setTesting(null)}>
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <ConfirmDialog
        open={asking !== null}
        onOpenChange={(open) => !open && setAsking(null)}
        title={asking?.title ?? ''}
        description={asking?.description}
        confirmLabel={asking?.confirmLabel ?? 'Make default'}
        onConfirm={async () => {
          if (asking === null) return
          if (asking.id === 'pi' && remote !== null) {
            setWarned((all) => ({ ...all, [remote]: true }))
          }
          await write('agentProvider', asking.id, 'local')
        }}
      />
      <ConfirmDialog
        open={resetting}
        onOpenChange={setResetting}
        title="Reset this machine's agents file?"
        description="Holi keeps a copy of it beside it as .bad, then starts it over: the agents you added are gone from Settings, and the built-in ones go back to what Holi ships."
        confirmLabel="Reset"
        destructive
        onConfirm={async () => {
          if (remote === null) return
          await agentCall(remote, 'agent.harnessReset', {})
          read()
        }}
      />
    </SettingsGroup>
  )
}
