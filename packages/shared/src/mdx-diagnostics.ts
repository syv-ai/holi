export interface MdxDiagnostic {
  message: string
  line: number
  column: number
}

export const MDX_RESOURCE_PURPOSE = 'mdx-dependency-diagnostics'

export interface MdxExternalResourceRequest {
  id: string
  origin: string
  purpose: typeof MDX_RESOURCE_PURPOSE
}

export interface MdxExternalResourceGrant {
  id: string
  origin: string
  purpose: typeof MDX_RESOURCE_PURPOSE
  /** Access is already blocked; revoke this same ID again to save the removal. */
  revocationPending?: boolean
}

/** External dependency controls for one diagnostics lease and source generation. */
export interface MdxExternalResourceState {
  generation: number
  pending: MdxExternalResourceRequest[]
  approved: MdxExternalResourceGrant[]
}

/** Push invalidation only; the renderer must re-read controls through authenticated IPC. */
export const MDX_RESOURCE_EVENTS = 'core:mdx-resources'

export type MdxCompileState =
  | { kind: 'checking' }
  | { kind: 'clean' }
  | { kind: 'syntax-error'; diagnostics: MdxDiagnostic[] }
  | { kind: 'unavailable'; message: string }
