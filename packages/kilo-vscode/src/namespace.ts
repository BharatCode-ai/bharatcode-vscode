import type { ConfigurationTarget, WorkspaceConfiguration } from "vscode"

// Public VS Code registrations are independent of the extension/storage identity.
export const NAMESPACE = "bharatcode-agent"
export const LEGACY_NAMESPACE = "kilo-code.new"

const levels = ["globalValue", "workspaceValue", "workspaceFolderValue"] as const
type Level = (typeof levels)[number]

/** Only explicit old values are eligible; another extension's defaults are not ours. */
export function fallback(
  current: WorkspaceConfiguration,
  legacy: WorkspaceConfiguration,
  completed: readonly boolean[] = [],
): WorkspaceConfiguration {
  const inspect: WorkspaceConfiguration["inspect"] = <T>(key: string) => {
    const next = current.inspect?.<T>(key)
    const old = legacy.inspect?.<T>(key)
    if (!next && !old) return undefined
    const result = { ...next, key: next?.key ?? key }
    for (const [index, level] of levels.entries()) {
      if (result[level] === undefined && !completed[index] && old?.[level] !== undefined) result[level] = old[level]
    }
    return result
  }
  const get = <T>(key: string, value?: T): T | undefined => {
    const next = current.inspect?.<T>(key)
    const old = legacy.inspect?.<T>(key)
    for (const [index, level] of [...levels.entries()].reverse()) {
      // Let VS Code resolve the new value (including policy/default behavior).
      if (next?.[level] !== undefined) return current.get<T>(key) ?? value
      if (!completed[index] && old?.[level] !== undefined) return old[level]
    }
    return current.get<T>(key) ?? value
  }
  return {
    ...current,
    get: get as WorkspaceConfiguration["get"],
    inspect,
    has: (key) => get(key) !== undefined,
    update: (key, value, target, language) => current.update(key, value, target, language),
  }
}

/** Copy one scope, never deleting legacy values or overwriting explicit new values. */
export async function copySettings(
  current: WorkspaceConfiguration,
  legacy: WorkspaceConfiguration,
  keys: readonly string[],
  level: Level,
  target: ConfigurationTarget,
  failed: (key: string, error: unknown) => void,
): Promise<boolean> {
  let complete = true
  for (const key of keys) {
    const value = legacy.inspect(key)?.[level]
    if (value === undefined || current.inspect(key)?.[level] !== undefined) continue
    try {
      await current.update(key, value, target)
    } catch (error) {
      complete = false
      failed(key, error)
    }
  }
  return complete
}
