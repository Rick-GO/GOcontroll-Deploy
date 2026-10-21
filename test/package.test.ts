// public/js/package.js: the Linux release (update.tar.gz + the version manifest) the browser
// builds, held against the CI producer, build-package.py of the skill
// r2-application-deploy-setup. test/fixtures/tar/fixture.json comes from
// `python -I scripts/tar-fixture.py`: what build-package.py wrote for a fixed input, the
// tarball package.js built for the same input under Node, and how Python's tarfile read that
// tarball. Runs in workerd, which has the browser's CompressionStream and crypto.subtle.

import { describe, expect, it } from 'vitest';
import fixture from './fixtures/tar/fixture.json';
import {
  POST_INSTALL_TEMPLATE,
  PackageError,
  buildPackage,
  buildTar,
  checkBuiltPackage,
  compareLinuxVersions,
  definitionFromConfig,
  definitionFromVersionManifest,
  definitionProblem,
  gunzip,
  gzip,
  linuxAppIdProblem,
  linuxVersionProblem,
  nextPatch,
  packageFileProblem,
  pythonJson,
  readTar,
  renderPostInstall,
  servicesOf,
  sha256Hex,
  versionManifest,
} from '../public/js/package.js';

const bytes = (b64: string) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
const utf8 = (s: string) => new TextEncoder().encode(s);
const input = fixture.input;
const contents = new Map(input.files.map((f) => [f.name, bytes(f.base64)]));
const definition = {
  owner: input.owner,
  group: input.group,
  files: input.files.map((f) => ({
    name: f.name, destination: f.destination, mode: f.mode, ...(f.owner ? { owner: f.owner } : {}), ...(f.group ? { group: f.group } : {}),
  })),
  post_install: { mode: 'services' as const, services: input.services },
};
const build = () => buildPackage({
  appId: input.appId, version: input.version, released: input.released, description: input.description, definition, contents, mtime: input.mtime,
});

describe('post-install script', () => {
  it('is the skill\'s post-install.sh.tmpl byte for byte, with LF line endings', () => {
    expect(POST_INSTALL_TEMPLATE).toBe(fixture.template);
    expect(POST_INSTALL_TEMPLATE).not.toContain('\r');
    expect(POST_INSTALL_TEMPLATE.endsWith('echo "Post-install complete."\n')).toBe(true);
  });

  it('renders as build-package.py renders it', () => {
    expect(renderPostInstall(input.services)).toBe(fixture.buildPackagePy.postInstall);
    expect(renderPostInstall([])).toContain('SERVICES=""');
  });

  it('recognises a rendered script, and not one of its own', () => {
    expect(servicesOf(fixture.buildPackagePy.postInstall)).toEqual(['nodered', 'go-simulink']);
    expect(servicesOf(`${fixture.buildPackagePy.postInstall}# changed\n`)).toBeNull();
    expect(servicesOf('#!/bin/bash\nsystemctl restart nodered\n')).toBeNull();
  });
});

