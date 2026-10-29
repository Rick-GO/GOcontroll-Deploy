// The pure helpers of the Firmware and Images pages (public/js/release-helpers.js).

import { describe, expect, it } from 'vitest';
import {
  annotationMatches, changelogFromTag, compareVersions, githubSlug, githubUrl, guessPlatform, guessRole, normaliseChangelog, parseSrecName as pageParse,
  previousTag, releaseDateFromTag, safetyNetFindings, syncState, tagAnnotation, toLf,
} from '../public/js/release-helpers.js';
import { normaliseChangelog as workerNormalise, parseSrecName as workerParse } from '../src/firmware';

/**
 * What publish-firmware.yml makes of a tag annotation (its "Read tag annotation" step): the
 * RELEASE_DATE: and DEPLOY_FILES: values, and the rest without blank lines, stripped by the script.
 */
function asTheCiReadsIt(message: string) {
  const lines = message.split('\n');
  const value = (key: string) => lines.filter((l) => l.startsWith(`${key}:`)).map((l) => l.replace(`${key}: `, '')).join('\n');
  const changelog = lines.filter((l) => !l.startsWith('RELEASE_DATE:') && !l.startsWith('DEPLOY_FILES:') && !/^\s*$/.test(l)).join('\n').trim();
  return { date: value('RELEASE_DATE'), files: value('DEPLOY_FILES'), changelog };
}

