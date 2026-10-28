// Tag v<version> and the GitHub release after a module firmware publish (src/github.ts), against a
// mocked GitHub API. What the tag says comes from the published manifests; the files at the commit
// must be the published ones; no tag for an older version when the repository has the safety net.

import { env } from 'cloudflare:test';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { annotationSays, repoAllowed, tagAnnotation } from '../src/github';
import worker from '../src/index';
import { call } from './helpers';

const ORIGIN = 'http://localhost';
const ME = 'jane.doe@gocontroll.com';
const REPO = 'GOcontroll/Module-Test';
const COMMIT = 'c'.repeat(40);
const TOKEN = { GITHUB_TOKEN: 'test-token' };

afterEach(() => vi.restoreAllMocks());

function srec(seed: string): Uint8Array<ArrayBuffer> {
  const rec = (kind: string, addr: number[], data: number[]) => {
    const body = [addr.length + data.length + 1, ...addr, ...data];
    const sum = (~body.reduce((a, b) => a + b, 0)) & 0xff;
    return `S${kind}${body.map((b) => b.toString(16).padStart(2, '0')).join('').toUpperCase()}${sum.toString(16).padStart(2, '0').toUpperCase()}`;
  };
  const data = [...new TextEncoder().encode(seed.padEnd(16, '.'))].slice(0, 16);
  return new TextEncoder().encode([rec('0', [0, 0], [1]), rec('3', [8, 0, 0x40, 0], data), rec('7', [8, 0, 0x40, 0], [])].join('\n') + '\n') as Uint8Array<ArrayBuffer>;
}

async function publish(file: string, bytes: Uint8Array<ArrayBuffer>, fields: Record<string, string> = {}) {
  const form = new FormData();
  form.append('file', new File([bytes], file));
  for (const [k, v] of Object.entries({ released: '2026-10-28', changelog: 'Faster sampling', module_name: 'Test module', ...fields })) form.append(k, v);
  const res = await worker.fetch(new Request(`${ORIGIN}/api/firmware`, { method: 'POST', body: form, headers: { origin: ORIGIN } }), {
    ...env, DEV_USER_EMAIL: ME, DEV_USER_NAME: 'Jane Doe', DEV_USER_GROUPS: 'CF_Deploy',
  } as typeof env);
  expect(res.status, await res.clone().text()).toBe(200);
}

type Call = { method: string; host: string; path: string; body: any };
interface GitHubState {
  workflow?: boolean;
  files?: Record<string, Uint8Array>;
  ref?: { type: string; sha: string } | null;
  tagObject?: { message: string; object: { sha: string } } | null;
  release?: { id: number; html_url: string; assets: { name: string }[] } | null;
}

/** GitHub's API for REPO on fetch; every call recorded. */
function mockGitHub(state: GitHubState): Call[] {
  const calls: Call[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: any, init?: RequestInit) => {
    const req = new Request(input, init);
    const url = new URL(req.url);
    expect(req.headers.get('authorization')).toBe('Bearer test-token');
    const prefix = `/repos/${REPO}`;
    if (!url.pathname.startsWith(prefix)) throw new Error(`unexpected fetch ${req.url}`);
    const path = url.pathname.slice(prefix.length);
    const body: any = req.method === 'GET' || req.method === 'DELETE' ? null
      : url.host === 'uploads.github.com' ? new Uint8Array(await req.arrayBuffer()) : await req.json();
    calls.push({ method: req.method, host: url.host, path: path + url.search, body });
    const json = (status: number, v: unknown) => new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } });
    if (url.host === 'uploads.github.com') return json(201, { name: url.searchParams.get('name') });
    if (req.method === 'GET' && path === '/contents/.github/workflows/publish-firmware.yml') return state.workflow ? json(200, {}) : json(404, {});
    if (req.method === 'GET' && path.startsWith('/contents/')) {
      const file = state.files?.[decodeURIComponent(path.slice('/contents/'.length))];
      return file ? new Response(file as Uint8Array<ArrayBuffer>) : json(404, {});
    }
    if (req.method === 'GET' && path.startsWith('/git/ref/tags/')) return state.ref ? json(200, { object: state.ref }) : json(404, {});
    if (req.method === 'GET' && path.startsWith('/git/tags/')) return state.tagObject ? json(200, state.tagObject) : json(404, {});
    if (req.method === 'DELETE' && path.startsWith('/git/refs/tags/')) return new Response(null, { status: 204 });
    if (req.method === 'POST' && path === '/git/tags') return json(201, { sha: 't'.repeat(40) });
    if (req.method === 'POST' && path === '/git/refs') return json(201, {});
    if (req.method === 'GET' && path.startsWith('/releases/tags/')) return state.release ? json(200, state.release) : json(404, {});
    if (req.method === 'POST' && path === '/releases') return json(201, { id: 7, html_url: `https://github.com/${REPO}/releases/tag/${body.tag_name}`, assets: [] });
    throw new Error(`unmocked ${req.method} ${path}`);
  });
  return calls;
}

