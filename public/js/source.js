// @ts-check
// Firmware source files in the browser: what Publish and Sign send to the Worker.
//
// The Worker runs on Workers Free (10 ms CPU per request), so the image is prepared here and
// not there: a Motorola S-record is flattened into one image (gap fill 0xFF from 0x08000000),
// a raw .bin is taken as it is, an .elf is refused, and the image is compressed into a zlib
// stream (RFC 1950) with CompressionStream('deflate'). The Worker gets that payload plus the
// raw size and builds the GOCO header around it. A file that starts with "GOCO" is a
// ready-made container and goes to the Worker unchanged.
//
// A port of the parts of GOcontroll-Deployment-Tool/tools/goco.py the browser needs:
// parse_srec, srec_to_bin, version_from_name, parse_version, check_size and load_source.
// The container format has one producer and one reader in this repo, src/goco.ts.
// readHeaderPreview() below only reads the App ID and version out of a container to fill in
// the form; the Worker checks the whole header (CRC, sizes, SHA-256, signature).
//
// Pure functions (no DOM): test/source.test.ts runs them in workerd.

// STM32H573 flash layout: page 252 and up is EEPROM emulation and is never written.
export const STM32_FLASH_BASE = 0x08000000;
export const STM32_PROTECTED_BASE = 0x081F8000;
export const STM32_APP_MAX_SIZE = STM32_PROTECTED_BASE - STM32_FLASH_BASE;

/** Extensions read as Motorola S-record (as goco.load_source: ".hex" too). */
export const SREC_EXTENSIONS = ['.srec', '.s19', '.s28', '.s37', '.mot', '.hex'];

/** The file picker's accept list. */
export const ACCEPT = ['.bin', ...SREC_EXTENSIONS].join(',');

/** A source file, version or App ID that does not hold up. The message is meant for the colleague. */
export class SourceError extends Error {}

/** @param {number} n */
const hex8 = (n) => `0x${n.toString(16).toUpperCase().padStart(8, '0')}`;

// ── Motorola S-record ────────────────────────────────────────────────────────

/** Address bytes per record type; S1/S2/S3 carry data, the rest are checked and skipped. */
const ADDR_BYTES = /** @type {Record<string, number>} */ ({ 0: 2, 1: 2, 2: 3, 3: 4, 5: 2, 6: 3, 7: 4, 8: 3, 9: 2 });
const DATA_TYPES = new Set(['1', '2', '3']);

/** Value of one hex digit, or -1. @param {number} c  char code */
function nibble(c) {
  if (c >= 48 && c <= 57) return c - 48;
  if (c >= 65 && c <= 70) return c - 55;
  if (c >= 97 && c <= 102) return c - 87;
  return -1;
}

/**
 * @typedef {{ address: number, data: Uint8Array }} SrecRecord
 *   one data record (S1/S2/S3): its address and bytes
 */

/**
 * Parse an S-record file into its data records, in file order. The length field and the
 * checksum of every record are checked; S0/S5/S6/S7/S8/S9 are checked and skipped.
 * @param {string} text
 * @returns {SrecRecord[]}
 */
export function parseSrec(text) {
  /** @type {SrecRecord[]} */
  const records = [];
  let dataBytes = 0;
  const lines = text.split(/\r\n|\r|\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const n = i + 1;
    if (line[0] !== 'S') throw new SourceError(`Line ${n}: not an S-record (it does not start with "S").`);
    const type = line[1] ?? '';
    const addrLen = ADDR_BYTES[type];
    if (!addrLen) throw new SourceError(`Line ${n}: unknown record type S${type}.`);
    const hex = line.slice(2);
    if (hex.length % 2) throw new SourceError(`Line ${n}: not valid hex.`);
    const bytes = new Uint8Array(hex.length / 2);
    for (let j = 0; j < bytes.length; j++) {
      const hi = nibble(hex.charCodeAt(2 * j));
      const lo = nibble(hex.charCodeAt(2 * j + 1));
      if (hi < 0 || lo < 0) throw new SourceError(`Line ${n}: not valid hex.`);
      bytes[j] = (hi << 4) | lo;
    }
    if (bytes.length < 1 || bytes[0] !== bytes.length - 1) throw new SourceError(`Line ${n}: the length field does not match.`);
    let sum = 0;
    for (let j = 0; j < bytes.length - 1; j++) sum += bytes[j];
    if (((sum & 0xff) ^ 0xff) !== bytes[bytes.length - 1]) throw new SourceError(`Line ${n}: the checksum does not match.`);
    if (!DATA_TYPES.has(type)) continue;
    let address = 0;
    for (let j = 1; j <= addrLen && j < bytes.length; j++) address = address * 256 + bytes[j];
    const data = bytes.subarray(Math.min(1 + addrLen, bytes.length - 1), bytes.length - 1);
    dataBytes += data.length;
    records.push({ address, data });
  }
  if (!dataBytes) throw new SourceError('The S-record holds no data records.');
  return records;
}

