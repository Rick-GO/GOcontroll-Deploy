// The pages: the downloads page and the download page of one file behind a session, the sign-in
// page for anyone; their assets public. What they show comes from public/format.js (no DOM, so it
// runs here), and the catalogue never reaches them as HTML.

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { FILE_ROLE_LABELS, FILE_ROLES, IMAGE_CONTROLLERS, LINK_TTL_SECONDS, PLATFORM_LABELS, PLATFORMS, SESSION_TTL_SECONDS, type CatalogueRelease } from '../../src/images-format';
import * as format from '../public/format.js';
import appSource from '../public/app.js?raw';
import downloadHtml from '../public/download.html?raw';
import downloadSource from '../public/download.js?raw';
import formatSource from '../public/format.js?raw';
import indexHtml from '../public/index.html?raw';
import signInHtml from '../public/sign-in.html?raw';
import signInSource from '../public/sign-in.js?raw';
import uiSource from '../public/ui.js?raw';
import { emptyBucket, run, HOST, ROOTFS, signedIn } from './helpers';

beforeEach(async () => {
  await emptyBucket();
});
afterEach(() => vi.restoreAllMocks());

/** The same-site paths a page links to (href/src), without the routes of the Worker itself. */
const linkedAssets = (html: string) => [...html.matchAll(/(?:href|src)="(\/[^"]*)"/g)].map((m) => m[1])
  .filter((p) => !['/', '/sign-in', '/sign-out'].includes(p)).sort();

describe('the pages and their assets', () => {
  test('/ is the downloads page; its script, stylesheet and brand images are served', async () => {
    const page = await signedIn('/');
    expect(page.status).toBe(200);
    expect(page.headers.get('content-type')).toMatch(/^text\/html/);
    const html = await page.text();
    expect(html).toContain('Linux images for the Moduline L4, M1 and HMI1');
    expect(linkedAssets(html)).toEqual(['/app.js', '/favicon-dark.png', '/favicon-large.png', '/favicon-light.png', '/logo.svg', '/styles.css']);
    // What the scripts import and the stylesheet loads, plus robots.txt: public, no session needed.
    for (const path of [...linkedAssets(html), '/format.js', '/ui.js', '/sign-in.js', '/download.js', '/pattern.svg', '/robots.txt']) {
      const res = await signedIn(path, { auth: false });
      expect(res.status, path).toBe(200);
      await res.arrayBuffer();
    }
  });

  test('the sign-in page and the download page link only to assets that exist', () => {
    expect(linkedAssets(signInHtml)).toEqual(['/favicon-dark.png', '/favicon-large.png', '/favicon-light.png', '/logo.svg', '/sign-in.js', '/styles.css']);
    expect(linkedAssets(downloadHtml)).toEqual(['/download.js', '/favicon-dark.png', '/favicon-large.png', '/favicon-light.png', '/logo.svg', '/styles.css']);
  });

  test('/download/<path> is the download page with a session; the pages are not reachable by file name', async () => {
    const res = await signedIn(`/download/${ROOTFS}`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('<script type="module" src="/download.js"></script>');
    for (const path of ['/index.html', '/sign-in.html', '/download.html', '/download', '/index']) {
      expect((await signedIn(path)).status, path).toBe(404);
    }
    // Not the shape of a release file: nothing to download there.
    for (const path of ['/download/manifest.json', '/download/downloads/2026/10/x.json', '/download/images/a/1', '/download/images/a/1/%2e%2e']) {
      expect((await signedIn(path)).status, path).toBe(404);
    }
  });

  test('robots.txt keeps crawlers off the API, the files, the download pages and the links', async () => {
    const text = await (await run(new Request(`${HOST}/robots.txt`))).text();
    expect(text).toContain('User-agent: *');
    for (const path of ['/api/', '/files/', '/download/', '/access']) expect(text).toContain(`Disallow: ${path}`);
    expect(text).not.toMatch(/Disallow: \/\s*$/m); // the sign-in page stays crawlable, so its noindex is seen
  });

  test('the type-check config is not part of the site; unknown paths are a 404 page', async () => {
    expect((await signedIn('/tsconfig.json')).status).toBe(404);
    expect((await signedIn('/.assetsignore')).status).toBe(404);
    const res = await signedIn('/nope.css');
    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).toMatch(/^text\/html/);
  });

  test('no inline script, inline style or data: URI in the pages (the CSP allows none)', () => {
    for (const html of [indexHtml, signInHtml, downloadHtml]) {
      expect(html).not.toMatch(/<script(?![^>]*\bsrc=)/i);
      expect(html).not.toMatch(/<style|style=|data:/i);
      expect(html).not.toContain('/cdn-cgi/access');
    }
    expect(indexHtml).toContain('href="/sign-out"');
    expect(downloadHtml).toContain('href="/sign-out"');
    expect(signInHtml).toContain('id="human-check" data-sitekey=""');
    // The hero has no label above its title (not part of the house style).
    for (const html of [indexHtml, signInHtml, downloadHtml]) expect(html).not.toContain('eyebrow');
    // An element with id "turnstile" would be window.turnstile, mistaken for Cloudflare's API.
    for (const html of [indexHtml, signInHtml, downloadHtml]) expect(html).not.toMatch(/id="turnstile"/);
  });

  test('there are only controller images: no page or script speaks of tools (since 0.8.0)', () => {
    for (const text of [indexHtml, signInHtml, downloadHtml, appSource, formatSource]) expect(text).not.toMatch(/\btools?\b/i);
    expect(indexHtml).toContain('id="images"');
  });

  test('catalogue text never goes into a page as HTML', () => {
    for (const source of [appSource, formatSource, uiSource, signInSource, downloadSource]) {
      const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, ''); // without comments
      expect(code).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write|\.style\b|eval\(/);
    }
  });
});

