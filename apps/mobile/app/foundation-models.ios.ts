export type FoundationModelsAvailability =
  | 'available'
  | 'device-not-eligible'
  | 'apple-intelligence-not-enabled'
  | 'model-not-ready'
  | 'unknown'

const reasons: FoundationModelsAvailability[] = [
  'available',
  'device-not-eligible',
  'apple-intelligence-not-enabled',
  'model-not-ready',
  'unknown',
]

export function foundationModelsAvailability(): FoundationModelsAvailability {
  const native = (
    globalThis as typeof globalThis & {
      HoliFoundationModels?: { availabilityReason?: () => unknown }
    }
  ).HoliFoundationModels
  if (!native || typeof native.availabilityReason !== 'function')
    throw new Error('HoliFoundationModels availability selector is unavailable')
  const reason = native.availabilityReason()
  if (typeof reason !== 'string' || !reasons.includes(reason as FoundationModelsAvailability))
    throw new Error('HoliFoundationModels returned an invalid availability reason')
  return reason as FoundationModelsAvailability
}
