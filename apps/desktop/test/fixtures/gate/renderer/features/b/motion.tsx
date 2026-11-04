// FIXTURE — must fail: motion numbers stated at the call site instead of taken
// from the vocabulary (rule: no-restricted-syntax motion). Eight violations.
export const ArbitraryDuration = (): React.JSX.Element => (
  <div className="transition-opacity duration-[220ms]">x</div>
)

export const ArbitraryEase = (): React.JSX.Element => (
  <div className="ease-[cubic-bezier(0.1,0,0.2,1)]">x</div>
)

export const ArbitraryDelay = (): React.JSX.Element => <div className="delay-[60ms]">x</div>

export const ArbitraryAnimation = (): React.JSX.Element => (
  <div className="animate-[spin_2s_linear_infinite]">x</div>
)

// The marker of a transition nobody chose: it animates every property there is,
// including ones that reflow, and names none of the four behaviours.
export const TransitionAll = (): React.JSX.Element => <div className="transition-all">x</div>

// Reached through a template QUASI rather than a string literal, which is a
// separate AST node and therefore a separate selector.
export const InTemplate = ({ on }: { on: boolean }): React.JSX.Element => (
  <div className={`transition-all duration-[300ms] ${on ? 'opacity-100' : 'opacity-0'}`}>x</div>
)

export const InlineTransition = (): React.JSX.Element => (
  <div style={{ transition: 'transform 160ms ease-out' }}>x</div>
)

export const InlineAnimationDelay = (): React.JSX.Element => (
  <div style={{ animationDelay: '90ms' }}>x</div>
)

// A raw Tailwind transition utility is still a component choosing its own
// property list and Tailwind's default duration.
export const RawTransitionUtility = (): React.JSX.Element => (
  <div className="transition-colors hover:bg-accent">x</div>
)
