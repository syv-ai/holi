// FIXTURE — must fail: native title="" tooltip (rule: no-restricted-syntax).
export const NativeTitle = (): React.JSX.Element => <button title="hi">x</button>
