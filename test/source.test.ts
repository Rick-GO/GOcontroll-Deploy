// public/js/source.js: what the browser does to a firmware file before it goes to the
// Worker (S-record → image, version from the name, size check, compression). It is the
// browser's port of GOcontroll-Deployment-Tool/tools/goco.py; the S-record fixture below
// was checked against goco.srec_to_bin (same image, same gaps) while writing these tests.
// Runs in workerd, which has the same CompressionStream / DecompressionStream as a browser.

import { describe, expect, it } from 'vitest';
import {
  ACCEPT,
  STM32_APP_MAX_SIZE,
  STM32_FLASH_BASE,
  SourceError,
  appIdProblem,
  checkSize,
  compareVersions,
  compress,
  isContainer,
  parseSrec,
  parseVersion,
  readHeaderPreview,
  readSource,
  srecToBin,
  versionFromName,
} from '../public/js/source.js';

const ADDR_BYTES: Record<string, number> = { 0: 2, 1: 2, 2: 3, 3: 4, 5: 2, 6: 3, 7: 4, 8: 3, 9: 2 };

/** One S-record line with a correct length field and checksum. */
function rec(type: string, address: number, data: number[] = []): string {
  const addr: number[] = [];
  for (let i = ADDR_BYTES[type] - 1; i >= 0; i--) addr.push(Math.floor(address / 256 ** i) & 0xff);
  const body = [addr.length + data.length + 1, ...addr, ...data];
  const checksum = ~body.reduce((a, b) => a + b, 0) & 0xff;
  return `S${type}${[...body, checksum].map((b) => b.toString(16).toUpperCase().padStart(2, '0')).join('')}`;
}

const BASE = 0x08000000;

// Two gaps, one overlapping record (the later one wins), an S0 header and an S7 start address.
const FIXTURE = [
  rec('0', 0, [...new TextEncoder().encode('test')]),
  rec('3', BASE, [0x00, 0x01, 0x02, 0x03]),
  rec('3', BASE + 0x10, [0x10, 0x11]),
  rec('3', BASE + 0x11, [0xaa]),
  rec('3', BASE + 0x20, [0x20]),
  rec('7', BASE),
].join('\r\n');

// Wikipedia's S-record example ("hello world" for a 68k), an independent check of the
// length field and checksum arithmetic.
const WIKIPEDIA = `S00F000068656C6C6F202020202000003C
S11F00007C0802A6900100049421FFF07C6C1B787C8C23783C6000003863000026
S11F001C4BFFFFE5398000007D83637880010014382100107C0803A64E800020E9
S111003848656C6C6F20776F726C642E0A0042
S5030003F9
S9030000FC
`;

/** The error a function throws (the test fails when it throws none). */
function thrown(fn: () => unknown): Error {
  try {
    fn();
  } catch (err) {
    return err as Error;
  }
  throw new Error('expected an error');
}

