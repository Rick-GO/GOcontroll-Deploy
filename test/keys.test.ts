// The Worker's side of the signing keys (src/keys.ts): public keys in the format of
// GOcontroll-Deployment-Tool/tools/keys.py (code-signing-local.md), and the at-rest format of the
// sealed private keys of before 0.7.0, which stay in STATE but are opened by nothing. The private
// keys themselves are the browser's (public/js/signing.js, test/signing.test.ts).

import { describe, expect, test } from 'vitest';
import {
  KeyFormatError, KeyUnavailableError, UnreadableKeyError, checkedPublicKey, parsePublicKeyHex, publicKeyHex, sealScalar, unsealScalar,
} from '../src/keys';
import fixtures from './fixtures/goco/fixtures.json';
import { TEST_KEK } from './helpers';

const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const KEY = fixtures.key;

describe('public keys', () => {
  test('130 hex characters, starting with 04; upper case as keys.py writes it', () => {
    expect(publicKeyHex(parsePublicKeyHex(KEY.public_hex.toLowerCase()))).toBe(KEY.public_hex);
    expect(publicKeyHex(parsePublicKeyHex(`0x${KEY.public_hex}`))).toBe(KEY.public_hex);
    expect(() => parsePublicKeyHex('04ABCD')).toThrow(KeyFormatError);
    expect(() => parsePublicKeyHex(`02${KEY.public_hex.slice(2)}`)).toThrow(KeyFormatError);
  });

  test('to attach, a public key must also be a point on P-256', async () => {
    expect(await checkedPublicKey(` ${KEY.public_hex.toLowerCase()}\n`)).toBe(KEY.public_hex);
    await expect(checkedPublicKey(`04${'11'.repeat(64)}`)).rejects.toBeInstanceOf(KeyFormatError);
    await expect(checkedPublicKey(KEY.private_b64)).rejects.toBeInstanceOf(KeyFormatError);
  });
});

describe('the sealed keys of before 0.7.0', () => {
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

  test('a missing or short KEK is KeyUnavailableError, never "wrong key"', async () => {
    await expect(sealScalar(scalar, undefined, 'GOCO')).rejects.toBeInstanceOf(KeyUnavailableError);
    await expect(sealScalar(scalar, btoa('short'), 'GOCO')).rejects.toBeInstanceOf(KeyUnavailableError);
    const sealed = await sealScalar(scalar, TEST_KEK, 'GOCO');
    await expect(unsealScalar(sealed, undefined, 'GOCO')).rejects.toBeInstanceOf(KeyUnavailableError);
  });

  test('the KEK binding stays readable (test/setup.ts): /api/health says so', async () => {
    const { ok } = await import('./helpers');
    expect((await ok('GET', '/api/health')).signingKeys).toBe(true);
  });
});
