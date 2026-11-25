export interface MdxDiagnostic {
  message: string
  line: number
  column: number
}

/** A compiled module graph is inert data; consumers must not evaluate it in a privileged context. */
export interface MdxArtifactGraph {
  id: string
  generation: number
  entry: string
  modules: MdxArtifactModule[]
}

export interface MdxArtifactModule {
  path: string
  code: string
  /** Original module specifier to canonical vault path or explicit React runtime reference. */
  imports: Record<string, string>
}

export interface MdxArtifactPublication {
  id: string
  generation: number
}

export const MAX_MDX_ARTIFACT_MODULES = 64
export const MAX_MDX_ARTIFACT_BYTES = 2 * 1024 * 1024

// The compiler transports raw specifiers; the broker also caps the canonical HTTPS URL.
export const MAX_MDX_SPECIFIER_LENGTH = 4096

// Shared by the offline compiler guest and the main process that validates its reply.
export const MAX_MDX_INSPECTION_DEPENDENCIES = 64
export const MAX_MDX_INSPECTION_DIAGNOSTICS = 32
export const MAX_MDX_DIAGNOSTIC_MESSAGE_LENGTH = 512

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
  /** On read failure, approved contains only known Revoke controls and pending is empty. */
  listError?: string
}

/** Push invalidation only; the renderer must re-read controls through authenticated IPC. */
export const MDX_RESOURCE_EVENTS = 'core:mdx-resources'

export type MdxCompileState =
  | { kind: 'checking' }
  | { kind: 'clean' }
  | { kind: 'syntax-error'; diagnostics: MdxDiagnostic[] }
  | { kind: 'unavailable'; message: string }
