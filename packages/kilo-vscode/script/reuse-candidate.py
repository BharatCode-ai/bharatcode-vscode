#!/usr/bin/env python3
"""Package-only reuse of one approved backend candidate; never execute its binaries."""

import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import shutil
import stat
import zipfile

spec = importlib.util.spec_from_file_location("audit_vsix", Path(__file__).with_name("audit-vsix.py"))
audit = importlib.util.module_from_spec(spec)
spec.loader.exec_module(audit)
require = audit.require

REPOSITORY = "BharatCode-ai/bharatcode-vscode"
ARTIFACT = 14373729058
RUN = "44186017306"
SOURCE = "09bcc0764e142829534f94475e90f863cd5a7f70"
VERSION = "7.8.113"
# Binds the complete reviewed eight-target VSIX size/hash list, not just a run name.
RECEIPT = "9543d01371adf81eef327f04d04f802fa6e73625aad21c72625a36f77deead84"
PREFIX = "extension/bin/"


def digest(stream):
    value = hashlib.sha256()
    for chunk in iter(lambda: stream.read(1024 * 1024), b""):
        value.update(chunk)
    return value.hexdigest()


def checksum(file):
    with file.open("rb") as stream:
        return digest(stream)


def candidate(data):
    require(hashlib.sha256(data).hexdigest() == RECEIPT, "unapproved parent receipt hash")
    value = json.loads(data)
    require(value["source"] == SOURCE and value["run"] == RUN and value["attempt"] == "1", "parent provenance")
    require(value["version"] == VERSION and value["extensionId"] == "bharatcode.bharatcode-vscode", "parent identity/version")
    rows = value["files"]
    require(len(rows) == 8 and {row["target"] for row in rows} == set(audit.TARGETS), "parent target set")
    for row in rows:
        require(row["name"] == f"bharatcode-vscode-{row['target']}.vsix", "parent filename")
    return value


def metadata(value):
    require(value["id"] == ARTIFACT and value["expired"] is False, "wrong or expired parent artifact")
    require(value["name"] == f"vscode-oauth-{SOURCE}", "parent artifact name")
    require(str(value["workflow_run"]["id"]) == RUN and value["workflow_run"]["head_sha"] == SOURCE, "artifact run/source")


def regular(info):
    mode = info.external_attr >> 16
    require(stat.S_IFMT(mode) in (0, stat.S_IFREG), f"non-regular ZIP entry: {info.filename}")
    require(not info.flag_bits & 1, "encrypted ZIP entry")
    return stat.S_IMODE(mode)


def members(archive, target):
    names = archive.namelist()
    require(len(names) == len(set(names)), "duplicate ZIP entries")
    binary = "bharatcode.exe" if target.startswith("win32-") else "bharatcode"
    required = {binary, "kilo-sandbox-mutation-worker.js", "tree-sitter/tree-sitter.wasm"}
    if target.startswith(("linux-", "alpine-")):
        required.update({"kilo-sandbox-network-relay.js", "kilo-sandbox-seccomp", "licenses/sandbox-runtime/LICENSE"})
    entries = []
    for info in archive.infolist():
        if not info.filename.startswith(PREFIX):
            continue
        name = info.filename.removeprefix(PREFIX)
        require(name in required or re.fullmatch(r"tree-sitter/tree-sitter-[a-z0-9_]+\.wasm", name), f"unexpected backend path: {name}")
        require(regular(info) in (0o644, 0o755), f"unsafe backend mode: {name}")
        require(0 < info.file_size <= 400 * 1024 * 1024, f"invalid backend size: {name}")
        entries.append(info)
    require(required <= {info.filename.removeprefix(PREFIX) for info in entries}, "missing backend companion resources")
    return sorted(entries, key=lambda info: info.filename)


def payload(file, target):
    with zipfile.ZipFile(file) as archive:
        rows = []
        for info in members(archive, target):
            with archive.open(info) as stream:
                rows.append({"path": info.filename.removeprefix(PREFIX), "size": info.file_size,
                             "mode": regular(info), "sha256": digest(stream)})
        return rows


