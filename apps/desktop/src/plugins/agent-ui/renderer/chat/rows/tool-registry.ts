/**
 * Which renderer draws a tool call, by the tool's name. A Map and not an
 * object, because the name is the model's: `constructor` or `__proto__` must
 * not resolve to something on `Object.prototype`. Names that are the same tool
 * spelt another way (`Task` for `Agent`, `bash` for `Bash`) go through an alias
 * table; `mcp__<server>__<tool>` goes to the MCP renderers by pattern; any other
 * name has none, and the card draws the generic view.
 *
 * The table is built on first use, not when the module loads: a renderer that
 * draws a nested conversation imports the row switch, which imports the card,
 * which imports this, so a table built at load could meet a renderer not yet
 * defined.
 */
import type { ToolRenderer } from './registry'
import { agentRenderer, handbackRenderer, sendMessageRenderer } from './tools/agent'
import { askRenderer } from './tools/ask'
import { bashRenderer } from './tools/bash'
import { editRenderer, writeRenderer } from './tools/edit-write'
import { parseMcp } from './tools/generic'
import { browserRenderer, mcpRenderer } from './tools/mcp'
import {
  monitorRenderer,
  skillRenderer,
  structuredOutputRenderer,
  taskStopRenderer,
  toolSearchRenderer,
  workflowRenderer,
} from './tools/misc'
import { planRenderer } from './tools/plan'
import { readRenderer } from './tools/read'
import { globRenderer, grepRenderer } from './tools/search'
import { taskCreateRenderer, taskUpdateRenderer, todoWriteRenderer } from './tools/tasks'
import { webFetchRenderer, webSearchRenderer } from './tools/web'

/** Other spellings of a tool, by lower-cased name. */
const ALIASES: ReadonlyMap<string, string> = new Map([
  ['task', 'Agent'],
  ['subagent', 'Agent'],
  ['bash', 'Bash'],
  ['read', 'Read'],
  ['write', 'Write'],
  ['edit', 'Edit'],
  ['grep', 'Grep'],
  ['glob', 'Glob'],
  ['webfetch', 'WebFetch'],
  ['websearch', 'WebSearch'],
  ['todowrite', 'TodoWrite'],
  ['agent', 'Agent'],
  ['askuserquestion', 'AskUserQuestion'],
  ['exitplanmode', 'ExitPlanMode'],
  ['taskcreate', 'TaskCreate'],
  ['taskupdate', 'TaskUpdate'],
  ['taskstop', 'TaskStop'],
  ['killshell', 'TaskStop'],
  ['skill', 'Skill'],
  ['monitor', 'Monitor'],
  ['workflow', 'Workflow'],
  ['toolsearch', 'ToolSearch'],
  ['sendmessage', 'SendMessage'],
  ['subagenthandback', 'SubagentHandback'],
  ['structuredoutput', 'StructuredOutput'],
])

let table: ReadonlyMap<string, ToolRenderer> | null = null

function renderers(): ReadonlyMap<string, ToolRenderer> {
  table ??= new Map<string, ToolRenderer>([
    ['Bash', bashRenderer],
    ['Read', readRenderer],
    ['Write', writeRenderer],
    ['Edit', editRenderer],
    ['Grep', grepRenderer],
    ['Glob', globRenderer],
    ['WebFetch', webFetchRenderer],
    ['WebSearch', webSearchRenderer],
    ['Agent', agentRenderer],
    ['SubagentHandback', handbackRenderer],
    ['SendMessage', sendMessageRenderer],
    ['TaskCreate', taskCreateRenderer],
    ['TaskUpdate', taskUpdateRenderer],
    ['TodoWrite', todoWriteRenderer],
    ['AskUserQuestion', askRenderer],
    ['ExitPlanMode', planRenderer],
    ['Skill', skillRenderer],
    ['Monitor', monitorRenderer],
    ['Workflow', workflowRenderer],
    ['TaskStop', taskStopRenderer],
    ['ToolSearch', toolSearchRenderer],
    ['StructuredOutput', structuredOutputRenderer],
  ])
  return table
}

/** The renderer for a tool, or undefined: the card then draws the generic view. */
export function rendererFor(name: string): ToolRenderer | undefined {
  if (typeof name !== 'string' || name === '') return undefined
  const known = renderers()
  const exact = known.get(name)
  if (exact !== undefined) return exact
  const mcp = parseMcp(name)
  if (mcp !== null) return /browser/i.test(mcp.server) ? browserRenderer : mcpRenderer
  const alias = ALIASES.get(name.toLowerCase())
  return alias === undefined ? undefined : known.get(alias)
}