describe('firmware page', () => {
  it('reads a file name exactly as the Worker does', () => {
    for (const name of ['20-10-1-6-2-0-3.srec', '20-10-3-3-1-1-0.srec', '20-30-4-2-0-2-0.srec', 'Module-Multibus.srec', '20-10-1-6-2-0.srec']) {
      expect(pageParse(name)).toEqual(workerParse(name));
    }
  });

  it('turns CRLF and lone CR into LF', () => {
    expect(toLf('S0\r\nS1\rS9\n')).toBe('S0\nS1\nS9\n');
  });

  it('normalises a changelog as the Worker does', () => {
    for (const text of ['One line', '  a  \n\n\n b\t\n', 'x\r\ny', '\n\n']) expect(normaliseChangelog(text)).toBe(workerNormalise(text));
  });

  it('reads a tag annotation of the deployment skill as the CI does', () => {
    const msg = 'RELEASE_DATE: 27/04/26\nDEPLOY_FILES: 20-20-2-7-2-3-1.srec\n\nImprovement on supply rail precharge mechanism\n';
    expect(changelogFromTag(msg)).toBe('Improvement on supply rail precharge mechanism');
    expect(releaseDateFromTag(msg)).toBe('2026-04-27');
    expect(releaseDateFromTag('Release 0.4.0')).toBeNull();
    expect(changelogFromTag('[a.srec]\nFirst\n\n[b.srec]\nSecond\n')).toBe('[a.srec]\nFirst\n[b.srec]\nSecond');
  });

  it('writes the tag annotation so the CI reads back exactly what was published', () => {
    const changelog = normaliseChangelog('Faster sampling  \n\nFixes the offset at 0 mA');
    const msg = tagAnnotation('2026-10-28', ['20-10-1-6-2-0-4.srec', '20-10-1-5-2-0-4.srec'], changelog);
    expect(msg).toBe('RELEASE_DATE: 28/10/26\nDEPLOY_FILES: 20-10-1-5-2-0-4.srec,20-10-1-6-2-0-4.srec\n\nFaster sampling\nFixes the offset at 0 mA\n');
    expect(asTheCiReadsIt(msg)).toEqual({ date: '28/10/26', files: '20-10-1-5-2-0-4.srec,20-10-1-6-2-0-4.srec', changelog });
    expect(annotationMatches(msg, '2026-10-28', ['20-10-1-6-2-0-4.srec', '20-10-1-5-2-0-4.srec'], changelog)).toBe(true);
    expect(annotationMatches(msg, '2026-10-29', ['20-10-1-6-2-0-4.srec', '20-10-1-5-2-0-4.srec'], changelog)).toBe(false);
    expect(annotationMatches(msg, '2026-10-28', ['20-10-1-6-2-0-4.srec'], changelog)).toBe(false);
    expect(annotationMatches(msg, '2026-10-28', ['20-10-1-6-2-0-4.srec', '20-10-1-5-2-0-4.srec'], 'Other')).toBe(false);
  });

  it('finds the previous version tag', () => {
    const tag = (name: string) => ({ name, commit: name, annotated: true, message: null, date: null });
    const tags = [tag('v2.0.0'), tag('v2.0.10'), tag('v2.0.9'), tag('v2.1.0'), tag('release/x'), tag('v2.0.3-rc1')];
    expect(previousTag(tags, '2.1.0')?.name).toBe('v2.0.10');
    expect(previousTag(tags, '2.0.0')).toBeNull();
    expect(compareVersions('2.0.10', '2.0.9')).toBe(1);
  });

  it('makes a GitHub link of the remote URL', () => {
    expect(githubUrl('https://github.com/GOcontroll/Module-Input.git')).toBe('https://github.com/GOcontroll/Module-Input');
    expect(githubUrl('git@github.com:GOcontroll/Module-IR.git')).toBe('https://github.com/GOcontroll/Module-IR');
    expect(githubUrl('https://gitlab.com/x/y.git')).toBeNull();
    expect(githubUrl(null)).toBeNull();
    expect(githubSlug('git@github.com:GOcontroll/Module-IR.git')).toBe('GOcontroll/Module-IR');
    expect(githubSlug('https://gitlab.com/x/y.git')).toBeNull();
  });

  it('checks the safety net as the deployment agent did', () => {
    const workflow = `env:\n  MODULE_NAME: "IR communication module"\n  R2_BUCKET_NAME: gocontroll-firmware\njobs:\n  publish:\n    steps:\n      - env:\n          R2_ACCESS_KEY_ID: \${{ secrets.FIRM_R2_ACCESS_KEY_ID }}\n          R2_SECRET_ACCESS_KEY: \${{ secrets.FIRM_R2_SECRET_ACCESS_KEY }}\n          R2_ACCOUNT_ID: \${{ secrets.CF_ACCOUNT_ID }}\n        run: python .github/scripts/publish_firmware.py\n`;
    const fixed = 'if _ver(sw_ver) > _ver(entry.get("latest_firmware", "0.0.0")):';
    expect(safetyNetFindings({ workflow, script: fixed, scriptPath: '.github/scripts/publish_firmware.py', names: ['IR Communication Module'] }))
      .toEqual([expect.stringContaining('MODULE_NAME is "IR communication module"')]);
    expect(safetyNetFindings({ workflow, script: fixed, scriptPath: '.github/scripts/publish_firmware.py', names: ['IR communication module'] })).toEqual([]);
    expect(safetyNetFindings({ workflow, script: 'entry["latest_firmware"] = sw_ver', scriptPath: 'scripts/publish_firmware.py', names: [] }))
      .toEqual([expect.stringContaining('in version order')]);
    expect(safetyNetFindings({ workflow, script: null, scriptPath: 'scripts/publish_firmware.py', names: [] })).toEqual([expect.stringContaining('not in the repository')]);
    expect(safetyNetFindings({ workflow: workflow.replace('secrets.CF_ACCOUNT_ID', 'secrets.CLOUDFLARE_ACCOUNT_ID'), script: fixed, scriptPath: 'x.py', names: [] }))
      .toEqual([expect.stringContaining('CF_ACCOUNT_ID')]);
    expect(safetyNetFindings({ workflow: null, script: null, scriptPath: null, names: [] })).toEqual([expect.stringContaining('no safety net')]);
  });

  it('says whether HEAD is the newest commit of its branch, from GitHub or else from the last fetch', () => {
    const head = { sha: 'b'.repeat(40), date: null, subject: 'Faster sampling' };
    const gh = (state: any, extra = {}) => ({ branch: 'main', head, state, githubNewer: null, localNewer: null, ...extra });
    const local = { headReachesGithub: null, branch: 'main', pushed: null, trackingNewer: null, reason: null };
    expect(syncState({ ...local, github: gh('up-to-date') })).toMatchObject({ source: 'github', state: 'up-to-date', pushed: true });
    expect(syncState({ ...local, github: gh('github-newer', { githubNewer: 3 }) })).toMatchObject({ state: 'github-newer', githubNewer: 3, head, pushed: true });
    expect(syncState({ ...local, github: gh('local-newer', { localNewer: 2 }) })).toMatchObject({ state: 'local-newer', pushed: false });
    expect(syncState({ ...local, github: gh('diverged') })).toMatchObject({ state: 'diverged', pushed: false });
    expect(syncState({ ...local, github: gh('no-branch') })).toMatchObject({ state: 'no-branch', pushed: false });
    // GitHub's answer wins over a stale origin/main.
    expect(syncState({ ...local, pushed: true, trackingNewer: false, github: gh('github-newer') }).state).toBe('github-newer');
    // GitHub does not know HEAD: does HEAD's history hold GitHub's newest commit?
    expect(syncState({ ...local, github: gh('not-on-github'), headReachesGithub: true })).toMatchObject({ state: 'local-newer', githubNewer: 0, pushed: false });
    expect(syncState({ ...local, github: gh('not-on-github'), headReachesGithub: false })).toMatchObject({ state: 'diverged', pushed: false });
    expect(syncState({ ...local, github: gh('not-on-github') })).toMatchObject({ state: 'unknown', pushed: false, reason: expect.stringContaining('not on GitHub') });

    const fetched = (pushed: boolean | null, trackingNewer: boolean | null, branch: string | null = 'main') =>
      syncState({ github: null, headReachesGithub: null, branch, pushed, trackingNewer, reason: 'GitHub is not set up' });
    expect(fetched(true, false)).toMatchObject({ source: 'fetch', state: 'up-to-date', pushed: true, reason: 'GitHub is not set up' });
    expect(fetched(true, true)).toMatchObject({ state: 'github-newer', pushed: true });
    expect(fetched(false, false)).toMatchObject({ state: 'local-newer', pushed: false });
    expect(fetched(false, true)).toMatchObject({ state: 'diverged', pushed: false });
    expect(fetched(null, null).state).toBe('unknown');
    expect(fetched(true, null).state).toBe('unknown');
    expect(fetched(null, null, null).state).toBe('unknown');
  });
});

describe('images page', () => {
  it('guesses what a file is and what it runs on', () => {
    expect(guessRole('rootfs13_headless.ext4.zst', 'image')).toBe('rootfs');
    expect(guessRole('barebox-gocontroll-mini-111.img', 'image')).toBe('bootloader');
    expect(guessRole('flash_mini_111.ps1', 'tool')).toBe('script');
    expect(guessRole('imx-usb-loader.exe', 'tool')).toBe('tool');
    expect(guessRole('README.pdf', 'tool')).toBe('docs');
    expect(guessPlatform('flash_mini_111.ps1')).toBe('windows');
    expect(guessPlatform('flash_mini_111.sh')).toBe('linux');
    expect(guessPlatform('rootfs.ext4')).toBe('any');
  });
});
