import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { Awareness } from 'y-protocols/awareness'
import { BRIDGE_ORIGIN, PEER_ORIGIN, YDOC_TEXT_KEY, YjsLink } from '../src'

/**
 * The renderer↔main link (D59). Both ends run this same class, so the fixture below is
 * the real thing on both sides: two real `Y.Doc`s, two real `Awareness`, wired to each
 * other through counted transports.
 *
 * The property worth being sure about is **echo suppression**. Its failure mode is not a
 * wrong answer, it is an infinite loop between two processes — so every test here that
 * asserts "did not echo" is written to be able to fail (see the mutation notes in the
 * commit; breaking `origin === PEER_ORIGIN` must turn these red).
 */

/** Two linked peers, plus a count of what actually crossed the wire each way. */
function linkedPair() {
  const mainDoc = new Y.Doc()
  const rendererDoc = new Y.Doc()
  const mainAwareness = new Awareness(mainDoc)
  const rendererAwareness = new Awareness(rendererDoc)

  const sent = { toRenderer: 0, toMain: 0, awarenessToRenderer: 0, awarenessToMain: 0 }
  let main: YjsLink
  let renderer: YjsLink

  main = new YjsLink(mainDoc, mainAwareness, {
    sendUpdate: (u) => {
      sent.toRenderer++
      renderer.applyUpdate(u)
    },
    sendAwareness: (u) => {
      sent.awarenessToRenderer++
      renderer.applyAwareness(u)
    },
  })
  renderer = new YjsLink(rendererDoc, rendererAwareness, {
    sendUpdate: (u) => {
      sent.toMain++
      main.applyUpdate(u)
    },
    sendAwareness: (u) => {
      sent.awarenessToMain++
      main.applyAwareness(u)
    },
  })

  return { mainDoc, rendererDoc, mainAwareness, rendererAwareness, main, renderer, sent }
}

const text = (doc: Y.Doc) => doc.getText(YDOC_TEXT_KEY).toString()

describe('YjsLink — doc updates', () => {
  it('carries a renderer edit to main', () => {
    const { rendererDoc, mainDoc } = linkedPair()
    rendererDoc.getText(YDOC_TEXT_KEY).insert(0, 'typed in the editor')
    expect(text(mainDoc)).toBe('typed in the editor')
  })

  it('carries a main edit to the renderer', () => {
    const { rendererDoc, mainDoc } = linkedPair()
    mainDoc.getText(YDOC_TEXT_KEY).insert(0, 'arrived from the relay')
    expect(text(rendererDoc)).toBe('arrived from the relay')
  })

  // THE loop guard. Without it these two ping-pong forever and the app hangs; with a
  // naive guard they go quiet and nothing syncs. Both failure modes are caught by
  // counting what crossed rather than by asserting the text.
  it('does not echo an update back to the sender', () => {
    const { rendererDoc, sent } = linkedPair()
    rendererDoc.getText(YDOC_TEXT_KEY).insert(0, 'x')
    expect(sent.toMain).toBe(1)
    expect(sent.toRenderer).toBe(0) // main must not bounce it back
  })

  it('does not echo in the other direction either', () => {
    const { mainDoc, sent } = linkedPair()
    mainDoc.getText(YDOC_TEXT_KEY).insert(0, 'x')
    expect(sent.toRenderer).toBe(1)
    expect(sent.toMain).toBe(0)
  })

  // The agent writes a file; DocBridge applies it to main's doc under BRIDGE_ORIGIN. That
  // is not a peer echo — it is the agent's edit, and the user must watch it land. A guard
  // that skipped every tagged origin instead of only the peer's would make the agent
  // invisible in the editor, which is a lie of exactly the kind D59 exists to stop.
  it('forwards a BRIDGE_ORIGIN update — the agent must be visible', () => {
    const { mainDoc, rendererDoc } = linkedPair()
    const other = new Y.Doc()
    other.getText(YDOC_TEXT_KEY).insert(0, 'the agent wrote this')
    Y.applyUpdate(mainDoc, Y.encodeStateAsUpdate(other), BRIDGE_ORIGIN)
    expect(text(rendererDoc)).toBe('the agent wrote this')
  })

  it('converges on concurrent edits from both ends', () => {
    const { mainDoc, rendererDoc } = linkedPair()
    rendererDoc.getText(YDOC_TEXT_KEY).insert(0, 'renderer')
    mainDoc.getText(YDOC_TEXT_KEY).insert(0, 'main ')
    expect(text(mainDoc)).toBe(text(rendererDoc))
  })

  it('hands a linking peer the full current state', () => {
    const mainDoc = new Y.Doc()
    mainDoc.getText(YDOC_TEXT_KEY).insert(0, 'already here before you linked')
    const link = new YjsLink(mainDoc, null, { sendUpdate: () => {}, sendAwareness: () => {} })
    const fresh = new Y.Doc()
    Y.applyUpdate(fresh, link.stateAsUpdate())
    expect(text(fresh)).toBe('already here before you linked')
  })

  it('goes quiet once destroyed', () => {
    const { rendererDoc, sent, renderer } = linkedPair()
    renderer.destroy()
    rendererDoc.getText(YDOC_TEXT_KEY).insert(0, 'after teardown')
    expect(sent.toMain).toBe(0)
  })
})

