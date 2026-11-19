// kilocode_change - new file
import { fetchKiloModels, type KiloModelsResult } from "@kilocode/kilo-gateway"
import { Clock, Context, Deferred, Duration, Effect, Exit, Fiber, Layer, Schema, Scope } from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http"
import { Config } from "../config/config"
import { Auth } from "../auth"
import { compatible, organization, token } from "@/kilocode/provider/catalog"
import { delay, retryable } from "@/kilocode/provider/catalog-recovery"
import * as BharatcodeCatalog from "@/kilocode/provider/bharatcode-catalog"
import { fetch as fetchBharatcodeCatalog } from "@/kilocode/provider/bharatcode-catalog-http"
import * as ModelsRefresh from "@opencode-ai/core/kilocode/models-refresh"
import type { Provider } from "@opencode-ai/core/models-dev"
import * as Log from "@opencode-ai/core/util/log"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder" // kilocode_change
import { httpClient } from "@opencode-ai/core/effect/app-node-platform" // kilocode_change

type Models = Provider["models"]
type Modalities = NonNullable<Models[string]["modalities"]>
type KiloOptions = NonNullable<Parameters<typeof fetchKiloModels>[0]>
type Options = { -readonly [K in keyof KiloOptions]?: KiloOptions[K] } & BharatcodeCatalog.Options
type Failure = NonNullable<KiloModelsResult["error"]>
type Result = BharatcodeCatalog.Result
type View = { models?: Models; timestamp?: number; empty?: boolean }
type Flight = { readonly done: Deferred.Deferred<Result, unknown>; version: number }

export interface KiloModels {
  readonly fetch: (options: KiloOptions) => Effect.Effect<KiloModelsResult, unknown>
}

export class KiloModelsService extends Context.Service<KiloModelsService, KiloModels>()(
  "@kilocode/ModelCache/KiloModels",
) {}

export const kiloModelsLayer = Layer.succeed(
  KiloModelsService,
  KiloModelsService.of({ fetch: (options) => Effect.tryPromise(() => fetchKiloModels(options)) }),
)
type Cell = {
  readonly providerID: string
  readonly options: Options
  readonly input: Options
  readonly view: View
  attempts?: number
  retryAt?: number
  cached?: { readonly result: Result; readonly expires: number }
  flight?: Flight
  recovery?: Fiber.Fiber<void>
}

