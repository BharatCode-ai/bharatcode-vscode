import { expect, setSystemTime } from "bun:test"
import { Deferred, Effect, Fiber, Layer, Ref } from "effect"
import * as TestClock from "effect/testing/TestClock"
import { FetchHttpClient, HttpClient, HttpClientResponse } from "effect/unstable/http"
import * as Core from "@opencode-ai/core/models-dev"
import * as Refresh from "@opencode-ai/core/kilocode/models-refresh"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { Auth } from "../../../src/auth"
import { Config } from "../../../src/config/config"
import { InstanceState } from "../../../src/effect/instance-state"
import { Plugin } from "../../../src/plugin"
import { ModelCache } from "../../../src/provider/model-cache"
import { ModelsDev } from "../../../src/provider/models"
import { Provider } from "../../../src/provider/provider"
import { refresh } from "../../../src/kilocode/provider/catalog-refresh"
import { TestConfig } from "../../fixture/config"
import { provideInstance, testInstanceStoreLayer } from "../../fixture/fixture"
import { testEffect } from "../../lib/effect"

const it = testEffect(testInstanceStoreLayer)
const access = Layer.mock(Auth.Service)({ get: () => Effect.succeed(undefined), all: () => Effect.succeed({}) })
const data = (id = "available") => ({
  data: [{ id, display_name: id, context_window: 262144, max_output_tokens: 32000, metadata: { reasoning: true } }],
})

function layer(http = FetchHttpClient.layer, cfg = TestConfig.layer(), auth = access) {
  return Layer.fresh(ModelCache.layer).pipe(
    Layer.provide(http),
    Layer.provide(cfg),
    Layer.provide(auth),
    Layer.provide(ModelCache.kiloModelsLayer),
  )
}

function transport(respond: () => Response) {
  return Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) => Effect.sync(() => HttpClientResponse.fromWeb(request, respond()))),
  )
}

function server(respond: (request: Request) => Response | Promise<Response>) {
  return Effect.acquireRelease(
    Effect.sync(() => Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: respond })),
    (server) => Effect.promise(() => server.stop(true)),
  )
}

it.live("uses local HTTP and retains last-good models and safe failure metadata", () =>
  Effect.gen(function* () {
    let status = 200
    const requests: string[] = []
    const upstream = yield* server((request) => {
      requests.push(new URL(request.url).pathname)
      return Response.json(status === 200 ? data() : { error: "must-not-leak-secret" }, { status })
    })
    yield* ModelCache.Service.use((cache) =>
      Effect.gen(function* () {
        const options = { baseURL: `${upstream.url}v1`, apiKey: "synthetic-key" }
        const good = yield* cache.fetch("bharatcode", options)
        expect(good.available).toMatchObject({ name: "available", limit: { context: 262144, output: 32000 } })
        status = 503
        expect(yield* cache.refresh("bharatcode", options)).toEqual(good)
        expect(yield* cache.get("bharatcode")).toEqual(good)
        expect(yield* cache.getFailure("bharatcode")).toEqual({ kind: "http", status: 503 })
        expect(yield* cache.failedProviders()).toEqual(["bharatcode"])
        status = 200
        expect(yield* cache.refresh("bharatcode", options)).toEqual(good)
        expect(yield* cache.getFailure("bharatcode")).toBeUndefined()
        expect(requests).toEqual(["/v1/models", "/v1/models", "/v1/models"])
      }),
    ).pipe(Effect.provide(layer()))
  }),
)

