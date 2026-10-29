// @ts-check
// Signing keys in the browser. Since 0.7.0 a private key never reaches the Worker: the Key
// generator makes a pair here, the colleague keeps the private key (1Password, the .cred file of
// the Deployment Tool), and Deploy keeps only the public key, per application. To publish a
// signed S1 release the page reads the private key the colleague gives, checks here that it
// belongs to the application's public key, and signs the bytes the Worker hands it (the header
// scope of src/goco.ts signedScope(), followed by the compressed payload); only the 64-byte
// signature goes to the Worker, which checks it against the public key again before it writes.
//
// The formats are those of GOcontroll-Deployment-Tool/tools/keys.py (normative in the S1
// knowledge base, code-signing-local.md): the private key is the 32-byte P-256 scalar (base64,
// 44 characters, the CI secret FW_PRIVATE_KEY_B64) or a PKCS#8 PEM; the public key the 65-byte
// uncompressed point 04 || X || Y as 130 hex characters, upper case. `s1_ble.py keygen --out
// <name>.pem` writes the PEM and <name>.pub (the public hex and a newline); the download here is
// the same two files. readPrivateKey() takes what keys.py load_private_key() takes: a PEM (PKCS#8
// or SEC1, also pasted on one line), the base64 scalar, or a .cred document with private_key.
//
// No imports and no DOM: the tests (test/signing.test.ts) and scripts/goco-fixtures.mjs (under
// Node, for the Python cross-check) use this module as it is.

export const PRIVATE_SCALAR_SIZE = 32;
export const PUBLIC_KEY_SIZE = 65;
export const SIGNATURE_SIZE = 64;

const ECDSA = /** @type {const} */ ({ name: 'ECDSA', namedCurve: 'P-256' });
const ECDSA_SHA256 = /** @type {const} */ ({ name: 'ECDSA', hash: 'SHA-256' });
// The order n of P-256: a scalar must be 1 ≤ d < n.
const P256_ORDER = 'ffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551';

/** Text that is not a key in a format keys.py reads. */
export class KeyError extends Error {}

/** A private key that does not belong to the public key it is checked against. */
export class KeyMismatchError extends Error {}

// ── Bytes ────────────────────────────────────────────────────────────────────

/** @param {Uint8Array} bytes */
export const toBase64 = (bytes) => {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
};

/** @param {string} text @returns {Uint8Array<ArrayBuffer>} */
export const fromBase64 = (text) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));

/** @param {Uint8Array} bytes */
const b64url = (bytes) => toBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/** @param {string} s */
const unb64url = (s) => fromBase64(s.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(s.length / 4) * 4, '='));

/** @param {Uint8Array} bytes */
export const toHex = (bytes) => {
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
};

/** @param {string} hex @returns {Uint8Array<ArrayBuffer>} */
const fromHex = (hex) => {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
};

/** Left-pad to `size` bytes (a JWK coordinate or scalar is normally full length already). @param {Uint8Array<ArrayBuffer>} bytes @param {number} size */
const padTo = (bytes, size) => {
  if (bytes.length >= size) return bytes;
  const out = new Uint8Array(size);
  out.set(bytes, size - bytes.length);
  return out;
};

/** A PEM block with 64-character lines, as keys.py (cryptography) writes it. @param {string} label @param {Uint8Array} der */
const pem = (label, der) => `-----BEGIN ${label}-----\n${toBase64(der).replace(/.{1,64}/g, '$&\n')}-----END ${label}-----\n`;

// ── Public keys ──────────────────────────────────────────────────────────────

/**
 * A public key as Deploy keeps it: 130 hex characters, upper case, starting with 04. Takes the
 * hex (optionally 0x-prefixed, with white space), a .pub file of keys.py, or a JSON document
 * with "public_key" (deploy/metadata.json). Throws KeyError. Whether it is a point on P-256 is
 * checkPublicKey()'s job (asynchronous).
 * @param {string} text @returns {string}
 */
