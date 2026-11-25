// Each isolated Vitest file gets its own mocks, store and cleanup. Import this
// fixture first so Vitest hoists the tRPC mock before evaluating FileView.
import { emptyVaultSnapshot, type MdxDiagnostic, type MdxExternalResourceState } from '@holi/shared'
import { createStore, Provider } from 'jotai'
import { afterEach, vi } from 'vitest'
import { render, waitFor } from '@/test/render'
import { coreContributionAtom } from '@/state/plugins'
import { vimCodeEditingAtom } from '@/state/preferences'
import { activeRemoteAtom, openedRemoteAtom, snapshotAtom } from '@/state/vaults'
import { sessionAtom } from '@/state/session'
import { FileView } from '@/features/files/file-view'
import { HostHintLayer } from '@/features/shell/host-hint-layer'
import { useShortcutDispatcher } from '@/hooks/use-shortcuts'

export let lastStore: ReturnType<typeof createStore>
export const compiledGeneration = new Map<string, number>()
export const read = vi.fn()
export const write = vi.fn()
export const historyList = vi.fn()
export const fileDiff = vi.fn()
export const mdxStatus = vi.fn()
export const mdxApprove = vi.fn()
export const mdxRevoke = vi.fn()
export const mdxCompile = vi.fn<
  (input: { lease: string; generation: number; source: string }) => Promise<MdxDiagnostic[]>
>(async () => [])
export const mdxAcquire = vi.fn<
  (input: { remote: string; path: string; context: string }) => Promise<{ lease: string }>
>(async () => ({ lease: 'test-lease' }))
export const mdxCancel = vi.fn<
  (input: { lease: string; generation: number }) => Promise<{ ok: true }>
>(async () => ({ ok: true }))
const mdxRelease = vi.fn<(input: { lease: string }) => Promise<{ ok: true }>>(async () => ({
  ok: true,
}))
export const mdxResources = vi.fn(
  async ({ lease }: { lease: string }): Promise<MdxExternalResourceState> => ({
    generation: compiledGeneration.get(lease) ?? 0,
    pending: [],
    approved: [],
  }),
)
export const mdxAllow =
  vi.fn<(input: { lease: string; requestId: string }) => Promise<{ ok: true }>>()
export const mdxDeny =
  vi.fn<(input: { lease: string; requestId: string }) => Promise<{ ok: true }>>()
export const mdxRevokeResource =
  vi.fn<(input: { lease: string; grantId: string }) => Promise<{ ok: true }>>()

vi.mock('@/lib/trpc', () => ({
  trpc: {
    notes: {
      read: { query: (input: unknown) => read(input) },
      write: { mutate: (input: unknown) => write(input) },
    },
    github: {
      fileContributors: { query: () => Promise.resolve([]) },
    },
    history: {
      list: { query: (input: unknown) => historyList(input) },
      fileDiff: { query: (input: unknown) => fileDiff(input) },
    },
    mdxTrust: {
      status: { query: (input: unknown) => mdxStatus(input) },
      approve: { mutate: (input: unknown) => mdxApprove(input) },
      revoke: { mutate: (input: unknown) => mdxRevoke(input) },
      compile: {
        mutate: (input: { lease: string; generation: number; source: string }) => {
          compiledGeneration.set(input.lease, input.generation)
          return mdxCompile(input)
        },
      },
      externalResources: { query: (input: { lease: string }) => mdxResources(input) },
      approveExternalResource: {
        mutate: (input: { lease: string; requestId: string }) => mdxAllow(input),
      },
      rejectExternalResource: {
        mutate: (input: { lease: string; requestId: string }) => mdxDeny(input),
      },
      revokeExternalResource: {
        mutate: (input: { lease: string; grantId: string }) => mdxRevokeResource(input),
      },
      acquireDiagnosticsLease: {
        mutate: (input: Parameters<typeof mdxAcquire>[0]) => mdxAcquire(input),
      },
      cancelCompile: { mutate: (input: { lease: string; generation: number }) => mdxCancel(input) },
      releaseDiagnosticsLease: { mutate: (input: { lease: string }) => mdxRelease(input) },
    },
  },
}))

afterEach(() => {
  read.mockReset()
  write.mockReset()
  historyList.mockReset()
  fileDiff.mockReset()
  mdxStatus.mockReset()
  mdxApprove.mockReset()
  mdxRevoke.mockReset()
  vi.unstubAllGlobals()
  compiledGeneration.clear()
  mdxCompile.mockReset()
  mdxResources.mockReset()
  mdxAllow.mockReset()
  mdxDeny.mockReset()
  mdxRevokeResource.mockReset()
  mdxAcquire.mockReset()
  mdxCancel.mockReset()
  mdxRelease.mockReset()
})

function HintKeys() {
  useShortcutDispatcher()
  return <HostHintLayer scopeKey="fixture:file" />
}

export function createFileViewStore(path: string, vimEnabled?: boolean) {
  const store = createStore()
  lastStore = store
  store.set(activeRemoteAtom, 'syv-ai/site')
  store.set(openedRemoteAtom, 'syv-ai/site')
  store.set(sessionAtom, { login: 'fixture-user' })
  if (vimEnabled !== undefined) store.set(vimCodeEditingAtom, vimEnabled)
  store.set(snapshotAtom, {
    ...emptyVaultSnapshot(),
    files: [{ path, updatedAt: '2026-10-23T10:00:00Z' }],
  })
  return store
}

export function setup(path: string, claims = false, vimEnabled = false, hints = false) {
  const store = createFileViewStore(path, vimEnabled)
  if (claims) {
    store.set(coreContributionAtom, {
      surfaces: [],
      rail: [],
      claims: [
        {
          match: (p: string) => p.endsWith('.pdf'),
          view: ({ path: p }: { path: string }) => <p>Claimed {p}</p>,
        },
      ],
    })
  }
  return render(
    <Provider store={store}>
      <FileView path={path} />
      {hints ? <HintKeys /> : null}
    </Provider>,
  )
}

/** Types into the CodeMirror document, the way a keystroke would land. */
export async function typeInto(text: string) {
  const content = await waitFor(() => {
    const node = document.querySelector<HTMLElement>('.cm-content')
    if (node === null) throw new Error('no editor yet')
    return node
  })
  const { EditorView } = await import('@codemirror/view')
  const view = EditorView.findFromDOM(content)!
  view.dispatch({
    changes: { from: 0, to: view.state.doc.length, insert: text },
  })
}
