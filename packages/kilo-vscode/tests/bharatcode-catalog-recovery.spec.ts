import { expect, test } from "@playwright/test"

test("an empty catalog has an actionable error and recovers without reloading the chat", async ({ page }, testInfo) => {
  test.setTimeout(180_000)
  await page.addInitScript(() => {
    ;(window as any).__catalogRefreshes = 0
    ;(window as any).acquireVsCodeApi = () => ({
      getState: () => undefined,
      setState: () => {},
      postMessage: (message: any) => {
        if (message.type !== "requestProviders") return
        const send = (data: unknown) => window.postMessage(data, window.location.origin)
        if (!message.refresh) {
          setTimeout(
            () =>
              send({ type: "providersLoadFailed", failure: { providerID: "bharatcode", kind: "http", status: 503 } }),
            20,
          )
          return
        }
        ;(window as any).__catalogRefreshes++
        send({ type: "providersRefreshing" })
        setTimeout(
          () =>
            send({
              type: "providersLoaded",
              providers: {
                bharatcode: {
                  id: "bharatcode",
                  name: "BharatCode",
                  models: { "glm-5.3-flash": { id: "glm-5.3-flash", name: "GLM 5.3 Flash" } },
                },
              },
              connected: ["bharatcode"],
              defaults: { bharatcode: "glm-5.3-flash" },
              defaultSelection: { providerID: "bharatcode", modelID: "glm-5.3-flash" },
              authMethods: {},
              authStates: { bharatcode: "oauth" },
              ready: true,
              failures: [],
            }),
          100,
        )
      },
    })
  })
  await page.goto(
    "/iframe.html?id=shared--model-selector-bharatcode-recovery&viewMode=story&globals=theme:kilo-vscode;vscodeTheme:dark-modern",
  )
  await page.waitForSelector("#storybook-root button", { timeout: 120_000 })
  const trigger = page.getByRole("button", { name: "Select model: Models unavailable" })
  await expect(trigger).toBeEnabled()
  await trigger.click()
  await expect(page.getByRole("status")).toContainText("HTTP 503")
  await page.screenshot({ path: testInfo.outputPath("catalog-error.png") })
  const retry = page.getByRole("button", { name: "Retry model catalog" })
  await retry.focus()
  await page.keyboard.press("Enter")
  await expect(page.getByRole("treeitem", { name: /GLM 5.3 Flash/ })).toBeVisible()
  expect(await page.evaluate(() => (window as any).__catalogRefreshes)).toBe(1)
  await expect(page.getByRole("button", { name: "Retry model catalog" })).toHaveCount(0)
  await expect(page.locator(".model-selector-notice")).toHaveCount(0)

  await page.evaluate(() =>
    window.postMessage(
      {
        type: "providersLoadFailed",
        failure: { providerID: "bharatcode", kind: "network" },
      },
      window.location.origin,
    ),
  )
  await expect(page.getByRole("treeitem", { name: /GLM 5.3 Flash/ })).toBeVisible()
  await expect(page.getByRole("status")).toContainText("Your chats and sign-in are unchanged")
  await page.getByRole("button", { name: "Retry model catalog" }).focus()
  await page.keyboard.press("Enter")
  await expect.poll(() => page.evaluate(() => (window as any).__catalogRefreshes)).toBe(2)
  await expect(page.getByRole("button", { name: "Retry model catalog" })).toHaveCount(0)
  await expect(page.getByRole("treeitem", { name: /GLM 5.3 Flash/ })).toBeVisible()
  await expect(page.locator(".model-selector-notice")).toHaveCount(0)
  await page.screenshot({ path: testInfo.outputPath("catalog-recovered.png") })
})