describe('YjsLink — awareness', () => {
  it('carries the renderer’s local state to main (this is a remote cursor)', () => {
    const { rendererAwareness, mainAwareness, rendererDoc } = linkedPair()
    rendererAwareness.setLocalStateField('user', { name: 'Nicolai', color: '#f97316' })
    expect(mainAwareness.getStates().get(rendererDoc.clientID)).toMatchObject({
      user: { name: 'Nicolai', color: '#f97316' },
    })
  })

  // main stamps agentEditing on ITS awareness (vault-mirror onTurnState, D37). The
  // renderer reads it via agentEditingIn to render "Claude is editing…", so it has to
  // cross the link or that marker goes dark again.
  it('carries main’s agentEditing to the renderer', () => {
    const { mainAwareness, rendererAwareness, mainDoc } = linkedPair()
    mainAwareness.setLocalStateField('agentEditing', true)
    expect(rendererAwareness.getStates().get(mainDoc.clientID)).toMatchObject({
      agentEditing: true,
    })
  })

  it('carries the cleared field too, so the marker can go away', () => {
    const { mainAwareness, rendererAwareness, mainDoc } = linkedPair()
    mainAwareness.setLocalStateField('agentEditing', true)
    mainAwareness.setLocalStateField('agentEditing', null)
    expect(rendererAwareness.getStates().get(mainDoc.clientID)).toMatchObject({
      agentEditing: null,
    })
  })

  it('does not echo awareness back to the sender', () => {
    const { rendererAwareness, sent } = linkedPair()
    rendererAwareness.setLocalStateField('user', { name: 'Nicolai' })
    expect(sent.awarenessToMain).toBe(1)
    expect(sent.awarenessToRenderer).toBe(0)
  })

  // Awareness only emits on CHANGE, so a turn already in flight (or a teammate sitting
  // still) when the editor opens would be invisible until it happened to move. The
  // renderer's very first paint depends on this snapshot carrying real state.
  it('hands a linking peer the awareness that predates the link', () => {
    const mainDoc = new Y.Doc()
    const mainAwareness = new Awareness(mainDoc)
    mainAwareness.setLocalStateField('agentEditing', true) // a turn already in flight
    const link = new YjsLink(mainDoc, mainAwareness, {
      sendUpdate: () => {},
      sendAwareness: () => {},
    })

    const peerDoc = new Y.Doc()
    const peerAwareness = new Awareness(peerDoc)
    const peerLink = new YjsLink(peerDoc, peerAwareness, {
      sendUpdate: () => {},
      sendAwareness: () => {},
    })
    peerLink.applyAwareness(link.awarenessAsUpdate()!)

    expect(peerAwareness.getStates().get(mainDoc.clientID)).toMatchObject({
      agentEditing: true,
    })
  })

  it('reports nothing to send when nobody is present', () => {
    const doc = new Y.Doc()
    const awareness = new Awareness(doc)
    // Awareness registers its own client on construction, so "empty" has to be made.
    awareness.setLocalState(null)
    const link = new YjsLink(doc, awareness, {
      sendUpdate: () => {},
      sendAwareness: () => {},
    })
    expect(link.awarenessAsUpdate()).toBeNull()
  })
})

describe('PEER_ORIGIN', () => {
  // main and the renderer are separate bundles. A bare `Symbol()` would be a different
  // value in each, so every update would look non-peer, forward straight back, and loop.
  it('is registry-global so it survives a bundle boundary', () => {
    expect(PEER_ORIGIN).toBe(Symbol.for('holi.yjs-link.peer'))
  })
})
