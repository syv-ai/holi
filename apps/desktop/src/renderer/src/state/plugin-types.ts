/**
 * What a plugin's renderer side is: its info, the paths it claims, and the
 * surfaces it adds. Declared in state, which holds what plugins add, and
 * re-exported as `@/plugin-api/types`, the path plugins import, so core's
 * state and the plugins read one definition.
 */
import type { Atom, createStore, WritableAtom } from 'jotai'
import type { ComponentType } from 'react'
import type { PluginInfo, VaultSnapshot } from '@holi/shared'
export type { /** @public */ IconGlyph } from '@/lib/icon-glyph'
import type { IconGlyph } from '@/lib/icon-glyph'
import type { Command } from '@/state/commands'
import type { PluginDialog } from '@/state/dialogs'

/** What a slash command is given: the text it was typed over, the
 *  caret's line, and the note's vault path; nothing more of the buffer.
 *
 * @public
 */
export interface SlashInput {
  /** What was selected when `/` was typed, else empty. */
  text: string
  /** The caret's line (its paragraph) as it was before the command. */
  line: string
  path: string
}

/**
 * What a command does to the note. `replace`: its text takes the place of
 * what the command was typed over. `insert`: that stays, and the text
 * follows it. `agent`: the ask-the-agent prompt opens with this instruction.
 * Null leaves the note as it was.
 */
export type SlashResult = { replace: string } | { insert: string } | { agent: string } | null

/** A command a plugin adds to the slash menu. */
export interface SlashCommand {
  /** What follows the `/`. A built-in's name stays the built-in's. */
  name: string
  /** Under the name, in the menu. */
  detail?: string
  /** Where the command comes from: an app's name. */
  meta?: string
  /** Whether the menu offers it in the note at `path`; absent, everywhere.
   *  The command's plugin decides. */
  offeredIn?(path: string): boolean
  /** Rejects when it failed; the plugin says where (an app's log). */
  run(input: SlashInput): Promise<SlashResult>
}

/** One item a claim adds to a file's row menu. @public */
export interface ClaimMenuItem {
  label: string
  /** Shown only when this says so, from the path and the vault as scanned.
   *  Pure: the menu asks it on every open. */
  when?(path: string, snapshot: VaultSnapshot): boolean
  run(ctx: { remote: string; path: string; openDialog: (dialog: PluginDialog) => void }): void
}

/**
 * A directory that is one document, such as a vault app's `Budget.app`: the
 * tree lists it among the files and opens it, rather than listing what is
 * inside, and it opens as the tab `{surface, id: path}`.
 */
export interface FolderClaim {
  /** The surface it opens in, with its path as the tab's id. */
  surface: string
  /** The file that makes a matched directory a document. Without it the
   *  directory is an ordinary folder; moving it moves the tab. */
  entry: string
  /** False while the document is a draft: still listed as one, but a click
   *  shows its files, since there is nothing to open yet. `has` says whether
   *  a vault path exists. */
  ready?(path: string, has: (path: string) => boolean): boolean
}

/** How a claimed path is shown in the file tree. @public */
export interface ClaimDecoration {
  icon: IconGlyph
  /** What its row is called. */
  name(path: string): string
  /** What a rename keeps on the end of the name typed, such as `.app`. */
  suffix(path: string): string
}

/** Something the explorer's New menu makes. */
export interface ClaimCreate {
  id: string
  label: string
  icon: IconGlyph
  /** What its name field says while empty. */
  placeholder: string
  /** The New menu asks for the name first, in a field that says
   *  `placeholder`, rather than making it as Untitled: a link's address. */
  asksName?: true
  /** A web address dropped on the tree from a browser is made with this,
   *  the address as its name, in the folder it lands in. */
  fromUrl?: true
  /** Make it, named `name`, in the folder `parent` ('' for the root). Resolves
   *  to a vault path to open, or null. */
  run(ctx: { remote: string; parent: string; name: string }): Promise<string | null>
}

/**
 * A plugin owning the vault paths `match` accepts: how one opens in a pane,
 * and what its row menu offers. The first enabled claim with a `view` wins.
 * `match` runs for every folder in the tree, so keep it a cheap test of the
 * path's spelling.
 */
