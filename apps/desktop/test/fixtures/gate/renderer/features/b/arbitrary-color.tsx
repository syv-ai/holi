// FIXTURE — must fail: arbitrary colour literal (rule: no-restricted-syntax colour).
export const Swatch = (): React.JSX.Element => <div className="bg-[#ff0000] text-foreground">x</div>
