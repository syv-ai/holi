import React from 'react'
import { createRoot } from 'react-dom/client'
import { createStore, useAtomValue } from 'jotai'
import { Provider, useSetAtom } from 'jotai/react'
import { activeModeAtom, vimCodeEditingAtom } from './app-frame-renderer-fixture-api'
import { HostHintLayer } from '../src/renderer/src/features/shell/host-hint-layer'
import { useShortcutDispatcher } from '../src/renderer/src/hooks/use-shortcuts'
import './app-frame-renderer-fixture.css'
import * as fixtureApi from './app-frame-renderer-fixture-api'

const { activeRemoteAtom, snapshotAtom } = fixtureApi
void Object.values(fixtureApi)
import { AppFrame } from '../src/plugins/apps/renderer/app-frame'

export type RendererFixtureMarker = never

const bundle = 'Same/Tool.app'
const files = [
  { path: `${bundle}/index.html` },
  { path: `${bundle}/app.yaml` },
  { path: 'note.md' },
]
const store = createStore()
store.set(snapshotAtom, { files, docs: [], claimed: {} })

function Fixture() {
  const [remote, setRemote] = React.useState('ada/a')
  const [visible, setVisible] = React.useState(true)
  const [reload, setReload] = React.useState(0)
  const [mode, setMode] = React.useState<'light' | 'dark'>('dark')
  const [focused, setFocused] = React.useState(true)
  const [split, setSplit] = React.useState(false)
  const setVim = useSetAtom(vimCodeEditingAtom)
  const vimEnabled = useAtomValue(vimCodeEditingAtom)
  useShortcutDispatcher()
  React.useEffect(() => {
    ;(window as Window & { fixtureVimEnabled?: boolean }).fixtureVimEnabled = vimEnabled
  }, [vimEnabled])
  React.useEffect(() => {
    document.documentElement.dataset.theme = mode
  }, [mode])
  React.useEffect(() => {
    const state = window as Window & { fixtureNonces?: Record<string, string> }
    state.fixtureNonces ??= {}
    const change = (event: MessageEvent) => {
      if (event.data?.kind === 'fixture-vault') {
        store.set(activeRemoteAtom, event.data.remote)
        setRemote(event.data.remote)
      }
      if (event.data?.kind === 'fixture-visible') setVisible(event.data.visible)
      if (event.data?.kind === 'fixture-reload') setReload((value) => value + 1)
      if (event.data?.kind === 'fixture-vim') setVim(Boolean(event.data.enabled))
      if (event.data?.kind === 'fixture-mode') {
        const nextMode = event.data.mode === 'light' ? 'light' : 'dark'
        store.set(activeModeAtom, nextMode)
        setMode(nextMode)
      }
      if (event.data?.kind === 'fixture-focused') setFocused(Boolean(event.data.focused))
      if (event.data?.kind === 'fixture-split') setSplit(Boolean(event.data.split))
      if (event.data?.kind === 'fixture-overlay') {
        document.querySelector('#fixture-host-overlay')?.remove()
        if (event.data.show) {
          const overlay = document.createElement('div')
          overlay.id = 'fixture-host-overlay'
          Object.assign(overlay.style, {
            position: 'fixed',
            inset: '0',
            zIndex: '1000',
            background: 'transparent',
          })
          document.body.append(overlay)
        }
      }
      if (event.data?.kind === 'bridge-read-result') {
        const output = document.querySelector('#bridge-read-result')
        if (output) output.textContent = event.data.text
        if (typeof event.data.owner === 'string' && typeof event.data.nonce === 'string') {
          state.fixtureNonces![event.data.owner.toLowerCase()] = event.data.nonce
        }
      }
      if (
        event.data?.kind === 'guest-action-count' &&
        event.source === document.querySelector('iframe')?.contentWindow &&
        event.data.nonce === state.fixtureNonces?.a
      ) {
        const output = document.querySelector('#guest-action-count')
        if (output) output.textContent = String(event.data.count)
      }
      if (
        event.data?.kind === 'fixture-input-focused' &&
        event.source === document.querySelector('iframe')?.contentWindow &&
        event.data.nonce === state.fixtureNonces?.a
      ) {
        ;(window as Window & { fixtureInputFocused?: boolean }).fixtureInputFocused = Boolean(
          event.data.value,
        )
      }
      if (
        event.data?.kind === 'fixture-neutral-focused' &&
        event.source === document.querySelector('iframe')?.contentWindow &&
        event.data.nonce === state.fixtureNonces?.a
      ) {
        ;(window as Window & { fixtureNeutralFocused?: boolean }).fixtureNeutralFocused =
          event.data.value === true
      }
      if (event.data?.kind === 'guest-input-value') {
        const output = document.querySelector('#guest-input-value')
        if (output) output.textContent = String(event.data.value)
      }
      if (event.data?.kind === 'guest-shadow-input') {
        ;(window as Window & { fixtureShadowInput?: string }).fixtureShadowInput =
          `${event.data.editor}:${event.data.value}`
      }
      if (event.data?.kind === 'fixture-shadow-focused') {
        ;(window as Window & { fixtureShadowFocused?: string }).fixtureShadowFocused = String(
          event.data.editor,
        )
      }
      if (event.data?.kind === 'stale-result' || event.data?.kind === 'replacement-result') {
        const output = document.querySelector('#stale-result')
        if (output) output.textContent = String(event.data.value)
      }
    }
    addEventListener('message', change)
    return () => removeEventListener('message', change)
  }, [setVim])
  return (
    <main className={`fixture ${mode}`} style={{ width: '760px', height: '500px' }}>
      <output id="active-vault">{remote}</output>
      <pre id="bridge-read-result">waiting</pre>
      <output id="stale-result"></output>
      <output id="guest-action-count">0</output>
      <output id="guest-input-value"></output>
      <section
        data-pane
        data-pane-focused={split ? (focused ? 'true' : undefined) : undefined}
        aria-label="App pane"
      >
        <AppFrame key={reload} path={bundle} visible={visible} />
      </section>
      {split ? <section data-pane aria-label="Other pane" /> : null}
      <HostHintLayer scopeKey={`app-frame-smoke:${remote}:${visible}:${reload}:${focused}`} />
    </main>
  )
}

createRoot(document.getElementById('root')!, {
  onUncaughtError: (error, info) =>
    console.error('FIXTURE UNCAUGHT', String(error), JSON.stringify(info.componentStack)),
}).render(
  <Provider store={store}>
    <Fixture />
  </Provider>,
)
