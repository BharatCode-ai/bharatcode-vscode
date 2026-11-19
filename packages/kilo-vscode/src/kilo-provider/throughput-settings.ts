import { configuration, affectsConfiguration } from "../configuration"
import * as vscode from "vscode"

type Post = (msg: unknown) => void

export function buildThroughputSettingMessage() {
  const config = configuration("bharatcode-agent")
  return {
    type: "throughputSettingLoaded" as const,
    visible: config.get<boolean>("showTokenThroughput", true),
  }
}

export function watchThroughputConfig(post: Post): vscode.Disposable {
  return vscode.workspace.onDidChangeConfiguration((event) => {
    if (affectsConfiguration(event, "bharatcode-agent.showTokenThroughput")) {
      post(buildThroughputSettingMessage())
    }
  })
}
