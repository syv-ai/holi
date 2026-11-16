import React from 'react'
import { createRoot } from 'react-dom/client'
import { createStore } from 'jotai'
import { Provider } from 'jotai/react'
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
      if (event.data?.kind === 'bridge-read-result') {
        const output = document.querySelector('#bridge-read-result')
        if (output) output.textContent = event.data.text
        if (typeof event.data.owner === 'string' && typeof event.data.nonce === 'string') {
          state.fixtureNonces![event.data.owner.toLowerCase()] = event.data.nonce
        }
      }
      if (event.data?.kind === 'stale-result' || event.data?.kind === 'replacement-result') {
        const output = document.querySelector('#stale-result')
        if (output) output.textContent = String(event.data.value)
      }
    }
    addEventListener('message', change)
    return () => removeEventListener('message', change)
  }, [])
  return (
    <main style={{ width: '760px', height: '500px', background: '#fff' }}>
      <output id="active-vault">{remote}</output>
      <pre id="bridge-read-result">waiting</pre>
      <output id="stale-result"></output>
      <AppFrame key={reload} path={bundle} visible={visible} />
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
