import { configuration } from "../../configuration"
import * as vscode from "vscode"

const INTEGRATED_BROWSER = "bharatcode-agent.agentManager.browser"
const BROWSER_AUTOMATION = "bharatcode-agent.browserAutomation"

/**
 * Read the Chrome preference for the Agent Manager Integrated Browser.
 *
 * The broker and the settings payload both use this so the toggle in Settings
 * and the effective value stay in sync. The Playwright setting under Web Tools
 * stays independent.
 */
export function integratedBrowserUseSystemChrome(): boolean {
  return configuration(INTEGRATED_BROWSER).get("useSystemChrome", true)
}

export function integratedBrowserFallback(remote = vscode.env.remoteName): boolean {
  return remote === "wsl" && configuration(INTEGRATED_BROWSER).inspect<boolean>("useSystemChrome")?.globalValue == null
}

/** Keep the settings payload and effective link destination in sync. */
export function integratedBrowserLinkDestination() {
  const value = configuration(INTEGRATED_BROWSER).get<string>("openLinksIn", "integrated")
  return value === "external" ? "external" : "integrated"
}

/**
 * Copy a user-level Chrome preference that was stored before this setting had
 * its own key.
 *
 * Runs once on activation and only when the current key has no explicit value,
 * so the old Playwright preference is preserved without aliasing the two
 * features afterwards. Workspace-scoped legacy values are left alone because
 * the current key is application-scoped and cannot store them.
 */
export async function migrateIntegratedBrowserUseSystemChrome(): Promise<void> {
  const browser = configuration(INTEGRATED_BROWSER)
  if (browser.inspect?.<boolean>("useSystemChrome")?.globalValue !== undefined) return
  const value = configuration(BROWSER_AUTOMATION).inspect?.<boolean>("useSystemChrome")?.globalValue
  if (value === undefined) return
  await browser.update("useSystemChrome", value, vscode.ConfigurationTarget.Global)
}
