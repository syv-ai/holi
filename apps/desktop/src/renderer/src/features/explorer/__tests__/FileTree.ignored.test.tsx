/**
 * Gitignored rows are dimmed, the way VS Code and every other IDE does it.
 *
 * The tree shows gitignored files on purpose — they are real files in the
 * directory — but it used to show them looking exactly like committed content,
 * and **the name does not tell you**: `*.local.*` is only the seeded rule, a
 * vault may ignore anything, and one seeded before D65 carries a bare
 * `USER.md`. Which paths those are is git's answer, carried on the snapshot;
 * all this tree does is look them up.
 */
import { emptyVaultSnapshot } from '@holi/shared'
import { getDefaultStore } from 'jotai'
import { beforeEach, expect, test, vi } from 'vitest'
import { render } from '@/test/render'
import { FileTree } from '../FileTree'
import { activeRemoteAtom, snapshotAtom, vaultsAtom } from '../../../state/vaults'

const REMOTE = 'syv-ai/holi'
const EMPTY = emptyVaultSnapshot()
const store = getDefaultStore()

vi.mock('../../../lib/trpc', () => ({
  trpc: { vaults: { snapshot: { query: () => Promise.resolve(EMPTY) } } },
}))

function tree(docs: string[], ignored: string[], dirs: string[] = []) {
  store.set(activeRemoteAtom, REMOTE)
  store.set(vaultsAtom, [{ remote: REMOTE, path: '/vault' } as never])
  store.set(snapshotAtom, {
    ...EMPTY,
    docs: docs.map((path) => ({ path, kind: 'note' as const, updatedAt: '' })),
    dirs,
    ignored,
  })
  return render(
    <FileTree
      activePath={null}
      onOpenPreview={() => {}}
      onOpenPinned={() => {}}
      onOpenInNewPane={() => {}}
    />,
  )
}

const rowFor = (path: string) => document.querySelector(`[data-path="${path}"]`)!

/** Whether the row's own contents are dimmed. Asked of the name span rather
 *  than the row, because the dim is deliberately NOT on the row — see below. */
const nameOf = (path: string) => rowFor(path).querySelector('.min-w-0.flex-1.truncate')!

beforeEach(() => {
  store.set(snapshotAtom, EMPTY)
})

test('dims a row git ignores and leaves its neighbour alone', () => {
  tree(['plan.md', 'USER.md'], ['USER.md'])

  expect(nameOf('USER.md').className).toContain('opacity-50')
  expect(nameOf('plan.md').className).not.toContain('opacity-50')
})

test('applies no name rule of its own — the list decides, whatever it contains', () => {
  // Inverted on purpose. `USER.md` is the file this whole thread started with
  // and it is NOT dimmed here, because this vault does not ignore it; the
  // ordinary-looking `plan.md` IS, because this vault does. Any pattern the
  // renderer kept for itself would get both of these backwards.
  tree(['USER.md', 'plan.md'], ['plan.md'])

  expect(nameOf('plan.md').className).toContain('opacity-50')
  expect(nameOf('USER.md').className).not.toContain('opacity-50')
})

test('dims a wholly-ignored folder too', () => {
  // Same complaint one level up: a folder that will never be committed should
  // not look like one that will.
  tree(['build/out.md'], ['build', 'build/out.md'], ['build'])

  expect(nameOf('build').className).toContain('opacity-50')
})

test('dims the icon as well as the name, so the row reads as one thing', () => {
  tree(['USER.md'], ['USER.md'])

  const spans = [...rowFor('USER.md').querySelectorAll('span.flex.w-4')]
  expect(spans.length).toBeGreaterThan(0)
  expect(spans.every((s) => s.className.includes('opacity-50'))).toBe(true)
})

test('leaves the ROW undimmed, so a selection highlight stays solid', () => {
  // `isCut` dims the whole row and means something else: a pending move, a
  // state the row is briefly in. Being ignored is a standing fact about the
  // file, and dimming the row would take the selection background with it.
  tree(['USER.md'], ['USER.md'])

  expect(rowFor('USER.md').className).not.toContain('opacity-50')
})

test('dims nothing when git could not be asked', () => {
  // `ignoredPaths` returns empty on any failure — not a repo yet, no git
  // binary, mid-rebase. The tree renders undimmed rather than not at all.
  tree(['USER.md', 'plan.md'], [])

  expect(nameOf('USER.md').className).not.toContain('opacity-50')
  expect(nameOf('plan.md').className).not.toContain('opacity-50')
})
