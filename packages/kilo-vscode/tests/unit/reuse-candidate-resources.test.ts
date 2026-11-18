import { expect, test } from "bun:test"
import { chmod, cp, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  copyKiloSandboxWorker,
  copySandboxResources,
  copyTreeSitterResources,
} from "../../src/services/cli-backend/cli-resources"

test("packaging copies parent companions from CLI_DIST_DIR without regenerating them", async () => {
  const root = await mkdtemp(join(tmpdir(), "bharatcode-reuse-resources-"))
  try {
    for (const target of [
      "win32-x64",
      "win32-arm64",
      "linux-x64",
      "linux-arm64",
      "alpine-x64",
      "alpine-arm64",
      "darwin-x64",
      "darwin-arm64",
    ]) {
      const source = join(root, target, "source")
      const output = join(root, target, "output")
      const binary = target.startsWith("win32-") ? "bharatcode.exe" : "bharatcode"
      const files: Record<string, string> = {
        [binary]: `synthetic ${target} backend`,
        "tree-sitter/tree-sitter.wasm": "parent runtime",
        "tree-sitter/tree-sitter-bash.wasm": "parent grammar",
        "kilo-sandbox-mutation-worker.js": "parent worker",
        ...(target.startsWith("linux-") || target.startsWith("alpine-")
          ? {
              "kilo-sandbox-network-relay.js": "parent relay",
              "kilo-sandbox-seccomp": "parent seccomp",
              "licenses/sandbox-runtime/LICENSE": "parent license",
            }
          : {}),
      }
      for (const [name, data] of Object.entries(files)) {
        const file = join(source, name)
        await mkdir(join(file, ".."), { recursive: true })
        await writeFile(file, data)
        await chmod(file, name === binary || name.endsWith(".wasm") || name.endsWith("seccomp") ? 0o755 : 0o644)
      }
      await mkdir(output)
      await cp(join(source, binary), join(output, binary))
      await copyTreeSitterResources(join(source, binary), join(output, binary))
      await copySandboxResources(join(source, binary), join(output, binary))
      await copyKiloSandboxWorker(join(source, binary), join(output, binary))
      const entries = await readdir(output, { recursive: true, withFileTypes: true })
      expect(entries.filter((entry) => entry.isFile())).toHaveLength(Object.keys(files).length)
      for (const name of Object.keys(files)) {
        expect(await readFile(join(output, name))).toEqual(await readFile(join(source, name)))
        if (process.platform !== "win32") {
          expect((await stat(join(output, name))).mode & 0o777).toBe((await stat(join(source, name))).mode & 0o777)
        }
      }
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