export function readPublicKey(text) {
  let t = String(text ?? '').trim();
  if (!t) throw new KeyError('Paste a public key.');
  if (t.startsWith('{')) {
    let doc;
    try { doc = JSON.parse(t); } catch { throw new KeyError('The text is neither a public key nor a JSON document with public_key.'); }
    const value = doc && typeof doc === 'object' ? /** @type {Record<string, unknown>} */ (doc).public_key : undefined;
    if (typeof value !== 'string') throw new KeyError('The JSON document holds no public_key.');
    t = value;
  }
  if (/PRIVATE KEY/.test(t)) throw new KeyError('That is a private key. Give the public key (130 hex characters, the .pub file); the private key stays with you.');
  const compact = t.replace(/\s+/g, '').replace(/^0x/i, '');
  if (!/^[0-9a-f]+$/i.test(compact) || compact.length !== PUBLIC_KEY_SIZE * 2) {
    throw new KeyError(`A public key is ${PUBLIC_KEY_SIZE * 2} hex characters (65 bytes: 04, then X and Y).`);
  }
  if (!/^04/.test(compact)) throw new KeyError('A public key starts with 04 (an uncompressed point).');
  return compact.toUpperCase();
}

/** Whether the public key (readPublicKey()'s form) is a point on P-256. @param {string} hex */
export async function checkPublicKey(hex) {
  try {
    await crypto.subtle.importKey('raw', fromHex(hex), ECDSA, false, ['verify']);
    return true;
  } catch {
    return false;
  }
}

// ── Generating ───────────────────────────────────────────────────────────────

/**
 * @typedef {{ privateB64: string, privatePem: string, publicHex: string }} KeyPair
 *   as keys.py KeyPair: private_b64 (44 characters: FW_PRIVATE_KEY_B64), private_pem (PKCS#8),
 *   public_hex (130 characters, upper case)
 */

/** A new P-256 key pair, made in this browser (keys.py generate()). @returns {Promise<KeyPair>} */
export async function generateKeyPair() {
  const pair = /** @type {CryptoKeyPair} */ (await crypto.subtle.generateKey(ECDSA, true, ['sign', 'verify']));
  const jwk = /** @type {JsonWebKey} */ (await crypto.subtle.exportKey('jwk', pair.privateKey));
  if (!jwk.d || !jwk.x || !jwk.y) throw new Error('The browser did not give the key pair out.');
  const der = new Uint8Array(/** @type {ArrayBuffer} */ (await crypto.subtle.exportKey('pkcs8', pair.privateKey)));
  return {
    privateB64: toBase64(padTo(unb64url(jwk.d), PRIVATE_SCALAR_SIZE)),
    privatePem: pem('PRIVATE KEY', der),
    publicHex: `04${toHex(padTo(unb64url(jwk.x), 32))}${toHex(padTo(unb64url(jwk.y), 32))}`.toUpperCase(),
  };
}

/**
 * The two files of `s1_ble.py keygen --out <base>.pem`: the PKCS#8 PEM, and <base>.pub with the
 * public key and a newline. @param {KeyPair} pair @param {string} base  file name without extension
 * @returns {{ name: string, text: string, type: string }[]}
 */
export const keyPairFiles = (pair, base) => [
  { name: `${base}.pem`, text: pair.privatePem, type: 'application/x-pem-file' },
  { name: `${base}.pub`, text: `${pair.publicHex}\n`, type: 'text/plain' },
];

// ── Reading a private key ────────────────────────────────────────────────────

const OID_EC_PUBLIC_KEY = [0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01];
const OID_P256 = [0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07];

/** @typedef {{ tag: number, content: Uint8Array, end: number }} Der */

/** One DER element at `at`. @param {Uint8Array} data @param {number} at @returns {Der} */
function readDer(data, at) {
  if (at + 2 > data.length) throw new KeyError('The key is cut short.');
  const tag = data[at];
  let len = data[at + 1];
  let start = at + 2;
  if (len & 0x80) {
    const n = len & 0x7f;
    if (n < 1 || n > 2 || start + n > data.length) throw new KeyError('The key is not valid DER.');
    len = 0;
    for (let i = 0; i < n; i++) len = (len << 8) | data[start + i];
    start += n;
  }
  if (start + len > data.length) throw new KeyError('The key is cut short.');
  return { tag, content: data.subarray(start, start + len), end: start + len };
}

/** @param {Uint8Array} a @param {number[]} b */
const sameBytes = (a, b) => a.length === b.length && b.every((x, i) => a[i] === x);

