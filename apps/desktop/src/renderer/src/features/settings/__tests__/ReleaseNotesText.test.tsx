import { render, screen } from '@/test/render'
import userEvent from '@testing-library/user-event'
import { expect, test, vi } from 'vitest'
import { ReleaseNotesText } from '../ReleaseNotesText'

test('release notes open http(s) links externally and never render HTML', async () => {
  const openExternal = vi.fn(async () => {})
  Object.assign(window, { holi: { ...(window as { holi?: object }).holi, openExternal } })
  const body = [
    '## Fixes',
    '- See [the PR](https://github.com/syv-ai/holi/pull/1)',
    '- [bad](javascript:alert(1)) <img src=x onerror=alert(1)>',
  ].join('\n')
  const { container } = render(<ReleaseNotesText body={body} />)

  await userEvent.click(screen.getByRole('button', { name: 'the PR' }))
  expect(openExternal).toHaveBeenCalledWith('https://github.com/syv-ai/holi/pull/1')
  expect(screen.queryByRole('button', { name: 'bad' })).toBeNull()
  expect(container.querySelector('img')).toBeNull()
  expect(container.textContent).toContain('<img src=x onerror=alert(1)>')
})
