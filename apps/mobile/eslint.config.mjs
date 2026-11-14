import js from '@eslint/js'
import globals from 'globals'
import ts from 'typescript-eslint'

export default ts.config(
  { ignores: ['platforms/**', 'hooks/**', 'node_modules/**'] },
  js.configs.recommended,
  ...ts.configs.recommended,
  {
    files: ['**/*.{js,mjs,cjs}'],
    languageOptions: { globals: globals.node },
    rules: { '@typescript-eslint/no-require-imports': 'off' },
  },
)
