/** Browser-safe, serializable contracts for the UI's loaded mail list. */
export interface MailListCursor {
  version: 1
  /** Account/list lifetime supplied by the adapter, never just a folder name. */
  owner: string
  /** Includes the query, filters and resolved account identities. */
  key: string
  historyId: string
}

export interface MailListRequest {
  /** All rows held by the caller, including rows beyond the disk cache. */
  loadedIds: string[]
  cursor?: MailListCursor
  /** Refresh the loaded set; omit for initial and continuation pages. */
  refresh?: boolean
}

export interface MailListContext {
  owner: string
  request: MailListRequest
}

export interface MailListResult {
  /** page: append; delta/coverage: upsert summaries and apply explicit removals.
   * Missing rows in the response are NOT departures. */
  mode: 'page' | 'delta' | 'coverage'
  cursor: MailListCursor
  removedIds: string[]
  /** Loaded IDs authoritatively checked. Coverage checks every supplied ID. */
  revalidatedIds: string[]
}
