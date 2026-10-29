// Signing keys on the Worker's side: public keys only. Since 0.7.0 Deploy makes, imports and
// keeps no private key: the Key generator makes a pair in the browser (public/js/signing.js),
// the colleague keeps the private key, and the application's public key is stored here
// (STATE keys/<APP_ID>.json). A signed release is signed in the browser; the Worker checks the
// signature against this public key (src/release.ts).
//
// Formats of GOcontroll-Deployment-Tool/tools/keys.py (normative in the S1 knowledge base,
// code-signing-local.md): the public key is the 65-byte uncompressed point 0x04 || X || Y, as
// 130 hex characters, upper case.
//
// The sealed private keys of before 0.7.0. Until 0.6.1 a key generated or imported here was
// kept with its private key sealed (AES-256-GCM under SIGNING_KEYS_KEY, Secrets Store
// DEPLOY_SIGNING_KEYS_KEY, AAD `deploy-key:<APP_ID>`, "v1.<iv>.<ciphertext+tag>"). Those objects
// stay as they are (controllers in the field may carry their public keys) and the binding stays;
// nothing opens them now. sealScalar/unsealScalar remain as the definition of that format (and are
// tested against it) for the owner's decision on them: export them once, or keep them as fallback.
//
// No imports: scripts/goco-fixtures.mjs may run this file under Node.

export const PUBLIC_KEY_SIZE = 65;
const SEAL_VERSION = 'v1';
const KEK_NAME = 'DEPLOY_SIGNING_KEYS_KEY';

/** A public key that is not a P-256 point in the format of keys.py (→ 422). */
export class KeyFormatError extends Error {}

/** The key-encryption key of the sealed keys cannot be used now (store unreadable, not set, not 32 bytes). */
export class KeyUnavailableError extends Error {}

/** A sealed key that does not open (other KEK, other folder, damaged). */
export class UnreadableKeyError extends Error {}

const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

export function publicKeyHex(publicKey: Uint8Array): string {
  let out = '';
  for (const b of publicKey) out += b.toString(16).padStart(2, '0');
  return out.toUpperCase();
}

/** 130 hex characters (optionally 0x-prefixed, any case) to the 65-byte point. */
export function parsePublicKeyHex(text: string): Uint8Array<ArrayBuffer> {
  const compact = String(text ?? '').replace(/\s+/g, '').replace(/^0x/i, '');
  if (!/^[0-9a-f]*$/i.test(compact) || compact.length !== PUBLIC_KEY_SIZE * 2) {
    throw new KeyFormatError(`A public key is ${PUBLIC_KEY_SIZE * 2} hex characters.`);
  }
  const raw = new Uint8Array(PUBLIC_KEY_SIZE);
  for (let i = 0; i < raw.length; i++) raw[i] = parseInt(compact.slice(i * 2, i * 2 + 2), 16);
  if (raw[0] !== 0x04) throw new KeyFormatError('A public key must start with 04 (an uncompressed point).');
  return raw;
}

/**
 * A public key to attach to an application: the hex of parsePublicKeyHex() that is also a point
 * on P-256 (the runtime refuses to import anything else), as 130 upper-case hex characters.
 */
export async function checkedPublicKey(text: string): Promise<string> {
  const raw = parsePublicKeyHex(text);
  try {
    await crypto.subtle.importKey('raw', raw, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
  } catch {
    throw new KeyFormatError('That is not a point on the P-256 curve, so it is no public key of a signing key.');
  }
  return publicKeyHex(raw);
}

// ── The sealed keys of before 0.7.0 ─────────────────────────────────────────

const kekCache = new Map<string, CryptoKey>(); // base64 → CryptoKey

async function importKek(kekB64: string | undefined): Promise<CryptoKey> {
  if (!kekB64) throw new KeyUnavailableError(`${KEK_NAME} is not set`);
  const cached = kekCache.get(kekB64);
  if (cached) return cached;
  let raw: Uint8Array;
  try { raw = unb64(kekB64.trim()); } catch { raw = new Uint8Array(0); }
  if (raw.length !== 32) throw new KeyUnavailableError(`${KEK_NAME} must be 32 bytes, base64`);
  const key = await crypto.subtle.importKey('raw', raw as Uint8Array<ArrayBuffer>, 'AES-GCM', false, ['encrypt', 'decrypt']);
  kekCache.set(kekB64, key);
  return key;
}

const aad = (appId: string) => new TextEncoder().encode(`deploy-key:${appId}`);

/** Seal a scalar for one folder: "v1.<iv>.<ciphertext+tag>" (the format of keys/<APP_ID>.json until 0.6.1). */
export async function sealScalar(scalar: Uint8Array, kekB64: string | undefined, appId: string): Promise<string> {
  const key = await importKek(kekB64);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad(appId) }, key, scalar as Uint8Array<ArrayBuffer>));
  return `${SEAL_VERSION}.${b64(iv)}.${b64(ct)}`;
}

/** Inverse of sealScalar. KeyUnavailableError for a missing KEK, UnreadableKeyError otherwise. */
export async function unsealScalar(sealed: string, kekB64: string | undefined, appId: string): Promise<Uint8Array<ArrayBuffer>> {
  const [version, iv, ct, ...rest] = String(sealed).split('.');
  if (version !== SEAL_VERSION || !iv || !ct || rest.length) throw new UnreadableKeyError('unknown sealed key format');
  const key = await importKek(kekB64);
  try {
    const plain = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(iv), additionalData: aad(appId) }, key, unb64(ct)));
    if (plain.length !== 32) throw new Error('length');
    return plain;
  } catch {
    throw new UnreadableKeyError(`the signing key of ${appId} does not open`);
  }
}
