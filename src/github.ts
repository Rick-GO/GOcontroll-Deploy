// The tag and the GitHub release of a module firmware publish (the Firmware tab, after Publish).
//
// The deployment agent (08) set tag v<version> by hand after every publish and made the GitHub
// release when it could. Deploy does both through the GitHub API, with a fine-grained token in the
// Secrets Store (DEPLOY_GITHUB_TOKEN: Contents read and write on the Module-* repositories), for the
// repositories GITHUB_REPOS allows:
//
//   1. what the tag says comes from the published module manifests, not from the browser: per file
//      the entry of that version, all with the same date and changelog;
//   2. every file at that commit on GitHub must have the SHA-256 that was published (so the commit is
//      pushed and holds exactly the published bytes);
//   3. a repository with .github/workflows/publish-firmware.yml (the safety net) gets no tag for a
//      version below the highest of a module: pushing it starts that workflow, which puts its
//      version first in the module's manifest, and go-modules would flash the older firmware;
//   4. the annotated tag (git/tags, then git/refs; never the release API's lightweight tag, which the
//      workflow would read as an empty annotation) with RELEASE_DATE, DEPLOY_FILES and the changelog in
//      the workflow's format, so its run writes what Deploy wrote. The tagger is the colleague. An
//      existing tag that says the same is kept; one that says something else is replaced only when
//      asked (as the agent did: delete, then set again);
//   5. the release v<version> with the changelog as its notes and the .srec files (from the bucket)
//      as assets; an existing release keeps its assets and gets the missing ones.
// Every call is in the audit log (github-release).

import { z } from 'zod';
import type { Env, User } from './env';
import { compareFirmwareVersions, MODULES_PREFIX, parseSrecName } from './firmware';
import { sha256, toHex } from './goco';
import { HttpError, parse } from './lib/http';
import { readSecret } from './lib/secret';
import { audit } from './state';

const API = 'https://api.github.com';
const UPLOADS = 'https://uploads.github.com';
const WORKFLOW = '.github/workflows/publish-firmware.yml';

/** The token, or undefined when it is not set (empty, or the placeholder not-set). */
export async function githubToken(env: Env): Promise<string | undefined> {
  const token = await readSecret(env.GITHUB_TOKEN);
  return token && token !== 'not-set' ? token : undefined;
}

/** Whether `owner/name` is one of GITHUB_REPOS (comma list; a trailing * matches any rest). */
export function repoAllowed(slug: string, patterns: string | undefined): boolean {
  return (patterns || '').split(',').map((p) => p.trim()).filter(Boolean).some((p) =>
    p.endsWith('*') ? slug.startsWith(p.slice(0, -1)) && slug.length > p.length - 1 : slug === p);
}

/** The annotation the safety net reads (publish-firmware.yml, "Read tag annotation"). */
export function tagAnnotation(date: string, files: string[], changelog: string): string {
  return `RELEASE_DATE: ${date}\nDEPLOY_FILES: ${[...files].sort().join(',')}\n\n${changelog}\n`;
}

/** Whether an annotation says the same date, files and changelog (as the workflow reads them). */
export function annotationSays(message: string, date: string, files: string[], changelog: string): boolean {
  const lines = message.split(/\r?\n/);
  const value = (key: string) => lines.find((l) => l.startsWith(`${key}: `))?.slice(key.length + 2).trim() ?? null;
  const text = lines.filter((l) => !/^(RELEASE_DATE|DEPLOY_FILES):/.test(l) && l.trim()).map((l) => l.replace(/\s+$/, '')).join('\n').trim();
  const listed = (value('DEPLOY_FILES') ?? '').split(',').map((f) => f.trim()).filter(Boolean).sort();
  return value('RELEASE_DATE') === date && JSON.stringify(listed) === JSON.stringify([...files].sort()) && text === changelog;
}

class GitHub {
  constructor(private token: string, private repo: string) {}

  async call(method: string, path: string, body?: unknown, accept = 'application/vnd.github+json', base = API): Promise<Response> {
    let res: Response;
    try {
      res = await fetch(`${base}/repos/${this.repo}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${this.token}`,
          accept,
          'user-agent': 'gocontroll-deploy-intranet',
          'x-github-api-version': '2022-11-28',
          ...(body instanceof Uint8Array ? { 'content-type': 'application/octet-stream' } : body !== undefined ? { 'content-type': 'application/json' } : {}),
        },
        body: body instanceof Uint8Array ? body as Uint8Array<ArrayBuffer> : body !== undefined ? JSON.stringify(body) : undefined,
      });
    } catch {
      throw new HttpError(502, 'GitHub could not be reached. Try again.');
    }
    if (res.status === 401) throw new HttpError(503, 'GitHub refused the token (DEPLOY_GITHUB_TOKEN): it is wrong or expired.');
    if (res.status === 403 || (res.status === 404 && method !== 'GET')) {
      throw new HttpError(503, `The GitHub token may not ${method === 'GET' ? 'read' : 'write'} ${this.repo} (it needs Contents: read and write on it).`);
    }
    return res;
  }

  async json<T>(method: string, path: string, body?: unknown): Promise<T | null> {
    const res = await this.call(method, path, body);
    if (res.status === 404) return null;
    if (!res.ok) throw new HttpError(502, `GitHub answered ${res.status} to ${method} ${path}: ${(await res.text()).slice(0, 200)}`);
    return res.status === 204 ? null : res.json<T>();
  }
}

