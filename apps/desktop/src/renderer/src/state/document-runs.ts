/**
 * A document's agent runs, by path (docs/features/editor.md), and Create
 * vault app, which the document's menu and the file tree's row menu both
 * offer: one definition, so both menus agree on when it applies and what it
 * starts. The document's view follows a run (`features/documents/
 * document-agent.ts`); a run outlives its tab being switched away.
 *
 * **Create vault app** makes `<name>.app` beside a markdown note, leaving the
 * note alone, as a session the person can watch, answer and add to
 * (`agent.scoped`, docs/features/agent-sessions.md): on this machine's agent
 * (`agentProvider`), never another. It is offered once that choice is read
 * (never the default in its place), with an agent running, for a note whose
 * app beside it would be the vault's shared content (`isAppWritablePath`),
 * and not while a run on that note is live.
 */
import { isAppWritablePath, type AgentProviderId, type VaultSnapshot } from '@holi/shared'
import { atom } from 'jotai'
import { AstroidIcon, LinkIcon, type LucideIcon } from 'lucide-react'

import { parentOf } from '@/lib/tree-paths'
import { trpc } from '@/lib/trpc'

import { agentSourceAtom } from './plugins'
import { loadedAgentProviderAtom } from './settings'
import { activeRemoteAtom, snapshotAtom } from './vaults'

/** The actions the document's menu and a note's row menu in the file tree
 *  share, drawn the same in both. Agentic ones carry the agent's mark. */
export const NOTE_ACTIONS: Readonly<
  Record<'copyLink' | 'createVaultApp', { label: string; icon: LucideIcon }>
> = {
  copyLink: { label: 'Copy Holi link', icon: LinkIcon },
  createVaultApp: { label: 'Create vault app', icon: AstroidIcon },
}

/** Claude Code's model for a document's runs; another agent runs on its own
 *  default. */
export const AGENT_MODEL = 'claude-sonnet-5-5'

export type AgentRunKind = 'write' | 'rewrite' | 'vault-app'

type AgentRunStatus = 'starting' | 'working' | 'needs-you' | 'done' | 'stopped' | 'failed'

export interface AgentRun {
  kind: AgentRunKind
  /** What the person asked, for the status line. */
  label: string
  /** The agent that runs it, as a person says it. */
  agent: string
  /** A vault app's bundle, chosen as the run started. */
  appPath?: string
  /** The session ended; a vault app waits for its `app.yaml`. */
  ended?: boolean
  /** The document's view was left while the run went on: it does not open
   *  the app when it finishes, it offers it. */
  away?: boolean
  sessionId: string | null
  /** Which start this run is waiting on (`launchRunAtom`): a start that
   *  resolves for a run since stopped or replaced stops what it started. */
  launch?: number
  status: AgentRunStatus
  /** Set once the session was seen working, so its idle means done. */
  seenWorking: boolean
  message?: string
}

export const documentRunsAtom = atom<Readonly<Record<string, AgentRun>>>({})

export function isRunLive(run: AgentRun | undefined): boolean {
  return (
    run !== undefined &&
    (run.status === 'starting' || run.status === 'working' || run.status === 'needs-you')
  )
}

/** Change the run on `path`, if there is one. */
export const patchRunAtom = atom(
  null,
  (_get, set, { path, patch }: { path: string; patch: Partial<AgentRun> }) =>
    set(documentRunsAtom, (all) => {
      const current = all[path]
      return current === undefined ? all : { ...all, [path]: { ...current, ...patch } }
    }),
)

export async function agentCapability<T>(
  remote: string,
  name: string,
  params: unknown,
): Promise<T> {
  return (await trpc.cap.run.mutate({
    remote,
    name,
    paramsJson: JSON.stringify(params),
  })) as T
}

type StartResult = { ok: true; sessionId: string } | { ok: false; message: string }

let launches = 0

/**
 * Start a run with `capabilityName`, and note its session or why not. A Stop
 * while it starts has no session to stop yet: the run is no longer live when
 * the start comes back (or another run took its place), so the session it
 * started is stopped there and then, never followed.
 */
export const launchRunAtom = atom(
  null,
  async (
    get,
    set,
    {
      remote,
      path,
      capabilityName,
      params,
    }: { remote: string; path: string; capabilityName: string; params: unknown },
  ) => {
    const launch = ++launches
    set(patchRunAtom, { path, patch: { launch } })
    const current = (): AgentRun | undefined => {
      const run = get(documentRunsAtom)[path]
      return run?.launch === launch && isRunLive(run) ? run : undefined
    }
    try {
      const result = await agentCapability<StartResult>(remote, capabilityName, params)
      if (current() === undefined) {
        if (result.ok) {
          await agentCapability(remote, 'agent.stop', { id: result.sessionId }).catch(
            () => undefined,
          )
        }
        return
      }
      set(patchRunAtom, {
        path,
        patch: result.ok
          ? { sessionId: result.sessionId }
          : { status: 'failed', message: result.message },
      })
    } catch (err) {
      if (current() === undefined) return
      set(patchRunAtom, {
        path,
        patch: {
          status: 'failed',
          message: err instanceof Error ? err.message : 'The agent did not start.',
        },
      })
    }
  },
)

