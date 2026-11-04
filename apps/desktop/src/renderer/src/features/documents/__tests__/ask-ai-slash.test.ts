import { expect, test, vi } from 'vitest'

import { askAiSlashItem } from '../ask-ai-slash'

test.each(['Codex', 'Pi', 'My Custom Agent', 'AI'])('uses the current agent label %s', (label) => {
  const item = askAiSlashItem(vi.fn(), label)
  expect(item.title).toBe(`Ask ${label}`)
  expect(item.hint).toBe('Write or change this document')
  expect(item.keywords).toContain('ai')
  expect(item.keywords).toContain('agent')
})