export interface GitHubCheck {
  configured: boolean;      // a token is set
  allowed: boolean;         // the repository is in GITHUB_REPOS
  readable: boolean;        // the token can read it (GET /repos/{repo}: 200)
  canPush: boolean | null;  // GitHub's permissions.push for the token's owner, when it says
  error: string | null;     // why not, for the colleague
}

/**
 * Whether Deploy can tag and release in a repository: the token is set, the repository is allowed
 * and the token can read it. Read only (one GET). Write access shows only at the first tag: GitHub
 * has no way to ask a fine-grained token what it may write.
 */
export async function checkGitHub(env: Env, repo: string): Promise<GitHubCheck> {
  const out: GitHubCheck = { configured: false, allowed: false, readable: false, canPush: null, error: null };
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) throw new HttpError(400, 'The GitHub repository is owner/name.', 'repo');
  const token = await githubToken(env);
  out.configured = Boolean(token);
  out.allowed = repoAllowed(repo, env.GITHUB_REPOS);
  if (!token) return { ...out, error: 'GitHub is not set up (DEPLOY_GITHUB_TOKEN).' };
  if (!out.allowed) return { ...out, error: `Deploy may not tag ${repo} (GITHUB_REPOS: ${env.GITHUB_REPOS || 'none'}).` };
  try {
    const res = await new GitHub(token, repo).call('GET', '');
    if (res.status === 404) return { ...out, error: `The GitHub token cannot see ${repo}: add the repository to the token.` };
    if (!res.ok) return { ...out, error: `GitHub answered ${res.status} for ${repo}.` };
    const info = await res.json<{ permissions?: { push?: boolean } }>();
    return { ...out, readable: true, canPush: typeof info.permissions?.push === 'boolean' ? info.permissions.push : null };
  } catch (err) {
    if (err instanceof HttpError) return { ...out, error: err.message };
    throw err;
  }
}

const Body = z.object({
  repo: z.string({ message: 'The GitHub repository is missing.' }).regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/, 'The GitHub repository is owner/name.'),
  commit: z.string({ message: 'The commit is missing.' }).regex(/^[0-9a-f]{40}$/, 'The commit is a full commit id.'),
  version: z.string({ message: 'The version is missing.' }).regex(/^\d{1,3}\.\d{1,3}\.\d{1,3}$/, 'The version is x.y.z.'),
  files: z.array(z.object({ file: z.string(), path: z.string() }), { message: 'The files are missing.' }).min(1).max(20),
  replaceTag: z.boolean().default(false),
});

export interface ReleaseResult {
  repo: string;
  tag: string;
  tagState: 'created' | 'kept' | 'replaced';
  tagUrl: string;
  releaseUrl: string;
  releaseState: 'created' | 'kept';
  assets: string[];       // uploaded now
  safetyNet: boolean;     // the repository has publish-firmware.yml: its run starts now
}

