# Preparing a BharatCode VS Code release

## Extension identity

The approved website sign-in extension identity is **`bharatcode.bharatcode-agent`**: publisher `bharatcode`, package name `bharatcode-agent`, display name `BharatCode Agent`. The owner approved this identity and publication of all eight verified platform packages on 2026-11-18, after Marketplace rejected the reserved `bharatcode-vscode` name. The Marketplace publisher was verified on 2026-11-18. This is not the older CLI-launcher listing `bharatcode.bharatcode`; do not overwrite that listing or Navya's listing.

The verified parent candidate remains `bharatcode.bharatcode-vscode`. Keep its receipt, hashes and reuse-helper identity pins unchanged. Existing `bharatcode-vscode-*.vsix` filenames are retained as a packaging convention; the manifest, compiled lookup and receipt identify the proposed extension independently of its archive filename. Repository URLs are unchanged.

The former `thenabbu.bharatcode-vscode` identity belongs to the upstream BharatCode fork. Keep its attribution and license notices, but do not use it for this organization's packages, install links or runtime lookups. A publisher change is a different extension ID, not an automatic update or transfer of VS Code's extension-scoped state. Do not remove old installations or migrate profiles without a separate, explicit migration plan.

Internal `kilo-code.*` commands/settings and the bundled CLI's data paths remain unchanged. Website sign-in still uses the loopback callback; changing the Marketplace publisher does not change the OAuth client, issuer or redirect URI.

## Candidate-only workflow

Use `.github/workflows/oauth-candidate.yml` on `website-signin`. It has read-only repository permissions and builds artifacts only: no tags, releases, registry uploads or production deployment.

The candidate workflow is dispatch-only: pushing preparation changes does not start an additional native build.

After the final identity changes are reviewed, committed and pushed with explicit authorization, one dispatch runs the consolidated checks and all eight platform builds:

```bash
gh workflow run oauth-candidate.yml --repo BharatCode-ai/bharatcode-vscode --ref website-signin
```

Do not dispatch until that branch contains the intended final commit. The command above does not push local edits. Publication is a separate decision. Do not substitute `release.yml` (which creates commits/tags/releases) or `script/publish.ts` (which uploads to registries).

The candidate version is `7.8.113`, supplied by `KILO_VERSION` to both the CLI and extension builds. The source manifest remains at the base version until the build overrides it; do not bulk-bump unrelated workspace packages for an identity-only change. No new version has been published by this preparation.

### Packaging-only reuse of the verified backends

For an approved extension-only change, the same single Linux job can skip all native backend builds:

```bash
gh workflow run oauth-candidate.yml --repo BharatCode-ai/bharatcode-vscode --ref website-signin -f reuse_verified_backends=true
```

Do not run this until the final identity/source changes and dispatch are explicitly approved. This input does not rename the extension. It reuses only artifact `14373729058` from run `44186017306`, attempt `1`, source `09bcc0764e142829534f94475e90f863cd5a7f70`. An expired/missing artifact fails closed; do not substitute another candidate.

The parent artifact was uploaded with a three-day retention period and may expire before dispatch. A separately retained local copy can remain valid if its pinned receipt and all eight VSIX hashes still verify, but this workflow has no local-copy fallback. Supporting one would require separate review and approval; do not silently rebuild backends or substitute artifacts after expiry.

`script/reuse-candidate.py` (under `packages/kilo-vscode/`) pins the original `candidate.json` SHA-256, verifies every parent VSIX hash and target, and extracts only the CLI binaries and fixed companion-resource paths into `CLI_DIST_DIR`. The existing build copies Tree-sitter WASMs, sandbox workers, Linux/Alpine relay and seccomp helpers, and their license from beside each parent binary. It does not regenerate these resources from newer sources. SDK/extension-host/webview bundles are rebuilt once; `vsce` creates eight fresh packages normally, with no ZIP byte patching or backend execution.