const NOT_P256 = 'The key is not an ECDSA P-256 (secp256r1) private key.';

/** The scalar of a SEC1 ECPrivateKey, checking a curve it names. @param {Uint8Array} der @returns {Uint8Array<ArrayBuffer>} */
function scalarFromSec1(der) {
  const seq = readDer(der, 0);
  if (seq.tag !== 0x30) throw new KeyError('The key is not an EC private key.');
  const version = readDer(seq.content, 0);
  if (version.tag !== 0x02 || version.content.length !== 1 || version.content[0] !== 1) throw new KeyError('The key is not an EC private key.');
  const priv = readDer(seq.content, version.end);
  if (priv.tag !== 0x04) throw new KeyError('The key is not an EC private key.');
  for (let at = priv.end; at < seq.content.length;) {
    const field = readDer(seq.content, at);
    if (field.tag === 0xa0) {
      const oid = readDer(field.content, 0);
      if (oid.tag !== 0x06 || !sameBytes(oid.content, OID_P256)) throw new KeyError(NOT_P256);
    }
    at = field.end;
  }
  if (priv.content.length > PRIVATE_SCALAR_SIZE) throw new KeyError(NOT_P256);
  const scalar = new Uint8Array(PRIVATE_SCALAR_SIZE);
  scalar.set(priv.content, PRIVATE_SCALAR_SIZE - priv.content.length);
  return scalar;
}

/** The scalar of a PKCS#8 PrivateKeyInfo for an EC P-256 key. @param {Uint8Array} der */
function scalarFromPkcs8(der) {
  const seq = readDer(der, 0);
  if (seq.tag !== 0x30) throw new KeyError('The key could not be read.');
  const version = readDer(seq.content, 0);
  if (version.tag !== 0x02) throw new KeyError('The key could not be read.');
  const alg = readDer(seq.content, version.end);
  if (alg.tag !== 0x30) throw new KeyError('The key could not be read.');
  const oid = readDer(alg.content, 0);
  if (oid.tag !== 0x06 || !sameBytes(oid.content, OID_EC_PUBLIC_KEY)) throw new KeyError(NOT_P256);
  const curve = readDer(alg.content, oid.end);
  if (curve.tag !== 0x06 || !sameBytes(curve.content, OID_P256)) throw new KeyError(NOT_P256);
  const inner = readDer(seq.content, alg.end);
  if (inner.tag !== 0x04) throw new KeyError('The key could not be read.');
  return scalarFromSec1(inner.content);
}

/** 1 ≤ d < n. @param {Uint8Array} scalar */
function checkScalar(scalar) {
  if (scalar.length !== PRIVATE_SCALAR_SIZE) throw new KeyError(`A private key is ${PRIVATE_SCALAR_SIZE} bytes, got ${scalar.length}.`);
  const hex = toHex(scalar);
  if (/^0+$/.test(hex) || hex >= P256_ORDER) throw new KeyError('That is not a valid P-256 private key.');
}

/**
 * Read a private key as keys.py load_private_key() does, minus file paths: a PEM (PKCS#8
 * "PRIVATE KEY" or SEC1 "EC PRIVATE KEY", also pasted on one line), the base64 scalar, or a .cred
 * document whose private_key holds either. Returns the 32-byte scalar; throws KeyError.
 * @param {string} input @returns {Uint8Array<ArrayBuffer>}
 */
