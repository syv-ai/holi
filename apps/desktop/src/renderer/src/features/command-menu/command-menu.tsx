/**
 * ⌘K, the command menu (docs/features/command-palette.md): one box that goes
 * anywhere in the vault and runs any action the shell has right now.
 *
 * Untyped, it offers the newest documents, the places to go and the actions.
 * Typed, it ranks the vault's documents, files and apps by name, then the
 * notes whose text holds the query, then the actions, then the groups that
 * are too long to list untyped (Settings' pages, the theme, each Holi, each
 * conversation); `>` first lists only the actions. The actions are the live
 * rows of the shortcut table (`lib/shortcuts.ts`), so each shows its real key
 * and runs the real handler, then core's own and what running plugins add
 * (`RendererPlugin.commandMenu`).
 * Ranking is `lib/command-menu-rows.ts`, outside cmdk (`shouldFilter={false}`).
 */
import { atom, useAtomValue, useSetAtom } from "jotai"
import {
  AppWindowIcon,
  AstroidIcon,
  CalendarIcon,
  ChevronsDownUpIcon,
  ColumnsIcon,
  FilePlusIcon,
  KeyboardIcon,
  ListChecksIcon,
  LoaderCircleIcon,
  MailIcon,
  MessageSquarePlusIcon,
  PanelBottomIcon,
  PanelLeftIcon,
  PlusIcon,
  RefreshCwIcon,
  RotateCcwIcon,
  SettingsIcon,
  SparklesIcon,
  SquareKanbanIcon,
  WaypointsIcon,
  SquareSplitHorizontalIcon,
  TerminalIcon,
  FolderTreeIcon,
  ArrowRightLeftIcon,
  XIcon,
  AppWindowMacIcon,
  BugIcon,
  CloudUploadIcon,
  FolderPlusIcon,
  HelpCircleIcon,
  LogOutIcon,
  MonitorIcon,
  MoonIcon,
  SunIcon,
  UserIcon,
} from "lucide-react"
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentType,
  type ReactNode,
} from "react"
import { toast } from "sonner"

import { FileType, getFileType } from "@/components/reui/file-type"
import { Button } from "@/components/ui/button"
import {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandShortcut,
} from "@/components/ui/command"
import { Kbd } from "@/components/ui/kbd"
import { hotkeyLabels } from "@/lib/hotkey"
import { SHORTCUTS } from "@/lib/shortcuts"
import {
  actionQuery,
  buildPlaces,
  rankActions,
  rankPlaces,
  textPlaces,
  type ActionRow,
  type PlaceRow,
} from "@/lib/command-menu-rows"
import { trpc } from "@/lib/trpc"
import {
  canStartConversationAtom,
  newAgentSessionAtom,
  startConversationAtom,
} from "@/state/agents-slots"
import { ensureTodaysDailyAtom } from "@/state/daily"
import {
  commandMenuEntriesAtom,
  runCommandMenuEntryAtom,
  runningPluginsAtom,
  surfacesAtom,
} from "@/state/plugins"
import { openSettingsAtom } from "@/state/settings-section"
import { isMac, liveShortcutIdsAtom, runShortcutAtom } from "@/state/shortcuts"
import { createTaskAtom } from "@/state/tasks"
import { AGENTS_HOME_KEY, GRAPH_KEY } from "@/state/tab-descriptor"
import { switchVaultAtom } from "@/state/vault-switch"
import { activeRemoteAtom, snapshotAtom, vaultsAtom } from "@/state/vaults"

import { settingsGroupsAtom } from "@/features/settings/settings-pages"
import { useNewApp } from "@/features/apps/use-new-app"
import { writeColorSchemeAtom } from "@/state/color-scheme"
import { signOutAtom } from "@/state/session"
import { openSettingsSectionAtom } from "@/state/settings-section"

import { APPS_TAB, BOARD_TAB } from "../sidebar/documents-section"

/** How long typing must pause before the note bodies are searched. */
const TEXT_SEARCH_MS = 150

type MenuIcon = ComponentType<{ className?: string; "aria-hidden"?: boolean }>

