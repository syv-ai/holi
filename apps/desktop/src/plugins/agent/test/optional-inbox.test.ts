import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { jsonFileStore, type CapabilityContext } from '../../../main/plugin-api'
import { createInbox } from '../main/inbox/inbox'
import { inboxCapabilities } from '../main/inbox/capabilities'
import { parseInbox } from '../main/inbox/rules'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

it('disables inbox delivery and mutations while preserving the backlog for re-enabling', async () => {
  const root = await mkdtemp(join(tmpdir(), 'holi-605-inbox-'))
  roots.push(root)
  const path = join(root, 'inbox.json')
  let enabled = true
  const banners: string[] = []
  const inbox = createInbox({
    store: jsonFileStore(path, parseInbox),
    enabled: () => enabled,
    changed: () => {},
    notify: (notice) => {
      banners.push(notice.title)
      return true
    },
  })
  await inbox.raise({ title: 'Existing request', line: 'Keep this request.' })
  const entry = (await inbox.view()).entries[0]!
  const before = await readFile(path, 'utf8')
  enabled = false
  expect(await inbox.raise({ title: 'New request', line: 'Do not deliver.' })).toBe('disabled')
  await inbox.dismiss(entry.id)
  await inbox.seen()
  expect(await inbox.view()).toEqual({ entries: [], unread: 0 })
  expect(await readFile(path, 'utf8')).toBe(before)
  expect(banners).toEqual(['Existing request'])

  const caps = inboxCapabilities({ inbox, liveRemote: () => 'fixture/inbox' })
  const context = {
    root,
    remote: 'fixture/inbox',
    core: { syncState: () => ({}) },
  } as unknown as CapabilityContext
  const notify = caps['agent.notify']
  await expect(
    notify.run(context, notify.params({ title: 'Notify', line: 'Disabled' })),
  ).rejects.toMatchObject({ code: 'FORBIDDEN' })
  enabled = true
  expect((await inbox.view()).entries).toEqual([entry])
  expect((await inbox.view()).unread).toBe(1)
})