describe('S-record parsing', () => {
  it('reads data records with their addresses and skips the others', () => {
    const records = parseSrec(WIKIPEDIA);
    expect(records.map((r) => r.address)).toEqual([0x0000, 0x001c, 0x0038]);
    expect(records.map((r) => r.data.length)).toEqual([28, 28, 14]);
    expect(new TextDecoder().decode(records[2].data.subarray(0, 12))).toBe('Hello world.');
  });

  it('reads S1, S2 and S3 address widths', () => {
    const records = parseSrec([rec('1', 0x1234, [1]), rec('2', 0x123456, [2]), rec('3', 0x08001234, [3])].join('\n'));
    expect(records.map((r) => [r.address, [...r.data]])).toEqual([[0x1234, [1]], [0x123456, [2]], [0x08001234, [3]]]);
  });

  it('flattens into one image from 0x08000000 with gaps filled with 0xFF', () => {
    const { image, gaps } = srecToBin(FIXTURE);
    expect(image.length).toBe(0x21);
    expect([...image.subarray(0, 4)]).toEqual([0, 1, 2, 3]);
    expect([...image.subarray(4, 16)]).toEqual(new Array(12).fill(0xff));
    expect(image[0x10]).toBe(0x10);
    expect(image[0x11]).toBe(0xaa); // the later record wins, as in goco's dict
    expect([...image.subarray(0x12, 0x20)]).toEqual(new Array(14).fill(0xff));
    expect(image[0x20]).toBe(0x20);
    expect(gaps).toEqual([[BASE + 4, 12], [BASE + 0x12, 14]]);
  });

  it('has no gaps for contiguous records, in any order', () => {
    const { image, gaps } = srecToBin([rec('3', BASE + 2, [3, 4]), rec('3', BASE, [1, 2])].join('\n'));
    expect([...image]).toEqual([1, 2, 3, 4]);
    expect(gaps).toEqual([]);
  });

  it('takes another gap fill and base when asked', () => {
    const { image, gaps } = srecToBin([rec('1', 0x0010, [1]), rec('1', 0x0012, [2])].join('\n'), 0x0010, 0x00);
    expect([...image]).toEqual([1, 0, 2]);
    expect(gaps).toEqual([[0x11, 1]]);
  });

  it('refuses a record whose checksum does not match, naming its line', () => {
    const bad = FIXTURE.split('\r\n');
    bad[2] = bad[2].slice(0, -2) + (bad[2].endsWith('00') ? '01' : '00');
    const err = thrown(() => srecToBin(bad.join('\n')));
    expect(err).toBeInstanceOf(SourceError);
    expect(err.message).toBe('Line 3: the checksum does not match.');
  });

  it('refuses a length field that does not match', () => {
    const line = rec('1', 0, [1, 2]);
    const err = thrown(() => parseSrec(`S1${(4).toString(16).padStart(2, '0')}${line.slice(4)}`));
    expect(err.message).toBe('Line 1: the length field does not match.');
  });

  it('refuses lines that are not S-records, unknown types and bad hex', () => {
    expect(thrown(() => parseSrec(`${rec('1', 0, [1])}\n:10000000`)).message).toBe('Line 2: not an S-record (it does not start with "S").');
    expect(thrown(() => parseSrec('S4030000FC')).message).toBe('Line 1: unknown record type S4.');
    expect(thrown(() => parseSrec('S')).message).toBe('Line 1: unknown record type S.');
    expect(thrown(() => parseSrec('S1030000FG')).message).toBe('Line 1: not valid hex.');
    expect(thrown(() => parseSrec('S1030000F')).message).toBe('Line 1: not valid hex.');
  });

  it('skips blank lines and accepts lower-case hex', () => {
    expect(parseSrec(`\n\n${rec('1', 0, [0xab]).toLowerCase().replace(/^s/, 'S')}\n\n`)[0].data[0]).toBe(0xab);
  });

  it('refuses a file without data records', () => {
    expect(thrown(() => parseSrec([rec('0', 0, [1]), rec('9', 0)].join('\n'))).message).toBe('The S-record holds no data records.');
  });

  it('refuses data below the base address', () => {
    expect(thrown(() => srecToBin(WIKIPEDIA)).message).toBe('The S-record starts at 0x00000000, before the base address 0x08000000.');
  });

  it('refuses an image reaching into the protected region, before allocating it', () => {
    const far = [rec('3', BASE, [1]), rec('3', BASE + STM32_APP_MAX_SIZE, [2])].join('\n');
    expect(thrown(() => srecToBin(far)).message).toMatch(/^The image is 2064385 bytes; at most 2064384 fit before the protected region at 0x081F8000\.$/);
    const fits = srecToBin([rec('3', BASE, [1]), rec('3', BASE + STM32_APP_MAX_SIZE - 1, [2])].join('\n'));
    expect(fits.image.length).toBe(STM32_APP_MAX_SIZE);
    // A stray record gigabytes away fails fast instead of taking the memory.
    expect(() => srecToBin([rec('3', BASE, [1]), rec('3', 0xfffffff0, [2])].join('\n'))).toThrow(SourceError);
  });
});

describe('size check', () => {
  it('allows up to 0x081F8000 - 0x08000000 bytes', () => {
    expect(STM32_APP_MAX_SIZE).toBe(0x1f8000);
    expect(() => checkSize(STM32_APP_MAX_SIZE)).not.toThrow();
    expect(() => checkSize(STM32_APP_MAX_SIZE + 1)).toThrow(SourceError);
  });
});

