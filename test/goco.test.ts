// The GOCO container (src/goco.ts) against the reference implementation: every fixture in
// test/fixtures/goco/fixtures.json was made by GOcontroll-Deployment-Tool/tools/goco.py, or
// made here and verified there (scripts/goco-fixtures.mjs). All four header versions.

import { describe, expect, test } from 'vitest';
import {
  GocoError, MAX_HEADER_SIZE, STM32_APP_MAX_SIZE, buildHeader, concat, crc16ccitt, fromHex, headerSize, headerWithSignature, looksLikeZlib,
  parseContainer, parseVersion, pickVersion, readHeader, sha256, signedScope, toHex, verifySignature,
} from '../src/goco';
import { parsePublicKeyHex, publicKeyHex } from '../src/keys';
import { signScope, signerFor } from '../public/js/signing.js';
import fixtures from './fixtures/goco/fixtures.json';

const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const payload = unb64(fixtures.payload_b64);

/** The fields Python's read_header gives, as src/goco.ts reads them. */
function fields(data: Uint8Array) {
  const h = readHeader(data);
  return {
    header_version: h.headerVersion, app_id: h.appId, version: h.version, compressed_size: h.compressedSize,
    uncompressed_size: h.uncompressedSize, sha256: toHex(h.sha256), public_key: h.publicKey ? toHex(h.publicKey).toUpperCase() : null,
    header_size: h.headerSize, crc: data[h.headerSize - 2] | (data[h.headerSize - 1] << 8),
  };
}

test('constants match goco.py', () => {
  expect(MAX_HEADER_SIZE).toBe(fixtures.max_header_size);
  expect(STM32_APP_MAX_SIZE).toBe(fixtures.app_max_size);
  expect([0x02, 0x03, 0x04, 0x05].map(headerSize)).toEqual([58, 187, 82, 211]);
});

test('CRC-16/CCITT (init 0xFFFF, poly 0x1021) matches goco.py', () => {
  expect(crc16ccitt(fromHex(fixtures.crc_check.input_hex))).toBe(fixtures.crc_check.crc);
  expect(crc16ccitt(new TextEncoder().encode('123456789'))).toBe(0x29b1);
});

test('the fixture payload is a zlib stream', () => {
  expect(looksLikeZlib(payload)).toBe(true);
  expect(looksLikeZlib(new Uint8Array([0x1f, 0x8b, 8, 0]))).toBe(false); // gzip
  expect(looksLikeZlib(new Uint8Array([0xed, 0xbd]))).toBe(false);       // raw deflate
});

describe.each(fixtures.cases)('App ID $app_id, version $version', (c) => {
  test('unsigned: byte-identical to goco.py build_unsigned from the same compressed payload', async () => {
    const header = await buildHeader({ appId: c.app_id, version: c.version, payload, rawSize: fixtures.raw_size });
    const container = concat(header, payload);
    expect(toHex(container)).toBe(toHex(unb64(c.unsigned_b64)));
    expect(fields(container)).toEqual(c.unsigned_header);
    expect(c.unsigned_header.header_version).toBe(c.app_id.length > 8 ? 0x04 : 0x02);
    await parseContainer(container);
  });

  test('signed by goco.py: reads the same fields and the signature verifies here', async () => {
    const data = unb64(c.python_signed_b64);
    expect(fields(data)).toEqual(c.python_signed_header);
    expect(c.python_signed_header.header_version).toBe(c.app_id.length > 8 ? 0x05 : 0x03);
    expect(c.python_signed_header.public_key).toBe(fixtures.key.public_hex);
    const parsed = await parseContainer(data);
    expect(parsed.header.signed).toBe(true);
  });

  test('signed as the browser signs (committed): goco.py verified it, and it still verifies here', async () => {
    expect(c.ts_signed_verified_by_python).toBe(true);
    const data = unb64(c.ts_signed_b64);
    expect(fields(data)).toEqual(c.ts_signed_python_header);
    await parseContainer(data);
  });

  test('signed now as the browser signs: the scope is the header goco.py signed, up to the signature', async () => {
    const signer = await signerFor(fixtures.key.private_b64, fixtures.key.public_hex);
    const scope = signedScope({
      appId: c.app_id, version: c.version, compressedSize: payload.length, rawSize: fixtures.raw_size,
      payloadSha256: await sha256(payload), publicKey: parsePublicKeyHex(fixtures.key.public_hex),
    });
    const python = unb64(c.python_signed_b64);
    expect(toHex(scope)).toBe(toHex(python.subarray(0, readHeader(python).signatureScope)));
    const header = headerWithSignature(scope, await signScope(signer, scope, payload));
    expect(publicKeyHex(readHeader(header).publicKey!)).toBe(fixtures.key.public_hex);
    await parseContainer(concat(header, payload));
    // buildHeader with a signer (the format's reference) gives the same scope.
    const built = await buildHeader({ appId: c.app_id, version: c.version, payload, rawSize: fixtures.raw_size, signer: { privateKey: signer, publicKey: parsePublicKeyHex(fixtures.key.public_hex) } });
    expect(toHex(built.subarray(0, scope.length))).toBe(toHex(scope));
  });
});

describe('refusals', () => {
  const signed = unb64(fixtures.cases[0].python_signed_b64);

  test('magic, version, CRC and length are checked', () => {
    expect(() => readHeader(new TextEncoder().encode('ELF\x7f....'))).toThrow(/magic/);
    const v9 = signed.slice(); v9[4] = 0x09;
    expect(() => readHeader(v9)).toThrow(/0x09 is not supported/);
    const crc = signed.slice(); crc[10] ^= 1;
    expect(() => readHeader(crc)).toThrow(/CRC does not match/);
    expect(() => readHeader(signed.subarray(0, 100))).toThrow(/shorter/);
  });

  test('payload size and SHA-256, and a forged signature', async () => {
    await expect(parseContainer(concat(signed, new Uint8Array([0])))).rejects.toThrow(/does not match the header/);
    const flipped = signed.slice(); flipped[flipped.length - 1] ^= 1;
    await expect(parseContainer(flipped)).rejects.toThrow(/SHA-256/);
    const h = readHeader(signed);
    const badSig = signed.slice();
    badSig[h.signatureScope] ^= 1;
    const crc = crc16ccitt(badSig.subarray(0, h.headerSize - 2));
    badSig[h.headerSize - 2] = crc & 0xff; badSig[h.headerSize - 1] = crc >> 8;
    await expect(parseContainer(badSig)).rejects.toThrow(/signature is invalid/);
    expect(await verifySignature(readHeader(badSig), badSig.subarray(0, h.headerSize), badSig.subarray(h.headerSize))).toBe(false);
  });

  test('App ID and version limits', () => {
    expect(pickVersion('ABCDEFGH', false)).toBe(0x02);
    expect(pickVersion('ABCDEFGHI', true)).toBe(0x05);
    expect(() => pickVersion('X'.repeat(33), false)).toThrow(GocoError);
    expect(() => pickVersion('café', false)).toThrow(GocoError);
    expect(parseVersion('01.2.3')).toEqual([1, 2, 3]);
    for (const bad of ['1.2', '1.2.3.4', '256.0.0', 'a.b.c', '1.2.-3']) expect(() => parseVersion(bad), bad).toThrow(GocoError);
  });
});
