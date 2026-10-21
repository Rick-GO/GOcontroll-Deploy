"""Fixtures for test/package.test.ts: public/js/package.js held against the CI producer.

The CI producer of Linux releases is build-package.py of the skill r2-application-deploy-setup
(GOcontroll-Claude-Skills). This script

  1. runs that build-package.py on a fixed input (a throw-away repo with
     .github/r2-deploy.config.json, the skill's post-install.sh.tmpl and the source files)
     and keeps its manifest.json, files/post-install.sh and update.tar.gz;
  2. builds the same release with public/js/package.js under Node (buildPackage(), fixed mtime);
  3. reads that browser-built tarball back with Python's tarfile (r:gz and plain r) and lists
     every member with its type, mode, owner, size and the SHA-256 of its bytes;

and writes test/fixtures/tar/fixture.json. Commit that file. Run it again when the skill's
scripts or package.js's tar writer change; the test then compares the current package.js with
what Python saw:

    python -I scripts/tar-fixture.py [--skill <path to r2-application-deploy-setup>]
"""

from __future__ import annotations

import argparse
import base64
import contextlib
import hashlib
import importlib.util
import io
import json
import shutil
import subprocess
import sys
import tarfile
import tempfile
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
DEFAULT_SKILL = REPO.parents[1] / "GOcontroll-Claude-Skills" / "r2-application-deploy-setup"
OUT = REPO / "test" / "fixtures" / "tar" / "fixture.json"

# The fixed release: non-ASCII in the description (json.dumps escapes it), a file of exactly
# one tar block, one that crosses block boundaries, an owner of its own, and a post-install
# that restarts two services.
INPUT = {
    "appId": "test-app",
    "version": "1.2.4",
    "released": "2026-10-21",
    "description": "Faster start-up – and “quoted” text, naïve ü \U0001F600",
    "owner": "root",
    "group": "root",
    "mtime": 1792540800,
    "services": ["nodered", "go-simulink"],
}
FILES = [
    ("flows.json", "/usr/node-red/flows.json", "0644", None, None, b'[{"id":"tab1","type":"tab","label":"Flow 1"}]\n'),
    ("app", "/usr/bin/app", "0755", "gocontroll", "gocontroll", bytes(range(256)) * 3 + b"\x00" * 700),
    ("exact512.bin", "/opt/test/exact512.bin", "0600", None, None, b"A" * 512),
    ("settings.js", "/usr/node-red/settings.js", "0640", None, "nodered", "module.exports = { uiPort: 1880 }; // é\n".encode()),
]

CRLF, LF = "\r\n", "\n"

NODE_BUILD = r"""
import { buildPackage } from %s;
let raw = '';
for await (const chunk of process.stdin) raw += chunk;
const input = JSON.parse(raw);
const contents = new Map(input.files.map((f) => [f.name, new Uint8Array(Buffer.from(f.base64, 'base64'))]));
const definition = {
  owner: input.owner,
  group: input.group,
  files: input.files.map((f) => ({ name: f.name, destination: f.destination, mode: f.mode,
    ...(f.owner ? { owner: f.owner } : {}), ...(f.group ? { group: f.group } : {}) })),
  post_install: { mode: 'services', services: input.services },
};
const b = await buildPackage({ appId: input.appId, version: input.version, released: input.released,
  description: input.description, definition, contents, mtime: input.mtime });
const b64 = (u) => Buffer.from(u).toString('base64');
process.stdout.write(JSON.stringify({ tarBase64: b64(b.tar), tarGzBase64: b64(b.tarGz), manifestText: b.manifestText, sha256: b.sha256 }));
"""


def listing(tar: tarfile.TarFile) -> list[dict]:
    """Every member as Python's tarfile sees it."""
    out = []
    for m in tar.getmembers():
        data = tar.extractfile(m).read() if m.isfile() else None
        out.append({
            "name": m.name,
            "type": "dir" if m.isdir() else "file" if m.isfile() else "other",
            "mode": m.mode,
            "uid": m.uid,
            "gid": m.gid,
            "uname": m.uname,
            "gname": m.gname,
            "size": m.size,
            "mtime": int(m.mtime),
            "sha256": hashlib.sha256(data).hexdigest() if data is not None else None,
        })
    return out