export function readPrivateKey(input) {
  let text = String(input ?? '').trim();
  if (!text) throw new KeyError('Give the private key: paste it, or choose the file that holds it.');
  if (text.startsWith('{')) {
    let doc;
    try { doc = JSON.parse(text); } catch { throw new KeyError('The text is neither a key nor a credentials document.'); }
    const key = doc && typeof doc === 'object' ? /** @type {Record<string, unknown>} */ (doc).private_key : undefined;
    if (typeof key !== 'string' || !key.trim()) throw new KeyError('The credentials document holds no private_key.');
    text = key.trim();
    if (text.startsWith('{')) throw new KeyError('The private_key of the credentials document is not a key.');
  }

  if (text.includes('BEGIN') && text.includes('PRIVATE KEY')) {
    const match = /-----BEGIN ([A-Z ]+)-----([\s\S]*?)-----END \1-----/.exec(text);
    if (!match) throw new KeyError('The PEM key could not be read.');
    const label = match[1];
    if (label === 'ENCRYPTED PRIVATE KEY') throw new KeyError('The PEM key is encrypted; export it without a password.');
    let der;
    try { der = fromBase64(match[2].replace(/\s+/g, '')); } catch { throw new KeyError('The PEM key could not be read.'); }
    let scalar;
    if (label === 'EC PRIVATE KEY') scalar = scalarFromSec1(der);
    else if (label === 'PRIVATE KEY') scalar = scalarFromPkcs8(der);
    else throw new KeyError(`A "${label}" PEM is not a P-256 private key.`);
    checkScalar(scalar);
    return scalar;
  }

  if (/^[0-9A-F]{130}$/i.test(text.replace(/\s+/g, '')) && /^04/i.test(text.replace(/\s+/g, ''))) {
    throw new KeyError('That is a public key. Signing needs the private key that belongs to it.');
  }
  const compact = text.replace(/\s+/g, '');
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(compact) || compact.length % 4) throw new KeyError('The private key is neither PEM nor valid base64.');
  const scalar = fromBase64(compact);
  if (scalar.length !== PRIVATE_SCALAR_SIZE) throw new KeyError(`A private key is ${PRIVATE_SCALAR_SIZE} bytes, got ${scalar.length}.`);
  checkScalar(scalar);
  return scalar;
}

// ── Signing ──────────────────────────────────────────────────────────────────

/**
 * A key that signs for `publicHex`, from the private key the colleague gave. Refused
 * (KeyMismatchError) unless it belongs to that public key: a signature over random bytes must
 * verify against the public key, whatever the browser checks on import. The key is not
 * extractable; the text it came from is not kept here.
 * @param {string} privateKeyText  any form readPrivateKey() takes
 * @param {string} publicHex  the application's public key
 * @param {string} [appId]  for the message
 * @returns {Promise<CryptoKey>}
 */
export async function signerFor(privateKeyText, publicHex, appId = '') {
  const scalar = readPrivateKey(privateKeyText);
  const pub = fromHex(readPublicKey(publicHex));
  const mismatch = () => new KeyMismatchError(`This private key does not belong to the public key of ${appId || 'this application'}. Nothing was signed; use the private key that was made with this public key.`);
  /** @type {CryptoKey} */
  let key;
  try {
    key = await crypto.subtle.importKey('jwk', {
      kty: 'EC', crv: 'P-256', ext: false, d: b64url(scalar), x: b64url(pub.subarray(1, 33)), y: b64url(pub.subarray(33, 65)),
    }, ECDSA, false, ['sign']);
  } catch {
    throw mismatch(); // browsers that check the pair on import stop here
  } finally {
    scalar.fill(0);
  }
  const probe = crypto.getRandomValues(new Uint8Array(32));
  const verifier = await crypto.subtle.importKey('raw', pub, ECDSA, false, ['verify']);
  if (!(await crypto.subtle.verify(ECDSA_SHA256, verifier, await crypto.subtle.sign(ECDSA_SHA256, key, probe), probe))) throw mismatch();
  return key;
}

/**
 * The raw R || S signature (64 bytes) over the header scope the Worker gave followed by the
 * compressed payload: what goes into a signed GOCO header.
 * @param {CryptoKey} key @param {Uint8Array} scope @param {Uint8Array} payload
 * @returns {Promise<Uint8Array<ArrayBuffer>>}
 */
export async function signScope(key, scope, payload) {
  const data = new Uint8Array(scope.length + payload.length);
  data.set(scope, 0);
  data.set(payload, scope.length);
  const signature = new Uint8Array(await crypto.subtle.sign(ECDSA_SHA256, key, data));
  if (signature.length !== SIGNATURE_SIZE) throw new Error(`The browser made a signature of ${signature.length} bytes, not ${SIGNATURE_SIZE}.`);
  return signature;
}

/** The SHA-256 of `bytes`, as lower-case hex. @param {Uint8Array} bytes */
export async function sha256Hex(bytes) {
  return toHex(new Uint8Array(await crypto.subtle.digest('SHA-256', /** @type {Uint8Array<ArrayBuffer>} */ (bytes))));
}