it.live("coalesces simultaneous manual refreshes through the real HTTP client", () =>
  Effect.gen(function* () {
    const started = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    let calls = 0
    const upstream = yield* server(async () => {
      calls++
      started.resolve()
      await release.promise
      return Response.json(data())
    })
    const cfg = TestConfig.layer({
      get: () => Effect.succeed({ provider: { bharatcode: { options: { baseURL: String(upstream.url) } } } }),
    })
    yield* ModelCache.Service.use((cache) =>
      Effect.gen(function* () {
        const first = yield* refresh(cache, {}, "bharatcode").pipe(Effect.forkChild)
        yield* Effect.promise(() => started.promise)
        const second = yield* refresh(cache, {}, "bharatcode").pipe(Effect.forkChild)
        yield* Effect.yieldNow
        release.resolve()
        expect(yield* Fiber.join(first)).toBe(true)
        expect(yield* Fiber.join(second)).toBe(true)
        expect(calls).toBe(1)
        expect(yield* refresh(cache, {}, "unknown")).toBe(false)
        expect(yield* refresh(cache, { disabled_providers: ["bharatcode"] }, "bharatcode")).toBe(false)
        expect(calls).toBe(1)
      }),
    ).pipe(Effect.provide(layer(FetchHttpClient.layer, cfg)))
  }),
)

it.live("coalesces a second refresh while the first result is validating its account", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>()
    const release = yield* Deferred.make<void>()
    let resolutions = 0
    let calls = 0
    const cfg = TestConfig.layer({
      get: () =>
        Effect.gen(function* () {
          resolutions++
          if (resolutions === 2) {
            yield* Deferred.succeed(started, undefined)
            yield* Deferred.await(release)
          }
          return {}
        }),
    })
    yield* ModelCache.Service.use((cache) =>
      Effect.gen(function* () {
        const first = yield* cache.refresh("bharatcode").pipe(Effect.forkChild)
        yield* Deferred.await(started)
        const second = yield* cache.refresh("bharatcode").pipe(Effect.forkChild)
        yield* Effect.yieldNow
        yield* Deferred.succeed(release, undefined)
        expect(Object.keys(yield* Fiber.join(first))).toEqual(["available"])
        expect(Object.keys(yield* Fiber.join(second))).toEqual(["available"])
        expect(calls).toBe(1)
      }),
    ).pipe(
      Effect.provide(
        layer(
          transport(() => {
            calls++
            return Response.json(data())
          }),
          cfg,
        ),
      ),
    )
  }),
)

for (const status of [401, 403, 404]) {
  it.effect(`does not automatically retry HTTP ${status}`, () =>
    Effect.gen(function* () {
      let calls = 0
      yield* ModelCache.Service.use((cache) =>
        Effect.gen(function* () {
          yield* cache.fetch("bharatcode")
          yield* TestClock.adjust("1 hour")
          expect(calls).toBe(1)
          expect(yield* cache.getFailure("bharatcode")).toEqual({
            kind: status === 404 ? "http" : "unauthorized",
            status,
          })
        }),
      ).pipe(
        Effect.provide(
          layer(
            transport(() => {
              calls++
              return new Response("private upstream response", { status })
            }),
          ),
        ),
      )
    }),
  )
}

it.effect("bounds background retries and polling cannot restart the budget", () =>
  Effect.gen(function* () {
    let calls = 0
    yield* ModelCache.Service.use((cache) =>
      Effect.gen(function* () {
        yield* cache.fetch("bharatcode")
        for (const seconds of [1, 2, 4, 8, 16]) yield* TestClock.adjust(`${seconds} seconds`)
        expect(calls).toBe(6)
        for (let n = 0; n < 5; n++) yield* cache.fetch("bharatcode")
        yield* TestClock.adjust("1 hour")
        expect(calls).toBe(6)
        expect(yield* refresh(cache, {}, "bharatcode")).toBe(false)
        expect(calls).toBe(7)
        yield* TestClock.adjust("1 second")
        expect(calls).toBe(8)
        yield* cache.clear("bharatcode")
        yield* TestClock.adjust("1 hour")
        expect(calls).toBe(8)
        expect(yield* cache.getFailure("bharatcode")).toBeUndefined()
      }),
    ).pipe(
      Effect.provide(
        layer(
          transport(() => {
            calls++
            return new Response(null, { status: 503 })
          }),
        ),
      ),
    )
  }),
)

