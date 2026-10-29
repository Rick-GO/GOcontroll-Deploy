// The GOcontroll firmware container (GOCO): the only producer and reader of the format in
// this repo. A port of GOcontroll-Deployment-Tool/tools/goco.py; the format is normative in
// the S1 knowledge base, cloud-r2-distribution.md §4 (when that changes, this file follows,
// together with its Python cross-check fixtures in test/fixtures/goco).
//
// Two families that differ only in the width of the App ID field at offset 5; the smallest
// that fits is picked (0x02/0x03 up to 8 characters, 0x04/0x05 up to 32), so an App ID of at
// most 8 characters keeps producing byte-identical 0x02/0x03 output for the controllers in
// the field.
//
// Since 0.7.0 Deploy holds no private key: the Worker builds the scope a signature covers
// (signedScope()), the browser signs it with the private key the colleague gives, and the
// Worker checks that signature against the folder's public key before it puts the header
// together (headerWithSignature(), verifySignature()). The bytes are the same as when the
// Worker signed itself (buildHeader() with a signer, which the fixtures still exercise).
//
// To keep the Worker's CPU time low, nothing here loops over the payload in JavaScript:
// SHA-256 and ECDSA run in crypto.subtle, concatenation is a native copy, the CRC covers only
// the header. The payload is a zlib stream the browser made (CompressionStream('deflate'));
// it is never inflated here.
//
// Plain erasable TypeScript without imports: scripts/goco-fixtures.mjs runs this file
// under Node to make the TS-signed fixtures the Python implementation verifies.

export const MAGIC = [0x47, 0x4f, 0x43, 0x4f]; // "GOCO"

export const VERSION_UNSIGNED = 0x02;
export const VERSION_SIGNED = 0x03;
export const VERSION_UNSIGNED_WIDE = 0x04;
export const VERSION_SIGNED_WIDE = 0x05;

export const PUBLIC_KEY_SIZE = 65; // uncompressed point: 0x04 || X || Y
export const SIGNATURE_SIZE = 64;  // raw R || S
export const APP_ID_SIZE = 8;
export const APP_ID_SIZE_WIDE = 32;

/** Per header version: App ID field width, common body size, signed. */
const FAMILIES: Record<number, { appIdSize: number; bodySize: number; signed: boolean }> = {
  [VERSION_UNSIGNED]: { appIdSize: APP_ID_SIZE, bodySize: 48 + APP_ID_SIZE, signed: false },
  [VERSION_SIGNED]: { appIdSize: APP_ID_SIZE, bodySize: 48 + APP_ID_SIZE, signed: true },
  [VERSION_UNSIGNED_WIDE]: { appIdSize: APP_ID_SIZE_WIDE, bodySize: 48 + APP_ID_SIZE_WIDE, signed: false },
  [VERSION_SIGNED_WIDE]: { appIdSize: APP_ID_SIZE_WIDE, bodySize: 48 + APP_ID_SIZE_WIDE, signed: true },
};

/** Wire size of the whole header of a version, CRC included. */
export function headerSize(headerVersion: number): number {
  const f = FAMILIES[headerVersion];
  if (!f) throw new GocoError(`header version 0x${hex2(headerVersion)} is not supported`);
  return f.bodySize + (f.signed ? PUBLIC_KEY_SIZE + SIGNATURE_SIZE : 0) + 2;
}

/** The longest header of any version (0x05): reading this many bytes always takes in a whole one. */
export const MAX_HEADER_SIZE = 211;

// STM32H573 flash layout: page 252 and up is EEPROM emulation and is never written.
export const STM32_FLASH_BASE = 0x08000000;
export const STM32_PROTECTED_BASE = 0x081f8000;
export const STM32_APP_MAX_SIZE = STM32_PROTECTED_BASE - STM32_FLASH_BASE;

/** A container, App ID or version that does not match the format. */
export class GocoError extends Error {}

const hex2 = (n: number) => n.toString(16).toUpperCase().padStart(2, '0');

export function toHex(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}

