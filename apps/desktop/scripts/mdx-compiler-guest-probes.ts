import assert from 'node:assert/strict'
import { app, BrowserWindow, session, type WebContents } from 'electron'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { MdxResources } from '../src/main/mdx-resources'

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
  const publicBase = `https://cdn.jsdelivr.net/gh/syv-ai/holi@${process.env.HOLI_MDX_SMOKE_FIXTURE_SHA}/apps/desktop/scripts/fixtures/mdx-external`
  const endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  let next: Mode | null = null
  let prepared: ((contents: WebContents) => void) | null = null
  let policy: { results: Record<string, unknown>; evidence: Record<string, unknown> } | null = null
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
            const bounded = (promise, cleanup = () => {}) => new Promise(resolve => {
              let settled = false;
              const finish = value => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                cleanup();
                resolve(value);
              };
              const timer = setTimeout(() => finish('timeout'), 350);
              Promise.resolve(promise).then(finish, () => finish('denied'));
            });
            const results = {};
            const evidence = {};
            // Observe the guest's unmodified production CSP. An error/failed handshake
            // is never proof of precontact denial, and Node counters cannot see Chromium.
            const policyDenied = (name, url, directive, operation) => new Promise(resolve => {
              let cleanup = () => {};
              const finish = value => {
                clearTimeout(timer);
                removeEventListener('securitypolicyviolation', violation);
                cleanup();
                resolve(value);
              };
              const violation = event => {
                if (event.disposition !== 'enforce' || event.effectiveDirective !== directive) return;
                try {
                  const target = new URL(url);
                  // Chromium can report blocked blob workers as the scheme alone.
                  const blobWorker = directive === 'worker-src' && target.protocol === 'blob:' &&
                    ['blob', 'blob:'].includes(event.blockedURI);
                  if (!blobWorker) {
                    const blocked = new URL(event.blockedURI);
                    // Cross-origin CSP reports may deliberately strip path information.
                    if (blocked.origin !== target.origin ||
                        (blocked.href !== target.href && blocked.href !== target.origin + '/')) return;
                  }
                  evidence[name] = { destination: url, blockedURI: event.blockedURI,
                    directive: event.effectiveDirective, disposition: event.disposition,
                    policy: event.originalPolicy };
                  finish(true);
                } catch {}
              };
              const timer = setTimeout(() => finish(false), 1500);
              addEventListener('securitypolicyviolation', violation);
              try { cleanup = operation() || cleanup; } catch { /* no policy evidence yet */ }
            });
            results.loopback = await denied(${JSON.stringify(endpoint + '/canary')});
            // Consent authorizes main's typed transport, never guest networking.
            const publicBase = ${JSON.stringify(publicBase)};
            const probe = async (name, path, directive, operation) => {
              const url = publicBase + path;
              results[name] = await policyDenied(name, url, directive, () => operation(url));
            };
            await probe('publicFetch', '/nested.css', 'connect-src', url => { void fetch(url).catch(() => {}); });
            await probe('publicImport', '/entry.js', 'script-src-elem', url => { void import(url).catch(() => {}); });
            await probe('publicXhr', '/tiny.png', 'connect-src', url => {
              const xhr = new XMLHttpRequest(); xhr.open('GET', url); xhr.send();
              return () => xhr.abort();
            });
            await probe('publicCss', '/nested.css', 'style-src-elem', url => {
              const link = document.createElement('link'); link.rel = 'stylesheet'; link.href = url;
              document.head.append(link); return () => link.remove();
            });
            await probe('publicImage', '/tiny.png', 'img-src', url => {
              const image = new Image(); image.src = url; return () => { image.src = ''; };
            });
            await probe('publicFont', '/tiny.woff2', 'font-src', url => {
              void new FontFace('public-probe', 'url("' + url + '")').load().catch(() => {});
            });
            await probe('publicAudio', '/tiny.wav', 'media-src', url => {
              const audio = document.createElement('audio'); audio.src = url; audio.load();
              return () => { audio.removeAttribute('src'); audio.load(); };
            });
            const socketUrl = publicBase.replace('https:', 'wss:');
            results.publicSocket = await policyDenied('publicSocket', socketUrl, 'connect-src', () => {
              const socket = new WebSocket(socketUrl);
              socket.onerror = () => {}; return () => socket.close();
            });
            // A classic cross-origin constructor can fail its same-origin check before
            // reaching CSP. Use a same-origin blob loader for the public import instead.
            const workerImport = publicBase + '/entry.js';
            const publicWorkerUrl = URL.createObjectURL(new Blob([
              'importScripts(' + JSON.stringify(workerImport) + ');',
            ], { type: 'text/javascript' }));
            try {
              results.publicWorker = await policyDenied('publicWorker', publicWorkerUrl, 'worker-src', () => {
                const worker = new Worker(publicWorkerUrl); worker.onerror = () => {};
                return () => worker.terminate();
              });
              if (evidence.publicWorker) evidence.publicWorker.importDestination = workerImport;
            } finally {
              URL.revokeObjectURL(publicWorkerUrl);
            }
            results.publicPopup = window.open(publicBase + '/tiny.png') === null;
            results.external = await denied('https://outside.invalid/canary');
            results.dynamicImport = await bounded(import(${JSON.stringify(endpoint + '/module.js')})
              .then(() => false, () => true));
            results.xhr = await new Promise(resolve => {
              try { const xhr = new XMLHttpRequest(); xhr.onerror = () => resolve(true); xhr.onload = () => resolve(false); xhr.open('GET', ${JSON.stringify(endpoint + '/xhr')}); xhr.send(); }
              catch { resolve(true) }
            });
            let eventSource;
            results.eventSource = await bounded(new Promise(resolve => {
              try { eventSource = new EventSource(${JSON.stringify(endpoint + '/events')});
                eventSource.onerror = () => resolve(true);
                eventSource.onopen = () => resolve(false);
              } catch { resolve(true) }
            }), () => eventSource?.close());
            let worker;
            let workerUrl;
            results.worker = await bounded(new Promise(resolve => {
              try { workerUrl = URL.createObjectURL(new Blob(["importScripts('${endpoint}/worker-import.js');"]));
                worker = new Worker(workerUrl);
                worker.onerror = () => resolve(true);
                worker.onmessage = () => resolve(false);
              } catch { resolve(true) }
            }), () => { worker?.terminate(); if (workerUrl) URL.revokeObjectURL(workerUrl); });
            results.css = await bounded(new Promise(resolve => { const link = document.createElement('link'); link.rel = 'stylesheet';
              link.href = ${JSON.stringify(endpoint + '/style.css')}; link.onerror = () => resolve(true);
              link.onload = () => resolve(false); document.head.append(link); }));
            results.image = await bounded(new Promise(resolve => { const image = new Image();
              image.onerror = () => resolve(true); image.onload = () => resolve(false); image.src = ${JSON.stringify(endpoint + '/image.png')}; }));
            results.font = await bounded((async () => {
              const face = new FontFace('mdx-probe', 'url(${JSON.stringify(endpoint + '/font.woff2')})');
              try { await face.load(); return false } catch { return true }
            })());
            results.audio = await bounded(new Promise(resolve => { const audio = document.createElement('audio');
              audio.onerror = () => resolve(true); audio.oncanplaythrough = () => resolve(false);
              audio.src = ${JSON.stringify(endpoint + '/audio.wav')}; audio.load(); }));
            results.video = await bounded(new Promise(resolve => { const video = document.createElement('video');
              video.onerror = () => resolve(true); video.oncanplaythrough = () => resolve(false);
              video.src = ${JSON.stringify(endpoint + '/video.mp4')}; video.load(); }));
            let frame;
            results.frame = await bounded(new Promise(resolve => { frame = document.createElement('iframe');
              frame.onload = () => { try { resolve(frame.contentWindow?.location.href === 'about:blank') } catch { resolve(true) } };
              frame.onerror = () => resolve(true); frame.src = ${JSON.stringify(endpoint + '/frame')}; document.body.append(frame); }),
              () => frame?.remove());
            results.file = await denied('file:///etc/passwd');
            results.holi = await denied('holi://vault/private');
            results.assetLookalike = await denied('${origin}/guest.js?extra=1');
            results.post = await denied('${origin}/guest.js', {method:'POST', body:'x'});
            results.assetAsImage = await bounded(new Promise(resolve => { const image = new Image();
              image.onerror = () => resolve(true); image.onload = () => resolve(false); image.src = '${origin}/guest.js'; }));
            results.assetAsFetch = await denied('${origin}/guest.js');
            results.assetRepeat = await bounded(new Promise(resolve => { const script = document.createElement('script');
              script.onerror = () => resolve(true); script.onload = () => resolve(false);
              script.src = '${origin}/guest.js'; document.head.append(script); }));
            let beaconViolation;
            results.beacon = await bounded(new Promise(resolve => {
              beaconViolation = event => {
                if (event.disposition !== 'enforce' || event.effectiveDirective !== 'connect-src') return;
                try {
                  if (new URL(event.blockedURI).origin === ${JSON.stringify(endpoint)}) resolve(true);
                } catch {}
              };
              addEventListener('securitypolicyviolation', beaconViolation);
              navigator.sendBeacon(${JSON.stringify(endpoint + '/beacon')}, 'x');
            }), () => removeEventListener('securitypolicyviolation', beaconViolation));
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
            return { results, evidence };
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
    async policy(compiler: MdxResources) {
      next = 'policy'
      const owner = compiler.createOwner(async () => true)
      const output = await compiler.compile(
        owner,
        `export const touch = (globalThis.__mdxSmokeExecuted = true)\n\n{fetch('${endpoint}/document-code')}\n`,
      )
      assert.deepEqual(output, [])
      if (probeFailure) throw probeFailure
      assert(policy, 'The actual guest policy probe did not complete')
      for (const [name, value] of Object.entries(policy.results)) assert.equal(value, true, name)
      assert.equal(
        Object.keys(policy.evidence).length,
        9,
        'Missing approved-host enforcing CSP evidence',
      )
      assert.equal(traffic, 0, 'A denied guest request reached the loopback server')
      assert(executionChecks > 0, 'The actual compiler output was not observed')
      await compiler.compile(owner, '# A fresh guest has empty storage\n')
      if (probeFailure) throw probeFailure
      assert(storage.length >= 2)
      return { policy, outboundRequests: traffic, executionChecks, freshGuests: storage.length }
    },
    async crashAndHang(compiler: MdxResources) {
      const owner = compiler.createOwner(async () => true)
      next = 'crash'
      await assert.rejects(compiler.compile(owner, '# crash\n'), /crash|closed|destroyed|disposed/i)
      assert.deepEqual(await compiler.compile(owner, '# recovery after crash\n'), [])
      next = 'hang'
      await assert.rejects(compiler.compile(owner, '# hang\n'), /timed out/i)
      assert.deepEqual(await compiler.compile(owner, '# recovery after timeout\n'), [])
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