def tree(rows):
    return hashlib.sha256(json.dumps(rows, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def validate(root):
    value = candidate((root / "candidate.json").read_bytes())
    require({file.name for file in root.glob("*.vsix")} == {row["name"] for row in value["files"]}, "parent VSIX set")
    for row in value["files"]:
        file = root / row["name"]
        require(not file.is_symlink() and file.stat().st_size == row["size"] and checksum(file) == row["sha256"], f"parent VSIX hash: {row['name']}")
    expected = "".join(row["sha256"] + "  " + row["name"] + "\n" for row in value["files"])
    require((root / "SHA256SUMS").read_text() == expected, "parent SHA256SUMS")
    return value


def directory(target):
    name = target.replace("win32-", "windows-").replace("alpine-", "linux-")
    return "@kilocode/cli-" + name + ("-musl" if target.startswith("alpine-") else "")


def prepare(archive, meta, root):
    metadata(json.loads(meta.read_text()))
    require(not root.exists() and not root.is_symlink(), "reuse destination must not exist")
    with zipfile.ZipFile(archive) as source:
        names = source.namelist()
        require(len(names) == len(set(names)), "duplicate artifact entries")
        require(source.getinfo("candidate.json").file_size < 64 * 1024, "oversized parent receipt")
        value = candidate(source.read("candidate.json"))
        expected = {row["name"]: row["size"] for row in value["files"]}
        expected.update({"candidate.json": 64 * 1024, "SHA256SUMS": 64 * 1024})
        require(set(names) == set(expected), "unexpected artifact entries")
        for info in source.infolist():
            regular(info)
            require(info.file_size <= expected[info.filename], "oversized artifact entry")
        parent = root / "parent"
        parent.mkdir(parents=True)
        # Never extract arbitrary paths, symlinks, extension code, or package metadata into the build tree.
        for name in sorted(expected):
            with source.open(name) as stream, (parent / name).open("xb") as output:
                shutil.copyfileobj(stream, output)
    validate(parent)
    for row in value["files"]:
        destination = root / "dist" / directory(row["target"]) / "bin"
        with zipfile.ZipFile(parent / row["name"]) as source:
            for info in members(source, row["target"]):
                output = destination / info.filename.removeprefix(PREFIX)
                output.parent.mkdir(parents=True, exist_ok=True)
                with source.open(info) as stream, output.open("xb") as file:
                    shutil.copyfileobj(stream, file)
                output.chmod(regular(info))
    print(f"Verified and staged {len(value['files'])} parent backend/resource trees; no binaries executed")


def verify(root, out):
    parent = validate(root / "parent")
    rows = audit.inspect(out, VERSION)
    originals = {row["target"]: row for row in parent["files"]}
    for row in rows:
        original = originals[row["target"]]
        before = payload(root / "parent" / original["name"], row["target"])
        after = payload(out / row["name"], row["target"])
        require(before == after, f"backend/resource bytes or permissions changed: {row['target']}")
        binary = "bharatcode.exe" if row["target"].startswith("win32-") else "bharatcode"
        row["parent"] = original
        row["backend"] = {
            "sha256": next(entry["sha256"] for entry in after if entry["path"] == binary),
            "resourcesSha256": tree([entry for entry in after if entry["path"] != binary]),
            "parentPayloadSha256": tree(before), "payloadSha256": tree(after), "entries": after,
        }
    receipt = {
        "kind": "derived-backend-reuse", "version": VERSION,
        "publisher": audit.PUBLISHER, "name": audit.NAME, "extensionId": audit.IDENTITY,
        "source": os.environ["GITHUB_SHA"], "run": os.environ["GITHUB_RUN_ID"],
        "attempt": os.environ["GITHUB_RUN_ATTEMPT"],
        "parent": {"repository": REPOSITORY, "artifact": ARTIFACT, "source": SOURCE,
                   "run": RUN, "attempt": "1", "candidateSha256": RECEIPT},
        "files": rows,
    }
    require(re.fullmatch(r"[0-9a-f]{40}", receipt["source"]), "invalid source SHA")
    require(receipt["run"].isdigit() and receipt["attempt"].isdigit() and receipt["run"] != RUN, "invalid derived run provenance")
    # Do not issue any receipt/checksums until all eight identity and payload audits pass.
    (out / "candidate.json").write_text(json.dumps(receipt, indent=2) + "\n")
    (out / "SHA256SUMS").write_text("".join(row["sha256"] + "  " + row["name"] + "\n" for row in rows))
    print(f"Audited {len(rows)} derived VSIXes: parent backend/resource bytes and permissions identical")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    stage = commands.add_parser("prepare")
    stage.add_argument("--archive", type=Path, required=True)
    stage.add_argument("--metadata", type=Path, required=True)
    stage.add_argument("--root", type=Path, required=True)
    check = commands.add_parser("verify")
    check.add_argument("--root", type=Path, required=True)
    check.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    if args.command == "prepare":
        prepare(args.archive, args.metadata, args.root)
        return
    verify(args.root, args.out)


if __name__ == "__main__":
    main()
