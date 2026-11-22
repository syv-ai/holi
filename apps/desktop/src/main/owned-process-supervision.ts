export interface ProcessGroupSupervision {
  /** One retained settlement. Repeated calls join it; rejection is sticky. */
  drain(): Promise<void>
}
