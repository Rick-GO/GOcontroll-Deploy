// The private keys in the browser (public/js/signing.js): the formats of
// GOcontroll-Deployment-Tool/tools/keys.py, the key pair the Key generator makes and downloads,
// the check that a private key belongs to an application's public key, and a signature the
// Worker's container verifies. The fixed key is the test key of test/fixtures/goco (made by
// scripts/goco-fixtures.py), so its public key is Python's answer.

import { describe, expect, test } from 'vitest';
import { concat, headerWithSignature, parseContainer, sha256, signedScope } from '../src/goco';
import { parsePublicKeyHex } from '../src/keys';
import {
  KeyError, KeyMismatchError, checkPublicKey, fromBase64, generateKeyPair, keyPairFiles, readPrivateKey, readPublicKey, signScope, signerFor, toBase64,
} from '../public/js/signing.js';
import fixtures from './fixtures/goco/fixtures.json';

const KEY = fixtures.key;

describe('reading a private key (keys.py load_private_key)', () => {
  test('the base64 scalar, a PKCS#8 PEM (also on one line), a SEC1 PEM and a .cred document all give the same scalar', () => {
    const scalar = toBase64(readPrivateKey(KEY.private_b64));
    expect(scalar).toBe(KEY.private_b64);
    expect(toBase64(readPrivateKey(KEY.private_pem_pkcs8))).toBe(scalar);
    expect(toBase64(readPrivateKey(KEY.private_pem_pkcs8.replace(/\n/g, ' ')))).toBe(scalar);
    expect(toBase64(readPrivateKey(KEY.private_pem_sec1))).toBe(scalar);
    const cred = (k: string) => JSON.stringify({ provider: 'cloudflare', application_id: 'GOCO', private_key: k });
    expect(toBase64(readPrivateKey(cred(KEY.private_b64)))).toBe(scalar);
    expect(toBase64(readPrivateKey(cred(KEY.private_pem_pkcs8)))).toBe(scalar);
  });

  test('anything else is a KeyError', () => {
    const bad = [
      '', 'not a key', btoa('short'), JSON.stringify({ api_token: 'x' }), '{ broken',
      KEY.private_pem_other_curve, KEY.public_pem, KEY.public_hex,
      '-----BEGIN ENCRYPTED PRIVATE KEY-----\nAAAA\n-----END ENCRYPTED PRIVATE KEY-----',
      btoa(String.fromCharCode(...new Uint8Array(32))), // zero
      btoa(String.fromCharCode(...new Uint8Array(32).fill(0xff))), // ≥ n
    ];
    for (const text of bad) expect(() => readPrivateKey(text), text.slice(0, 40)).toThrow(KeyError);
    expect(() => readPrivateKey(KEY.public_hex)).toThrow(/public key/);
  });
});

describe('public keys', () => {
  test('hex, a .pub file or deploy/metadata.json; never a private key', async () => {
    expect(readPublicKey(KEY.public_hex.toLowerCase())).toBe(KEY.public_hex);
    expect(readPublicKey(`${KEY.public_hex}\n`)).toBe(KEY.public_hex);
    expect(readPublicKey(JSON.stringify({ public_key: KEY.public_hex }))).toBe(KEY.public_hex);
    expect(() => readPublicKey(KEY.private_pem_pkcs8)).toThrow(/private key/);
    expect(() => readPublicKey('04ABCD')).toThrow(KeyError);
    expect(() => readPublicKey(`02${KEY.public_hex.slice(2)}`)).toThrow(KeyError);
    expect(await checkPublicKey(KEY.public_hex)).toBe(true);
    expect(await checkPublicKey(`04${'11'.repeat(64)}`)).toBe(false);
  });
});

describe('the Key generator', () => {
  test('makes a P-256 pair in the formats of keys.py: base64 scalar, PKCS#8 PEM, public hex', async () => {
    const pair = await generateKeyPair();
    expect(pair.privateB64).toMatch(/^[A-Za-z0-9+/]{43}=$/);
    expect(pair.publicHex).toMatch(/^04[0-9A-F]{128}$/);
    expect(pair.privatePem).toMatch(/^-----BEGIN PRIVATE KEY-----\n[A-Za-z0-9+/=\n]+-----END PRIVATE KEY-----\n$/);
    expect(pair.privatePem.split('\n').every((l) => l.length <= 64)).toBe(true);
    expect(toBase64(readPrivateKey(pair.privatePem))).toBe(pair.privateB64);
    // Both forms of the private key belong to the public key.
    await signerFor(pair.privatePem, pair.publicHex);
    await signerFor(pair.privateB64, pair.publicHex);
    // keys.py read such a pair when the fixtures were made (scripts/goco-fixtures.mjs).
    expect(fixtures.browser_key_pair_read_by_python).toEqual({ pem: true, public: true });
  });

  test('downloads the files of s1_ble.py keygen --out <base>.pem: the PEM, and <base>.pub with the hex and a newline', async () => {
    const pair = await generateKeyPair();
    const [pem, pub] = keyPairFiles(pair, 'GOCO-signing-key');
    expect(pem).toMatchObject({ name: 'GOCO-signing-key.pem', text: pair.privatePem });
    expect(pub).toMatchObject({ name: 'GOCO-signing-key.pub', text: `${pair.publicHex}\n` });
  });
});

describe('signing for an application', () => {
  test('a private key that is not the public key\'s is refused before anything is signed', async () => {
    const other = await generateKeyPair();
    await expect(signerFor(other.privatePem, KEY.public_hex, 'GOCO')).rejects.toBeInstanceOf(KeyMismatchError);
    await expect(signerFor(KEY.private_b64, other.publicHex, 'GOCO')).rejects.toThrow(/does not belong to the public key of GOCO/);
  });

  test('the signature over the Worker\'s scope + payload makes a container that verifies (goco.ts)', async () => {
    const signer = await signerFor(KEY.private_pem_sec1, KEY.public_hex, 'GOCO');
    const payload = fromBase64(fixtures.payload_b64);
    for (const c of fixtures.cases) {
      const scope = signedScope({
        appId: c.app_id, version: c.version, compressedSize: payload.length, rawSize: fixtures.raw_size,
        payloadSha256: await sha256(payload), publicKey: parsePublicKeyHex(KEY.public_hex),
      });
      const signature = await signScope(signer, scope, payload);
      expect(signature.length).toBe(64);
      const { header } = await parseContainer(concat(headerWithSignature(scope, signature), payload));
      expect(header.headerVersion).toBe(c.app_id.length > 8 ? 0x05 : 0x03);
    }
  });
});
