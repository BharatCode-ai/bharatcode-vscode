import { describe, expect, test } from "bun:test"
import { delay, failure, key, retain, retryable } from "../../../src/kilocode/provider/bharatcode-catalog"

describe("BharatCode catalog recovery policy", () => {
  test("classifies HTTP failures without retaining headers, URLs or response bodies", () => {
    expect(failure(401)).toEqual({ kind: "unauthorized", status: 401 })
    expect(failure(403)).toEqual({ kind: "unauthorized", status: 403 })
    expect(failure(404)).toEqual({ kind: "http", status: 404 })
    expect(failure(503, "secret-token")).toEqual({ kind: "http", status: 503 })
  })

  test("honors numeric and HTTP-date Retry-After and ignores invalid values", () => {
    const now = Date.parse("2026-11-20T00:00:00Z")
    expect(failure(429, "120", now).retryAfter).toBe(120)
    expect(failure(503, "Fri, 20 Nov 2026 00:02:00 GMT", now).retryAfter).toBe(120)
    expect(failure(503, "Thu, 19 Nov 2026 00:00:00 GMT", now).retryAfter).toBe(0)
    expect(failure(503, "invalid", now).retryAfter).toBeUndefined()
    expect(delay({ models: {}, error: failure(429, "86400") }, 0)).toBe(86400)
    expect(delay({ models: {}, error: failure(429, "999999999") }, 0)).toBeUndefined()
    expect(delay({ models: {}, error: failure(429, "9".repeat(400)) }, 0)).toBeUndefined()
  })

  test("bounds retries and distinguishes permanent, transient and empty failures", () => {
    const result = { models: {}, error: failure(503) }
    expect(Array.from({ length: 7 }, (_, attempt) => delay(result, attempt))).toEqual([
      1,
      2,
      4,
      8,
      16,
      undefined,
      undefined,
    ])
    for (const status of [408, 429, 500, 502, 503]) expect(retryable({ models: {}, error: failure(status) })).toBe(true)
    for (const status of [400, 401, 403, 404]) expect(retryable({ models: {}, error: failure(status) })).toBe(false)
    expect(retryable({ models: {}, error: { kind: "schema" } })).toBe(false)
    expect(retryable({ models: {}, error: { kind: "schema" }, empty: true })).toBe(true)
  })

  test("keeps last-good models only for recoverable failures", () => {
    const models = {
      good: {
        id: "good",
        name: "Good",
        release_date: "",
        attachment: false,
        reasoning: false,
        temperature: true,
        tool_call: true,
        limit: { context: 128000, output: 4096 },
      },
    }
    expect(retain({ models: {}, error: failure(503) }, models).models).toBe(models)
    expect(retain({ models: {}, error: { kind: "network" } }, models).models).toBe(models)
    expect(retain({ models: {}, error: { kind: "schema" }, empty: true }, models).models).toBe(models)
    expect(retain({ models: {}, error: failure(401) }, models).models).toEqual({})
  })

  test("scopes cache identity to normalized endpoint, API key and OAuth account", () => {
    const options = { baseURL: "https://catalog.example/v1", apiKey: "secret", catalogAccount: "account-a" }
    expect(key(options)).toBe(key({ ...options, baseURL: `${options.baseURL}/` }))
    expect(key(options)).not.toBe(key({ ...options, apiKey: "other" }))
    expect(key(options)).not.toBe(key({ ...options, baseURL: "https://other.example/v1" }))
    expect(key(options)).not.toBe(key({ ...options, catalogAccount: "account-b" }))
    expect(key(options)).not.toContain("secret")
  })
})
