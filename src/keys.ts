// ECDSA P-256 signing keys: one per App ID (folder). A port of the key formats of
// GOcontroll-Deployment-Tool/tools/keys.py; normative in the S1 knowledge base,
// code-signing-local.md: the private key is the 32-byte P-256 scalar (base64, 44
// characters), the public key the 65-byte uncompressed point 0x04 || X || Y (hex, 130
// characters, upper case as keys.py writes it).
//
// The private key never leaves the Worker except once, as the backup of a key generated
// here. At rest it is sealed with AES-256-GCM under SIGNING_KEYS_KEY (Secrets Store
// DEPLOY_SIGNING_KEYS_KEY: 32 random bytes, base64), with `deploy-key:<APP_ID>` as additional
// authenticated data, so a sealed key cannot be moved to another folder. Stored format:
// "v1.<iv base64>.<ciphertext+tag base64>" (the style of GOcontroll-Suppliers' crypto.js).
// Reading the KEK from the Secrets Store, once per request, is src/vault.ts.
//
// No imports: scripts/goco-fixtures.mjs runs this file under Node for the Python cross-check.

export const PRIVATE_SCALAR_SIZE = 32;
export const PUBLIC_KEY_SIZE = 65;
const SEAL_VERSION = 'v1';
const KEK_NAME = 'DEPLOY_SIGNING_KEYS_KEY';

// The order n of P-256: a scalar must be 1 ≤ d < n.
const P256_ORDER = 'ffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551';

/** A key given for import that is not a P-256 private key in a known format (→ 422). */
export class KeyFormatError extends Error {}

/**
 * The key-encryption key cannot be used now: the store cannot be read, or the value is not
 * set or not 32 bytes. Answer 503 and write nothing; never treat it as "no key".
 */
export class KeyUnavailableError extends Error {}

/** A sealed key that does not open (other KEK, other folder, damaged). Never "no key" either. */
export class UnreadableKeyError extends Error {}

export interface KeyMaterial {
  scalar: Uint8Array<ArrayBuffer>;    // 32 bytes, big endian
  publicKey: Uint8Array<ArrayBuffer>; // 65 bytes, 0x04 || X || Y
}

const ECDSA = { name: 'ECDSA', namedCurve: 'P-256' } as const;

const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const b64url = (bytes: Uint8Array) => b64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64url = (s: string) => unb64(s.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(s.length / 4) * 4, '='));

export function publicKeyHex(publicKey: Uint8Array): string {
  let out = '';
  for (const b of publicKey) out += b.toString(16).padStart(2, '0');
  return out.toUpperCase();
}

/** 130 hex characters (optionally 0x-prefixed, any case) to the 65-byte point. */
export function parsePublicKeyHex(text: string): Uint8Array<ArrayBuffer> {
  const compact = text.replace(/\s+/g, '').replace(/^0x/i, '');
  if (!/^[0-9a-f]*$/i.test(compact) || compact.length !== PUBLIC_KEY_SIZE * 2) {
    throw new KeyFormatError(`A public key is ${PUBLIC_KEY_SIZE * 2} hex characters.`);
  }
  const raw = new Uint8Array(PUBLIC_KEY_SIZE);
  for (let i = 0; i < raw.length; i++) raw[i] = parseInt(compact.slice(i * 2, i * 2 + 2), 16);
  if (raw[0] !== 0x04) throw new KeyFormatError('A public key must start with 04 (an uncompressed point).');
  return raw;
}

// ── DER: just enough for P-256 private keys ─────────────────────────────────

const OID_EC_PUBLIC_KEY = [0x06, 0x07, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01];
const OID_P256 = [0x06, 0x08, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07];

function tlv(tag: number, content: Uint8Array | number[]): number[] {
  const body = [...content];
  if (body.length >= 0x80) throw new Error('DER length too long for this encoder');
  return [tag, body.length, ...body];
}

/** PKCS#8 PrivateKeyInfo for a P-256 scalar, without the public key (the runtime derives it). */
export function pkcs8FromScalar(scalar: Uint8Array): Uint8Array<ArrayBuffer> {
  const ecPrivateKey = tlv(0x30, [...tlv(0x02, [1]), ...tlv(0x04, scalar)]);
  return new Uint8Array(tlv(0x30, [...tlv(0x02, [0]), ...tlv(0x30, [...OID_EC_PUBLIC_KEY, ...OID_P256]), ...tlv(0x04, ecPrivateKey)]));
}

interface Der { tag: number; content: Uint8Array; end: number }

