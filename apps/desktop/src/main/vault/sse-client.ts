/** Fetch-based SSE consumer for the server's /events/<vaultId> stream.
 * fetch (not EventSource) so the Authorization header rides a normal request.
 * Reconnects with capped exponential backoff; onReconnect lets the mirror
 * re-run its full reconcile after a gap. */

export interface SseClientOpts {
  url: string
  getToken(): string | null
  onEvent(channel: string, data: unknown): void
  /** Fired after a successful RE-connect (not the first connect). */
  onReconnect?(): void
  minBackoffMs?: number
  maxBackoffMs?: number
}

export class SseClient {
  private stopped = false
  private abort: AbortController | null = null

  constructor(private readonly opts: SseClientOpts) {}

  start(): void {
    void this.run()
  }

  stop(): void {
    this.stopped = true
    this.abort?.abort()
  }

  private async run(): Promise<void> {
    const min = this.opts.minBackoffMs ?? 1000
    const max = this.opts.maxBackoffMs ?? 30_000
    let attempts = 0
    let everConnected = false
    while (!this.stopped) {
      this.abort = new AbortController()
      try {
        const token = this.opts.getToken()
        if (!token) throw new Error('no session token')
        const res = await fetch(this.opts.url, {
          headers: { authorization: `Bearer ${token}` },
          signal: this.abort.signal,
        })
        if (!res.ok || !res.body) throw new Error(`sse connect failed: ${res.status}`)
        attempts = 0
        if (everConnected) this.opts.onReconnect?.()
        everConnected = true
        await this.consume(res.body)
      } catch {
        // fall through to backoff; stop() aborts land here too
      }
      if (this.stopped) return
      attempts += 1
      await new Promise((r) => setTimeout(r, Math.min(max, min * 2 ** Math.min(attempts - 1, 5))))
    }
  }

  private async consume(body: ReadableStream<Uint8Array>): Promise<void> {
    const decoder = new TextDecoder()
    let buf = ''
    for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
      buf += decoder.decode(chunk, { stream: true })
      let sep: number
      while ((sep = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, sep)
        buf = buf.slice(sep + 2)
        this.dispatch(block)
      }
    }
  }

  private dispatch(block: string): void {
    let channel = ''
    const dataLines: string[] = []
    for (const line of block.split('\n')) {
      if (line.startsWith('event:')) channel = line.slice('event:'.length).trim()
      else if (line.startsWith('data:')) dataLines.push(line.slice('data:'.length).trim())
    }
    if (!channel || dataLines.length === 0) return // comments/heartbeats
    try {
      this.opts.onEvent(channel, JSON.parse(dataLines.join('\n')))
    } catch {
      // malformed data — drop the block, keep the stream
    }
  }
}