let n = 0;
/** A module type of its own per test, with its .srec published as `version`. */
async function published(version: string, extra: string[] = []) {
  n++;
  const file = (v: string) => `20-70-${n}-1-${v.replace(/\./g, '-')}.srec`;
  const bytes = srec(`gh${n}-${version}`);
  for (const v of extra) await publish(file(v), srec(`gh${n}-${v}`));
  await publish(file(version), bytes);
  const path = `V2070${String(n).padStart(2, '0')}01-BOOT/${file(version)}`;
  return { file: file(version), path, bytes, hwId: `2070${String(n).padStart(2, '0')}01` };
}

const release = (version: string, files: { file: string; path: string }[], extra: Record<string, unknown> = {}) =>
  call('POST', '/api/firmware/releases', { repo: REPO, commit: COMMIT, version, files, ...extra }, TOKEN);

describe('tag and release', () => {
  test('sets the annotated tag the safety net reads, then the release with the .srec attached', async () => {
    const p = await published('1.2.0');
    const calls = mockGitHub({ workflow: true, files: { [p.path]: p.bytes } });
    const res = await release('1.2.0', [{ file: p.file, path: p.path }]);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({ tag: 'v1.2.0', tagState: 'created', releaseState: 'created', assets: [p.file], safetyNet: true });
    const tag = calls.find((c) => c.method === 'POST' && c.path === '/git/tags')!;
    expect(tag.body).toMatchObject({ tag: 'v1.2.0', object: COMMIT, type: 'commit', tagger: { name: 'Jane Doe', email: ME } });
    expect(tag.body.message).toBe(`RELEASE_DATE: 28/10/26\nDEPLOY_FILES: ${p.file}\n\nFaster sampling\n`);
    expect(calls.find((c) => c.path === '/git/refs')!.body).toEqual({ ref: 'refs/tags/v1.2.0', sha: 't'.repeat(40) });
    expect(calls.find((c) => c.path === '/releases')!.body).toEqual({ tag_name: 'v1.2.0', name: 'v1.2.0', body: 'Faster sampling' });
    const upload = calls.find((c) => c.host === 'uploads.github.com')!;
    expect(upload.path).toBe(`/releases/7/assets?name=${p.file}`);
    expect(upload.body).toEqual(p.bytes);
    // The tag comes before the release: the release API alone would make a lightweight tag.
    expect(calls.findIndex((c) => c.path === '/git/refs')).toBeLessThan(calls.findIndex((c) => c.path === '/releases'));
    const logs = await env.STATE.list({ prefix: 'log/' });
    expect(logs.objects.some((o) => o.key.endsWith('-repo-GOcontroll_Module-Test-1.2.0.json'))).toBe(true);
  });

  test('keeps a tag that says the same; replaces one that does not only when asked', async () => {
    const p = await published('2.0.0');
    const same = tagAnnotation('28/10/26', [p.file], 'Faster sampling');
    let calls = mockGitHub({ files: { [p.path]: p.bytes }, ref: { type: 'tag', sha: 'a'.repeat(40) }, tagObject: { message: same, object: { sha: COMMIT } },
      release: { id: 9, html_url: 'https://github.com/x', assets: [{ name: p.file }] } });
    const kept = await release('2.0.0', [{ file: p.file, path: p.path }]);
    expect(kept.body).toMatchObject({ tagState: 'kept', releaseState: 'kept', assets: [] });
    expect(calls.some((c) => c.method === 'POST')).toBe(false);
    vi.restoreAllMocks();

    calls = mockGitHub({ files: { [p.path]: p.bytes }, ref: { type: 'tag', sha: 'a'.repeat(40) }, tagObject: { message: 'Release 2.0.0', object: { sha: COMMIT } } });
    const refused = await release('2.0.0', [{ file: p.file, path: p.path }]);
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({ conflict: 'tag', existingMessage: 'Release 2.0.0' });
    expect(calls.some((c) => c.method !== 'GET')).toBe(false);
    const replaced = await release('2.0.0', [{ file: p.file, path: p.path }], { replaceTag: true });
    expect(replaced.body).toMatchObject({ tagState: 'replaced', releaseState: 'created' });
    expect(calls.findIndex((c) => c.method === 'DELETE')).toBeLessThan(calls.findIndex((c) => c.path === '/git/tags'));
  });

  test('no tag for an older version when the safety net would put it first; without one it is fine', async () => {
    const p = await published('1.0.0', ['1.1.0']);
    let calls = mockGitHub({ workflow: true, files: { [p.path]: p.bytes } });
    const refused = await release('1.0.0', [{ file: p.file, path: p.path }]);
    expect(refused.status).toBe(409);
    expect(refused.body.field).toBe('version');
    expect(calls.some((c) => c.method !== 'GET')).toBe(false);
    vi.restoreAllMocks();
    calls = mockGitHub({ workflow: false, files: { [p.path]: p.bytes } });
    expect((await release('1.0.0', [{ file: p.file, path: p.path }])).body).toMatchObject({ tagState: 'created', safetyNet: false });
  });

  test('the files at the commit must be the published ones, and the commit must be on GitHub', async () => {
    const p = await published('3.0.0');
    mockGitHub({ files: {} });
    const missing = await release('3.0.0', [{ file: p.file, path: p.path }]);
    expect(missing.status).toBe(409);
    expect(missing.body.error).toMatch(/push the commit/);
    vi.restoreAllMocks();
    const calls = mockGitHub({ files: { [p.path]: srec('something else') } });
    const other = await release('3.0.0', [{ file: p.file, path: p.path }]);
    expect(other.status).toBe(409);
    expect(other.body.error).toMatch(/SHA-256/);
    expect(calls.some((c) => c.method !== 'GET')).toBe(false);
  });

  test('refuses what was not published, mixed changelogs, other repositories and a missing token', async () => {
    const p = await published('4.0.0');
    mockGitHub({ files: { [p.path]: p.bytes } });
    expect((await release('4.0.1', [{ file: p.file, path: p.path }])).status).toBe(400);
    expect((await release('4.0.0', [{ file: p.file, path: `elsewhere/${p.file}` }])).status).toBe(400);
    expect((await call('POST', '/api/firmware/releases', { repo: 'GOcontroll/GOcontroll-Team', commit: COMMIT, version: '4.0.0', files: [{ file: p.file, path: p.path }] }, TOKEN)).status).toBe(403);
    expect((await call('POST', '/api/firmware/releases', { repo: REPO, commit: COMMIT, version: '4.0.0', files: [{ file: p.file, path: p.path }] }, { GITHUB_TOKEN: 'not-set' })).status).toBe(503);

    n++;
    const a = `20-70-${n}-1-5-0-0.srec`;
    const b = `20-70-${n}-2-5-0-0.srec`;
    await publish(a, srec('a5'), { changelog: 'One text' });
    await publish(b, srec('b5'), { changelog: 'Another text' });
    const mixed = await release('5.0.0', [{ file: a, path: `X-BOOT/${a}` }, { file: b, path: `Y-BOOT/${b}` }]);
    expect(mixed.status).toBe(409);
    expect(mixed.body.field).toBe('files');
  });

  test('checks, read only, whether Deploy can tag and release in a repository', async () => {
    const seen: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: any, init?: RequestInit) => {
      const req = new Request(input, init);
      seen.push(`${req.method} ${new URL(req.url).pathname}`);
      const known = new URL(req.url).pathname === `/repos/${REPO}`;
      return new Response(JSON.stringify(known ? { permissions: { push: true } } : { message: 'Not Found' }), { status: known ? 200 : 404 });
    });
    const ok = await call('GET', `/api/firmware/github?repo=${encodeURIComponent(REPO)}`, undefined, TOKEN);
    expect(ok.body).toEqual({ configured: true, allowed: true, readable: true, canPush: true, error: null });
    const unseen = await call('GET', `/api/firmware/github?repo=${encodeURIComponent('GOcontroll/Module-Other')}`, undefined, TOKEN);
    expect(unseen.body).toMatchObject({ readable: false, error: expect.stringContaining('cannot see') });
    const outside = await call('GET', `/api/firmware/github?repo=${encodeURIComponent('GOcontroll/GOcontroll-Team')}`, undefined, TOKEN);
    expect(outside.body).toMatchObject({ allowed: false, readable: false });
    const off = await call('GET', `/api/firmware/github?repo=${encodeURIComponent(REPO)}`, undefined, { GITHUB_TOKEN: 'not-set' });
    expect(off.body).toMatchObject({ configured: false, readable: false });
    expect((await call('GET', '/api/firmware/github?repo=nope', undefined, TOKEN)).status).toBe(400);
    expect(seen).toEqual([`GET /repos/${REPO}`, 'GET /repos/GOcontroll/Module-Other']);
  });

  test('the overview says whether GitHub is set up', async () => {
    expect((await call('GET', '/api/firmware', undefined, TOKEN)).body.github).toEqual({ configured: true, repos: 'GOcontroll/Module-*' });
    expect((await call('GET', '/api/firmware', undefined, { GITHUB_TOKEN: 'not-set' })).body.github.configured).toBe(false);
  });
});