/**
 * Flatten an S-record into one image starting at `base`. Gaps between the records
 * (alignment, space between sections) are filled with `gapFill`: 0xFF is what an ST-Link
 * leaves behind in erased flash. A record written twice keeps its last bytes.
 *
 * Unlike goco.srec_to_bin, the size is checked before the image is allocated (check_size
 * comes after it there): a stray record far out would otherwise take gigabytes of memory.
 *
 * @param {string} text
 * @param {number} [base]
 * @param {number} [gapFill]
 * @param {number} [maxSize]
 * @returns {{ image: Uint8Array, gaps: [number, number][] }}  every gap as [start address, length]
 */
export function srecToBin(text, base = STM32_FLASH_BASE, gapFill = 0xff, maxSize = STM32_APP_MAX_SIZE) {
  const records = parseSrec(text).filter((r) => r.data.length);
  let low = Infinity;
  let high = -1;
  for (const r of records) {
    low = Math.min(low, r.address);
    high = Math.max(high, r.address + r.data.length - 1);
  }
  if (low < base) throw new SourceError(`The S-record starts at ${hex8(low)}, before the base address ${hex8(base)}.`);
  checkSize(high - base + 1, maxSize);
  const image = new Uint8Array(high - base + 1).fill(gapFill);
  for (const r of records) image.set(r.data, r.address - base);
  /** @type {[number, number][]} */
  const gaps = [];
  const spans = records.map((r) => [r.address, r.address + r.data.length]).sort((a, b) => a[0] - b[0]);
  let end = low;
  for (const [start, stop] of spans) {
    if (start > end) gaps.push([end, start - end]);
    if (stop > end) end = stop;
  }
  return { image, gaps };
}

/**
 * Refuse an image that would reach into the protected EEPROM region.
 * @param {number} rawSize @param {number} [maxSize]
 */
export function checkSize(rawSize, maxSize = STM32_APP_MAX_SIZE) {
  if (rawSize > maxSize) {
    throw new SourceError(`The image is ${rawSize} bytes; at most ${maxSize} fit before the protected region at ${hex8(STM32_FLASH_BASE + maxSize)}.`);
  }
}

// ── Versions and App IDs ─────────────────────────────────────────────────────

/**
 * major.minor.patch, each 0–255 (one byte in the container header).
 * @param {string} text
 * @returns {[number, number, number]}
 */
export function parseVersion(text) {
  const parts = text.trim().split('.');
  if (parts.length !== 3 || parts.some((p) => !/^\d+$/.test(p))) {
    throw new SourceError('The version must be major.minor.patch, for example 1.2.3.');
  }
  const [major, minor, patch] = parts.map(Number);
  for (const [value, name] of /** @type {[number, string][]} */ ([[major, 'major'], [minor, 'minor'], [patch, 'patch']])) {
    if (value > 255) throw new SourceError(`The ${name} number of the version must be 0–255, not ${value}.`);
  }
  return [major, minor, patch];
}

// A build that writes "application_1.2.3.bin" has named its version already. The extension
// is optional, and starts with a letter so the fourth number of "app_1.2.3.4" is not taken
// for one (goco._VERSION_IN_NAME).
const VERSION_IN_NAME = /_(\d{1,3}\.\d{1,3}\.\d{1,3})(?:\.[A-Za-z][A-Za-z0-9]*)?$/;

/**
 * The version a firmware filename carries after its last underscore, normalised
 * ("app_01.2.3.bin" gives "1.2.3"), or null: also when a number does not fit in a byte.
 * @param {string} name  a filename; a path is cut down to its last part
 * @returns {string | null}
 */
export function versionFromName(name) {
  const base = name.split(/[\\/]/).pop() ?? '';
  const m = VERSION_IN_NAME.exec(base);
  if (!m) return null;
  try {
    return parseVersion(m[1]).join('.');
  } catch {
    return null;
  }
}

/**
 * Order two major.minor.patch strings (negative when a is lower); 0 when either is not a
 * version. Mirrors r2._version_key in the Deployment Tool.
 * @param {string} a @param {string} b
 */
export function compareVersions(a, b) {
  let x;
  let y;
  try {
    x = parseVersion(a);
    y = parseVersion(b);
  } catch {
    return 0;
  }
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
  return 0;
}

/**
 * Why a new folder's App ID will not do, or null. An App ID names the folder in the
 * bucket and goes into the container header: 1–32 printable ASCII characters, no spaces
 * and no "/" (cloud-r2-distribution.md §2). The Worker checks it again.
 * @param {string} appId
 */
