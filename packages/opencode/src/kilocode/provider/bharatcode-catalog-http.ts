import { Effect, Schema } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http"
import * as Catalog from "./bharatcode-catalog"

const modality = Schema.Literals(["text", "audio", "image", "video", "pdf"])
const item = Schema.Struct({
  id: Schema.String,
  owned_by: Schema.optional(Schema.String),
  display_name: Schema.optional(Schema.String),
  context_window: Schema.optional(Schema.Number),
  max_output_tokens: Schema.optional(Schema.Number),
  metadata: Schema.optional(
    Schema.Struct({
      reasoning: Schema.optional(Schema.Boolean),
      toolCalling: Schema.optional(Schema.Boolean),
      input: Schema.optional(Schema.Array(modality)),
      output: Schema.optional(Schema.Array(modality)),
    }),
  ),
})
const response = Schema.Struct({ data: Schema.Array(item) })

export function fetch(http: HttpClient.HttpClient, options: Catalog.Options): Effect.Effect<Catalog.Result> {
  return Effect.gen(function* () {
    const url = `${(options.baseURL ?? Catalog.baseURL).replace(/\/+$/, "")}/models`
    const res = yield* HttpClientRequest.get(url).pipe(
      HttpClientRequest.acceptJson,
      options.apiKey ? HttpClientRequest.bearerToken(options.apiKey) : (request) => request,
      http.execute,
    )
    if (res.status < 200 || res.status >= 300)
      return { models: {}, error: Catalog.failure(res.status, res.headers["retry-after"]) }

    return yield* HttpClientResponse.schemaBodyJson(response)(res).pipe(
      Effect.map((json): Catalog.Result => {
        if (json.data.some((model) => !model.id.trim())) return { models: {}, error: { kind: "schema" } }
        if (json.data.length === 0) return { models: {}, error: { kind: "schema" }, empty: true }
        return {
          models: Object.fromEntries(
            json.data.map((model) => [
              model.id,
              {
                id: model.id,
                name: model.display_name ?? model.id,
                family: model.owned_by ?? "",
                release_date: "",
                attachment: true,
                reasoning: model.metadata?.reasoning ?? false,
                temperature: true,
                tool_call: model.metadata?.toolCalling ?? true,
                cost: { input: 0, output: 0 },
                limit: { context: model.context_window ?? 128000, output: model.max_output_tokens ?? 4096 },
                modalities: {
                  input: model.metadata?.input ?? ["text", "image"],
                  output: model.metadata?.output ?? ["text"],
                },
              },
            ]),
          ),
        }
      }),
      Effect.catch(() => Effect.succeed<Catalog.Result>({ models: {}, error: { kind: "schema" } })),
    )
  }).pipe(
    // Bound the whole request, including a response body that never finishes.
    Effect.timeout("10 seconds"),
    // Transport errors can contain URLs, headers and credentials. Never retain or log them.
    Effect.catch(() => Effect.succeed<Catalog.Result>({ models: {}, error: { kind: "network" } })),
  )
}