export function fromHex(text: string): Uint8Array {
  const clean = text.replace(/\s+/g, '');
  if (clean.length % 2 || /[^0-9a-f]/i.test(clean)) throw new GocoError('not valid hex');
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** a ‖ b ‖ …, as one native copy per part (no per-byte loop). */
export function concat(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

export function equalBytes(a: Uint8Array | null | undefined, b: Uint8Array | null | undefined): boolean {
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

// ── CRC-16/CCITT: identical to Crc16_Compute() on the ESP; only ever over a header ──

export function crc16ccitt(data: Uint8Array, init = 0xffff): number {
  let crc = init;
  for (const byte of data) {
    crc ^= byte << 8;
    for (let i = 0; i < 8; i++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc;
}

// ── Fields ───────────────────────────────────────────────────────────────────

/** The smallest header version this App ID fits in. */
export function pickVersion(appId: string, signed: boolean): number {
  const length = asciiLength(appId);
  if (length > APP_ID_SIZE_WIDE) throw new GocoError(`App ID may be at most ${APP_ID_SIZE_WIDE} ASCII characters, got ${length}`);
  const wide = length > APP_ID_SIZE;
  if (signed) return wide ? VERSION_SIGNED_WIDE : VERSION_SIGNED;
  return wide ? VERSION_UNSIGNED_WIDE : VERSION_UNSIGNED;
}

function asciiLength(text: string): number {
  if (/[^\x00-\x7f]/.test(text)) throw new GocoError('App ID must be ASCII');
  return text.length;
}

/** App ID as `width` ASCII bytes, right-padded with spaces. */
export function encodeAppId(appId: string, width: number): Uint8Array {
  const length = asciiLength(appId);
  if (length > width) throw new GocoError(`App ID may be at most ${width} ASCII characters in this header format, got ${length}`);
  const out = new Uint8Array(width).fill(0x20);
  for (let i = 0; i < length; i++) out[i] = appId.charCodeAt(i);
  return out;
}

/** The field back to the readable App ID without its padding. */
export function decodeAppId(raw: Uint8Array): string {
  let s = '';
  for (const b of raw) s += b < 0x80 ? String.fromCharCode(b) : '�';
  return s.replace(/\s+$/, '');
}

/** "major.minor.patch", each 0-255; leading zeros are dropped ("01.2.3" is 1.2.3). */
export function parseVersion(text: string): [number, number, number] {
  const parts = String(text).trim().split('.');
  if (parts.length !== 3) throw new GocoError(`version must be major.minor.patch, got "${text}"`);
  const nums = parts.map((p) => (/^\d{1,3}$/.test(p) ? Number(p) : NaN));
  if (nums.some((n) => Number.isNaN(n))) throw new GocoError(`version must consist of numbers, got "${text}"`);
  const names = ['major', 'minor', 'patch'];
  nums.forEach((n, i) => { if (n > 255) throw new GocoError(`version field ${names[i]} must be 0-255, got ${n}`); });
  return [nums[0], nums[1], nums[2]];
}

export const formatVersion = (v: readonly number[]) => `${v[0]}.${v[1]}.${v[2]}`;

// ── Reading ──────────────────────────────────────────────────────────────────

export interface GocoHeader {
  headerVersion: number;
  signed: boolean;
  appId: string;
  version: string;           // "major.minor.patch"
  compressedSize: number;
  uncompressedSize: number;
  sha256: Uint8Array;        // of the compressed payload
  publicKey: Uint8Array | null;
  signature: Uint8Array | null;
  headerSize: number;
  appIdSize: number;
  signatureScope: number;    // header bytes the signature covers; 0 when unsigned
}

export function isContainer(data: Uint8Array): boolean {
  return data.length >= 4 && MAGIC.every((b, i) => data[i] === b);
}

/**
 * Read the header at the start of `data`: magic, version, CRC and fields. `data` may stop
 * right after the header; the payload is not looked at. Throws GocoError on any deviation.
 */
export function readHeader(data: Uint8Array): GocoHeader {
  if (!isContainer(data)) throw new GocoError("not a GOcontroll container: magic 'GOCO' is missing");
  const headerVersion = data[4];
  const family = FAMILIES[headerVersion];
  if (!family) {
    throw new GocoError(`header version 0x${hex2(headerVersion ?? 0)} is not supported (expected 0x02, 0x03, 0x04, 0x05)`);
  }
  const { appIdSize, bodySize, signed } = family;
  const size = headerSize(headerVersion);
  if (data.length < size) throw new GocoError(`file is shorter (${data.length} bytes) than the header (${size})`);

  const crcOffset = size - 2;
  const stored = data[crcOffset] | (data[crcOffset + 1] << 8);
  const computed = crc16ccitt(data.subarray(0, crcOffset));
  if (stored !== computed) {
    throw new GocoError(`header CRC does not match: 0x${stored.toString(16).toUpperCase().padStart(4, '0')} in the file, 0x${computed.toString(16).toUpperCase().padStart(4, '0')} computed`);
  }

  const view = new DataView(data.buffer, data.byteOffset, size);
  const rest = 5 + appIdSize; // everything after the App ID field shifts with its width
  const signatureScope = signed ? bodySize + PUBLIC_KEY_SIZE : 0;
  return {
    headerVersion,
    signed,
    appId: decodeAppId(data.subarray(5, 5 + appIdSize)),
    version: formatVersion([data[rest], data[rest + 1], data[rest + 2]]),
    compressedSize: view.getUint32(rest + 3, true),
    uncompressedSize: view.getUint32(rest + 7, true),
    sha256: data.slice(rest + 11, rest + 43),
    publicKey: signed ? data.slice(bodySize, bodySize + PUBLIC_KEY_SIZE) : null,
    signature: signed ? data.slice(signatureScope, signatureScope + SIGNATURE_SIZE) : null,
    headerSize: size,
    appIdSize,
    signatureScope,
  };
}

export interface Container {
  header: GocoHeader;
  headerBytes: Uint8Array;
  payload: Uint8Array;
}

/**
 * Split and check a whole container: header, total size, payload SHA-256 and, when signed,
 * the signature against the public key in its own header. Throws GocoError.
 */
export async function parseContainer(data: Uint8Array): Promise<Container> {
  const header = readHeader(data);
  const expected = header.headerSize + header.compressedSize;
  if (data.length !== expected) throw new GocoError(`file size ${data.length} does not match the header (${expected})`);
  const headerBytes = data.subarray(0, header.headerSize);
  const payload = data.subarray(header.headerSize);
  if (!equalBytes(await sha256(payload), header.sha256)) throw new GocoError('SHA-256 of the payload does not match the header');
  if (header.signed && !(await verifySignature(header, headerBytes, payload))) {
    throw new GocoError('ECDSA P-256 signature is invalid');
  }
  return { header, headerBytes, payload };
}

/** Check the ECDSA P-256 signature of a signed header over its scope plus the payload. */
export async function verifySignature(header: GocoHeader, headerBytes: Uint8Array, payload: Uint8Array): Promise<boolean> {
  if (!header.signed || !header.publicKey || !header.signature) throw new GocoError('container is not signed');
  let key: CryptoKey;
  try {
    key = await crypto.subtle.importKey('raw', header.publicKey as Uint8Array<ArrayBuffer>, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
  } catch {
    return false; // not a point on P-256
  }
  const signed = concat(headerBytes.subarray(0, header.signatureScope), payload);
  return crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, header.signature as Uint8Array<ArrayBuffer>, signed);
}

// ── Building ─────────────────────────────────────────────────────────────────

export async function sha256(data: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', data as Uint8Array<ArrayBuffer>));
}

/** Magic, header version, App ID, version, sizes and SHA-256: everything before the key. */
export function commonBody(headerVersion: number, appId: string, version: readonly number[], compressedSize: number, rawSize: number, payloadSha256: Uint8Array): Uint8Array<ArrayBuffer> {
  const { appIdSize, bodySize } = FAMILIES[headerVersion];
  const body = new Uint8Array(bodySize);
  body.set(MAGIC, 0);
  body[4] = headerVersion;
  body.set(encodeAppId(appId, appIdSize), 5);
  const rest = 5 + appIdSize;
  body[rest] = version[0];
  body[rest + 1] = version[1];
  body[rest + 2] = version[2];
  const view = new DataView(body.buffer);
  view.setUint32(rest + 3, compressedSize, true);
  view.setUint32(rest + 7, rawSize, true);
  body.set(payloadSha256, rest + 11);
  return body;
}

export interface Signer {
  privateKey: CryptoKey;  // ECDSA P-256, usage sign
  publicKey: Uint8Array;  // the 65-byte uncompressed point that belongs to it
}

/** CRC-16 over everything before the last two bytes, written into them (little endian). */
function withCrc(header: Uint8Array<ArrayBuffer>): Uint8Array<ArrayBuffer> {
  const crc = crc16ccitt(header.subarray(0, header.length - 2));
  header[header.length - 2] = crc & 0xff;
  header[header.length - 1] = crc >> 8;
  return header;
}

/**
 * The header bytes a signature covers: the common body of the signed header version
 * (0x03/0x05) plus the public key. The ECDSA signature is over SHA-256(scope + the whole
 * compressed payload), the scope the ESP recomputes in FwVerifyEcdsaP256(). Whoever signs
 * (the Deployment Tool, or the browser with a private key Deploy never sees) signs exactly
 * these bytes followed by the payload; headerWithSignature() puts the result together.
 */
export function signedScope(opts: {
  appId: string;
  version: string;
  compressedSize: number;
  rawSize: number;
  payloadSha256: Uint8Array;
  publicKey: Uint8Array;
}): Uint8Array<ArrayBuffer> {
  const { appId, compressedSize, rawSize, payloadSha256, publicKey } = opts;
  if (!Number.isSafeInteger(rawSize) || rawSize < 0 || rawSize > 0xffffffff) throw new GocoError('raw size out of range');
  if (!Number.isSafeInteger(compressedSize) || compressedSize < 0 || compressedSize > 0xffffffff) throw new GocoError('compressed size out of range');
  if (payloadSha256.length !== 32) throw new GocoError('the payload SHA-256 must be 32 bytes');
  if (publicKey.length !== PUBLIC_KEY_SIZE || publicKey[0] !== 0x04) throw new GocoError('public key must be a 65-byte uncompressed point');
  const body = commonBody(pickVersion(appId, true), appId, parseVersion(opts.version), compressedSize, rawSize, payloadSha256);
  return concat(body, publicKey);
}

/** A signed header: its scope (signedScope()), the raw R || S signature over scope + payload, the CRC. */
export function headerWithSignature(scope: Uint8Array, signature: Uint8Array): Uint8Array<ArrayBuffer> {
  if (signature.length !== SIGNATURE_SIZE) throw new GocoError(`signature is ${signature.length} bytes, expected ${SIGNATURE_SIZE}`);
  return withCrc(concat(scope, signature, new Uint8Array(2)));
}

/**
 * The header for a compressed payload: unsigned (0x02/0x04) without `signer`, signed
 * (0x03/0x05) with it (signedScope() + headerWithSignature()); WebCrypto's ECDSA gives the
 * raw R || S the header carries.
 */
export async function buildHeader(opts: {
  appId: string;
  version: string;
  payload: Uint8Array;
  rawSize: number;
  signer?: Signer | null;
  payloadSha256?: Uint8Array;
}): Promise<Uint8Array<ArrayBuffer>> {
  const { appId, payload, rawSize, signer } = opts;
  if (!Number.isSafeInteger(rawSize) || rawSize < 0 || rawSize > 0xffffffff) throw new GocoError('raw size out of range');
  const digest = opts.payloadSha256 ?? (await sha256(payload));
  if (signer) {
    const scope = signedScope({ appId, version: opts.version, compressedSize: payload.length, rawSize, payloadSha256: digest, publicKey: signer.publicKey });
    const signature = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, signer.privateKey, concat(scope, payload)));
    return headerWithSignature(scope, signature);
  }
  const body = commonBody(pickVersion(appId, false), appId, parseVersion(opts.version), payload.length, rawSize, digest);
  return withCrc(concat(body, new Uint8Array(2)));
}

/**
 * Whether `payload` starts like a zlib stream (RFC 1950): deflate, a window that fits, a
 * header check that holds. CompressionStream('deflate') writes exactly that;
 * 'deflate-raw' or gzip would not, and the ESP inflates zlib.
 */
export function looksLikeZlib(payload: Uint8Array): boolean {
  if (payload.length < 2) return false;
  const cmf = payload[0];
  const flg = payload[1];
  return (cmf & 0x0f) === 8 && cmf >> 4 <= 7 && ((cmf << 8) | flg) % 31 === 0 && (flg & 0x20) === 0;
}
