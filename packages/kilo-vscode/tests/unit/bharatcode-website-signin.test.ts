import { afterEach, describe, expect, mock, spyOn, test } from "bun:test"
import * as vscode from "vscode"
import { start } from "../../src/onboarding/bharatcode"

const website = "https://auth.bharatcode.ai/auth/v1/oauth/authorize"
const tick = () => new Promise<void>((resolve) => setImmediate(resolve))

function fixture(input: { connected?: boolean; open?: boolean; url?: string; fail?: boolean } = {}) {
  const information = spyOn(vscode.window, "showInformationMessage").mockImplementation(async () => undefined)
  const errors = spyOn(vscode.window, "showErrorMessage").mockImplementation(async () => undefined)
  const browser = spyOn(vscode.env, "openExternal").mockResolvedValue(input.open ?? true)
  const authorize = mock(async () => ({ data: { url: input.url ?? website } }))
  const callback = mock(async () => {
    if (input.fail) throw new Error("cancelled")
  })
  const update = mock(async () => {})
  let click!: () => Promise<void>
  spyOn(vscode.commands, "registerCommand").mockImplementation((_id, cmd) => {
    click = cmd
    return { dispose() {} }
  })
  const c = {
    provider: {
      list: async () => ({ data: { connected: input.connected ? ["bharatcode"] : [] } }),
      oauth: { authorize, callback },
    },
    global: { dispose: async () => {} },
  }
  start({ subscriptions: [], globalState: { get: () => false, update } } as never, async () => c as never)
  return { click: () => click(), information, errors, browser, authorize, callback, update }
}

afterEach(() => mock.restore())
describe("BharatCode website sign-in", () => {
  test("a fresh installation invites sign-in without opening a browser or making a model call", async () => {
    const f = fixture()
    await tick()
    expect(f.information).toHaveBeenCalledWith(
      "Connect BharatCode to start your first chat.",
      "Sign in with BharatCode",
    )
    expect(f.browser).not.toHaveBeenCalled()
    expect(f.update).not.toHaveBeenCalled()
  })
  test("an existing connection is not prompted to replace its credential", async () => {
    const f = fixture({ connected: true })
    await tick()
    expect(f.information).not.toHaveBeenCalled()
    expect(f.authorize).not.toHaveBeenCalled()
  })
  test("two explicit clicks complete one browser exchange, then remember the connection", async () => {
    const f = fixture()
    await tick()
    await Promise.all([f.click(), f.click()])
    expect(f.authorize).toHaveBeenCalledTimes(1)
    expect(f.browser).toHaveBeenCalledTimes(1)
    expect(f.callback).toHaveBeenCalledTimes(1)
    expect(f.update).toHaveBeenCalledWith("bharatcode.apiKeySet", true)
  })
  test("a denied exchange leaves setup incomplete and can be retried", async () => {
    const config = { fail: true }
    const f = fixture(config)
    await tick()
    await f.click()
    expect(f.errors).toHaveBeenCalledTimes(1)
    expect(f.update).not.toHaveBeenCalled()
    config.fail = false
    await f.click()
    expect(f.update).toHaveBeenCalledTimes(1)
  })
  test("a refused browser launch never reports a successful sign-in", async () => {
    const f = fixture({ open: false })
    await tick()
    await f.click()
    expect(f.callback).not.toHaveBeenCalled()
    expect(f.update).not.toHaveBeenCalled()
    expect(f.errors).toHaveBeenCalledTimes(1)
  })
  test("a non-BharatCode authorization destination is not opened", async () => {
    const f = fixture({ url: "https://example.invalid/login" })
    await tick()
    await f.click()
    expect(f.browser).not.toHaveBeenCalled()
    expect(f.callback).not.toHaveBeenCalled()
  })
})