it.effect("honors Retry-After for automatic and manual refresh", () =>
  Effect.gen(function* () {
    let calls = 0
    yield* ModelCache.Service.use((cache) =>
      Effect.gen(function* () {
        yield* cache.fetch("bharatcode")
        expect(yield* refresh(cache, {}, "bharatcode")).toBe(false)
        yield* TestClock.adjust("119 seconds")
        expect(calls).toBe(1)
        yield* TestClock.adjust("1 second")
        expect(calls).toBe(2)
        expect(Object.keys((yield* cache.get("bharatcode")) ?? {})).toEqual(["available"])
        expect(yield* cache.getFailure("bharatcode")).toBeUndefined()
      }),
    ).pipe(
      Effect.provide(
        layer(
          transport(() => {
            calls++
            return calls === 1
              ? new Response(null, { status: 429, headers: { "Retry-After": "120" } })
              : Response.json(data())
          }),
        ),
      ),
    )
  }),
)

it.effect("recovers empty catalogs but reports malformed JSON and schemas without retrying", () =>
  Effect.gen(function* () {
    let calls = 0
    yield* ModelCache.Service.use((cache) =>
      Effect.gen(function* () {
        yield* cache.fetch("bharatcode")
        expect(yield* cache.getFailure("bharatcode")).toEqual({ kind: "schema" })
        yield* TestClock.adjust("1 second")
        expect(Object.keys((yield* cache.get("bharatcode")) ?? {})).toEqual(["available"])
        yield* cache.refresh("bharatcode")
        yield* TestClock.adjust("1 hour")
        expect(calls).toBe(3)
        expect(yield* cache.getFailure("bharatcode")).toEqual({ kind: "schema" })
        yield* cache.refresh("bharatcode")
        yield* TestClock.adjust("1 hour")
        expect(calls).toBe(4)
        expect(yield* cache.getFailure("bharatcode")).toEqual({ kind: "schema" })
      }),
    ).pipe(
      Effect.provide(
        layer(
          transport(() => {
            calls++
            if (calls === 1) return Response.json({ data: [] })
            if (calls === 2) return Response.json(data())
            if (calls === 3) return new Response("not JSON: private token")
            return Response.json({ data: [{ id: 123 }] })
          }),
        ),
      ),
    )
  }),
)

for (const cooldown of [false, true]) {
  it.effect(`preserves ${cooldown ? "Retry-After" : "last-good models"} beyond the normal cache TTL`, () =>
    Effect.gen(function* () {
      const time = Date.now()
      yield* Effect.addFinalizer(() => Effect.sync(() => setSystemTime()))
      let calls = 0
      yield* ModelCache.Service.use((cache) =>
        Effect.gen(function* () {
          const good = yield* cache.fetch("bharatcode")
          if (cooldown) yield* cache.refresh("bharatcode")
          setSystemTime(time + 360000)
          yield* TestClock.adjust("6 minutes")
          expect(yield* cache.fetch("bharatcode")).toEqual(good)
          expect(calls).toBe(2)
          expect(yield* cache.getFailure("bharatcode")).toMatchObject({ kind: "http", status: 503 })
        }),
      ).pipe(
        Effect.provide(
          layer(
            transport(() => {
              calls++
              return calls === 1
                ? Response.json(data())
                : new Response(null, {
                    status: 503,
                    headers: cooldown ? { "Retry-After": "3600" } : {},
                  })
            }),
          ),
        ),
      )
    }),
  )
}

