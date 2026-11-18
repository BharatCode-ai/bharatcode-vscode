import { describe, expect, test } from "bun:test"
import { fileURLToPath } from "node:url"
import manifest from "../../package.json"
import { EXTENSION_DISPLAY_NAME, EXTENSION_ID } from "../../src/constants"

describe("BharatCode OAuth extension identity", () => {
  test("package and runtime use the verified publisher, not the CLI launcher", () => {
    expect(manifest.publisher).toBe("bharatcode")
    expect(manifest.name).toBe("bharatcode-agent")
    expect(manifest.displayName).toBe("BharatCode Agent")
    expect(EXTENSION_ID).toBe("bharatcode.bharatcode-agent")
    expect(EXTENSION_ID).toBe(`${manifest.publisher}.${manifest.name}`)
    expect(EXTENSION_DISPLAY_NAME).toBe(manifest.displayName)
  })

  test("production compilation retains the correct lookup identity", async () => {
    const result = await Bun.build({
      entrypoints: [fileURLToPath(new URL("../../src/constants.ts", import.meta.url))],
      target: "node",
      minify: true,
    })
    expect(result.success).toBe(true)
    const output = await result.outputs[0].text()
    expect(output).toContain("bharatcode.bharatcode-agent")
    expect(output).toContain("BharatCode Agent")
    expect(output).not.toContain("bharatcode.bharatcode-vscode")
    expect(output).not.toContain("thenabbu.bharatcode-vscode")
  })
})