describe('format.js', () => {
  test('the label maps and controllers are those of src/images-format.ts', () => {
    expect(format.FILE_ROLE_LABELS).toEqual(FILE_ROLE_LABELS);
    expect(format.PLATFORM_LABELS).toEqual(PLATFORM_LABELS);
    expect(format.CONTROLLERS).toEqual([...IMAGE_CONTROLLERS]);
    expect(FILE_ROLES.map(format.roleLabel)).toEqual(FILE_ROLES.map((r) => FILE_ROLE_LABELS[r]));
    expect(format.roleLabel('unknown')).toBe('Other');
    expect(format.roleLabel('package')).toBe('Complete image');
    expect(format.roleLabel('tool')).toBe('Other'); // the role of the tool releases of format 1
    expect(PLATFORMS.map(format.platformLabel)).toEqual(['', 'Windows', 'Linux', 'macOS']);
  });

  test('sizes, dates and lists as people read them', () => {
    expect([0, 999, 1000, 1500, 52_428_800, 1_288_490_189, 3e12].map(format.formatSize)).toEqual(['0 B', '999 B', '1 kB', '1.5 kB', '52.4 MB', '1.3 GB', '3 TB']);
    expect(format.formatDate('2026-11-01')).toBe('1 November 2026');
    expect(format.formatDate('2026-10-28T23:30:00.000Z')).toBe('28 October 2026');
    expect(format.formatDate('')).toBe('');
    expect(format.formatDate(null)).toBe('');
    expect(format.joinList(['L4'])).toBe('L4');
    expect(format.joinList(['L4', 'M1', 'HMI1'])).toBe('L4, M1 and HMI1');
  });

  const rel = (product: string, version: string, controllers: string[]): CatalogueRelease => ({
    product, title: product, version, controllers: controllers as CatalogueRelease['controllers'], released: '2026-11-01', notes: '', files: [],
  });

  test('releases grouped per product in catalogue order, filtered per controller', () => {
    const releases = [
      rel('a', '2', ['L4', 'M1']), rel('a', '1', ['L4']), rel('b', '1', ['HMI1']), rel('c', '1', []),
    ];
    const ids = (groups: { product: string; version: string }[][]) => groups.map((g) => g.map((r) => `${r.product}${r.version}`));
    expect(ids(format.productGroups(releases))).toEqual([['a2', 'a1'], ['b1'], ['c1']]);
    expect(ids(format.productGroups(releases, 'M1'))).toEqual([['a2'], ['c1']]);
    expect(ids(format.productGroups(releases, 'HMI1'))).toEqual([['b1'], ['c1']]);
    expect(ids(format.productGroups([]))).toEqual([]);
    expect(format.controllersText(releases[0])).toBe('For the L4 and M1');
    expect(format.controllersText(releases[3])).toBe('For every controller');
  });
});

describe('format.js: signing in and the download page', () => {
  test('the durations are those of src/images-format.ts', () => {
    expect(format.LINK_MINUTES * 60).toBe(LINK_TTL_SECONDS);
    expect(format.ACCESS_DAYS * 86400).toBe(SESSION_TTL_SECONDS);
  });

  test('the sign-in notice from the address', () => {
    expect(format.signInNotice(new URLSearchParams('link=expired'))).toEqual({ kind: 'err', text: expect.stringMatching(/expired/) });
    expect(format.signInNotice(new URLSearchParams('link=invalid'))).toEqual({ kind: 'err', text: expect.stringMatching(/does not work/) });
    expect(format.signInNotice(new URLSearchParams('signed-out'))).toEqual({ kind: 'info', text: 'You are signed out.' });
    expect(format.signInNotice(new URLSearchParams(''))).toBeNull();
  });

  test('downloadTarget: a release file of /download/…, else nothing', () => {
    expect(format.downloadTarget(`/download/${ROOTFS}`)).toBe(ROOTFS);
    for (const p of [null, '', '/', '/download/', '/download/manifest.json', '/files/x', '/download/images/a/b', '/download/tools/a/1/b']) expect(format.downloadTarget(p), String(p)).toBe('');
    expect(format.fileName(ROOTFS)).toBe('rootfs.ext4.zst');
  });

  test('findFile and the verify commands with the name filled in', () => {
    const catalogue = { format: 2, updated: null, releases: [{ product: 'p', title: 'P', version: '1', controllers: [], released: '', notes: '',
      files: [{ name: 'a.img', path: 'images/p/1/a.img', size: 1, sha256: '', role: 'rootfs', platform: 'any' }] }] };
    expect(format.findFile(catalogue, 'images/p/1/a.img')?.file.name).toBe('a.img');
    expect(format.findFile(catalogue, 'images/p/1/b.img')).toBeNull();
    expect(format.verifyCommands('a.img').map((c) => c.command)).toEqual(['sha256sum a.img', 'shasum -a 256 a.img', 'Get-FileHash -Algorithm SHA256 .\\a.img']);
  });
});
