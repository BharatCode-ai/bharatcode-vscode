import { configuration } from "./configuration"
import * as vscode from "vscode"

const CONFIG = "bharatcode-agent"
const KEY = "diff.renderMarkdown"

export function getDiffMarkdownRender(): boolean {
  return configuration(CONFIG).get<boolean>(KEY, false)
}

export async function setDiffMarkdownRender(value: boolean): Promise<void> {
  await configuration(CONFIG).update(KEY, value, vscode.ConfigurationTarget.Global)
}

export type DiffStyle = "unified" | "split"

/**
 * The user's remembered unified/split choice for diff viewers, read from the
 * effective configuration so a workspace override applies. Undefined until the
 * style is set once; callers then fall back to their own defaults (edit-tool
 * diffs open split, permission-dock expand opens unified).
 */
export function getUserDiffStyle(): DiffStyle | undefined {
  const value = configuration(CONFIG).get<DiffStyle>("diff.style")
  if (value === "unified" || value === "split") return value
  return undefined
}

export async function setUserDiffStyle(style: DiffStyle): Promise<void> {
  await configuration(CONFIG).update("diff.style", style, vscode.ConfigurationTarget.Global)
}