export interface Interface {
  readonly getFailure: (providerID: string) => Effect.Effect<Failure | undefined>
  readonly failedProviders: () => Effect.Effect<string[]>
  readonly get: (providerID: string) => Effect.Effect<Models | undefined>
  readonly fetch: (providerID: string, options?: Options) => Effect.Effect<Models, unknown>
  readonly refresh: (providerID: string, options?: Options) => Effect.Effect<Models, unknown>
  readonly clear: (providerID: string) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@kilocode/ModelCache") {}

const log = Log.create({ service: "model-cache" })
const ttl = Duration.minutes(5)
const APERTIS_BASE_URL = "https://api.apertis.ai/v1"
// OpenAI GET /models item shape. Optional extras are read by BharatCode's richer
// response (display_name/context_window/metadata); apertis items without them
// fall back to the legacy defaults in aperture().
const ApertisItem = Schema.Struct({
  id: Schema.String,
  owned_by: Schema.optional(Schema.String),
  display_name: Schema.optional(Schema.String),
  context_window: Schema.optional(Schema.Number),
  max_output_tokens: Schema.optional(Schema.Number),
  metadata: Schema.optional(
    Schema.Struct({
      reasoning: Schema.optional(Schema.Boolean),
      toolCalling: Schema.optional(Schema.Boolean),
      input: Schema.optional(Schema.Array(Schema.String)),
      output: Schema.optional(Schema.Array(Schema.String)),
    }),
  ),
})
const ApertisResponse = Schema.Struct({ data: Schema.optional(Schema.Array(ApertisItem)) })
type ApertisItem = Schema.Schema.Type<typeof ApertisItem>

export const layer: Layer.Layer<
  Service,
  never,
  Auth.Service | Config.Service | KiloModelsService | HttpClient.HttpClient
> = Layer.effect(
  Service,
  Effect.gen(function* () {
    const auth = yield* Auth.Service
    const cfg = yield* Config.Service
    const kilo = yield* KiloModelsService
    const http = yield* HttpClient.HttpClient
    const scope = yield* Scope.Scope
    const cells = new Map<string, Cell>()
    const active = new Map<string, Cell>()
    const selected = new Map<string, Cell>()
    const versions = new Map<string, number>()
    const failures = new Map<string, Failure>()

    const getFailure = Effect.fn("ModelCache.getFailure")(function* (providerID: string) {
      return failures.get(providerID)
    })

    const failedProviders = Effect.fn("ModelCache.failedProviders")(function* () {
      return [...failures.keys()]
    })

    const aperture = (item: ApertisItem): Models[string] => ({
      id: item.id,
      name: item.display_name ?? item.id,
      family: item.owned_by ?? "",
      release_date: "",
      attachment: true,
      reasoning: item.metadata?.reasoning ?? false,
      temperature: true,
      tool_call: item.metadata?.toolCalling ?? true,
      cost: { input: 0, output: 0 },
      limit: { context: item.context_window ?? 128000, output: item.max_output_tokens ?? 4096 },
      modalities: {
        // Apertis metadata types these as plain strings; narrow to the model modality union
        input: (item.metadata?.input ?? ["text", "image"]) as Modalities["input"],
        output: (item.metadata?.output ?? ["text"]) as Modalities["output"],
      },
    })

    const fetchApertisModels = Effect.fn("ModelCache.fetchApertisModels")(function* (options: Options) {
      const baseURL = options.baseURL ?? APERTIS_BASE_URL
      const anon = baseURL === BharatcodeCatalog.baseURL
      if (!options.apiKey && !anon) {
        log.debug("no API key for apertis, skipping model fetch")
        return {}
      }

      const url = `${baseURL.replace(/\/+$/, "")}/models`
      const response = yield* HttpClientRequest.get(url).pipe(
        HttpClientRequest.acceptJson,
        options.apiKey ? HttpClientRequest.bearerToken(options.apiKey) : (req) => req, // HttpClientRequest is a namespace here, not a type; pipe infers
        http.execute,
        Effect.timeout("10 seconds"),
      )
      if (response.status < 200 || response.status >= 300) {
        log.error("apertis model fetch failed", { status: response.status })
        return {}
      }

      const json = yield* HttpClientResponse.schemaBodyJson(ApertisResponse)(response)
      return Object.fromEntries((json.data ?? []).map((item) => [item.id, aperture(item)]))
    })

    const authOptions = Effect.fn("ModelCache.authOptions")(function* (providerID: string) {
      if (providerID !== "kilo" && providerID !== "apertis" && providerID !== "bharatcode") return {}
      const config = yield* cfg.get()
      const options: Options = {}

      if (providerID === "kilo") {
        const item = config.provider?.[providerID]
        const info = yield* auth.get(providerID)
        options.kilocodeOrganizationId = organization(item?.options, info)
        options.kilocodeToken = token(item?.options, info)
        log.debug("auth options resolved", {
          providerID,
          hasToken: !!options.kilocodeToken,
          hasOrganizationId: !!options.kilocodeOrganizationId,
        })
      }

      if (providerID === "apertis") {
        const item = config.provider?.[providerID]
        if (item?.options?.apiKey) options.apiKey = item.options.apiKey
        if (item?.options?.baseURL) options.baseURL = item.options.baseURL

        const info = yield* auth.get(providerID)
        if (info?.type === "api") options.apiKey = info.key
        if (process.env.APERTIS_API_KEY) options.apiKey = process.env.APERTIS_API_KEY
        if (process.env.APERTIS_BASE_URL) options.baseURL = process.env.APERTIS_BASE_URL
        log.debug("apertis auth options resolved", {
          providerID,
          hasKey: !!options.apiKey,
          hasBaseURL: !!options.baseURL,
        })
      }

      if (providerID === "bharatcode") {
        const item = config.provider?.[providerID]
        if (item?.options?.apiKey) options.apiKey = item.options.apiKey
        if (item?.options?.baseURL) options.baseURL = item.options.baseURL

        const info = yield* auth.get(providerID)
        if (info?.type === "api") options.apiKey = info.key
        // The catalog is public. Scope OAuth caches to the account without sending
        // its bearer token to an arbitrary configured catalog endpoint.
        if (info?.type === "oauth") options.catalogAccount = info.access
        if (process.env.BHARATCODE_API_KEY) options.apiKey = process.env.BHARATCODE_API_KEY
        log.debug("bharatcode auth options resolved", {
          providerID,
          hasKey: !!options.apiKey,
          hasBaseURL: !!options.baseURL,
        })
      }

      return options
    })

    const fetchModels = (providerID: string, options: Options): Effect.Effect<Result, unknown> => {
      if (providerID === "kilo") return kilo.fetch(options)
      if (providerID === "bharatcode") return fetchBharatcodeCatalog(http, options)
      if (providerID === "apertis") return fetchApertisModels(options).pipe(Effect.map((models) => ({ models })))
      log.debug("provider not implemented", { providerID })
      return Effect.succeed({ models: {} })
    }

    const load = Effect.fn("ModelCache.load")(function* (providerID: string, options: Options) {
      if (providerID === "kilo" && !compatible(options)) return { models: {}, error: { kind: "schema" as const } }
      return yield* fetchModels(providerID, options)
    })

    const resolve = Effect.fn("ModelCache.resolve")(function* (providerID: string, options: Options) {
      // Never silently replace a failed account/config lookup with anonymous
      // default-endpoint credentials for BharatCode.
      if (providerID === "bharatcode") return { ...(yield* authOptions(providerID)), ...options }
      const resolved = yield* authOptions(providerID).pipe(
        Effect.catchCause((cause) =>
          Effect.sync(() => {
            log.warn("auth options failed", { providerID, cause })
            return {}
          }),
        ),
      )
      return { ...resolved, ...options }
    })

    const key = (providerID: string, options?: Options) => {
      if (providerID === "kilo") {
        return JSON.stringify([providerID, options?.baseURL, options?.kilocodeOrganizationId, options?.kilocodeToken])
      }
      if (providerID === "apertis") return JSON.stringify([providerID, options?.baseURL, options?.apiKey])
      if (providerID === "bharatcode") return `${providerID}:${BharatcodeCatalog.key(options ?? {})}`
      return providerID
    }

    const cell = Effect.fn("ModelCache.cell")(function* (providerID: string, options: Options = {}) {
      const input = yield* resolve(providerID, options)
      const id = key(providerID, input)
      const existing = cells.get(id)
      if (existing) return existing
      const view: View = {}
      const next: Cell = { providerID, options: input, input: options, view }
      cells.set(id, next)
      return next
    })

    const invalidate = (entry: Cell) =>
      Effect.sync(() => {
        entry.cached = undefined
      })

    const detach = (entry: Cell) =>
      invalidate(entry).pipe(
        Effect.tap(() => (entry.recovery ? Fiber.interrupt(entry.recovery) : Effect.void)),
        Effect.tap(() =>
          Effect.sync(() => {
            entry.flight = undefined
          }),
        ),
      )

    const commit = (providerID: string, version: number | (() => number), entry: Cell, result: Result) =>
      Effect.gen(function* () {
        if (providerID === "bharatcode") {
          const current = yield* resolve(providerID, entry.input).pipe(Effect.catch(() => Effect.succeed(undefined)))
          if (!current || key(providerID, current) !== key(providerID, entry.options)) {
            if (active.get(providerID) === entry) active.delete(providerID)
            if (selected.get(providerID) === entry) failures.delete(providerID)
            return result.models
          }
          if (selected.get(providerID) !== entry) return result.models
        }
        if ((versions.get(providerID) ?? 0) !== (typeof version === "function" ? version() : version))
          return result.models
        const empty = Object.keys(result.models).length === 0
        const recovered =
          providerID === "bharatcode"
            ? (!result.error && !empty && failures.has(providerID)) ||
              (entry.view.models != null && JSON.stringify(entry.view.models) !== JSON.stringify(result.models))
            : providerID === "kilo" && entry.view.empty && !empty && !result.error
        if (result.error) {
          failures.set(providerID, result.error)
          log.warn("model fetch error", { providerID, error: result.error })
        } else {
          failures.delete(providerID)
          if (providerID === "bharatcode") entry.attempts = 0
        }
        entry.view.models = result.models
        entry.view.timestamp = Date.now()
        entry.view.empty = empty
        active.set(providerID, entry)
        log.info("models fetched and cached", { providerID, count: Object.keys(result.models).length })
        if (recovered) yield* ModelsRefresh.notify()
        return result.models
      })

    // A refresh belongs to the cache service, not the caller that happened to start it.
    const evaluate = (entry: Cell, version: number): Effect.Effect<Result, unknown> =>
      Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const cached = entry.cached
          if (cached && cached.expires > Date.now()) {
            yield* commit(entry.providerID, version, entry, cached.result)
            yield* recover(entry, cached.result)
            return cached.result
          }

          const existing = entry.flight
          if (existing) {
            existing.version = version
            return yield* restore(Deferred.await(existing.done))
          }

          const done = yield* Deferred.make<Result, unknown>()
          const flight = { done, version } satisfies Flight
          entry.flight = flight
          yield* Effect.uninterruptibleMask((restore) =>
            Effect.gen(function* () {
              const exit = yield* restore(load(entry.providerID, entry.options)).pipe(
                Effect.map((result) =>
                  entry.providerID === "bharatcode" ? BharatcodeCatalog.retain(result, entry.view.models) : result,
                ),
                Effect.exit,
              )
              if (entry.flight === flight) {
                if (entry.providerID !== "bharatcode") entry.flight = undefined
                if (Exit.isSuccess(exit)) {
                  entry.cached = { result: exit.value, expires: Date.now() + Duration.toMillis(ttl) }
                  if (entry.providerID === "bharatcode")
                    entry.retryAt = (yield* Clock.currentTimeMillis) + (exit.value.error?.retryAfter ?? 0) * 1000
                  yield* commit(
                    entry.providerID,
                    entry.providerID === "bharatcode" ? () => flight.version : flight.version,
                    entry,
                    exit.value,
                  )
                }
                if (entry.providerID === "bharatcode" && entry.flight === flight) entry.flight = undefined
              }
              yield* Deferred.done(done, exit)
              if (Exit.isSuccess(exit)) yield* recover(entry, exit.value)
            }),
          ).pipe(Effect.forkIn(scope, { startImmediately: true }))
          return yield* restore(Deferred.await(done))
        }),
      )

