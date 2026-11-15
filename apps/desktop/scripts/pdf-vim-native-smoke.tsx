import { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { createStore, Provider, useAtomValue, useSetAtom } from 'jotai'
import { PdfViewer } from '../src/plugins/pdf/renderer/pdf-viewer'
import { HostHintLayer } from '../src/renderer/src/features/shell/host-hint-layer'
import { useShortcutDispatcher } from '../src/renderer/src/hooks/use-shortcuts'
import { vimCodeEditingAtom } from '../src/renderer/src/state/preferences'
import { colorSchemeAtom } from '../src/renderer/src/state/color-scheme'
import { activeModeAtom, activeRemoteAtom, snapshotAtom } from '../src/renderer/src/plugin-api'
import { emptyVaultSnapshot } from '@holi/shared'
import '../src/renderer/src/index.css'

const store = createStore()
const surfaceEvents: { registered: boolean; buttons: number }[] = []
window.addEventListener('holi:vim-host-hint-surface', (event) => {
  const detail = (event as CustomEvent<{ root: ShadowRoot; registered: boolean }>).detail
  surfaceEvents.push({
    registered: detail.registered,
    buttons: detail.root.querySelectorAll('button').length,
  })
})
const fixtureWindow = window as unknown as Window & {
  __holiPdfSmoke: {
    vim(enabled: boolean): void
    remote(remote: string): void
    viewer(path: string, visible: boolean, focused: boolean): void
    mode(mode: 'dark' | 'light'): void
    focusPane(focused: 'a' | 'b'): void
    mutateShadow(): void
    setOverlay(visible: boolean): void
    state(): unknown
    surfaces(): unknown
  }
}
let controls: {
  vim(enabled: boolean): void
  remote(remote: string): void
  viewer(path: string, visible: boolean, focused: boolean): void
  mode(mode: 'dark' | 'light'): void
  focusPane(focused: 'a' | 'b'): void
  mutateShadow(): void
  setOverlay(visible: boolean): void
  state(): unknown
  surfaces(): unknown
} | null = null
fixtureWindow.__holiPdfSmoke = {
  vim: (enabled) => controls?.vim(enabled),
  remote: (remote) => controls?.remote(remote),
  viewer: (path, visible, focused) => controls?.viewer(path, visible, focused),
  mode: (mode) => controls?.mode(mode),
  focusPane: (focused) => controls?.focusPane(focused),
  mutateShadow: () => controls?.mutateShadow(),
  setOverlay: (visible) => controls?.setOverlay(visible),
  state: () => controls?.state(),
  surfaces: () => surfaceEvents,
}

function Fixture() {
  const [path, setPath] = useState('docs/fixture.pdf')
  const [visible, setVisible] = useState(true)
  const [focused, setFocused] = useState(true)
  const [overlay, setOverlay] = useState(false)
  const setVim = useSetAtom(vimCodeEditingAtom)
  const setRemote = useSetAtom(activeRemoteAtom)
  const remote = useAtomValue(activeRemoteAtom)
  const setMode = useSetAtom(colorSchemeAtom)
  const mode = useAtomValue(activeModeAtom)
  useEffect(() => {
    document.documentElement.dataset.theme = mode
  }, [mode])
  useShortcutDispatcher()
  useEffect(() => {
    setVim(true)
    setRemote('synthetic/vault-a')
    store.set(snapshotAtom, {
      ...emptyVaultSnapshot(),
      files: [{ path: 'docs/fixture.pdf', updatedAt: 'a-1' }],
    })
  }, [setVim, setRemote])
  useEffect(() => {
    controls = {
      vim: setVim,
      remote: (remote) => {
        setRemote(remote)
        store.set(snapshotAtom, {
          ...emptyVaultSnapshot(),
          files: [{ path, updatedAt: `${remote}-1` }],
        })
      },
      viewer: (nextPath, nextVisible, nextFocused) => {
        setPath(nextPath)
        setVisible(nextVisible)
        setFocused(nextFocused)
      },
      mode: setMode,
      focusPane: (pane) => setFocused(pane === 'a'),
      mutateShadow: () => {
        const root = document.querySelector('holi-pdf-container')?.shadowRoot
        const text = root?.querySelector('.epdf-page') ?? root?.querySelector('[class*="page"]')
        if (text) text.setAttribute('data-smoke-mutation', String(Date.now()))
        else root?.append(document.createElement('smoke-mutation'))
      },
      setOverlay,
      state: () => ({ path, visible, focused, remote: store.get(activeRemoteAtom) }),
      surfaces: () => surfaceEvents,
    }
    return () => {
      controls = null
    }
  }, [setVim, setRemote, setMode, path, visible, focused])
  return (
    <div className="flex h-screen" data-smoke-split>
      <section
        className="relative flex min-w-0 flex-1 flex-col"
        data-pane
        data-pane-focused={focused}
        data-pane-id="a"
      >
        <div className="flex h-10 items-center px-2">
          <button type="button" data-smoke-host-action="">
            Synthetic host action
          </button>
        </div>
        <div className="flex min-h-0 flex-1 flex-col" data-pdf-fixture="a">
          <PdfViewer path={path} visible={visible} focused={focused} />
        </div>
      </section>
      <section
        className="flex min-w-0 flex-1 flex-col"
        data-pane
        data-pane-focused={!focused}
        data-pane-id="b"
      >
        <div className="flex min-h-0 flex-1 flex-col" data-pdf-fixture="b">
          <PdfViewer path="docs/fixture.pdf" visible focused={!focused} />
        </div>
      </section>
      {overlay && <div data-smoke-occluder className="fixed inset-0 z-50" />}
      <HostHintLayer scopeKey={`${remote}:${path}:${visible}:${focused}`} />
    </div>
  )
}

createRoot(document.getElementById('root')!).render(
  <Provider store={store}>
    <Fixture />
  </Provider>,
)
