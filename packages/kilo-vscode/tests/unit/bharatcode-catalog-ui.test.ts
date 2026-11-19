import { describe, expect, test } from "bun:test"
import { catalogNotice } from "../../src/shared/bharatcode-catalog"

const loaded = { ready: true, connected: ["bharatcode"], failures: [], hasModels: true }

describe("BharatCode catalog recovery notice", () => {
  test("loading is distinct from signed out or empty", () => {
    expect(catalogNotice({ ...loaded, ready: false })?.key).toBe("bharatcode.catalog.loading")
    expect(catalogNotice({ ...loaded, connected: [], hasModels: false })?.action).toBe("signIn")
    expect(catalogNotice({ ...loaded, hasModels: false })?.action).toBe("retry")
  })

  test("catalog failures offer retry even when the provider was removed from connected", () => {
    for (const kind of ["network", "http", "schema"] as const) {
      const notice = catalogNotice({
        ...loaded,
        connected: [],
        hasModels: false,
        failures: [{ providerID: "bharatcode", kind, status: 503 }],
      })
      expect(notice?.key).toBe(`bharatcode.catalog.${kind}`)
      expect(notice?.action).toBe("retry")
    }
  })

  test("last-good models remain selectable while a refresh failure is explained", () => {
    expect(catalogNotice({ ...loaded, failures: [{ providerID: "bharatcode", kind: "network" }] })?.action).toBe(
      "retry",
    )
    expect(catalogNotice(loaded)).toBeUndefined()
  })

  test("authentication failures ask for sign-in, not repeated network retries", () => {
    for (const kind of ["unauthorized", "unauthenticated"] as const) {
      expect(catalogNotice({ ...loaded, failures: [{ providerID: "bharatcode", kind }] })?.action).toBe("signIn")
    }
  })
})
