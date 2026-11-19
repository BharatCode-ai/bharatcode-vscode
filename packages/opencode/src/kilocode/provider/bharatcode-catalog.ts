import { createHash } from "node:crypto"
import type { KiloModelsResult } from "@kilocode/kilo-gateway"
import type { Provider } from "@opencode-ai/core/models-dev"

export const baseURL = "https://bharatcode.ai/api/model/v1"
export type Options = { baseURL?: string; apiKey?: string; catalogAccount?: string }
export type Result = {
  readonly models: Provider["models"]
  readonly error?: NonNullable<KiloModelsResult["error"]>
  // An empty, otherwise valid catalog is recoverable, unlike an invalid schema.
  readonly empty?: boolean
}

export function key(options: Options) {
  return createHash("sha256")
    .update(JSON.stringify([(options.baseURL ?? baseURL).replace(/\/+$/, ""), options.apiKey, options.catalogAccount]))
    .digest("hex")
}

export function failure(status: number, header?: string, now = Date.now()): NonNullable<Result["error"]> {
  const value = header?.trim()
  const seconds = !value
    ? NaN
    : /^\d+$/.test(value)
      ? Math.min(Number(value), Number.MAX_SAFE_INTEGER)
      : (Date.parse(value) - now) / 1000
  const retryAfter = Number.isFinite(seconds) ? Math.max(0, seconds) : undefined
  return {
    kind: status === 401 || status === 403 ? "unauthorized" : "http",
    status,
    ...(retryAfter == null ? {} : { retryAfter }),
  }
}

export function retryable(result: Result) {
  if (result.empty || result.error?.kind === "network") return true
  const status = result.error?.status ?? 0
  return result.error?.kind === "http" && (status === 408 || status === 429 || (status >= 500 && status < 600))
}

// Five automatic retries per recovery cycle. Explicit refresh starts a new cycle;
// polling a failed cache does not. Retry-After is a minimum, never capped by backoff.
export function delay(result: Result, attempt: number) {
  if (!retryable(result) || attempt >= 5) return undefined
  const seconds = Math.max(2 ** attempt, result.error?.retryAfter ?? 0)
  // Do not overflow a platform timer into an immediate retry. An impractically
  // long Retry-After leaves the catalog in cooldown until a later caller/clear.
  return seconds * 1000 > 2_147_483_647 ? undefined : seconds
}

export function retain(result: Result, models?: Provider["models"]): Result {
  return models && retryable(result) ? { ...result, models } : result
}
