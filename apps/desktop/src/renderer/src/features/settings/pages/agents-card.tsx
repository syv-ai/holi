/**
 * Settings, General, Agents: this machine's agent harnesses
 * (docs/features/agent-sessions.md, Harnesses), the agent's to keep and to
 * check (`agent.harnesses` and the rest, UI door only). A row per agent with
 * Make default, Test, and Edit; one a person added can be removed, and an
 * edited built-in put back as Holi has it. The default is `agentProvider` in
 * `app.local.yaml`; one naming an agent since removed is said, never quietly
 * replaced.
 */
import { useCallback, useEffect, useState } from 'react'
import { useAtom, useAtomValue } from 'jotai'
import { atomWithStorage } from 'jotai/utils'
import { VAULT_SETTING_DEFAULTS } from '@holi/shared'
import { EllipsisIcon, PlusIcon } from 'lucide-react'

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
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
}

type TestResult = { ok: true; output: string } | { ok: false; message: string; output: string }

type ListState =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; list: readonly HarnessSummary[] }

/** What each built-in agent is, beside its row. */
const BUILT_IN_ABOUT: Readonly<Record<string, string>> = {
  claude:
    "Anthropic's agent. Its sessions keep running in the background, and Holis and automations run on it.",
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

/** The command a harness runs, as one line to read (never to run). */
const commandLine = (h: HarnessRecord): string => [h.command.bin, ...h.command.args].join(' ')

export function AgentsCard() {
  const { resolved, write } = useVaultSettings()
  const current = resolved?.agentProvider ?? VAULT_SETTING_DEFAULTS.agentProvider
  const remote = useAtomValue(activeRemoteAtom)
  const [warned, setWarned] = useAtom(piWarnedAtom)
  const [askPi, setAskPi] = useState(false)
  const [state, setState] = useState<ListState>({ kind: 'loading' })
  const [editing, setEditing] = useState<{ harness: HarnessRecord | null } | null>(null)
  const [removing, setRemoving] = useState<HarnessSummary | null>(null)
  const [testing, setTesting] = useState<{
    label: string
    result: TestResult | null
  } | null>(null)

  const read = useCallback(() => {
    if (remote === null) return
    setState({ kind: 'loading' })
    agentCall<HarnessSummary[]>(remote, 'agent.harnesses', {})
      .then((list) =>
        setState(
          Array.isArray(list)
            ? { kind: 'ready', list }
            : { kind: 'error', message: 'The agent did not answer with a list.' },
        ),
      )
      .catch((err: unknown) =>
        setState({ kind: 'error', message: err instanceof Error ? err.message : String(err) }),
      )
  }, [remote])
  useEffect(read, [read])

  const makeDefault = (id: string): void => {
    // The default is what Holis, automations and a document's Ask AI and rewrites run on:
    // Pi there runs every tool without asking, which is said once.
    if (id === 'pi' && remote !== null && warned[remote] !== true) {
      setAskPi(true)
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

  const list = state.kind === 'ready' ? state.list : []
  const missing =
    state.kind === 'ready' && resolved !== null && !list.some((v) => v.harness.id === current)

  const actionsOf = (v: HarnessSummary): MenuAction[] => [
    { kind: 'item', label: 'Edit', run: () => setEditing({ harness: v.harness }) },
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
        <Button variant="outline" size="sm" onClick={() => setEditing({ harness: null })}>
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
          <Button variant="outline" size="sm" onClick={() => setEditing({ harness: null })}>
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
                <Button variant="outline" size="sm" onClick={() => makeDefault(v.harness.id)}>
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
      <HarnessDialog
        open={editing !== null}
        onOpenChange={(open) => !open && setEditing(null)}
        harness={editing?.harness ?? null}
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
        open={askPi}
        onOpenChange={setAskPi}
        title="Run unattended work on Pi?"
        description="Holis, automations and a document's Ask AI and rewrites will run on Pi with nobody watching. Pi asks before no tool: each run edits the files it may touch without asking you. Holi keeps it to those files, and runs it only on macOS."
        confirmLabel="Make Pi the default"
        onConfirm={async () => {
          if (remote !== null) setWarned((all) => ({ ...all, [remote]: true }))
          await write('agentProvider', 'pi', 'local')
        }}
      />
    </SettingsGroup>
  )
}
