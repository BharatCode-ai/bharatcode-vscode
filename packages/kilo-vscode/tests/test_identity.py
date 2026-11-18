"""Small synthetic VSIXes only: no installed extension, profile or credential access."""

import importlib.util
import io
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
import zipfile

spec = importlib.util.spec_from_file_location("audit_vsix", Path(__file__).parents[1] / "script/audit-vsix.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
VERSION = "7.8.113"


def fixture(target="linux-x64", publisher="bharatcode", name="bharatcode-agent", xml=None, bundle=None, extra=None, display="BharatCode Agent"):
    binary = "extension/bin/bharatcode" + (".exe" if target.startswith("win32-") else "")
    entries = {
        "extension/package.json": json.dumps({"publisher": publisher, "name": name, "displayName": display, "version": VERSION}),
        "extension.vsixmanifest": xml or (
            '<PackageManifest xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011"><Metadata>'
            f'<Identity Publisher="{publisher}" Id="{name}" Version="{VERSION}" TargetPlatform="{target}"/>'
            f'<DisplayName>{display}</DisplayName>'
            '</Metadata></PackageManifest>'
        ),
        "extension/dist/extension.js": bundle or f'"{publisher}.{name}"; "{display}"; "Sign in with BharatCode"',
        "extension/LICENSE.txt": "BharatCode modifications\nKilo Code",
        binary: "synthetic binary",
    }
    entries.update(extra or {})
    stream = io.BytesIO()
    with zipfile.ZipFile(stream, "w") as archive:
        for path, data in entries.items():
            archive.writestr(path, data)
    stream.seek(0)
    return stream


class IdentityTests(unittest.TestCase):
    def test_all_platforms(self):
        for target in module.TARGETS:
            with self.subTest(target=target):
                module.audit(fixture(target), target, VERSION)

    def test_old_publisher(self):
        with self.assertRaisesRegex(ValueError, "package identity"):
            module.audit(fixture(publisher="thenabbu"), "linux-x64", VERSION)

    def test_cli_launcher_listing(self):
        with self.assertRaisesRegex(ValueError, "package identity"):
            module.audit(fixture(name="bharatcode"), "linux-x64", VERSION)

    def test_previous_listing(self):
        with self.assertRaisesRegex(ValueError, "package identity"):
            module.audit(fixture(name="bharatcode-vscode"), "linux-x64", VERSION)

    def test_display_name(self):
        with self.assertRaisesRegex(ValueError, "package display name"):
            module.audit(fixture(display="BharatCode for VS Code"), "linux-x64", VERSION)
        with zipfile.ZipFile(fixture()) as archive:
            xml = archive.read("extension.vsixmanifest").decode().replace("BharatCode Agent", "BharatCode")
        with self.assertRaisesRegex(ValueError, "VSIX XML display name"):
            module.audit(fixture(xml=xml), "linux-x64", VERSION)
        with self.assertRaisesRegex(ValueError, "compiled display name"):
            module.audit(fixture(bundle='"bharatcode.bharatcode-agent"; "Sign in with BharatCode"'), "linux-x64", VERSION)

    def test_json_only_relabel(self):
        xml = '<PackageManifest><Metadata><Identity Publisher="thenabbu"/></Metadata></PackageManifest>'
        with self.assertRaisesRegex(ValueError, "VSIX XML Publisher"):
            module.audit(fixture(xml=xml), "linux-x64", VERSION)

    def test_stale_compiled_runtime(self):
        with self.assertRaisesRegex(ValueError, "compiled extension identity"):
            module.audit(fixture(bundle='"thenabbu.bharatcode-vscode"; "Sign in with BharatCode"'), "linux-x64", VERSION)

    def test_stale_webview(self):
        for identity in ["thenabbu.bharatcode-vscode", "bharatcode.bharatcode-vscode", "bharatcode.bharatcode"]:
            with self.subTest(identity=identity), self.assertRaisesRegex(ValueError, "identity|publisher"):
                module.audit(fixture(extra={"extension/dist/webview/chunk.js": f'"{identity}"'}), "linux-x64", VERSION)

    def test_wrong_platform(self):
        with self.assertRaisesRegex(ValueError, "VSIX XML TargetPlatform"):
            module.audit(fixture("win32-x64"), "linux-x64", VERSION)

    def test_wrong_binary(self):
        with self.assertRaisesRegex(ValueError, "platform binary"):
            module.audit(fixture(extra={"extension/bin/bharatcode.exe": "wrong"}), "linux-x64", VERSION)

    def test_source_map(self):
        with self.assertRaisesRegex(ValueError, "sourcemaps"):
            module.audit(fixture(extra={"extension/dist/extension.js.map": "{}"}), "linux-x64", VERSION)

    def test_version(self):
        with self.assertRaisesRegex(ValueError, "package version"):
            module.audit(fixture(), "linux-x64", "7.8.114")

    def test_license(self):
        with self.assertRaisesRegex(ValueError, "license attribution"):
            module.audit(fixture(extra={"extension/LICENSE.txt": "MIT"}), "linux-x64", VERSION)

    def test_signin(self):
        with self.assertRaisesRegex(ValueError, "compiled website sign-in"):
            module.audit(fixture(bundle='"bharatcode.bharatcode-agent"; "BharatCode Agent"'), "linux-x64", VERSION)

    def test_exact_matrix_and_hashes(self):
        with tempfile.TemporaryDirectory(prefix="bharatcode-identity-") as tmp:
            root = Path(tmp)
            for target in module.TARGETS:
                (root / f"bharatcode-vscode-{target}.vsix").write_bytes(fixture(target).getvalue())
            rows = module.inspect(root, VERSION)
            self.assertEqual(len(rows), 8)
            self.assertTrue(all(len(row["sha256"]) == 64 and row["size"] > 0 for row in rows))
            self.assertFalse((root / "candidate.json").exists())
            (root / "unexpected.vsix").write_bytes(b"not a candidate")
            with self.assertRaisesRegex(ValueError, "target set"):
                module.inspect(root, VERSION)

    def test_missing_platform(self):
        with tempfile.TemporaryDirectory(prefix="bharatcode-identity-") as tmp:
            with self.assertRaisesRegex(ValueError, "target set"):
                module.inspect(Path(tmp), VERSION)

    def test_versioned_release_matrix(self):
        with tempfile.TemporaryDirectory(prefix="bharatcode-identity-") as tmp:
            root = Path(tmp)
            for target in module.TARGETS:
                (root / f"bharatcode-vscode-{target}-{VERSION}.vsix").write_bytes(fixture(target).getvalue())
            self.assertEqual(len(module.inspect(root, VERSION, versioned=True)), 8)

    def test_receipt_and_checksums_bind_exact_files(self):
        with tempfile.TemporaryDirectory(prefix="bharatcode-identity-") as tmp:
            root = Path(tmp)
            for target in module.TARGETS:
                (root / f"bharatcode-vscode-{target}.vsix").write_bytes(fixture(target).getvalue())
            result = subprocess.run(
                [sys.executable, "-B", module.__file__, "--dir", tmp, "--version", VERSION, "--receipt"],
                env={**os.environ, "GITHUB_SHA": "a" * 40, "GITHUB_RUN_ID": "123", "GITHUB_RUN_ATTEMPT": "2"},
                capture_output=True, text=True,
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            receipt = json.loads((root / "candidate.json").read_text())
            self.assertEqual(receipt["extensionId"], "bharatcode.bharatcode-agent")
            self.assertEqual(receipt["publisher"], "bharatcode")
            self.assertEqual(receipt["source"], "a" * 40)
            self.assertEqual(receipt["run"], "123")
            self.assertEqual(receipt["attempt"], "2")
            self.assertEqual({row["target"] for row in receipt["files"]}, set(module.TARGETS))
            for row in receipt["files"]:
                self.assertEqual(row["sha256"], hashlib.sha256((root / row["name"]).read_bytes()).hexdigest())
            self.assertEqual(
                (root / "SHA256SUMS").read_text(),
                "".join(row["sha256"] + "  " + row["name"] + "\n" for row in receipt["files"]),
            )
            # A failed re-audit must not replace existing evidence.
            original = (root / "candidate.json").read_bytes()
            (root / "bharatcode-vscode-linux-x64.vsix").write_bytes(fixture(publisher="thenabbu").getvalue())
            result = subprocess.run(
                [sys.executable, "-B", module.__file__, "--dir", tmp, "--version", VERSION, "--receipt"],
                capture_output=True, text=True,
            )
            self.assertNotEqual(result.returncode, 0)
            self.assertEqual((root / "candidate.json").read_bytes(), original)

    def test_receipt_requires_provenance(self):
        with tempfile.TemporaryDirectory(prefix="bharatcode-identity-") as tmp:
            root = Path(tmp)
            (root / "bharatcode-vscode-linux-x64.vsix").write_bytes(fixture().getvalue())
            result = subprocess.run(
                [sys.executable, "-B", module.__file__, "--dir", tmp, "--version", VERSION,
                 "--target", "linux-x64", "--receipt"],
                env={key: value for key, value in os.environ.items() if not key.startswith("GITHUB_")},
                capture_output=True, text=True,
            )
            self.assertNotEqual(result.returncode, 0)
            self.assertFalse((root / "candidate.json").exists())
            self.assertFalse((root / "SHA256SUMS").exists())


if __name__ == "__main__":
    unittest.main()
