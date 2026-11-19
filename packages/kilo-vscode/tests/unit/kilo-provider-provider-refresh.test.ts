import { describe, expect, it } from "bun:test"

// vscode mock is provided by the shared preload (tests/setup/vscode-mock.ts)
const { KiloProvider } = await import("../../src/KiloProvider")

type State = "connecting" | "connected" | "disconnected" | "error"

type Internals = {
  webview: { postMessage: (message: unknown) => Promise<unknown> } | null
  providersRetry: boolean
  cachedConfigMessage: unknown
  cachedConfigDirectory: string | null
  retryInitialization: () => Promise<void>
  refreshConfig: (type: "configLoaded" | "configUpdated", dir?: string) => Promise<void>
  initializeConnection: () => Promise<void>
  fetchAndSendProviders: () => Promise<void>
  refreshBharatcodeCatalog: () => Promise<void>
  fetchAndSendIndexingStatus: (directory?: string, projectId?: string) => void
  flushPendingKiloModel: () => void
  checkConfigWarnings: (reason: string) => Promise<void>
  syncWebviewState: (reason: string) => Promise<void>
  flushPendingSessionRefresh: (reason: string) => Promise<void>
  recoverPendingPrompts: () => void
  fetchAndSendAgents: () => Promise<void>
  fetchAndSendSkills: () => Promise<void>
  fetchAndSendCommands: () => Promise<void>
  fetchAndSendConfig: () => Promise<void>
  fetchAndSendNotifications: () => Promise<void>
  seedSessionStatusMap: () => Promise<void>
  sendNotificationSettings: () => void
  startStatsPolling: () => void
}

function connection(online = true, custom?: unknown) {
  let listener: ((state: State, error?: Error) => void) | undefined
  const client = custom ?? { kilo: { profile: async () => ({ data: null }) } }
  return {
    emitState(next: State) {
      if (!listener) throw new Error("expected a connection state subscription")
      listener(next)
    },
    connect: async () => {},
    getClient: () => {
      if (!online) throw new Error("Not connected — call connect() first")
      return client as never
    },
    onEventFiltered: () => () => undefined,
    onStateChange: (next: typeof listener) => {
      listener = next
      return () => undefined
    },
    onNotificationDismissed: () => () => undefined,
    onClearPendingPrompts: () => () => undefined,
    onLanguageChanged: () => () => undefined,
    onProfileChanged: () => () => undefined,
    onFavoritesChanged: () => () => undefined,
    onModelSelectorExpandedChanged: () => () => undefined,
    registerDirectoryProvider: () => () => undefined,
    unregisterVisible: () => undefined,
    unregisterAttached: () => undefined,
    getServerInfo: () => ({ port: 12345 }),
    getServerConfig: () => ({ baseUrl: "http://127.0.0.1:12345", password: "test" }),
    getConnectionState: () => "connected" as const,
    getConnectionError: () => null,
  }
}

function provider(service: ReturnType<typeof connection>, root = () => "/repo") {
  return new KiloProvider({} as never, service as never, undefined, {
    rootDirectory: root,
  }) as unknown as Internals
}

function stub(internal: Internals) {
  internal.webview = { postMessage: async () => true }
  internal.fetchAndSendIndexingStatus = () => {}
  internal.flushPendingKiloModel = () => {}
  internal.checkConfigWarnings = async () => {}
  internal.syncWebviewState = async () => {}
  internal.flushPendingSessionRefresh = async () => {}
  internal.recoverPendingPrompts = () => {}
  internal.fetchAndSendAgents = async () => {}
  internal.fetchAndSendSkills = async () => {}
  internal.fetchAndSendCommands = async () => {}
  internal.fetchAndSendConfig = async () => {}
  internal.fetchAndSendNotifications = async () => {}
  internal.seedSessionStatusMap = async () => {}
  internal.sendNotificationSettings = () => {}
  internal.startStatsPolling = () => {}
}

