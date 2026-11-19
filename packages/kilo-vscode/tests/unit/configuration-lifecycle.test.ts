import { describe, expect, it } from "bun:test"
import * as vscode from "vscode"
import { configuration, migrateConfiguration } from "../../src/configuration"
import { LEGACY_NAMESPACE, NAMESPACE } from "../../src/namespace"

describe("configuration migration lifecycle", () => {
  it("preserves existing extension/chat/sign-in state, retries a failed copy and does not restore reset values", async () => {
    const marker = "bharatcode-agent.settingsMigration.v1"
    const global = new Map<string, unknown>([
      ["bharatcode.apiKeySet", true],
      ["favoriteModels", ["bharatcode/qwen"]],
      ["recentModels", ["bharatcode/deepseek"]],
      ["variantSelections", { existing: "high" }],
    ])
    const local = new Map<string, unknown>([["kilo.workbench.restore", { agentManager: true }]])
    const before = { global: [...global], local: [...local] }
    const memento = (state: Map<string, unknown>) => ({
      get: (key: string, value?: unknown) => (state.has(key) ? state.get(key) : value),
      update: async (key: string, value: unknown) => {
        state.set(key, value)
      },
    })
    const properties = {
      [`${NAMESPACE}.fontSize`]: { default: 13 },
      [`${NAMESPACE}.model.modelID`]: { default: "" },
      [`${NAMESPACE}.agentWorkStyle`]: { default: "unset", scope: "application" },
    }
    type Values = { globalValue?: unknown; workspaceValue?: unknown; defaultValue?: unknown }
    const legacy: Record<string, Values> = {
      fontSize: { globalValue: 17, workspaceValue: 19 },
      "model.modelID": { globalValue: "existing-model" },
      agentWorkStyle: { globalValue: "autonomous" },
    }
    const current: Record<string, Values> = { fontSize: { defaultValue: 13 }, "model.modelID": { defaultValue: "" } }
    const snapshot = structuredClone(legacy)
    const writes: Array<{ section: string; key: string; value: unknown; target: unknown }> = []
    let blocked = true
    const context = {
      extension: { packageJSON: { contributes: { configuration: { properties } } } },
      globalState: memento(global),
      workspaceState: memento(local),
      get secrets() {
        throw new Error("migration must not touch credentials")
      },
      get globalStorageUri() {
        throw new Error("migration must not move chat storage")
      },
    } as unknown as vscode.ExtensionContext
    const original = vscode.workspace.getConfiguration
    const folders = Object.getOwnPropertyDescriptor(vscode.workspace, "workspaceFolders")
    Object.defineProperty(vscode.workspace, "workspaceFolders", {
      configurable: true,
      value: [{ uri: { toString: () => "file:///existing-project" } }],
    })
    vscode.workspace.getConfiguration = ((section: string) => {
      const old = section === LEGACY_NAMESPACE || section.startsWith(`${LEGACY_NAMESPACE}.`)
      const values = old ? legacy : current
      const prefix = section.slice((old ? LEGACY_NAMESPACE : NAMESPACE).length + 1)
      const full = (key: string) => (prefix ? `${prefix}.${key}` : key)
      return {
        inspect: (key: string) => ({ key, ...values[full(key)] }),
        get: (key: string, value?: unknown) => {
          const info = values[full(key)]
          return info?.workspaceValue ?? info?.globalValue ?? info?.defaultValue ?? value
        },
        update: async (key: string, value: unknown, target: number) => {
          if (blocked && full(key) === "model.modelID") throw new Error("settings locked")
          writes.push({ section, key, value, target })
          const level = target === vscode.ConfigurationTarget.Workspace ? "workspaceValue" : "globalValue"
          ;(values[full(key)] ??= {})[level] = value
        },
      }
    }) as typeof vscode.workspace.getConfiguration
    try {
      await migrateConfiguration(context)
      expect(global.has(marker)).toBe(false)
      expect(configuration(`${NAMESPACE}.model`).get("modelID")).toBe("existing-model")
      expect(configuration(NAMESPACE).get("fontSize")).toBe(19)
      blocked = false
      await migrateConfiguration(context)
      expect(global.get(marker)).toBe(true)
      expect(current["model.modelID"]?.globalValue).toBe("existing-model")
      const count = writes.length
      await migrateConfiguration(context)
      expect(writes).toHaveLength(count)
      await configuration(`${NAMESPACE}.model`).update("modelID", undefined, vscode.ConfigurationTarget.Global)
      await migrateConfiguration(context)
      expect(configuration(`${NAMESPACE}.model`).get("modelID")).toBe("")
      expect(legacy).toEqual(snapshot)
      expect(writes.every((write) => write.section.startsWith(NAMESPACE))).toBe(true)
      expect([...global].filter(([key]) => key !== marker)).toEqual(before.global)
      expect([...local].filter(([key]) => key !== marker)).toEqual(before.local)
    } finally {
      vscode.workspace.getConfiguration = original
      if (folders) Object.defineProperty(vscode.workspace, "workspaceFolders", folders)
    }
  })
})
