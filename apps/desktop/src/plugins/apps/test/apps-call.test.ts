/**
 * `apps.call`: what a vault app may ask the vault for, as `AppFrame` forwards
 * it from the frame it mounted.
 *
 * These tests are the security boundary, not a convenience check. The refusal
 * lives in main and is asserted here because the renderer is the process that
 * hosts untrusted app code, and the process rendering untrusted code must not
 * also be the process deciding what it may read.
 */
import { taskClaim } from '@holi/shared'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { appsCapabilities, storeCapabilities } from '../main/capabilities'
import { createCapabilityHost, type AppDoor } from '../../../main/capabilities/dispatch'
import { createCapabilityRegistry } from '../../../main/capabilities/registry'
import { noCoreServices } from '../../../main/capabilities/services'
import { vaultCapabilities, VAULT_NAMESPACES } from '../../../main/capabilities/vault-caps'
import { taskCapabilities, TASK_NAMESPACES } from '../../../main/vault/task-capabilities'
import { seedVault } from '../../../../test/helpers/seed'

const REMOTE = 'ada/vault'
const dirs: string[] = []

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })))
})

async function rig() {
  const root = await mkdtemp(join(tmpdir(), 'holi-apps-call-'))
  dirs.push(root)
  // A real vault carries its seeded files: the agent surface is there to refuse.
  await seedVault(root)
  for (const [rel, text] of Object.entries({
    'inbox.md': '# Inbox\n\nnotes\n',
    'USER.local.md': '# Ada Holm\n\nada@syv.ai\n',
    'task.review.md': '---\ntitle: Review\nstatus: todo\n---\n',
    'Tracker.app/index.html': '<p>tracker</p>\n',
    'Tracker.app/app.yaml': '',
  })) {
    await mkdir(dirname(join(root, rel)), { recursive: true })
    await writeFile(join(root, rel), text)
  }
  const registry = createCapabilityRegistry()
  registry.register(
    VAULT_NAMESPACES,
    vaultCapabilities({ updateSkills: async () => ({ summary: '', conflicts: null }) }),
  )
  registry.register(TASK_NAMESPACES, taskCapabilities({ today: () => '2026-09-30' }))
  let door: AppDoor | null = null
  registry.register(
    ['apps'],
    appsCapabilities({
      events: { emit: () => {} },
      appDoor: () => door!,
      grants: { status: async () => ({ codeHash: '', affordances: [] }), grant: async () => true },
    }),
  )
  registry.register(['store'], storeCapabilities())
  const host = createCapabilityHost({
    registry,
    rootFor: async (remote) => (remote === REMOTE ? root : null),
    active: () => null,
    core: noCoreServices,
    pluginEnabled: async () => true,
    claims: async () => [{ ...taskClaim, plugin: 'tasks' }],
  })
  // No entry here asks for an app's consent.
  door = host.openAppDoor({ admit: async () => {} })
  /** One bridge call, as `AppFrame` makes it for the frame it mounted. */
  const call = async (method: string, params?: unknown, bundle = 'Tracker.app') =>
    (
      await host.dispatch({
        door: 'ui',
        remote: REMOTE,
        name: 'apps.call',
        params: { bundle, method, params },
      })
    ).value
  return { call, door }
}

describe('apps.call', () => {
  it('reads an ordinary note', async () => {
    const { call } = await rig()
    expect(await call('docs.read', { path: 'inbox.md' })).toContain('# Inbox')
  })

  it('refuses every file that configures the agent', async () => {
    // `.claude/hooks/google-send-gate.mjs` IS the mail send gate, so a readable
    // agent surface is an app reading its way toward the agent's configuration,
    // and MEMORY.md/USER.local.md are what the user told the assistant privately.
    const { call } = await rig()
    for (const path of [
      'AGENTS.md',
      'CLAUDE.md',
      'MEMORY.md',
      'USER.local.md',
      '.claude/settings.json',
      // `.holi/memory/` is MEMORY.md subdivided, and does not become readable by
      // being spread over more files.
      '.holi/memory/index.md',
      '.holi/memory/shell-quirks.md',
    ]) {
      await expect(call('docs.read', { path })).rejects.toMatchObject({ code: 'FORBIDDEN' })
    }
  })

  it('refuses a path that leaves the vault', async () => {
    const { call } = await rig()
    await expect(call('docs.read', { path: '../outside.md' })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    })
  })

  it('says NOT_FOUND for a missing note, distinguishably from a refusal', async () => {
    const { call } = await rig()
    await expect(call('docs.read', { path: 'nope.md' })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    })
  })

  it('lists the vault docs with the agent surface removed', async () => {
    const { call } = await rig()
    const paths = ((await call('docs.list')) as { path: string }[]).map((d) => d.path)
    expect(paths).toContain('inbox.md')
    // Seeded at creation, so their absence here is a filter doing work
    // rather than a fixture that never had them.
    expect(paths).not.toContain('AGENTS.md')
    expect(paths).not.toContain('MEMORY.md')
    // The listing, not just the read: an app that cannot open a memory but can
    // see every memory's path has still been told what the vault remembers.
    expect(paths.some((p) => p.startsWith('.holi/memory/'))).toBe(false)
  })

  it('lists the vault tasks', async () => {
    const { call } = await rig()
    expect(((await call('tasks.list')) as { title: string }[]).map((t) => t.title)).toContain(
      'Review',
    )
  })

  it('refuses a method no app may call, and a caller that is not an app', async () => {
    const { call } = await rig()
    await expect(call('apps.init', { path: 'x.app' })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    })
    await expect(call('nope')).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    await expect(call('docs.list', undefined, 'notes')).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    })
  })

  it('cannot be reached from a frame, nor can the approval', async () => {
    // The app door's allowlist is what was registered for it: an app that
    // names `apps.call` cannot call as another app, and one that names
    // `apps.grant` cannot approve itself.
    const { call, door } = await rig()
    for (const method of ['apps.call', 'apps.grant', 'apps.grants', 'apps.log']) {
      await expect(door.call(REMOTE, 'Tracker.app', method, {})).rejects.toThrow(/no such method/)
      await expect(call(method, {})).rejects.toThrow(/no such method/)
    }
  })
})