export async function tagAndRelease(env: Env, user: User, input: unknown): Promise<ReleaseResult> {
  const b = parse(Body, input);
  const token = await githubToken(env);
  if (!token) throw new HttpError(503, 'GitHub is not set up: DEPLOY_GITHUB_TOKEN has no token yet (README, "GitHub releases").');
  if (!repoAllowed(b.repo, env.GITHUB_REPOS)) throw new HttpError(403, `Deploy may not tag ${b.repo} (GITHUB_REPOS: ${env.GITHUB_REPOS || 'none'}).`, 'repo');
  const tag = `v${b.version}`;

  // 1. What was published, per file, from the module manifests.
  const published = await Promise.all(b.files.map(async ({ file, path }) => {
    const name = parseSrecName(file);
    if (!name || name.version !== b.version) throw new HttpError(400, `${file} is not firmware ${b.version}.`, 'files');
    if (!/^[A-Za-z0-9._-]+-BOOT\/[^/]+$/.test(path) || !path.endsWith(`/${file}`)) throw new HttpError(400, `${path} is not a <…>-BOOT/<file>.srec path.`, 'files');
    const obj = await env.FIRMWARE_BUCKET.get(`${MODULES_PREFIX}${name.hwId}/manifest.json`);
    const releases: Record<string, string>[] = obj ? (JSON.parse(await obj.text()).releases ?? []) : [];
    const entry = releases.find((r) => r.sw_version === b.version && r.file === `${MODULES_PREFIX}${name.hwId}/${file}`);
    if (!entry) throw new HttpError(409, `${file} is not published as ${b.version}: publish it first.`, 'files');
    return { file, path, hwId: name.hwId, entry, highest: String(releases[0]?.sw_version ?? b.version) };
  }));
  const { date, changelog } = published[0].entry;
  if (published.some((p) => p.entry.date !== date || p.entry.changelog !== changelog)) {
    throw new HttpError(409, `The files of ${b.version} were published with different dates or changelogs: one tag cannot say both.`, 'files');
  }

  const gh = new GitHub(token, b.repo);
  // 3. The safety net and an older version.
  const workflow = await gh.call('GET', `/contents/${WORKFLOW}?ref=${b.commit}`);
  const safetyNet = workflow.ok;
  const older = published.filter((p) => compareFirmwareVersions(b.version, p.highest) < 0);
  if (safetyNet && older.length) {
    throw new HttpError(409, `${b.repo} has ${WORKFLOW}: pushing ${tag} starts it, and it puts ${b.version} first in the manifest of ${older.map((p) => p.hwId).join(', ')} (highest ${older[0].highest}), so controllers would flash the older firmware. No tag was set.`, 'version');
  }

  // 2. The files at that commit on GitHub are the published ones.
  for (const p of published) {
    const res = await gh.call('GET', `/contents/${p.path.split('/').map(encodeURIComponent).join('/')}?ref=${b.commit}`, undefined, 'application/vnd.github.raw+json');
    if (res.status === 404 || res.status === 422) throw new HttpError(409, `${p.path} is not in ${b.repo} at ${b.commit.slice(0, 7)}: push the commit first.`, 'commit');
    if (!res.ok) throw new HttpError(502, `GitHub answered ${res.status} for ${p.path}.`);
    const digest = toHex(await sha256(new Uint8Array(await res.arrayBuffer())));
    if (digest !== p.entry.sha256) throw new HttpError(409, `${p.path} at ${b.commit.slice(0, 7)} is not the published file (SHA-256 differs).`, 'commit');
  }

  // 4. The tag.
  const files = published.map((p) => p.file);
  const message = tagAnnotation(date, files, changelog);
  let tagState: ReleaseResult['tagState'] = 'created';
  const ref = await gh.json<{ object: { type: string; sha: string } }>('GET', `/git/ref/tags/${tag}`);
  if (ref) {
    const existing = ref.object.type === 'tag' ? await gh.json<{ message: string; object: { sha: string } }>('GET', `/git/tags/${ref.object.sha}`) : null;
    if (existing && existing.object.sha === b.commit && annotationSays(existing.message, date, files, changelog)) {
      tagState = 'kept';
    } else if (!b.replaceTag) {
      throw new HttpError(409, `${tag} exists in ${b.repo} on another commit or with another date, files or changelog. Replace it to make it say what was published.`, 'replaceTag', {
        conflict: 'tag', existingMessage: existing?.message ?? null, existingCommit: existing?.object.sha ?? ref.object.sha,
      });
    } else {
      await gh.json('DELETE', `/git/refs/tags/${tag}`);
      tagState = 'replaced';
    }
  }
  if (tagState !== 'kept') {
    const object = await gh.json<{ sha: string }>('POST', '/git/tags', {
      tag, message, object: b.commit, type: 'commit', tagger: { name: user.name, email: user.email, date: new Date().toISOString() },
    });
    await gh.json('POST', '/git/refs', { ref: `refs/tags/${tag}`, sha: object!.sha });
  }

  // 5. The release, with the files.
  let release = await gh.json<{ id: number; html_url: string; assets: { name: string }[] }>('GET', `/releases/tags/${tag}`);
  const releaseState: ReleaseResult['releaseState'] = release ? 'kept' : 'created';
  release ??= await gh.json('POST', '/releases', { tag_name: tag, name: tag, body: changelog });
  const have = new Set((release!.assets ?? []).map((a) => a.name));
  const assets: string[] = [];
  for (const p of published.filter((x) => !have.has(x.file))) {
    const obj = await env.FIRMWARE_BUCKET.get(`${MODULES_PREFIX}${p.hwId}/${p.file}`);
    if (!obj) continue;
    const res = await gh.call('POST', `/releases/${release!.id}/assets?name=${encodeURIComponent(p.file)}`, new Uint8Array(await obj.arrayBuffer()), 'application/vnd.github+json', UPLOADS);
    if (!res.ok) throw new HttpError(502, `GitHub did not take ${p.file} as a release asset (${res.status}).`);
    assets.push(p.file);
  }

  const result: ReleaseResult = {
    repo: b.repo, tag, tagState, tagUrl: `https://github.com/${b.repo}/tree/${tag}`, releaseUrl: release!.html_url, releaseState, assets, safetyNet,
  };
  await audit(env, { action: 'github-release', app_id: `repo-${b.repo.replace('/', '_')}`, version: b.version, actor: user.email, commit: b.commit, files, ...result });
  return result;
}