def run_build_package(skill: Path, work: Path) -> dict:
    """build-package.py on the fixed input, in a throw-away repo."""
    (work / ".github" / "scripts").mkdir(parents=True)
    (work / "src").mkdir()
    shutil.copyfile(skill / "post-install.sh.tmpl", work / ".github" / "scripts" / "post-install.sh.tmpl")
    files = []
    for name, destination, mode, owner, group, data in FILES:
        (work / "src" / name).write_bytes(data)
        entry = {"source": f"src/{name}", "destination": destination, "mode": mode}
        if owner:
            entry["owner"] = owner
        if group:
            entry["group"] = group
        files.append(entry)
    config = {
        "app_id": INPUT["appId"], "owner": INPUT["owner"], "group": INPUT["group"], "files": files,
        "post_install": {"enabled": True, "services": INPUT["services"]},
    }
    (work / ".github" / "r2-deploy.config.json").write_text(json.dumps(config, indent=2), encoding="utf-8")

    spec = importlib.util.spec_from_file_location("build_package", skill / "build-package.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    module.REPO_ROOT = work
    module.CONFIG_PATH = work / ".github" / "r2-deploy.config.json"
    module.TEMPLATE_PATH = work / ".github" / "scripts" / "post-install.sh.tmpl"
    dist = work / "dist"
    with contextlib.redirect_stdout(io.StringIO()):
        module.build(INPUT["version"], INPUT["released"], INPUT["description"], dist)

    tar_gz = (dist / "update.tar.gz").read_bytes()
    with tarfile.open(fileobj=io.BytesIO(tar_gz), mode="r:gz") as tar:
        members = listing(tar)
    return {
        # write_text() without newline= writes the platform's line ending: LF on the CI runner
        # (Linux), CRLF when this script runs on Windows. The manifest the CI writes has LF.
        "manifestText": (dist / "manifest.json").read_bytes().decode("utf-8").replace(CRLF, LF),
        "postInstall": (dist / "files" / "post-install.sh").read_bytes().decode("utf-8"),
        "tarGzBase64": base64.b64encode(tar_gz).decode("ascii"),
        "listing": members,
    }


def run_package_js(node_input: dict) -> dict:
    """public/js/package.js buildPackage() under Node, on the same input."""
    module_url = (REPO / "public" / "js" / "package.js").as_uri()
    script = NODE_BUILD % json.dumps(module_url)
    done = subprocess.run(
        ["node", "--input-type=module", "-e", script],
        input=json.dumps(node_input), capture_output=True, text=True, encoding="utf-8", check=False,
    )
    if done.returncode != 0:
        raise SystemExit(f"node failed:\n{done.stderr}")
    return json.loads(done.stdout)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--skill", type=Path, default=DEFAULT_SKILL, help="the r2-application-deploy-setup directory")
    args = parser.parse_args()
    skill = args.skill.resolve()
    for need in ("build-package.py", "post-install.sh.tmpl"):
        if not (skill / need).is_file():
            raise SystemExit(f"{skill / need} not found (pass --skill)")

    node_input = {**INPUT, "files": [
        {"name": n, "destination": d, "mode": m, "owner": o, "group": g, "base64": base64.b64encode(b).decode("ascii")}
        for n, d, m, o, g, b in FILES
    ]}
    with tempfile.TemporaryDirectory() as tmp:
        python_side = run_build_package(skill, Path(tmp))
    browser = run_package_js(node_input)

    tar_gz = base64.b64decode(browser["tarGzBase64"])
    with tarfile.open(fileobj=io.BytesIO(tar_gz), mode="r:gz") as tar:
        browser["pythonListing"] = listing(tar)
    with tarfile.open(fileobj=io.BytesIO(base64.b64decode(browser["tarBase64"])), mode="r:") as tar:
        plain = listing(tar)
    if plain != browser["pythonListing"]:
        raise SystemExit("tarfile reads the plain tar differently from the gzipped one")

    fixture = {
        "generatedBy": "python -I scripts/tar-fixture.py",
        "python": sys.version.split()[0],
        "template": (skill / "post-install.sh.tmpl").read_bytes().decode("utf-8"),
        "input": node_input,
        "buildPackagePy": python_side,
        "browser": browser,
    }
    OUT.parent.mkdir(parents=True, exist_ok=True)
    with OUT.open("w", encoding="utf-8", newline="\n") as f:
        json.dump(fixture, f, indent=2, ensure_ascii=False)
        f.write("\n")

    same_manifest = browser["manifestText"] == python_side["manifestText"]
    names = [m["name"] for m in browser["pythonListing"]]
    print(f"wrote {OUT.relative_to(REPO)}")
    print(f"  manifest.json identical to build-package.py: {same_manifest}")
    print(f"  tarfile reads the browser tarball as: {', '.join(names)}")
    return 0 if same_manifest else 1


if __name__ == "__main__":
    sys.exit(main())