The final shared identity audit still checks all eight packages. A separate equality check requires every packaged `bin/` entry's bytes, path, size and permissions to match its parent. Only then are `candidate.json` (kind `derived-backend-reuse`) and `SHA256SUMS` written. The derived receipt records the new source/run, fixed parent artifact/receipt and VSIX hashes, and per-target binary/resource hashes and inventories. It is not the original candidate receipt, a new native build, or a claim that VSIX ZIP bytes are reproducible. Original receipts/artifacts remain unchanged. This Python helper is CI/release tooling only; ordinary `build.ts` still has no Python requirement.

## Checks before rebuilding

From the repository root:

```bash
bun script/check-workflows.ts
bun script/check-md-table-padding.ts
bun script/check-opencode-annotations.ts --worktree
bun script/check-opencode-annotations.ts --base 1e97696076bafea5ff4010627108ca50a162d9eb
bun script/extract-source-links.ts
bun script/extract-source-links.ts --check
python3 -B -m unittest discover -s packages/kilo-vscode/tests -p 'test_*.py'
```

From `packages/kilo-vscode`:

```bash
bun --config=/dev/null test --preload ./tests/setup/vscode-mock.ts ./tests/unit/bharatcode-website-signin.test.ts ./tests/unit/extension-arch.test.ts ./tests/unit/extension-identity.test.ts ./tests/unit/reuse-candidate-resources.test.ts ../opencode/test/plugin/bharatcode.test.ts
bun run check-kilocode-change
```

The candidate workflow also checks formatting, host and webview types, lint and production bundling. CI and the publishing script require Python 3 for the common VSIX audit; ordinary developer builds do not. The build script checks the source manifest against the runtime identity before packaging. Do not set `KILO_SKIP_HEAVY` in the candidate workflow.

## Eight-platform evidence

| VSIX target | CLI target | Bundled executable |
|---|---|---|
| win32-x64 | win32-x64 | bin/bharatcode.exe |
| win32-arm64 | win32-arm64 | bin/bharatcode.exe |
| linux-x64 | linux-x64 | bin/bharatcode |
| linux-arm64 | linux-arm64 | bin/bharatcode |
| alpine-x64 | linux-x64-musl | bin/bharatcode |
| alpine-arm64 | linux-arm64-musl | bin/bharatcode |
| darwin-x64 | darwin-x64 | bin/bharatcode |
| darwin-arm64 | darwin-arm64 | bin/bharatcode |

`packages/kilo-vscode/script/audit-vsix.py` checks the exact target set, JSON and XML publisher/name/version/platform, compiled extension identity, website sign-in entry point, platform-exclusive binary, no sourcemaps, and BharatCode/Kilo license attribution. Candidate receipt, GitHub release audit and registry preflight all use this same audit. A source-level test also compiles the runtime identity constant in production mode.

Only after every VSIX passes does the candidate job write `candidate.json` and `SHA256SUMS`. The receipt records source SHA, run ID/attempt, version, publisher, package name, full extension ID, target, size and SHA-256 for each file. Download and verify all eight hashes before installation tests or a separate publication approval. Static audits do not prove native binary execution or a real VS Code sign-in round trip.

The earlier candidate from source `9afaf1c9b4ac6e7b96c8dc773292473663935de8` used publisher `thenabbu`. Its eight verified VSIXes are historical evidence, not release-ready packages for the new identity. Preserve them; do not edit, relabel, re-zip or reuse their receipts. Fresh extension packages from the final source commit are required; the packaging-only path above uses the later, explicitly pinned parent, never this obsolete candidate.

## Isolated installation validation

Only after separate approval, use disposable VS Code user-data and extensions directories for the final candidate. Confirm the extension is registered as `bharatcode.bharatcode-agent`, command activation and version lookup work, browser sign-in/cancel/retry work without a model request, and the correct bundled backend starts on each supported OS/architecture. Never use real profiles or credentials for automated fixtures.

Do not delete or merge existing users' extension state to make a candidate pass. Marketplace identity consolidation alone does not establish migration compatibility with either older listing.
