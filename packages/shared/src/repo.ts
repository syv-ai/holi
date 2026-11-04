/** A GitHub repository as the vault pickers see it. */

export interface Repo {
  /** `owner/repo`: the same identity `VaultEntry` and `cloneRepo` speak. */
  remote: string
  private: boolean
  /**
   * Surfaced because a vault silently becoming public is the highest-severity
   * thing that can happen to it. `internal` is a third state, not a synonym
   * for either.
   */
  visibility: 'public' | 'private' | 'internal'
  /** ISO. The picker's sort key. */
  pushedAt: string
  defaultBranch: string
  /** GitHub's `size`, in KiB: what the repo weighs on GitHub (`repoUsagePercent`). */
  sizeKb: number
  /**
   * `permissions.push`. A repo you cannot push to would become a vault that
   * cannot publish, so the picker offers it visibly disabled rather than
   * letting someone discover it at their first Publish.
   */
  canPush: boolean
  /** `permissions.admin`: the level GitHub asks for before it deletes the repo,
   *  so it decides whether Holi offers Delete at all. */
  canAdmin: boolean
  owner: { login: string; kind: 'user' | 'org' }
  /** Carries the `holi-vault` topic. Drives the "join a vault" filter. */
  isVault: boolean
}
