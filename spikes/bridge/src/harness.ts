import { HocuspocusProvider, HocuspocusProviderWebsocket } from '@hocuspocus/provider'
import { Hocuspocus } from '@hocuspocus/server'
import ws from 'ws'
import * as Y from 'yjs'

export async function startRelay(port: number): Promise<Hocuspocus> {
  const relay = new Hocuspocus({ port, quiet: true })
  await relay.listen()
  return relay
}

export function connectDoc(url: string, room: string, doc: Y.Doc) {
  const socket = new HocuspocusProviderWebsocket({
    url,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    WebSocketPolyfill: ws as any,
  })
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
    return this.doc.getText('content')
  }

  toString(): string {
    return this.text.toString()
  }

  insertAt(index: number, str: string): void {
    this.text.insert(index, str)
  }

  insertAfter(marker: string, str: string): void {
    const current = this.toString()
    const i = current.indexOf(marker)
    if (i < 0) throw new Error(`marker not found: ${marker}`)
    this.text.insert(i + marker.length, str)
  }

  replaceOnce(oldStr: string, newStr: string): void {
    const current = this.toString()
    const i = current.indexOf(oldStr)
    if (i < 0) throw new Error(`text not found: ${oldStr}`)
    this.doc.transact(() => {
      this.text.delete(i, oldStr.length)
      this.text.insert(i, newStr)
    })
  }

  destroy(): void {
    this.conn.destroy()
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

export const countOccurrences = (haystack: string, needle: string) =>
  haystack.split(needle).length - 1
