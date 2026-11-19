import { Effect } from "effect"
import * as ModelsRefresh from "@opencode-ai/core/kilocode/models-refresh"
import type { Config } from "@/config/config"
import type { ModelCache } from "@/provider/model-cache"

export const refresh = Effect.fn("Catalog.refresh")(function* (
  cache: ModelCache.Interface,
  config: Config.Info,
  providerID: string,
) {
  // This endpoint deliberately does not refresh the global models.dev catalog,
  // dispose instances, or invoke provider login/plugin loaders.
  if (providerID !== "bharatcode") return false
  if (config.disabled_providers?.includes(providerID)) return false
  if (config.enabled_providers && !config.enabled_providers.includes(providerID)) return false
  return yield* cache.refresh(providerID).pipe(
    Effect.flatMap((models) =>
      cache.getFailure(providerID).pipe(Effect.map((error) => !error && Object.keys(models).length > 0)),
    ),
    // Also cover an explicit refresh of a newly selected/warm account. Only
    // model-provider caches watch this signal; session/tool scopes stay alive.
    Effect.tap((success) => (success ? ModelsRefresh.notify() : Effect.void)),
    Effect.timeout("15 seconds"),
    Effect.catch(() => Effect.succeed(false)),
  )
})
