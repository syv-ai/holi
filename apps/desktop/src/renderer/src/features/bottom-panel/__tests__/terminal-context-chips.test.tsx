/**
 * The bottom panel terminal's context chips (docs/features/status-bar.md):
 * where the shell is, its branch and its changes, and how the picker names
 * a terminal.
 */
import { afterEach, describe, expect, test, vi } from "vitest"

import { fireEvent, render, screen, waitFor } from "@/test/render"
import {
  folderName,
  terminalLabel,
  withContext,
  type TerminalContext,
  type TerminalInfo,
} from "@/state/panel-terminals"

import {
  middleTruncate,
  PATH_CHARS,
  TerminalContextChips,
} from "../terminal-context-chips"

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }))
vi.mock("sonner", () => ({ toast }))

const context = (over: Partial<TerminalContext> = {}): TerminalContext => ({
  cwd: "/Users/me/Development/syvai/repos/holi",
  label: "~/Development/syvai/repos/holi",
  git: {
    branch: "feat/agents-holis-automations",
    files: 16,
    added: 1435,
    removed: 0,
  },
  ...over,
})

afterEach(() => {
  vi.clearAllMocks()
})

describe("context chips", () => {
  test("show the cwd, the branch and the changes, + without − when nothing was removed", () => {
    render(<TerminalContextChips context={context()} />)
    expect(
      screen.getByText("~/Development/syvai/repos/holi")
    ).toBeInTheDocument()
    expect(
      screen.getByText("feat/agents-holis-automations")
    ).toBeInTheDocument()
    const changes = screen.getByLabelText(
      "16 changed files, 1435 lines added, 0 removed"
    )
    expect(changes).toHaveTextContent("16•+1,435")
    expect(changes).not.toHaveTextContent("−")
    expect(screen.getByText("+1,435")).toHaveClass("text-success-foreground")
  })

  test("draw the lines removed in the destructive colour", () => {
    render(
      <TerminalContextChips
        context={context({
          git: { branch: "main", files: 2, added: 3, removed: 7 },
        })}
      />
    )
    expect(screen.getByText("−7")).toHaveClass("text-destructive-foreground")
  })

  test("outside a repository, only the cwd; a clean tree, no changes chip", () => {
    const { rerender } = render(
      <TerminalContextChips context={context({ git: null })} />
    )
    expect(screen.queryByText("feat/agents-holis-automations")).toBeNull()
    rerender(
      <TerminalContextChips
        context={context({
          git: { branch: "main", files: 0, added: 0, removed: 0 },
        })}
      />
    )
    expect(screen.getByText("main")).toBeInTheDocument()
    expect(screen.queryByLabelText(/changed file/)).toBeNull()
  })

  test("a skeleton until main first reads it", () => {
    render(<TerminalContextChips context={null} />)
    expect(screen.getByRole("status")).toBeInTheDocument()
  })

  test("clicking the cwd copies the whole path; its tooltip shows it", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.assign(navigator, { clipboard: { writeText } })
    const long = "/Users/me/" + "deep/".repeat(20) + "holi"
    render(
      <TerminalContextChips
        context={context({ cwd: long, label: long, git: null })}
      />
    )
    const chip = screen.getByRole("button", { name: `Copy ${long}` })
    expect(chip.textContent!.length).toBeLessThanOrEqual(PATH_CHARS)
    fireEvent.click(chip)
    expect(writeText).toHaveBeenCalledWith(long)
    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith("Path copied")
    )
    fireEvent.keyDown(chip, { key: "Enter" })
    expect(writeText).toHaveBeenCalledTimes(2)
    fireEvent.focus(chip)
    expect(await screen.findAllByText(long)).not.toHaveLength(0)
  })
})

describe("paths and names", () => {
  test("a long path loses its middle, keeping both ends", () => {
    expect(middleTruncate("~/short")).toBe("~/short")
    const cut = middleTruncate(
      "~/Development/syvai/repos/holi/apps/desktop/src/main",
      30
    )
    expect(cut).toHaveLength(30)
    expect(cut.startsWith("~/Develop")).toBe(true)
    expect(cut.endsWith("/src/main")).toBe(true)
    expect(cut).toContain("…")
  })

  test("the picker names a terminal by its folder, and tells two in one folder apart", () => {
    const t = (
      id: string,
      title: string,
      label: string | null
    ): TerminalInfo => ({
      id,
      title,
      exitCode: null,
      context: label === null ? null : { cwd: "/x", label, git: null },
    })
    const list = [
      t("a", "zsh", "~/dev/holi"),
      t("b", "zsh 2", "~/dev/holi"),
      t("c", "zsh 3", null),
    ]
    expect(terminalLabel(list[0]!, list)).toBe("holi · zsh")
    expect(terminalLabel(list[2]!, list)).toBe("zsh 3")
    expect(terminalLabel(t("d", "zsh", "~"), [])).toBe("~")
    expect(terminalLabel({ ...t("e", "zsh", "/"), exitCode: 1 }, [])).toBe(
      "/ (exited)"
    )
    expect(folderName("~/dev/holi/")).toBe("holi")
    expect(withContext(list, "c", context()).at(-1)!.context?.git?.files).toBe(
      16
    )
  })
})