function readDer(data: Uint8Array, at: number): Der {
  if (at + 2 > data.length) throw new KeyFormatError('The key is cut short.');
  const tag = data[at];
  let len = data[at + 1];
  let start = at + 2;
  if (len & 0x80) {
    const n = len & 0x7f;
    if (n < 1 || n > 2 || start + n > data.length) throw new KeyFormatError('The key is not valid DER.');
    len = 0;
    for (let i = 0; i < n; i++) len = (len << 8) | data[start + i];
    start += n;
  }
  if (start + len > data.length) throw new KeyFormatError('The key is cut short.');
  return { tag, content: data.subarray(start, start + len), end: start + len };
}

/** The scalar of a SEC1 ECPrivateKey ("BEGIN EC PRIVATE KEY"), checking that its curve is P-256. */
function scalarFromSec1(der: Uint8Array): Uint8Array<ArrayBuffer> {
  const seq = readDer(der, 0);
  if (seq.tag !== 0x30) throw new KeyFormatError('The key is not an EC private key.');
  const version = readDer(seq.content, 0);
  if (version.tag !== 0x02 || version.content.length !== 1 || version.content[0] !== 1) throw new KeyFormatError('The key is not an EC private key.');
  const priv = readDer(seq.content, version.end);
  if (priv.tag !== 0x04) throw new KeyFormatError('The key is not an EC private key.');
  let at = priv.end;
  while (at < seq.content.length) {
    const field = readDer(seq.content, at);
    if (field.tag === 0xa0) {
      const oid = readDer(field.content, 0);
      if (oid.tag !== 0x06 || !sameBytes([...oid.content], OID_P256.slice(2))) {
        throw new KeyFormatError('The key is not an ECDSA P-256 (secp256r1) private key.');
      }
    }
    at = field.end;
  }
  if (priv.content.length > PRIVATE_SCALAR_SIZE) throw new KeyFormatError('The key is not an ECDSA P-256 (secp256r1) private key.');
  const scalar = new Uint8Array(PRIVATE_SCALAR_SIZE);
  scalar.set(priv.content, PRIVATE_SCALAR_SIZE - priv.content.length);
  return scalar;
}

const sameBytes = (a: number[], b: number[]) => a.length === b.length && a.every((x, i) => x === b[i]);

function checkScalar(scalar: Uint8Array): void {
  if (scalar.length !== PRIVATE_SCALAR_SIZE) throw new KeyFormatError(`A private key is ${PRIVATE_SCALAR_SIZE} bytes, got ${scalar.length}.`);
  let hex = '';
  for (const b of scalar) hex += b.toString(16).padStart(2, '0');
  if (/^0+$/.test(hex) || hex >= P256_ORDER) throw new KeyFormatError('That is not a valid P-256 private key.');
}

// ── Key material ─────────────────────────────────────────────────────────────

async function materialFromJwk(jwk: JsonWebKey): Promise<KeyMaterial> {
  if (jwk.kty !== 'EC' || jwk.crv !== 'P-256' || !jwk.d || !jwk.x || !jwk.y) throw new KeyFormatError('The key is not an ECDSA P-256 (secp256r1) private key.');
  const scalar = unb64url(jwk.d);
  const x = unb64url(jwk.x);
  const y = unb64url(jwk.y);
  if (scalar.length !== 32 || x.length !== 32 || y.length !== 32) throw new KeyFormatError('The key is not an ECDSA P-256 (secp256r1) private key.');
  const publicKey = new Uint8Array(PUBLIC_KEY_SIZE);
  publicKey[0] = 0x04;
  publicKey.set(x, 1);
  publicKey.set(y, 33);
  return { scalar, publicKey };
}

/** Scalar → key material, the public point derived by the runtime (PKCS#8 import, JWK export). */
export async function materialFromScalar(scalar: Uint8Array): Promise<KeyMaterial> {
  checkScalar(scalar);
  let key: CryptoKey;
  try {
    key = await crypto.subtle.importKey('pkcs8', pkcs8FromScalar(scalar), ECDSA, true, ['sign']);
  } catch {
    throw new KeyFormatError('That is not a valid P-256 private key.');
  }
  return materialFromJwk(await crypto.subtle.exportKey('jwk', key) as JsonWebKey);
}

/** A new P-256 key pair. */
export async function generateKey(): Promise<KeyMaterial> {
  const pair = await crypto.subtle.generateKey(ECDSA, true, ['sign', 'verify']) as CryptoKeyPair;
  return materialFromJwk(await crypto.subtle.exportKey('jwk', pair.privateKey) as JsonWebKey);
}

