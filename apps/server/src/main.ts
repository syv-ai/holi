import { Hocuspocus } from '@hocuspocus/server'
import { createHTTPServer } from '@trpc/server/adapters/standalone'
import { appRouter } from './router'

const RELAY_PORT = 4444
const API_PORT = 4000

const relay = new Hocuspocus({ port: RELAY_PORT })
void relay.listen().then(() => {
  console.log(`[relay] Hocuspocus listening on ws://127.0.0.1:${RELAY_PORT}`)
})

createHTTPServer({ router: appRouter }).listen(API_PORT)
console.log(`[api] tRPC listening on http://127.0.0.1:${API_PORT}`)
