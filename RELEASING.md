# Preparing a BharatCode VS Code release

## Extension identity

The website sign-in extension is **`bharatcode.bharatcode-vscode`**: publisher `bharatcode`, package name `bharatcode-vscode`. The Marketplace publisher was verified on 2026-11-18. This is not the older CLI-launcher listing `bharatcode.bharatcode`; do not overwrite that listing.

The former `thenabbu.bharatcode-vscode` identity belongs to the upstream BharatCode fork. Keep its attribution and license notices, but do not use it for this organization's packages, install links or runtime lookups. A publisher change is a different extension ID, not an automatic update or transfer of VS Code's extension-scoped state. Do not remove old installations or migrate profiles without a separate, explicit migration plan.

Internal `kilo-code.*` commands/settings and the bundled CLI's data paths remain unchanged. Website sign-in still uses the loopback callback; changing the Marketplace publisher does not change the OAuth client, issuer or redirect URI.

## Candidate-only workflow

Use `.github/workflows/oauth-candidate.yml` on `website-signin`. It has read-only repository permissions and builds artifacts only: no tags, releases, registry uploads or production deployment.

After the final identity changes are reviewed, committed and pushed with explicit authorization, one dispatch runs the consolidated checks and all eight platform builds:

```bash
gh workflow run oauth-candidate.yml --repo BharatCode-ai/bharatcode-vscode --ref website-signin
```

Do not dispatch until that branch contains the intended final commit. The command above does not push local edits. Publication is a separate decision. Do not substitute `release.yml` (which creates commits/tags/releases) or `script/publish.ts` (which uploads to registries).

The candidate version is `7.8.113`, supplied by `KILO_VERSION` to both the CLI and extension builds. The source manifest remains at the base version until the build overrides it; do not bulk-bump unrelated workspace packages for an identity-only change. No new version has been published by this preparation.

## Checks before rebuilding

From the repository root:

```bash
bun script/check-workflows.ts
bun script/check-md-table-padding.ts
bun script/check-opencode-annotations.ts --worktree
bun script/check-opencode-annotations.ts --base 1e97696076bafea5ff4010627108ca50a162d9eb
bun script/extract-source-links.ts
bun script/extract-source-links.ts --check
python3 -B -m unittest discover -s packages/kilo-vscode/tests -p test_identity.py
```

From `packages/kilo-vscode`:

```bash
bun --config=/dev/null test --preload ./tests/setup/vscode-mock.ts ./tests/unit/bharatcode-website-signin.test.ts ./tests/unit/extension-arch.test.ts ./tests/unit/extension-identity.test.ts ../opencode/test/plugin/bharatcode.test.ts
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

The earlier candidate from source `9afaf1c9b4ac6e7b96c8dc773292473663935de8` used publisher `thenabbu`. Its eight verified VSIXes are historical evidence, not release-ready packages for the new identity. Preserve them; do not edit, relabel, re-zip or reuse their receipts. A fresh all-platform build from the final source commit is required.

## Isolated installation validation

Use disposable VS Code user-data and extensions directories for the final candidate. Confirm the extension is registered as `bharatcode.bharatcode-vscode`, command activation and version lookup work, browser sign-in/cancel/retry work without a model request, and the correct bundled backend starts on each supported OS/architecture. Never use real profiles or credentials for automated fixtures.

Do not delete or merge existing users' extension state to make a candidate pass. Marketplace identity consolidation alone does not establish migration compatibility with either older listing.