interface MenuAction extends ActionRow {
  icon: MenuIcon
  /** The key that runs it outside the menu, as a glyph spec (`⇧⌘B`). */
  keys?: string
  /** Muted after the label: a count, a state, where it is. */
  detail?: string
  run: () => void | Promise<void>
}

/** A row of a group listed only once something is typed. */
interface GroupedAction extends MenuAction {
  group: string
}

const THEMES = [
  { value: "light", label: "Light theme", icon: SunIcon },
  { value: "dark", label: "Dark theme", icon: MoonIcon },
  { value: "system", label: "System theme", icon: MonitorIcon },
] as const

const DOCS_URL = "https://github.com/syv-ai/holi/tree/main/docs"
const ISSUE_URL = "https://github.com/syv-ai/holi/issues/new"

/** The table's rows the menu offers as actions, in this order, each with
 *  its icon. Gestures, steppers and the menu's own key are left out. */
const SHORTCUT_ACTIONS: readonly {
  id: string
  icon: MenuIcon
  keywords?: string[]
}[] = [
  { id: "document.new", icon: FilePlusIcon },
  { id: "tab.new", icon: PlusIcon },
  { id: "tab.reopen", icon: RotateCcwIcon },
  { id: "tab.close", icon: XIcon },
  { id: "tab.closeAll", icon: XIcon },
  { id: "pane.split", icon: SquareSplitHorizontalIcon },
  { id: "split.separate", icon: ColumnsIcon },
  { id: "sidebar.toggle", icon: PanelLeftIcon },
  { id: "files.collapseAll", icon: ChevronsDownUpIcon },
  { id: "panel.terminal", icon: TerminalIcon, keywords: ["shell", "console"] },
  {
    id: "panel.output",
    icon: PanelBottomIcon,
    keywords: ["log", "activity", "sync"],
  },
  { id: "shortcuts.show", icon: KeyboardIcon },
]

/** The table's places to go, as the menu names them. */
const SHORTCUT_PLACES: readonly {
  id: string
  label: string
  icon: MenuIcon
}[] = [
  { id: "sidebar.documents", label: "Documents sidebar", icon: FolderTreeIcon },
  { id: "sidebar.agents", label: "Agents sidebar", icon: AstroidIcon },
  { id: "app.mail", label: "Mail", icon: MailIcon },
  { id: "app.calendar", label: "Calendar", icon: CalendarIcon },
]

function shortcut(id: string) {
  return SHORTCUTS.find((row) => row.id === id)
}

/** A key spec as it reads on this platform: `⇧⌘B`, or `Ctrl Shift B`. */
function keyText(spec: string): string {
  const mac = isMac()
  return hotkeyLabels(spec, mac).join(mac ? "" : " ")
}

