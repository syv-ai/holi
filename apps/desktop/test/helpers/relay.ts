/** In-process Hocuspocus + provider helpers — the spike harness pattern
 * (spikes/bridge/src/harness.ts), retargeted at YDOC_TEXT_KEY. */
import { HocuspocusProvider, HocuspocusProviderWebsocket } from '@hocuspocus/provider'
import { Hocuspocus } from '@hocuspocus/server'
import ws from 'ws'
import * as Y from 'yjs'
import { YDOC_TEXT_KEY } from '@holi/shared'

export async function startRelay(port: number): Promise<Hocuspocus> {
  const relay = new Hocuspocus({ port, quiet: true })
  await relay.listen()
  return relay
}

export function connectDoc(url: string, room: string, doc: Y.Doc) {
  const socket = new HocuspocusProviderWebsocket({ url, WebSocketPolyfill: ws as never })
  const provider = new HocuspocusProvider({ websocketProvider: socket, name: room, document: doc })
  return {
    provider,
    destroy: () => {
      provider.destroy()
      socket.destroy()
    },
  }
}

/** A simulated human editing through the relay. */
export class SimClient {
  readonly doc = new Y.Doc()
  private readonly conn: ReturnType<typeof connectDoc>

  constructor(url: string, room: string) {
    this.conn = connectDoc(url, room, this.doc)
  }
  get text(): Y.Text {
    return this.doc.getText(YDOC_TEXT_KEY)
  }
  get provider(): HocuspocusProvider {
    return this.conn.provider
  }
  toString(): string {
    return this.text.toString()
  }
  insertAfter(marker: string, str: string): void {
    const i = this.toString().indexOf(marker)
    if (i < 0) throw new Error(`marker not found: ${marker}`)
    this.text.insert(i + marker.length, str)
  }
  destroy(): void {
    this.conn.destroy()
  }
}

/** Mimics Claude Code's native file tools against the working copy. */
export class AgentSim {
  constructor(private readonly filePath: string) {}
  async read(): Promise<string> {
    const { readFile } = await import('node:fs/promises')
    return readFile(this.filePath, 'utf8')
  }
  async write(content: string): Promise<void> {
    const { writeFile } = await import('node:fs/promises')
    await writeFile(this.filePath, content, 'utf8')
  }
  async edit(oldString: string, newString: string): Promise<void> {
    const current = await this.read()
    if (!current.includes(oldString)) throw new Error(`edit failed: old_string not found`)
    await this.write(current.replace(oldString, newString))
  }
}

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

export async function waitUntil(
  cond: () => boolean | Promise<boolean>,
  timeoutMs = 10_000,
  label = 'condition',
): Promise<void> {
  const start = Date.now()
  while (!(await cond())) {
    if (Date.now() - start > timeoutMs) throw new Error(`timeout waiting for: ${label}`)
    await sleep(20)
  }
}

export const converged = (texts: string[]) => texts.every((t) => t === texts[0])
export const countOccurrences = (haystack: string, needle: string) => haystack.split(needle).length - 1
