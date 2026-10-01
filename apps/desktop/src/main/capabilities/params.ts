/** Reading a capability's untrusted params: a refusal names what is wrong. */
import { CapabilityError } from './error'

/** Params as a plain object; an absent one is `{}`. */
export function paramsObject(raw: unknown): Record<string, unknown> {
  if (raw === undefined || raw === null) return {}
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new CapabilityError('BAD_REQUEST', 'params must be an object')
  }
  return raw as Record<string, unknown>
}

/** A required string param. */
export function stringParam(raw: Record<string, unknown>, key: string): string {
  const value = raw[key]
  if (typeof value !== 'string' || value === '') {
    throw new CapabilityError('BAD_REQUEST', `${key} is required`)
  }
  return value
}

/** An optional non-negative integer param, clamped to `max`. A CLI field
 *  arrives as text, so a numeric string counts. */
export function limitParam(
  raw: Record<string, unknown>,
  key: string,
  fallback: number,
  max: number,
): number {
  const value = raw[key]
  if (value === undefined || value === '') return fallback
  const n = typeof value === 'string' ? Number(value) : value
  if (typeof n !== 'number' || !Number.isInteger(n) || n < 1) {
    throw new CapabilityError('BAD_REQUEST', `${key} must be a positive integer`)
  }
  return Math.min(n, max)
}

export const noParams = (): Record<string, never> => ({})

/** A required `path` param, the commonest shape. */
export const pathParams = (raw: unknown): { path: string } => ({
  path: stringParam(paramsObject(raw), 'path'),
})