    const get = Effect.fn("ModelCache.get")(function* (providerID: string) {
      const entry = active.get(providerID)
      if (!entry?.view.models || entry.view.timestamp === undefined) {
        log.debug("cache miss", { providerID })
        return
      }

      const age = Date.now() - entry.view.timestamp
      if (
        age > Duration.toMillis(ttl) &&
        !(providerID === "bharatcode" && (entry.retryAt ?? 0) > (yield* Clock.currentTimeMillis))
      ) {
        log.debug("cache expired", { providerID, age })
        if (providerID !== "bharatcode") entry.view.models = undefined
        entry.view.timestamp = undefined
        yield* invalidate(entry)
        return
      }

      log.debug("cache hit", { providerID, age })
      return entry.view.models
    })

    const fetch = Effect.fn("ModelCache.fetch")(function* (providerID: string, options?: Options) {
      const entry = yield* cell(providerID, options)
      if (providerID === "bharatcode" && selected.get(providerID) !== entry) {
        active.delete(providerID)
        failures.delete(providerID)
      }
      selected.set(providerID, entry)
      const cached = active.get(providerID) === entry ? yield* get(providerID) : undefined
      if (cached) {
        if (entry.cached) yield* recover(entry, entry.cached.result)
        return cached
      }
      const version = (versions.get(providerID) ?? 0) + 1
      versions.set(providerID, version)
      log.info("fetching models", { providerID })
      const result = yield* evaluate(entry, version)
      if (providerID === "bharatcode" && active.get(providerID) !== entry) return {}
      return result.models
    })