/** Each agent's name as main gives it (`agent.providers`), by vault: asked
 *  once, as the first run starts. */
const providerLabelsAtom = atom<{ remote: string; labels: Record<string, string> } | null>(null)

/** The run's agent by name: main's, asked for the first time alongside the
 *  run on `path`, which takes it when it comes; "the agent" until then. */
export const agentLabelAtom = atom(
  null,
  (get, set, { remote, id, path }: { remote: string; id: AgentProviderId; path: string }) => {
    const labels = get(providerLabelsAtom)
    const known = labels !== null && labels.remote === remote ? labels.labels[id] : undefined
    if (known !== undefined) return known
    void agentCapability<readonly { id: string; label: string }[]>(remote, 'agent.providers', {})
      .then((list) => {
        if (!Array.isArray(list)) return
        const byId = Object.fromEntries(list.map((p) => [p.id, p.label]))
        set(providerLabelsAtom, { remote, labels: byId })
        const label = byId[id]
        if (label !== undefined) set(patchRunAtom, { path, patch: { agent: label } })
      })
      .catch(() => undefined)
    return 'the agent'
  },
)

/** What a vault app's session is told: it is watched, and may be added to. */
const VAULT_APP_SYSTEM = [
  "You are Holi's document agent, making a vault app from one markdown document in this vault.",
  'The person can watch this session and add to it; work without waiting on them, and ask only when you cannot go on.',
  'Touch only the files named in the request.',
].join(' ')

/**
 * The vault app a document becomes, beside it: `notes/Plan.md` →
 * `notes/Plan.app`, or `notes/Plan 2.app` and on when that is `taken`.
 */
function vaultAppPathFor(path: string, taken: (bundle: string) => boolean): string {
  const folder = parentOf(path)
  const name = path.slice(folder === '' ? 0 : folder.length + 1)
  const dot = name.lastIndexOf('.')
  const title = dot > 0 ? name.slice(0, dot) : name
  const at = (n: number) =>
    `${folder === '' ? '' : `${folder}/`}${title}${n === 1 ? '' : ` ${n}`}.app`
  let n = 1
  while (taken(at(n))) n += 1
  return at(n)
}

/** Whether anything in the vault is at `bundle` or under it. Case-blind: on
 *  macOS `plan.app` is `Plan.app`. */
function takenIn(snapshot: VaultSnapshot): (bundle: string) => boolean {
  const all = [
    ...snapshot.dirs,
    ...snapshot.files.map((f) => f.path),
    ...snapshot.docs.map((d) => d.path),
  ].map((p) => p.toLowerCase())
  return (bundle) => {
    const b = bundle.toLowerCase()
    return all.some((p) => p === b || p.startsWith(`${b}/`))
  }
}

function vaultAppPrompt(path: string, app: string): string {
  return [
    `Read \`${path}\` and make a Holi vault app of it beside it: the folder \`${app}\`.`,
    "Write `index.html` first: one self-contained page (inline CSS and JS, no network) that presents the document's content as a polished, readable, interactive page, using the theme tokens Holi injects into apps.",
    'Write `app.yaml` last, with a one-line `description`: it is what marks the app finished.',
    `Do not change \`${path}\`.`,
  ].join('\n')
}

/** Whether Create vault app can run on `path` now. */
export const vaultAppOfferAtom = atom((get) => {
  const ready = get(agentSourceAtom) !== null && get(loadedAgentProviderAtom) !== null
  const runs = get(documentRunsAtom)
  return (path: string): boolean =>
    ready && /\.md$/i.test(path) && isAppWritablePath(path) && !isRunLive(runs[path])
})

/** Start Create vault app on `path`, a note saved as it is. Nothing when it
 *  is not offered there. */
export const startVaultAppAtom = atom(null, async (get, set, path: string) => {
  const remote = get(activeRemoteAtom)
  const provider = get(loadedAgentProviderAtom)
  if (remote === null || provider === null || !get(vaultAppOfferAtom)(path)) return
  const appPath = vaultAppPathFor(path, takenIn(get(snapshotAtom)))
  const agent = set(agentLabelAtom, { remote, id: provider, path })
  set(documentRunsAtom, (all) => ({
    ...all,
    [path]: {
      kind: 'vault-app',
      label: 'Creating a vault app',
      agent,
      appPath,
      sessionId: null,
      status: 'starting',
      seenWorking: false,
    },
  }))
  const name = path.slice(path.lastIndexOf('/') + 1).replace(/\.md$/i, '')
  await set(launchRunAtom, {
    remote,
    path,
    capabilityName: 'agent.scoped',
    params: {
      provider,
      name: `${name}: vault app`,
      prompt: vaultAppPrompt(path, appPath),
      // Sonnet is Claude Code's; another agent runs on its own default.
      ...(provider === 'claude' ? { model: AGENT_MODEL } : {}),
      system: VAULT_APP_SYSTEM,
      scope: { read: [path], write: [`${appPath}/**`] },
    },
  })
})
