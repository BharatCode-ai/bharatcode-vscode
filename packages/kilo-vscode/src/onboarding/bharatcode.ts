// Keep the existing command ID so older keybindings and the welcome view still work.
import * as vscode from "vscode"
import type { KiloClient } from "@kilocode/sdk/v2/client"

const SET_KEY_COMMAND = "kilo-code.new.setBharatcodeKey"
const CONNECTED_FLAG = "bharatcode.apiKeySet"
const SIGN_IN = "Sign in with BharatCode"

function explain(error: unknown) {
  const status = (error as { status?: number } | null)?.status
  if (status === 409 || /already in use|EADDRINUSE/i.test(String((error as Error)?.message)))
    return "Another BharatCode sign-in is using the callback port. Finish that sign-in and try again."
  if (status === 429) return "Too many sign-in attempts. Wait a minute and try again."
  return "Sign-in didn’t finish. Run BharatCode: Sign In to try again."
}

export function start(ctx: vscode.ExtensionContext, client: () => Promise<KiloClient>) {
  let pending: Promise<void> | undefined
  const folder = () => vscode.workspace.workspaceFolders?.[0]?.uri.fsPath

  async function signIn() {
    const directory = folder()
    if (!directory) {
      void vscode.window.showInformationMessage("Open a project folder, then run BharatCode: Sign In.")
      return
    }
    if (vscode.env.remoteName) {
      // The registered OAuth callback is a loopback URL; never replace it with a public tunnel.
      const forwarded = await vscode.env.asExternalUri(vscode.Uri.parse("http://127.0.0.1:27182/callback"))
      const local = new URL(forwarded.toString())
      if (
        local.protocol !== "http:" ||
        !["localhost", "127.0.0.1"].includes(local.hostname) ||
        local.port !== "27182"
      ) {
        void vscode.window.showErrorMessage(
          "Forward port 27182 to local port 27182 in VS Code’s Ports view, or sign in from a local project window.",
        )
        return
      }
    }
    const c = await client()
    const params = { providerID: "bharatcode", method: 0, directory }
    const { data } = await c.provider.oauth.authorize(params, { throwOnError: true })
    const url = data?.url && new URL(data.url)
    if (
      !url ||
      url.origin !== "https://auth.bharatcode.ai" ||
      url.pathname !== "/auth/v1/oauth/authorize" ||
      url.username ||
      url.password ||
      url.hash
    )
      throw new Error("Unexpected authorization URL")
    if (!(await vscode.env.openExternal(vscode.Uri.parse(url.href)))) throw new Error("Browser unavailable")
    await c.provider.oauth.callback(params, { throwOnError: true })
    await ctx.globalState.update(CONNECTED_FLAG, true).then(undefined, () => {})
    await c.global.dispose().catch(() => {})
    void vscode.commands.executeCommand("kilo-code.SidebarProvider.focus")
    void vscode.window.showInformationMessage("BharatCode connected.")
  }

  function connect() {
    // A click from the sidebar and the command palette share one PKCE exchange.
    return (pending ??= signIn()
      .catch((error: unknown) => {
        void vscode.window.showErrorMessage(explain(error))
      })
      .finally(() => {
        pending = undefined
      }))
  }

  async function welcome() {
    const directory = folder()
    if (!directory) return
    try {
      const c = await client()
      const { data } = await c.provider.list({ directory }, { throwOnError: true })
      if (data.connected.includes("bharatcode")) return
    } catch {
      if (ctx.globalState.get<boolean>(CONNECTED_FLAG)) return
    }
    // Opening an editor must not launch a browser without a user gesture.
    if (
      (await vscode.window.showInformationMessage("Connect BharatCode to start your first chat.", SIGN_IN)) === SIGN_IN
    )
      await connect()
  }

  ctx.subscriptions.push(vscode.commands.registerCommand(SET_KEY_COMMAND, connect))
  if (folder()) void welcome()
  else {
    const listener = vscode.workspace.onDidChangeWorkspaceFolders(() => {
      if (!folder()) return
      listener.dispose()
      void welcome()
    })
    ctx.subscriptions.push(listener)
  }
}
