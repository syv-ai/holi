#!/usr/bin/env node
// Holi PreToolUse hook — tells Holi a file write is about to land so the
// editor can snapshot and lock the doc before it changes.
//
// Outside Holi (bare `claude` in a synced checkout) the env vars are absent
// and this exits silently: never break a session over a missing sidecar.

const endpoint = process.env.HOLI_AGENT_ENDPOINT
const token = process.env.HOLI_AGENT_TOKEN
if (!endpoint || !token) process.exit(0)

try {
  const chunks = []
  for await (const chunk of process.stdin) chunks.push(chunk)
  const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  const filePath = payload?.tool_input?.file_path

  await fetch(`${endpoint}/hook/pre-tool-use`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(filePath ? { filePath } : {}),
    signal: AbortSignal.timeout(1000),
  })
} catch {
  // Holi is gone, slow, or this isn't a file write — the vault watcher still
  // catches the edit; the hook only sharpens the turn boundary.
}
process.exit(0)
