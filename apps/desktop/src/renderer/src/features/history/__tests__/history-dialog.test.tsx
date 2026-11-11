import { execFileSync } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { openRepo } from '../../../../../main/git'
import { render, screen, waitFor } from '@/test/render'
import userEvent from '@testing-library/user-event'
import { HistoryDialog } from '../history-dialog'
import type { FileCommit, FileHistory } from '../use-file-history'

const { commitQuery } = vi.hoisted(() => ({ commitQuery: vi.fn() }))
vi.mock('@/lib/trpc', () => ({ trpc: { history: { commit: { query: commitQuery } } } }))
vi.mock('../commit-view', () => ({
  CommitView: () => <div>Commit diff</div>,
  FolderCommitView: () => <div>Folder diff</div>,
}))

const target: FileCommit = {
  sha: 'a'.repeat(40),
  subject: 'the old target',
  date: '2026-01-01T00:00:00Z',
  author: 'Ada',
  added: 1,
  removed: 0,
}
const history: FileHistory = {
  kind: 'ready',
  commits: Array.from({ length: 200 }, (_, index) => ({
    ...target,
    sha: `${index.toString(16).padStart(2, '0')}${'b'.repeat(38)}`,
    subject: `recent ${index}`,
  })),
}

function dialog(path = 'Team/Retro.app', open = true, sha = target.sha) {
  return (
    <HistoryDialog
      path={path}
      history={history}
      authors={[]}
      onRetry={vi.fn()}
      open={open}
      onOpenChange={vi.fn()}
      sha={sha}
    />
  )
}

let fixtureRoot: string | null = null

afterEach(async () => {
  if (fixtureRoot !== null) await rm(fixtureRoot, { recursive: true, force: true })
  fixtureRoot = null
})

beforeEach(() => {
  commitQuery.mockReset()
  commitQuery.mockResolvedValue(target)
})

it('renders metadata returned by a real Git lookup through the history query seam', async () => {
  fixtureRoot = await mkdtemp(join(tmpdir(), 'holi-history-dialog-'))
  execFileSync('git', ['init', '-b', 'main'], { cwd: fixtureRoot })
  execFileSync('git', ['config', 'user.name', 'History Fixture'], { cwd: fixtureRoot })
  execFileSync('git', ['config', 'user.email', 'history@example.test'], { cwd: fixtureRoot })
  await writeFile(join(fixtureRoot, 'app.md'), 'real commit\n', 'utf8')
  execFileSync('git', ['add', 'app.md'], { cwd: fixtureRoot })
  execFileSync('git', ['commit', '-m', 'real lookup result'], { cwd: fixtureRoot })
  const sha = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: fixtureRoot,
    encoding: 'utf8',
  }).trim()
  const repo = openRepo(fixtureRoot)
  commitQuery.mockImplementation(({ sha: requested }: { sha: string }) => repo.commit(requested))

  render(dialog('app.md', true, sha))
  expect(await screen.findByRole('heading', { name: 'real lookup result' })).toBeTruthy()
  expect(commitQuery).toHaveBeenCalledWith({ sha })
})

it('loads a named commit outside the recent list and retries a lookup error', async () => {
  let rejectFirst!: (error: Error) => void
  commitQuery.mockReturnValueOnce(
    new Promise<FileCommit>((_resolve, reject) => (rejectFirst = reject)),
  )
  const user = userEvent.setup()
  render(dialog())

  expect(screen.getByRole('status', { name: 'Loading the commit' })).toBeTruthy()
  rejectFirst(new Error('temporary lookup failure'))
  expect(await screen.findByText('temporary lookup failure')).toBeTruthy()
  await user.click(screen.getByRole('button', { name: /retry/i }))
  expect(await screen.findByRole('heading', { name: target.subject })).toBeTruthy()
  expect(commitQuery).toHaveBeenCalledTimes(2)
  expect(commitQuery).toHaveBeenNthCalledWith(1, { sha: target.sha })
})

it('shows unavailable targets with a way back to all commits', async () => {
  commitQuery.mockResolvedValue(null)
  const user = userEvent.setup()
  render(dialog())

  expect(await screen.findByText('This commit is no longer available.')).toBeTruthy()
  await user.click(screen.getByRole('button', { name: /all commits/i }))
  expect(screen.getByRole('heading', { name: 'Commits' })).toBeTruthy()
})

it('ignores a late lookup after the path changes', async () => {
  let resolveOld!: (commit: FileCommit) => void
  const oldRequest = new Promise<FileCommit>((resolve) => (resolveOld = resolve))
  commitQuery
    .mockReturnValueOnce(oldRequest)
    .mockResolvedValueOnce({ ...target, subject: 'new path' })
  const view = render(dialog('Team/Retro.app'))
  view.rerender(dialog('Other/Retro.app'))

  expect(await screen.findByRole('heading', { name: 'new path' })).toBeTruthy()
  resolveOld({ ...target, subject: 'stale path' })
  await waitFor(() => expect(screen.queryByRole('heading', { name: 'stale path' })).toBeNull())
})

it('clears the selected target when closed and reopened', async () => {
  const view = render(dialog())
  expect(await screen.findByRole('heading', { name: target.subject })).toBeTruthy()
  view.rerender(dialog('Team/Retro.app', false))
  view.rerender(dialog('Team/Retro.app', true))
  await waitFor(() => expect(commitQuery).toHaveBeenCalledTimes(2))
  expect(await screen.findByRole('heading', { name: target.subject })).toBeTruthy()
})
