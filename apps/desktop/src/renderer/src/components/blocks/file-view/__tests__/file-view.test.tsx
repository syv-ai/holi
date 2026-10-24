/**
 * A non-note file opens in the view its kind wants: a plugin's claim first,
 * an image as an image, an office document as a placeholder, and any other
 * text as code in the plain editor, which saves it, but not while json does
 * not parse; and History, the file's commits, each opening its changes.
 */
import { emptyVaultSnapshot } from "@holi/shared"
import { createStore, Provider } from "jotai"
import { afterEach, expect, test, vi } from "vitest"
import userEvent from "@testing-library/user-event"
import { render, screen, waitFor } from "@/test/render"
import { coreContributionAtom } from "@/state/plugins"
import { activeRemoteAtom, snapshotAtom } from "@/state/vaults"
import { FileView } from "../file-view"

const read = vi.fn()
const write = vi.fn()
const historyList = vi.fn()
const fileDiff = vi.fn()

vi.mock("@/lib/trpc", () => ({
  trpc: {
    notes: {
      read: { query: (input: unknown) => read(input) },
      write: { mutate: (input: unknown) => write(input) },
    },
    github: {
      fileContributors: { query: () => Promise.resolve([]) },
    },
    history: {
      list: { query: (input: unknown) => historyList(input) },
      fileDiff: { query: (input: unknown) => fileDiff(input) },
    },
  },
}))

afterEach(() => {
  read.mockReset()
  write.mockReset()
  historyList.mockReset()
  fileDiff.mockReset()
})

function setup(path: string, claims = false) {
  const store = createStore()
  store.set(activeRemoteAtom, "syv-ai/site")
  store.set(snapshotAtom, {
    ...emptyVaultSnapshot(),
    files: [{ path, updatedAt: "2026-10-23T10:00:00Z" }],
  })
  if (claims) {
    store.set(coreContributionAtom, {
      surfaces: [],
      rail: [],
      claims: [
        {
          match: (p: string) => p.endsWith(".pdf"),
          view: ({ path: p }: { path: string }) => <p>Claimed {p}</p>,
        },
      ],
    })
  }
  render(
    <Provider store={store}>
      <FileView path={path} />
    </Provider>
  )
}

/** Types into the CodeMirror document, the way a keystroke would land. */
async function typeInto(text: string) {
  const content = await waitFor(() => {
    const node = document.querySelector<HTMLElement>(".cm-content")
    if (node === null) throw new Error("no editor yet")
    return node
  })
  const { EditorView } = await import("@codemirror/view")
  const view = EditorView.findFromDOM(content)!
  view.dispatch({
    changes: { from: 0, to: view.state.doc.length, insert: text },
  })
}

test("an image opens as an image", () => {
  setup("assets/logo.png")
  expect(screen.getByRole("img", { name: "logo.png" })).toHaveAttribute(
    "src",
    "holi-vault://vault/assets/logo.png"
  )
})

test("a plugin's claim on the path wins", () => {
  setup("docs/brief.pdf", true)
  expect(screen.getByText("Claimed docs/brief.pdf")).toBeInTheDocument()
})

test("an office document is a placeholder, not garbage text", () => {
  setup("plan.docx")
  expect(
    screen.getByText(/can't show this kind of document/)
  ).toBeInTheDocument()
  expect(read).not.toHaveBeenCalled()
})

test("code opens straight into the editor, with its latest commit", async () => {
  read.mockResolvedValue("body { color: red; }\n")
  historyList.mockResolvedValue([
    {
      sha: "4a14110aaaa",
      subject: "Update",
      date: new Date(Date.now() - 2 * 3_600_000).toISOString(),
      author: "Ana",
      added: 1,
      removed: 0,
    },
  ])
  setup("styles/site.css")
  await waitFor(() =>
    expect(document.querySelector(".cm-content")).toHaveTextContent(
      "body { color: red; }"
    )
  )
  expect(document.querySelector(".cm-lineNumbers")).not.toBeNull()
  expect(await screen.findByText("4a14110")).toBeInTheDocument()
  expect(screen.getByText("2 hours ago")).toBeInTheDocument()
})

test("code wears the code block's colours, Vue included", async () => {
  // CodeMirror measures text ranges, which jsdom does not lay out.
  Range.prototype.getClientRects ??= () =>
    ({ length: 0, item: () => null, [Symbol.iterator]: [][Symbol.iterator] }) as unknown as DOMRectList
  Range.prototype.getBoundingClientRect ??= () => new DOMRect()
  read.mockResolvedValue('<template>\n  <div class="a">{{ msg }}</div>\n</template>\n')
  historyList.mockResolvedValue([])
  setup("app/Page.vue")
  await waitFor(
    () => {
      const marks = document.querySelectorAll<HTMLElement>(".cm-content .cm-shiki")
      expect(marks.length).toBeGreaterThan(0)
      expect(marks[0]!.getAttribute("style")).toMatch(/--cb-c: ?#[0-9a-f]{6}/i)
    },
    { timeout: 10_000 }
  )
}, 15_000)

test("History lists the commits by day and opens one's changes", async () => {
  read.mockResolvedValue("a\nB\n")
  historyList.mockResolvedValue([
    {
      sha: "c2ffffffff",
      subject: "Rename the colour",
      date: "2026-08-05T10:00:00Z",
      author: "Ana",
      added: 1,
      removed: 1,
    },
  ])
  fileDiff.mockResolvedValue({ before: "a\nb\n", after: "a\nB\n" })
  setup("styles/site.css")
  await userEvent.click(await screen.findByRole("button", { name: "History" }))
  expect(await screen.findByText("Commits on Aug 5, 2026")).toBeInTheDocument()
  await userEvent.click(screen.getByRole("button", { name: /Rename the colour/ }))
  const block = await screen.findByRole("region", {
    name: "Changes to site.css",
  })
  expect(fileDiff).toHaveBeenCalledWith({ path: "styles/site.css", sha: "c2ffffffff" })
  expect(block).toHaveTextContent("ab")
})

test("a file with no commits says so in History", async () => {
  read.mockResolvedValue("x\n")
  historyList.mockResolvedValue([])
  setup("styles/site.css")
  await userEvent.click(await screen.findByRole("button", { name: "History" }))
  expect(await screen.findByText("No commits yet")).toBeInTheDocument()
})

test("a json file saves once it parses, and not before", async () => {
  read.mockResolvedValue('{"a": 1}\n')
  write.mockResolvedValue(undefined)
  historyList.mockResolvedValue([])
  setup(".holi/config.json")
  expect(await screen.findByText("Saved")).toBeInTheDocument()

  await typeInto('{"a": ')
  expect(
    await screen.findByText("Not saved until it parses")
  ).toBeInTheDocument()
  expect(write).not.toHaveBeenCalled()

  await typeInto('{"a": 2}\n')
  await waitFor(() =>
    expect(write).toHaveBeenCalledWith({
      remote: "syv-ai/site",
      path: ".holi/config.json",
      text: '{"a": 2}\n',
    })
  )
})
