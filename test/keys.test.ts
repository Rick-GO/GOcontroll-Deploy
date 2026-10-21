// Signing keys: the formats of GOcontroll-Deployment-Tool/tools/keys.py (code-signing-local.md)
// and the sealing under the key-encryption key. The key pair below is the fixed test key of
// test/fixtures/goco (scripts/goco-fixtures.py), so its public key is Python's answer.

import { describe, expect, test } from 'vitest';
import {
  KeyFormatError, KeyUnavailableError, UnreadableKeyError, generateKey, materialFromScalar, parsePrivateKey,
  parsePublicKeyHex, pkcs8FromScalar, privateKeyPem, publicKeyHex, scalarB64, sealScalar, signingKey, unsealScalar,
} from '../src/keys';
import { keyVault } from '../src/vault';
import fixtures from './fixtures/goco/fixtures.json';
import { TEST_KEK } from './helpers';

const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const KEY = fixtures.key;

describe('import', () => {
  test('a base64 scalar gets its public point derived (PKCS#8 without public key, in workerd)', async () => {
    const m = await parsePrivateKey(KEY.private_b64);
    expect(publicKeyHex(m.publicKey)).toBe(KEY.public_hex);
    expect(scalarB64(m.scalar)).toBe(KEY.private_b64);
  });

  test('a PKCS#8 PEM, also pasted on one line', async () => {
    expect(publicKeyHex((await parsePrivateKey(KEY.private_pem_pkcs8)).publicKey)).toBe(KEY.public_hex);
    expect(publicKeyHex((await parsePrivateKey(KEY.private_pem_pkcs8.replace(/\n/g, ' '))).publicKey)).toBe(KEY.public_hex);
  });

  test('a SEC1 "EC PRIVATE KEY" PEM', async () => {
    expect(publicKeyHex((await parsePrivateKey(KEY.private_pem_sec1)).publicKey)).toBe(KEY.public_hex);
  });

  test('a .cred document with private_key (PEM or base64)', async () => {
    const cred = (k: string) => JSON.stringify({ provider: 'cloudflare', application_id: 'GOCO', private_key: k });
    expect(publicKeyHex((await parsePrivateKey(cred(KEY.private_b64))).publicKey)).toBe(KEY.public_hex);
    expect(publicKeyHex((await parsePrivateKey(cred(KEY.private_pem_pkcs8))).publicKey)).toBe(KEY.public_hex);
  });

  test('anything else is a KeyFormatError', async () => {
    const bad = [
      '', 'not a key', btoa('short'), JSON.stringify({ api_token: 'x' }), '{ broken',
      KEY.private_pem_other_curve, KEY.public_pem,
      '-----BEGIN ENCRYPTED PRIVATE KEY-----\nAAAA\n-----END ENCRYPTED PRIVATE KEY-----',
      btoa(String.fromCharCode(...new Uint8Array(32))), // zero
      btoa(String.fromCharCode(...new Uint8Array(32).fill(0xff))), // ≥ n
    ];
    for (const text of bad) await expect(parsePrivateKey(text), text.slice(0, 40)).rejects.toBeInstanceOf(KeyFormatError);
  });
});