describe("KiloProvider providers on reconnect", () => {
  it("coalesces explicit catalog retries without disposing sessions or replaying tools", async () => {
    const gate = Promise.withResolvers<void>()
    const messages: unknown[] = []
    let refreshes = 0
    let lists = 0
    let disposals = 0
    let prompts = 0
    const internal = provider(
      connection(true, {
        provider: {
          refresh: async (input: unknown) => {
            expect(input).toEqual({ providerID: "bharatcode", directory: "/repo" })
            refreshes++
            await gate.promise
            return { data: true }
          },
          list: async () => {
            lists++
            return {
              data: {
                all: [{ id: "bharatcode", models: { glm: { id: "glm" } } }],
                connected: ["bharatcode"],
                default: { bharatcode: "glm" },
              },
            }
          },
        },
        kilo: { authStatus: async () => ({ data: undefined }) },
        global: {
          dispose: async () => {
            disposals++
          },
        },
        session: {
          prompt: async () => {
            prompts++
          },
        },
      }),
    )
    stub(internal)
    internal.webview = { postMessage: async (message) => messages.push(message) }
    const first = internal.refreshBharatcodeCatalog()
    const second = internal.refreshBharatcodeCatalog()
    expect(first).toBe(second)
    expect(refreshes).toBe(1)
    gate.resolve()
    await first
    expect(lists).toBe(1)
    expect(disposals).toBe(0)
    expect(prompts).toBe(0)
    expect(messages).toContainEqual({ type: "providersRefreshing" })
    expect(messages).toContainEqual(
      expect.objectContaining({ type: "providersLoaded", ready: false, connected: ["bharatcode"] }),
    )
  })

  it("reports a sanitized retry error and releases the retry lock", async () => {
    const messages: unknown[] = []
    let attempts = 0
    const internal = provider(
      connection(true, {
        provider: {
          refresh: async () => {
            attempts++
            throw new Error("private-response-body")
          },
        },
      }),
    )
    stub(internal)
    internal.webview = { postMessage: async (message) => messages.push(message) }
    await internal.refreshBharatcodeCatalog()
    await internal.refreshBharatcodeCatalog()
    expect(attempts).toBe(2)
    expect(messages).toContainEqual({
      type: "providersLoadFailed",
      failure: { providerID: "bharatcode", kind: "network" },
    })
    expect(JSON.stringify(messages)).not.toContain("private-response-body")
  })

  for (const change of ["project", "directory", "client", "generation"] as const) {
    it.each([true, false])(
      `ignores a stale catalog retry after a ${change} change (rejected: %s)`,
      async (rejected) => {
        const gate = Promise.withResolvers<void>()
        let directory = "/before"
        const requests: string[] = []
        const messages: unknown[] = []
        const service = connection(true, {
          provider: {
            refresh: async () => gate.promise,
            list: async (input: { directory: string }) => {
              requests.push(input.directory)
              return { data: { all: [], connected: [], default: {} } }
            },
          },
          kilo: { authStatus: async () => ({ data: { authenticated: false } }) },
        })
        const internal = provider(service, () => directory)
        stub(internal)
        internal.webview = { postMessage: async (message) => messages.push(message) }
        const pending = internal.refreshBharatcodeCatalog()
        if (change === "project" || change === "directory") directory = "/after"
        if (change === "project" || change === "generation") await internal.fetchAndSendProviders()
        if (change === "client") service.getClient = () => ({}) as never
        const published = [...messages]
        const fetched = [...requests]
        if (rejected) gate.reject(new Error("stale private error"))
        else gate.resolve()
        await pending

        // Neither an old error nor an old success may replace/refetch the current catalog.
        expect(messages).toEqual(published)
        expect(requests).toEqual(fetched)
        if (change === "project") {
          expect(requests).toEqual(["/after"])
          expect(messages.at(-1)).toEqual(expect.objectContaining({ type: "providersLoaded" }))
        }
      },
    )
  }

  it("lets the active project retry while an obsolete retry is still pending", async () => {
    const before = Promise.withResolvers<void>()
    const after = Promise.withResolvers<void>()
    let directory = "/before"
    const requests: string[] = []
    const messages: unknown[] = []
    const internal = provider(
      connection(true, {
        provider: {
          refresh: async (input: { directory: string }) => {
            requests.push(input.directory)
            await (input.directory === "/before" ? before.promise : after.promise)
          },
          list: async () => ({ data: { all: [], connected: [], default: {} } }),
        },
        kilo: { authStatus: async () => ({ data: { authenticated: false } }) },
      }),
      () => directory,
    )
    stub(internal)
    internal.webview = { postMessage: async (message) => messages.push(message) }
    const stale = internal.refreshBharatcodeCatalog()
    directory = "/after"
    const active = internal.refreshBharatcodeCatalog()
    expect(active).not.toBe(stale)
    expect(requests).toEqual(["/before", "/after"])
    before.reject(new Error("obsolete project"))
    await stale
    expect(messages).not.toContainEqual(expect.objectContaining({ type: "providersLoadFailed" }))
    expect(internal.refreshBharatcodeCatalog()).toBe(active)
    after.resolve()
    await active
    expect(messages.at(-1)).toEqual(expect.objectContaining({ type: "providersLoaded" }))
    expect(requests).toHaveLength(2)
  })

  it("keeps duplicate retries coalesced through the follow-up provider list", async () => {
    const started = Promise.withResolvers<void>()
    const gate = Promise.withResolvers<void>()
    let refreshes = 0
    const internal = provider(
      connection(true, {
        provider: {
          refresh: async () => {
            refreshes++
          },
          list: async () => {
            started.resolve()
            await gate.promise
            return { data: { all: [], connected: [], default: {} } }
          },
        },
        kilo: { authStatus: async () => ({ data: { authenticated: false } }) },
      }),
    )
    stub(internal)
    const pending = internal.refreshBharatcodeCatalog()
    await started.promise
    expect(internal.refreshBharatcodeCatalog()).toBe(pending)
    expect(refreshes).toBe(1)
    gate.resolve()
    await pending
  })

  it("recovers providers against the selected project without reconnecting", async () => {
    let dir = "/unavailable"
    const requests: string[] = []
    const messages: unknown[] = []
    const internal = provider(
      connection(true, {
        kilo: { authStatus: async () => ({ data: { authenticated: false } }) },
        provider: {
          list: async (input: { directory: string }) => {
            requests.push(input.directory)
            if (input.directory === "/unavailable") throw new Error("PermissionDenied")
            return { data: { all: [], connected: [], default: {} } }
          },
        },
      }),
      () => dir,
    )
    stub(internal)
    internal.webview = { postMessage: async (message) => messages.push(message) }
    const configs: string[] = []
    internal.fetchAndSendConfig = async () => {
      configs.push(dir)
      internal.cachedConfigMessage = { type: "configLoaded", config: {} }
      internal.cachedConfigDirectory = dir
    }
    await internal.fetchAndSendProviders()
    expect(internal.providersRetry).toBe(true)

    dir = "/healthy"
    await internal.retryInitialization()

    expect(requests).toEqual(["/unavailable", "/healthy"])
    expect(configs).toEqual(["/healthy"])
    expect(internal.providersRetry).toBe(false)
    expect(messages).toContainEqual(expect.objectContaining({ type: "providersLoaded", ready: true }))

    await internal.retryInitialization()
    expect(requests).toHaveLength(2)
    expect(configs).toHaveLength(1)
  })

  it("drops a config snapshot that resolves for a previous project directory", async () => {
    let dir = "/project-a"
    const messages: unknown[] = []
    const internal = provider(
      connection(true, {
        config: {
          get: async () => ({ data: {} }),
          overlay: async () => ({ data: { collections: [] } }),
        },
        global: { config: { get: async () => ({ data: {} }) } },
        experimental: { capabilities: { get: async () => ({ data: { backgroundSubagents: false } }) } },
      }),
      () => dir,
    )
    stub(internal)
    internal.webview = { postMessage: async (message) => messages.push(message) }

    await internal.refreshConfig("configLoaded", "/project-a")
    expect(messages).toContainEqual(expect.objectContaining({ type: "configLoaded" }))
    const published = messages.length

    dir = "/project-b"
    await internal.refreshConfig("configLoaded", "/project-a")

    expect(messages).toHaveLength(published)
  })

  it("marks a retry when providers are fetched without a client", async () => {
    const internal = provider(connection(false))
    stub(internal)

    await internal.fetchAndSendProviders()

    expect(internal.providersRetry).toBe(true)
  })

  it("marks a retry when the provider fetch rejects with a client", async () => {
    const reject = {
      kilo: { authStatus: async () => ({ data: undefined }) },
      provider: {
        list: async () => {
          throw new Error("backend gone")
        },
      },
    }
    const internal = provider(connection(true, reject))
    stub(internal)

    await internal.fetchAndSendProviders()

    expect(internal.providersRetry).toBe(true)
  })

  it("fetches providers on connect when a previous fetch had no client", async () => {
    const service = connection()
    const internal = provider(service)
    let providers = 0
    stub(internal)
    internal.fetchAndSendProviders = async () => {
      providers++
    }
    await internal.initializeConnection()
    internal.providersRetry = true
    const before = providers

    service.emitState("connected")
    await Bun.sleep(0)

    expect(providers).toBe(before + 1)
  })

  it("does not refetch providers on connect when none are pending", async () => {
    const service = connection()
    const internal = provider(service)
    let providers = 0
    stub(internal)
    internal.fetchAndSendProviders = async () => {
      providers++
    }
    await internal.initializeConnection()
    const before = providers

    service.emitState("connected")
    await Bun.sleep(0)

    expect(providers).toBe(before)
  })
})
