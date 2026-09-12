// FIXTURE — must PASS the motion rule. A computed delay is the supported way to
// stagger a list, so the rule bans STATING a number, not touching the property:
// banning `animationDelay` outright would make lib/motion.ts's staggerDelay
// unusable and there would be no way to stagger anything at all.
//
// This file exists so a regex that overreaches is caught here rather than in a
// feature, and the gate test asserts it reports no motion violation.
declare function staggerDelay(i: number): string

export const ComputedDelayIsFine = ({ i }: { i: number }): React.JSX.Element => (
  <div className="motion-in-top" style={{ animationDelay: staggerDelay(i) }}>
    x
  </div>
)

export const UtilitiesAreFine = (): React.JSX.Element => (
  <div className="motion-respond hover:bg-accent">
    <span className="motion-ack-bloom motion-pulse" />
  </div>
)