export function CommandMenu({
  open,
  onOpenChange,
  onOpen,
  onAddVault,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Open a vault path, an app or a view's tab key; `beside` in split view
   *  next to what is in front. */
  onOpen: (id: string, beside: boolean) => void
  /** Clone another GitHub repository as a vault. */
  onAddVault: () => void
}) {
  const [query, setQuery] = useState("")
  const snapshot = useAtomValue(snapshotAtom)
  const remote = useAtomValue(activeRemoteAtom)
  const vaults = useAtomValue(vaultsAtom)
  const live = useAtomValue(liveShortcutIdsAtom)
  const surfaces = useAtomValue(surfacesAtom)
  const hasAgents = useAtomValue(runningPluginsAtom).some(
    (plugin) => plugin.agentsMode !== undefined
  )
  const runShortcut = useSetAtom(runShortcutAtom)
  const openSettings = useSetAtom(openSettingsAtom)
  const ensureDaily = useSetAtom(ensureTodaysDailyAtom)
  const createTask = useSetAtom(createTaskAtom)
  const switchVault = useSetAtom(switchVaultAtom)
  const canAsk = useAtomValue(canStartConversationAtom)
  const startConversation = useSetAtom(startConversationAtom)
  const newAgentSession = useSetAtom(newAgentSessionAtom)
  const pluginEntries = useAtomValue(commandMenuEntriesAtom)
  const runPluginEntry = useSetAtom(runCommandMenuEntryAtom)
  const settingsGroups = useAtomValue(settingsGroupsAtom)
  const openSection = useSetAtom(openSettingsSectionAtom)
  const setTheme = useSetAtom(writeColorSchemeAtom)
  const signOut = useSetAtom(signOutAtom)
  const newApp = useNewApp((path) => onOpen(path, false)).create
  /** ⌘↵ or ⌃↵ on the row being chosen: open it beside. */
  const beside = useRef(false)

  // Each vault app, by its bundle path and the app surface's label for it.
  const appSurface = surfaces.get("app")
  const appsAtom = useMemo(
    () =>
      atom((get) => {
        if (appSurface?.instances === undefined) return []
        const label = appSurface.label
        return get(appSurface.instances).map((id) => ({
          id,
          label: typeof label === "function" ? label(id) : label,
        }))
      }),
    [appSurface]
  )
  const apps = useAtomValue(appsAtom)
  const places = useMemo(() => buildPlaces(snapshot, apps), [snapshot, apps])

  /** Close first, then act: what it opens takes the focus the dialog would
   *  give back, and a dialog it opens is not closed with this one. */
  function choose(run: () => void | Promise<void>) {
    onOpenChange(false)
    setQuery("")
    requestAnimationFrame(() => void run())
  }

  async function openToday() {
    try {
      const path = await ensureDaily()
      if (path !== null) onOpen(path, false)
    } catch {
      toast.error(
        "Couldn’t open today’s note. Check that the vault is reachable, then try again."
      )
    }
  }

  /** A new chat with the query as its first message, in a tab of its own
   *  that comes forward (`startConversationAtom`). */
  async function ask() {
    const res = await startConversation(query.trim())
    if (!res.ok) toast.error(`Couldn’t start the chat. ${res.message}`)
  }

  async function newTask() {
    try {
      const path = await createTask({
        title: "Untitled task",
        status: "todo",
        folder: "",
      })
      if (path) onOpen(path, false)
    } catch {
      toast.error("Couldn’t create the task. Try again.")
    }
  }

  /** A plugin's row, run through the plugin that added it. */
  const fromPlugins = pluginEntries.map((entry): GroupedAction => ({
    id: `plugin:${entry.plugin}:${entry.id}`,
    label: entry.label,
    group: entry.group,
    icon: entry.icon,
    ...(entry.keywords === undefined ? {} : { keywords: entry.keywords }),
    ...(entry.detail === undefined ? {} : { detail: entry.detail }),
    run: () => runPluginEntry({ plugin: entry.plugin, id: entry.id }),
  }))
  const pluginRows = (group: string): MenuAction[] =>
    fromPlugins.filter((row) => row.group === group)

  const goTo: MenuAction[] = [
    {
      id: "go.board",
      label: "Board",
      keywords: ["tasks", "planning", "kanban"],
      icon: SquareKanbanIcon,
      keys: "⇧⌘B",
      run: () => onOpen(BOARD_TAB, beside.current),
    },
    {
      id: "go.graph",
      label: "Graph",
      keywords: ["links", "map", "network"],
      icon: WaypointsIcon,
      run: () => onOpen(GRAPH_KEY, beside.current),
    },
    ...(surfaces.has("app")
      ? [
          {
            id: "go.apps",
            label: "Apps",
            keywords: ["vault apps"],
            icon: AppWindowIcon,
            run: () => onOpen(APPS_TAB, beside.current),
          },
        ]
      : []),
    {
      id: "go.today",
      label: "Today’s note",
      keywords: ["daily", "journal"],
      icon: CalendarIcon,
      keys: shortcut("daily.open")?.keys[0],
      run: openToday,
    },
    ...pluginRows("go"),
    ...SHORTCUT_PLACES.filter((place) => live.has(place.id)).map(
      (place): MenuAction => ({
        id: place.id,
        label: place.label,
        icon: place.icon,
        keys: shortcut(place.id)?.keys[0],
        run: () => void runShortcut(place.id),
      })
    ),
    {
      id: "go.settings",
      label: "Settings",
      keywords: ["preferences", "plugins", "theme"],
      icon: SettingsIcon,
      keys: "⌘,",
      run: () => openSettings(),
    },
  ]

  const actions: MenuAction[] = [
    ...SHORTCUT_ACTIONS.filter((row) => live.has(row.id)).flatMap(
      ({ id, icon, keywords }): MenuAction[] => {
        const row = shortcut(id)
        if (row === undefined) return []
        return [
          {
            id,
            label: row.label,
            icon,
            ...(keywords === undefined ? {} : { keywords }),
            keys: row.keys[0],
            run: () => void runShortcut(id),
          },
        ]
      }
    ),
    {
      id: "task.new",
      label: "New task",
      keywords: ["todo"],
      icon: ListChecksIcon,
      run: newTask,
    },
    ...(hasAgents
      ? [
          {
            id: "session.new",
            label: "New session",
            keywords: ["agent", "chat", "claude", "codex"],
            icon: MessageSquarePlusIcon,
            keys: shortcut("session.new")?.keys[0],
            run: () => {
              if (!newAgentSession(beside.current)) {
                onOpen(AGENTS_HOME_KEY, beside.current)
              }
            },
          },
        ]
      : []),
    ...(newApp === undefined
      ? []
      : [
          {
            id: "app.new",
            label: "New app",
            keywords: ["vault app", "html", "create"],
            icon: AppWindowMacIcon,
            run: newApp,
          },
        ]),
    ...pluginRows("action"),
    {
      id: "sync.now",
      label: "Sync now",
      keywords: ["push", "pull", "commit", "git"],
      icon: CloudUploadIcon,
      run: () =>
        void trpc.sync.now
          .mutate()
          .catch(() => toast.error("Couldn’t sync. The Output says why.")),
    },
    {
      id: "vault.add",
      label: "Add vault",
      keywords: ["clone", "repository", "github"],
      icon: FolderPlusIcon,
      run: onAddVault,
    },
    ...vaults
      .filter((vault) => vault.remote !== remote)
      .map((vault): MenuAction => ({
        id: `vault.switch:${vault.remote}`,
        label: `Switch to ${vault.name}`,
        keywords: ["vault", vault.remote],
        icon: ArrowRightLeftIcon,
        run: () => switchVault(vault.remote),
      })),
  ]

  /** Too many to list untyped: each found once something is typed. */
  const more: GroupedAction[] = [
    ...settingsGroups.flatMap((group) =>
      group.pages.map((page): GroupedAction => ({
        id: `settings:${page.id}`,
        label: page.label,
        group: "Settings",
        detail: group.label,
        keywords: ["settings", group.label],
        icon: page.icon,
        run: () => openSection(page.id),
      }))
    ),
    ...THEMES.map((theme): GroupedAction => ({
      id: `theme:${theme.value}`,
      label: theme.label,
      group: "Theme",
      keywords: ["theme", "appearance", "mode", "color"],
      icon: theme.icon,
      run: () => void setTheme(theme.value),
    })),
    {
      id: "help.docs",
      label: "Help",
      group: "Help",
      keywords: ["docs", "documentation", "how"],
      icon: HelpCircleIcon,
      run: () => void window.holi.openExternal(DOCS_URL),
    },
    {
      id: "help.issue",
      label: "File an issue",
      group: "Help",
      keywords: ["bug", "feedback", "report"],
      icon: BugIcon,
      run: () => void window.holi.openExternal(ISSUE_URL),
    },
    ...fromPlugins.filter(
      (row) => row.group !== "go" && row.group !== "action"
    ),
    {
      id: "account.profile",
      label: "Profile",
      group: "Account",
      keywords: ["account", "github"],
      icon: UserIcon,
      run: () => openSection("account"),
    },
    {
      id: "account.signOut",
      label: "Sign out",
      group: "Account",
      keywords: ["log out", "account"],
      icon: LogOutIcon,
      run: () => void signOut(),
    },
  ]

  const commandsOnly = actionQuery(query)
  const term = commandsOnly ?? query
  const shownPlaces = commandsOnly === null ? rankPlaces(places, term) : []
  const shownGoTo = rankActions(goTo, term)
  const shownActions = rankActions(actions, term)
  /** Each typed-only group in the order its rows were listed. */
  const shownMore =
    term.trim() === ""
      ? []
      : [...new Set(more.map((row) => row.group))].map((group) => ({
          group,
          rows: rankActions(
            more.filter((row) => row.group === group),
            term
          ),
        }))

  // The note bodies, once typing pauses. An answer for a query no longer in
  // the box is dropped.
  const [text, setText] = useState<{
    q: string
    status: "loading" | "ready" | "error"
    hits: { path: string; snippet?: string }[]
  }>({ q: "", status: "ready", hits: [] })
  const [retry, setRetry] = useState(0)
  const textQuery = commandsOnly === null ? query.trim() : ""
  useEffect(() => {
    if (!open || remote === null || textQuery.length < 2) return
    let stale = false
    setText({ q: textQuery, status: "loading", hits: [] })
    const timer = window.setTimeout(() => {
      trpc.notes.search
        .query({ remote, q: textQuery })
        .then((hits) => {
          if (!stale) setText({ q: textQuery, status: "ready", hits })
        })
        .catch(() => {
          if (!stale) setText({ q: textQuery, status: "error", hits: [] })
        })
    }, TEXT_SEARCH_MS)
    return () => {
      stale = true
      window.clearTimeout(timer)
    }
  }, [open, remote, textQuery, retry])
  const textState = text.q === textQuery ? text : null
  const inText =
    textState?.status === "ready"
      ? textPlaces(places, shownPlaces, textState.hits)
      : []

  function handleOpenChange(next: boolean) {
    if (!next) setQuery("")
    onOpenChange(next)
  }

  return (
    <CommandDialog
      open={open}
      onOpenChange={handleOpenChange}
      title="Command menu"
      description="Go to a document, a view or an app, or run an action."
      className="sm:max-w-xl"
    >
      <Command
        shouldFilter={false}
        loop
        onKeyDown={(event) => {
          if (event.key === "Enter")
            beside.current = event.metaKey || event.ctrlKey
        }}
      >
        <CommandInput
          value={query}
          onValueChange={setQuery}
          placeholder="Search documents, or type > for actions…"
          aria-label="Search documents and actions"
        />
        <CommandList>
          <CommandEmpty>
            <div className="flex flex-col items-center gap-3">
              <p className="text-muted-foreground text-sm">
                Nothing matches “{term.trim()}”.
              </p>
              <Button variant="outline" size="sm" onClick={() => setQuery("")}>
                Clear search
              </Button>
            </div>
          </CommandEmpty>

          {shownPlaces.length > 0 ? (
            <CommandGroup
              heading={query.trim() === "" ? "Recent" : "Documents"}
            >
              {shownPlaces.map((place) => (
                <PlaceItem
                  key={`${place.kind}:${place.key}`}
                  place={place}
                  onSelect={() =>
                    choose(() => onOpen(place.key, beside.current))
                  }
                />
              ))}
            </CommandGroup>
          ) : null}

          {/* Shown while the search runs, on an error, or with what it found;
              a search that found nothing new says nothing. */}
          {textQuery.length >= 2 &&
          (textState?.status !== "ready" || inText.length > 0) ? (
            <CommandGroup heading="In text">
              {textState === null || textState.status === "loading" ? (
                <CommandItem value="text:loading" disabled>
                  <LoaderCircleIcon
                    aria-hidden="true"
                    className="motion-orbit text-muted-foreground"
                  />
                  <span className="text-muted-foreground">
                    Searching note text…
                  </span>
                </CommandItem>
              ) : textState.status === "error" ? (
                <CommandItem
                  value="text:retry"
                  onSelect={() => setRetry((n) => n + 1)}
                >
                  <RefreshCwIcon aria-hidden="true" />
                  <span>Couldn’t search note text. Retry</span>
                </CommandItem>
              ) : (
                inText.map((place) => (
                  <PlaceItem
                    key={`text:${place.key}`}
                    value={`text:${place.key}`}
                    place={place}
                    onSelect={() =>
                      choose(() => onOpen(place.key, beside.current))
                    }
                  />
                ))
              )}
            </CommandGroup>
          ) : null}

          <ActionGroup heading="Go to" actions={shownGoTo} onSelect={choose} />
          <ActionGroup
            heading="Actions"
            actions={shownActions}
            onSelect={choose}
          />
          {shownMore.map(({ group, rows }) => (
            <ActionGroup
              key={group}
              heading={group}
              actions={rows}
              onSelect={choose}
            />
          ))}

          {/* Whatever was typed can go to the agent instead: the last row,
              and the only one, already selected, when nothing else matches. */}
          {canAsk && commandsOnly === null && query.trim() !== "" ? (
            <CommandGroup heading="Ask">
              <CommandItem value="ask" onSelect={() => choose(ask)}>
                <SparklesIcon aria-hidden="true" />
                <span className="shrink-0">Ask the agent</span>
                <span className="text-muted-foreground min-w-0 flex-1 truncate">
                  {query.trim()}
                </span>
                <CommandShortcut>New chat</CommandShortcut>
              </CommandItem>
            </CommandGroup>
          ) : null}
        </CommandList>

        {/* What the keys do here, as the menu's foot. */}
        <div className="text-muted-foreground flex items-center gap-4 border-t px-3 py-2 text-xs">
          <Hint keys={["↵"]}>Open</Hint>
          <Hint keys={hotkeyLabels("⌘↵", isMac())}>Open beside</Hint>
          <Hint keys={[">"]}>Actions only</Hint>
          <span className="ms-auto">
            <Hint keys={["esc"]}>Close</Hint>
          </span>
        </div>
      </Command>
    </CommandDialog>
  )
}

