import { expect } from "bun:test"
import { Effect, Fiber, Layer } from "effect"
import { HttpClientResponse } from "effect/unstable/http"
import { createServer } from "node:http"
import { once } from "node:events"
import { GlobalBus, type GlobalEvent } from "../../../src/bus/global"
import { Provider } from "../../../src/provider/provider"
import { resetDatabase } from "../../fixture/db"
import { tmpdirScoped } from "../../fixture/fixture"
import { testEffect } from "../../lib/effect"
import { httpApiLayer, requestInDirectory } from "../../server/httpapi-layer"

const state = Layer.effectDiscard(
  Effect.acquireRelease(
    Effect.promise(() => resetDatabase()),
    () => Effect.promise(() => resetDatabase()),
  ),
)
const it = testEffect(Layer.mergeAll(state, httpApiLayer))

it.live(
  "POST refresh repairs a 503 catalog on the same backend before returning, without instance disposal",
  () =>
    Effect.gen(function* () {
      let healthy = false
      let calls = 0
      const started = Promise.withResolvers<void>()
      const release = Promise.withResolvers<void>()
      const upstream = yield* Effect.acquireRelease(
        Effect.promise(async () => {
          const server = createServer(async (request, response) => {
            if (request.url !== "/v1/models") {
              response.writeHead(404).end()
              return
            }
            calls++
            if (!healthy) {
              response.writeHead(503, { "content-type": "application/json" }).end('{"error":"synthetic-secret"}')
              return
            }
            started.resolve()
            await release.promise
            response.writeHead(200, { "content-type": "application/json" }).end(
              JSON.stringify({
                data: [
                  { id: "recovered", display_name: "Recovered", context_window: 262144, max_output_tokens: 32000 },
                ],
              }),
            )
          })
          server.listen(0, "127.0.0.1")
          await once(server, "listening")
          return server
        }),
        (server) =>
          Effect.promise(async () => {
            release.resolve()
            const closed = Promise.withResolvers<void>()
            server.close(() => closed.resolve())
            server.closeAllConnections()
            await closed.promise
          }),
      )
      const address = upstream.address()
      if (!address || typeof address === "string") throw new Error("Missing local catalog listener")
      const directory = yield* tmpdirScoped({
        git: true,
        config: {
          enabled_providers: ["bharatcode"],
          formatter: false,
          lsp: false,
          provider: { bharatcode: { options: { baseURL: `http://127.0.0.1:${address.port}/v1` } } },
        },
      })
      const auth = yield* requestInDirectory("/auth/bharatcode", directory, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ type: "api", key: "synthetic-catalog-key" }),
      })
      expect(auth.status).toBe(200)
      yield* Effect.addFinalizer(() =>
        requestInDirectory("/auth/bharatcode", directory, { method: "DELETE" }).pipe(Effect.ignore),
      )

      const events: GlobalEvent[] = []
      const listen = (event: GlobalEvent) => {
        events.push(event)
      }
      GlobalBus.on("event", listen)
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          GlobalBus.off("event", listen)
        }),
      )

      const initial = yield* requestInDirectory("/provider", directory).pipe(
        Effect.flatMap(HttpClientResponse.schemaBodyJson(Provider.ListResult)),
      )
      expect(initial.failed).toContain("bharatcode")
      expect(initial.failures).toContainEqual({ providerID: "bharatcode", kind: "http", status: 503 })
      expect(initial.all.find((provider) => provider.id === "bharatcode")?.models).toEqual({})
      expect(JSON.stringify(initial.failures)).not.toContain("synthetic-secret")

      healthy = true
      const first = yield* requestInDirectory("/provider/bharatcode/refresh", directory, { method: "POST" }).pipe(
        Effect.forkChild,
      )
      yield* Effect.promise(() => started.promise)
      release.resolve()
      const response = yield* Fiber.join(first)
      expect(response.status).toBe(200)
      expect(yield* response.json).toBe(true)
      const recovered = yield* requestInDirectory("/provider", directory).pipe(
        Effect.flatMap(HttpClientResponse.schemaBodyJson(Provider.ListResult)),
      )
      expect(recovered.failed).not.toContain("bharatcode")
      expect(recovered.failures.find((failure) => failure.providerID === "bharatcode")).toBeUndefined()
      expect(recovered.connected).toContain("bharatcode")
      expect(Object.keys(recovered.all.find((provider) => provider.id === "bharatcode")?.models ?? {})).toEqual([
        "recovered",
      ])
      expect(calls).toBe(2)
      expect(events.filter((event) => event.payload.type === "server.instance.disposed")).toEqual([])
      const unsupported = yield* requestInDirectory("/provider/unknown/refresh", directory, { method: "POST" })
      expect(yield* unsupported.json).toBe(false)
      expect(calls).toBe(2)
    }),
  30_000,
)