export interface PathClaim {
  match(path: string): boolean
  view?: ComponentType<{ path: string }>
  folder?: FolderClaim
  decorate?: ClaimDecoration
  rowMenu?: readonly ClaimMenuItem[]
  create?: ClaimCreate
  /** What a pointer resting on its row in the tree shows, in a hover card. */
  hover?: ComponentType<{ path: string }>
  /** Drawn at the top of its tab, above the document: a link file's card. */
  banner?: ComponentType<{ path: string }>
  /**
   * The file's canonical form: the same function as the main side's claim,
   * which the `normalize-md` commit transform applies. The editor treats a
   * file rewritten into it as Holi's own tidy, not a foreign edit.
   */
  normalize?(text: string): string
}

/**
 * A kind of tab that is not a file: the board, mail, settings
 * (docs/features/tabs-panes.md). A tab names it as `{kind: 'surface',
 * surface: kind, id?}`, and the pane, the tab strip, the palette, the "Open"
 * commands, Home and `holi.open` all read it from the registry, so a surface
 * whose plugin is off is simply not there.
 *
 * `kind` is its name: lowercase letters, digits and dashes (`isSurfaceName`).
 * `render` gets the tab's `id` for a surface that is one tab per thing, and
 * `label` may depend on it. `visible` is false only for a `keepMounted` tab
 * that is not its pane's active one.
 */
export interface Surface {
  kind: string
  label: string | ((id?: string) => string)
  icon: IconGlyph
  render: ComponentType<{ id?: string; visible: boolean }>
  /** Every tab of it stays mounted in its pane, hidden while another tab is
   *  active, so it keeps state a remount would lose (a terminal's
   *  scrollback). */
  keepMounted?: true
  /** Its tabs open only from its plugin's own controls: the palette, the
   *  Open commands and Home do not offer it. */
  unlisted?: true
  /** Offered as the `home` setting, and opened by it. */
  homeable?: true
  /** The ids there are to open, most recently used first: the palette lists
   *  them, the Home picker offers a folder document's, and its rail item
   *  drills down to them. */
  instances?: Atom<readonly string[]>
  /** One instance's own words about itself, for its card on a launcher page
   *  (the Apps page); null when it has none. Read again as its files change. */
  describe?: (remote: string, id: string) => Promise<string | null>
  /** A small picture of one instance for its card, a `data:` URL; null when
   *  this machine has none that is current. Read again as its files change
   *  and as `previewVersions` moves. */
  preview?: (remote: string, id: string) => Promise<string | null>
  /** Bumped for an instance whenever its picture is taken or let go. */
  previewVersions?: Atom<Readonly<Record<string, number>>>
  /** A card's Refresh preview: let the picture go, and take it again now if
   *  the instance is open somewhere on screen. */
  refreshPreview?: WritableAtom<null, [id: string], Promise<void>>
  /** The instances set aside, which `instances` leaves out: a launcher lists
   *  them under Archived. */
  archived?: Atom<readonly string[]>
  /** Set one aside, or bring it back; rejects with the reason it could not. */
  archive?: WritableAtom<null, [{ id: string; archived: boolean }], Promise<void>>
  /** Controls at the end of the pane's tab strip while its tab is active. */
  headerActions?: ComponentType<{ id?: string }>
  /**
   * The tabs of it that exist now, and how each looks, for a surface whose
   * ids come and go outside the vault (an agent's terminals). The tab strip
   * names and marks a tab from it, the palette lists every one, and a recent
   * of one lives only while it is listed. Its tabs take the keyboard
   * themselves when they open.
   */
  tabs?: Atom<readonly SurfaceTabLook[]>
  /** While one of its tabs is active, the note focused before it stays the
   *  focused one, as main is told: typing to the agent happens in its tab. */
  keepsFocusedNote?: true
}

/** How one tab of a surface looks right now (`Surface.tabs`). */
export interface SurfaceTabLook {
  id: string
  label: string
  /** The tab's tooltip, when it says more than the label. */
  tooltip?: string
  /** A background class for a dot drawn in place of the surface's icon. */
  dot?: string
}

/** Something the palette lists that is not a tab yet, such as a live agent
 *  session (`RendererPlugin.palette`).
 *  @public a plugin names it through `@/plugin-api`. */
export interface PaletteItem {
  key: string
  name: string
  /** A background class for the dot it is shown with. */
  dot: string
}

/**
 * A row a plugin adds to the ⌘K command menu (docs/features/command-palette.md):
 * a place it opens or something it does. Its plugin's `commandMenu.run` gets
 * the `id`.
 */
