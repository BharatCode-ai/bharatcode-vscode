import { describe, expect, it } from "bun:test"
import path from "node:path"
import { Project, SyntaxKind } from "ts-morph"

const root = path.resolve(import.meta.dir, "../..")
const project = new Project({ useInMemoryFileSystem: true })
const source = project.createSourceFile(
  "provider.tsx",
  await Bun.file(path.join(root, "webview-ui/src/context/provider.tsx")).text(),
)
const body = source
  .getVariableDeclarationOrThrow("ProviderProvider")
  .getInitializerIfKindOrThrow(SyntaxKind.ArrowFunction)
  .getBody()
  .asKindOrThrow(SyntaxKind.Block)
// Exercise the real context subscriptions and Solid signals without loading the JSX renderer graph.
const setup = new Bun.Transpiler({ loader: "ts" }).transformSync(`
  function provider() {
    ${body
      .getStatements()
      .filter((statement) => !statement.isKind(SyntaxKind.ReturnStatement))
      .map((statement) => statement.getText())
      .join("\n")}
    return value
  }
`)

function check(code: string) {
  const script = `
    import assert from "node:assert/strict"
    import { dirname, join } from "node:path"
    const solid = join(dirname(require.resolve("solid-js")), "solid.js")
    const { batch, createRoot, createSignal, createMemo, onCleanup } = await import(solid)
    const { flattenModels, findModel: _findModel, isModelValid: isValid } = await import("./webview-ui/src/context/provider-utils.ts")
    const { KILO_AUTO } = await import("./src/shared/provider-model.ts")
    const { catalogNotice } = await import("./src/shared/bharatcode-catalog.ts")
    const listeners = new Set()
    const requests = []
    const useVSCode = () => ({
      onMessage(callback) { listeners.add(callback); return () => listeners.delete(callback) },
      postMessage(message) { requests.push(message) },
    })
    ${setup}
    const state = createRoot((dispose) => ({ ...provider(), dispose }))
    const post = (message) => { for (const callback of [...listeners]) callback(message) }
    const loaded = (overrides = {}) => post({
      type: "providersLoaded", providers: {}, connected: [], defaults: {}, ready: false,
      defaultSelection: KILO_AUTO, authMethods: {}, authStates: {}, ...overrides,
    })
    const notice = () => catalogNotice({
      ready: state.catalogReady(), connected: state.connected(), failures: state.failures(),
      hasModels: state.models().length > 0,
    })
    try { ${code} } finally { state.dispose() }
    assert.equal(listeners.size, 0)
  `
  const child = Bun.spawnSync([process.execPath, "--conditions=browser", "-e", script], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
    windowsHide: true,
  })
  expect(child.exitCode, child.stdout.toString() + child.stderr.toString()).toBe(0)
}

describe("provider catalog completion", () => {
  it("settles a signed-out empty catalog even when Kilo auth is unavailable", () => {
    check(`
      assert.equal(state.ready(), false)
      assert.equal(state.catalogReady(), false)
      assert.equal(notice().key, "bharatcode.catalog.loading")
      assert.deepEqual(requests, [{ type: "requestProviders" }])
      loaded()
      assert.equal(state.ready(), false)
      assert.equal(state.organizationId(), undefined)
      assert.equal(state.catalogReady(), true)
      assert.deepEqual(notice(), { key: "bharatcode.catalog.signIn", action: "signIn" })
    `)
  })

  it("settles an initial catalog failure without inventing Kilo auth readiness", () => {
    check(`
      post({ type: "providersLoadFailed", failure: { providerID: "bharatcode", kind: "network" } })
      assert.equal(state.ready(), false)
      assert.equal(state.organizationId(), undefined)
      assert.equal(state.catalogReady(), true)
      assert.equal(notice().key, "bharatcode.catalog.network")
      assert.equal(notice().action, "retry")
      post({ type: "providersRefreshing" })
      assert.equal(state.catalogReady(), false)
      assert.equal(state.ready(), false)
      assert.equal(notice().key, "bharatcode.catalog.loading")
      loaded()
      assert.equal(state.catalogReady(), true)
      assert.deepEqual(state.failures(), [])
      assert.equal(notice().action, "signIn")
    `)
  })

  it("preserves auth, selection, and usable models through retry failure and recovery", () => {
    check(`
      const selection = { providerID: "bharatcode", modelID: "glm" }
      const providers = { bharatcode: { id: "bharatcode", name: "BharatCode", models: { glm: { id: "glm", name: "GLM" } } } }
      loaded({ ready: true, organizationId: "org", providers, connected: ["bharatcode"],
        defaults: { bharatcode: "glm" }, defaultSelection: selection, authStates: { bharatcode: "oauth" },
        failures: [{ providerID: "other", kind: "network" }] })
      const models = state.models()
      post({ type: "providersRefreshing" })
      assert.equal(state.catalogReady(), false)
      assert.equal(state.ready(), true)
      assert.equal(state.organizationId(), "org")
      assert.equal(state.models(), models)
      assert.equal(notice().key, "bharatcode.catalog.loading")
      for (const kind of ["network", "unauthorized"]) {
        post({ type: "providersLoadFailed", failure: { providerID: "bharatcode", kind } })
        assert.equal(state.catalogReady(), true)
        assert.equal(state.ready(), true)
        assert.equal(state.organizationId(), "org")
        assert.equal(state.models(), models)
        assert.deepEqual(state.defaultSelection(), selection)
        assert.deepEqual(state.defaults(), { bharatcode: "glm" })
        assert.deepEqual(state.authStates(), { bharatcode: "oauth" })
        assert.deepEqual(state.failures(), [{ providerID: "other", kind: "network" }, { providerID: "bharatcode", kind }])
      }
      assert.equal(notice().action, "signIn")
      loaded({ providers, connected: ["bharatcode"], defaultSelection: selection })
      assert.equal(state.catalogReady(), true)
      assert.equal(state.ready(), false)
      assert.deepEqual(state.failures(), [])
      assert.equal(notice(), undefined)
    `)
  })

  it("resets catalog completion and auth readiness for a new provider load", () => {
    check(`
      loaded({ ready: true, organizationId: "org" })
      assert.equal(state.catalogReady(), true)
      assert.equal(state.ready(), true)
      post({ type: "providersLoading" })
      assert.equal(state.catalogReady(), false)
      assert.equal(state.ready(), false)
      assert.equal(state.organizationId(), undefined)
      assert.equal(notice().key, "bharatcode.catalog.loading")
      loaded()
      assert.equal(state.catalogReady(), true)
      assert.equal(state.ready(), false)
    `)
  })
})
