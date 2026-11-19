import { describe, expect, it } from "bun:test"
import type { WorkspaceConfiguration } from "vscode"
import { copySettings, fallback } from "../../src/namespace"

type Values = {
  defaultValue?: unknown
  globalValue?: unknown
  workspaceValue?: unknown
  workspaceFolderValue?: unknown
}

// A small VS Code configuration boundary; tests exercise the real migration/read logic.
function config(values: Record<string, Values> = {}, blocked = new Set<string>()) {
  const writes: Array<{ key: string; value: unknown; target: unknown }> = []
  const api = {
    get: (key: string, value?: unknown) => {
      const info = values[key]
      return info?.workspaceFolderValue ?? info?.workspaceValue ?? info?.globalValue ?? info?.defaultValue ?? value
    },
    inspect: (key: string) => (values[key] ? { key, ...values[key] } : undefined),
    update: async (key: string, value: unknown, target: number) => {
      if (blocked.has(key)) throw new Error("read-only settings")
      writes.push({ key, value, target })
      const level = target === 3 ? "workspaceFolderValue" : target === 2 ? "workspaceValue" : "globalValue"
      ;(values[key] ??= {})[level] = value
    },
  } as WorkspaceConfiguration
  return { api, values, writes }
}

describe("BharatCode settings namespace migration", () => {
  it("reads explicit legacy values ahead of new defaults, including false/zero/empty values", () => {
    for (const value of [false, 0, "", [], ["existing-model"]]) {
      const current = config({ setting: { defaultValue: "new-default" } })
      const legacy = config({ setting: { defaultValue: "other-extension-default", globalValue: value } })
      expect(fallback(current.api, legacy.api).get("setting")).toEqual(value)
      expect(current.writes).toEqual([])
      expect(legacy.writes).toEqual([])
    }
  })

  it("never adopts another extension's contributed defaults", () => {
    const current = config({ setting: { defaultValue: false } })
    const legacy = config({ setting: { defaultValue: true } })
    expect(fallback(current.api, legacy.api).get("setting")).toBe(false)
    expect(fallback(current.api, legacy.api).get("missing", "fallback")).toBe("fallback")
  })

  it("preserves VS Code scope precedence and prefers explicit new values within each scope", () => {
    const current = config({ setting: { globalValue: "new-user", workspaceFolderValue: "new-folder" } })
    const legacy = config({
      setting: { globalValue: "old-user", workspaceValue: "old-workspace", workspaceFolderValue: "old-folder" },
    })
    const resolved = fallback(current.api, legacy.api)
    expect(resolved.get("setting")).toBe("new-folder")
    delete current.values.setting!.workspaceFolderValue
    expect(resolved.get("setting")).toBe("old-folder")
    delete legacy.values.setting!.workspaceFolderValue
    expect(resolved.get("setting")).toBe("old-workspace")
    expect(resolved.inspect("setting")).toMatchObject({ globalValue: "new-user", workspaceValue: "old-workspace" })
    current.values.setting!.workspaceValue = false
    expect(resolved.get("setting")).toBe(false)
  })

  it("copies only missing explicit values to the same scope without touching old settings", async () => {
    const current = config({ setting: { defaultValue: true }, existing: { globalValue: false } })
    const legacy = config({
      setting: { globalValue: false, workspaceValue: true, workspaceFolderValue: false },
      existing: { globalValue: true },
      defaults: { defaultValue: 99 },
    })
    const before = structuredClone(legacy.values)
    const errors: unknown[] = []
    for (const [level, target] of [
      ["globalValue", 1],
      ["workspaceValue", 2],
      ["workspaceFolderValue", 3],
    ] as const) {
      expect(
        await copySettings(current.api, legacy.api, ["setting", "existing", "defaults"], level, target, (_, error) =>
          errors.push(error),
        ),
      ).toBe(true)
    }
    expect(current.writes).toEqual([
      { key: "setting", value: false, target: 1 },
      { key: "setting", value: true, target: 2 },
      { key: "setting", value: false, target: 3 },
    ])
    expect(legacy.values).toEqual(before)
    expect(legacy.writes).toEqual([])
    expect(errors).toEqual([])
    expect(await copySettings(current.api, legacy.api, ["setting"], "globalValue", 1, () => {})).toBe(true)
    expect(current.writes).toHaveLength(3)
  })

  it("keeps failed values readable, continues other copies, and safely retries", async () => {
    const blocked = new Set(["first"])
    const current = config({ first: { defaultValue: true } }, blocked)
    const legacy = config({ first: { globalValue: false }, second: { globalValue: 0 } })
    const errors: string[] = []
    expect(
      await copySettings(current.api, legacy.api, ["first", "second"], "globalValue", 1, (key) => errors.push(key)),
    ).toBe(false)
    expect(errors).toEqual(["first"])
    expect(fallback(current.api, legacy.api).get("first")).toBe(false)
    expect(current.writes).toEqual([{ key: "second", value: 0, target: 1 }])
    blocked.clear()
    expect(await copySettings(current.api, legacy.api, ["first", "second"], "globalValue", 1, () => {})).toBe(true)
    expect(current.writes).toHaveLength(2)
  })

  it("does not resurrect old preferences after a migrated setting is reset", async () => {
    const current = config({ setting: { defaultValue: true, globalValue: false } })
    const legacy = config({ setting: { globalValue: false } })
    const resolved = fallback(current.api, legacy.api, [true, true, true])
    await resolved.update("setting", undefined, 1)
    expect(resolved.get("setting")).toBe(true)
    expect(resolved.inspect("setting")?.globalValue).toBeUndefined()
    expect(legacy.values.setting!.globalValue).toBe(false)
    expect(legacy.writes).toEqual([])
  })
})