export interface CommandMenuEntry {
  /** Unique within its plugin. */
  id: string
  label: string
  /** `go` lists it under Go to and `action` under Actions, untyped and typed
   *  alike. Any other name is a group of its own ("Holis", "Conversations"),
   *  listed only once something is typed, so a long list never crowds the
   *  untyped menu. */
  group: 'go' | 'action' | (string & {})
  icon: IconGlyph
  /** Other words that find it: "agent" for a Holi. */
  keywords?: readonly string[]
  /** Muted beside the label: where it is, or its state. */
  detail?: string
}

/**
 * A surface's place in the nav menu. `order` sorts the menu, core's own
 * items included (Home 0, Search 10, Apps 20, Board 30, Agents 60, Sync 70,
 * Settings 100). `visible` is an atom so a plugin can show or hide its item
 * without the menu calling a hook per item.
 */
export interface RailItem {
  surface: string
  order: number
  /** The menu's word for it when that is not the surface's own label: a
   *  surface with instances is listed as a group of them, such as "Apps". */
  label?: string
  visible?: Atom<boolean>
  /** Run this command (`state/commands.ts`) instead of opening the surface. */
  command?: string
  /** While true, the item shows that something of the surface's is running. */
  live?: Atom<boolean>
}

/** @public */
export interface SettingsSectionHeading {
  /** The anchor the rail scrolls to: `headingId(title)`, never hand-written. */
  id: string
  title: string
}

/**
 * A section of the settings tab (docs/features/settings.md). Core's own and
 * every enabled plugin's are listed in one rail; a plugin's come after core's
 * vault sections and before Vault and Account.
 */
export interface SettingsSection {
  id: string
  label: string
  /** Its row in the settings nav; a plug when absent. */
  icon?: IconGlyph
  /** One line under the section's title: what it is for. */
  description?: string
  /** What the rail shows beneath the section you are in: declared, so a test
   *  can hold the section to rendering each one. */
  headings: readonly SettingsSectionHeading[]
  /** The files this section is a view of, offered at the bottom of it. */
  files: readonly string[]
  /** Shown inside core's Plugins page, under its label, rather than as a
   *  section of its own: a plugin's settings about plugins. */
  within?: 'plugins'
  Component: (props: { remote: string }) => React.JSX.Element
}

/** The renderer's one store, as an event handler gets it. */
export type PluginStore = Pick<ReturnType<typeof createStore>, 'get' | 'set' | 'sub'>

/**
 * What a plugin does when its main side emits `name`. Main sends an event
 * only for a vault that runs the plugin, but it may be about a vault other
 * than the open one: `remote` says which, and the handler decides.
 */
export type PluginEventHandler = (
  event: { remote: string; payload: unknown },
  store: PluginStore,
) => void

/** What an ask or a start answers: done, or why not, in words to show. */
export type AskResult = { ok: true } | { ok: false; message: string }

/** One of the vault's live agent sessions, as an ask offers it. */
export interface AgentSessionRow {
  id: string
  name: string
  state: 'needs-you' | 'working' | 'idle'
  /** Only for 'needs-you': why, e.g. 'permission prompt'. */
  waitingFor?: string
  /** The model, in the agent's words (`Opus 5.5`), once it has said. */
  model?: string
  /** When it started, epoch ms. */
  startedAt?: number
}

/** A file a run changed, across its whole range. */
export interface AgentRunFile {
  path: string
  added: number
  removed: number
  /** `A` | `M` | `D` | `R<score>`. */
  status: string
}

/**
 * What a run changed, for a plugin whose runs are agent sessions (a Holi's
 * sends): each run is a session, and its range is its first turn's base to
 * its last turn's end, from the agent's turn log, by job id.
 *
 * @public
 */
export interface AgentRunsSource {
  /** What each run changed, by job id, once loaded. */
  files: Atom<Readonly<Record<string, readonly AgentRunFile[]>>>
  /** Runs the person kept or reverted, by job id. This machine's. */
  reviewed: Atom<Readonly<Record<string, 'kept' | 'reverted'>>>
  /** Read the turn log and these runs' files again. */
  load: WritableAtom<null, [readonly string[]], Promise<void>>
  /** The turn review drawer over the run's range. */
  review: WritableAtom<null, [string], void>
  /** What it changed stays, and its entry stops asking. */
  keep: WritableAtom<null, [string], void>
  /** The vault as it was before the run, one new commit per file. */
  revert: WritableAtom<null, [string], Promise<AskResult>>
}

