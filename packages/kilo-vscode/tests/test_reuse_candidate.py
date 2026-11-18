"""Tiny eight-platform packaging fixtures; no real profiles, binaries or network."""

import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import stat
import tempfile
import unittest
from unittest.mock import patch
import warnings
import zipfile

from test_identity import fixture

spec = importlib.util.spec_from_file_location("reuse_candidate", Path(__file__).parents[1] / "script/reuse-candidate.py")
reuse = importlib.util.module_from_spec(spec)
spec.loader.exec_module(reuse)


def package(target, changes=None, mode=None, duplicate=False, parent=False):
    entries = {
        "extension/bin/kilo-sandbox-mutation-worker.js": "worker",
        "extension/bin/tree-sitter/tree-sitter.wasm": "runtime",
        "extension/bin/tree-sitter/tree-sitter-bash.wasm": "grammar",
    }
    if target.startswith(("linux-", "alpine-")):
        entries.update({
            "extension/bin/kilo-sandbox-network-relay.js": "relay",
            "extension/bin/kilo-sandbox-seccomp": "seccomp",
            "extension/bin/licenses/sandbox-runtime/LICENSE": "license",
        })
    entries.update(changes or {})
    result = io.BytesIO()
    original = {"name": "bharatcode-vscode", "display": "BharatCode for VS Code"} if parent else {}
    with zipfile.ZipFile(fixture(target, extra=entries, **original)) as source, zipfile.ZipFile(result, "w") as archive:
        for name in source.namelist():
            info = zipfile.ZipInfo(name)
            info.create_system = 3
            info.external_attr = (stat.S_IFREG | (0o755 if name.endswith(("bharatcode", ".exe", "seccomp", ".wasm")) else 0o644)) << 16
            if mode and name == mode[0]:
                info.external_attr = mode[1] << 16
            archive.writestr(info, source.read(name))
        if duplicate:
            with warnings.catch_warnings():
                warnings.simplefilter("ignore", UserWarning)
                archive.writestr("extension/bin/kilo-sandbox-mutation-worker.js", "duplicate")
    return result.getvalue()


class ReuseTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="bharatcode-reuse-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.stage = self.root / "stage"
        self.out = self.root / "out"
        self.out.mkdir()
        self.archive = self.root / "artifact.zip"
        self.meta = self.root / "metadata.json"
        self.metadata = {
            "id": reuse.ARTIFACT, "expired": False, "name": f"vscode-oauth-{reuse.SOURCE}",
            "workflow_run": {"id": int(reuse.RUN), "head_sha": reuse.SOURCE},
        }
        self.meta.write_text(json.dumps(self.metadata))
        self.files = {f"bharatcode-vscode-{target}.vsix": package(target, parent=True) for target in reuse.audit.TARGETS}
        self.environ = patch.dict(os.environ, {"GITHUB_SHA": "a" * 40, "GITHUB_RUN_ID": "123", "GITHUB_RUN_ATTEMPT": "1"})
        self.environ.start()
        self.addCleanup(self.environ.stop)

    def parent(self, extra=None, symlink=False):
        rows = [{"name": name, "target": name.removeprefix("bharatcode-vscode-").removesuffix(".vsix"),
                 "size": len(data), "sha256": hashlib.sha256(data).hexdigest()} for name, data in sorted(self.files.items())]
        receipt = json.dumps({"source": reuse.SOURCE, "run": reuse.RUN, "attempt": "1", "version": reuse.VERSION,
                              "extensionId": "bharatcode.bharatcode-vscode", "files": rows}).encode()
        # Only the pinned digest is replaced: real validation/extraction/auditing runs on tiny fixtures.
        pin = patch.object(reuse, "RECEIPT", hashlib.sha256(receipt).hexdigest())
        pin.start()
        self.addCleanup(pin.stop)
        entries = {**self.files, "candidate.json": receipt,
                   "SHA256SUMS": "".join(row["sha256"] + "  " + row["name"] + "\n" for row in rows)}
        entries.update(extra or {})
        with zipfile.ZipFile(self.archive, "w") as archive:
            for name, data in entries.items():
                info = zipfile.ZipInfo(name)
                info.external_attr = (stat.S_IFLNK | 0o777 if symlink else stat.S_IFREG | 0o644) << 16
                archive.writestr(info, data)

    def prepare(self):
        reuse.prepare(self.archive, self.meta, self.stage)
        for target in reuse.audit.TARGETS:
            (self.out / f"bharatcode-vscode-{target}.vsix").write_bytes(package(target))

    def test_all_eight_extraction_and_derived_receipt(self):
        self.parent()
        self.prepare()
        for target in reuse.audit.TARGETS:
            binary = "bharatcode.exe" if target.startswith("win32-") else "bharatcode"
            folder = self.stage / "dist" / reuse.directory(target) / "bin"
            self.assertEqual((folder / binary).read_bytes(), b"synthetic binary")
            self.assertEqual(stat.S_IMODE((folder / binary).stat().st_mode), 0o755)
            self.assertFalse((folder.parent / "package.json").exists())
        reuse.verify(self.stage, self.out)
        receipt = json.loads((self.out / "candidate.json").read_text())
        self.assertEqual(receipt["kind"], "derived-backend-reuse")
        self.assertEqual(receipt["extensionId"], "bharatcode.bharatcode-agent")
        self.assertEqual(receipt["name"], "bharatcode-agent")
        parent = json.loads((self.stage / "parent/candidate.json").read_text())
        self.assertEqual(parent["extensionId"], "bharatcode.bharatcode-vscode")
        self.assertEqual(receipt["parent"]["artifact"], reuse.ARTIFACT)
        self.assertEqual(receipt["parent"]["candidateSha256"], reuse.RECEIPT)
        self.assertEqual(receipt["source"], "a" * 40)
        self.assertEqual(receipt["parent"]["source"], reuse.SOURCE)
        self.assertEqual(len(receipt["files"]), 8)
        for row in receipt["files"]:
            self.assertEqual(row["backend"]["payloadSha256"], row["backend"]["parentPayloadSha256"])
            self.assertEqual(row["parent"]["sha256"], hashlib.sha256(self.files[row["name"]]).hexdigest())
            self.assertNotEqual(row["sha256"], row["parent"]["sha256"])
        self.assertEqual((self.out / "SHA256SUMS").read_text(), "".join(row["sha256"] + "  " + row["name"] + "\n" for row in receipt["files"]))

    def test_unapproved_receipt(self):
        with self.assertRaisesRegex(ValueError, "receipt hash"):
            reuse.candidate(b"{}")

    def test_wrong_or_expired_artifact(self):
        for field, value in [("id", 123), ("expired", True), ("name", "other"), ("workflow_run", {"id": 123, "head_sha": reuse.SOURCE})]:
            with self.subTest(field=field), self.assertRaises(ValueError):
                reuse.metadata({**self.metadata, field: value})

    def test_outer_traversal(self):
        self.parent({"../escape": "no"})
        with self.assertRaisesRegex(ValueError, "unexpected artifact entries"):
            self.prepare()
        self.assertFalse(self.stage.exists())
        self.assertFalse((self.root / "escape").exists())

    def test_outer_symlink(self):
        self.parent(symlink=True)
        with self.assertRaisesRegex(ValueError, "non-regular"):
            self.prepare()

    def test_corrupt_parent_vsix(self):
        self.parent({"bharatcode-vscode-linux-x64.vsix": b"corrupt"})
        with self.assertRaisesRegex(ValueError, "parent VSIX hash"):
            self.prepare()
        self.assertFalse((self.stage / "dist").exists())

    def test_existing_destination_is_never_deleted(self):
        self.parent()
        self.stage.mkdir()
        sentinel = self.stage / "sentinel"
        sentinel.write_text("keep")
        with self.assertRaisesRegex(ValueError, "must not exist"):
            self.prepare()
        self.assertEqual(sentinel.read_text(), "keep")

    def test_unsafe_backend_entries(self):
        for name in ["../escape", "/escape", "C:/escape", "tree-sitter/../escape", "tree-sitter\\escape", "unexpected"]:
            with self.subTest(name=name), self.assertRaisesRegex(ValueError, "unexpected backend path"):
                reuse.payload(io.BytesIO(package("linux-x64", {"extension/bin/" + name: "bad"})), "linux-x64")
        for mode in [stat.S_IFLNK | 0o777, stat.S_IFREG | 0o4755]:
            with self.subTest(mode=mode), self.assertRaisesRegex(ValueError, "non-regular|unsafe backend mode"):
                reuse.payload(io.BytesIO(package("linux-x64", mode=("extension/bin/bharatcode", mode))), "linux-x64")
        with self.assertRaisesRegex(ValueError, "duplicate ZIP entries"):
            reuse.payload(io.BytesIO(package("linux-x64", duplicate=True)), "linux-x64")

    def test_modified_binary_resource_or_mode_blocks_receipt(self):
        self.parent()
        self.prepare()
        for name in ["bharatcode", "tree-sitter/tree-sitter.wasm", "licenses/sandbox-runtime/LICENSE", "kilo-sandbox-mutation-worker.js"]:
            with self.subTest(name=name):
                (self.out / "bharatcode-vscode-linux-x64.vsix").write_bytes(package("linux-x64", {"extension/bin/" + name: "changed"}))
                with self.assertRaisesRegex(ValueError, "bytes or permissions changed"):
                    reuse.verify(self.stage, self.out)
                self.assertFalse((self.out / "candidate.json").exists())
                self.assertFalse((self.out / "SHA256SUMS").exists())
        (self.out / "bharatcode-vscode-linux-x64.vsix").write_bytes(package("linux-x64", mode=("extension/bin/bharatcode", stat.S_IFREG | 0o644)))
        with self.assertRaisesRegex(ValueError, "bytes or permissions changed"):
            reuse.verify(self.stage, self.out)

    def test_stale_identity_missing_platform_and_parent_run_cannot_issue_receipt(self):
        self.parent()
        self.prepare()
        file = self.out / "bharatcode-vscode-linux-x64.vsix"
        file.write_bytes(package("linux-x64", {"extension/dist/extension.js": "old identity"}))
        with self.assertRaisesRegex(ValueError, "compiled extension identity"):
            reuse.verify(self.stage, self.out)
        file.unlink()
        with self.assertRaisesRegex(ValueError, "target set"):
            reuse.verify(self.stage, self.out)
        file.write_bytes(package("linux-x64"))
        with patch.dict(os.environ, {"GITHUB_RUN_ID": reuse.RUN}), self.assertRaisesRegex(ValueError, "derived run provenance"):
            reuse.verify(self.stage, self.out)
        self.assertFalse((self.out / "candidate.json").exists())


if __name__ == "__main__":
    unittest.main()
