"""linux-root-fixtures.py: what the CI producer writes, for test/fixtures/linux/root-manifests.json.

    python -I scripts/linux-root-fixtures.py <skill dir> test/fixtures/linux/root-manifests.json
    (npm run fixtures:linux, with the skill next to GOcontroll-Team:
     ../../GOcontroll-Claude-Skills/r2-application-deploy-setup)

Runs the real upload() of the skill's upload-r2.py (the CI pipeline that publishes go-deploy
releases) against an in-memory bucket: boto3 is replaced by a stub, and the S3 helpers of the
module by fakes that record what is written. Per case: the root manifest before (or none), the
version manifest and tarball in dist/, and what upload() wrote, in order, with the root
manifest's exact bytes. test/linux-release.test.ts sends the same input to
POST /api/linux-releases and expects the same bytes.

Nothing here talks to Cloudflare. The tarballs are tiny fixed gzip streams, not packages.
"""

from __future__ import annotations

import base64
import gzip
import importlib.util
import json
import sys
import tempfile
import types
from pathlib import Path


def load_upload_module(skill_dir: Path):
    # upload-r2.py imports boto3 and botocore at the top; they are not needed for upload()
    # once its S3 helpers are replaced, so stub them.
    boto3 = types.ModuleType("boto3")
    boto3.client = lambda *a, **k: None
    botocore = types.ModuleType("botocore")
    client = types.ModuleType("botocore.client")
    client.Config = lambda *a, **k: None
    exceptions = types.ModuleType("botocore.exceptions")

    class ClientError(Exception):
        pass

    exceptions.ClientError = ClientError
    sys.modules.update({"boto3": boto3, "botocore": botocore, "botocore.client": client, "botocore.exceptions": exceptions})
    spec = importlib.util.spec_from_file_location("upload_r2", skill_dir / "upload-r2.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def run_case(mod, case: dict) -> dict:
    bucket: dict[str, bytes] = {}
    writes: list[dict] = []
    app_id = case["app_id"]
    if case.get("root_before") is not None:
        bucket[f"{app_id}/manifest.json"] = case["root_before"].encode("utf-8")

    def put_file(s3, b, key, path, content_type):
        bucket[key] = Path(path).read_bytes()
        writes.append({"key": key, "content_type": content_type})

    def put_json(s3, b, key, obj):
        body = (json.dumps(obj, indent=2) + "\n").encode("utf-8")
        bucket[key] = body
        writes.append({"key": key, "content_type": "application/json"})

    def get_json(s3, b, key):
        raw = bucket.get(key)
        return None if raw is None else json.loads(raw.decode("utf-8"))

    mod.put_file, mod.put_json, mod.get_json = put_file, put_json, get_json
    mod.s3_client = lambda: None
    mod.require_env = lambda name: "fixture"

    tarball = gzip.compress(case["tarball_text"].encode("utf-8"), mtime=0)
    with tempfile.TemporaryDirectory() as tmp:
        dist = Path(tmp)
        (dist / "update.tar.gz").write_bytes(tarball)
        (dist / "manifest.json").write_text(case["version_manifest"], encoding="utf-8", newline="\n")
        mod.upload(case["version"], dist)

    return {
        **case,
        "tarball_b64": base64.b64encode(tarball).decode(),
        "writes": writes,
        "root_after": bucket[f"{app_id}/manifest.json"].decode("utf-8"),
    }


def version_manifest(app_id: str, version: str, description: str, released: str = "2026-10-21") -> str:
    # The shape build-package.py writes (json.dumps indent 2 + newline).
    doc = {
        "manifest_version": 1,
        "app_id": app_id,
        "version": version,
        "released": released,
        "description": description,
        "files": [{
            "source": "files/app.elf",
            "destination": "/usr/simulink/app.elf",
            "owner": "root",
            "group": "root",
            "mode": "0755",
            "sha256": "ab" * 32,
        }],
    }
    return json.dumps(doc, indent=2) + "\n"


def root(doc: dict) -> str:
    return json.dumps(doc, indent=2) + "\n"


def entry(version: str, **extra) -> dict:
    return {"version": version, "released": "2026-01-01", "description": f"old {version}",
            "tarball": f"v{version}/update.tar.gz", "manifest": f"v{version}/manifest.json",
            "size_bytes": 100, "sha256": "cd" * 32, **extra}


def main() -> int:
    skill = Path(sys.argv[1])
    mod = load_upload_module(skill)
    cases = [
        {"name": "first release of a new folder", "app_id": "lxfix-new", "version": "1.0.0",
         "root_before": None, "description": "First release"},
        {"name": "unknown fields are kept, newer version becomes latest", "app_id": "lxfix-keep", "version": "1.2.0",
         "root_before": root({"note": {"keep": "me"}, "app_id": "lxfix-keep", "latest_version": "1.1.0",
                              "versions": [entry("1.1.0", extra_field=True), entry("1.0.0")], "trailer": [1, 2]}),
         "description": "Adds the dashboard"},
        {"name": "pre-releases sort below their release, by suffix", "app_id": "lxfix-pre", "version": "1.0.1-beta",
         "root_before": root({"app_id": "lxfix-pre", "latest_version": "1.0.1",
                              "versions": [entry("0.9.9"), entry("1.0.1-r"), entry("1.0.0"), entry("1.0.1"),
                                           entry("0.9.10"), entry("1.0.1-alpha")]}),
         "description": "Beta"},
        {"name": "a lower version does not become latest", "app_id": "lxfix-low", "version": "1.0.5",
         "root_before": root({"app_id": "lxfix-low", "latest_version": "2.0.0", "versions": [entry("2.0.0"), entry("1.0.0")]}),
         "description": "Backport"},
        {"name": "replacing a version keeps one entry for it", "app_id": "lxfix-repl", "version": "1.1.0",
         "root_before": root({"app_id": "lxfix-repl", "latest_version": "1.1.0", "versions": [entry("1.1.0"), entry("1.0.0")]}),
         "description": "Rebuilt 1.1.0", "replace": True},
        {"name": "non-ASCII text is escaped as json.dumps does", "app_id": "lxfix-ascii", "version": "0.2.0",
         "root_before": root({"app_id": "lxfix-ascii", "latest_version": "0.1.0",
                              "versions": [entry("0.1.0", description="Première versie ✓")]}),
         "description": "Nieuwe functie: café-modus 🚀"},
        {"name": "odd versions already in the manifest sort as upload-r2.py does", "app_id": "lxfix-odd", "version": "0.0.1",
         "root_before": root({"app_id": "lxfix-odd", "latest_version": "1.x", "versions": [entry("1.x"), entry("1.2"), entry("0.0.1-rc")]}),
         "description": "Odd ones"},
    ]
    target = Path(sys.argv[2])
    out = []
    for c in cases:
        c["version_manifest"] = version_manifest(c["app_id"], c["version"], c["description"])
        c["tarball_text"] = f"tarball of {c['app_id']} {c['version']}"
        out.append(run_case(mod, c))
    # upload() prints its progress to stdout, so the fixtures go to a file of their own.
    text = json.dumps({"_about": "Generated by scripts/linux-root-fixtures.py from the skill's upload-r2.py; do not edit.",
                       "cases": out}, indent=2, ensure_ascii=False) + "\n"
    target.write_text(text, encoding="utf-8", newline="\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
