import type { ProviderFailure } from "@kilocode/sdk/v2/client"

/** Only typed, sanitized failures enter the webview. Never display a response body or credential. */
export function catalogNotice(input: {
  ready: boolean
  connected: string[]
  failures: ProviderFailure[]
  hasModels: boolean
}) {
  const failure = input.failures.find((item) => item.providerID === "bharatcode")
  if (!input.ready) return { key: "bharatcode.catalog.loading", action: undefined }
  if (failure) {
    const signIn = failure.kind === "unauthorized" || failure.kind === "unauthenticated"
    return {
      key: `bharatcode.catalog.${failure.kind}`,
      vars: { status: failure.status ?? "" },
      action: signIn ? ("signIn" as const) : ("retry" as const),
    }
  }
  if (input.hasModels) return undefined
  return input.connected.includes("bharatcode")
    ? { key: "bharatcode.catalog.empty", action: "retry" as const }
    : { key: "bharatcode.catalog.signIn", action: "signIn" as const }
}