/** Where an ask may go, and where it goes when nobody picks. */
export interface AskTargets {
  /** Sessions that can take an ask now. */
  sessions: readonly { id: string; name: string }[]
  /** A session id, or `'new'` for a new session. */
  default: string
}

/**
 * The vault's agent, as everything outside its plugin uses it: every "Ask"
 * button, the reconcile hand-off and the stuck-push investigation. Core's
 * `useAgentService()` is null while no plugin provides one.
 */
export interface AgentService {
  /** What it is called in copy, such as "Ask Claude to reconcile". */
  name: string
  sessions: Atom<readonly AgentSessionRow[]>
  targets: Atom<AskTargets>
  /** Put `text` in a session's input, unsent, and bring it forward. */
  ask(args: { text: string; target: string }): Promise<AskResult>
  /** A new session whose first turn is `prompt`, brought forward. */
  start(args: { name?: string; prompt: string }): Promise<AskResult>
}

/** What a plugin provides for `AgentService`: the same, as atoms, which
 *  core binds to the store. */
export interface AgentServiceSource {
  name: string
  sessions: Atom<readonly AgentSessionRow[]>
  targets: Atom<AskTargets>
  ask: WritableAtom<null, [{ text: string; target: string }], Promise<AskResult>>
  start: WritableAtom<null, [{ name?: string; prompt: string }], Promise<AskResult>>
  /** Show a session in the Agents view; one that has finished (`live`
   *  false) is brought back first, its conversation intact. */
  show: WritableAtom<null, [{ session: string; live: boolean }], Promise<AskResult>>
  runs: AgentRunsSource
}

export interface AgentsStatus {
  /** Sessions or Holis waiting on the person (a permission, a question). */
  needsYou: number
  /** Sessions or Holis mid-turn. */
  working: number
}

/**
 * An app that takes the window over from the files (Mail, Calendar): listed at
 * the foot of the sidebar, above the profile. Picking it folds the files
 * sidebar to its rail and shows `render` beside it, which brings its own
 * sidebar; picking anything of the files' brings them back.
 */
export interface SidebarApp {
  id: string
  label: string
  icon: IconGlyph
  /** Its place among every plugin's apps, lowest first. */
  order: number
  render: ComponentType
  /** Listed only while true (an account it needs is connected). */
  visible?: Atom<boolean>
}

/**
 * One character of the empty view's arcade (`components/monocode/arcade`):
 * a Holi as the board draws it, by its pixel persona and its colour. The
 * holis plugin contributes the vault's own; with none, the board brings a
 * default cast.
 */
export interface ArcadeCastMember {
  id: string
  name: string
  /** One of `HOLI_MASCOTS`, its persona; an older arcade name draws its stand-in. */
  mascot: string
  /** `#rrggbb`, the Holi's own colour: its papers and its speech bubble. */
  color: string
}

/** @public */
export interface AgentsMode {
  sidebar: ComponentType
  /** The mode's main view for one tab: `selection` is what the tab shows
   *  (null for the mode's home), so two tabs can show two sessions. */
  main: ComponentType<{ selection: { owner: string; id: string } | null }>
  status: Atom<AgentsStatus>
  /** How a session tab looks (`AgentsTabLook`), by the selection it shows;
   *  undefined for one the mode does not know (yet). */
  tabLook?: Atom<(selection: { owner: string; id: string }) => AgentsTabLook | undefined>
  /** Start a session in the default agent and bring it forward: the tab
   *  strip's + and ⌘T on the Agents side, and the command menu's New
   *  session. `beside` opens it in split view. Absent, those open the mode's
   *  home. */
  newSession?: WritableAtom<null, [beside?: boolean], unknown>
  /** ⌘J: the sessions at a glance, ready to pick one or start one. */
  overview?: WritableAtom<null, [], unknown>
}

/** A session tab as the strip draws it: its title, the state its dot shows,
 *  and who ran it (a Holi wears its face). */
export interface AgentsTabLook {
  title: string
  state: 'needs-you' | 'working' | 'done' | 'idle'
  by?: AgentsSessionItem['by']
  /** The coding agent that runs it, for its mark. */
  agent?: string
}

/**
 * One row of the Agents sidebar's session list (docs/features/agent-sessions.md,
 * The Agents view), from whichever plugin owns it: a Holi's run, an
 * automation's run. The provider draws them all as one list and derives each
 * row's state from these fields; it never knows whose a row is.
 */