describe('helpers', () => {
  test('repositories Deploy may tag', () => {
    expect(repoAllowed('GOcontroll/Module-Input', 'GOcontroll/Module-*')).toBe(true);
    expect(repoAllowed('GOcontroll/Module-', 'GOcontroll/Module-*')).toBe(false);
    expect(repoAllowed('GOcontroll/GOcontroll-Team', 'GOcontroll/Module-*')).toBe(false);
    expect(repoAllowed('Evil/Module-Input', 'GOcontroll/Module-*')).toBe(false);
    expect(repoAllowed('GOcontroll/X', 'GOcontroll/Module-*, GOcontroll/X')).toBe(true);
    expect(repoAllowed('GOcontroll/X', '')).toBe(false);
  });

  test('an annotation says what was published as the workflow reads it', () => {
    const msg = tagAnnotation('28/10/26', ['b.srec', 'a.srec'], 'First\nSecond');
    expect(msg).toBe('RELEASE_DATE: 28/10/26\nDEPLOY_FILES: a.srec,b.srec\n\nFirst\nSecond\n');
    expect(annotationSays(msg, '28/10/26', ['a.srec', 'b.srec'], 'First\nSecond')).toBe(true);
    expect(annotationSays(msg.replace('\n\nFirst', '\n\n\nFirst  '), '28/10/26', ['a.srec', 'b.srec'], 'First\nSecond')).toBe(true);
    expect(annotationSays(msg, '29/10/26', ['a.srec', 'b.srec'], 'First\nSecond')).toBe(false);
    expect(annotationSays(msg, '28/10/26', ['a.srec'], 'First\nSecond')).toBe(false);
  });
});
