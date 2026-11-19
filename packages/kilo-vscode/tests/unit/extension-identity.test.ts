import { describe, expect, it } from "bun:test"
import { readFileSync, readdirSync } from "node:fs"
import { resolve, join } from "node:path"
import { EXTENSION_DISPLAY_NAME, EXTENSION_ID } from "../../src/constants"
import { NAMESPACE } from "../../src/namespace"

const root = resolve(import.meta.dir, "../..")
const read = (path: string) => readFileSync(join(root, path), "utf8")
const pkg = JSON.parse(read("package.json"))
const prefix = `${NAMESPACE}.`

function sources(directory: string): Array<{ file: string; source: string }> {
  return readdirSync(join(root, directory), { withFileTypes: true }).flatMap((entry) => {
    const file = `${directory}/${entry.name}`
    if (entry.isDirectory()) return sources(file)
    if (!/\.tsx?$/.test(entry.name) || /\.(test|spec)\./.test(entry.name)) return []
    return [{ file, source: read(file) }]
  })
}

const files = sources("src")
const source = files.map((file) => file.source).join("\n")

describe("BharatCode Agent public namespace and persistent identity", () => {
  it("shared shortcuts do not toggle approval or capture keys outside BharatCode", () => {
    for (const name of ["focusChatInput", "toggleAutoApprove", "generateTerminalCommand", "agentManagerOpen"]) {
      const binding = pkg.contributes.keybindings.find(
        (item: { command: string }) => item.command === `bharatcode-agent.${name}`,
      )
      expect(binding?.when).toContain("bharatcode-agent.sidebarFocused")
    }
    expect(
      pkg.contributes.keybindings.some((item: { command: string }) => item.command.startsWith("-workbench.")),
    ).toBe(false)
  })

  it("keeps the installed extension identity and backend storage behavior", () => {
    expect(pkg.name).toBe("bharatcode-agent")
    expect(pkg.publisher).toBe("bharatcode")
    expect(pkg.displayName).toBe("BharatCode Agent")
    expect(EXTENSION_DISPLAY_NAME).toBe(pkg.displayName)
    expect(`${pkg.publisher}.${pkg.name}`).toBe(EXTENSION_ID)
    expect(EXTENSION_ID).toBe("bharatcode.bharatcode-agent")
    expect(read("src/extension.ts")).toContain('const RESTORE_KEY = "kilo.workbench.restore"')
    expect(read("src/extension.ts")).toContain("context.globalStorageUri.fsPath")
    expect(read("src/onboarding/bharatcode.ts")).toContain('const CONNECTED_FLAG = "bharatcode.apiKeySet"')
    expect(read("src/services/cli-backend/server-manager.ts")).toContain('KILO_APP_NAME: "kilo-code"')
    expect(read("src/services/cli-backend/server-manager.ts")).toContain("this.context.globalStorageUri.fsPath")
    expect(read("src/agent-manager/WorktreeStateManager.ts")).toContain('const STATE_FILE = "agent-manager.json"')
    expect(read("src/agent-manager/WorktreeStateManager.ts")).toContain("path.join(root, KILO_DIR, STATE_FILE)")
    expect(read("src/agent-manager/constants.ts")).toContain('".kilo"')
    // A UI namespace change must never turn into an auth/chat data migration.
    const migration = read("src/configuration.ts") + read("src/namespace.ts")
    expect(migration).not.toMatch(/secrets\.|globalStorageUri|auth\.json|unlink|rmSync/)
    expect(migration).not.toMatch(/legacy\.update\(/)
  })

  it("retains the correct lookup identity in production compilation", async () => {
    const result = await Bun.build({
      entrypoints: [join(root, "src/constants.ts")],
      target: "node",
      minify: true,
    })
    expect(result.success).toBe(true)
    const output = await result.outputs[0]!.text()
    expect(output).toContain("bharatcode.bharatcode-agent")
    expect(output).toContain("BharatCode Agent")
    expect(output).not.toContain("bharatcode.bharatcode-vscode")
    expect(output).not.toContain("thenabbu.bharatcode-vscode")
  })

  it("has isolated contributions, with menu/keybinding commands matching declarations", () => {
    const commands = pkg.contributes.commands.map((item: { command: string }) => item.command) as string[]
    expect(new Set(commands).size).toBe(commands.length)
    expect(commands.every((id) => id.startsWith(prefix))).toBe(true)
    const submenus = pkg.contributes.submenus.map((item: { id: string }) => item.id) as string[]
    for (const id of submenus) expect(id.startsWith(prefix)).toBe(true)
    for (const items of Object.values(pkg.contributes.menus) as Array<Array<{ command?: string; submenu?: string }>>) {
      for (const item of items) {
        if (item.command) expect(commands).toContain(item.command)
        if (item.submenu) expect(submenus).toContain(item.submenu)
      }
    }
    for (const item of pkg.contributes.keybindings) {
      if (item.command.startsWith("-workbench.")) continue // Existing built-in keybinding removal.
      expect(commands).toContain(item.command)
    }
    for (const key of Object.keys(pkg.contributes.configuration.properties)) expect(key.startsWith(prefix)).toBe(true)
    for (const item of pkg.contributes.taskDefinitions) expect(item.type.startsWith(prefix)).toBe(true)
    expect(JSON.stringify(pkg.contributes)).not.toMatch(/kilo-code(?:\.new|\.SidebarProvider|-ActivityBar)/)
  })

  it("matches sidebar/container IDs, panel IDs, context keys and command references", () => {
    const container = pkg.contributes.viewsContainers.activitybar[0].id
    const view = pkg.contributes.views[container][0].id
    expect(container).toBe(`${NAMESPACE}-ActivityBar`)
    // VS Code rejects dots in container IDs (unlike command and view IDs).
    expect(container).toMatch(/^[a-zA-Z0-9_-]+$/)
    expect(view).toBe(`${NAMESPACE}.SidebarProvider`)
    expect(read("src/KiloProvider.ts")).toContain(`viewType = "${view}"`)
    expect(read("src/extension.ts")).toContain(`"${view}.focus"`)
    for (const { file, source } of files) {
      if (file === "src/namespace.ts") continue
      expect(source, file).not.toMatch(
        /kilo-code\.new|kilo-code\\\.new|kilo-code\.SidebarProvider|kilo-code-ActivityBar|kilo-code\.agentTerminalFocus/,
      )
    }
    const registered = new Set([...source.matchAll(/registerCommand\s*\(\s*"([^"]+)"/g)].map((match) => match[1]))
    registered.add(`${NAMESPACE}.setBharatcodeKey`)
    for (let i = 1; i <= 9; i++) registered.add(`${NAMESPACE}.agentManager.jumpTo${i}`)
    for (const match of source.matchAll(/executeCommand\s*\(\s*"(bharatcode-agent\.[^"]+)"/g)) {
      if (match[1] === `${view}.focus`) continue // VS Code's generated focus command.
      expect(registered.has(match[1]!), match[1]).toBe(true)
    }
    for (const match of source.matchAll(/setContext"\s*,\s*"([^"]+)"/g)) expect(match[1]!.startsWith(prefix)).toBe(true)
    expect(read("src/SettingsEditorProvider.ts")).toContain("type.match(/^bharatcode-agent\\.(\\w+)Panel$/)")
    expect(read("src/extension.ts")).toContain("registerWebviewPanelSerializer(`bharatcode-agent.${suffix}`")
  })

  it("migrates before any backend service or onboarding starts, without settings definitions in the old namespace", () => {
    const activation = read("src/extension.ts")
    expect(activation.indexOf("await migrateConfiguration(context)")).toBeLessThan(
      activation.indexOf("new KiloConnectionService("),
    )
    expect(activation.indexOf("await migrateConfiguration(context)")).toBeLessThan(
      activation.indexOf("startBharatcodeOnboarding(context"),
    )
    // Current settings are scalar/arrays, not mergeable object or language overrides.
    // Extending this schema requires extending the legacy resolver and migration tests.
    for (const schema of Object.values(pkg.contributes.configuration.properties) as Array<{
      type: string
      scope?: string
    }>) {
      expect(schema.type).not.toBe("object")
      expect(schema.scope).not.toBe("language-overridable")
    }
  })
})
