import { configuration, affectsConfiguration } from "../configuration"
import * as vscode from "vscode"
import { integratedBrowserLinkDestination } from "../services/browser-automation/chrome-setting"

type Post = (msg: unknown) => void

export function buildChatSettingsMessage() {
  const config = configuration("bharatcode-agent.chat")
  return {
    type: "chatSettingsLoaded" as const,
    settings: {
      shiftTabCyclesVariant: config.get<boolean>("shiftTabCyclesVariant", true),
      browserAutomation: configuration("bharatcode-agent.experimental").get("browserAutomation", false),
      agentManagerBrowserOpenLinksIn: integratedBrowserLinkDestination(),
      workspaceTrusted: vscode.workspace.isTrusted,
    },
  }
}

export function buildTimelineSettingMessage() {
  const config = configuration("bharatcode-agent")
  return {
    type: "timelineSettingLoaded" as const,
    visible: config.get<boolean>("showTaskTimeline", true),
  }
}

export function watchChatConfig(post: Post): vscode.Disposable {
  return vscode.workspace.onDidChangeConfiguration((event) => {
    if (
      affectsConfiguration(event, "bharatcode-agent.chat") ||
      affectsConfiguration(event, "bharatcode-agent.experimental.browserAutomation") ||
      affectsConfiguration(event, "bharatcode-agent.agentManager.browser.openLinksIn")
    ) {
      post(buildChatSettingsMessage())
    }
    if (affectsConfiguration(event, "bharatcode-agent.showTaskTimeline")) {
      post(buildTimelineSettingMessage())
    }
  })
}

export function validChatSetting(key: string, value: unknown) {
  return key === "shiftTabCyclesVariant" && typeof value === "boolean"
}
