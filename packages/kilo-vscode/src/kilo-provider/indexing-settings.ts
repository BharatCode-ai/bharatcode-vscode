import { configuration, affectsConfiguration } from "../configuration"
import * as vscode from "vscode"
import type { IndexingProject } from "../indexing-consent"

export function buildIndexingSettingsMessage(consent = false, projects: IndexingProject[] = [], projectId?: string) {
  const config = configuration("bharatcode-agent.indexing")
  return {
    type: "indexingSettingsLoaded" as const,
    settings: {
      showButtonWhenDisabled: config.get<boolean>("showButtonWhenDisabled", true),
      consent,
      projects,
      projectId,
    },
  }
}

export function watchIndexingConfig(post: () => void): vscode.Disposable {
  return vscode.workspace.onDidChangeConfiguration((event) => {
    if (affectsConfiguration(event, "bharatcode-agent.indexing")) {
      post()
    }
  })
}

export function validIndexingSetting(key: string, value: unknown) {
  return key === "showButtonWhenDisabled" && typeof value === "boolean"
}