it.live("isolates credentials and endpoints and rejects late results after switch or clear", () =>
  Effect.gen(function* () {
    const started = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const requests: Array<{ path: string; key: string | null }> = []
    const upstream = yield* server(async (request) => {
      const path = new URL(request.url).pathname
      const key = request.headers.get("authorization")
      requests.push({ path, key })
      if (path === "/old/models") {
        started.resolve()
        await release.promise
      }
      return Response.json(data(path === "/old/models" ? "old" : key === "Bearer second" ? "second" : "first"))
    })
    yield* ModelCache.Service.use((cache) =>
      Effect.gen(function* () {
        const pending = yield* cache
          .fetch("bharatcode", { baseURL: `${upstream.url}old`, apiKey: "first" })
          .pipe(Effect.forkChild)
        yield* Effect.promise(() => started.promise)
        const options = { baseURL: `${upstream.url}new`, apiKey: "second" }
        expect(Object.keys(yield* cache.fetch("bharatcode", options))).toEqual(["second"])
        release.resolve()
        yield* Fiber.join(pending)
        expect(Object.keys((yield* cache.get("bharatcode")) ?? {})).toEqual(["second"])
        expect(Object.keys(yield* cache.fetch("bharatcode", { ...options, apiKey: "first" }))).toEqual(["first"])
        yield* cache.clear("bharatcode")
        expect(yield* cache.get("bharatcode")).toBeUndefined()
        expect(requests).toEqual([
          { path: "/old/models", key: "Bearer first" },
          { path: "/new/models", key: "Bearer second" },
          { path: "/new/models", key: "Bearer first" },
        ])
      }),
    ).pipe(Effect.provide(layer()))
  }),
)

it.effect("stops obsolete retries when OAuth account changes without another catalog caller", () =>
  Effect.gen(function* () {
    let calls = 0
    const account = yield* Ref.make("first")
    const auth = Layer.mock(Auth.Service)({
      get: () =>
        Ref.get(account).pipe(
          Effect.map(
            (token) =>
              new Auth.Oauth({
                type: "oauth",
                access: token,
                refresh: "synthetic-refresh",
                expires: Date.now() + 3600000,
              }),
          ),
        ),
    })
    yield* ModelCache.Service.use((cache) =>
      Effect.gen(function* () {
        yield* cache.fetch("bharatcode")
        yield* Ref.set(account, "second")
        yield* TestClock.adjust("1 hour")
        expect(calls).toBe(1)
        expect(Object.keys(yield* cache.fetch("bharatcode"))).toEqual(["available"])
        expect(calls).toBe(2)
        expect(yield* cache.getFailure("bharatcode")).toBeUndefined()
      }),
    ).pipe(
      Effect.provide(
        layer(
          Layer.succeed(
            HttpClient.HttpClient,
            HttpClient.make((request) =>
              Effect.sync(() => {
                expect(request.headers.authorization).toBeUndefined()
                calls++
                return HttpClientResponse.fromWeb(
                  request,
                  calls === 1 ? new Response(null, { status: 503 }) : Response.json(data()),
                )
              }),
            ),
          ),
          TestConfig.layer(),
          auth,
        ),
      ),
    )
  }),
)

it.live("does not restore an in-flight catalog after clearing it", () =>
  Effect.gen(function* () {
    const started = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const upstream = yield* server(async () => {
      started.resolve()
      await release.promise
      return Response.json(data())
    })
    yield* ModelCache.Service.use((cache) =>
      Effect.gen(function* () {
        const pending = yield* cache.fetch("bharatcode", { baseURL: String(upstream.url) }).pipe(Effect.forkChild)
        yield* Effect.promise(() => started.promise)
        yield* cache.clear("bharatcode")
        release.resolve()
        expect(yield* Fiber.join(pending)).toEqual({})
        expect(yield* cache.get("bharatcode")).toBeUndefined()
        expect(yield* cache.getFailure("bharatcode")).toBeUndefined()
      }),
    ).pipe(Effect.provide(layer()))
  }),
)

it.effect("stops obsolete retries when the configured endpoint changes", () =>
  Effect.gen(function* () {
    const endpoint = yield* Ref.make("https://first.example/v1")
    const requests: string[] = []
    const cfg = TestConfig.layer({
      get: () =>
        Ref.get(endpoint).pipe(Effect.map((baseURL) => ({ provider: { bharatcode: { options: { baseURL } } } }))),
    })
    const http = Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make((request) =>
        Effect.sync(() => {
          requests.push(request.url)
          return HttpClientResponse.fromWeb(
            request,
            requests.length === 1 ? new Response(null, { status: 503 }) : Response.json(data()),
          )
        }),
      ),
    )
    yield* ModelCache.Service.use((cache) =>
      Effect.gen(function* () {
        yield* cache.fetch("bharatcode")
        yield* Ref.set(endpoint, "https://second.example/v1")
        yield* TestClock.adjust("1 hour")
        expect(requests).toEqual(["https://first.example/v1/models"])
        expect(Object.keys(yield* cache.fetch("bharatcode"))).toEqual(["available"])
        expect(requests).toEqual(["https://first.example/v1/models", "https://second.example/v1/models"])
      }),
    ).pipe(Effect.provide(layer(http, cfg)))
  }),
)

