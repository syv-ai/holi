import { Hocuspocus } from '@hocuspocus/server'
import { createHTTPServer } from '@trpc/server/adapters/standalone'
import { createBus } from './bus'
import { config } from './config'
import { createDb } from './db/client'
import { runMigrations } from './db/migrate'
import { createGithubApi } from './git/github-api'
import { createGithubOAuth } from './git/oauth'
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

  createHTTPServer({
    router: makeAppRouter({ githubOAuth, githubApi, publicBaseUrl: config.publicBaseUrl }),
    createContext: makeCreateContext({ db, bus, getLiveDoc }),
  }).listen(config.apiPort)
  console.log(`[api] tRPC listening on http://127.0.0.1:${config.apiPort}`)

  createReminderEvaluator({ db, bus }).start()
  console.log('[reminders] evaluator started')
}

void main().catch((err) => {
  console.error(err)
  process.exit(1)
})
