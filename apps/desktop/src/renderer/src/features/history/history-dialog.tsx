/**
 * A file's history, after GitHub's commits page: the commits grouped under
 * their day on a timeline, filtered by who and by when. A row opens what
 * the commit changed in the file; its buttons copy the sha, open the change,
 * or show the file as that commit left it.
 */
import { useState } from 'react'
import {
  ArrowLeftIcon,
  CalendarIcon,
  CodeIcon,
  CopyIcon,
  FileDiffIcon,
  GitCommitHorizontalIcon,
  HistoryIcon,
  UsersIcon,
} from 'lucide-react'
import { toast } from 'sonner'

import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'

import {
  commitAuthors,
  filterCommits,
  groupByDay,
  PERIOD_LABEL,
  PERIODS,
  type Period,
} from './commit-groups'
import { CommitView } from './commit-view'
import { initials, shortSha } from './commit-format'
import { authorFor, type FileAuthor, type FileCommit, type FileHistory } from './use-file-history'
import { EmptyState, ErrorState } from '@/composites/empty-state'

const ALL_USERS = '__all__'

const ON_DAY = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
})

type Detail = { commit: FileCommit; show: 'diff' | 'file' } | null

export function HistoryDialog({
  path,
  history,
  authors,
  onRetry,
  open,
  onOpenChange,
}: {
  path: string
  history: FileHistory
  authors: readonly FileAuthor[]
  onRetry: () => void
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const [author, setAuthor] = useState<string | null>(null)
  const [period, setPeriod] = useState<Period>('all')
  const [detail, setDetail] = useState<Detail>(null)
  const segments = path.split('/')

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) setDetail(null)
        onOpenChange(next)
      }}
    >
      <DialogContent className="sm:max-w-4xl">
        <DialogHeader>
          <DialogTitle>{detail === null ? 'Commits' : detail.commit.subject}</DialogTitle>
          <DialogDescription>
            <span className="flex flex-wrap items-center gap-x-1">
              {detail === null ? (
                <>
                  History for{' '}
                  {segments.map((segment, index) => (
                    <span key={index} className="flex items-center gap-x-1">
                      {index > 0 ? <span aria-hidden="true">/</span> : null}
                      <span
                        className={
                          index === segments.length - 1 ? 'text-foreground font-medium' : undefined
                        }
                      >
                        {segment}
                      </span>
                    </span>
                  ))}
                </>
              ) : (
                <>
                  {detail.commit.author} committed on {ON_DAY.format(new Date(detail.commit.date))}{' '}
                  · <span className="font-mono">{shortSha(detail.commit.sha)}</span>
                </>
              )}
            </span>
          </DialogDescription>
        </DialogHeader>

        {detail !== null ? (
          // A grid item sizes to its content by default; min-w-0 lets the
          // code scroll inside the dialog instead of widening it.
          <div className="flex min-h-0 min-w-0 flex-col gap-3">
            <div className="flex items-center gap-2">
              <Button variant="outline" size="sm" onClick={() => setDetail(null)}>
                <ArrowLeftIcon data-icon="inline-start" aria-hidden="true" />
                All commits
              </Button>
              <Button
                variant={detail.show === 'diff' ? 'secondary' : 'ghost'}
                size="sm"
                aria-pressed={detail.show === 'diff'}
                onClick={() => setDetail({ ...detail, show: 'diff' })}
              >
                <FileDiffIcon data-icon="inline-start" aria-hidden="true" />
                Changes
              </Button>
              <Button
                variant={detail.show === 'file' ? 'secondary' : 'ghost'}
                size="sm"
                aria-pressed={detail.show === 'file'}
                onClick={() => setDetail({ ...detail, show: 'file' })}
              >
                <CodeIcon data-icon="inline-start" aria-hidden="true" />
                File at this commit
              </Button>
            </div>
            <div className="max-h-160 min-w-0 overflow-auto">
              <CommitView
                key={`${detail.commit.sha}:${detail.show}`}
                path={path}
                sha={detail.commit.sha}
                show={detail.show}
              />
            </div>
          </div>
        ) : (
          <CommitList
            history={history}
            authors={authors}
            author={author}
            period={period}
            onAuthor={setAuthor}
            onPeriod={setPeriod}
            onRetry={onRetry}
            onOpen={(commit, show) => setDetail({ commit, show })}
          />
        )}
      </DialogContent>
    </Dialog>
  )
}

