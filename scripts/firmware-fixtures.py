"""firmware-fixtures.py: what the module repos' CI writes, for test/fixtures/firmware/ci-manifests.json.

    python -I scripts/firmware-fixtures.py <publish_firmware.py> test/fixtures/firmware/ci-manifests.json
    (npm run fixtures:firmware, with the module repos next to GOcontroll-Team:
     ../../Module-4-20mA/.github/scripts/publish_firmware.py)

Runs the real publish_firmware.py (the GitHub Actions step of every Module-* repo, on a v* tag)
against an in-memory bucket: boto3 is replaced by a fake S3 client that records every write. Per
case: the bucket before, the .srec in a <hw>-BOOT folder, the tag's RELEASE_DATE and changelog, and
what the script wrote, in order, with the exact bytes. test/firmware.test.ts sends the same input to
POST /api/firmware and expects the same objects (modules/manifest.json apart from "updated", which
the script takes from the clock).

The cases publish in ascending version order, as the module-firmware-deployment skill prescribes:
there Deploy and the script agree. For an older version after a newer one they differ on purpose
(src/firmware.ts). Nothing here talks to Cloudflare.
"""

from __future__ import annotations

import base64
import io
import json
import os
import runpy
import sys
import tempfile
import types
from pathlib import Path


class FakeS3:
    def __init__(self, objects: dict[str, bytes]):
        self.objects = objects
        self.writes: list[dict] = []

    def head_object(self, Bucket, Key):  # noqa: N803 (boto3 names)
        if Key not in self.objects:
            raise ClientError("404")
        return {}

    def get_object(self, Bucket, Key):  # noqa: N803
        if Key not in self.objects:
            raise ClientError("NoSuchKey")
        return {"Body": io.BytesIO(self.objects[Key])}

    def put_object(self, Bucket, Key, Body, ContentType):  # noqa: N803
        self.objects[Key] = Body
        self.writes.append({"key": Key, "content_type": ContentType})

    def upload_fileobj(self, fh, bucket, key, ExtraArgs):  # noqa: N803
        self.objects[key] = fh.read()
        self.writes.append({"key": key, "content_type": ExtraArgs.get("ContentType")})


class ClientError(Exception):
    pass


def stub_boto(s3: FakeS3) -> None:
    boto3 = types.ModuleType("boto3")
    boto3.client = lambda *a, **k: s3
    botocore = types.ModuleType("botocore")
    config = types.ModuleType("botocore.config")
    config.Config = lambda *a, **k: None
    exceptions = types.ModuleType("botocore.exceptions")
    exceptions.ClientError = ClientError
    sys.modules.update({"boto3": boto3, "botocore": botocore, "botocore.config": config, "botocore.exceptions": exceptions})


def srec(text_seed: str) -> bytes:
    """A small, valid S-record (S0 header, S3 data records, S7 end), LF line ends."""
    def record(kind: str, addr: bytes, data: bytes) -> str:
        body = bytes([len(addr) + len(data) + 1]) + addr + data
        checksum = (~sum(body)) & 0xFF
        return f"S{kind}{body.hex().upper()}{checksum:02X}"

    lines = [record("0", b"\x00\x00", text_seed.encode()[:20])]
    payload = (text_seed * 8).encode()
    for i in range(0, len(payload), 16):
        lines.append(record("3", (0x08004000 + i).to_bytes(4, "big"), payload[i:i + 16]))
    lines.append(record("7", (0x08004000).to_bytes(4, "big"), b""))
    return ("\n".join(lines) + "\n").encode()


def run_case(script: Path, case: dict) -> dict:
    before = {k: v.encode("utf-8") for k, v in case["before"].items()}
    s3 = FakeS3(dict(before))
    stub_boto(s3)
    data = srec(case["srec_name"])
    with tempfile.TemporaryDirectory() as tmp:
        boot = Path(tmp) / case["boot_dir"]
        boot.mkdir()
        (boot / case["srec_name"]).write_bytes(data)
        env = {
            "R2_ACCESS_KEY_ID": "test", "R2_SECRET_ACCESS_KEY": "test", "R2_ACCOUNT_ID": "test",
            "R2_BUCKET_NAME": "gocontroll-firmware", "RELEASE_TAG": "v" + case["version"],
            "RELEASE_DATE": case["release_date"], "CHANGELOG": case["changelog"],
            "MODULE_NAME": case["module_name"], "DEPLOY_FILES": "",
        }
        old_env, old_cwd = dict(os.environ), os.getcwd()
        os.environ.update(env)
        os.chdir(tmp)
        try:
            runpy.run_path(str(script), run_name="__main__")
        finally:
            os.chdir(old_cwd)
            os.environ.clear()
            os.environ.update(old_env)
    after = {}
    for w in s3.writes:
        body = s3.objects[w["key"]]
        after[w["key"]] = base64.b64encode(body).decode() if w["key"].endswith(".srec") else body.decode("utf-8")
    return {**case, "srec_b64": base64.b64encode(data).decode(), "writes": s3.writes, "after": after}


MASTER = {
    "updated": "2026-08-17",
    "modules": [
        {"id": "20200207", "name": "6 Channel Output module", "hardware_version": "1.07", "latest_firmware": "2.3.1", "manifest": "modules/20200207/manifest.json"},
        {"id": "20100105", "name": "6 Channel Input module", "hardware_version": "1.05", "latest_firmware": "2.0.3", "manifest": "modules/20100105/manifest.json"},
    ],
}
MODULE_20200207 = {
    "id": "20200207", "name": "6 Channel Output module", "hardware_version": "1.07",
    "releases": [{"sw_version": "2.3.1", "file": "modules/20200207/20-20-2-7-2-3-1.srec", "date": "27/04/26", "sha256": "ab" * 32, "changelog": "Precharge — improvement"}],
}

CASES = [
    {
        "name": "a new hardware version of a known module type",
        "boot_dir": "V20100106-BOOT", "srec_name": "20-10-1-6-2-0-4.srec", "version": "2.0.4",
        "release_date": "27/10/26", "changelog": "Faster sampling\nFixes the offset at 0 mA",
        "module_name": "6 Channel Input module",
        "before": {"modules/manifest.json": json.dumps(MASTER, indent=2, ensure_ascii=False)},
    },
    {
        "name": "a newer release of an existing module",
        "boot_dir": "V20200207-BOOT", "srec_name": "20-20-2-7-2-3-2.srec", "version": "2.3.2",
        "release_date": "28/10/26", "changelog": "Groundshift détection tuned",
        "module_name": "6 Channel Output module",
        "before": {
            "modules/manifest.json": json.dumps(MASTER, indent=2, ensure_ascii=False),
            "modules/20200207/manifest.json": json.dumps(MODULE_20200207, indent=2, ensure_ascii=False),
        },
    },
    {
        "name": "the first module in an empty bucket",
        "boot_dir": "20100303-BOOT", "srec_name": "20-10-3-3-1-2-0.srec", "version": "1.2.0",
        "release_date": "01/11/26", "changelog": "Calibration per channel",
        "module_name": "4-20mA Input module",
        "before": {},
    },
]


def main() -> None:
    script, out = Path(sys.argv[1]).resolve(), Path(sys.argv[2])
    results = [run_case(script, c) for c in CASES]
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps({"script": script.name, "cases": results}, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"{len(results)} cases -> {out}")


if __name__ == "__main__":
    main()