export interface AgentsSessionItem {
  /** Unique across every plugin's rows: `<owner>:<id>`. */
  key: string
  /** What picking it selects, in `agentsSelectionAtom`. Absent for a run
   *  that is only an agent session (`jobId`): the provider opens that. */
  selection?: { owner: string; id: string }
  /** The agent session it is, by job id, when it is one. A row of the
   *  provider's own live sessions with the same id merges into this one. */
  jobId?: string
  title: string
  /** The model in Claude Code's words or alias (`Opus 5.5`, `opus`). */
  model?: string
  /** The coding agent that runs it (`claude`, `codex`), for its mark.
   *  Absent is Claude Code. */
  agent?: string
  /** What it is doing now: mid-turn, waiting on a permission or a question,
   *  or neither. */
  state: 'needs-you' | 'working' | 'idle'
  /** Only for 'needs-you': what it waits on, in words. */
  waitingFor?: string
  /** Last activity, epoch ms: what its age and its day group count from. */
  updatedAt: number
  /** When its last turn ended, epoch ms. Done and unread until it is opened
   *  after this. */
  endedAt?: number
  /** Out of the list unless the filter asks for archived ones. */
  archived?: boolean
  /** Kept in a Pinned group above the day groups. */
  pinned?: boolean
  /** Claude Code's id for it, for Copy session ID: a conversation's id (what
   *  `--resume` takes). A run's job id stands in when it has none. */
  sessionId?: string
  /** Where it ran, after the vault: the document a Holi was sent. */
  location?: string
  /** Who started it, when it was not the person: a Holi (by its persona) or
   *  an automation. */
  by?: { kind: 'holi' | 'automation'; name: string; mascot?: string; color?: string }
}

/** A plugin's rows in the Agents sidebar's session list. */
export interface AgentsSessionsSource {
  items: Atom<readonly AgentsSessionItem[]>
  /** Whether its rows have come back once: `loading` draws skeletons,
   *  `error` an inline Retry. Absent is `ready`. */
  status?: Atom<'loading' | 'ready' | 'error'>
  /** Ask for its rows again (the error's Retry). */
  reload?: WritableAtom<null, [], unknown>
  /** Start a new session in its own view: the list's + and its empty
   *  state's action. The first slot with one wins over the provider's own. */
  create?: WritableAtom<null, [], unknown>
  /** Archive a row of its own, or bring one back, by its `key`. Rows
   *  without it offer no Archive. */
  archive?: WritableAtom<null, [key: string, archived: boolean], unknown>
  /** Retitle a row of its own. Rows without it offer no Rename. */
  rename?: WritableAtom<null, [key: string, title: string], unknown>
  /** Pin a row of its own above the day groups, or unpin it. */
  pin?: WritableAtom<null, [key: string, pinned: boolean], unknown>
  /** Delete a row of its own, after the list has asked. Rows without it
   *  offer no Delete. */
  remove?: WritableAtom<null, [key: string], unknown>
  /** Stop what a row of its own runs, when the person closes it in the
   *  Sessions list (a turn in flight, a prompt waiting). The row stays, in
   *  History. Rows without it only leave the list. */
  close?: WritableAtom<null, [key: string], unknown>
}

/** Something a conversation is about besides its words: a vault app, by its
 *  bundle path, which the agent reads itself (`AgentsSlot.start`). */
export interface ConversationContext {
  kind: 'app'
  path: string
  name: string
}

/** How a conversation starts (`AgentsSlot.start`). */
export interface ConversationStart {
  /** Its first message. Empty, with `context`, opens the new-session page
   *  with that context in its composer, for the person to ask. */
  text: string
  context?: readonly ConversationContext[]
  /** Open it in split view beside what is in front, as ⌥-click does. */
  beside?: boolean
}

/**
 * What another plugin adds to the Agents mode, which the plugin providing it
 * draws without knowing who adds what (docs/features/sidebar.md). Its rows
 * select `{owner: <its id>, id}` in `agentsSelectionAtom`, and while one of
 * them is selected `main` is the main view.
 */