    const refresh = Effect.fn("ModelCache.refresh")(function* (providerID: string, options?: Options) {
      const resolved = providerID === "bharatcode" ? yield* cell(providerID, options) : undefined
      const version = (versions.get(providerID) ?? 0) + 1
      versions.set(providerID, version)
      const entry = resolved ?? (yield* cell(providerID, options))
      if (providerID === "bharatcode" && selected.get(providerID) !== entry) {
        active.delete(providerID)
        failures.delete(providerID)
      }
      selected.set(providerID, entry)
      if (providerID === "bharatcode") {
        // Repeated clicks coalesce with the flight, and cannot bypass Retry-After.
        if (entry.cached && (entry.retryAt ?? 0) > (yield* Clock.currentTimeMillis)) {
          yield* commit(providerID, version, entry, entry.cached.result)
          yield* recover(entry, entry.cached.result)
          return entry.cached.result.models
        }
        if (!entry.flight && !entry.recovery) entry.attempts = 0
      }
      log.info("refreshing models", { providerID })
      yield* invalidate(entry)
      const result = yield* evaluate(entry, version)
      if (providerID === "bharatcode" && active.get(providerID) !== entry) return {}
      return result.models
    })

    const recover = Effect.fn("ModelCache.recover")(function* (entry: Cell, result: Result) {
      if (
        (entry.providerID !== "kilo" && entry.providerID !== "bharatcode") ||
        selected.get(entry.providerID) !== entry ||
        active.get(entry.providerID) !== entry ||
        entry.recovery ||
        !(entry.providerID === "bharatcode" ? BharatcodeCatalog.retryable(result) : retryable(result))
      )
        return
      entry.recovery = yield* Effect.gen(function* () {
        let next = result
        for (let attempt = 0; ; attempt++) {
          const seconds =
            entry.providerID === "bharatcode"
              ? BharatcodeCatalog.delay(next, entry.attempts ?? 0)
              : delay(next, attempt)
          if (seconds === undefined) return
          yield* Effect.sleep(Duration.seconds(seconds))
          // A newer account or endpoint must not be replaced by this retry.
          if (selected.get(entry.providerID) !== entry || active.get(entry.providerID) !== entry) return
          if (entry.providerID === "bharatcode") {
            const current = yield* resolve(entry.providerID, entry.input).pipe(
              Effect.catch(() => Effect.succeed(undefined)),
            )
            if (!current || key(entry.providerID, current) !== key(entry.providerID, entry.options)) return
            if (entry.cached && !BharatcodeCatalog.retryable(entry.cached.result)) return
            // A manual request can extend Retry-After while this fiber sleeps.
            const remaining = (entry.retryAt ?? 0) - (yield* Clock.currentTimeMillis)
            if (remaining > 0) yield* Effect.sleep(Duration.millis(remaining))
            if (selected.get(entry.providerID) !== entry || active.get(entry.providerID) !== entry) return
            const latest = yield* resolve(entry.providerID, entry.input).pipe(
              Effect.catch(() => Effect.succeed(undefined)),
            )
            if (!latest || key(entry.providerID, latest) !== key(entry.providerID, entry.options)) return
            if (entry.cached && !BharatcodeCatalog.retryable(entry.cached.result)) return
            entry.attempts = (entry.attempts ?? 0) + 1
          }
          if (entry.providerID !== "bharatcode" && entry.cached && !retryable(entry.cached.result)) return
          yield* invalidate(entry)
          const version = (versions.get(entry.providerID) ?? 0) + 1
          versions.set(entry.providerID, version)
          // Catalog fetches report network and HTTP problems as results, so a failure
          // here is unexpected: log it and stop instead of retrying it as a network error.
          const value = yield* evaluate(entry, version).pipe(
            Effect.catch((error) =>
              Effect.sync(() => {
                log.error(
                  "catalog recovery failed",
                  entry.providerID === "bharatcode"
                    ? { providerID: entry.providerID }
                    : { providerID: entry.providerID, error },
                )
                return undefined
              }),
            ),
          )
          if (!value) return
          next = value
          if (selected.get(entry.providerID) !== entry || active.get(entry.providerID) !== entry) return
          if (entry.providerID === "bharatcode" ? BharatcodeCatalog.retryable(next) : retryable(next)) continue
          return
        }
      }).pipe(Effect.ensuring(Effect.sync(() => (entry.recovery = undefined))), Effect.forkIn(scope))
    })

    const clear = Effect.fn("ModelCache.clear")(function* (providerID: string) {
      versions.set(providerID, (versions.get(providerID) ?? 0) + 1)
      const entries = [...cells.entries()].filter(([, entry]) => entry.providerID === providerID)
      yield* Effect.all(
        entries.map(([id, entry]) => detach(entry).pipe(Effect.tap(() => Effect.sync(() => cells.delete(id))))),
        { discard: true },
      )
      active.delete(providerID)
      selected.delete(providerID)
      failures.delete(providerID)
      if (entries.some(([, entry]) => entry.view.models)) {
        log.info("cache cleared", { providerID })
        return
      }
      log.debug("no cache to clear", { providerID })
    })

    return Service.of({ getFailure, failedProviders, get, fetch, refresh, clear })
  }),
)

export const defaultLayer: Layer.Layer<Service> = Layer.suspend(() => AppNodeBuilder.build(node)) // kilocode_change - build from the LayerNode graph

const kiloModels = LayerNode.make({ name: "kilo-models", layer: kiloModelsLayer, deps: [] })
export const node = LayerNode.make({
  service: Service,
  layer,
  deps: [Auth.node, Config.node, kiloModels, httpClient],
})

export * as ModelCache from "./model-cache"
