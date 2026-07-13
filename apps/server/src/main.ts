import { createServer } from 'node:http'
import { Hocuspocus } from '@hocuspocus/server'
import { createHTTPHandler } from '@trpc/server/adapters/standalone'
import { createBus } from './bus'
import { config } from './config'
import { createDb } from './db/client'
import { runMigrations } from './db/migrate'
import { makeEventsHandler } from './events'
import { createGithubApi } from './git/github-api'
import { createGithubOAuth } from './git/oauth'
import { createGitScheduler } from './git/scheduler'
import { syncVault } from './git/sync'
import { makeGithubWebhookHandler } from './git/webhook'
import { createReminderEvaluator } from './reminders/evaluator'
import { makeAppRouter } from './routers'
import { makeCreateContext } from './trpc'
import { makeHooks } from './yjs/hooks'

async function main(): Promise<void> {
  await runMigrations()
  const { db } = createDb()
  const bus = createBus()

  const hooks = makeHooks({ db, bus })
  const relay = new Hocuspocus({
    port: config.relayPort,
    // built-in store debouncing — do not hand-roll (PRD: debounced onStoreDocument)
    debounce: 2000,
    maxDebounce: 10_000,
    onAuthenticate: (data) => hooks.onAuthenticate(data),
    onLoadDocument: (data) => hooks.onLoadDocument(data),
    onStoreDocument: (data) =>
      hooks.onStoreDocument({
        documentName: data.documentName,
        document: data.document,
        context: data.context,
      }),
  })
  await relay.listen()
  console.log(`[relay] Hocuspocus listening on ws://127.0.0.1:${config.relayPort}`)

  const getLiveDoc = (docId: string) => relay.documents.get(docId) ?? null

  const githubApi =
    config.github.clientId && config.github.clientSecret
      ? createGithubApi({ clientId: config.github.clientId, clientSecret: config.github.clientSecret })
      : null
  const githubOAuth = githubApi
    ? createGithubOAuth({ db, api: githubApi, clientId: config.github.clientId!, publicBaseUrl: config.publicBaseUrl })
    : null

  const trpcHandler = createHTTPHandler({
    router: makeAppRouter({ githubOAuth, githubApi, publicBaseUrl: config.publicBaseUrl }),
    createContext: makeCreateContext({ db, bus, getLiveDoc }),
  })
  const webhookHandler = makeGithubWebhookHandler({
    db,
    triggerSync: (vaultId) => syncVault({ db, getLiveDoc }, vaultId),
  })
  const eventsHandler = makeEventsHandler({ db, bus })

  createServer((req, res) => {
    const eventsMatch = req.method === 'GET' ? /^\/events\/([0-9a-f-]{36})$/.exec(req.url ?? '') : null
    if (eventsMatch) return void eventsHandler(req, res, eventsMatch[1]!)
    if (req.method === 'POST' && req.url === '/webhooks/github') return void webhookHandler(req, res)
    if (req.method === 'GET' && req.url?.startsWith('/github/oauth/callback')) {
      const url = new URL(req.url, config.publicBaseUrl)
      const code = url.searchParams.get('code')
      const state = url.searchParams.get('state')
      if (!githubOAuth || !code || !state) {
        res.statusCode = 400
        return void res.end('bad request')
      }
      void githubOAuth
        .handleCallback({ code, state })
        .then((html) => {
          res.setHeader('content-type', 'text/html; charset=utf-8')
          res.end(html)
        })
        .catch((err) => {
          res.statusCode = 400
          res.end(`GitHub connection failed: ${err instanceof Error ? err.message : err}`)
        })
      return
    }
    trpcHandler(req, res)
  }).listen(config.apiPort)
  console.log(`[api] tRPC + git endpoints listening on http://127.0.0.1:${config.apiPort}`)

  createReminderEvaluator({ db, bus }).start()
  console.log('[reminders] evaluator started')

  createGitScheduler({ db, getLiveDoc }).start()
  console.log('[git] mirror scheduler started')
}

void main().catch((err) => {
  console.error(err)
  process.exit(1)
})