function Hint({ keys, children }: { keys: string[]; children: ReactNode }) {
  return (
    <span className="flex items-center gap-1.5">
      <span className="flex items-center gap-0.5">
        {keys.map((key) => (
          <Kbd key={key}>{key}</Kbd>
        ))}
      </span>
      {children}
    </span>
  )
}

function PlaceItem({
  place,
  value,
  onSelect,
}: {
  place: PlaceRow
  value?: string
  onSelect: () => void
}) {
  return (
    <CommandItem
      value={value ?? `place:${place.kind}:${place.key}`}
      onSelect={onSelect}
      className={place.dim ? "opacity-60" : undefined}
    >
      {place.emoji !== undefined ? (
        <span aria-hidden="true" className="w-4 shrink-0 text-center">
          {place.emoji}
        </span>
      ) : place.kind === "app" ? (
        <AppWindowIcon aria-hidden="true" />
      ) : (
        <FileType
          type={getFileType(place.key)}
          size="mini"
          aria-hidden="true"
          className="shrink-0"
        />
      )}
      <span className="truncate">{place.name}</span>
      {place.snippet !== undefined || place.detail !== undefined ? (
        <span className="text-muted-foreground min-w-0 flex-1 truncate text-xs">
          {place.snippet ?? place.detail}
        </span>
      ) : null}
    </CommandItem>
  )
}

function ActionGroup({
  heading,
  actions,
  onSelect,
}: {
  heading: string
  actions: MenuAction[]
  onSelect: (run: () => void | Promise<void>) => void
}) {
  if (actions.length === 0) return null
  return (
    <CommandGroup heading={heading}>
      {actions.map((action) => {
        const Icon = action.icon
        return (
          <CommandItem
            key={action.id}
            value={`action:${action.id}`}
            onSelect={() => onSelect(action.run)}
          >
            <Icon aria-hidden />
            <span className="truncate">{action.label}</span>
            {action.detail !== undefined ? (
              <span className="text-muted-foreground min-w-0 flex-1 truncate text-xs">
                {action.detail}
              </span>
            ) : null}
            {action.keys !== undefined ? (
              <CommandShortcut>{keyText(action.keys)}</CommandShortcut>
            ) : null}
          </CommandItem>
        )
      })}
    </CommandGroup>
  )
}