export interface AgentsSlot {
  /** Where its section sits in the Agents sidebar: lower first. The
   *  provider's sessions are at 100; a slot without one comes after them. */
  order?: number
  /** Its rows in the sidebar's top group, under the provider's Inbox: a
   *  place it opens (Automations), not a list. Drawn inside the sidebar's
   *  menu, so each row is a `SidebarNavItem` (`@/composites`). */
  nav?: ComponentType
  /** Its section of the Agents sidebar. */
  sidebar?: ComponentType
  /** Its rows in the provider's Inbox: what of its own needs the person, or
   *  nothing. Counted by its `status`'s `needsYou`. */
  inbox?: ComponentType
  /** The main view while the selection is its own; gets the selected id. */
  main?: ComponentType<{ id: string }>
  /** The mode's main view while nothing is selected, in place of the
   *  provider's own new-session page: the first running slot with one wins. */
  home?: ComponentType
  /** Added to what the mode toggle reports. */
  status?: Atom<AgentsStatus>
  /** Its rows in the provider's one session list (a Holi's runs). */
  sessions?: AgentsSessionsSource
  /** Start a conversation whose first message is `text`, and select it, so
   *  its tab opens and comes forward: the agent's own, a new session. The
   *  command menu's Ask the agent. The first running slot with one wins. */
  start?: WritableAtom<
    null,
    [ConversationStart],
    Promise<{ ok: true } | { ok: false; message: string }>
  >
}

/**
 * An item of the status bar at the foot of the main column
 * (docs/features/status-bar.md). Its `Component` draws itself, usually as a
 * `StatusBarItem`, and renders nothing when it has nothing true to say.
 * Left items follow core's sync items, right items come before core's
 * Terminal and Output toggles; within a side, lower `order` first.
 *
 * @public
 */
export interface StatusItem {
  id: string
  side: 'left' | 'right'
  order?: number
  Component: ComponentType
}

export interface RendererPlugin {
  info: PluginInfo
  /** Handlers for the plugin's events, by name. Subscribed at boot for every
   *  installed plugin. */
  events?: Readonly<Record<string, PluginEventHandler>>
  /** Its path claims, or an atom of them for a plugin whose claims follow
   *  what main tells it (the community plugins' files). */
  claims?: readonly PathClaim[] | Atom<readonly PathClaim[]>
  surfaces?: readonly Surface[]
  rail?: readonly RailItem[]
  settingsSections?: readonly SettingsSection[]
  /**
   * The sidebar's Agents mode (docs/features/sidebar.md): its sidebar body and
   * main view replace Documents' while the mode toggle is on Agents, and
   * `status` is what the toggle reports from either mode. One plugin provides
   * it (the agent); without it the toggle is not shown.
   */
  agentsMode?: AgentsMode
  /** Apps it lists at the foot of the sidebar (`SidebarApp`). */
  sidebarApps?: readonly SidebarApp[]
  /** Characters it puts on the empty view's arcade (`ArcadeCastMember`). */
  arcadeCast?: Atom<readonly ArcadeCastMember[]>
  /** Its additions to the Agents mode another plugin provides. */
  agentsSlot?: AgentsSlot
  /**
   * What it offers to do with the open document, as rows of the Agent
   * button's menu in a pane's header (`DropdownMenuItem`s and the like from
   * `@/components/ui/dropdown-menu`). Core draws the menu and knows nothing of the rows.
   */
  documentActions?: ComponentType<{ path: string }>
  /** Shown in the sidebar, under the file tree. */
  sidebarSection?: ComponentType
  /** Right-hand drawers; each decides whether it is open. */
  drawers?: readonly ComponentType[]
  /** Its items in the status bar (`StatusItem`). */
  statusItems?: readonly StatusItem[]
  /**
   * Why leaving the open vault (switching, or adding one) costs something
   * now, as a sentence, or null when it costs nothing. Core asks before
   * leaving while any plugin's says something.
   */
  leaveGuard?: Atom<string | null>
  /** Runs while `remote` is the open vault and the plugin runs in it; the
   *  returned undo runs when either stops. */
  vault?(remote: string, store: PluginStore): () => void
  /** What it adds to the document editor's slash menu while it runs, after
   *  the built-in commands (docs/features/editor.md). */
  slashCommands?: Atom<readonly SlashCommand[]>
  agent?: AgentServiceSource
  /** Commands, run by id like core's (`state/commands.ts`), while it runs. */
  commands?: readonly Command[]
  /**
   * What the palette lists beside the vault's files that is not a tab, and
   * how one is opened: `open` gets its key, and focuses what it opens.
   */
  palette?: {
    items: Atom<readonly PaletteItem[]>
    open: WritableAtom<null, [key: string], unknown>
  }
  /** Its rows in the ⌘K command menu, and how one runs. */
  commandMenu?: {
    entries: Atom<readonly CommandMenuEntry[]>
    run: WritableAtom<null, [id: string], unknown>
  }
}
