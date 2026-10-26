import { describe, expect, it } from "vitest"

import { codeLanguage } from "../code-language"
import { lineDiff } from "../line-diff"

describe("a file's highlight language", () => {
  it("reads the extension, and the names that have none", () => {
    expect(codeLanguage("styles/site.css")).toBe("css")
    expect(codeLanguage("app/Page.vue")).toBe("vue")
    expect(codeLanguage(".holi/settings/app.yml")).toBe("yaml")
    expect(codeLanguage("Dockerfile")).toBe("docker")
    expect(codeLanguage("api/.env.local")).toBe("dotenv")
  })

  it("leaves a dotfile with no grammar, and unknown kinds, as plain text", () => {
    expect(codeLanguage(".gitignore")).toBeUndefined()
    expect(codeLanguage("notes.txt")).toBeUndefined()
    expect(codeLanguage("README")).toBeUndefined()
  })
})

describe("a line diff for the code block", () => {
  it("lists both sides in order and numbers the changed lines", () => {
    const diff = lineDiff("a\nb\nc\n", "a\nB\nc\nd\n")
    expect(diff.code).toBe("a\nb\nB\nc\nd")
    expect(diff.removed).toEqual([2])
    expect(diff.added).toEqual([3, 5])
  })

  it("reads an added or deleted file as all one side", () => {
    expect(lineDiff("", "x\ny\n")).toEqual({
      code: "x\ny",
      added: [1, 2],
      removed: [],
    })
    expect(lineDiff("x\n", "")).toEqual({ code: "x", added: [], removed: [1] })
  })

  it("marks nothing when nothing changed", () => {
    expect(lineDiff("same\n", "same\n")).toEqual({
      code: "same",
      added: [],
      removed: [],
    })
  })

  it("aligns an edit in the middle of unrelated lines", () => {
    const diff = lineDiff("1\n2\n3\n4\n5\n", "1\n2\nthree\n4\n5\n")
    expect(diff.removed).toEqual([3])
    expect(diff.added).toEqual([4])
  })
})
