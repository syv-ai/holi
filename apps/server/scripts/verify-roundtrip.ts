/** Append text to a doc over the real WebSocket, or read it back.
 * Run: pnpm --filter @holi/server exec tsx scripts/verify-roundtrip.ts <docId> <token> [textToAppend] */
import { HocuspocusProvider } from '@hocuspocus/provider'
import WebSocket from 'ws'
import * as Y from 'yjs'
import { YDOC_TEXT_KEY } from '@holi/shared'

const [docId, token, textToAppend] = process.argv.slice(2)
if (!docId || !token) throw new Error('usage: verify-roundtrip.ts <docId> <token> [textToAppend]')

const doc = new Y.Doc()
const provider = new HocuspocusProvider({
  url: 'ws://127.0.0.1:4444',
  name: docId,
  token,
  document: doc,
  WebSocketPolyfill: WebSocket as never,
  onSynced() {
    const text = doc.getText(YDOC_TEXT_KEY)
    if (textToAppend) {
      text.insert(text.length, textToAppend)
      console.log(`[write] appended; doc now: ${JSON.stringify(text.toString())}`)
    } else {
      console.log(`[read] doc content: ${JSON.stringify(text.toString())}`)
    }
    // give the relay's debounced store time to flush before exiting
    setTimeout(() => {
      provider.destroy()
      process.exit(0)
    }, 3000)
  },
  onAuthenticationFailed({ reason }) {
    console.error(`[auth] rejected: ${reason}`)
    process.exit(1)
  },
})
