#!/usr/bin/env node
// Holi Stop hook — the turn is over; merge any open agent edits into the live
// documents now instead of waiting for the watcher's idle timeout.

const endpoint = process.env.HOLI_AGENT_ENDPOINT
const token = process.env.HOLI_AGENT_TOKEN
if (!endpoint || !token) process.exit(0)

try {
  await fetch(`${endpoint}/hook/stop`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(1000),
  })
} catch {
  // watcher idle still ends the turn — this only makes it immediate
}
process.exit(0)
