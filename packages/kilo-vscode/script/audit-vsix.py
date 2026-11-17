#!/usr/bin/env python3
"""Read-only VSIX audit, with optional checksums/receipt for a fresh candidate."""

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import xml.etree.ElementTree as ET
import zipfile

PUBLISHER = "bharatcode"
NAME = "bharatcode-vscode"
IDENTITY = f"{PUBLISHER}.{NAME}"
TARGETS = (
    "win32-x64", "win32-arm64", "linux-x64", "linux-arm64",
    "alpine-x64", "alpine-arm64", "darwin-x64", "darwin-arm64",
)


def require(condition, message):
    if not condition:
        raise ValueError(message)


def audit(file, target, version):
    require(target in TARGETS, f"unknown target: {target}")
    with zipfile.ZipFile(file) as archive:
        names = archive.namelist()
        require(len(names) == len(set(names)), "duplicate ZIP entries")
        require(not any(name.endswith(".map") for name in names), "sourcemaps in VSIX")
        manifest = json.loads(archive.read("extension/package.json"))
        require(manifest["publisher"] == PUBLISHER and manifest["name"] == NAME, "package identity")
        require(manifest["version"] == version, "package version")
        xml = ET.fromstring(archive.read("extension.vsixmanifest"))
        identity = xml.find("{*}Metadata/{*}Identity")
        require(identity is not None, "missing VSIX XML identity")
        for key, value in {
            "Publisher": PUBLISHER, "Id": NAME, "Version": version, "TargetPlatform": target,
        }.items():
            require(identity.get(key) == value, f"VSIX XML {key}")
        binary = "extension/bin/bharatcode" + (".exe" if target.startswith("win32-") else "")
        other = "extension/bin/bharatcode" if binary.endswith(".exe") else binary + ".exe"
        require(binary in names and other not in names, "platform binary")
        license = archive.read("extension/LICENSE.txt").decode()
        require("BharatCode modifications" in license and "Kilo Code" in license, "license attribution")
        bundle = archive.read("extension/dist/extension.js")
        require(IDENTITY.encode() in bundle, "compiled extension identity")
        require(b"Sign in with BharatCode" in bundle, "compiled website sign-in")
        for name in names:
            if name.startswith("extension/dist/") and name.endswith(".js"):
                data = archive.read(name)
                require(b"thenabbu.bharatcode-vscode" not in data, f"old publisher in {name}")
                require(not re.search(rb"bharatcode\.bharatcode(?![\w-])", data), f"CLI launcher identity in {name}")


def inspect(directory, version, targets=TARGETS, versioned=False):
    require(len(targets) == len(set(targets)) and bool(targets), "duplicate or empty targets")
    suffix = f"-{version}" if versioned else ""
    expected = {f"{NAME}-{target}{suffix}.vsix": target for target in targets}
    files = sorted(directory.glob("*.vsix"))
    require({file.name for file in files} == set(expected), "unexpected or missing VSIX target set")
    rows = []
    for file in files:
        target = expected[file.name]
        audit(file, target, version)
        digest = hashlib.sha256()
        with file.open("rb") as stream:
            for chunk in iter(lambda: stream.read(1024 * 1024), b""):
                digest.update(chunk)
        rows.append({"name": file.name, "target": target, "size": file.stat().st_size, "sha256": digest.hexdigest()})
    return rows


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dir", type=Path, default=Path(__file__).resolve().parent.parent / "out")
    parser.add_argument("--version", required=True)
    parser.add_argument("--target", action="append", choices=TARGETS)
    parser.add_argument("--versioned", action="store_true")
    parser.add_argument("--checksums", action="store_true")
    parser.add_argument("--receipt", action="store_true")
    args = parser.parse_args()
    rows = inspect(args.dir, args.version, args.target or TARGETS, args.versioned)
    receipt = {
        "version": args.version, "publisher": PUBLISHER, "name": NAME,
        "extensionId": IDENTITY, "files": rows,
    }
    if args.receipt:
        # Require CI provenance before writing any evidence.
        receipt.update({
            "source": os.environ["GITHUB_SHA"],
            "run": os.environ["GITHUB_RUN_ID"],
            "attempt": os.environ["GITHUB_RUN_ATTEMPT"],
        })
        require(re.fullmatch(r"[0-9a-f]{40}", receipt["source"]), "invalid source SHA")
        require(receipt["run"].isdigit() and receipt["attempt"].isdigit(), "invalid run provenance")
        (args.dir / "candidate.json").write_text(json.dumps(receipt, indent=2) + "\n")
    if args.checksums or args.receipt:
        (args.dir / "SHA256SUMS").write_text("".join(row["sha256"] + "  " + row["name"] + "\n" for row in rows))
    print(json.dumps(receipt, indent=2))


if __name__ == "__main__":
    main()
