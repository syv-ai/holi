/**
 * Which grammar a vault file is highlighted with in the code view: by its
 * name for the files that have no extension worth reading (`Dockerfile`,
 * `.env.local`), otherwise by its extension. Undefined is plain text, which
 * the code block shows without loading a highlighter: `.gitignore` and
 * anything this list does not name.
 */
const BY_NAME: Record<string, string> = {
  dockerfile: "docker",
  makefile: "makefile",
  gnumakefile: "makefile",
  ".npmrc": "ini",
  ".editorconfig": "ini",
  ".gitconfig": "ini",
  ".zshrc": "shell",
  ".bashrc": "shell",
  ".profile": "shell",
}

const BY_EXTENSION: Record<string, string> = {
  astro: "astro",
  bash: "shell",
  c: "c",
  cc: "cpp",
  cjs: "javascript",
  cpp: "cpp",
  cs: "csharp",
  css: "css",
  cts: "typescript",
  diff: "diff",
  go: "go",
  gql: "graphql",
  graphql: "graphql",
  h: "c",
  hpp: "cpp",
  htm: "html",
  html: "html",
  ini: "ini",
  java: "java",
  js: "javascript",
  json: "json",
  jsonc: "json",
  json5: "json",
  jsx: "jsx",
  kt: "kotlin",
  kts: "kotlin",
  less: "less",
  mjs: "javascript",
  mts: "typescript",
  patch: "diff",
  php: "php",
  py: "python",
  rb: "ruby",
  rs: "rust",
  scss: "scss",
  sh: "shell",
  sql: "sql",
  svelte: "svelte",
  svg: "xml",
  swift: "swift",
  toml: "toml",
  ts: "typescript",
  tsx: "tsx",
  vue: "vue",
  xml: "xml",
  yaml: "yaml",
  yml: "yaml",
  zsh: "shell",
}

export function codeLanguage(path: string): string | undefined {
  const name = path.slice(path.lastIndexOf("/") + 1).toLowerCase()
  const named = BY_NAME[name]
  if (named !== undefined) return named
  if (name === ".env" || name.startsWith(".env.")) return "dotenv"
  if (name.endsWith(".dockerfile")) return "docker"
  const dot = name.lastIndexOf(".")
  // A dotfile's only dot is its name, not an extension (`.gitignore`).
  if (dot <= 0) return undefined
  return BY_EXTENSION[name.slice(dot + 1)]
}
