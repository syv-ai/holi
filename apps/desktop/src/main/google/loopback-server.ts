/**
 * The real redirect catcher — a `node:http` server that lives for one request.
 *
 * Split from `loopback-flow.ts` so the flow's state machine can be tested with
 * a three-line fake instead of a socket, and so the only thing that binds a
 * port is the thing whose job is binding a port.
 */
import { createServer } from 'node:http'
import { CLOSE_PAGE, type LoopbackServer } from './loopback-flow'

/**
 * Bind `127.0.0.1:0` and hand back the port the OS assigned.
 *
 * **Port 0, never a fixed one.** A hardcoded port is a collision waiting for
 * the one user who already has something on it, and the failure surfaces as
 * "connecting Google is broken on my machine" with nothing to point at.
 *
 * **`127.0.0.1`, not `localhost`.** The literal cannot be redirected by a hosts
 * file, and it is what gets registered as the redirect URI.
 */
export function listenLoopback(): Promise<LoopbackServer> {
  return new Promise((resolve, reject) => {
    let deliver: ((params: Record<string, string>) => void) | null = null
    let pending: Record<string, string> | null = null

    const server = createServer((req, res) => {
      // A browser asks for /favicon.ico too; only the redirect carries a query.
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      const params: Record<string, string> = {}
      for (const [k, v] of url.searchParams) params[k] = v

      if (Object.keys(params).length === 0) {
        res.writeHead(204).end()
        return
      }

      // Answer *before* handing off: the tab is a real browser window waiting on
      // this response, and closing the server with the request unanswered leaves
      // the user staring at a spinner on a page that already succeeded.
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(`<!doctype html><meta charset="utf-8"><title>Holi</title><p>${CLOSE_PAGE}</p>`)

      if (deliver !== null) deliver(params)
      // The redirect can land before anyone awaits it; hold it rather than drop it.
      else pending = params
    })

    server.once('error', reject)

    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (address === null || typeof address === 'string') {
        server.close()
        reject(new Error('the loopback listener did not report a port'))
        return
      }

      resolve({
        port: address.port,
        waitForRedirect: () =>
          new Promise<Record<string, string>>((resolveRedirect) => {
            if (pending !== null) resolveRedirect(pending)
            else deliver = resolveRedirect
          }),
        // `closeAllConnections` because a keep-alive socket from the browser
        // keeps `close()` pending indefinitely, and the port would stay held.
        close: () => {
          server.closeAllConnections()
          server.close()
        },
      })
    })
  })
}