describe('version from the filename (Deployment Tool README, "The version comes from the filename")', () => {
  it.each([
    ['application_1.2.3.bin', '1.2.3'],
    ['application_1.2.3', '1.2.3'], // the extension is optional
    ['application_256.0.0.bin', null], // each number has to fit in a byte
    ['application_255.255.255.srec', '255.255.255'],
    ['app_1.2.3.4', null], // an extension starts with a letter: the 4th number is no extension
    ['app_1.2.3.4.bin', null],
    ['app_1.2.3.s19', '1.2.3'],
    ['app_1.2.3.S37', '1.2.3'],
    ['app_01.002.3.bin', '1.2.3'], // normalised
    ['app_1000.0.0.bin', null],
    ['app_1.2.bin', null],
    ['app_1.2.3.tar.gz', null],
    ['app-1.2.3.bin', null], // no underscore
    ['application.bin', null],
    ['my_app_2.0.1.mot', '2.0.1'], // after the last underscore
    ['app_1.2.3_4.5.6.bin', '4.5.6'],
    ['C:\\builds\\app_1.2.3.srec', '1.2.3'], // a path is cut down to its name
    ['builds/v_9.9.9/app.bin', null],
  ])('%s → %s', (name, expected) => {
    expect(versionFromName(name)).toBe(expected);
  });
});

describe('versions and App IDs', () => {
  it('parses major.minor.patch within a byte', () => {
    expect(parseVersion(' 1.2.3 ')).toEqual([1, 2, 3]);
    expect(parseVersion('0.0.0')).toEqual([0, 0, 0]);
    expect(thrown(() => parseVersion('1.2')).message).toBe('The version must be major.minor.patch, for example 1.2.3.');
    expect(thrown(() => parseVersion('1.2.x')).message).toBe('The version must be major.minor.patch, for example 1.2.3.');
    expect(thrown(() => parseVersion('1.-2.3')).message).toBe('The version must be major.minor.patch, for example 1.2.3.');
    expect(thrown(() => parseVersion('1.256.3')).message).toBe('The minor number of the version must be 0–255, not 256.');
  });

  it('orders versions numerically', () => {
    expect(compareVersions('1.2.10', '1.2.9')).toBe(1);
    expect(compareVersions('1.2.3', '1.10.0')).toBe(-1);
    expect(compareVersions('2.0.0', '2.0.0')).toBe(0);
    expect(compareVersions('nonsense', '1.0.0')).toBe(0);
  });

  it('checks the App ID of a new folder', () => {
    expect(appIdProblem('GOCOXYZ')).toBeNull();
    expect(appIdProblem('A'.repeat(32))).toBeNull();
    expect(appIdProblem('KRAKER-TRAILERS-2026')).toBeNull();
    expect(appIdProblem('')).toBe('Enter an App ID.');
    expect(appIdProblem('A'.repeat(33))).toBe('An App ID is at most 32 characters.');
    expect(appIdProblem('GOCO XYZ')).toBe('An App ID has no spaces.');
    expect(appIdProblem('GOCO/XYZ')).toBe('An App ID cannot contain "/".');
    expect(appIdProblem('GOCOÄ')).toBe('An App ID is plain ASCII: letters, digits and punctuation.');
  });
});

/** A container header of family 0x02–0x05 (CRC and hash not filled in: the preview reads neither). */
function header(version: number, appId: string, width: number, ver: [number, number, number], compressed: number, raw: number): Uint8Array {
  const signed = version === 0x03 || version === 0x05;
  const size = 48 + width + (signed ? 65 + 64 : 0) + 2;
  const out = new Uint8Array(size);
  out.set(new TextEncoder().encode('GOCO'), 0);
  out[4] = version;
  out.set(new TextEncoder().encode(appId.padEnd(width, ' ')), 5);
  out.set(ver, 5 + width);
  const view = new DataView(out.buffer);
  view.setUint32(5 + width + 3, compressed, true);
  view.setUint32(5 + width + 7, raw, true);
  return out;
}

describe('container preview', () => {
  it('reads App ID, version and sizes of both families', () => {
    expect(readHeaderPreview(header(0x02, 'GOCOXYZ', 8, [1, 2, 3], 100, 200))).toEqual({
      headerVersion: 2, signed: false, appId: 'GOCOXYZ', version: '1.2.3', compressedSize: 100, uncompressedSize: 200,
    });
    const wide = readHeaderPreview(header(0x05, 'KRAKER-TRAILERS-MAIN', 32, [4, 5, 6], 1, 2));
    expect(wide).toMatchObject({ headerVersion: 5, signed: true, appId: 'KRAKER-TRAILERS-MAIN', version: '4.5.6' });
  });

  it('gives null for no container, an unknown header version or too few bytes', () => {
    expect(readHeaderPreview(new Uint8Array([1, 2, 3, 4, 5]))).toBeNull();
    expect(readHeaderPreview(header(0x07 as number, 'X', 8, [1, 0, 0], 0, 0))).toBeNull();
    expect(readHeaderPreview(header(0x02, 'X', 8, [1, 0, 0], 0, 0).subarray(0, 20))).toBeNull();
    expect(isContainer(new TextEncoder().encode('GOC'))).toBe(false);
  });
});