function CommitList({
  history,
  authors,
  author,
  period,
  onAuthor,
  onPeriod,
  onRetry,
  onOpen,
}: {
  history: FileHistory
  authors: readonly FileAuthor[]
  author: string | null
  period: Period
  onAuthor: (author: string | null) => void
  onPeriod: (period: Period) => void
  onRetry: () => void
  onOpen: (commit: FileCommit, show: 'diff' | 'file') => void
}) {
  if (history.kind === 'loading') {
    return (
      <div className="flex flex-col gap-3" role="status" aria-label="Loading commits">
        <Skeleton className="h-16 w-full" />
        <Skeleton className="h-16 w-full" />
        <Skeleton className="h-16 w-full" />
      </div>
    )
  }
  if (history.kind === 'error') {
    return (
      <ErrorState
        title="The history could not be read"
        message={history.message}
        onRetry={onRetry}
      />
    )
  }
  if (history.commits.length === 0) {
    return (
      <EmptyState
        icon={HistoryIcon}
        title="No commits yet"
        description="This file has not been committed. Its history starts once it syncs."
      />
    )
  }

  const shown = filterCommits(history.commits, author, period)
  const days = groupByDay(shown)

  return (
    <div className="flex min-h-0 min-w-0 flex-col gap-4">
      <div className="flex flex-wrap items-center justify-end gap-2">
        <Select
          value={author ?? ALL_USERS}
          onValueChange={(next) => onAuthor(next === ALL_USERS ? null : next)}
        >
          <SelectTrigger size="sm" aria-label="Author">
            <UsersIcon aria-hidden="true" />
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL_USERS}>All users</SelectItem>
            {commitAuthors(history.commits).map((name) => (
              <SelectItem key={name} value={name}>
                {name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={period} onValueChange={(next) => onPeriod(next as Period)}>
          <SelectTrigger size="sm" aria-label="Time">
            <CalendarIcon aria-hidden="true" />
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {PERIODS.map((id) => (
              <SelectItem key={id} value={id}>
                {PERIOD_LABEL[id]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="max-h-160 overflow-y-auto">
        {days.length === 0 ? (
          <EmptyState
            title="No commits match"
            description="Try another author or a longer time."
            action={{
              label: 'Show all commits',
              onClick: () => {
                onAuthor(null)
                onPeriod('all')
              },
            }}
          />
        ) : (
          <ol className="flex flex-col gap-3">
            {days.map((day) => (
              <li key={day.day} className="flex flex-col gap-2">
                <h3 className="text-muted-foreground flex items-center gap-2 text-sm">
                  <GitCommitHorizontalIcon aria-hidden="true" className="size-4" />
                  Commits on {day.label}
                </h3>
                {/* The day's line runs down beside its commits. */}
                <div className="border-border ms-2 border-s ps-4">
                  <ul className="divide-border border-border divide-y rounded-lg border">
                    {day.commits.map((commit) => (
                      <CommitRow
                        key={commit.sha}
                        commit={commit}
                        author={authorFor(authors, commit.author)}
                        onOpen={onOpen}
                      />
                    ))}
                  </ul>
                </div>
              </li>
            ))}
          </ol>
        )}
      </div>
    </div>
  )
}

function IconAction({
  label,
  onClick,
  children,
}: {
  label: string
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={label}
          onClick={(event) => {
            // The row opens the change; a button does its own thing.
            event.stopPropagation()
            onClick()
          }}
        >
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
}

function CommitRow({
  commit,
  author,
  onOpen,
}: {
  commit: FileCommit
  author: FileAuthor
  onOpen: (commit: FileCommit, show: 'diff' | 'file') => void
}) {
  const who = author.login ?? author.name
  return (
    <li className="hover:bg-muted/50 motion-respond flex items-center gap-3 px-4 py-3">
      <Button
        type="button"
        variant="text"
        size="inline"
        onClick={() => onOpen(commit, 'diff')}
        className="min-w-0 flex-1 flex-col items-start justify-start text-start"
      >
        <span className="w-full truncate text-sm font-medium">{commit.subject}</span>
        <span className="text-muted-foreground flex items-center gap-1.5 text-xs">
          <Avatar size="sm">
            {author.avatarUrl ? <AvatarImage src={author.avatarUrl} alt="" /> : null}
            <AvatarFallback className="text-xs">{initials(author.name)}</AvatarFallback>
          </Avatar>
          <span className="text-foreground">{who}</span> committed on{' '}
          {ON_DAY.format(new Date(commit.date))}
          <span aria-hidden="true">·</span>
          <span className="tabular-nums">
            <span className="text-success-foreground">+{commit.added}</span>{' '}
            <span className="text-destructive">−{commit.removed}</span>
          </span>
        </span>
      </Button>
      <span className="font-mono text-xs">{shortSha(commit.sha)}</span>
      <div className="flex items-center gap-0.5">
        <IconAction
          label="Copy the full SHA"
          onClick={() =>
            void navigator.clipboard
              .writeText(commit.sha)
              .then(() => toast.success("Copied the commit's SHA"))
              .catch(() => toast.error('Couldn’t copy the SHA.'))
          }
        >
          <CopyIcon aria-hidden="true" />
        </IconAction>
        <IconAction label="View the changes" onClick={() => onOpen(commit, 'diff')}>
          <FileDiffIcon aria-hidden="true" />
        </IconAction>
        <IconAction label="View the file at this commit" onClick={() => onOpen(commit, 'file')}>
          <CodeIcon aria-hidden="true" />
        </IconAction>
      </div>
    </li>
  )
}
