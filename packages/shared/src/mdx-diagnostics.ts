export interface MdxDiagnostic {
  message: string
  line: number
  column: number
}

export type MdxCompileState =
  | { kind: 'checking' }
  | { kind: 'clean' }
  | { kind: 'syntax-error'; diagnostics: MdxDiagnostic[] }
  | { kind: 'unavailable'; message: string }
