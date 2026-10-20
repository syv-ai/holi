/**
 * A Holi's details beside its runs (docs/features/holis.md): who it is,
 * whether this machine approved what it says now, which documents it takes,
 * what it may do without asking, its instructions and its file. A scheduled
 * Holi says when it runs, and that it is not set up in the cloud.
 */
import { useSetAtom } from 'jotai'
import { Badge, Button } from '@/primitives'
import { appModeAtom, openPathAtom } from '@/plugin-api'
import type { HoliSummary } from '../state/holis'
import { PixelMascot, type MascotStatus } from './PixelMascot'

function Heading({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <h4 className="text-xs font-medium text-muted-foreground">{children}</h4>
}

const STATUS: Record<HoliSummary['status'], string> = {
  approved: 'Approved on this machine',
  new: 'Not approved here yet: its first send asks',
  changed: 'Changed since you approved it: its next send asks again',
  invalid: 'Does not run',
  cloud: 'Not set up in the cloud',
}

export function HoliDetails({
  holi,
  status,
}: {
  holi: HoliSummary
  status: MascotStatus
}): React.JSX.Element {
  const openPath = useSetAtom(openPathAtom)
  const setMode = useSetAtom(appModeAtom)
  const accepts = holi.accepts ?? []
  const allow = holi.allow ?? []

  return (
    <aside
      aria-label={`${holi.name} details`}
      className="flex w-[300px] shrink-0 flex-col gap-6 overflow-y-auto border-s border-divider px-4 py-5"
    >
      <div className="flex items-center gap-3">
        <PixelMascot
          name={holi.mascot ?? 'ghost'}
          color={holi.color ?? '#8f8f94'}
          status={status}
          still={holi.status === 'invalid'}
          className="size-9"
        />
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="truncate text-sm font-semibold">{holi.name}</span>
          {holi.description !== undefined && holi.description !== '' && (
            <span className="text-xs text-muted-foreground">{holi.description}</span>
          )}
        </div>
      </div>

      <div className="flex flex-col gap-2">
        <Badge
          variant={
            holi.status === 'invalid'
              ? 'destructive-light'
              : holi.status === 'approved'
                ? 'primary-light'
                : 'outline'
          }
        >
          {STATUS[holi.status]}
        </Badge>
        {holi.error !== undefined && <p className="text-sm text-destructive">{holi.error}</p>}
        {holi.kind === 'scheduled' && (
          <p className="text-xs text-muted-foreground">
            {holi.when}. A scheduled Holi is shared work on the vault alone, for Claude Code's cloud
            to run once for everyone. Holi cannot set it up there yet, so nothing runs it.
          </p>
        )}
      </div>

      {holi.kind === 'triggered' && holi.error === undefined && (
        <div className="flex flex-col gap-2">
          <Heading>Documents it takes</Heading>
          {accepts.length === 0 ? (
            <p className="text-xs text-muted-foreground">Any document.</p>
          ) : (
            <p className="rounded-xl bg-foreground/[0.04] p-2.5 font-mono text-xs leading-relaxed text-foreground/85">
              {accepts.map((g) => (
                <span key={g} className="block">
                  {g}
                </span>
              ))}
            </p>
          )}
        </div>
      )}

      {holi.instructions !== undefined && (
        <div className="flex flex-col gap-2">
          <Heading>Instructions</Heading>
          <p className="whitespace-pre-wrap rounded-xl bg-foreground/[0.04] p-2.5 text-sm leading-relaxed text-foreground/85">
            {holi.instructions}
          </p>
        </div>
      )}

      {holi.error === undefined && (
        <div className="flex flex-col gap-2">
          <Heading>Allowed without asking</Heading>
          {allow.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              Nothing: Claude Code asks you before each action.
            </p>
          ) : (
            <p className="rounded-xl bg-foreground/[0.04] p-2.5 font-mono text-xs leading-relaxed text-foreground/85">
              {allow.map((rule) => (
                <span key={rule} className="block">
                  {rule}
                </span>
              ))}
            </p>
          )}
          {holi.model !== undefined && (
            <p className="text-xs text-muted-foreground">Model: {holi.model}</p>
          )}
        </div>
      )}

      {holi.unknownKeys !== undefined && holi.unknownKeys.length > 0 && (
        <p className="text-xs text-muted-foreground">
          Ignored, unknown to this Holi:{' '}
          <code className="font-mono">{holi.unknownKeys.join(', ')}</code>
        </p>
      )}

      <Button
        variant="ghost"
        className="h-auto w-full min-w-0 justify-start rounded-lg px-2 py-1.5 text-sm font-normal text-foreground/85 hover:bg-foreground/[0.04]"
        onClick={() => {
          setMode('documents')
          void openPath(holi.path)
        }}
      >
        <span className="truncate">Edit its file</span>
      </Button>
    </aside>
  )
}