describe('material', () => {
  test('generate makes a P-256 pair whose public key the runtime derives the same way', async () => {
    const m = await generateKey();
    expect(m.scalar.length).toBe(32);
    expect(m.publicKey.length).toBe(65);
    expect(m.publicKey[0]).toBe(4);
    expect(publicKeyHex((await materialFromScalar(m.scalar)).publicKey)).toBe(publicKeyHex(m.publicKey));
  });

  test('the backup PEM reads back to the same key (keys.py reads it too: scripts/goco-fixtures.py)', async () => {
    const m = await generateKey();
    const pem = await privateKeyPem(m);
    expect(pem).toMatch(/^-----BEGIN PRIVATE KEY-----\n[A-Za-z0-9+/=\n]+-----END PRIVATE KEY-----\n$/);
    expect(pem.split('\n').every((l) => l.length <= 64)).toBe(true);
    expect(publicKeyHex((await parsePrivateKey(pem)).publicKey)).toBe(publicKeyHex(m.publicKey));
    expect(publicKeyHex((await parsePrivateKey(scalarB64(m.scalar))).publicKey)).toBe(publicKeyHex(m.publicKey));
  });

  test('pkcs8FromScalar is the canonical 67-byte PrivateKeyInfo', () => {
    const der = pkcs8FromScalar(new Uint8Array(32).fill(1));
    expect(der.length).toBe(67);
    expect([...der.subarray(0, 4)]).toEqual([0x30, 0x41, 0x02, 0x01]);
  });

  test('signingKey signs what the public key verifies', async () => {
    const m = await parsePrivateKey(KEY.private_b64);
    const data = new TextEncoder().encode('firmware');
    const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, await signingKey(m), data);
    const pub = await crypto.subtle.importKey('raw', m.publicKey, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
    expect(await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, pub, sig, data)).toBe(true);
  });

  test('public key hex: 130 characters, starting with 04', () => {
    expect(publicKeyHex(parsePublicKeyHex(KEY.public_hex.toLowerCase()))).toBe(KEY.public_hex);
    expect(() => parsePublicKeyHex('04ABCD')).toThrow(KeyFormatError);
    expect(() => parsePublicKeyHex(`02${KEY.public_hex.slice(2)}`)).toThrow(KeyFormatError);
  });
});

describe('sealing', () => {
  const scalar = unb64(KEY.private_b64);

  test('seal/unseal round trip, v1.<iv>.<ct> with a fresh iv each time', async () => {
    const a = await sealScalar(scalar, TEST_KEK, 'GOCO');
    const b = await sealScalar(scalar, TEST_KEK, 'GOCO');
    expect(a).toMatch(/^v1\.[A-Za-z0-9+/=]{16}\.[A-Za-z0-9+/=]{64}$/);
    expect(a).not.toBe(b);
    expect([...(await unsealScalar(a, TEST_KEK, 'GOCO'))]).toEqual([...scalar]);
  });

  test('a sealed key is bound to its folder (AAD) and to the KEK', async () => {
    const sealed = await sealScalar(scalar, TEST_KEK, 'GOCO');
    await expect(unsealScalar(sealed, TEST_KEK, 'OTHER')).rejects.toBeInstanceOf(UnreadableKeyError);
    const otherKek = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));
    await expect(unsealScalar(sealed, otherKek, 'GOCO')).rejects.toBeInstanceOf(UnreadableKeyError);
    const [v, iv, ct] = sealed.split('.');
    const flipped = `${v}.${iv}.${ct.slice(0, 10)}${ct[10] === 'A' ? 'B' : 'A'}${ct.slice(11)}`;
    await expect(unsealScalar(flipped, TEST_KEK, 'GOCO')).rejects.toBeInstanceOf(UnreadableKeyError);
    await expect(unsealScalar(`v2.${iv}.${ct}`, TEST_KEK, 'GOCO')).rejects.toBeInstanceOf(UnreadableKeyError);
  });

  test('a missing, short or unreadable KEK is KeyUnavailableError, never "wrong key"', async () => {
    await expect(sealScalar(scalar, undefined, 'GOCO')).rejects.toBeInstanceOf(KeyUnavailableError);
    await expect(sealScalar(scalar, btoa('short'), 'GOCO')).rejects.toBeInstanceOf(KeyUnavailableError);
    const broken = { get: async () => { throw new Error('store down'); } } as unknown as SecretsStoreSecret;
    await expect(keyVault(broken).seal(scalar, 'GOCO')).rejects.toBeInstanceOf(KeyUnavailableError);
    const sealed = await sealScalar(scalar, TEST_KEK, 'GOCO');
    await expect(unsealScalar(sealed, undefined, 'GOCO')).rejects.toBeInstanceOf(KeyUnavailableError);
  });

  test('keyVault reads the Secrets Store binding (set up in test/setup.ts)', async () => {
    const { env } = await import('cloudflare:test');
    const vault = keyVault(env.SIGNING_KEYS_KEY);
    const sealed = await vault.seal(scalar, 'GOCO');
    expect([...(await unsealScalar(sealed, TEST_KEK, 'GOCO'))]).toEqual([...scalar]);
  });
});
