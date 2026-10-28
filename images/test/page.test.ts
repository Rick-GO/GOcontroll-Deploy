// The page: served behind the token check, with its assets; what it shows comes from
// public/format.js (no DOM, so it runs here), and the catalogue never reaches it as HTML.

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { FILE_ROLE_LABELS, FILE_ROLES, IMAGE_CONTROLLERS, PLATFORM_LABELS, PLATFORMS, type CatalogueRelease } from '../../src/images-format';
import * as format from '../public/format.js';
import appSource from '../public/app.js?raw';
import formatSource from '../public/format.js?raw';
import indexHtml from '../public/index.html?raw';
import { emptyBucket, mockAccess, signedIn } from './helpers';

beforeEach(async () => {
  mockAccess();
  await emptyBucket();
});
afterEach(() => vi.restoreAllMocks());

describe('the page and its assets', () => {
  test('/ is the page; its script, stylesheet and brand images are served', async () => {
    const page = await signedIn('/');
    expect(page.status).toBe(200);
    expect(page.headers.get('content-type')).toMatch(/^text\/html/);
    const html = await page.text();
    expect(html).toContain('Linux images and tools for the Moduline L4, M1 and HMI1');
    // What the page links to, plus what app.js imports and styles.css loads.
    const linked = [...html.matchAll(/(?:href|src)="(\/[^"]+)"/g)].map((m) => m[1]).filter((p) => !p.startsWith('/cdn-cgi/'));
    expect(linked.sort()).toEqual(['/app.js', '/favicon-dark.png', '/favicon-large.png', '/favicon-light.png', '/logo.svg', '/styles.css']);
    for (const path of [...linked, '/format.js', '/pattern.svg']) {
      const res = await signedIn(path);
      expect(res.status, path).toBe(200);
      await res.arrayBuffer();
    }
  });

  test('the type-check config is not part of the site; unknown paths are a 404 page', async () => {
    expect((await signedIn('/tsconfig.json')).status).toBe(404);
    expect((await signedIn('/.assetsignore')).status).toBe(404);
    const res = await signedIn('/nope.html');
    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).toMatch(/^text\/html/);
  });

  test('no inline script, inline style or data: URI in the page (the CSP allows none)', () => {
    expect(indexHtml).not.toMatch(/<script(?![^>]*\bsrc=)/i);
    expect(indexHtml).not.toMatch(/<style|style=|data:/i);
    expect(indexHtml).toContain('href="/cdn-cgi/access/logout"');
  });

  test('catalogue text never goes into the page as HTML', () => {
    for (const source of [appSource, formatSource]) {
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

  const rel = (kind: 'image' | 'tool', product: string, version: string, controllers: string[]): CatalogueRelease => ({
    kind, product, title: product, version, controllers: controllers as CatalogueRelease['controllers'], released: '2026-11-01', notes: '', files: [],
  });

  test('releases grouped per product in catalogue order, filtered per controller', () => {
    const releases = [
      rel('image', 'a', '2', ['L4', 'M1']), rel('image', 'a', '1', ['L4']), rel('image', 'b', '1', ['HMI1']),
      rel('image', 'c', '1', []), rel('tool', 't', '1', []),
    ];
    const ids = (groups: { product: string; version: string }[][]) => groups.map((g) => g.map((r) => `${r.product}${r.version}`));
    expect(ids(format.productGroups(releases, 'image'))).toEqual([['a2', 'a1'], ['b1'], ['c1']]);
    expect(ids(format.productGroups(releases, 'image', 'M1'))).toEqual([['a2'], ['c1']]);
    expect(ids(format.productGroups(releases, 'image', 'HMI1'))).toEqual([['b1'], ['c1']]);
    expect(ids(format.productGroups(releases, 'tool'))).toEqual([['t1']]);
    expect(ids(format.productGroups([], 'image'))).toEqual([]);
    expect(format.controllersText(releases[0])).toBe('For the L4 and M1');
    expect(format.controllersText(releases[4])).toBe('For every controller');
  });
});
