import type { Mapping } from '@tiptap/pm/transform'
import type { Node as ProseMirrorNode } from '@tiptap/pm/model'

export interface RewriteRequest {
  id: string
  from: number
  to: number
  blockFrom: number
  blockTo: number
  passage: string
  blockType: string
  instruction: string
  valid: boolean
}

export type RewriteQueue = readonly RewriteRequest[]

export function enqueueRewrite(
  queue: RewriteQueue,
  request: Omit<RewriteRequest, 'id' | 'valid'>,
  id: string,
): RewriteQueue {
  return [...queue, { ...request, id, valid: true }]
}

export function updateRewrite(
  queue: RewriteQueue,
  id: string,
  patch: Partial<
    Pick<
      RewriteRequest,
      'instruction' | 'from' | 'to' | 'blockFrom' | 'blockTo' | 'passage' | 'blockType'
    >
  >,
): RewriteQueue {
  return queue.map((request) => (request.id === id ? { ...request, ...patch } : request))
}

export function reselectRewrite(
  queue: RewriteQueue,
  id: string,
  target: Pick<RewriteRequest, 'from' | 'to' | 'blockFrom' | 'blockTo' | 'passage' | 'blockType'>,
): RewriteQueue {
  return queue.map((request) =>
    request.id === id ? { ...request, ...target, valid: true } : request,
  )
}

export function removeRewrite(queue: RewriteQueue, id: string): RewriteQueue {
  return queue.filter((request) => request.id !== id)
}

/** Map queued positions through an editor transaction; uncertain targets require reselection. */
export function mapRewriteTargets(
  queue: RewriteQueue,
  mapping: Mapping,
  doc: ProseMirrorNode,
): RewriteQueue {
  return queue.map((request) => {
    if (!request.valid) return request
    const from = mapping.map(request.from, 1)
    const to = mapping.map(request.to, -1)
    const blockFrom = mapping.map(request.blockFrom, -1)
    const blockTo = mapping.map(request.blockTo, 1)
    if (from >= to || to > doc.content.size || blockFrom >= blockTo) {
      return { ...request, valid: false }
    }
    const $from = doc.resolve(from)
    const $to = doc.resolve(to)
    const $blockFrom = doc.resolve(blockFrom + 1)
    const $blockTo = doc.resolve(blockTo - 1)
    // The original entire text block must still exist at its mapped extent.
    // This rejects split and merged paragraphs, even when selected text remains.
    if (
      $from.parent !== $to.parent ||
      $blockFrom.parent !== $blockTo.parent ||
      $from.parent !== $blockFrom.parent ||
      !$from.parent.isTextblock ||
      $from.parent.type.name !== request.blockType ||
      $blockFrom.start() - 1 !== blockFrom ||
      $blockTo.end() + 1 !== blockTo
    )
      return { ...request, valid: false }
    return { ...request, from, to, blockFrom, blockTo, passage: doc.textBetween(from, to, '\n') }
  })
}
