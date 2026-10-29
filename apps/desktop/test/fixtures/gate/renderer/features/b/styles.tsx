// FIXTURE - @shadcn/lint token rules, one violation each (see test/gate.test.ts).
import { Button } from '@/components/ui/button'

declare const colour: string

export const Arbitrary = (): React.JSX.Element => <div className="w-[13px]">x</div>
export const Inline = (): React.JSX.Element => <div style={{ width: 10 }}>x</div>
export const Unknown = (): React.JSX.Element => <div className="rounded-huge">x</div>
export const Dynamic = (): React.JSX.Element => <Button className={`mt-${colour}`}>x</Button>

// And these pass: a custom property, a motion utility, a declared token.
export const Fine = ({ depth }: { depth: number }): React.JSX.Element => (
  <div className="motion-respond bg-muted" style={{ '--row-depth': depth } as React.CSSProperties}>
    x
  </div>
)