describe('reading a chosen file', () => {
  it('refuses an .elf and an empty file', async () => {
    await expect(readSource(new File([new Uint8Array([0x7f, 0x45])], 'app_1.2.3.ELF'))).rejects.toThrow('An .elf is not supported');
    await expect(readSource(new File([], 'app.bin'))).rejects.toThrow('The file is empty.');
  });

  it('passes a GOCO container through unchanged, whatever its extension', async () => {
    const bytes = new Uint8Array([...header(0x02, 'GOCOXYZ', 8, [1, 2, 3], 3, 9), 1, 2, 3]);
    const s = await readSource(new File([bytes], 'GOCOXYZ-1.2.4.srec'));
    expect(s.kind).toBe('container');
    expect([...s.bytes]).toEqual([...bytes]);
    expect(s.rawSize).toBe(9);
    expect(s.header?.version).toBe('1.2.3');
    expect(s.versionFromName).toBeNull(); // "-1.2.4" has no underscore
  });

  it('flattens an S-record and takes a .bin as it is', async () => {
    const srec = await readSource(new File([FIXTURE], 'firmware_2.1.0.s37'));
    expect(srec).toMatchObject({ kind: 'raw', format: 'srec', rawSize: 0x21, versionFromName: '2.1.0' });
    expect(srec.gaps).toHaveLength(2);
    const raw = new Uint8Array([1, 2, 3, 4, 5]);
    const bin = await readSource(new File([raw], 'firmware.bin'));
    expect(bin).toMatchObject({ kind: 'raw', format: 'bin', rawSize: 5, versionFromName: null, gaps: [] });
    expect([...bin.bytes]).toEqual([1, 2, 3, 4, 5]);
  });

  it('refuses a .bin that is too large, and S-record errors come through', async () => {
    await expect(readSource(new File([new Uint8Array(STM32_APP_MAX_SIZE + 1)], 'big.bin'))).rejects.toThrow(SourceError);
    await expect(readSource(new File(['S1030000FF\n'], 'bad.hex'))).rejects.toThrow('Line 1: the checksum does not match.');
  });

  it('offers the extensions goco.load_source reads', () => {
    expect(ACCEPT.split(',')).toEqual(['.bin', '.srec', '.s19', '.s28', '.s37', '.mot', '.hex']);
    expect(STM32_FLASH_BASE).toBe(0x08000000);
  });
});

/** Adler-32, the checksum at the end of a zlib stream (RFC 1950). */
function adler32(data: Uint8Array): number {
  let a = 1;
  let b = 0;
  for (const byte of data) {
    a = (a + byte) % 65521;
    b = (b + a) % 65521;
  }
  return ((b << 16) | a) >>> 0;
}

async function inflate(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

describe('compression', () => {
  it('produces a zlib stream (RFC 1950) that inflates back to the image', async () => {
    const { image } = srecToBin(FIXTURE);
    const raw = new Uint8Array(64 * 1024);
    for (let i = 0; i < raw.length; i++) raw[i] = (i * 7) & 0xff;
    raw.set(image, 1000);
    const z = await compress(raw);
    // CMF 0x78: deflate with a 32 KB window; CMF·256 + FLG is a multiple of 31.
    expect(z[0]).toBe(0x78);
    expect(((z[0] << 8) | z[1]) % 31).toBe(0);
    expect(z[1] & 0x20).toBe(0); // no preset dictionary
    // The stream ends in the Adler-32 of the raw image, big-endian.
    expect(new DataView(z.buffer, z.byteOffset, z.byteLength).getUint32(z.length - 4, false)).toBe(adler32(raw));
    expect(z.length).toBeLessThan(raw.length);
    expect([...(await inflate(z))]).toEqual([...raw]);
  });

  it('compresses an empty and a tiny image too', async () => {
    expect([...(await inflate(await compress(new Uint8Array(0))))]).toEqual([]);
    expect([...(await inflate(await compress(new Uint8Array([0xff]))))]).toEqual([0xff]);
  });
});