describe('version manifest', () => {
  it('has the field order and content of build-package.py for the same input', async () => {
    const built = await build();
    expect(built.manifestText).toBe(fixture.buildPackagePy.manifestText);
    expect(Object.keys(built.manifest)).toEqual(['manifest_version', 'app_id', 'version', 'released', 'description', 'files', 'post_install']);
  });

  it('leaves post_install out without a script', () => {
    const m = versionManifest({ appId: 'a', version: '1.0.0', released: '2026-10-21', description: 'd', files: [], postInstallSha256: null });
    expect(Object.keys(m)).toEqual(['manifest_version', 'app_id', 'version', 'released', 'description', 'files']);
  });

  it('writes JSON as json.dumps(indent=2) + newline, escaping non-ASCII', () => {
    expect(pythonJson({ a: 'é–😀', b: [], c: { d: 1 } })).toBe('{\n  "a": "\\u00e9\\u2013\\ud83d\\ude00",\n  "b": [],\n  "c": {\n    "d": 1\n  }\n}\n');
    expect(pythonJson({ x: '\u007f\n"\\' })).toBe('{\n  "x": "\\u007f\\n\\"\\\\"\n}\n');
  });

  it('hashes like hashlib', async () => {
    expect(await sha256Hex(utf8('abc'))).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
});

describe('tarball', () => {
  it('is exactly the tar Python\'s tarfile read back (the committed fixture)', async () => {
    const built = await build();
    expect(built.tar).toEqual(bytes(fixture.browser.tarBase64));
  });

  it('lists in Python exactly files/ and files/<name>, with the same bytes', () => {
    const want = [
      { name: 'files', type: 'dir', mode: 0o755, uname: 'root', gname: 'root', sha256: null },
      ...[...input.files.map((f) => ({ name: f.name, mode: f.mode, owner: f.owner ?? 'root', group: f.group ?? 'root' })),
        { name: 'post-install.sh', mode: '0755', owner: 'root', group: 'root' }]
        .sort((a, b) => (a.name < b.name ? -1 : 1))
        .map((f) => ({ name: `files/${f.name}`, type: 'file', mode: Number.parseInt(f.mode, 8), uname: f.owner, gname: f.group })),
    ];
    const seen = fixture.browser.pythonListing;
    expect(seen.map(({ name, type, mode, uname, gname }) => ({ name, type, mode, uname, gname }))).toEqual(
      want.map(({ name, type, mode, uname, gname }) => ({ name, type, mode, uname, gname })),
    );
    for (const m of seen) {
      expect(m.uid).toBe(0);
      expect(m.gid).toBe(0);
      expect(m.mtime).toBe(input.mtime);
    }
  });

  it('carries the bytes and SHA-256 of every file, as Python saw them', async () => {
    const seen = new Map(fixture.browser.pythonListing.map((m) => [m.name, m]));
    for (const f of input.files) {
      const data = bytes(f.base64);
      expect(seen.get(`files/${f.name}`)?.size).toBe(data.length);
      expect(seen.get(`files/${f.name}`)?.sha256).toBe(await sha256Hex(data));
    }
    expect(seen.get('files/post-install.sh')?.sha256).toBe(await sha256Hex(utf8(fixture.buildPackagePy.postInstall)));
  });

  it('has ustar headers, two zero blocks and whole 10240-byte records', () => {
    const tar = buildTar([{ name: 'a.txt', data: utf8('hello\n'), mode: '0644', owner: 'pi', group: 'users' }], { mtime: 1_700_000_000, owner: 'root', group: 'root' });
    expect(tar.length % 10240).toBe(0);
    const ascii = (from: number, to: number) => new TextDecoder().decode(tar.subarray(from, to));
    // The directory entry, then the file.
    expect(ascii(0, 6)).toBe('files/');
    expect(String.fromCharCode(tar[156])).toBe('5');
    expect(ascii(512, 523)).toBe('files/a.txt');
    expect(String.fromCharCode(tar[512 + 156])).toBe('0');
    expect(ascii(512 + 100, 512 + 108)).toBe('0000644\0');
    expect(ascii(512 + 108, 512 + 124)).toBe('0000000\x000000000\0');
    expect(ascii(512 + 124, 512 + 136)).toBe('00000000006\0');
    expect(ascii(512 + 136, 512 + 148)).toBe(`${(1_700_000_000).toString(8)}\0`);
    expect(ascii(512 + 257, 512 + 265)).toBe('ustar\x0000');
    expect(ascii(512 + 265, 512 + 267)).toBe('pi');
    expect(ascii(512 + 297, 512 + 302)).toBe('users');
    // The checksum: "%06o\0 " of the header with its own field as spaces.
    const h = tar.slice(512, 1024);
    h.fill(0x20, 148, 156);
    const sum = h.reduce((n, b) => n + b, 0);
    expect(ascii(512 + 148, 512 + 156)).toBe(`${sum.toString(8).padStart(6, '0')}\0 `);
    expect(ascii(1024, 1030)).toBe('hello\n');
    expect(tar.subarray(1536, 2560).every((b) => b === 0)).toBe(true);
  });

  it('reads back in the browser module, through gzip and gunzip', async () => {
    const built = await build();
    expect(built.tarGz[0]).toBe(0x1f);
    expect(built.tarGz[1]).toBe(0x8b);
    expect(built.sha256).toBe(await sha256Hex(built.tarGz));
    expect(built.size).toBe(built.tarGz.length);
    const entries = readTar(await gunzip(built.tarGz));
    expect(entries.map((e) => e.name)).toEqual(fixture.browser.pythonListing.map((m) => (m.type === 'dir' ? `${m.name}/` : m.name)));
    for (const f of input.files) expect(entries.find((e) => e.name === `files/${f.name}`)?.data).toEqual(bytes(f.base64));
    // And the gzip that Node made for the fixture (what Python opened with r:gz).
    expect(readTar(await gunzip(bytes(fixture.browser.tarGzBase64))).length).toBe(entries.length);
  });

  it('reads a tarball build-package.py made (pax headers included)', async () => {
    const entries = readTar(await gunzip(bytes(fixture.buildPackagePy.tarGzBase64)));
    expect(entries.map((e) => e.name)).toEqual(fixture.buildPackagePy.listing.map((m) => (m.type === 'dir' ? `${m.name}/` : m.name)));
    const script = entries.find((e) => e.name === 'files/post-install.sh');
    expect(new TextDecoder().decode(script?.data)).toBe(fixture.buildPackagePy.postInstall);
    for (const f of input.files) expect(entries.find((e) => e.name === `files/${f.name}`)?.data).toEqual(bytes(f.base64));
  });

  it('checks a built package against its manifest', async () => {
    const python = bytes(fixture.buildPackagePy.tarGzBase64);
    const manifest = JSON.parse(fixture.buildPackagePy.manifestText);
    const ok = await checkBuiltPackage(python, manifest);
    expect(ok.problems).toEqual([]);
    expect(ok.postInstall).toBe(fixture.buildPackagePy.postInstall);
    const wrong = structuredClone(manifest);
    wrong.files[0].sha256 = '0'.repeat(64);
    wrong.files.push({ source: 'files/missing.txt', destination: '/x', mode: '0644', sha256: '0'.repeat(64) });
    const bad = await checkBuiltPackage(python, wrong);
    expect(bad.problems).toHaveLength(2);
    await expect(checkBuiltPackage(utf8('not gzip'), manifest)).rejects.toThrow(PackageError);
  });

  it('refuses a damaged tar', async () => {
    const tar = (await build()).tar.slice();
    tar[600] ^= 0xff;
    expect(() => readTar(tar)).toThrow('checksum');
    await expect(gunzip((await gzip(utf8('x'))).subarray(0, 12))).rejects.toThrow(PackageError);
  });
});

describe('package definition', () => {
  it('comes from an r2-deploy.config.json', () => {
    const { definition: d, appId } = definitionFromConfig({
      app_id: 'my-app', owner: 'pi', files: [
        { source: 'node-red/flows.json', destination: '/usr/node-red/flows.json', mode: '0644' },
        { source: 'bin/app', destination: '/usr/bin/app', mode: '0755', owner: 'root', group: 'adm' },
      ], post_install: { enabled: true, services: ['nodered'] },
    });
    expect(appId).toBe('my-app');
    expect(d).toEqual({
      owner: 'pi', group: 'root', post_install: { mode: 'services', services: ['nodered'] },
      files: [
        { name: 'flows.json', destination: '/usr/node-red/flows.json', mode: '0644' },
        { name: 'app', destination: '/usr/bin/app', mode: '0755', owner: 'root', group: 'adm' },
      ],
    });
    expect(definitionFromConfig({ app_id: 'x', files: [{ source: 'a', destination: '/a', mode: '0644' }] }).definition.post_install).toEqual({ mode: 'none' });
    expect(() => definitionFromConfig({ app_id: 'x' })).toThrow(PackageError);
  });

  it('comes from the latest version manifest', () => {
    const d = definitionFromVersionManifest(JSON.parse(fixture.buildPackagePy.manifestText));
    expect(d.files).toEqual([
      { name: 'flows.json', destination: '/usr/node-red/flows.json', mode: '0644' },
      { name: 'app', destination: '/usr/bin/app', mode: '0755', owner: 'gocontroll', group: 'gocontroll' },
      { name: 'exact512.bin', destination: '/opt/test/exact512.bin', mode: '0600' },
      { name: 'settings.js', destination: '/usr/node-red/settings.js', mode: '0640', group: 'nodered' },
    ]);
  });

  it('checks files, defaults and post-install', () => {
    const ok = { name: 'flows.json', destination: '/usr/flows.json', mode: '0644' };
    expect(packageFileProblem(ok, [ok])).toBeNull();
    expect(packageFileProblem({ ...ok, name: 'a/b' }, [])).toContain('plain file name');
    expect(packageFileProblem({ ...ok, name: 'post-install.sh' }, [])).toContain('post-install script');
    expect(packageFileProblem(ok, [ok, ok])).toContain('twice');
    expect(packageFileProblem({ ...ok, destination: 'usr/x' }, [])).toContain('absolute');
    expect(packageFileProblem({ ...ok, mode: '644x' }, [])).toContain('octal');
    expect(packageFileProblem({ ...ok, owner: 'bad user' }, [])).toContain('owner');
    const def = { owner: 'root', group: 'root', files: [ok], post_install: { mode: 'none' as const } };
    expect(definitionProblem(def)).toBeNull();
    expect(definitionProblem({ ...def, files: [] })).toContain('at least one file');
    expect(definitionProblem({ ...def, post_install: { mode: 'services', services: [] } })).toContain('at least one service');
    expect(definitionProblem({ ...def, post_install: { mode: 'services', services: ['node red'] } })).toContain('not a service name');
    expect(definitionProblem({ ...def, post_install: { mode: 'script', script: '  ' } })).toContain('empty');
  });
});

describe('Linux App IDs and versions', () => {
  it('takes the r2-deploy.config.json App ID pattern', () => {
    expect(linuxAppIdProblem('gocontroll-application')).toBeNull();
    expect(linuxAppIdProblem('a.b_c-9')).toBeNull();
    expect(linuxAppIdProblem('')).toBe('Enter an App ID.');
    expect(linuxAppIdProblem('My-App')).toContain('lower case');
    expect(linuxAppIdProblem('-app')).toContain('lower case');
    expect(linuxAppIdProblem('a'.repeat(65))).toContain('64');
  });

  it('takes a version with an optional pre-release', () => {
    expect(linuxVersionProblem('1.0.1')).toBeNull();
    expect(linuxVersionProblem('1.0.1-r')).toBeNull();
    expect(linuxVersionProblem('1.0')).toContain('major.minor.patch');
    expect(linuxVersionProblem('v1.0.0')).toContain('major.minor.patch');
  });

  it('orders versions as upload-r2.py semver_key does', () => {
    const sorted = ['1.0.1-r', '1.2.0', '1.10.0', '1.0.1', '0.9.9', '1.0.1-a'].sort((a, b) => compareLinuxVersions(b, a));
    expect(sorted).toEqual(['1.10.0', '1.2.0', '1.0.1', '1.0.1-r', '1.0.1-a', '0.9.9']);
    expect(compareLinuxVersions('2.0.0', '2.0.0')).toBe(0);
  });

  it('suggests the next patch', () => {
    expect(nextPatch('1.2.3')).toBe('1.2.4');
    expect(nextPatch('1.0.1-r')).toBe('1.0.2');
    expect(nextPatch(null)).toBe('1.0.0');
  });
});
