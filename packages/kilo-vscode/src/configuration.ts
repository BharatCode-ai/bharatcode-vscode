import * as vscode from "vscode"
import { copySettings, fallback, LEGACY_NAMESPACE, NAMESPACE } from "./namespace"

const MARKER = "bharatcode-agent.settingsMigration.v1"
const completed = new Set<string>()

/** Read old settings only until their scope has been safely copied. Writes are always isolated. */
export function configuration(
  section: string,
  scope?: vscode.Uri,
  host = vscode.workspace,
): vscode.WorkspaceConfiguration {
  const current = host.getConfiguration(section, scope)
  if (section !== NAMESPACE && !section.startsWith(`${NAMESPACE}.`)) return current
  const legacy = host.getConfiguration(LEGACY_NAMESPACE + section.slice(NAMESPACE.length), scope)
  const folder = scope && host.getWorkspaceFolder(scope)?.uri.toString()
  return fallback(current, legacy, [
    completed.has("global"),
    completed.has("workspace"),
    folder ? completed.has(folder) : false,
  ])
}

export function affectsConfiguration(event: vscode.ConfigurationChangeEvent, section: string): boolean {
  if (event.affectsConfiguration(section)) return true
  if (section !== NAMESPACE && !section.startsWith(`${NAMESPACE}.`)) return false
  return event.affectsConfiguration(LEGACY_NAMESPACE + section.slice(NAMESPACE.length))
}

/** Activation must await this before services read preferences or start the backend. */
export async function migrateConfiguration(context: vscode.ExtensionContext): Promise<void> {
  if (context.globalState.get<boolean>(MARKER)) completed.add("global")
  for (const scope of context.workspaceState.get<string[]>(MARKER, [])) completed.add(scope)
  const properties = context.extension.packageJSON.contributes.configuration.properties as Record<
    string,
    { scope?: string }
  >
  const scopes: Array<{
    id: string
    uri: vscode.Uri | undefined
    level: Parameters<typeof copySettings>[3]
    target: vscode.ConfigurationTarget
  }> = [
    { id: "global", uri: undefined, level: "globalValue", target: vscode.ConfigurationTarget.Global },
    ...(vscode.workspace.workspaceFolders?.length || vscode.workspace.workspaceFile
      ? [
          {
            id: "workspace",
            uri: undefined,
            level: "workspaceValue" as const,
            target: vscode.ConfigurationTarget.Workspace,
          },
        ]
      : []),
    ...(vscode.workspace.workspaceFolders ?? []).map((folder) => ({
      id: folder.uri.toString(),
      uri: folder.uri,
      level: "workspaceFolderValue" as const,
      target: vscode.ConfigurationTarget.WorkspaceFolder,
    })),
  ]
  for (const scope of scopes) {
    if (completed.has(scope.id)) continue
    const keys = Object.entries(properties)
      .filter(([key, schema]) => {
        if (!key.startsWith(`${NAMESPACE}.`)) return false
        if (scope.level === "globalValue") return true
        if (schema.scope === "application" || schema.scope === "machine") return false
        return (
          scope.level !== "workspaceFolderValue" ||
          schema.scope === "resource" ||
          schema.scope === "language-overridable"
        )
      })
      .map(([key]) => key.slice(NAMESPACE.length + 1))
    const success = await copySettings(
      vscode.workspace.getConfiguration(NAMESPACE, scope.uri),
      vscode.workspace.getConfiguration(LEGACY_NAMESPACE, scope.uri),
      keys,
      scope.level,
      scope.target,
      (key) => console.warn(`[BharatCode] Could not copy setting ${key}; keeping the legacy read fallback.`),
    )
    if (!success) continue
    // Mark only successful scopes: retries remain safe, and resetting a new setting
    // later cannot resurrect its old value. Existing state keys are never touched.
    if (scope.id === "global") await context.globalState.update(MARKER, true)
    else
      await context.workspaceState.update(
        MARKER,
        [...completed, scope.id].filter((id) => id !== "global"),
      )
    completed.add(scope.id)
  }
}
