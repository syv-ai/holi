import { readFile, writeFile } from 'node:fs/promises'

/** Mimics Claude Code's native file tools against the materialized working copy. */
export class AgentSim {
  constructor(private readonly filePath: string) {}

  /** CC `Read`. */
  async read(): Promise<string> {
    return readFile(this.filePath, 'utf8')
  }

  /** CC `Write`: full-file rewrite. */
  async write(content: string): Promise<void> {
    await writeFile(this.filePath, content, 'utf8')
  }

  /** CC `Edit`: targeted string replace; throws if old_string is missing (mirrors CC's guard). */
  async edit(oldString: string, newString: string): Promise<void> {
    const current = await this.read()
    if (!current.includes(oldString)) {
      throw new Error(`edit failed: old_string not found: ${JSON.stringify(oldString)}`)
    }
    await this.write(current.replace(oldString, newString))
  }
}
