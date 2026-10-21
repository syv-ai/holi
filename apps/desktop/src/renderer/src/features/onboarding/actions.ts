/**
 * What the ritual does to the world, in one place: create a vault, join one,
 * write the answers into it, and open it.
 *
 * **A dry run is a different set of these, not a flag the view checks.**
 * Developer → Test onboarding walks the whole ritual against the dry set, which
 * creates and writes nothing, so "writes nothing" holds by construction rather
 * than by every handler remembering an `if`. Joining in a dry run used to clone
 * for real, because the one handler that forgot was the join.
 */
import { useSetAtom } from 'jotai'
import { splitAnswersByTarget, type PluginSettings } from '@holi/shared'
import { trpc } from '@/lib/trpc'
import { activeRemoteAtom, addVaultAtom, createVaultAtom, loadVaultsAtom } from '@/state/vaults'

export interface RitualActions {
  /** Create, seed, commit and push the repo; resolves to its `owner/name`. */
  create(input: { name: string; owner: string }): Promise<string>
  /** Clone a vault a teammate has given you access to, and open it. */
  join(remote: string): Promise<void>
  /** Merge the plugins and settings answers over the new vault's seed. */
  saveAnswers(remote: string, answers: Record<string, unknown>): Promise<void>
  /** Open the vault just made and leave the ritual. */
  open(remote: string | null): Promise<void>
}

/**
 * The answers as a settings patch: split by each setting's own file, and the
 * plugins answer as a patch takes it, a plugin id to on or off for those turned
 * away from their default. The act keeps the resolved shape (`vault` and
 * `localOff`), which is what a read returns and a write refuses.
 */
export function answersPatch(answers: Record<string, unknown>) {
  const plugins = answers.plugins as PluginSettings | undefined
  return splitAnswersByTarget(
    plugins === undefined ? answers : { ...answers, plugins: plugins.vault },
  )
}

export function useRitualActions(dryRun: boolean, onDone?: () => void): RitualActions {
  const createVault = useSetAtom(createVaultAtom)
  const addVault = useSetAtom(addVaultAtom)
  const setActiveRemote = useSetAtom(activeRemoteAtom)
  const loadVaults = useSetAtom(loadVaultsAtom)

  if (dryRun) {
    return {
      // The fake success that makes the acts after naming reachable.
      create: async ({ name, owner }) => `${owner || 'you'}/${name}`,
      join: async () => onDone?.(),
      saveAnswers: async () => {},
      open: async () => onDone?.(),
    }
  }

  return {
    create: (input) => createVault(input),
    // A joined vault activates itself and unmounts the ritual through the gate.
    join: async (remote) => void (await addVault(remote)),
    saveAnswers: async (remote, answers) => {
      // The vault already holds the seed's defaults, so a failed write is not
      // fatal: say so and carry on.
      const { committed, local } = answersPatch(answers)
      try {
        const { warnings } = await trpc.settings.write.mutate({
          remote,
          committedJson: JSON.stringify(committed),
          localJson: JSON.stringify(local),
        })
        if (warnings.length > 0) console.warn(`[settings] ${warnings.join('; ')}`)
      } catch (err) {
        console.warn(
          `[settings] could not save your choices: ${err instanceof Error ? err.message : String(err)}`,
        )
      }
    },
    open: async (remote) => {
      // **Activate here, not at creation.** Activating makes the Shell land the
      // vault and read its settings; at the naming act it would read the
      // seeded defaults before the answers were written.
      if (remote !== null) setActiveRemote(remote)
      await loadVaults()
      onDone?.()
    },
  }
}
