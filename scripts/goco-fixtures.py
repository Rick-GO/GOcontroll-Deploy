"""goco-fixtures.py: the Python side of the GOCO cross-check fixtures (test/fixtures/goco).

Run through scripts/goco-fixtures.mjs (`npm run fixtures:goco`), never on its own:

    python -I scripts/goco-fixtures.py <Deployment-Tool tools dir> make            > python.json
    python -I scripts/goco-fixtures.py <Deployment-Tool tools dir> verify <in.json> > verified.json

`make` builds, with the reference implementation (GOcontroll-Deployment-Tool/tools/goco.py and
keys.py), a fixed test key in every format keys.py reads, a zlib payload, and per App ID an
unsigned and a Python-signed container plus the header fields Python reads from them.
`verify` reads containers signed by src/goco.ts and checks each with goco.parse_header and
goco.verify_signature; it also reads the PEM backup src/keys.ts makes with keys.py.

The test key is derived from a fixed text: it signs nothing but these fixtures.
"""

from __future__ import annotations

import base64
import hashlib
import json
import sys
import zlib


def main() -> int:
    tools, mode = sys.argv[1], sys.argv[2]
    sys.path.insert(0, tools)
    import goco  # noqa: E402  (the Deployment Tool's reference implementation)
    import keys  # noqa: E402

    from cryptography.hazmat.primitives.asymmetric import ec
    from cryptography.hazmat.primitives.serialization import (
        Encoding, NoEncryption, PrivateFormat, PublicFormat)

    order = 0xFFFFFFFF00000000FFFFFFFFFFFFFFFFBCE6FAADA7179E84F3B9CAC2FC632551
    d = int.from_bytes(hashlib.sha256(b"GOcontroll Deploy test key - signs nothing but fixtures").digest(), "big") % order
    scalar = d.to_bytes(32, "big")
    private = ec.derive_private_key(d, ec.SECP256R1())

    def header_fields(data: bytes) -> dict:
        h = goco.read_header(data)
        return {
            "header_version": h.header_version,
            "app_id": h.app_id,
            "version": h.version_str,
            "compressed_size": h.compressed_size,
            "uncompressed_size": h.uncompressed_size,
            "sha256": h.sha256.hex(),
            "public_key": h.public_key.hex().upper() if h.public_key else None,
            "header_size": h.header_size,
            "crc": data[h.header_size - 2] | (data[h.header_size - 1] << 8),
        }

    if mode == "make":
        other = ec.generate_private_key(ec.SECP384R1())
        key = {
            "private_b64": base64.b64encode(scalar).decode(),
            "public_hex": keys.public_key_for(scalar).hex().upper(),
            "private_pem_pkcs8": private.private_bytes(Encoding.PEM, PrivateFormat.PKCS8, NoEncryption()).decode(),
            "private_pem_sec1": private.private_bytes(Encoding.PEM, PrivateFormat.TraditionalOpenSSL, NoEncryption()).decode(),
            "private_pem_other_curve": other.private_bytes(Encoding.PEM, PrivateFormat.PKCS8, NoEncryption()).decode(),
            "public_pem": private.public_key().public_bytes(Encoding.PEM, PublicFormat.SubjectPublicKeyInfo).decode(),
        }
        # Reading the formats back through keys.py proves they are what it accepts.
        for name in ("private_b64", "private_pem_pkcs8", "private_pem_sec1"):
            assert keys.load_private_key(key[name]) == scalar, name

        # A raw image with some structure (a vector table, code-like bytes, an erased gap).
        raw = bytes(range(256)) * 4 + b"\xff" * 700 + hashlib.sha256(b"code").digest() * 40
        payload = zlib.compress(raw, level=9)
        cases = []
        for app_id, version in (("GOCO", "1.2.3"), ("ABCDEFGH", "0.0.1"), ("ABCDEFGHI", "255.0.7"),
                                ("GOCONTROLL-DEPLOY-TEST-APP-32CHR", "2.10.100")):
            parts = goco.parse_version(version)
            unsigned = goco.build_unsigned(raw, app_id, parts)
            signed = goco.build_signed(raw, app_id, parts, scalar)
            goco.parse_header(signed)
            goco.verify_signature(signed, goco.read_header(signed))
            cases.append({
                "app_id": app_id,
                "version": version,
                "unsigned_b64": base64.b64encode(unsigned).decode(),
                "python_signed_b64": base64.b64encode(signed).decode(),
                "unsigned_header": header_fields(unsigned),
                "python_signed_header": header_fields(signed),
            })
        json.dump({
            "key": key,
            "raw_size": len(raw),
            "payload_b64": base64.b64encode(payload).decode(),
            "max_header_size": goco.MAX_HEADER_SIZE,
            "app_max_size": goco.STM32_APP_MAX_SIZE,
            "crc_check": {"input_hex": b"123456789".hex(), "crc": goco.crc16_ccitt(b"123456789")},
            "cases": cases,
        }, sys.stdout, indent=2)
        return 0

    if mode == "verify":
        with open(sys.argv[3], encoding="utf-8") as f:
            data = json.load(f)
        out = {"cases": [], "pem_backup": None}
        for case in data["cases"]:
            container = base64.b64decode(case["ts_signed_b64"])
            header = goco.parse_header(container)
            goco.verify_signature(container, header)  # raises when the signature does not hold
            out["cases"].append({"app_id": case["app_id"], "verified": True, "header": header_fields(container)})
        if data.get("pem_backup"):
            out["pem_backup"] = keys.load_private_key(data["pem_backup"]) == base64.b64decode(data["pem_backup_scalar_b64"])
        json.dump(out, sys.stdout, indent=2)
        return 0

    raise SystemExit(f"unknown mode {mode}")


if __name__ == "__main__":
    sys.exit(main())