it.live("classifies a real local connection failure as network without leaking credentials", () =>
  Effect.gen(function* () {
    const upstream = yield* server(() => Response.json(data()))
    const url = String(upstream.url)
    yield* Effect.promise(() => upstream.stop(true))
    yield* ModelCache.Service.use((cache) =>
      Effect.gen(function* () {
        expect(yield* cache.fetch("bharatcode", { baseURL: url, apiKey: "must-not-leak" })).toEqual({})
        expect(yield* cache.getFailure("bharatcode")).toEqual({ kind: "network" })
      }),
    ).pipe(Effect.provide(layer()))
  }),
)

it.effect("bounds the request timeout and exposes network failure", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>()
    const http = Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make(() => Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never))),
    )
    yield* ModelCache.Service.use((cache) =>
      Effect.gen(function* () {
        const pending = yield* cache.fetch("bharatcode").pipe(Effect.forkChild)
        yield* Deferred.await(started)
        yield* TestClock.adjust("10 seconds")
        expect(yield* Fiber.join(pending)).toEqual({})
        expect(yield* cache.getFailure("bharatcode")).toEqual({ kind: "network" })
        yield* cache.clear("bharatcode")
      }),
    ).pipe(Effect.provide(layer(http)))
  }),
)

it.effect("rebuilds initialized provider state after recovery without disposing unrelated state or work", () =>
  Effect.gen(function* () {
    let calls = 0
    const notifications = yield* Ref.make(0)
    yield* Refresh.watch(() => Ref.update(notifications, (count) => count + 1))
    const cfg = TestConfig.layer({
      get: () => Effect.succeed({ enabled_providers: ["bharatcode"], provider: { bharatcode: {} } }),
    })
    const cache = layer(
      transport(() => (++calls === 1 ? new Response(null, { status: 503 }) : Response.json(data()))),
      cfg,
    )
    const models = ModelsDev.layer.pipe(
      Layer.provide(cache),
      Layer.provide(cfg),
      Layer.provide(access),
      Layer.provide(Layer.mock(Core.Service)({ get: () => Effect.succeed({}), refresh: () => Effect.void })),
    )
    const graph = LayerNode.compile(Provider.node, [
      [ModelsDev.node, models],
      [Config.node, cfg],
      [Auth.node, access],
      [Plugin.node, Layer.mock(Plugin.Service)({ list: () => Effect.succeed([]) })],
    ])
    yield* Effect.gen(function* () {
      const sentinel = yield* InstanceState.make(() => Effect.succeed({ marker: Symbol() }))
      const original = yield* InstanceState.get(sentinel)
      const stopped = yield* Ref.make(false)
      const started = yield* Deferred.make<void>()
      yield* Deferred.succeed(started, undefined).pipe(
        Effect.andThen(Effect.never),
        Effect.ensuring(Ref.set(stopped, true)),
        Effect.forkChild,
      )
      yield* Deferred.await(started)
      const provider = yield* Provider.Service
      const id = ProviderV2.ID.make("bharatcode")
      const model = ModelV2.ID.make("available")
      expect((yield* provider.list())[id]).toBeUndefined()
      expect(calls).toBe(1)
      yield* TestClock.adjust("1 second")
      expect(calls).toBe(2)
      expect(yield* Ref.get(notifications)).toBe(1)
      expect(yield* provider.getModel(id, model)).toMatchObject({ id: "available", providerID: "bharatcode" })
      expect(yield* InstanceState.get(sentinel)).toBe(original)
      expect(yield* Ref.get(stopped)).toBe(false)
    }).pipe(Effect.provide(graph), provideInstance(process.cwd()))
  }),
)
