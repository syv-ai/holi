import assert from 'node:assert/strict'
import { app, BrowserWindow, session, type WebContents } from 'electron'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { MdxCompiler } from '../src/main/mdx-compiler'

type Mode = 'policy' | 'crash' | 'hang' | 'hold'
const origin = 'https://mdx-compiler.invalid'

/** Native fixture instrumentation; this module is never imported by the app. */
export async function createGuestProbes() {
  let traffic = 0
  const server = createServer((_request, response) => {
    traffic += 1
    response.writeHead(200).end('unexpected guest traffic')
  })
  server.on('upgrade', (_request, socket) => {
    traffic += 1
    socket.destroy()
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  let next: Mode | null = null
  let prepared: ((contents: WebContents) => void) | null = null
  let policy: Record<string, unknown> | null = null
  let executionChecks = 0
  let probeFailure: Error | null = null
  const storage: Array<{ cookie: string; local: number; session: number }> = []
  const children = new Set<WebContents>()
  await session.defaultSession.cookies.set({
    url: origin,
    name: 'synthetic-default-session-secret',
    value: '507-disposable-cookie',
  })

  const observe = (_event: Electron.Event, contents: WebContents) => {
    if (contents.session === session.defaultSession) return
    children.add(contents)
    contents.once('destroyed', () => children.delete(contents))
    const mode = next
    next = null
    contents.on('console-message', (details) => {
      if (details.message === 'MDX507_OUTPUT_NOT_EXECUTED') executionChecks += 1
      if (details.message === 'MDX507_OUTPUT_EXECUTED')
        probeFailure = new Error('MDX document code executed inside the compiler guest')
    })
    contents.once('did-finish-load', () => {
      if (contents.getURL() !== `${origin}/guest.html`) {
        probeFailure = new Error('Unexpected compiler guest document')
        return
      }
      if (mode === 'crash') {
        contents.forcefullyCrashRenderer()
        return
      }
      if (mode === 'hang') {
        void contents.executeJavaScript('for (;;) {}').catch(() => undefined)
        return
      }
      if (mode === 'hold') {
        void contents
          .executeJavaScript('window.__holiMdxReceive = () => undefined; true')
          .then(() => prepared?.(contents))
          .catch((error: Error) => {
            probeFailure = error
          })
        return
      }
      const probe = `(() => {
        if (${mode === 'policy'}) {
          const receive = window.__holiMdxReceive;
          let pending;
          window.__holiMdxReceive = data => { pending = data };
          window.__release507 = () => {
            window.__holiMdxReceive = receive;
            if (pending !== undefined) receive(pending);
          };
        }
        const original = window.__holiMdxTakeResult;
        window.__holiMdxTakeResult = () => {
          const answer = original();
          if (answer) console.debug(globalThis.__mdxSmokeExecuted === undefined
            ? 'MDX507_OUTPUT_NOT_EXECUTED' : 'MDX507_OUTPUT_EXECUTED');
          return answer;
        };
        return {
          globals: [typeof process, typeof require, typeof holi, typeof electron, typeof holiSmoke],
          cookie: document.cookie, local: localStorage.length, session: sessionStorage.length,
        };
      })()`
      void contents
        .executeJavaScript(probe)
        .then(async (result) => {
          assert.deepEqual(result.globals, Array(5).fill('undefined'))
          assert.equal(result.cookie, '')
          assert.equal(result.local, 0)
          assert.equal(result.session, 0)
          storage.push(result)
          if (mode !== 'policy') return
          policy = await contents.executeJavaScript(`(async () => {
            const denied = async (url, options) => {
              try { await fetch(url, options); return false } catch { return true }
            };
            const bounded = (promise) => Promise.race([
              promise, new Promise(resolve => setTimeout(() => resolve('timeout'), 350))
            ]);
            const results = {};
            results.loopback = await denied(${JSON.stringify(endpoint + '/canary')});
            results.external = await denied('https://outside.invalid/canary');
            results.file = await denied('file:///etc/passwd');
            results.holi = await denied('holi://vault/private');
            results.assetLookalike = await denied('${origin}/guest.js?extra=1');
            results.post = await denied('${origin}/guest.js', {method:'POST', body:'x'});
            try { navigator.sendBeacon(${JSON.stringify(endpoint + '/beacon')}, 'x') } catch {}
            results.beacon = true;
            results.websocket = await bounded(new Promise(resolve => {
              try {
                const socket = new WebSocket(${JSON.stringify(endpoint.replace('http:', 'ws:'))});
                socket.addEventListener('error', () => { socket.close(); resolve(true) }, {once:true});
                socket.addEventListener('open', () => { socket.close(); resolve(false) }, {once:true});
              } catch { resolve(true) }
            }));
            results.popup = window.open('https://outside.invalid/') === null;
            results.permission = await bounded(Notification.requestPermission()) === 'denied';
            results.media = await bounded(navigator.mediaDevices.getUserMedia({audio:true})
              .then(stream => { stream.getTracks().forEach(track => track.stop()); return false }, () => true));
            const link = document.createElement('a');
            link.href = ${JSON.stringify(endpoint + '/download')}; link.download = 'denied.txt';
            document.body.append(link); link.click(); link.remove();
            localStorage.setItem('previous-guest', 'synthetic');
            sessionStorage.setItem('previous-guest', 'synthetic');
            location.href = '${origin}/not-an-asset';
            await new Promise(resolve => setTimeout(resolve, 100));
            results.navigation = location.href === '${origin}/guest.html';
            return results;
          })()`)
          await contents.executeJavaScript('window.__release507()')
        })
        .catch((error: Error) => {
          probeFailure = error
        })
    })
  }
  app.on('web-contents-created', observe)

  return {
    async policy(compiler: MdxCompiler) {
      next = 'policy'
      const output = await compiler.compile(
        `export const touch = (globalThis.__mdxSmokeExecuted = true)\n\n{fetch('${endpoint}/document-code')}\n`,
      )
      assert.deepEqual(output, [])
      if (probeFailure) throw probeFailure
      assert(policy, 'The actual guest policy probe did not complete')
      for (const [name, value] of Object.entries(policy)) assert.equal(value, true, name)
      assert.equal(traffic, 0, 'A denied guest request reached the loopback server')
      assert(executionChecks > 0, 'The actual compiler output was not observed')
      await compiler.compile('# A fresh guest has empty storage\n')
      if (probeFailure) throw probeFailure
      assert(storage.length >= 2)
      return { policy, outboundRequests: traffic, executionChecks, freshGuests: storage.length }
    },
    async crashAndHang(compiler: MdxCompiler) {
      next = 'crash'
      await assert.rejects(compiler.compile('# crash\n'), /crash|closed|destroyed|disposed/i)
      assert.deepEqual(await compiler.compile('# recovery after crash\n'), [])
      next = 'hang'
      await assert.rejects(compiler.compile('# hang\n'), /timed out/i)
      assert.deepEqual(await compiler.compile('# recovery after timeout\n'), [])
      if (probeFailure) throw probeFailure
      return { crashRejected: true, timeoutRejected: true, recovered: true }
    },
    async hold() {
      assert.equal(next, null)
      next = 'hold'
      return new Promise<WebContents>((resolve, reject) => {
        const timer = setTimeout(() => {
          prepared = null
          reject(new Error('Held native guest did not initialize'))
        }, 4000)
        prepared = (contents) => {
          clearTimeout(timer)
          prepared = null
          resolve(contents)
        }
      })
    },
    assertHealthy() {
      if (probeFailure) throw probeFailure
      assert.equal(traffic, 0)
    },
    async close() {
      app.removeListener('web-contents-created', observe)
      for (const contents of children) {
        if (!contents.isDestroyed()) BrowserWindow.fromWebContents(contents)?.destroy()
      }
      server.closeAllConnections()
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()))
      })
    },
  }
}
