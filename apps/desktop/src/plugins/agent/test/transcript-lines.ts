/**
 * Synthetic transcript lines for the transcript tests: shaped like Claude
 * Code's, with invented content. Nothing here is copied from a real session.
 */
export const json = (value: unknown): string => JSON.stringify(value)

const common = { sessionId: 's-1', version: '2.1.290', isSidechain: false }

export const user = (uuid: string, content: unknown, extra: Record<string, unknown> = {}) => ({
  type: 'user',
  uuid,
  ...common,
  message: { role: 'user', content },
  ...extra,
})

export const assistant = (uuid: string, content: unknown, extra: Record<string, unknown> = {}) => ({
  type: 'assistant',
  uuid,
  ...common,
  message: { id: 'msg_1', role: 'assistant', content },
  ...extra,
})

export const toolUse = (id: string, name: string, input: unknown) => ({
  type: 'tool_use',
  id,
  name,
  input,
  caller: { type: 'direct' },
})

export const toolResult = (id: string, content: unknown, extra: Record<string, unknown> = {}) => ({
  type: 'tool_result',
  tool_use_id: id,
  content,
  ...extra,
})

export const attachment = (uuid: string, body: Record<string, unknown>) => ({
  type: 'attachment',
  uuid,
  ...common,
  attachment: body,
})

export const system = (uuid: string, subtype: string, extra: Record<string, unknown> = {}) => ({
  type: 'system',
  uuid,
  subtype,
  ...common,
  ...extra,
})
