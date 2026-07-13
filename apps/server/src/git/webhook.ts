/** GitHub push webhook: HMAC-verified against the vault's stored secret, then
 * fire-and-forget sync. Webhooks are a latency optimization — correctness is
 * carried by the scheduler's fetch backstop (design spec §Ingester). */
import { createHmac, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { encryptionKey, openSealed } from '../crypto'
import type { Db } from '../db/client'
import { vaultGit } from '../db/schema'
import { parseGithubRepoUrl } from './repo-url'

export interface WebhookDeps {
  db: Db
  triggerSync: (vaultId: string) => Promise<void>
}

function validSignature(secret: string, body: Buffer, header: string | undefined): boolean {
  if (!header?.startsWith('sha256=')) return false
  const expected = createHmac('sha256', secret).update(body).digest()
  const got = Buffer.from(header.slice('sha256='.length), 'hex')
  return got.length === expected.length && timingSafeEqual(got, expected)
}

export function makeGithubWebhookHandler(deps: WebhookDeps) {
  return async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(chunk as Buffer)
    const body = Buffer.concat(chunks)

    let fullName: string | undefined
    try {
      fullName = (JSON.parse(body.toString('utf8')) as { repository?: { full_name?: string } }).repository?.full_name
    } catch {
      /* fall through to 400 */
    }
    if (!fullName) {
      res.statusCode = 400
      return void res.end('malformed payload')
    }

    // find the vault(s) whose configured repo matches the payload's repository
    const rows = await deps.db.select().from(vaultGit)
    const key = encryptionKey()
    const match = rows.find((r) => {
      try {
        const repo = parseGithubRepoUrl(r.repoUrl)
        return `${repo.owner}/${repo.repo}`.toLowerCase() === fullName!.toLowerCase()
      } catch {
        return false
      }
    })
    if (!match) {
      res.statusCode = 404
      return void res.end('unknown repository')
    }
    const secret = openSealed(match.webhookSecretCiphertext, key)
    if (!validSignature(secret, body, req.headers['x-hub-signature-256'] as string | undefined)) {
      res.statusCode = 401
      return void res.end('bad signature')
    }

    if (req.headers['x-github-event'] === 'ping') {
      res.statusCode = 204
      return void res.end()
    }

    res.statusCode = 202
    res.end('accepted')
    void deps.triggerSync(match.vaultId).catch((err) => console.error('[git] webhook-triggered sync failed', err))
  }
}