export function appIdProblem(appId) {
  if (!appId) return 'Enter an App ID.';
  if (appId.length > 32) return 'An App ID is at most 32 characters.';
  if (/\s/.test(appId)) return 'An App ID has no spaces.';
  if (!/^[\x21-\x7e]+$/.test(appId)) return 'An App ID is plain ASCII: letters, digits and punctuation.';
  if (appId.includes('/')) return 'An App ID cannot contain "/".';
  return null;
}

// ── Containers (GOCO): a preview only, src/goco.ts reads them for real ─────────

/** Header version → [App ID field width, signed] (goco._FAMILIES). */
const FAMILIES = /** @type {Record<number, [number, boolean]>} */ ({ 2: [8, false], 3: [8, true], 4: [32, false], 5: [32, true] });

/** Whether the bytes start with the magic "GOCO". @param {Uint8Array} bytes */
export const isContainer = (bytes) => bytes.length >= 4 && bytes[0] === 0x47 && bytes[1] === 0x4f && bytes[2] === 0x43 && bytes[3] === 0x4f;

/**
 * @typedef {{ headerVersion: number, signed: boolean, appId: string, version: string,
 *   compressedSize: number, uncompressedSize: number }} HeaderPreview
 */

/**
 * What a container says about itself, to fill in the form: no CRC, size or signature
 * check (the Worker does those). Null when it is no container or its header version is
 * not one this reads.
 * @param {Uint8Array} bytes
 * @returns {HeaderPreview | null}
 */
export function readHeaderPreview(bytes) {
  if (!isContainer(bytes) || bytes.length < 5) return null;
  const family = FAMILIES[bytes[4]];
  if (!family) return null;
  const [width, signed] = family;
  const rest = 5 + width;
  if (bytes.length < rest + 11) return null;
  let appId = '';
  for (const b of bytes.subarray(5, rest)) appId += b < 0x80 ? String.fromCharCode(b) : '�';
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return {
    headerVersion: bytes[4],
    signed,
    appId: appId.replace(/\s+$/, ''),
    version: `${bytes[rest]}.${bytes[rest + 1]}.${bytes[rest + 2]}`,
    compressedSize: view.getUint32(rest + 3, true),
    uncompressedSize: view.getUint32(rest + 7, true),
  };
}

// ── Reading a chosen file ────────────────────────────────────────────────────

/**
 * @typedef {{
 *   kind: 'container' | 'raw',
 *   format: 'container' | 'srec' | 'bin',
 *   bytes: Uint8Array,
 *   rawSize: number,
 *   gaps: [number, number][],
 *   versionFromName: string | null,
 *   header: HeaderPreview | null,
 * }} Source
 *   kind container: `bytes` is the container, sent unchanged; rawSize is what its header
 *   says (0 when it cannot be read here). kind raw: `bytes` is the flat image, still to be
 *   compressed (compress()); gaps only for an S-record.
 */

/** ".srec" for "app_1.2.3.SREC". @param {string} name */
const extension = (name) => {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot).toLowerCase() : '';
};

/**
 * Read a chosen firmware file (goco.load_source).
 * @param {Blob & { name: string }} file
 * @returns {Promise<Source>}
 */
export async function readSource(file) {
  const ext = extension(file.name);
  if (ext === '.elf') {
    throw new SourceError('An .elf is not supported: provide a .bin or an .srec (objcopy -O binary or -O srec).');
  }
  const data = new Uint8Array(await file.arrayBuffer());
  if (!data.length) throw new SourceError('The file is empty.');
  const fromName = versionFromName(file.name);
  if (isContainer(data)) {
    const header = readHeaderPreview(data);
    return { kind: 'container', format: 'container', bytes: data, rawSize: header?.uncompressedSize ?? 0, gaps: [], versionFromName: fromName, header };
  }
  if (SREC_EXTENSIONS.includes(ext)) {
    // S-records are ASCII; anything else (decoded as U+FFFD) fails the hex check of its line.
    const { image, gaps } = srecToBin(new TextDecoder().decode(data));
    return { kind: 'raw', format: 'srec', bytes: image, rawSize: image.length, gaps, versionFromName: fromName, header: null };
  }
  checkSize(data.length);
  return { kind: 'raw', format: 'bin', bytes: data, rawSize: data.length, gaps: [], versionFromName: fromName, header: null };
}

/**
 * Compress an image into a zlib stream (RFC 1950: 'deflate' in CompressionStream is the
 * zlib format, not raw deflate): the payload of a container.
 * @param {Uint8Array} raw
 * @returns {Promise<Uint8Array>}
 */
export async function compress(raw) {
  const stream = new Blob([/** @type {Uint8Array<ArrayBuffer>} */ (raw)]).stream().pipeThrough(new CompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