/**
 * Read a private key as keys.py load_private_key() does, minus file paths: a PEM (PKCS#8
 * "PRIVATE KEY" or SEC1 "EC PRIVATE KEY", also pasted on one line), the base64 scalar, or a
 * credentials document (.cred JSON) whose `private_key` holds either. Throws KeyFormatError.
 */
export async function parsePrivateKey(input: string): Promise<KeyMaterial> {
  let text = String(input ?? '').trim();
  if (!text) throw new KeyFormatError('Paste a private key.');

  if (text.startsWith('{')) {
    let doc: unknown;
    try {
      doc = JSON.parse(text);
    } catch {
      throw new KeyFormatError('The text is neither a key nor a credentials document.');
    }
    const key = doc && typeof doc === 'object' ? (doc as Record<string, unknown>).private_key : undefined;
    if (typeof key !== 'string' || !key.trim()) throw new KeyFormatError('The credentials document holds no private_key.');
    text = key.trim();
    if (text.startsWith('{')) throw new KeyFormatError('The private_key of the credentials document is not a key.');
  }

  if (text.includes('BEGIN') && text.includes('PRIVATE KEY')) {
    const match = /-----BEGIN ([A-Z ]+)-----([\s\S]*?)-----END \1-----/.exec(text);
    if (!match) throw new KeyFormatError('The PEM key could not be read.');
    const label = match[1];
    let der: Uint8Array;
    try {
      der = unb64(match[2].replace(/\s+/g, ''));
    } catch {
      throw new KeyFormatError('The PEM key could not be read.');
    }
    if (label === 'ENCRYPTED PRIVATE KEY') throw new KeyFormatError('The PEM key is encrypted; export it without a password.');
    if (label === 'EC PRIVATE KEY') return materialFromScalar(scalarFromSec1(der));
    if (label !== 'PRIVATE KEY') throw new KeyFormatError(`A "${label}" PEM is not a P-256 private key.`);
    let key: CryptoKey;
    try {
      key = await crypto.subtle.importKey('pkcs8', der as Uint8Array<ArrayBuffer>, ECDSA, true, ['sign']);
    } catch {
      throw new KeyFormatError('The key is not an ECDSA P-256 (secp256r1) private key.');
    }
    const material = await materialFromJwk(await crypto.subtle.exportKey('jwk', key) as JsonWebKey);
    checkScalar(material.scalar);
    return material;
  }

  const compact = text.replace(/\s+/g, '');
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(compact) || compact.length % 4) {
    throw new KeyFormatError('The private key is neither PEM nor valid base64.');
  }
  const scalar = unb64(compact);
  if (scalar.length !== PRIVATE_SCALAR_SIZE) throw new KeyFormatError(`A private key is ${PRIVATE_SCALAR_SIZE} bytes, got ${scalar.length}.`);
  return materialFromScalar(scalar);
}

/** The scalar as base64 (44 characters): the GitHub secret FW_PRIVATE_KEY_B64 format. */
export const scalarB64 = (scalar: Uint8Array) => b64(scalar);

/** The key as a PKCS#8 PEM, for those who keep a .pem. */
export async function privateKeyPem(material: KeyMaterial): Promise<string> {
  const key = await signingKey(material, true);
  const der = new Uint8Array(await crypto.subtle.exportKey('pkcs8', key) as ArrayBuffer);
  const body = b64(der).replace(/.{1,64}/g, '$&\n');
  return `-----BEGIN PRIVATE KEY-----\n${body}-----END PRIVATE KEY-----\n`;
}

/** A CryptoKey that signs with this key (JWK import: scalar plus its stored public point). */
export async function signingKey(material: KeyMaterial, extractable = false): Promise<CryptoKey> {
  const jwk: JsonWebKey = {
    kty: 'EC', crv: 'P-256', ext: extractable,
    d: b64url(material.scalar), x: b64url(material.publicKey.subarray(1, 33)), y: b64url(material.publicKey.subarray(33, 65)),
  };
  return crypto.subtle.importKey('jwk', jwk, ECDSA, extractable, ['sign']);
}

// ── Sealing ──────────────────────────────────────────────────────────────────

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

/** Seal a scalar for one folder: "v1.<iv>.<ciphertext+tag>". */
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
    if (plain.length !== PRIVATE_SCALAR_SIZE) throw new Error('length');
    return plain;
  } catch {
    throw new UnreadableKeyError(`the signing key of ${appId} does not open`);
  }
}
